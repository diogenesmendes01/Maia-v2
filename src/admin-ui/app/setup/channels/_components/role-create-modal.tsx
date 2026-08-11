'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';
import { Modal } from '../../../../components/ui/modal.js';
import { Button } from '../../../../components/ui/button.js';
import { Field, Input, Textarea } from '../../../../components/ui/field.js';
import { Alert } from '../../../../components/ui/states.js';

interface Props {
  tenantId: string;
  agentId: string;
  /** O agente já tem algum papel ativo? Muda apenas o texto informativo. */
  hasRoles: boolean;
  onClose: () => void;
  /** Chamado após criar com sucesso (o caller invalida as queries). */
  onCreated: () => void;
}

const ROLE_KEY_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

export default function RoleCreateModal({
  tenantId,
  agentId,
  hasRoles,
  onClose,
  onCreated,
}: Props) {
  const mutation = trpc.channelPolicies.createRole.useMutation();

  const [roleKey, setRoleKey] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [promptAddendum, setPromptAddendum] = React.useState('');
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    if (!ROLE_KEY_REGEX.test(roleKey)) {
      setError(
        'A chave do papel deve usar minúsculas, dígitos, “-” ou “_”, começando por letra ou dígito.',
      );
      return;
    }
    if (displayName.trim().length === 0) {
      setError('Dê um nome ao papel.');
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
        role_key: roleKey,
        display_name: displayName.trim(),
        prompt_addendum: promptAddendum.trim() || undefined,
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
      title="Novo papel"
      description={
        <>
          Cria um modo operacional para o agente{' '}
          <code className="font-mono">{agentId}</code>. A política de canal
          exige um papel padrão.
        </>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => void handleSubmit()} loading={mutation.isPending}>
            Criar papel
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Chave (slug)"
          required
          hint="Imutável. Minúsculas, dígitos, “-” e “_”. Ex.: comercial, suporte."
        >
          <Input
            value={roleKey}
            onChange={(e) => setRoleKey(e.target.value)}
            placeholder="comercial"
            className="font-mono"
            maxLength={64}
          />
        </Field>
        <Field label="Nome de exibição" required>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Atendimento comercial"
            maxLength={200}
          />
        </Field>
        <Field
          label="Complemento de prompt"
          hint="Opcional — entra no prompt quando este papel estiver ativo."
        >
          <Textarea
            value={promptAddendum}
            onChange={(e) => setPromptAddendum(e.target.value)}
            rows={3}
            placeholder="Ex.: Priorize qualificação de leads e siga o playbook comercial."
            maxLength={4000}
          />
        </Field>
        <Field label="Motivo (auditado, mín. 10 caracteres)" required>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="Ex.: Papel inicial para vincular a política do canal comercial."
          />
        </Field>
      </div>

      {!hasRoles && (
        <p className="mt-3 text-xs text-zinc-500">
          Este é o primeiro papel do agente — ele se torna automaticamente o
          papel padrão.
        </p>
      )}

      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Modal>
  );
}
