'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';
import { Modal } from '../../../../components/ui/modal.js';
import { Button } from '../../../../components/ui/button.js';
import { Field, Textarea } from '../../../../components/ui/field.js';
import { Alert } from '../../../../components/ui/states.js';

export type LineActionKind = 'disable' | 'repair';

interface Props {
  kind: LineActionKind;
  tenantId: string;
  agentId: string;
  channelId: string;
  channelLabel: string;
  onClose: () => void;
  onDone: () => void;
}

const COPY: Record<
  LineActionKind,
  { title: string; description: React.ReactNode; cta: string; warning: React.ReactNode }
> = {
  disable: {
    title: 'Desabilitar linha',
    description: 'A linha para de rotear imediatamente. As credenciais NÃO são apagadas.',
    cta: 'Desabilitar',
    warning:
      'Mensagens que chegarem nesta linha deixam de ser atendidas. Para religar é preciso ' +
      're-parear (o caminho auditado), não basta reativar o canal.',
  },
  repair: {
    title: 'Pedir re-pareamento',
    description: 'Encerra a posse atual desta linha e a devolve ao estado "declarada".',
    cta: 'Encerrar posse e liberar re-pareamento',
    warning:
      'A sessão desta linha é derrubada e as credenciais DELA são removidas. As demais linhas ' +
      'e a linha primária não são afetadas. Depois disso será preciso ler um QR/código novo.',
  },
};

/**
 * Issue #518 — ações destrutivas de linha (desabilitar / re-parear) com
 * motivo obrigatório. O motivo vai para `admin_audit_log` junto com o ator:
 * uma linha que parou de responder tem que ter uma resposta rastreável para
 * "quem desligou, quando e por quê".
 */
export default function LineActionModal({
  kind,
  tenantId,
  agentId,
  channelId,
  channelLabel,
  onClose,
  onDone,
}: Props) {
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const disable = trpc.channelLines.disable.useMutation();
  const repair = trpc.channelLines.requestRepair.useMutation();
  const pending = kind === 'disable' ? disable.isPending : repair.isPending;
  const copy = COPY[kind];

  const handleSubmit = async () => {
    setError(null);
    if (comment.trim().length < 10) {
      setError('O motivo deve ter pelo menos 10 caracteres — ele vai para a auditoria.');
      return;
    }
    // Ramificação EXPLÍCITA (não uma união de mutations): as duas procedures
    // têm o mesmo input, mas chamar a união apaga o tipo do resultado.
    const input = { tenantId, agentId, channelId, comment: comment.trim() };
    try {
      if (kind === 'disable') await disable.mutateAsync(input);
      else await repair.mutateAsync(input);
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${copy.title} — ${channelLabel}`}
      description={copy.description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button
            variant={kind === 'disable' ? 'danger' : 'primary'}
            onClick={() => void handleSubmit()}
            loading={pending}
          >
            {copy.cta}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Alert tone="warning">{copy.warning}</Alert>
        <Field label="Motivo (auditado, mín. 10 caracteres)" required>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="Ex.: Número desativado pela operadora; encerrar a posse antes de migrar."
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}
