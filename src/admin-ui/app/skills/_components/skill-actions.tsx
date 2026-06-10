'use client';

/**
 * Admin UI — ações de ciclo de vida da skill (somente founder).
 *
 * Botões por status: Ativar quando 'proposed'; Descontinuar quando
 * 'active'/'proposed'; Reverter quando 'active'. Cada ação abre um prompt de
 * motivo obrigatório (auditado, mín. 10 caracteres); na confirmação fazemos
 * mutateAsync e onMutated() invalida lista/detalhe/versões. Erros aparecem
 * por error.data.code.
 */

import * as React from 'react';
import { trpc } from '../../../trpc/client.js';
import { Button } from '../../../components/ui/button.js';
import { Field, Textarea } from '../../../components/ui/field.js';
import { Alert } from '../../../components/ui/states.js';
import type { SkillRow } from './skill-detail.js';

type LifecycleAction = 'activate' | 'deprecate' | 'rollback';

const ACTION_LABEL: Record<LifecycleAction, string> = {
  activate: 'Ativar',
  deprecate: 'Descontinuar',
  rollback: 'Reverter',
};

// Mapeia data.code do TRPCError + a mensagem DO SERVIDOR para um texto voltado
// ao operador. Para CONFLICT a mensagem do servidor já é específica da
// transição; cai num texto genérico se vier vazia.
function actionErrorMessage(
  code: string | undefined,
  serverMessage: string,
): string {
  if (code === 'CONFLICT') {
    return (
      serverMessage.trim() ||
      'Esta skill mudou de status — atualize e tente novamente.'
    );
  }
  if (code === 'FORBIDDEN') {
    return `Não permitido: ${serverMessage}`;
  }
  if (code === 'NOT_FOUND') {
    return 'Skill não encontrada — pode ter sido removida. Atualize a página.';
  }
  return serverMessage;
}

export function SkillActions({
  skill,
  tenantId,
  onMutated,
}: {
  skill: SkillRow;
  tenantId: string;
  onMutated: () => void;
}) {
  const [pending, setPending] = React.useState<LifecycleAction | null>(null);
  const [reason, setReason] = React.useState('');

  const activate = trpc.skills.activate.useMutation();
  const deprecate = trpc.skills.deprecate.useMutation();
  const rollback = trpc.skills.rollback.useMutation();

  const mutationFor = (a: LifecycleAction) =>
    a === 'activate' ? activate : a === 'deprecate' ? deprecate : rollback;

  const activeError = activate.error ?? deprecate.error ?? rollback.error ?? null;
  const isPending = activate.isPending || deprecate.isPending || rollback.isPending;

  // O agente da própria skill (nunca null aqui — o pai só renderiza isto para
  // skills escopadas por agente, exigência das mutações do repo).
  const agentId = skill.agent_id ?? '';

  const reasonOk = reason.trim().length >= 10;

  const start = (a: LifecycleAction) => {
    setPending(a);
    setReason('');
  };

  const confirm = async () => {
    if (!pending || !reasonOk) return;
    try {
      await mutationFor(pending).mutateAsync({
        id: skill.id,
        tenantId,
        agentId,
        reason: reason.trim(),
      });
      setPending(null);
      setReason('');
      onMutated();
    } catch {
      // Exibido via activeError abaixo.
    }
  };

  const canActivate = skill.status === 'proposed';
  const canDeprecate = skill.status === 'active' || skill.status === 'proposed';
  const canRollback = skill.status === 'active';

  return (
    <div className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Ações de ciclo de vida
      </h3>
      {pending === null ? (
        <div className="flex flex-wrap gap-2">
          {canActivate && (
            <Button variant="success" size="sm" onClick={() => start('activate')}>
              Ativar
            </Button>
          )}
          {canDeprecate && (
            <Button variant="secondary" size="sm" onClick={() => start('deprecate')}>
              Descontinuar
            </Button>
          )}
          {canRollback && (
            <Button variant="danger" size="sm" onClick={() => start('rollback')}>
              Reverter
            </Button>
          )}
          {!canActivate && !canDeprecate && !canRollback && (
            <p className="text-xs text-zinc-500">
              Nenhuma ação disponível para uma skill com status{' '}
              <code className="font-mono">{skill.status}</code>.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-zinc-800">
            <strong>{ACTION_LABEL[pending]}</strong> a skill{' '}
            <code className="font-mono">{skill.skill_descriptor}</code> v
            {skill.version}.
          </p>
          <Field label="Motivo (auditado, mín. 10 caracteres)" required>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              autoFocus
            />
          </Field>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void confirm()}
              disabled={!reasonOk}
              loading={isPending}
            >
              Confirmar {ACTION_LABEL[pending].toLowerCase()}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setPending(null);
                setReason('');
              }}
            >
              Cancelar
            </Button>
          </div>
        </div>
      )}
      {activeError && (
        <Alert tone="danger">
          {actionErrorMessage(activeError.data?.code, activeError.message)}
        </Alert>
      )}
    </div>
  );
}
