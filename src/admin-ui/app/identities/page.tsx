'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { PageHeader } from '../../components/ui/page-header.js';
import { StatusBadge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Field, Select } from '../../components/ui/field.js';
import {
  LoadingState,
  ErrorState,
  EmptyState,
  Alert,
} from '../../components/ui/states.js';
import {
  TableShell,
  Table,
  THead,
  Th,
  Tr,
  Td,
} from '../../components/ui/table.js';

/**
 * Cross-agent view of operational profile versions — READ-ONLY overview.
 *
 * A aprovação de perfil tem UMA superfície: a aba Versões da página do
 * agente (`/agents/[id]?tab=versions`), onde o operador vê o diff completo
 * contra a versão ativa antes de decidir. Esta tela já duplicou esse fluxo
 * (mesma mutation `agents.approveProfile`, mesmo modal) — a redundância foi
 * removida na fase 2 do relatório de complexidade: aqui se OBSERVA o parque
 * de identidades; aprova-se no agente.
 */
export default function IdentitiesPage() {
  const { data: session, status } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';
  const [agentId, setAgentId] = React.useState('');

  const agentsQuery = trpc.agents.list.useQuery(
    { tenantId },
    { enabled: tenantId !== '' },
  );
  const versionsQuery = trpc.versions.listVersions.useQuery(
    {
      tenantId,
      sotKind: 'agent_operational_profile_versions',
      agentId: agentId || undefined,
      limit: 100,
    },
    { enabled: tenantId !== '' },
  );

  if (status === 'loading') return <LoadingState label="Carregando sessão…" />;

  const items = versionsQuery.data?.items ?? [];
  const pendingCount = items.filter((v) => v.status === 'proposed').length;

  return (
    <div>
      <PageHeader
        title="Identidades"
        description="Visão geral das versões de perfil operacional por agente. A linha ativa é o que o agente executa hoje; propostas são aprovadas na aba Versões do agente."
      />

      {pendingCount > 0 && (
        <div className="mb-4">
          <Alert tone="warning" title="Aprovações pendentes">
            {pendingCount === 1
              ? 'Há 1 versão proposta aguardando aprovação.'
              : `Há ${pendingCount} versões propostas aguardando aprovação.`}{' '}
            Use o botão da linha para revisar o diff e aprovar na página do
            agente.
          </Alert>
        </div>
      )}

      <div className="mb-5 max-w-xs">
        <Field label="Filtrar por agente">
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Todos</option>
            {(agentsQuery.data?.items ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.nome} ({a.id})
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {versionsQuery.isLoading ? (
        <LoadingState label="Carregando versões…" />
      ) : versionsQuery.error ? (
        <ErrorState
          message={versionsQuery.error.message}
          onRetry={() => void versionsQuery.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nenhuma versão de perfil"
          description="Crie um agente para gerar a primeira versão de identidade."
        />
      ) : (
        <TableShell>
          <Table>
            <THead>
              <Th>Agente</Th>
              <Th>Versão</Th>
              <Th>Status</Th>
              <Th>Criada em</Th>
              <Th className="text-right">Ações</Th>
            </THead>
            <tbody>
              {items.map((v) => (
                <Tr key={v.id}>
                  <Td>
                    <Link
                      href={`/agents/${encodeURIComponent(v.sot_id)}`}
                      className="font-mono text-xs font-medium text-brand-600 hover:underline"
                    >
                      {v.sot_id}
                    </Link>
                  </Td>
                  <Td className="font-medium">v{v.version}</Td>
                  <Td>
                    <StatusBadge status={v.status} />
                  </Td>
                  <Td className="text-zinc-600">
                    {new Date(v.created_at).toLocaleString('pt-BR')}
                  </Td>
                  <Td className="text-right">
                    {v.status === 'proposed' ? (
                      <Link
                        href={`/agents/${encodeURIComponent(v.sot_id)}?tab=versions`}
                      >
                        <Button size="sm" variant="success">
                          Revisar e aprovar no agente
                        </Button>
                      </Link>
                    ) : (
                      <span className="text-xs text-zinc-400">—</span>
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
