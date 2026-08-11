'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';
import ChannelPolicyModal from './_components/channel-policy-modal.js';
import ChannelCreateModal from './_components/channel-create-modal.js';
import RoleCreateModal from './_components/role-create-modal.js';
import LinePairingModal from './_components/line-pairing-modal.js';
import LineActionModal, {
  type LineActionKind,
} from './_components/line-action-modal.js';
import { presentState, presentReason, primaryAction } from './_components/line-state.js';
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
  const [pairTarget, setPairTarget] = React.useState<{
    channelId: string;
    channelLabel: string;
  } | null>(null);
  const [actionTarget, setActionTarget] = React.useState<{
    kind: LineActionKind;
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

  /**
   * Issue #518 — a listagem passou a ser `channelLines.list`, que devolve
   * canais ATIVOS E INATIVOS com o estado operacional da linha. A antiga
   * `channelsOverview` só trazia ativos, e como um canal WhatsApp nasce
   * inativo ("declarado"), ele SUMIA da tela logo depois de ser criado — o
   * operador não tinha por onde pareá-lo.
   */
  const linesQuery = trpc.channelLines.list.useQuery(
    { tenantId, agentId },
    { enabled: allowed && tenantId !== '' && agentId !== '' },
  );

  const rolesQuery = trpc.channelPolicies.listRoles.useQuery(
    { tenantId, agentId },
    { enabled: allowed && tenantId !== '' && agentId !== '' },
  );

  const invalidateAll = React.useCallback(() => {
    void utils.channelLines.list.invalidate({ tenantId, agentId });
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

  const lines = linesQuery.data?.lines ?? [];
  const pairingAvailable = linesQuery.data?.pairing_available ?? false;
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
              title="Linhas e canais do agente"
              description="Um canal representa a linha em que as mensagens chegam. Uma linha WhatsApp nasce DECLARADA (inativa) e só passa a rotear depois de provar a posse pelo pareamento e ter uma política com papel padrão."
              actions={
                <Button size="sm" onClick={() => setShowChannelCreate(true)}>
                  Novo canal
                </Button>
              }
            />
            <CardBody>
              {!pairingAvailable && !linesQuery.isLoading && !linesQuery.error && (
                <div className="mb-4">
                  <Alert tone="warning" title="Pareamento pelo console indisponível">
                    O QR e o código de pareamento só trafegam cifrados. Configure{' '}
                    <code className="font-mono">MAIA_STAGING_KEYRING</code> e{' '}
                    <code className="font-mono">MAIA_STAGING_ACTIVE_KEY_ID</code> no runtime e
                    no console para habilitar. Os estados abaixo continuam válidos.
                  </Alert>
                </div>
              )}
              {linesQuery.isLoading ? (
                <LoadingState label="Carregando linhas…" />
              ) : linesQuery.error ? (
                <ErrorState
                  message={linesQuery.error.message}
                  onRetry={() => void linesQuery.refetch()}
                />
              ) : lines.length === 0 ? (
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
                      <Th>Linha / ID externo</Th>
                      <Th>Estado</Th>
                      <Th>Roteamento</Th>
                      <Th>Política</Th>
                      <Th>Última transição</Th>
                      <Th>Ações</Th>
                    </THead>
                    <tbody>
                      {lines.map((line) => {
                        const label = `${line.channel_type}/${line.external_id}`;
                        const st = presentState(line.state);
                        const reason = presentReason(line.reason_code);
                        const action =
                          line.channel_type === 'whatsapp' ? primaryAction(line) : null;
                        return (
                          <Tr key={line.channel_id}>
                            <Td>{line.channel_type}</Td>
                            <Td className="font-mono text-xs">
                              {line.external_id}
                              {line.display_name && (
                                <span className="block font-sans text-2xs text-zinc-400">
                                  {line.display_name}
                                </span>
                              )}
                            </Td>
                            <Td>
                              <Badge tone={st.tone} title={st.help}>
                                {st.label}
                              </Badge>
                              {reason && (
                                <span className="mt-1 block text-2xs text-zinc-400">
                                  {reason}
                                </span>
                              )}
                            </Td>
                            <Td>
                              {line.active ? (
                                <Badge tone="success">roteando</Badge>
                              ) : (
                                <Badge tone="neutral">não roteia</Badge>
                              )}
                            </Td>
                            <Td>
                              {line.policy_ready ? (
                                <Badge tone="success">
                                  papel padrão: {line.default_role_key}
                                </Badge>
                              ) : line.has_policy ? (
                                <Badge tone="danger">papel padrão inativo</Badge>
                              ) : (
                                <Badge tone="warning">sem política</Badge>
                              )}
                            </Td>
                            <Td className="text-2xs text-zinc-500">
                              {line.last_transition_at
                                ? new Date(line.last_transition_at).toLocaleString('pt-BR')
                                : '—'}
                            </Td>
                            <Td>
                              <div className="flex flex-wrap gap-1">
                                {line.channel_type === 'whatsapp' &&
                                  (line.state === 'pairing' || action === 'pair') && (
                                    <Button
                                      variant={line.state === 'pairing' ? 'primary' : 'secondary'}
                                      size="sm"
                                      disabled={!pairingAvailable}
                                      onClick={() =>
                                        setPairTarget({
                                          channelId: line.channel_id,
                                          channelLabel: label,
                                        })
                                      }
                                    >
                                      {line.state === 'pairing'
                                        ? 'Acompanhar pareamento'
                                        : line.state === 'failed'
                                          ? 'Repetir pareamento'
                                          : 'Parear'}
                                    </Button>
                                  )}
                                {action === 'repair' && (
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() =>
                                      setActionTarget({
                                        kind: 'repair',
                                        channelId: line.channel_id,
                                        channelLabel: label,
                                      })
                                    }
                                  >
                                    Re-parear
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    setPolicyTarget({
                                      channelId: line.channel_id,
                                      channelLabel: label,
                                    })
                                  }
                                >
                                  {line.has_policy ? 'Editar política' : 'Criar política'}
                                </Button>
                                {line.active && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                      setActionTarget({
                                        kind: 'disable',
                                        channelId: line.channel_id,
                                        channelLabel: label,
                                      })
                                    }
                                  >
                                    Desabilitar
                                  </Button>
                                )}
                              </div>
                            </Td>
                          </Tr>
                        );
                      })}
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

      {pairTarget && tenantId && agentId && (
        <LinePairingModal
          tenantId={tenantId}
          agentId={agentId}
          channelId={pairTarget.channelId}
          channelLabel={pairTarget.channelLabel}
          onClose={() => {
            setPairTarget(null);
            invalidateAll();
          }}
          onChanged={invalidateAll}
        />
      )}

      {actionTarget && tenantId && agentId && (
        <LineActionModal
          kind={actionTarget.kind}
          tenantId={tenantId}
          agentId={agentId}
          channelId={actionTarget.channelId}
          channelLabel={actionTarget.channelLabel}
          onClose={() => setActionTarget(null)}
          onDone={invalidateAll}
        />
      )}
    </div>
  );
}
