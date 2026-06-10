'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { PageHeader } from '../../components/ui/page-header.js';
import { StatusBadge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Field, Select, Textarea } from '../../components/ui/field.js';
import { Modal } from '../../components/ui/modal.js';
import {
  LoadingState,
  ErrorState,
  EmptyState,
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
 * Cross-agent view of operational profile versions. The active row is what
 * each agent is running; proposed rows can be approved here (the previous
 * active version is frozen in the same transaction).
 */
export default function IdentitiesPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? '';
  const tenantId = session?.user?.tenant_id ?? '';
  const [agentId, setAgentId] = React.useState('');
  const [target, setTarget] = React.useState<{
    versionId: string;
    agentId: string;
    version: number;
  } | null>(null);
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const canApprove = role === 'owner' || role === 'founder';

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
  const approveMutation = trpc.agents.approveProfile.useMutation();

  const approve = async () => {
    if (!target) return;
    if (comment.trim().length < 10) {
      setError('O comentário de aprovação precisa de ao menos 10 caracteres.');
      return;
    }
    try {
      await approveMutation.mutateAsync({
        tenantId,
        agentId: target.agentId,
        versionId: target.versionId,
        comment: comment.trim(),
      });
      setTarget(null);
      setComment('');
      setError(null);
      void versionsQuery.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (status === 'loading') return <LoadingState label="Carregando sessão…" />;

  const items = versionsQuery.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Identidades"
        description="Versões de perfil operacional por agente. A linha ativa é o que o agente executa hoje; propostas podem ser aprovadas aqui — a versão anterior é congelada na mesma transação."
      />

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
                    {v.status === 'proposed' && canApprove ? (
                      <Button
                        size="sm"
                        variant="success"
                        onClick={() => {
                          setError(null);
                          setTarget({
                            versionId: v.id,
                            agentId: v.sot_id,
                            version: v.version,
                          });
                        }}
                      >
                        Aprovar e ativar
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

      <Modal
        open={target !== null}
        onClose={() => setTarget(null)}
        title={`Aprovar e ativar v${target?.version ?? ''} — ${target?.agentId ?? ''}`}
        description="A versão ativa atual (se houver) é congelada na mesma transação. A decisão é auditada."
        footer={
          <>
            <Button variant="secondary" onClick={() => setTarget(null)}>
              Cancelar
            </Button>
            <Button
              variant="success"
              onClick={() => void approve()}
              loading={approveMutation.isPending}
            >
              Aprovar e ativar
            </Button>
          </>
        }
      >
        <Field
          label="Comentário (auditado)"
          required
          hint="Mínimo de 10 caracteres."
          error={error}
        >
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="Ex.: Revisei papel, princípios e limites — aprovado para operação."
          />
        </Field>
      </Modal>
    </div>
  );
}
