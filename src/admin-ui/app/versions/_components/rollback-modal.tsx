'use client';

import * as React from 'react';
import { trpc } from '../../../trpc/client.js';
import { Modal } from '../../../components/ui/modal.js';
import { Button } from '../../../components/ui/button.js';
import { Field, Textarea } from '../../../components/ui/field.js';
import { Alert } from '../../../components/ui/states.js';
import type { VersionItem } from './versions-table.js';

type SotKind =
  | 'agent_operational_profile_versions'
  | 'policy_rules'
  | 'soul_biases'
  | 'skills';

/**
 * Fluxo de reversão (Tela 3). Toda tentativa — sucesso OU falha — é gravada
 * em admin_audit_log pelo servidor. Fontes ainda não integradas respondem com
 * NOT_IMPLEMENTED em vez de um falso-positivo de recuperação.
 */
export default function RollbackModal({
  tenantId,
  item,
  fromVersion,
  onClose,
  onSuccess,
}: {
  tenantId: string;
  item: VersionItem;
  fromVersion: number;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [reason, setReason] = React.useState('');
  const [localError, setLocalError] = React.useState<string | null>(null);
  const mutation = trpc.versions.rollback.useMutation();

  const handleSubmit = async () => {
    setLocalError(null);
    if (reason.trim().length < 10) {
      setLocalError('O motivo deve ter no mínimo 10 caracteres.');
      return;
    }
    try {
      await mutation.mutateAsync({
        tenantId,
        sotKind: item.sot_kind as SotKind,
        sotId: item.sot_id,
        fromVersion,
        toVersion: item.version,
        reason,
      });
      onSuccess();
    } catch {
      // Erro exibido abaixo via mutation.error.
    }
  };

  const notImplemented = mutation.error?.data?.code === 'NOT_IMPLEMENTED';

  return (
    <Modal
      open
      onClose={onClose}
      title="Reverter versão"
      description="Troca a versão ativa por uma anterior. Toda tentativa é registrada no log de auditoria."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            loading={mutation.isPending}
            onClick={() => void handleSubmit()}
          >
            Confirmar reversão
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-zinc-50 px-4 py-3 text-sm">
          <p>
            <span className="font-medium text-zinc-700">Fonte:</span>{' '}
            <span className="font-mono text-xs">{item.sot_kind}</span>
          </p>
          <p className="mt-1">
            <span className="font-medium text-zinc-700">ID:</span>{' '}
            <span className="font-mono text-xs">{item.sot_id}</span>
          </p>
          <p className="mt-1 text-zinc-700">
            De <span className="font-semibold">v{fromVersion}</span> (ativa) para{' '}
            <span className="font-semibold">v{item.version}</span>
          </p>
        </div>

        <Field
          label="Motivo"
          required
          hint="Mínimo de 10 caracteres. Fica registrado na auditoria."
          error={localError}
        >
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Descreva por que esta reversão é necessária…"
          />
        </Field>

        {mutation.error &&
          (notImplemented ? (
            <Alert tone="warning" title="Reversão não implementada">
              {mutation.error.message}
            </Alert>
          ) : (
            <Alert tone="danger" title="Falha na reversão">
              {mutation.error.message}
            </Alert>
          ))}
      </div>
    </Modal>
  );
}
