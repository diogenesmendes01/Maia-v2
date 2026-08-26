/**
 * Issue #634 (fatia E da épica #506) — A TRAVA.
 *
 * A issue-mãe é literal: "**nenhum caminho de produção pode chamar o adaptador
 * diretamente fora do outbox**, salvo exceção documentada, fail-closed e
 * testada". Este módulo é o "fail-closed" dessa frase; o "documentada" é
 * `send-paths.ts`; o "testada" é
 * `tests/unit/runtime/outbound-trava-envio-direto.spec.ts`.
 *
 * ─── Por que uma trava de RUNTIME e não só um teste de arquitetura ──────────
 *
 * O teste estático varre o texto de `src/` e reprova um `line.sendText(` num
 * arquivo que o inventário não conhece. Isso pega o caso comum — código novo —
 * e não pega três casos reais:
 *
 *   1. envio por referência indireta (`const s = line.sendText; s(...)`);
 *   2. envio a partir de um módulo INVENTARIADO, mas fora do trecho que o
 *      inventário descreve (um `catch` que reenvia por fora do outbox);
 *   3. envio a partir de dependência ou de código gerado.
 *
 * A trava de runtime não tem esse ponto cego porque ela não pergunta QUEM
 * chamou: ela pergunta se a chamada está DENTRO de um escopo de egresso
 * declarado. Um envio fora de qualquer escopo é recusado, seja qual for o
 * arquivo que o originou.
 *
 * ─── Por que AsyncLocalStorage e não um parâmetro ───────────────────────────
 *
 * Um parâmetro `via: 'outbox'` seria trivialmente falsificável por quem
 * quisesse contornar (e, pior, por quem estivesse só copiando um call site) e
 * exigiria mudar a assinatura de `LineOutput`, que é a fronteira que a fase 0
 * do roteamento multi-linha congelou. O ALS já é o mecanismo de escopo deste
 * runtime (tenant/agent, posse do turno), propaga por `await` e por timer, e
 * NÃO propaga para quem não abriu o escopo — que é exatamente a semântica
 * desejada.
 *
 * ─── Fail-closed, sem flag ──────────────────────────────────────────────────
 *
 * Não há `FEATURE_*` aqui, e a ausência é a decisão. #506 lista entre os riscos
 * "feature flag mal desenhada pode reativar caminho fail-open", e uma trava
 * cujo default fosse "só contar" seria exatamente isso: a violação vira uma
 * série de métrica que ninguém olha e o envio direto continua. O custo de
 * fechar por padrão é que um caminho de envio esquecido QUEBRA em vez de
 * escapar — e é por isso que o inventário de `send-paths.ts` tem uma entrada
 * para cada `LineOutput.send*` que existe hoje em `src/`, verificada pelo teste
 * estático.
 *
 * A métrica `maia_outbound_direct_send_violation_total` continua sendo emitida
 * ANTES do throw: um alarme que só dispara quando alguém lê um stack trace não
 * é um alarme.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { incCounter } from '@/lib/metrics.js';
import { logger } from '@/lib/logger.js';
import { TypedError } from '@/lib/utils.js';
import { METRIC } from '@/observability/taxonomy.js';
import { isDeclaredEgressException, type OutboundSendPathId } from './send-paths.js';

/**
 * As primitivas de MENSAGEM de `LineOutput`. `startTyping`/`markRead` ficam de
 * fora de propósito: são sinais efêmeros de presença, não saídas lógicas do
 * turno — não têm artefato, não têm idempotência e não aparecem no histórico.
 * Cobri-las faria o typing de `agent/core.ts` virar uma "violação".
 */
export const EGRESS_PRIMITIVES = [
  'sendText',
  'sendDocument',
  'sendVoice',
  'sendPoll',
  'sendReaction',
] as const;

export type EgressPrimitive = (typeof EGRESS_PRIMITIVES)[number];

/**
 * Por onde o envio está autorizado a sair.
 *
 *   `outbox`    — há artefato durável commitado e a entrega é dele. É o
 *                 caminho que a épica quer para tudo.
 *   `exception` — caminho legado inventariado, com motivo escrito e id
 *                 estável. Não é "permitido": é RASTREADO.
 */
export type EgressAuthorization =
  | { via: 'outbox'; outbound_id: string | null }
  | { via: 'exception'; path_id: OutboundSendPathId };

const als = new AsyncLocalStorage<EgressAuthorization>();

/**
 * Escopo de egresso do OUTBOX. Abre em volta da chamada ao provedor — nunca em
 * volta de um bloco maior.
 *
 * O tamanho do escopo é o contrato: envolver `deliverOutbound()` inteiro
 * autorizaria qualquer envio que acontecesse durante a entrega, inclusive um
 * envio de outro módulo alcançado por um callback. Envolver só a chamada ao
 * adaptador mantém a autorização do tamanho do efeito.
 */
export function withOutboxEgress<T>(outbound_id: string | null, fn: () => Promise<T>): Promise<T> {
  return als.run({ via: 'outbox', outbound_id }, fn);
}

/**
 * Escopo de egresso de uma EXCEÇÃO INVENTARIADA.
 *
 * `path_id` precisa existir em `send-paths.ts` com `state:'declared_exception'`
 * — um id desconhecido é recusado aqui mesmo, para que "abrir uma exceção" não
 * possa ser feito sem escrever o motivo no inventário.
 */
export function withDeclaredEgressException<T>(
  path_id: OutboundSendPathId,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isDeclaredEgressException(path_id)) {
    throw new TypedError(
      'outbound_egress_exception_unknown',
      'egress exception id is not declared in the outbound send-path inventory',
      { path_id },
    );
  }
  return als.run({ via: 'exception', path_id }, fn);
}

/** Variante síncrona — `sendReaction` devolve `void`, não uma promessa. */
export function withDeclaredEgressExceptionSync<T>(path_id: OutboundSendPathId, fn: () => T): T {
  if (!isDeclaredEgressException(path_id)) {
    throw new TypedError(
      'outbound_egress_exception_unknown',
      'egress exception id is not declared in the outbound send-path inventory',
      { path_id },
    );
  }
  return als.run({ via: 'exception', path_id }, fn);
}

/** A autorização vigente, ou `undefined` fora de qualquer escopo. */
export function currentEgressAuthorization(): EgressAuthorization | undefined {
  return als.getStore();
}

export class DirectSendViolationError extends TypedError {
  constructor(public readonly primitive: EgressPrimitive) {
    super(
      'outbound_direct_send_violation',
      `refusing ${primitive}: the outbound channel may only be called from the durable outbox or from a declared, inventoried exception`,
      { primitive },
    );
  }
}

/**
 * O guard. Chamado por CADA primitiva de mensagem da fronteira única
 * (`src/gateway/line-output.ts`).
 *
 * A ordem — contar, logar, lançar — é deliberada: a série tem de existir mesmo
 * quando alguém captura o throw mais acima e o transforma em `logger.warn`.
 * Sem `tenant_id`/`agent_id` como label por escolha: `incCounter` já atribui o
 * tenant do ALS, e `kind`/`primitive` é vocabulário FECHADO de cinco valores.
 */
export function assertEgressAuthorized(primitive: EgressPrimitive): EgressAuthorization {
  const auth = als.getStore();
  if (auth) return auth;
  incCounter(METRIC.OUTBOUND_DIRECT_SEND_VIOLATION, { kind: primitive });
  logger.error(
    { primitive, ops_alert: true },
    'outbound.direct_send_violation',
  );
  throw new DirectSendViolationError(primitive);
}
