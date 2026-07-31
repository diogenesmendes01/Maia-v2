'use client';

/**
 * Issue #462 — aba "Atividade": visão 360º de um agente.
 *
 * Quatro cartões escopados ao agente:
 *   1. Traces recentes        — traces.listTraces (tenant) filtrado por agent_id
 *                               no cliente (os itens carregam agent_id).
 *   2. Alertas de drift       — drift.listDriftAlerts; os itens AINDA não
 *                               carregam agent_id, então exibimos os alertas do
 *                               tenant inteiro com aviso honesto.
 *   3. Skills do agente       — skills.list({ tenantId, agentId }) — o repo já
 *                               escopa por (tenant, agent OU tenant-wide).
 *   4. Canais                 — channelPolicies.listChannels({ tenantId, agentId }):
 *                               canais são linhas POR agente (channelsRepo.listActive
 *                               filtra por tenant+agent do contexto), então todo
 *                               canal listado roteia para ESTE agente; a política
 *                               de cada canal vem via fan-out getByChannel.
 *
 * Traces/drift estão parcialmente instrumentados upstream (P10b / wiring P4) e
 * retornam [] por enquanto — ver docs/runbooks/p8.5-admin-ui.md. Os EmptyStates
 * dizem isso com calma em vez de fingir que não há atividade.
 */

import * as React from 'react';
import Link from 'next/link';
import { trpc } from '../../../../trpc/client.js';
import { cn } from '../../../../components/ui/cn.js';
import { Card, CardHeader, CardBody } from '../../../../components/ui/card.js';
import { Badge, StatusBadge } from '../../../../components/ui/badge.js';
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from '../../../../components/ui/states.js';
import {
  IconSearch,
  IconAlertTriangle,
  IconZap,
  IconMessage,
  IconChevronRight,
} from '../../../../components/ui/icons.js';

/** Máximo de linhas por cartão — o link "ver tudo" leva à tela completa. */
const MAX_ROWS = 8;

/**
 * Nota honesta para listas que dependem de fases ainda não concluídas
 * (traces → P10b; drift → wiring do repo P4). Fonte:
 * docs/runbooks/p8.5-admin-ui.md.
 */
const PARTIAL_INSTRUMENTATION =
  'instrumentação parcial — ver runbook docs/runbooks/p8.5-admin-ui.md';

interface ScopeProps {
  tenantId: string;
  agentId: string;
}

/** Sem superjson no link tRPC: datas chegam como string mesmo tipadas Date. */
function fmtDate(value: string | Date): string {
  return new Date(value).toLocaleString('pt-BR');
}

function HeaderLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-0.5 text-xs font-medium text-brand-600 hover:text-brand-700"
    >
      {label}
      <IconChevronRight size={12} />
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* 1. Traces recentes                                                  */
/* ------------------------------------------------------------------ */

