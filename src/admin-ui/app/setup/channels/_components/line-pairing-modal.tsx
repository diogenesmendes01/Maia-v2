'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';
import { Modal } from '../../../../components/ui/modal.js';
import { Button } from '../../../../components/ui/button.js';
import { Field, Textarea } from '../../../../components/ui/field.js';
import { Badge } from '../../../../components/ui/badge.js';
import { Alert, Spinner } from '../../../../components/ui/states.js';
import { presentState, presentReason, countdown } from './line-state.js';

interface Props {
  tenantId: string;
  agentId: string;
  channelId: string;
  channelLabel: string;
  onClose: () => void;
  /** Chamado quando o estado da linha muda (o caller invalida as queries). */
  onChanged: () => void;
}

type Method = 'qr' | 'code';

const POLL_MS = 2000;

/**
 * Chave de idempotência da TENTATIVA. `crypto.randomUUID` existe em contexto
 * seguro (o console roda sob HTTPS, e `localhost` também conta); o fallback
 * cobre um navegador antigo sem derrubar o fluxo — a consequência de uma
 * chave "menos aleatória" aqui é apenas menos deduplicação de retry.
 */
function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const hex = (n: number): string =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
}

/**
 * Modal de pareamento de linha (issue #518).
 *
 * Tudo acontece dentro da sessão autenticada do console: o QR chega como data
 * URI no CORPO de uma resposta `no-store` e é renderizado inline — nenhuma URL
 * carrega credencial, nada vai para histórico, referer ou access log.
 *
 * O operador escolhe QR ou código, justifica (motivo auditado), acompanha o
 * countdown e pode cancelar. Um pareamento em curso é retomado ao reabrir o
 * modal — o estado vive no Postgres, não nesta aba.
 */
