'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';
import { Modal } from '../../../../components/ui/modal.js';
import { Button } from '../../../../components/ui/button.js';
import { Field, Select, Textarea } from '../../../../components/ui/field.js';
import { Alert, LoadingState } from '../../../../components/ui/states.js';

interface Props {
  tenantId: string;
  agentId: string;
  channelId: string;
  channelLabel: string;
  onClose: () => void;
}

type SwitchBehavior = 'locked' | 'prefer_handoff' | 'free_with_trigger' | 'by_context';
type AnnounceMode = 'always' | 'affects_user' | 'never';

export default function ChannelPolicyModal({
  tenantId,
  agentId,
  channelId,
  channelLabel,
  onClose,
}: Props) {
  const utils = trpc.useUtils();
  const existingQuery = trpc.channelPolicies.getByChannel.useQuery({
    tenantId,
    agentId,
    channelId,
  });
  const rolesQuery = trpc.channelPolicies.listRoles.useQuery({
    tenantId,
    agentId,
  });
  const mutation = trpc.channelPolicies.upsert.useMutation();

  const [defaultRoleId, setDefaultRoleId] = React.useState('');
  const [switchBehavior, setSwitchBehavior] =
    React.useState<SwitchBehavior>('locked');
  const [announceMode, setAnnounceMode] = React.useState<AnnounceMode>(
    'affects_user',
  );
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  // Hidrata o formulário uma única vez quando a query da política existente
  // resolve.
  const hydratedRef = React.useRef(false);
  React.useEffect(() => {
    if (hydratedRef.current) return;
    if (existingQuery.data) {
      setDefaultRoleId(existingQuery.data.default_role_id);
      setSwitchBehavior(existingQuery.data.switch_behavior as SwitchBehavior);
      setAnnounceMode(existingQuery.data.announce_mode as AnnounceMode);
      hydratedRef.current = true;
    } else if (existingQuery.isSuccess && !existingQuery.data) {
      hydratedRef.current = true;
    }
  }, [existingQuery.data, existingQuery.isSuccess]);

  const handleSubmit = async () => {
    setError(null);
    if (!defaultRoleId) {
      setError('Escolha um papel padrão.');
      return;
    }
    if (comment.trim().length < 10) {
      setError('O comentário deve ter pelo menos 10 caracteres.');
      return;
    }
    try {
      await mutation.mutateAsync({
        tenantId,
        agentId,
        channel_id: channelId,
        default_role_id: defaultRoleId,
        switch_behavior: switchBehavior,
        announce_mode: announceMode,
        comment,
      });
      await utils.channelPolicies.getByChannel.invalidate({
        tenantId,
        agentId,
        channelId,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const isUpdate = existingQuery.data !== null && existingQuery.data !== undefined;

  return (
    <Modal
      open
      onClose={onClose}
      title={isUpdate ? 'Editar política do canal' : 'Criar política do canal'}
      description={
        <>
          Canal: <code className="font-mono">{channelLabel}</code>
        </>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            loading={mutation.isPending}
            disabled={existingQuery.isLoading}
          >
            {isUpdate ? 'Atualizar política' : 'Criar política'}
          </Button>
        </>
      }
    >
      {existingQuery.isLoading || rolesQuery.isLoading ? (
        <LoadingState label="Carregando…" />
      ) : (
        <div className="space-y-4">
          <Field label="Papel padrão" required>
            <Select
              value={defaultRoleId}
              onChange={(e) => setDefaultRoleId(e.target.value)}
            >
              <option value="">Escolha o papel…</option>
              {(rolesQuery.data?.items ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.role_key} — {r.display_name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Comportamento de troca">
            <Select
              value={switchBehavior}
              onChange={(e) => setSwitchBehavior(e.target.value as SwitchBehavior)}
            >
              <option value="locked">locked — o papel nunca troca</option>
              <option value="prefer_handoff">
                prefer_handoff — handoff em vez de troca
              </option>
              <option value="free_with_trigger">
                free_with_trigger — troca sob gatilho explícito
              </option>
              <option value="by_context">
                by_context — troca quando o contexto sugere fortemente
              </option>
            </Select>
          </Field>
          <Field label="Modo de anúncio">
            <Select
              value={announceMode}
              onChange={(e) => setAnnounceMode(e.target.value as AnnounceMode)}
            >
              <option value="always">always</option>
              <option value="affects_user">affects_user</option>
              <option value="never">never</option>
            </Select>
          </Field>
          <Field label="Motivo (auditado, mín. 10 caracteres)" required>
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
            />
          </Field>
        </div>
      )}

      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Modal>
  );
}
