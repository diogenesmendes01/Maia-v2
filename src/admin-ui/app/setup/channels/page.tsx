'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';
import ChannelPolicyModal from './_components/channel-policy-modal.js';
import ChannelCreateModal from './_components/channel-create-modal.js';
import RoleCreateModal from './_components/role-create-modal.js';
import { PageHeader } from '../../../components/ui/page-header.js';
import { Badge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import { Card, CardHeader, CardBody } from '../../../components/ui/card.js';
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
 * Setup → Canais (founder/owner). Registra canais e papéis do agente e
 * configura a política (papel padrão + comportamento de troca) por canal;
 * toda mudança é auditada. Canais e papéis eram seed/SQL-only — esta tela
 * fecha o elo que faltava na jornada "agente novo → responde no canal".
 */
export default function ChannelsSetupPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? '';
  const sessionTenant = session?.user?.tenant_id ?? '';
  const allowed = role === 'founder' || role === 'owner';

  const utils = trpc.useUtils();

  const [tenantId, setTenantId] = React.useState(sessionTenant);
  React.useEffect(() => {
    if (sessionTenant && !tenantId) setTenantId(sessionTenant);
  }, [sessionTenant, tenantId]);

  const [agentId, setAgentId] = React.useState('');
  const [policyTarget, setPolicyTarget] = React.useState<{
    channelId: string;
    channelLabel: string;
  } | null>(null);
  const [showChannelCreate, setShowChannelCreate] = React.useState(false);
  const [showRoleCreate, setShowRoleCreate] = React.useState(false);

  const tenantsQuery = trpc.tenants.list.useQuery(undefined, {
    enabled: role === 'founder',
  });

  const agentsQuery = trpc.agents.list.useQuery(
    { tenantId },
    { enabled: allowed && tenantId !== '' },
  );

  const overviewQuery = trpc.channelPolicies.channelsOverview.useQuery(
    { tenantId, agentId },
    { enabled: allowed && tenantId !== '' && agentId !== '' },
  );

  const rolesQuery = trpc.channelPolicies.listRoles.useQuery(
    { tenantId, agentId },
    { enabled: allowed && tenantId !== '' && agentId !== '' },
  );

  const invalidateAll = React.useCallback(() => {
    void utils.channelPolicies.channelsOverview.invalidate({ tenantId, agentId });
    void utils.channelPolicies.listChannels.invalidate({ tenantId, agentId });
    void utils.channelPolicies.listRoles.invalidate({ tenantId, agentId });
  }, [utils, tenantId, agentId]);

  if (status === 'loading') return <LoadingState label="Carregando sessão…" />;

  if (!allowed) {
    return (
      <div>
        <PageHeader title="Canais" />
        <Alert tone="danger" title="Acesso restrito">
          Editar canais e políticas exige o papel{' '}
          <code className="font-mono">founder</code> ou{' '}
          <code className="font-mono">owner</code>. Seu papel atual é{' '}
          <code className="font-mono">{role || '(nenhum)'}</code>.
        </Alert>
      </div>
    );
  }

  const channels = overviewQuery.data?.channels ?? [];
  const roles = rolesQuery.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Canais"
        description="Registre canais e papéis do agente e configure a política (papel padrão + comportamento de troca) por canal. Toda mudança é auditada."
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
          description="Selecione um tenant e um agente para ver os canais e papéis deles."
        />
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Canais do agente"
              description="Um canal representa a linha em que as mensagens chegam. Cada canal precisa de uma política com papel padrão."
              actions={
                <Button size="sm" onClick={() => setShowChannelCreate(true)}>
                  Novo canal
                </Button>
              }
            />
            <CardBody>
              {overviewQuery.isLoading ? (
                <LoadingState label="Carregando canais…" />
              ) : overviewQuery.error ? (
                <ErrorState
                  message={overviewQuery.error.message}
                  onRetry={() => void overviewQuery.refetch()}
                />
              ) : channels.length === 0 ? (
                <EmptyState
                  icon={<IconMessage size={36} />}
                  title="Nenhum canal ainda para este agente"
                  description="Sem canal o agente não recebe mensagens. Registre o primeiro."
                  action={
                    <Button size="sm" onClick={() => setShowChannelCreate(true)}>
                      Novo canal
                    </Button>
                  }
                />
              ) : (
                <TableShell>
                  <Table>
                    <THead>
                      <Th>Tipo</Th>
                      <Th>ID externo</Th>
                      <Th>Nome de exibição</Th>
                      <Th>Política</Th>
                      <Th>Ações</Th>
                    </THead>
                    <tbody>
                      {channels.map((c) => (
                        <Tr key={c.id}>
                          <Td>{c.channel_type}</Td>
                          <Td className="font-mono text-xs">{c.external_id}</Td>
                          <Td>{c.display_name ?? '—'}</Td>
                          <Td>
                            {c.policy_ready ? (
                              <Badge tone="success">
                                papel padrão: {c.default_role_key}
                              </Badge>
                            ) : c.has_policy ? (
                              <Badge tone="danger">papel padrão inativo</Badge>
                            ) : (
                              <Badge tone="warning">sem política</Badge>
                            )}
                          </Td>
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
                              {c.has_policy ? 'Editar política' : 'Criar política'}
                            </Button>
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </TableShell>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Papéis do agente"
              description="Modos operacionais que a política de canal pode ativar. O primeiro papel criado vira o padrão."
              actions={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setShowRoleCreate(true)}
                >
                  Novo papel
                </Button>
              }
            />
            <CardBody>
              {rolesQuery.isLoading ? (
                <LoadingState label="Carregando papéis…" />
              ) : rolesQuery.error ? (
                <ErrorState
                  message={rolesQuery.error.message}
                  onRetry={() => void rolesQuery.refetch()}
                />
              ) : roles.length === 0 ? (
                <EmptyState
                  title="Nenhum papel ainda para este agente"
                  description="A política de canal exige um papel padrão — crie o primeiro."
                  action={
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setShowRoleCreate(true)}
                    >
                      Novo papel
                    </Button>
                  }
                />
              ) : (
                <TableShell>
                  <Table>
                    <THead>
                      <Th>Chave</Th>
                      <Th>Nome</Th>
                      <Th>Padrão</Th>
                    </THead>
                    <tbody>
                      {roles.map((r) => (
                        <Tr key={r.id}>
                          <Td className="font-mono text-xs">{r.role_key}</Td>
                          <Td>{r.display_name}</Td>
                          <Td>
                            {r.is_default ? (
                              <Badge tone="brand">padrão</Badge>
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
            </CardBody>
          </Card>
        </div>
      )}

      {policyTarget && tenantId && agentId && (
        <ChannelPolicyModal
          tenantId={tenantId}
          agentId={agentId}
          channelId={policyTarget.channelId}
          channelLabel={policyTarget.channelLabel}
          onClose={() => {
            setPolicyTarget(null);
            invalidateAll();
          }}
        />
      )}

      {showChannelCreate && tenantId && agentId && (
        <ChannelCreateModal
          tenantId={tenantId}
          agentId={agentId}
          onClose={() => setShowChannelCreate(false)}
          onCreated={invalidateAll}
        />
      )}

      {showRoleCreate && tenantId && agentId && (
        <RoleCreateModal
          tenantId={tenantId}
          agentId={agentId}
          hasRoles={roles.length > 0}
          onClose={() => setShowRoleCreate(false)}
          onCreated={invalidateAll}
        />
      )}
    </div>
  );
}
