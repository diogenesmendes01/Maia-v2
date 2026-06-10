'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';
import ChannelPolicyModal from './_components/channel-policy-modal.js';
import { PageHeader } from '../../../components/ui/page-header.js';
import { Button } from '../../../components/ui/button.js';
import { Field, Select } from '../../../components/ui/field.js';
import {
  TableShell,
  Table,
  THead,
  Th,
  Tr,
  Td,
} from '../../../components/ui/table.js';
import {
  LoadingState,
  ErrorState,
  EmptyState,
  Alert,
} from '../../../components/ui/states.js';
import { IconMessage } from '../../../components/ui/icons.js';

/**
 * Setup → Canais (founder/owner). Configura a política (papel padrão +
 * comportamento de troca) por canal; toda mudança é auditada.
 */
export default function ChannelsSetupPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? '';
  const sessionTenant = session?.user?.tenant_id ?? '';
  const allowed = role === 'founder' || role === 'owner';

  const [tenantId, setTenantId] = React.useState(sessionTenant);
  React.useEffect(() => {
    if (sessionTenant && !tenantId) setTenantId(sessionTenant);
  }, [sessionTenant, tenantId]);

  const [agentId, setAgentId] = React.useState('');
  const [policyTarget, setPolicyTarget] = React.useState<{
    channelId: string;
    channelLabel: string;
  } | null>(null);

  const tenantsQuery = trpc.tenants.list.useQuery(undefined, {
    enabled: role === 'founder',
  });

  const agentsQuery = trpc.agents.list.useQuery(
    { tenantId },
    { enabled: allowed && tenantId !== '' },
  );

  const channelsQuery = trpc.channelPolicies.listChannels.useQuery(
    { tenantId, agentId },
    { enabled: allowed && tenantId !== '' && agentId !== '' },
  );

  if (status === 'loading') return <LoadingState label="Carregando sessão…" />;

  if (!allowed) {
    return (
      <div>
        <PageHeader title="Canais" />
        <Alert tone="danger" title="Acesso restrito">
          Editar políticas de canal exige o papel{' '}
          <code className="font-mono">founder</code> ou{' '}
          <code className="font-mono">owner</code>. Seu papel atual é{' '}
          <code className="font-mono">{role || '(nenhum)'}</code>.
        </Alert>
      </div>
    );
  }

  const channels = channelsQuery.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Canais"
        description="Configure a política (papel padrão + comportamento de troca) por canal. Toda mudança é auditada."
      />

      <div className="mb-5 flex flex-wrap items-end gap-4">
        {role === 'founder' ? (
          <Field label="Tenant" className="w-56">
            <Select
              value={tenantId}
              onChange={(e) => {
                setTenantId(e.target.value);
                setAgentId('');
              }}
            >
              <option value="">Selecione…</option>
              {(tenantsQuery.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Tenant" className="w-56">
            <span className="flex h-9 items-center rounded-lg bg-zinc-100 px-3 font-mono text-sm text-zinc-700">
              {sessionTenant}
            </span>
          </Field>
        )}

        <Field label="Agente" className="w-56">
          <Select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            disabled={!tenantId}
          >
            <option value="">Selecione…</option>
            {(agentsQuery.data?.items ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {!agentId ? (
        <EmptyState
          icon={<IconMessage size={36} />}
          title="Escolha um tenant e um agente"
          description="Selecione um tenant e um agente para ver os canais deles."
        />
      ) : channelsQuery.isLoading ? (
        <LoadingState label="Carregando canais…" />
      ) : channelsQuery.error ? (
        <ErrorState
          message={channelsQuery.error.message}
          onRetry={() => void channelsQuery.refetch()}
        />
      ) : channels.length === 0 ? (
        <EmptyState
          icon={<IconMessage size={36} />}
          title="Nenhum canal ainda para este agente"
        />
      ) : (
        <TableShell>
          <Table>
            <THead>
              <Th>Tipo</Th>
              <Th>ID externo</Th>
              <Th>Nome de exibição</Th>
              <Th>ID do canal</Th>
              <Th>Ações</Th>
            </THead>
            <tbody>
              {channels.map((c) => (
                <Tr key={c.id}>
                  <Td>{c.channel_type}</Td>
                  <Td className="font-mono text-xs">{c.external_id}</Td>
                  <Td>{c.display_name ?? '—'}</Td>
                  <Td className="font-mono text-xs">{c.id}</Td>
                  <Td>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setPolicyTarget({
                          channelId: c.id,
                          channelLabel: `${c.channel_type}/${c.external_id}`,
                        })
                      }
                    >
                      Editar política
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableShell>
      )}

      {policyTarget && tenantId && agentId && (
        <ChannelPolicyModal
          tenantId={tenantId}
          agentId={agentId}
          channelId={policyTarget.channelId}
          channelLabel={policyTarget.channelLabel}
          onClose={() => {
            setPolicyTarget(null);
          }}
        />
      )}
    </div>
  );
}
