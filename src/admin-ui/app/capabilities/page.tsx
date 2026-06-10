'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { PageHeader } from '../../components/ui/page-header.js';
import { Field, Select } from '../../components/ui/field.js';
import { Tabs } from '../../components/ui/tabs.js';
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

type Tab = 'domains' | 'skills' | 'gaps' | 'proposals';

export default function CapabilitiesPage() {
  const { data: session, status } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';

  const [agentId, setAgentId] = React.useState('');
  const [tab, setTab] = React.useState<Tab>('proposals');

  const agentsQuery = trpc.agents.list.useQuery(
    { tenantId },
    { enabled: tenantId !== '' },
  );

  const domainsQuery = trpc.capabilities.listDomains.useQuery(
    { tenantId, agentId },
    { enabled: tenantId !== '' && agentId !== '' && tab === 'domains' },
  );
  const skillsQuery = trpc.capabilities.listSkills.useQuery(
    { tenantId, agentId },
    { enabled: tenantId !== '' && agentId !== '' && tab === 'skills' },
  );
  const gapsQuery = trpc.capabilities.listGaps.useQuery(
    { tenantId, agentId },
    { enabled: tenantId !== '' && agentId !== '' && tab === 'gaps' },
  );
  const proposalsQuery = trpc.capabilities.listProposals.useQuery(
    { tenantId, agentId, status: 'submitted' },
    { enabled: tenantId !== '' && agentId !== '' && tab === 'proposals' },
  );

  if (status === 'loading') return <LoadingState label="Carregando sessão…" />;

  return (
    <div>
      <PageHeader
        title="Capacidades"
        description="Catálogo de domínios e skills, lacunas detectadas pelo agente e propostas de capacidade pendentes (P5 — aquisição dialógica de capacidades)."
      />

      <div className="mb-4 max-w-xs">
        <Field label="Agente">
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Selecione…</option>
            {(agentsQuery.data?.items ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.nome} ({a.id})
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Tabs
        className="mb-4"
        tabs={[
          { id: 'proposals', label: 'Propostas' },
          { id: 'gaps', label: 'Lacunas' },
          { id: 'skills', label: 'Skills' },
          { id: 'domains', label: 'Domínios' },
        ]}
        value={tab}
        onChange={(id) => setTab(id as Tab)}
      />

      {!agentId ? (
        <EmptyState
          icon={<IconLayers size={28} />}
          title="Selecione um agente"
          description="Escolha um agente acima para ver suas capacidades."
        />
      ) : tab === 'proposals' ? (
        <DataTable
          query={proposalsQuery}
          columns={[
            { key: 'title', label: 'Título' },
            { key: 'capability_type', label: 'Tipo', kind: 'mono' },
            { key: 'status', label: 'Status', kind: 'status' },
            { key: 'submitted_at', label: 'Enviada em', kind: 'date' },
          ]}
          emptyLabel="Nenhuma proposta de capacidade pendente."
        />
      ) : tab === 'gaps' ? (
        <DataTable
          query={gapsQuery}
          columns={[
            { key: 'capability_description', label: 'Capacidade' },
            { key: 'current_level', label: 'Nível' },
            { key: 'tipo', label: 'Tipo' },
            { key: 'last_observed', label: 'Última observação', kind: 'date' },
          ]}
          emptyLabel="Nenhuma lacuna de capacidade registrada."
        />
      ) : tab === 'skills' ? (
        <DataTable
          query={skillsQuery}
          columns={[
            { key: 'domain', label: 'Domínio' },
            { key: 'skill_name', label: 'Skill' },
            { key: 'confidence', label: 'Confiança' },
            { key: 'evidence_count', label: 'Evidências' },
          ]}
          emptyLabel="Nenhuma skill catalogada ainda."
        />
      ) : (
        <DataTable
          query={domainsQuery}
          columns={[
            { key: 'domain', label: 'Domínio' },
            { key: 'confidence', label: 'Confiança' },
            { key: 'evidence_count', label: 'Evidências' },
            { key: 'updated_at', label: 'Atualizado em', kind: 'date' },
          ]}
          emptyLabel="Nenhum domínio catalogado ainda."
        />
      )}
    </div>
  );
}

interface Col {
  key: string;
  label: string;
  kind?: 'date' | 'status' | 'mono';
}

type QueryShape = {
  data?: { items: unknown[] };
  isLoading: boolean;
  error: { message: string } | null;
  refetch: () => unknown;
};

function renderCell(value: unknown, col: Col): React.ReactNode {
  if (value == null) return '—';
  if (col.kind === 'date' && (typeof value === 'string' || value instanceof Date)) {
    return new Date(value).toLocaleString('pt-BR');
  }
  if (col.kind === 'status') return <StatusBadge status={String(value)} />;
  if (col.kind === 'mono') {
    return <span className="font-mono text-xs text-zinc-700">{String(value)}</span>;
  }
  return String(value);
}

function DataTable({
  query,
  columns,
  emptyLabel,
}: {
  query: QueryShape;
  columns: Col[];
  emptyLabel: string;
}) {
  if (query.isLoading) return <LoadingState />;
  if (query.error) {
    return (
      <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
    );
  }
  const items = (query.data?.items ?? []) as Array<Record<string, unknown>>;
  if (items.length === 0) {
    return <EmptyState icon={<IconLayers size={28} />} title={emptyLabel} />;
  }
  return (
    <TableShell>
      <Table>
        <THead>
          {columns.map((c) => (
            <Th key={c.key}>{c.label}</Th>
          ))}
        </THead>
        <tbody>
          {items.map((row, i) => (
            <Tr key={typeof row.id === 'string' ? row.id : i}>
              {columns.map((c) => (
                <Td key={c.key}>{renderCell(row[c.key], c)}</Td>
              ))}
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableShell>
  );
}
