'use client';

import * as React from 'react';
import { trpc } from '../../../trpc/client.js';
import { Button } from '../../../components/ui/button.js';
import { Field, Input, Select, Textarea } from '../../../components/ui/field.js';
import { Alert } from '../../../components/ui/states.js';
import LinePairingModal from '../../setup/channels/_components/line-pairing-modal.js';
import { ERROR_HELP, STEP_LABEL } from './labels.js';

/**
 * Formulário do passo CORRENTE da saga (issue #519 §7).
 *
 * Três propriedades que a tela precisa ter e que estão implementadas aqui, não
 * no backend por acaso:
 *
 *   1. **Backend é a fonte de verdade.** O que aparece é derivado de
 *      `run.current_step` e `run.allowed_steps`, ambos calculados pela máquina
 *      de estados no servidor. A UI não decide o que vem depois.
 *
 *   2. **Proteção contra double-submit.** O botão desabilita enquanto a
 *      mutação está no ar, E a chave de idempotência é ESTÁVEL por
 *      (passo, versão): dois cliques, ou um retry depois de um timeout,
 *      carregam a MESMA chave — o backend devolve o resultado anterior em vez
 *      de provisionar duas vezes. A chave só é regenerada quando a run avança
 *      (o par passo/versão muda), que é o único momento em que ela representa
 *      outra intenção.
 *
 *   3. **Nada de segredo na URL.** O pareamento reusa o `LinePairingModal` da
 *      #518: o QR chega no corpo de uma resposta `no-store` e é renderizado
 *      inline.
 */

interface Props {
  run: {
    id: string;
    version: number;
    current_step: string;
    state: string;
    tenant_id: string | null;
    agent_id: string | null;
    allowed_steps: string[];
    /**
     * `unknown` de propósito: o tipo que atravessa o tRPC passa pela
     * transformação de serialização, e amarrar a prop a `Record<string,
     * unknown>` acoplaria esta tela a esse detalhe. A leitura é feita com
     * narrowing explícito abaixo.
     */
    metadata: unknown;
  };
  onChanged: () => void;
}

/** Chave opaca da tentativa. Mesma implementação do modal de pareamento. */
function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const hex = (n: number): string =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
}

const COMMENT_HINT = 'Motivo auditado — mínimo 10 caracteres.';

