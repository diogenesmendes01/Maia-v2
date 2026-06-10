'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';
import type { ProposalTypeId, RiskLevelId } from '../../../../trpc/types.js';
import { Modal } from '../../../../components/ui/modal.js';
import { Button } from '../../../../components/ui/button.js';
import { Field, Textarea } from '../../../../components/ui/field.js';
import { Alert } from '../../../../components/ui/states.js';
import { StatusBadge } from '../../../../components/ui/badge.js';

interface ProposalSummary {
  id: string;
  descriptor: string;
  type: ProposalTypeId;
  risk: RiskLevelId;
  requires_dual: boolean;
  required_roles: string[];
}

interface Props {
  proposal: ProposalSummary;
  decision: 'approve' | 'reject';
  tenantId: string;
  onClose: () => void;
}

/**
 * Modal de decisão (aprovar/rejeitar). O comentário é obrigatório (mín. 10
 * caracteres) e fica registrado na trilha de auditoria. Para classes de
 * aprovação dupla, a ativação só ocorre após todas as assinaturas exigidas.
 */
export default function ApprovalModal({ proposal, decision, tenantId, onClose }: Props) {
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const approveMutation = trpc.proposals.approve.useMutation();
  const rejectMutation = trpc.proposals.reject.useMutation();
  const mutation = decision === 'approve' ? approveMutation : rejectMutation;
  const isApprove = decision === 'approve';

  const handleSubmit = async () => {
    setError(null);
    if (comment.trim().length < 10) {
      setError('O comentário deve ter pelo menos 10 caracteres.');
      return;
    }
    try {
      await mutation.mutateAsync({
        id: proposal.id,
        tenantId,
        comment,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isApprove ? 'Aprovar proposta?' : 'Rejeitar proposta?'}
      description={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <strong className="font-medium text-zinc-700">{proposal.descriptor}</strong>
          <StatusBadge status={proposal.risk} />
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button
            variant={isApprove ? 'success' : 'danger'}
            onClick={() => void handleSubmit()}
            loading={mutation.isPending}
          >
            {isApprove ? 'Confirmar aprovação' : 'Confirmar rejeição'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {isApprove && proposal.requires_dual && (
          <Alert tone="info" title="Aprovação dupla obrigatória">
            Após a sua aprovação, mais {proposal.required_roles.length - 1}{' '}
            aprovador(es) distinto(s) precisam assinar antes da ativação.
          </Alert>
        )}
        <Field
          label={isApprove ? 'Motivo da aprovação' : 'Motivo da rejeição'}
          required
          hint="Mínimo de 10 caracteres. O comentário fica registrado na trilha de auditoria."
        >
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={
              isApprove ? 'Por que aprovar esta proposta?' : 'Por que rejeitar esta proposta?'
            }
            rows={5}
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}
