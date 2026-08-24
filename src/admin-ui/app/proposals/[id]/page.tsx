'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';
import { PageHeader } from '../../../components/ui/page-header.js';
import { Card, CardHeader, CardBody } from '../../../components/ui/card.js';
import { Badge, StatusBadge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import { LoadingState, ErrorState, EmptyState, Alert } from '../../../components/ui/states.js';
import { IconArrowLeft, IconShield } from '../../../components/ui/icons.js';
import DiffRenderer from './_components/diff-renderer.js';
import ApprovalModal from './_components/approval-modal.js';
import { TYPE_LABELS } from '../../inbox/_components/labels.js';

/**
 * Tela 2 — diff e decisão de uma proposta. Mostra o cabeçalho de governança
 * (tipo, risco, origem, status, progresso de aprovação dupla), travas de
 * arquitetura, o diff por tipo e a trilha de decisões anteriores.
 */
export default function ProposalDetailPage({
  params,
}: {
  // Next 16 — `params` é uma Promise. A compatibilidade síncrona da 15 foi
  // REMOVIDA; em componente de cliente quem a resolve é `React.use()`.
  params: Promise<{ id: string }>;
}) {
  const { id } = React.use(params);
  const { data: session, status } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';
  const userRole = session?.user?.role ?? 'viewer';

  const [showApprovalModal, setShowApprovalModal] = React.useState<'approve' | 'reject' | null>(
    null,
  );

  const proposalQuery = trpc.proposals.getProposal.useQuery(
    { id, tenantId },
    { enabled: tenantId !== '' },
  );

  if (status === 'loading' || !tenantId) return <LoadingState label="Carregando sessão…" />;
  if (proposalQuery.isLoading) return <LoadingState label="Carregando proposta…" />;
  if (proposalQuery.error)
    return (
      <ErrorState
        message={proposalQuery.error.message}
        onRetry={() => void proposalQuery.refetch()}
      />
    );
  if (!proposalQuery.data)
    return <EmptyState title="Proposta não encontrada" />;

  const proposal = proposalQuery.data;
  const lockBlocked = proposal.locks.length > 0 && userRole !== 'founder';
  // Post-Codex-review #101: founder is always allowed at the role-gate layer;
  // architecture locks then restrict to founder via lockBlocked above.
  const canApprove =
    !lockBlocked && (userRole === 'founder' || proposal.required_roles.includes(userRole));

  const approvedRoles = new Set(
    proposal.approvals.filter((a) => a.decision === 'approved').map((a) => a.approver_role),
  );

  return (
    <div>
      <Link
        href="/inbox"
        className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 transition-colors hover:text-brand-600"
      >
        <IconArrowLeft size={14} />
        Voltar para Aprovações
      </Link>

      <PageHeader
        title={proposal.descriptor}
        description={
          <>
            {TYPE_LABELS[proposal.type]} · proposta{' '}
            <code className="font-mono text-xs">{proposal.id.slice(0, 8)}</code> · classe de
            aprovação <code className="font-mono text-xs">{proposal.approval_class}</code>
          </>
        }
        actions={
          <span className="flex items-center gap-2">
            <StatusBadge status={proposal.risk} />
            <StatusBadge status={proposal.status} />
          </span>
        }
      />

      <div className="space-y-5">
        <Card>
          <CardBody>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
              {[
                { label: 'Tipo', value: TYPE_LABELS[proposal.type] },
                { label: 'Risco', value: <StatusBadge status={proposal.risk} /> },
                {
                  label: 'Origem',
                  value: <span className="font-mono text-xs">{proposal.source}</span>,
                },
                {
                  label: 'Proposto em',
                  value: new Date(proposal.proposed_at).toLocaleString('pt-BR'),
                },
                {
                  label: 'Proposto por',
                  value: <span className="font-mono text-xs">{proposal.proposed_by}</span>,
                },
                { label: 'Status', value: <StatusBadge status={proposal.status} /> },
              ].map((item) => (
                <div key={item.label}>
                  <dt className="text-2xs font-semibold uppercase tracking-wide text-zinc-500">
                    {item.label}
                  </dt>
                  <dd className="mt-1 text-zinc-800">{item.value}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>

        {proposal.locks.length > 0 && (
          <Alert
            tone={userRole === 'founder' ? 'warning' : 'danger'}
            title={
              <span className="inline-flex items-center gap-1.5">
                <IconShield size={15} />
                {userRole === 'founder'
                  ? 'Trava de arquitetura — prossiga com autoridade de founder'
                  : 'Trava de arquitetura — aprovação de founder obrigatória'}
              </span>
            }
          >
            <p>Esta proposta toca {proposal.locks.length} trava(s) de arquitetura:</p>
            <ul className="mt-1 list-inside list-disc">
              {proposal.locks.map((lock) => (
                <li key={lock}>
                  <code className="rounded bg-white/70 px-1 font-mono">{lock}</code>
                </li>
              ))}
            </ul>
            {userRole !== 'founder' && (
              <p className="mt-2 font-medium">
                Botões de aprovar/rejeitar desabilitados. Escale para um usuário com papel
                founder.
              </p>
            )}
          </Alert>
        )}

        {proposal.requires_dual && (
          <Alert tone="info" title="Aprovação dupla obrigatória">
            <p>
              Papéis exigidos: {proposal.required_roles.join(' + ')}.{' '}
              {proposal.approvals.length > 0 && (
                <>
                  {proposal.approvals.length} de {proposal.required_roles.length} aprovações
                  registradas.
                </>
              )}
            </p>
            <span className="mt-2 flex flex-wrap items-center gap-1.5">
              {proposal.required_roles.map((r) => (
                <Badge key={r} tone={approvedRoles.has(r) ? 'success' : 'neutral'}>
                  {r}: {approvedRoles.has(r) ? 'aprovado' : 'pendente'}
                </Badge>
              ))}
            </span>
          </Alert>
        )}

        <DiffRenderer type={proposal.type} body={proposal.body} />

        <Card>
          <CardHeader
            title="Justificativas e trilha de auditoria"
            description="Decisões já registradas para esta proposta."
          />
          <CardBody>
            {proposal.approvals.length > 0 ? (
              <ul className="space-y-3">
                {proposal.approvals.map((a) => (
                  <li key={a.id} className="border-l-2 border-brand-200 pl-3 text-sm">
                    <span className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={a.decision} />
                      <code className="rounded bg-zinc-100 px-1 font-mono text-xs">
                        {a.approver_role}
                      </code>
                      <span className="text-xs text-zinc-500">
                        em {new Date(a.decided_at).toLocaleString('pt-BR')}
                      </span>
                    </span>
                    {a.comment && <p className="mt-1 text-zinc-700">{a.comment}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">
                Nenhuma decisão anterior nesta proposta.
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Artefatos impactados"
            description="Grafo de impacto completo chega no P8.5 v1.1."
          />
          <CardBody>
            <p className="text-sm text-zinc-500">
              Classe de aprovação:{' '}
              <code className="rounded bg-zinc-100 px-1 font-mono text-xs">
                {proposal.approval_class}
              </code>
            </p>
          </CardBody>
        </Card>

        <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-overlay sm:gap-3 sm:px-5">
          <Button
            variant="success"
            onClick={() => setShowApprovalModal('approve')}
            disabled={!canApprove}
            className="w-full sm:w-auto"
          >
            Aprovar
          </Button>
          <Button
            variant="danger"
            onClick={() => setShowApprovalModal('reject')}
            disabled={!canApprove}
            className="w-full sm:w-auto"
          >
            Rejeitar
          </Button>
          {!canApprove && (
            <span className="text-xs text-zinc-500">
              {lockBlocked
                ? 'Propostas com trava de arquitetura exigem o papel founder.'
                : `Seu papel (${userRole}) não pode decidir esta classe de aprovação.`}
            </span>
          )}
        </div>
      </div>

      {showApprovalModal && (
        <ApprovalModal
          proposal={proposal}
          decision={showApprovalModal}
          tenantId={tenantId}
          onClose={() => {
            setShowApprovalModal(null);
            void proposalQuery.refetch();
          }}
        />
      )}
    </div>
  );
}