export default function StepForm({ run, onChanged }: Props) {
  const submit = trpc.onboarding.submitStep.useMutation();
  const [error, setError] = React.useState<string | null>(null);
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [showPairing, setShowPairing] = React.useState(false);

  // Campos por passo. Um só objeto para não multiplicar estados; o payload
  // enviado é montado por passo.
  const [form, setForm] = React.useState<Record<string, string>>({});
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // ── chave de idempotência estável por (passo, versão) ───────────────────
  const keyScope = `${run.current_step}:${run.version}`;
  const keyRef = React.useRef<{ scope: string; key: string }>({
    scope: keyScope,
    key: newIdempotencyKey(),
  });
  if (keyRef.current.scope !== keyScope) {
    keyRef.current = { scope: keyScope, key: newIdempotencyKey() };
  }

  // Passo novo ⇒ formulário limpo (o payload anterior não faz sentido aqui).
  const lastStep = React.useRef(run.current_step);
  React.useEffect(() => {
    if (lastStep.current !== run.current_step) {
      lastStep.current = run.current_step;
      setForm({});
      setError(null);
      setErrorCode(null);
    }
  }, [run.current_step]);

  const send = async (step: string, payload: unknown) => {
    setError(null);
    setErrorCode(null);
    try {
      await submit.mutateAsync({
        runId: run.id,
        step: step as never,
        expectedVersion: run.version,
        idempotencyKey: keyRef.current.key,
        payload,
      });
      onChanged();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // O código sanitizado vem na `data` do TRPCError quando disponível; a
      // heurística abaixo é só para escolher o texto de apoio.
      const known = Object.keys(ERROR_HELP).find((c) => message.toLowerCase().includes(c));
      setErrorCode(known ?? null);
    }
  };

  const comment = form.comment ?? '';
  const commentOk = comment.trim().length >= 10;
  const pending = submit.isPending;

  const CommentField = (
    <Field label="Motivo (auditado)" hint={COMMENT_HINT} required>
      <Textarea
        rows={2}
        value={comment}
        onChange={(e) => set('comment', e.target.value)}
        placeholder="Ex.: provisionamento inicial do cliente Acme."
      />
    </Field>
  );

  const metadata = (run.metadata ?? {}) as Record<string, unknown>;
  const channelId = typeof metadata.channel_id === 'string' ? metadata.channel_id : null;
  const channelLabel =
    typeof metadata.channel_label === 'string' ? metadata.channel_label : 'WhatsApp';

  const body = (() => {
    switch (run.current_step) {
      case 'tenant':
        return (
          <>
            <Field
              label="Modo"
              hint="“Criar” provisiona um tenant novo (exige founder). “Anexar” continua o onboarding de um tenant existente."
              required
            >
              <Select value={form.mode ?? 'create'} onChange={(e) => set('mode', e.target.value)}>
                <option value="create">Criar tenant novo</option>
                <option value="attach">Anexar tenant existente</option>
              </Select>
            </Field>
            <Field label="Identificador do tenant" hint="Minúsculas, dígitos, _ e -." required>
              <Input
                value={form.tenant_id ?? ''}
                onChange={(e) => set('tenant_id', e.target.value)}
                placeholder="acme"
              />
            </Field>
            {(form.mode ?? 'create') === 'create' && (
              <Field label="Nome do tenant" required>
                <Input
                  value={form.nome ?? ''}
                  onChange={(e) => set('nome', e.target.value)}
                  placeholder="Acme Ltda"
                />
              </Field>
            )}
            {CommentField}
            <Button
              disabled={!commentOk || !(form.tenant_id ?? '').trim()}
              loading={pending}
              onClick={() =>
                void send('tenant', {
                  mode: form.mode ?? 'create',
                  tenant_id: (form.tenant_id ?? '').trim(),
                  nome: (form.nome ?? '').trim() || undefined,
                  comment: comment.trim(),
                })
              }
            >
              Confirmar tenant
            </Button>
          </>
        );

      case 'admin':
        return (
          <>
            <Alert tone="info">
              Este usuário é criado como <strong>owner</strong> do tenant — restrito a ele. O
              papel <code className="font-mono">founder</code> só nasce no bootstrap global da
              instalação, nunca aqui.
            </Alert>
            <Field
              label="E-mail do administrador"
              hint="Precisa ser exatamente o e-mail que o IdP vai apresentar."
              required
            >
              <Input
                type="email"
                value={form.email ?? ''}
                onChange={(e) => set('email', e.target.value)}
                placeholder="operador@acme.com"
              />
            </Field>
            <Field label="Nome" required>
              <Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} />
            </Field>
            {CommentField}
            <Button
              disabled={!commentOk || !(form.email ?? '').trim() || !(form.name ?? '').trim()}
              loading={pending}
              onClick={() =>
                void send('admin', {
                  email: (form.email ?? '').trim(),
                  name: (form.name ?? '').trim(),
                  comment: comment.trim(),
                })
              }
            >
              Criar administrador
            </Button>
          </>
        );

      case 'agent':
        return (
          <>
            <Alert tone="info">
              O agente nasce <strong>pausado</strong>. Ele só passa a atender na etapa final de
              ativação, e apenas se o backend provar que todos os pré-requisitos são deste mesmo
              tenant e agente.
            </Alert>
            <Field label="Identificador do agente" hint="Minúsculas, dígitos, _ e -." required>
              <Input
                value={form.agent_id ?? ''}
                onChange={(e) => set('agent_id', e.target.value)}
                placeholder="atendimento"
              />
            </Field>
            <Field label="Nome do agente" required>
              <Input value={form.nome ?? ''} onChange={(e) => set('nome', e.target.value)} />
            </Field>
            <Field label="Função (arquétipo)" hint="Define os packs de domínio extras.">
              <Select
                value={form.archetype ?? 'custom'}
                onChange={(e) => set('archetype', e.target.value)}
              >
                <option value="custom">Personalizado (só o piso da plataforma)</option>
                <option value="vendedor">Vendedor</option>
                <option value="suporte">Suporte</option>
                <option value="financeiro">Financeiro</option>
                <option value="agendador">Agendador</option>
              </Select>
            </Field>
            <Field
              label="Descrição do papel"
              hint="Uma frase sobre o que este agente faz. Entra no perfil operacional semente."
              required
            >
              <Input
                value={form.role_descriptor ?? ''}
                onChange={(e) => set('role_descriptor', e.target.value)}
                placeholder="Atendente comercial da Acme no WhatsApp"
              />
            </Field>
            {CommentField}
            <Button
              disabled={
                !commentOk ||
                !(form.agent_id ?? '').trim() ||
                !(form.nome ?? '').trim() ||
                !(form.role_descriptor ?? '').trim()
              }
              loading={pending}
              onClick={() =>
                void send('agent', {
                  agent_id: (form.agent_id ?? '').trim(),
                  nome: (form.nome ?? '').trim(),
                  archetype: form.archetype ?? null,
                  role_descriptor: (form.role_descriptor ?? '').trim(),
                  comment: comment.trim(),
                })
              }
            >
              Criar agente
            </Button>
          </>
        );

      case 'profile':
        return (
          <>
            <Alert tone="warning" title="Aprovação humana">
              Aprovar o perfil semente é uma decisão de governança: ela ATIVA a identidade
              operacional do agente. O motivo abaixo fica na trilha de auditoria.
            </Alert>
            {CommentField}
            <Button
              disabled={!commentOk}
              loading={pending}
              onClick={() => void send('profile', { comment: comment.trim() })}
            >
              Aprovar e ativar o perfil
            </Button>
          </>
        );

      case 'capabilities':
        return (
          <>
            <Alert tone="info">
              O piso da plataforma é sempre aplicado. Packs extras entram aqui, separados por
              vírgula — aplicar o mesmo conjunto duas vezes produz exatamente o mesmo resultado.
            </Alert>
            <Field label="Packs extras (opcional)" hint="Ex.: domain.sales, domain.support">
              <Input
                value={form.extra_packs ?? ''}
                onChange={(e) => set('extra_packs', e.target.value)}
                placeholder="domain.sales"
              />
            </Field>
            {CommentField}
            <Button
              disabled={!commentOk}
              loading={pending}
              onClick={() =>
                void send('capabilities', {
                  extra_packs: (form.extra_packs ?? '')
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                  comment: comment.trim(),
                })
              }
            >
              Aplicar capacidades
            </Button>
          </>
        );

      case 'role':
        return (
          <>
            <Alert tone="info">
              Este papel será o <strong>papel padrão</strong> do agente — é ele que a política do
              canal vai nomear. Sem papel padrão ativo, o canal não tem como escolher um
              comportamento e a linha não roteia.
            </Alert>
            <Field label="Chave do papel" hint="Minúsculas, dígitos, _ e -." required>
              <Input
                value={form.role_key ?? ''}
                onChange={(e) => set('role_key', e.target.value)}
                placeholder="atendente"
              />
            </Field>
            <Field label="Nome visível" required>
              <Input
                value={form.display_name ?? ''}
                onChange={(e) => set('display_name', e.target.value)}
                placeholder="Atendente comercial"
              />
            </Field>
            <Field label="Instruções adicionais do papel (opcional)">
              <Textarea
                rows={3}
                value={form.prompt_addendum ?? ''}
                onChange={(e) => set('prompt_addendum', e.target.value)}
              />
            </Field>
            {CommentField}
            <Button
              disabled={!commentOk || !(form.role_key ?? '').trim() || !(form.display_name ?? '').trim()}
              loading={pending}
              onClick={() =>
                void send('role', {
                  role_key: (form.role_key ?? '').trim(),
                  display_name: (form.display_name ?? '').trim(),
                  prompt_addendum: (form.prompt_addendum ?? '').trim() || undefined,
                  comment: comment.trim(),
                })
              }
            >
              Criar papel padrão
            </Button>
          </>
        );

      case 'channel':
        return (
          <>
            <Alert tone="info">
              A linha nasce <strong>declarada e inativa</strong>: digitar o número não prova
              posse. A política do canal é criada junto, apontando para o papel padrão — canal
              sem política não roteia.
            </Alert>
            <Field label="Linha WhatsApp (E.164)" hint="Com o “+”. Ex.: +5511999999999" required>
              <Input
                value={form.external_id ?? ''}
                onChange={(e) => set('external_id', e.target.value)}
                placeholder="+5511999999999"
              />
            </Field>
            <Field label="Nome da linha (opcional)">
              <Input
                value={form.display_name ?? ''}
                onChange={(e) => set('display_name', e.target.value)}
                placeholder="Linha comercial"
              />
            </Field>
            {CommentField}
            <Button
              disabled={!commentOk || !(form.external_id ?? '').trim()}
              loading={pending}
              onClick={() =>
                void send('channel', {
                  external_id: (form.external_id ?? '').trim(),
                  display_name: (form.display_name ?? '').trim() || undefined,
                  switch_behavior: 'locked',
                  comment: comment.trim(),
                })
              }
            >
              Declarar linha e política
            </Button>
          </>
        );

      case 'pairing':
        return (
          <>
            <Alert tone="info">
              A posse da linha é provada pelo WhatsApp, não por esta tela. O QR (ou o código de 8
              dígitos) aparece dentro do console, nunca em uma URL.
            </Alert>
            {run.state !== 'pairing_pending' && CommentField}
            <div className="flex flex-wrap gap-2">
              {run.state !== 'pairing_pending' && (
                <Button
                  disabled={!commentOk}
                  loading={pending}
                  onClick={() => void send('pairing', { comment: comment.trim() })}
                >
                  Marcar como aguardando pareamento
                </Button>
              )}
              {channelId && run.tenant_id && run.agent_id && (
                <Button variant="secondary" onClick={() => setShowPairing(true)}>
                  Abrir pareamento
                </Button>
              )}
              {run.allowed_steps.includes('readiness') && (
                <Button
                  variant="secondary"
                  loading={pending}
                  onClick={() => void send('readiness', {})}
                >
                  Avaliar prontidão
                </Button>
              )}
            </div>
          </>
        );

      case 'readiness':
        return (
          <>
            <Alert tone="info">
              A prontidão é recalculada no backend a cada avaliação. Corrija o que estiver
              vermelho na lista ao lado e avalie de novo — nada do que já foi provisionado se
              perde.
            </Alert>
            <div className="flex flex-wrap gap-2">
              <Button loading={pending} onClick={() => void send('readiness', {})}>
                Avaliar prontidão
              </Button>
              {channelId && run.tenant_id && run.agent_id && (
                <Button variant="secondary" onClick={() => setShowPairing(true)}>
                  Abrir pareamento
                </Button>
              )}
            </div>
          </>
        );

      case 'activation':
        return (
          <>
            <Alert tone="warning" title="Confirmação explícita">
              Ativar coloca <strong>{run.agent_id}</strong> do tenant{' '}
              <strong>{run.tenant_id}</strong> em operação. O backend reavalia a prontidão dentro
              da própria transição — se algo tiver mudado, a ativação é recusada.
            </Alert>
            <Field
              label="Confirme o identificador do agente"
              hint="Digite exatamente o identificador mostrado acima."
              required
            >
              <Input
                value={form.confirm_agent_id ?? ''}
                onChange={(e) => set('confirm_agent_id', e.target.value)}
              />
            </Field>
            {CommentField}
            <Button
              disabled={!commentOk || (form.confirm_agent_id ?? '').trim() !== (run.agent_id ?? '')}
              loading={pending}
              onClick={() =>
                void send('activation', {
                  confirm_tenant_id: run.tenant_id,
                  confirm_agent_id: (form.confirm_agent_id ?? '').trim(),
                  comment: comment.trim(),
                })
              }
            >
              Ativar agente
            </Button>
          </>
        );

      case 'done':
      default:
        return (
          <Alert tone="success" title="Jornada concluída">
            Não há mais etapas nesta run.
          </Alert>
        );
    }
  })();

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-zinc-900">
        Etapa: {STEP_LABEL[run.current_step] ?? run.current_step}
      </h3>
      {body}
      {error && (
        <Alert tone="danger" title="Não foi possível concluir">
          {error}
          {errorCode && ERROR_HELP[errorCode] && (
            <span className="mt-1 block">{ERROR_HELP[errorCode]}</span>
          )}
        </Alert>
      )}
      {showPairing && channelId && run.tenant_id && run.agent_id && (
        <LinePairingModal
          tenantId={run.tenant_id}
          agentId={run.agent_id}
          channelId={channelId}
          channelLabel={channelLabel}
          onClose={() => setShowPairing(false)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}
