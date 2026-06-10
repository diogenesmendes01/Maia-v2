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

  const tracesQuery = trpc.traces.listTraces.useQuery(
    { tenantId, limit: 50 },
    { enabled: tenantId !== '' },
  );

  if (!tenantId) return <LoadingState label="Carregando sessão…" />;

  const items = tracesQuery.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Traces"
        description="Explore os traces de execução. Corpos completos são redigidos; solicite um snapshot para a visão sem redação."
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
        <TableShell>
          <Table>
            <THead>
              <Th>Trace ID</Th>
              <Th>Agente</Th>
              <Th>Conversa</Th>
              <Th>Início</Th>
              <Th>Duração</Th>
              <Th>Resultado</Th>
            </THead>
            <tbody>
              {items.map((t) => (
                <Tr key={t.id}>
                  <Td>
                    <Link
                      href={`/traces/${t.id}`}
                      className="font-mono text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline"
                    >
                      {t.id.slice(0, 8)}
                    </Link>
                  </Td>
                  <Td>{t.agent_id}</Td>
                  <Td className="font-mono text-xs text-zinc-700">
                    {t.conversa_id ?? '—'}
                  </Td>
                  <Td className="text-zinc-600">
                    {new Date(t.started_at).toLocaleString('pt-BR')}
                  </Td>
                  <Td className="tabular-nums text-zinc-600">
                    {t.duration_ms != null ? `${t.duration_ms} ms` : '—'}
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
      )}
    </div>
  );
}