function TracesCard({ tenantId, agentId }: ScopeProps) {
  // Issue #514 §7: o filtro por agente agora é SERVER-SIDE (índice
  // `runtime_trace_env_explorer_agent_idx`, migration 100). Antes buscávamos 50
  // traces do tenant e filtrávamos no cliente — o que, num tenant com vários
  // agentes, mostrava "nenhum trace" para um agente que TINHA traces, só
  // porque os 50 mais recentes eram de outro.
  const query = trpc.traces.listTraces.useQuery(
    { tenantId, agentId, limit: MAX_ROWS },
    { enabled: tenantId !== '' },
  );

  const rows = query.data?.items ?? [];

  return (
    <Card>
      <CardHeader
        title="Traces recentes"
        description="Execuções de runtime deste agente."
        actions={<HeaderLink href="/traces" label="ver tudo" />}
      />
      <CardBody>
        {query.isLoading ? (
          <LoadingState label="Carregando traces…" />
        ) : query.error ? (
          <ErrorState
            message={query.error.message}
            onRetry={() => void query.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<IconSearch size={32} />}
            title="Nenhum trace deste agente"
            description={`Os traces dependem do P10b (${PARTIAL_INSTRUMENTATION}).`}
          />
        ) : (
          <ul className="divide-y divide-zinc-100">
            {rows.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/traces/${t.id}`}
                  className="flex items-center justify-between gap-3 py-2.5 hover:bg-zinc-50/70"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-zinc-800">
                      {t.id}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {fmtDate(t.started_at)}
                      {t.duration_ms !== null ? ` · ${t.duration_ms} ms` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {t.outcome ? (
                      <StatusBadge status={t.outcome} />
                    ) : (
                      <Badge tone="neutral">em curso</Badge>
                    )}
                    <IconChevronRight size={14} className="text-zinc-400" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 2. Alertas de drift abertos                                         */
/* ------------------------------------------------------------------ */

function DriftCard({ tenantId }: ScopeProps) {
  const query = trpc.drift.listDriftAlerts.useQuery(
    { tenantId, limit: 50 },
    { enabled: tenantId !== '' },
  );

  // Os itens AINDA não carregam agent_id (drift.ts retorna só
  // id/drift_type/severity/decision/detected_at) — sem como filtrar por
  // agente no cliente; exibimos os alertas do tenant com aviso honesto.
  const rows = (query.data?.items ?? []).slice(0, MAX_ROWS);

  return (
    <Card>
      <CardHeader
        title="Alertas de drift abertos"
        description="Os alertas ainda não carregam vínculo por agente — exibindo os do tenant inteiro."
        actions={<HeaderLink href="/drift" label="ver tudo" />}
      />
      <CardBody>
        {query.isLoading ? (
          <LoadingState label="Carregando alertas…" />
        ) : query.error ? (
          <ErrorState
            message={query.error.message}
            onRetry={() => void query.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<IconAlertTriangle size={32} />}
            title="Nenhum alerta de drift"
            description={`O wiring do repositório P4 está pendente (${PARTIAL_INSTRUMENTATION}).`}
          />
        ) : (
          <ul className="divide-y divide-zinc-100">
            {rows.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-800">
                    {a.drift_type}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {fmtDate(a.detected_at)}
                    {a.decision ? ` · decisão: ${a.decision}` : ''}
                  </p>
                </div>
                <div className="shrink-0">
                  <StatusBadge status={a.severity} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 3. Skills do agente                                                 */
/* ------------------------------------------------------------------ */

function SkillsCard({ tenantId, agentId }: ScopeProps) {
  const query = trpc.skills.list.useQuery(
    { tenantId, agentId },
    { enabled: tenantId !== '' && agentId !== '' },
  );

  // O repo já escopa por (tenant, agente atual OU tenant-wide); skills com
  // agent_id null são compartilhadas no tenant e marcadas como tal.
  const rows = (query.data?.items ?? []).slice(0, MAX_ROWS);

  return (
    <Card>
      <CardHeader
        title="Skills do agente"
        description="Contratos de skill visíveis a este agente (inclui tenant-wide)."
        actions={<HeaderLink href="/skills" label="ver tudo" />}
      />
      <CardBody>
        {query.isLoading ? (
          <LoadingState label="Carregando skills…" />
        ) : query.error ? (
          <ErrorState
            message={query.error.message}
            onRetry={() => void query.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<IconZap size={32} />}
            title="Nenhuma skill para este agente"
            description="Skills aparecem aqui quando forem propostas para este agente (ou para o tenant inteiro) na tela Skills."
          />
        ) : (
          <ul className="divide-y divide-zinc-100">
            {rows.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-zinc-800">
                    {s.skill_descriptor}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    v{s.version} · {s.category} · {s.execution_mode}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {s.agent_id === null && <Badge tone="info">tenant-wide</Badge>}
                  <StatusBadge status={s.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 4. Canais                                                           */
/* ------------------------------------------------------------------ */

function ChannelsCard({ tenantId, agentId }: ScopeProps) {
  const channelsQuery = trpc.channelPolicies.listChannels.useQuery(
    { tenantId, agentId },
    { enabled: tenantId !== '' && agentId !== '' },
  );

  // Canais são linhas POR agente (channels.agent_id; o repo filtra por
  // tenant+agent do contexto) — todo canal retornado roteia para ESTE agente.
  const channels = channelsQuery.data?.items ?? [];
  const visible = channels.slice(0, MAX_ROWS);

  // Fan-out: a política de cada canal visível (no máximo MAX_ROWS queries).
  // getByChannel roda no contexto deste agente, então uma política não nula é,
  // por construção, deste agente.
  const policyQueries = trpc.useQueries((t) =>
    visible.map((c) =>
      t.channelPolicies.getByChannel({ tenantId, agentId, channelId: c.id }),
    ),
  );

  return (
    <Card>
      <CardHeader
        title="Canais"
        description="Canais registrados para este agente e a política de papel de cada um."
        actions={<HeaderLink href="/setup/channels" label="configurar" />}
      />
      <CardBody>
        {channelsQuery.isLoading ? (
          <LoadingState label="Carregando canais…" />
        ) : channelsQuery.error ? (
          <ErrorState
            message={channelsQuery.error.message}
            onRetry={() => void channelsQuery.refetch()}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<IconMessage size={32} />}
            title="Nenhum canal para este agente"
            description="Registre um canal e configure a política dele em Setup → Canais."
          />
        ) : (
          <ul className="divide-y divide-zinc-100">
            {visible.map((c, idx) => {
              const policyQuery = policyQueries[idx];
              const policy = policyQuery?.data ?? null;
              const routesHere = policy !== null && policy.agent_id === agentId;
              return (
                <li
                  key={c.id}
                  className={cn(
                    'flex items-center justify-between gap-3 py-2.5',
                    routesHere && 'bg-brand-50/40',
                  )}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-800">
                      {c.channel_type}
                      {c.display_name ? ` · ${c.display_name}` : ''}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-xs text-zinc-500">
                      {c.external_id}
                    </p>
                  </div>
                  <div className="shrink-0">
                    {policyQuery?.isLoading ? (
                      <Badge tone="neutral">carregando…</Badge>
                    ) : policy ? (
                      <Badge tone="brand">{policy.switch_behavior}</Badge>
                    ) : (
                      <Badge tone="warning">sem política</Badge>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {channels.length > MAX_ROWS && (
          <p className="mt-3 text-xs text-zinc-500">
            Exibindo {MAX_ROWS} de {channels.length} canais — veja todos em
            Setup → Canais.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export default function ActivityTab({ tenantId, agentId }: ScopeProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <TracesCard tenantId={tenantId} agentId={agentId} />
      <DriftCard tenantId={tenantId} agentId={agentId} />
      <SkillsCard tenantId={tenantId} agentId={agentId} />
      <ChannelsCard tenantId={tenantId} agentId={agentId} />
    </div>
  );
}
