'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { PageHeader } from '../../components/ui/page-header.js';
import { Badge, StatusBadge } from '../../components/ui/badge.js';
import {
  TableShell,
  Table,
  THead,
  Th,
  Tr,
  Td,
} from '../../components/ui/table.js';
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from '../../components/ui/states.js';
import { IconActivity } from '../../components/ui/icons.js';

export default function TracesPage() {
  const { data: session } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';

  // Issue #514 §7 — cursor pagination. Cursors are opaque strings from the
  // server; we keep the stack so "voltar" is a pop rather than a re-query
  // from page 1.
  const [cursorStack, setCursorStack] = React.useState<Array<string | null>>([null]);
  const cursor = cursorStack[cursorStack.length - 1] ?? null;

  const [sideEffectOnly, setSideEffectOnly] = React.useState(false);

  const tracesQuery = trpc.traces.listTraces.useQuery(
    { tenantId, limit: 50, cursor, ...(sideEffectOnly ? { sideEffectOnly: true } : {}) },
    { enabled: tenantId !== '' },
  );

  const resetToFirstPage = React.useCallback(() => setCursorStack([null]), []);

  if (!tenantId) return <LoadingState label="Carregando sessão…" />;

  const items = tracesQuery.data?.items ?? [];
  const hasMore = tracesQuery.data?.hasMore ?? false;
  const nextCursor = tracesQuery.data?.nextCursor ?? null;
  const page = cursorStack.length;

  return (
    <div>
      <PageHeader
        title="Traces"
        description="Explore os traces de execução. Corpos completos são redigidos; solicite um snapshot para a visão sem redação."
        actions={
          <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-600">
            <input
              type="checkbox"
              checked={sideEffectOnly}
              onChange={(e) => {
                setSideEffectOnly(e.target.checked);
                resetToFirstPage();
              }}
            />
            Só com efeito colateral
          </label>
        }
      />

      {tracesQuery.isLoading ? (
        <LoadingState label="Carregando traces…" />
      ) : tracesQuery.error ? (
        <ErrorState
          message={tracesQuery.error.message}
          onRetry={() => void tracesQuery.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconActivity size={28} />}
          title="Nenhum trace ainda"
          description="O armazenamento de traces de runtime (P10b) ainda não foi populado."
        />
      ) : (
        <>
          <TableShell>
            <Table>
              <THead>
                <Th>Trace ID</Th>
                <Th>Agente</Th>
                <Th>Conversa</Th>
                <Th>Início</Th>
                <Th>Efeito</Th>
                <Th>Corpo</Th>
                <Th>Decisão</Th>
              </THead>
              <tbody>
                {items.map((t) => (
                  <Tr key={t.id}>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <Link
                          href={`/traces/${t.id}`}
                          className="font-mono text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline"
                        >
                          {t.id.slice(0, 8)}
                        </Link>
                        {/* A retry is a different trace id for the SAME turn —
                            label it so the list does not read as N incidents. */}
                        {t.is_retry && <Badge tone="warning">retry #{t.attempt}</Badge>}
                      </div>
                    </Td>
                    <Td>{t.agent_id}</Td>
                    <Td className="font-mono text-xs text-zinc-700">
                      {t.conversa_id ? t.conversa_id.slice(0, 8) : '—'}
                    </Td>
                    <Td className="text-zinc-600">
                      {new Date(t.started_at).toLocaleString('pt-BR')}
                    </Td>
                    <Td>
                      <Badge
                        tone={
                          t.side_effect_level === 'critical' || t.side_effect_level === 'high'
                            ? 'danger'
                            : t.side_effect_level === 'medium'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {t.side_effect_level}
                      </Badge>
                    </Td>
                    <Td>
                      {/* Issue #514 §7: pending/orphaned bodies must be VISIBLE.
                          An orphaned body is lost evidence, not an empty trace. */}
                      <Badge
                        tone={
                          t.body_status === 'persisted'
                            ? 'success'
                            : t.body_status === 'orphaned'
                              ? 'danger'
                              : 'neutral'
                        }
                      >
                        {t.body_status}
                      </Badge>
                    </Td>
                    <Td>
                      {t.outcome ? (
                        <StatusBadge status={t.outcome} />
                      ) : (
                        <Badge tone="neutral">pendente</Badge>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableShell>

          <div className="mt-4 flex items-center justify-between text-sm text-zinc-600">
            <span>Página {page}</span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-md border border-zinc-300 px-3 py-1.5 disabled:opacity-40"
                disabled={page === 1 || tracesQuery.isFetching}
                onClick={() => setCursorStack((s) => s.slice(0, -1))}
              >
                Anterior
              </button>
              <button
                type="button"
                className="rounded-md border border-zinc-300 px-3 py-1.5 disabled:opacity-40"
                disabled={!hasMore || nextCursor === null || tracesQuery.isFetching}
                onClick={() => setCursorStack((s) => [...s, nextCursor])}
              >
                Próxima
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
