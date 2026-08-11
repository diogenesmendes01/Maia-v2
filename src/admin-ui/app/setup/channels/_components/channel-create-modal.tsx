'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';
import { Modal } from '../../../../components/ui/modal.js';
import { Button } from '../../../../components/ui/button.js';
import { Field, Input, Select, Textarea } from '../../../../components/ui/field.js';
import { Alert } from '../../../../components/ui/states.js';

interface Props {
  tenantId: string;
  agentId: string;
  onClose: () => void;
  /** Chamado após criar com sucesso (o caller invalida as queries). */
  onCreated: () => void;
}

type ChannelType = 'whatsapp' | 'telegram' | 'email' | 'sms' | 'web' | 'api' | 'other';

const CHANNEL_TYPES: ChannelType[] = [
  'whatsapp',
  'telegram',
  'email',
  'sms',
  'web',
  'api',
  'other',
];

export default function ChannelCreateModal({
  tenantId,
  agentId,
  onClose,
  onCreated,
}: Props) {
  const mutation = trpc.channelPolicies.createChannel.useMutation();

  const [channelType, setChannelType] = React.useState<ChannelType>('whatsapp');
  const [externalId, setExternalId] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    if (externalId.trim().length === 0) {
      setError('Informe o identificador externo do canal.');
      return;
    }
    if (comment.trim().length < 10) {
      setError('O motivo deve ter pelo menos 10 caracteres.');
      return;
    }
    try {
      await mutation.mutateAsync({
        tenantId,
        agentId,
        channel_type: channelType,
        external_id: externalId.trim(),
        display_name: displayName.trim() || undefined,
        comment: comment.trim(),
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Novo canal"
      description={
        <>
          Registra um canal de entrada para o agente{' '}
          <code className="font-mono">{agentId}</code>. Depois de criado,
          configure a política (papel padrão) do canal.
        </>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => void handleSubmit()} loading={mutation.isPending}>
            Criar canal
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Tipo" required>
          <Select
            value={channelType}
            onChange={(e) => setChannelType(e.target.value as ChannelType)}
          >
            {CHANNEL_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Identificador externo"
          required
          hint="Identifica a LINHA do agente neste tipo de canal (ex.: o número WhatsApp do bot, com DDI). Único por tenant + tipo."
        >
          <Input
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
            placeholder="5511999990000"
            className="font-mono"
            maxLength={200}
          />
        </Field>
        <Field label="Nome de exibição" hint="Opcional — como o canal aparece no console.">
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Linha comercial"
            maxLength={200}
          />
        </Field>
        <Field label="Motivo (auditado, mín. 10 caracteres)" required>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="Ex.: Registrar a linha WhatsApp da divisão comercial."
          />
        </Field>
      </div>

      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Modal>
  );
}
