'use client';

import * as React from 'react';
import { trpc } from '../../../trpc/client.js';
import { Modal } from '../../../components/ui/modal.js';
import { Button } from '../../../components/ui/button.js';
import { Field, Textarea } from '../../../components/ui/field.js';
import { Alert } from '../../../components/ui/states.js';

interface Props {
  open: boolean;
  tenantId: string;
  ids: string[];
  onClose: () => void;
}

/**
 * Rejeição em massa. O servidor só rejeita propostas elegíveis
 * (risco baixo + sem trava de arquitetura); as demais são puladas e
 * reportadas em `skipped_ids`.
 */
export default function BulkRejectModal({ open, tenantId, ids, onClose }: Props) {
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const mutation = trpc.inbox.bulkReject.useMutation();

  const handleSubmit = async () => {
    setError(null);
    if (comment.trim().length < 10) {
      setError('O comentário deve ter pelo menos 10 caracteres.');
      return;
    }
    try {
      const result = await mutation.mutateAsync({ tenantId, ids, comment });
      // Surface skipped ids if any, then auto-close.
      if (result.skipped_ids.length > 0) {
        setError(
          `${result.rejected_count} rejeitada(s). ${result.skipped_ids.length} pulada(s) (risco alto demais ou com trava de arquitetura).`,
        );
        setTimeout(onClose, 2500);
      } else {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Rejeitar ${ids.length} proposta(s) em massa?`}
      description="Apenas propostas de risco baixo e sem trava de arquitetura serão rejeitadas; as demais são puladas."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            onClick={() => void handleSubmit()}
            loading={mutation.isPending}
          >
            Confirmar rejeição
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label="Motivo da rejeição"
          required
          hint="Mínimo de 10 caracteres. O comentário fica registrado na trilha de auditoria."
        >
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Por que rejeitar estas propostas?"
            rows={4}
          />
        </Field>
        {error && <Alert tone="warning">{error}</Alert>}
      </div>
    </Modal>
  );
}
