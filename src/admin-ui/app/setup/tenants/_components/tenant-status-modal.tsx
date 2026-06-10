'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';
import { Modal } from '../../../../components/ui/modal.js';
import { Button } from '../../../../components/ui/button.js';
import { Field, Textarea } from '../../../../components/ui/field.js';
import { Alert } from '../../../../components/ui/states.js';

interface Props {
  target: { id: string; nome: string; status: string };
  onClose: () => void;
}

export default function TenantStatusModal({ target, onClose }: Props) {
  const nextStatus = target.status === 'active' ? 'suspended' : 'active';
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const mutation = trpc.tenants.updateStatus.useMutation();

  const handleSubmit = async () => {
    setError(null);
    if (comment.trim().length < 10) {
      setError('O comentário deve ter pelo menos 10 caracteres.');
      return;
    }
    try {
      await mutation.mutateAsync({ id: target.id, status: nextStatus, comment });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const actionLabel = nextStatus === 'suspended' ? 'Suspender' : 'Reativar';

  return (
    <Modal
      open
      onClose={onClose}
      title={`${actionLabel} ${target.id}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button
            variant={nextStatus === 'suspended' ? 'danger' : 'success'}
            onClick={() => void handleSubmit()}
            loading={mutation.isPending}
          >
            {actionLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-zinc-600">
          O tenant <code className="font-mono">{target.id}</code> ({target.nome})
          está atualmente <strong>{target.status}</strong>. A mudança para{' '}
          <strong>{nextStatus}</strong> será registrada no log de auditoria.
        </p>
        <Field label="Motivo (auditado, mín. 10 caracteres)" required>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Por que essa mudança de status?"
            rows={4}
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}
