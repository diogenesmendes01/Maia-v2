'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { PageHeader } from '../../components/ui/page-header.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardHeader, CardBody } from '../../components/ui/card.js';
import { LoadingState, ErrorState } from '../../components/ui/states.js';
import InboxTable from './_components/inbox-table.js';
import BulkRejectModal from './_components/bulk-reject-modal.js';
import { TYPE_LABELS, RISK_LABELS, ALL_TYPES, ALL_RISKS } from './_components/labels.js';
import type { ProposalRow } from '../../trpc/types.js';

/** Papéis autorizados a rejeitar em massa (espelha ctx.assertRole no router). */
const BULK_REJECT_ROLES = ['owner', 'compliance_officer', 'founder'];

/**
 * Fila diária de aprovações do operador: contadores por tipo (clicáveis para
 * filtrar), filtro por risco, tabela de propostas pendentes e rejeição em
 * massa para papéis autorizados.
 */
export default function InboxPage() {
  const { data: session, status } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';
  const role = session?.user?.role ?? 'viewer';
  const canBulkReject = BULK_REJECT_ROLES.includes(role);

  const [filters, setFilters] = React.useState<{
    types?: ProposalRow['type'][];
    risks?: ProposalRow['risk'][];
    sources?: string[];
  }>({});

  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [showBulkReject, setShowBulkReject] = React.useState(false);

  const proposalsQuery = trpc.inbox.listProposals.useQuery(
    {
      tenantId,
      ...filters,
      status: 'proposed',
      limit: 50,
    },
    { enabled: tenantId !== '' },
  );

  const countersQuery = trpc.inbox.counters.useQuery(
    { tenantId },
    { enabled: tenantId !== '', refetchInterval: 30_000 },
  );

  // Perfis operacionais propostos NÃO passam por esta fila (são aprovados na
  // aba Versões do agente, com diff contra a versão ativa). Este agregado
  // garante que a tela "Aprovações" ao menos aponte para eles em vez de
  // omiti-los — fase 2 do relatório de complexidade.
  const pendingProfilesQuery = trpc.agents.pendingProfileApprovals.useQuery(
    { tenantId },
    { enabled: tenantId !== '', refetchInterval: 30_000 },
  );

  const toggleType = (t: ProposalRow['type']) => {
    const cur = filters.types ?? [];
    const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
    setFilters({ ...filters, types: next.length > 0 ? next : undefined });
  };
  const toggleRisk = (r: ProposalRow['risk']) => {
    const cur = filters.risks ?? [];
    const next = cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r];
    setFilters({ ...filters, risks: next.length > 0 ? next : undefined });
  };
  const hasFilters = (filters.types?.length ?? 0) > 0 || (filters.risks?.length ?? 0) > 0;

  if (status === 'loading' || !tenantId) {
    return <LoadingState label="Carregando sessão…" />;
  }

  const counters = countersQuery.data;
  const total = counters ? Object.values(counters).reduce((a, b) => a + b, 0) : null;

  return (
    <div>
      <PageHeader
        title="Aprovações"
        description="Propostas pendentes de todas as fontes de governança — revise, aprove ou rejeite antes que entrem em vigor."
        actions={
          total !== null && (
            <Badge tone={total > 0 ? 'warning' : 'success'}>
              {total} pendente{total === 1 ? '' : 's'}
            </Badge>
          )
        }
      />

      {/* Contadores por tipo — clicáveis para filtrar a tabela. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {ALL_TYPES.map((t) => {
          const active = filters.types?.includes(t) ?? false;
          const count = counters?.[t] ?? 0;
          return (
            <button
              key={t}
              onClick={() => toggleType(t)}
              aria-pressed={active}
              className={`relative overflow-hidden rounded-xl border bg-white px-4 py-3 text-left shadow-card transition-all hover:shadow-md ${
                active
                  ? 'border-brand-500 ring-2 ring-brand-500/20'
                  : 'border-zinc-200 hover:border-brand-300'
              }`}
            >
              <span
                aria-hidden
                className={`absolute inset-y-0 left-0 w-1 ${
                  active ? 'bg-brand-500' : count > 0 ? 'bg-amber-500' : 'bg-zinc-300'
                }`}
              />
              <span className="block text-2xs font-semibold uppercase tracking-wide text-zinc-500">
                {TYPE_LABELS[t]}
              </span>
              <span className="mt-1 block text-2xl font-semibold tabular-nums text-zinc-900">
                {countersQuery.isLoading ? '—' : count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Perfis de agente pendentes — aprovados na página do agente, não
          nesta fila; o card existe para a fila não esconder essa pendência. */}
      {(pendingProfilesQuery.data?.items.length ?? 0) > 0 && (
        <div className="mt-4">
          <Card>
            <CardHeader
              title="Perfis de agente aguardando aprovação"
              description="Versões de perfil operacional propostas. A aprovação acontece na aba Versões de cada agente, com o diff contra a versão ativa."
              actions={
                <Badge tone="warning">
                  {pendingProfilesQuery.data!.total} pendente
                  {pendingProfilesQuery.data!.total === 1 ? '' : 's'}
                </Badge>
              }
            />
            <CardBody>
              <ul className="divide-y divide-zinc-100">
                {pendingProfilesQuery.data!.items.map((p) => (
                  <li
                    key={p.agent_id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                  >
                    <span className="min-w-0 text-sm text-zinc-800">
                      <span className="font-medium">{p.agent_nome}</span>{' '}
                      <code className="font-mono text-2xs text-zinc-400">
                        {p.agent_id}
                      </code>
                      <span className="ml-2 text-xs text-zinc-500">
                        {p.pending_count === 1
                          ? '1 versão proposta'
                          : `${p.pending_count} versões propostas`}{' '}
                        · desde {new Date(p.oldest_created_at).toLocaleString('pt-BR')}
                      </span>
                    </span>
                    <Link href={`/agents/${encodeURIComponent(p.agent_id)}?tab=versions`}>
                      <Button size="sm" variant="secondary">
                        Revisar e aprovar
                      </Button>
                    </Link>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      )}

      {/* Filtro por risco + limpar. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-zinc-500">Risco:</span>
        {ALL_RISKS.map((r) => {
          const active = filters.risks?.includes(r) ?? false;
          return (
            <button
              key={r}
              onClick={() => toggleRisk(r)}
              aria-pressed={active}
              className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors ${
                active
                  ? 'bg-brand-600 text-white ring-brand-600'
                  : 'bg-white text-zinc-600 ring-zinc-300 hover:bg-zinc-50'
              }`}
            >
              {RISK_LABELS[r]}
            </button>
          );
        })}
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => setFilters({})}>
            Limpar filtros
          </Button>
        )}
      </div>

      <div className="mt-5">
        {proposalsQuery.isLoading ? (
          <LoadingState label="Carregando propostas…" />
        ) : proposalsQuery.error ? (
          <ErrorState
            message={proposalsQuery.error.message}
            onRetry={() => void proposalsQuery.refetch()}
          />
        ) : (
          <InboxTable
            proposals={proposalsQuery.data?.items ?? []}
            selectable={canBulkReject}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
          />
        )}
      </div>

      {/* Barra fixa de ação em lote — aparece quando há seleção. */}
      {canBulkReject && selectedIds.length > 0 && (
        <div className="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-5 py-3 shadow-overlay">
          <span className="text-sm text-zinc-700">
            <strong className="font-semibold">{selectedIds.length}</strong>{' '}
            proposta{selectedIds.length === 1 ? '' : 's'} selecionada
            {selectedIds.length === 1 ? '' : 's'}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelectedIds([])}>
              Limpar seleção
            </Button>
            <Button variant="danger" size="sm" onClick={() => setShowBulkReject(true)}>
              Rejeitar em massa
            </Button>
          </div>
        </div>
      )}

      <BulkRejectModal
        open={showBulkReject}
        tenantId={tenantId}
        ids={selectedIds}
        onClose={() => {
          setShowBulkReject(false);
          setSelectedIds([]);
          void proposalsQuery.refetch();
          void countersQuery.refetch();
        }}
      />
    </div>
  );
}
