'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';
import { PageHeader } from '../../../components/ui/page-header.js';
import { Card, CardHeader, CardBody } from '../../../components/ui/card.js';
import { Badge, StatusBadge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import { Field, Input, Select, Textarea } from '../../../components/ui/field.js';
import { Modal } from '../../../components/ui/modal.js';
import {
  Alert,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../components/ui/states.js';
import {
  TableShell,
  Table,
  THead,
  Th,
  Tr,
  Td,
} from '../../../components/ui/table.js';
import { IconPlus, IconWrench } from '../../../components/ui/icons.js';

/**
 * Conexões MCP (issue #478 — v1): conectar servers first-party (ex.: o MCP
 * do ERP), ver/decidir tools descobertas e regular o acesso por agente
 * (pack mcp.<server>). Test/sync são executados pelo runtime (worker
 * mcp_sync) — esta tela enfileira e faz poll do resultado.
 */
export default function McpPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? '';
  const tenantId = session?.user?.tenant_id ?? '';
  const canManage = role === 'owner' || role === 'founder';

  const [showRegister, setShowRegister] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);

  const serversQuery = trpc.mcp.listServers.useQuery(
    { tenantId },
    { enabled: tenantId !== '', refetchInterval: 10_000 },
  );

  if (status === 'loading') return <LoadingState label="Carregando sessão…" />;

  const servers = serversQuery.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Conexões MCP"
        description="Servidores MCP first-party (ex.: o MCP do seu ERP) que dão braços aos agentes. Cada tool descoberta precisa de aprovação explícita, e cada agente só usa os servers que você conceder — MCP é transporte, nunca atalho em volta da governança."
        actions={
          canManage && (
            <Button onClick={() => setShowRegister(true)}>
              <IconPlus size={15} />
              Registrar server
            </Button>
          )
        }
      />

      <Alert tone="warning" title="Flag de runtime">
        A visibilidade/execução de tools MCP exige <code>FEATURE_MCP_TOOLS=true</code>{' '}
        no processo do runtime (default desligado, fail-closed). Aprovações e
        grants podem ser preparados antes de ligar.
      </Alert>

      <div className="mt-5">
        {serversQuery.isLoading ? (
          <LoadingState label="Carregando servers…" />
        ) : serversQuery.error ? (
          <ErrorState
            message={serversQuery.error.message}
            onRetry={() => void serversQuery.refetch()}
          />
        ) : servers.length === 0 ? (
          <EmptyState
            icon={<IconWrench size={32} />}
            title="Nenhum server MCP registrado"
            description="Registre o servidor MCP do seu ERP para começar — o contrato recomendado está na spec (docs/superpowers/specs/2026-06-10-mcp-external-tools-design.md §3)."
            action={
              canManage && (
                <Button onClick={() => setShowRegister(true)}>
                  <IconPlus size={15} />
                  Registrar primeiro server
                </Button>
              )
            }
          />
        ) : (
          <div className="space-y-4">
            {servers.map((s) => {
              const test = s.last_test_result as { ok?: boolean; tool_count?: number; error?: string } | null;
              const sync = s.last_sync_result as { ok?: boolean; total?: number; suspended?: number; error?: string } | null;
              return (
                <Card key={s.id}>
                  <CardHeader
                    title={
                      <span className="flex items-center gap-2">
                        {s.name}
                        <StatusBadge status={s.status} />
                      </span>
                    }
                    description={
                      <>
                        <code className="font-mono">{s.url}</code>
                        {s.auth_secret_ref && (
                          <>
                            {' '}
                            · auth: <code className="font-mono">{s.auth_secret_ref}</code>
                          </>
                        )}
                      </>
                    }
                    actions={
                      canManage && (
                        <span className="flex flex-wrap gap-2">
                          <TestSyncButtons tenantId={tenantId} serverId={s.id} onDone={() => void serversQuery.refetch()} />
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setSelected(selected === s.id ? null : s.id)}
                          >
                            {selected === s.id ? 'Fechar detalhes' : 'Tools & acesso'}
                          </Button>
                        </span>
                      )
                    }
                  />
                  <CardBody className="flex flex-wrap gap-2 text-xs text-zinc-600">
                    <Badge tone={test ? (test.ok ? 'success' : 'danger') : 'neutral'}>
                      teste: {test ? (test.ok ? `ok (${test.tool_count} tools)` : `falhou`) : 'nunca'}
                    </Badge>
                    <Badge tone={sync ? (sync.ok ? 'success' : 'danger') : 'neutral'}>
                      sync: {sync ? (sync.ok ? `ok (${sync.total} tools${sync.suspended ? `, ${sync.suspended} suspensas` : ''})` : 'falhou') : 'nunca'}
                    </Badge>
                    {test && !test.ok && test.error && (
                      <span className="text-red-600">{test.error}</span>
                    )}
                  </CardBody>
                  {selected === s.id && (
                    <ServerDetail tenantId={tenantId} serverId={s.id} canManage={canManage} />
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <RegisterModal
        open={showRegister}
        tenantId={tenantId}
        onClose={(created) => {
          setShowRegister(false);
          if (created) void serversQuery.refetch();
        }}
      />
    </div>
  );
}

function TestSyncButtons({
  tenantId,
  serverId,
  onDone,
}: {
  tenantId: string;
  serverId: string;
  onDone: () => void;
}) {
  const testMutation = trpc.mcp.requestTest.useMutation();
  const syncMutation = trpc.mcp.requestSync.useMutation();
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        loading={testMutation.isPending}
        onClick={() =>
          void testMutation.mutateAsync({ tenantId, serverId }).then(onDone)
        }
      >
        Testar conexão
      </Button>
      <Button
        size="sm"
        variant="ghost"
        loading={syncMutation.isPending}
        onClick={() =>
          void syncMutation.mutateAsync({ tenantId, serverId }).then(onDone)
        }
      >
        Sincronizar tools
      </Button>
    </>
  );
}

function ServerDetail({
  tenantId,
  serverId,
  canManage,
}: {
  tenantId: string;
  serverId: string;
  canManage: boolean;
}) {
  const toolsQuery = trpc.mcp.listTools.useQuery(
    { tenantId, serverId },
    { refetchInterval: 10_000 },
  );
  const accessQuery = trpc.mcp.listAgentAccess.useQuery({ tenantId, serverId });
  const setPackMutation = trpc.mcp.setAgentPack.useMutation();
  const [decideTarget, setDecideTarget] = React.useState<{
    id: string;
    name: string;
  } | null>(null);

  if (toolsQuery.isLoading) return <CardBody><LoadingState label="Carregando tools…" /></CardBody>;
  if (toolsQuery.error)
    return (
      <CardBody>
        <ErrorState message={toolsQuery.error.message} onRetry={() => void toolsQuery.refetch()} />
      </CardBody>
    );

  const tools = toolsQuery.data?.items ?? [];
  const access = accessQuery.data?.items ?? [];

  return (
    <CardBody className="space-y-5 border-t border-zinc-100">
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Tools descobertas ({tools.length})
        </h4>
        {tools.length === 0 ? (
          <p className="text-sm text-zinc-400">
            Nenhuma tool — rode "Sincronizar tools" (o worker executa em ~1min).
          </p>
        ) : (
          <TableShell>
            <Table>
              <THead>
                <Th>Tool</Th>
                <Th>Descrição</Th>
                <Th>Risco</Th>
                <Th>Status</Th>
                <Th className="text-right">Ações</Th>
              </THead>
              <tbody>
                {tools.map((t) => (
                  <Tr key={t.id}>
                    <Td className="font-mono text-xs">{t.tool_name}</Td>
                    <Td className="max-w-xs truncate text-xs text-zinc-600" title={t.description ?? ''}>
                      {t.description ?? '—'}
                    </Td>
                    <Td><StatusBadge status={t.risk_class} /></Td>
                    <Td>
                      <span className="flex items-center gap-1">
                        <StatusBadge status={t.status} />
                        {t.status === 'approved' && !t.is_read_only && (
                          <Badge tone="warning" className="text-2xs">write — bloqueada na v1</Badge>
                        )}
                      </span>
                    </Td>
                    <Td className="text-right">
                      {canManage ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setDecideTarget({ id: t.id, name: t.tool_name })}
                        >
                          Decidir
                        </Button>
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

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Acesso por agente (pack <code className="font-mono">{accessQuery.data?.pack}</code>)
        </h4>
        {access.length === 0 ? (
          <p className="text-sm text-zinc-400">Nenhum agente no tenant.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
            {access.map((a) => (
              <li key={a.agent_id} className="flex items-center justify-between gap-3 px-4 py-2">
                <span className="text-sm text-zinc-800">
                  {a.nome} <code className="font-mono text-xs text-zinc-400">({a.agent_id})</code>
                </span>
                {canManage ? (
                  <Button
                    size="sm"
                    variant={a.granted ? 'danger' : 'success'}
                    loading={setPackMutation.isPending}
                    onClick={() =>
                      void setPackMutation
                        .mutateAsync({
                          tenantId,
                          serverId,
                          agentId: a.agent_id,
                          granted: !a.granted,
                        })
                        .then(() => accessQuery.refetch())
                    }
                  >
                    {a.granted ? 'Revogar' : 'Conceder'}
                  </Button>
                ) : (
                  <Badge tone={a.granted ? 'success' : 'neutral'}>
                    {a.granted ? 'concedido' : 'sem acesso'}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <DecideToolModal
        target={decideTarget}
        tenantId={tenantId}
        onClose={(decided) => {
          setDecideTarget(null);
          if (decided) void toolsQuery.refetch();
        }}
      />
    </CardBody>
  );
}

function RegisterModal({
  open,
  tenantId,
  onClose,
}: {
  open: boolean;
  tenantId: string;
  onClose: (created: boolean) => void;
}) {
  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [secretRef, setSecretRef] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const mutation = trpc.mcp.registerServer.useMutation();

  const submit = async () => {
    try {
      await mutation.mutateAsync({
        tenantId,
        name: name.trim(),
        url: url.trim(),
        authSecretRef: secretRef.trim() || null,
      });
      setName('');
      setUrl('');
      setSecretRef('');
      setError(null);
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => onClose(false)}
      title="Registrar server MCP"
      description="O registro é auditado e já enfileira a primeira sincronização de tools."
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose(false)}>Cancelar</Button>
          <Button onClick={() => void submit()} loading={mutation.isPending}>Registrar</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Nome (slug)" required hint="Vira o pack mcp.<nome> concedível por agente. Ex.: erp">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="erp" className="font-mono" maxLength={40} />
        </Field>
        <Field label="URL" required hint="Endpoint streamable HTTP do server. Ex.: https://erp.suaempresa.com/mcp">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" className="font-mono" maxLength={500} />
        </Field>
        <Field
          label="Secret ref (env var)"
          hint="Nome da variável de ambiente NO RUNTIME com o bearer token — o token nunca é salvo no banco. Ex.: MCP_SERVER_ERP_TOKEN"
        >
          <Input value={secretRef} onChange={(e) => setSecretRef(e.target.value)} placeholder="MCP_SERVER_ERP_TOKEN" className="font-mono" maxLength={100} />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

function DecideToolModal({
  target,
  tenantId,
  onClose,
}: {
  target: { id: string; name: string } | null;
  tenantId: string;
  onClose: (decided: boolean) => void;
}) {
  const [decision, setDecision] = React.useState<'approved' | 'rejected'>('approved');
  const [isReadOnly, setIsReadOnly] = React.useState(true);
  const [riskClass, setRiskClass] = React.useState<'low' | 'medium' | 'high' | 'critical'>('high');
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const mutation = trpc.mcp.decideTool.useMutation();

  const submit = async () => {
    if (!target) return;
    if (comment.trim().length < 10) {
      setError('O comentário (auditado) precisa de ao menos 10 caracteres.');
      return;
    }
    try {
      await mutation.mutateAsync({
        tenantId,
        toolId: target.id,
        decision,
        isReadOnly,
        riskClass,
        comment: comment.trim(),
      });
      setComment('');
      setError(null);
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal
      open={target !== null}
      onClose={() => onClose(false)}
      title={`Decidir tool — ${target?.name ?? ''}`}
      description="Aprovação é por tool, auditada. Na v1 só tools READ-ONLY executam — writes ficam bloqueadas no bridge mesmo se aprovadas."
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose(false)}>Cancelar</Button>
          <Button
            variant={decision === 'approved' ? 'success' : 'danger'}
            onClick={() => void submit()}
            loading={mutation.isPending}
          >
            {decision === 'approved' ? 'Aprovar' : 'Rejeitar'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Decisão">
          <Select value={decision} onChange={(e) => setDecision(e.target.value as 'approved' | 'rejected')}>
            <option value="approved">Aprovar</option>
            <option value="rejected">Rejeitar</option>
          </Select>
        </Field>
        <Field label="Natureza" hint="Declare com base no contrato do seu server (spec §3): reads não têm efeito colateral.">
          <Select value={isReadOnly ? 'read' : 'write'} onChange={(e) => setIsReadOnly(e.target.value === 'read')}>
            <option value="read">Somente leitura (executável na v1)</option>
            <option value="write">Escrita / efeito colateral (bloqueada até a v2)</option>
          </Select>
        </Field>
        <Field label="Classe de risco">
          <Select value={riskClass} onChange={(e) => setRiskClass(e.target.value as typeof riskClass)}>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="critical">critical</option>
          </Select>
        </Field>
        <Field label="Comentário (auditado)" required>
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={2000} />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}
