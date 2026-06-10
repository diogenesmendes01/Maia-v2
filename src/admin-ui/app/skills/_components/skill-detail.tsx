'use client';

/**
 * Admin UI — detalhe da skill (Modal).
 *
 * Busca o contrato completo via skills.getById e o histórico de versões via
 * skills.listVersions (escopado ao agent_id da PRÓPRIA linha selecionada —
 * null = tenant-wide — para que uma skill de agente e uma tenant-wide com o
 * mesmo descritor não se misturem). As ações de ciclo de vida (founder) vivem
 * em skill-actions.tsx.
 */

import * as React from 'react';
import { trpc } from '../../../trpc/client.js';
import { Modal } from '../../../components/ui/modal.js';
import { Badge, StatusBadge } from '../../../components/ui/badge.js';
import { LoadingState, ErrorState } from '../../../components/ui/states.js';
import { SkillActions } from './skill-actions.js';

// Projeção RESUMIDA retornada por skills.list: apenas as colunas da tabela,
// SEM JSONB grande. Timestamps chegam como strings ISO.
export type SkillSummary = {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  skill_descriptor: string;
  category: string;
  execution_mode: string;
  version: number;
  status: string;
  activated_at: string | null;
  created_at: string;
};

// Resumo de versão retornado por skills.listVersions: só metadados escalares.
type SkillVersionSummary = {
  id: string;
  version: number;
  status: string;
  agent_id: string | null;
  activated_at: string | null;
  deprecated_at: string | null;
  rolled_back_at: string | null;
  created_at: string;
  proposed_by: string;
  approved_by: string | null;
};

// Contrato completo retornado por skills.getById — espelho de SkillRow.
export type SkillRow = SkillSummary & {
  goal: string;
  when_to_use: string;
  procedure: unknown;
  constraints: unknown;
  input_schema: unknown;
  output_schema: unknown;
  allowed_tools: string[];
  policy_descriptors: string[];
  success_criteria: unknown;
  failure_modes: unknown;
  runtime_hints: unknown;
  proposed_by: string;
  proposed_reason: string | null;
  approved_by: string | null;
  approved_at: string | null;
  deprecated_at: string | null;
  rolled_back_at: string | null;
  rollback_reason: string | null;
};

function fmtDate(v: string | null): string {
  if (!v) return '—';
  return new Date(v).toLocaleString('pt-BR');
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="scroll-thin max-h-72 overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-800">
      {JSON.stringify(value ?? null, null, 2)}
    </pre>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {title}
      </h3>
      {children}
    </div>
  );
}

function TagList({ items, empty }: { items: string[]; empty: string }) {
  if (!items || items.length === 0) {
    return <p className="text-xs text-zinc-400">{empty}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((t) => (
        <code
          key={t}
          className="rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-xs text-zinc-700"
        >
          {t}
        </code>
      ))}
    </div>
  );
}

