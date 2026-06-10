'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { PageHeader } from '../../components/ui/page-header.js';
import { Field, Select } from '../../components/ui/field.js';
import { StatusBadge } from '../../components/ui/badge.js';
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
import { IconLayers } from '../../components/ui/icons.js';

type ProcStatus = 'draft' | 'proposed' | 'active' | 'frozen' | 'rolled_back';

const STATUS_OPTIONS: ProcStatus[] = [
  'active',
  'proposed',
  'frozen',
  'rolled_back',
  'draft',
];

export default function ProceduresPage() {
  const { data: session, status } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';

  const [agentId, setAgentId] = React.useState('');
  const [procStatus, setProcStatus] = React.useState<ProcStatus>('active');

  const agentsQuery = trpc.agents.list.useQuery(
    { tenantId },
    { enabled: tenantId !== '' },
  );

  const defsQuery = trpc.procedures.listDefinitions.useQuery(
    { tenantId, agentId, status: procStatus, limit: 100 },
    { enabled: tenantId !== '' && agentId !== '' },
  );

  if (status === 'loading') return <LoadingState label="Carregando sessão…" />;

  const items = defsQuery.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Procedures"
        description={
          <>
            Definições de procedures por agente (
            <code className="font-mono text-xs">procedure_definitions</code>),
            filtradas por status de ciclo de vida.
          </>
        }
      />

      <div className="mb-4 flex flex-wrap gap-3">
        <Field label="Agente" className="w-64">
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Selecione…</option>
            {(agentsQuery.data?.items ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.nome} ({a.id})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status" className="w-44">
          <Select
            value={procStatus}
            onChange={(e) => setProcStatus(e.target.value as ProcStatus)}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {!agentId ? (
        <EmptyState
          icon={<IconLayers size={28} />}
          title="Selecione um agente"
          description="Escolha um agente acima para listar suas procedures."
        />
      ) : defsQuery.isLoading ? (
        <LoadingState label="Carregando procedures…" />
      ) : defsQuery.error ? (
        <ErrorState
          message={defsQuery.error.message}
          onRetry={() => void defsQuery.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconLayers size={28} />}
          title="Nenhuma procedure neste status"
        />
      ) : (
        <TableShell>
          <Table>
            <THead>
              <Th>Nome</Th>
              <Th>Versão</Th>
              <Th>Status</Th>
              <Th>Criada em</Th>
            </THead>
            <tbody>
              {items.map((p) => (
                <Tr key={p.id}>
                  <Td className="font-mono text-xs text-zinc-700">{p.nome}</Td>
                  <Td className="tabular-nums">v{p.version_number}</Td>
                  <Td>
                    <StatusBadge status={p.status} />
                  </Td>
                  <Td className="text-zinc-600">
                    {new Date(p.created_at).toLocaleString('pt-BR')}
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