export default function LinePairingModal({
  tenantId,
  agentId,
  channelId,
  channelLabel,
  onClose,
  onChanged,
}: Props) {
  const [method, setMethod] = React.useState<Method>('qr');
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());

  const start = trpc.channelLines.startPairing.useMutation();
  const abort = trpc.channelLines.abortPairing.useMutation();

  const status = trpc.channelLines.getPairingStatus.useQuery(
    { tenantId, agentId, channelId },
    { refetchInterval: POLL_MS, refetchOnWindowFocus: true },
  );

  const state = status.data?.state ?? 'declared';
  const isPairing = state === 'pairing';
  const material = status.data?.material ?? null;

  // Relógio do countdown. Só corre durante o pareamento — um timer de 1s
  // rodando numa aba parada é desperdício.
  React.useEffect(() => {
    if (!isPairing) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isPairing]);

  // Toda transição relevante invalida a listagem do caller (o estado da
  // linha aparece na tabela).
  const lastState = React.useRef(state);
  React.useEffect(() => {
    if (lastState.current !== state) {
      lastState.current = state;
      onChanged();
    }
  }, [state, onChanged]);

  const handleStart = async () => {
    setError(null);
    if (comment.trim().length < 10) {
      setError('O motivo deve ter pelo menos 10 caracteres — ele vai para a auditoria.');
      return;
    }
    try {
      await start.mutateAsync({
        tenantId,
        agentId,
        channelId,
        method,
        idempotencyKey: newIdempotencyKey(),
        comment: comment.trim(),
      });
      await status.refetch();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleAbort = async () => {
    setError(null);
    try {
      await abort.mutateAsync({
        tenantId,
        agentId,
        channelId,
        comment: comment.trim().length >= 10 ? comment.trim() : 'Pareamento cancelado pelo operador',
      });
      await status.refetch();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const presentation = presentState(state);
  const reason = presentReason(status.data?.reason_code ?? null);
  const materialLeft = countdown(status.data?.material_expires_at ?? null, now);
  const attemptLeft = countdown(status.data?.pairing_expires_at ?? null, now);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Parear linha ${channelLabel}`}
      description={
        <>
          Digitar o número não prova posse: a linha só é ativada quando o
          WhatsApp <strong>desta</strong> linha confirmar o pareamento. Toda
          operação é auditada com o seu usuário.
        </>
      }
      footer={
        isPairing ? (
          <Button variant="secondary" onClick={() => void handleAbort()} loading={abort.isPending}>
            Cancelar pareamento
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Fechar
            </Button>
            <Button onClick={() => void handleStart()} loading={start.isPending}>
              {state === 'failed' ? 'Tentar de novo' : 'Iniciar pareamento'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <div
          className="flex flex-wrap items-center gap-2"
          aria-live="polite"
          data-testid="line-pairing-state"
        >
          <span className="text-xs text-zinc-500">Estado:</span>
          <Badge tone={presentation.tone}>{presentation.label}</Badge>
          <span className="text-xs text-zinc-500">{presentation.help}</span>
        </div>

        {reason && state !== 'connected' && (
          <Alert tone={state === 'failed' || state === 'logged_out' ? 'danger' : 'info'}>
            {reason}
          </Alert>
        )}

        {!isPairing && (
          <>
            {/* Não usa <Field> aqui de propósito: Field renderiza um <label>
                e aninhar <button> dentro de <label> duplica a ativação. */}
            <div role="group" aria-label="Método de pareamento">
              <span className="mb-1.5 block text-xs font-medium text-zinc-700">
                Método <span className="text-red-500">*</span>
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={method === 'qr' ? 'primary' : 'secondary'}
                  onClick={() => setMethod('qr')}
                  aria-pressed={method === 'qr'}
                >
                  QR Code
                </Button>
                <Button
                  size="sm"
                  variant={method === 'code' ? 'primary' : 'secondary'}
                  onClick={() => setMethod('code')}
                  aria-pressed={method === 'code'}
                >
                  Código de 8 dígitos
                </Button>
              </div>
            </div>
            <Field label="Motivo (auditado, mín. 10 caracteres)" required>
              <Textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                placeholder="Ex.: Parear a linha comercial declarada para o agente de vendas."
              />
            </Field>
          </>
        )}

        {isPairing && (
          <div className="rounded-lg border border-zinc-200 p-4">
            {material === null ? (
              <div className="flex items-center gap-3 py-6 text-sm text-zinc-600">
                <Spinner />
                <span>
                  Preparando o {method === 'code' ? 'código' : 'QR'}… o runtime está abrindo a
                  sessão.
                </span>
              </div>
            ) : material.kind === 'qr' ? (
              <div className="text-center">
                {/* O QR chega como data URI no corpo da resposta autenticada:
                    não há request de imagem, então nada vaza em referer nem
                    em access log (era exatamente o problema do
                    `/setup/qr.png?token=…`). */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={material.png_data_uri}
                  alt="QR Code de pareamento"
                  width={288}
                  height={288}
                  className="mx-auto rounded-lg border border-zinc-200"
                />
                <p className="mt-3 text-sm text-zinc-600">
                  WhatsApp → <strong>Aparelhos conectados</strong> →{' '}
                  <strong>Conectar aparelho</strong> e aponte a câmera.
                </p>
              </div>
            ) : (
              <div className="text-center">
                <div
                  className="my-4 select-all font-mono text-4xl font-bold tracking-widest text-zinc-900"
                  data-testid="pairing-code"
                >
                  {material.code.length === 8
                    ? `${material.code.slice(0, 4)}-${material.code.slice(4)}`
                    : material.code}
                </div>
                <p className="text-sm text-zinc-600">
                  WhatsApp → <strong>Aparelhos conectados</strong> →{' '}
                  <strong>Conectar com número de telefone</strong> → digite o código.
                </p>
              </div>
            )}

            <div className="mt-4 flex flex-wrap justify-center gap-4 text-xs text-zinc-500">
              {materialLeft && (
                <span>
                  Este {material?.kind === 'code' ? 'código' : 'QR'} expira em{' '}
                  <span className="font-mono">{materialLeft}</span>
                </span>
              )}
              {attemptLeft && (
                <span>
                  Tentativa expira em <span className="font-mono">{attemptLeft}</span>
                </span>
              )}
              <span>Tentativa nº {status.data?.attempts ?? 1}</span>
            </div>
          </div>
        )}

        {state === 'verified_offline' && (
          <Alert tone="success">
            Posse provada. A linha ainda não roteia: ela precisa de uma política com papel padrão
            e da sessão de roteamento no ar.
          </Alert>
        )}

        {state === 'connected' && (
          <Alert tone="success">Linha conectada — já envia e recebe.</Alert>
        )}

        {error && <Alert tone="danger">{error}</Alert>}

        <p className="text-2xs leading-relaxed text-zinc-400">
          O QR e o código são credenciais de curta duração: qualquer pessoa que os leia consegue
          conectar um aparelho a esta linha. Eles nunca aparecem em URL, log ou auditoria — e
          somem da tela ao expirar.
        </p>
      </div>
    </Modal>
  );
}