export function SkillDetailModal({
  id,
  tenantId,
  agentId,
  isFounder,
  onClose,
  onMutated,
}: {
  id: string;
  tenantId: string;
  agentId: string;
  isFounder: boolean;
  onClose: () => void;
  onMutated: () => void;
}) {
  const detailQuery = trpc.skills.getById.useQuery({ id, tenantId, agentId });
  const skill = (detailQuery.data?.item ?? null) as SkillRow | null;

  // Histórico de versões escopado ao agent_id da PRÓPRIA linha selecionada
  // (null = tenant-wide), NÃO ao filtro de agente da página.
  const versionsQuery = trpc.skills.listVersions.useQuery(
    {
      descriptor: skill?.skill_descriptor ?? '',
      tenantId,
      agentId: skill ? skill.agent_id : agentId,
    },
    { enabled: skill != null },
  );
  const versions = (versionsQuery.data?.items ?? []) as SkillVersionSummary[];

  return (
    <Modal open onClose={onClose} title="Detalhe da skill" size="xl">
      {detailQuery.isLoading ? (
        <LoadingState label="Carregando skill…" />
      ) : detailQuery.error ? (
        <ErrorState message={detailQuery.error.message} />
      ) : !skill ? (
        <p className="text-sm text-zinc-500">
          Skill não encontrada ou não visível.
        </p>
      ) : (
        <div className="space-y-5">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-sm font-semibold text-zinc-900">
                {skill.skill_descriptor}
              </code>
              <Badge tone="neutral">v{skill.version}</Badge>
              <StatusBadge status={skill.status} />
              <Badge tone="neutral">{skill.category}</Badge>
              <Badge tone="neutral">{skill.execution_mode}</Badge>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-600">
              <div>
                <dt className="inline font-medium">Agente: </dt>
                <dd className="inline">{skill.agent_id ?? 'tenant-wide'}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Proposta por: </dt>
                <dd className="inline">{skill.proposed_by}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Aprovada por: </dt>
                <dd className="inline">{skill.approved_by ?? '—'}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Ativada em: </dt>
                <dd className="inline">{fmtDate(skill.activated_at)}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Descontinuada em: </dt>
                <dd className="inline">{fmtDate(skill.deprecated_at)}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Revertida em: </dt>
                <dd className="inline">{fmtDate(skill.rolled_back_at)}</dd>
              </div>
            </dl>
          </div>

          {isFounder && skill.agent_id !== null && (
            <SkillActions skill={skill} tenantId={tenantId} onMutated={onMutated} />
          )}

          <Section title="Objetivo">
            <p className="whitespace-pre-wrap text-sm text-zinc-800">{skill.goal}</p>
          </Section>

          <Section title="Quando usar">
            <p className="whitespace-pre-wrap text-sm text-zinc-800">
              {skill.when_to_use}
            </p>
          </Section>

          <Section title="Procedimento">
            <JsonBlock value={skill.procedure} />
          </Section>

          <Section title="Ferramentas permitidas">
            <TagList
              items={skill.allowed_tools}
              empty="Nenhuma (sem acesso a ferramentas)."
            />
          </Section>

          <Section title="Descritores de política">
            <TagList items={skill.policy_descriptors} empty="Nenhum." />
          </Section>

          <Section title="Restrições">
            <JsonBlock value={skill.constraints} />
          </Section>

          <Section title="Schema de entrada">
            <JsonBlock value={skill.input_schema} />
          </Section>

          <Section title="Schema de saída">
            <JsonBlock value={skill.output_schema} />
          </Section>

          <Section title="Dicas de runtime">
            <JsonBlock value={skill.runtime_hints} />
          </Section>

          <Section title="Critérios de sucesso">
            <JsonBlock value={skill.success_criteria} />
          </Section>

          <Section title="Modos de falha">
            <JsonBlock value={skill.failure_modes} />
          </Section>

          {skill.proposed_reason && (
            <Section title="Motivo da proposta">
              <p className="whitespace-pre-wrap text-sm text-zinc-800">
                {skill.proposed_reason}
              </p>
            </Section>
          )}

          {skill.rollback_reason && (
            <Section title="Motivo da reversão">
              <p className="whitespace-pre-wrap text-sm text-zinc-800">
                {skill.rollback_reason}
              </p>
            </Section>
          )}

          <Section title="Versões">
            {versionsQuery.isLoading ? (
              <p className="text-xs text-zinc-500">Carregando versões…</p>
            ) : versionsQuery.error ? (
              <p className="text-xs text-red-600">
                Erro: {versionsQuery.error.message}
              </p>
            ) : versions.length === 0 ? (
              <p className="text-xs text-zinc-400">Nenhuma versão encontrada.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-zinc-200">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-zinc-200 bg-zinc-50 text-left">
                      <th className="px-3 py-2 font-semibold text-zinc-600">Versão</th>
                      <th className="px-3 py-2 font-semibold text-zinc-600">Status</th>
                      <th className="px-3 py-2 font-semibold text-zinc-600">Ativada em</th>
                      <th className="px-3 py-2 font-semibold text-zinc-600">Criada em</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr
                        key={v.id}
                        className={`border-b border-zinc-100 last:border-0 ${
                          v.id === skill.id ? 'bg-brand-50' : ''
                        }`}
                      >
                        <td className="px-3 py-2 tabular-nums">v{v.version}</td>
                        <td className="px-3 py-2">
                          <StatusBadge status={v.status} />
                        </td>
                        <td className="px-3 py-2 text-zinc-500">
                          {fmtDate(v.activated_at)}
                        </td>
                        <td className="px-3 py-2 text-zinc-500">
                          {fmtDate(v.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
      )}
    </Modal>
  );
}
