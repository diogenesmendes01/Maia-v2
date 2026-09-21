/**
 * Issue #503 — a REGRA que traduz o resultado durável do ReAct no destino do
 * turno. Pura e sem I/O, para ser exaustivamente testável: era lógica inline em
 * `core.ts`, onde nenhum teste alcançava (a rodada 1 do review encontrou dois
 * defeitos exatamente aqui).
 *
 * O princípio: nenhum turno é concluído porque uma função retornou. O destino
 * sai de dois fatos DURÁVEIS — se a resposta chegou ao usuário, e se alguma
 * tool com efeito externo irreversível já rodou.
 */
import type { ReActDelivery, ReActExitReason } from './react-loop.js';

export type TurnAction =
  /** Estado terminal `completed`, com o outcome indicado. */
  | {
      kind: 'complete';
      outcome: 'reply_delivered' | 'reply_delivery_unknown' | 'no_reply_produced';
    }
  /** Falhou ANTES de efeito irreversível: pode voltar para a fila. */
  | { kind: 'retry'; code: ReActExitReason }
  /** Falhou DEPOIS de efeito irreversível: exige decisão humana. */
  | { kind: 'dead_letter'; code: ReActExitReason; outcome: 'unsafe_to_retry' };

/**
 * Saídas do ReAct em que NADA chegou ao usuário e NADA foi produzido de
 * definitivo — portanto, candidatas a nova tentativa:
 *
 *   `reasoner_failed`  (cenário A da issue) — o LLM expirou/errou;
 *   `outbound_failure` (cenário B) — resposta pronta, envio falhou pre-send.
 *
 * `empty_final_text` e `iteration_cap` NÃO entram: no primeiro o modelo
 * deliberadamente não produziu texto (o turno correu até o fim), e no segundo
 * as tools já rodaram — reexecutar duplicaria efeito.
 *
 * `human_control_blocked` também não entra, e a ausência é deliberada. Ele
 * parece `outbound_failure` — nada chegou ao usuário — mas a semelhança para
 * aí: um envio que falhou por transporte PODE dar certo na próxima; um
 * recusado porque um atendente assumiu a conversa NÃO vai, porque o fence
 * continuará recusando enquanto o humano estiver lá. Retentar seria a
 * automação insistindo para voltar ao canal de onde foi tirada.
 *
 * O desfecho é `complete/no_reply_produced`, e não `dead_letter`. Tomada
 * humana é operação NORMAL e frequente: mandar cada handover para a fila de
 * intervenção encheria a DLQ de eventos que já têm dono — o atendente. O que
 * importa é o turno fechar sem retry, e é isso que a ausência daqui garante.
 */
const RETRYABLE_EXITS: ReadonlySet<ReActExitReason> = new Set<ReActExitReason>([
  'reasoner_failed',
  'outbound_failure',
]);

export function decideTurnAction(delivery: ReActDelivery): TurnAction {
  // 1. A resposta chegou ao usuário. `persistUnknown` significa "enviado, mas a
  //    persistência ficou ambígua" — NUNCA reenviar; o outcome registra a
  //    incerteza em vez de mentir que está tudo certo.
  if (delivery.dispatched) {
    return {
      kind: 'complete',
      outcome: delivery.persistUnknown ? 'reply_delivery_unknown' : 'reply_delivered',
    };
  }

  // 2. Falha recuperável — mas só se nenhum efeito irreversível ocorreu. O
  //    gate é o mesmo para os dois motivos: o risco não vem de POR QUE o turno
  //    falhou, e sim do que já foi aplicado no mundo antes de falhar.
  if (RETRYABLE_EXITS.has(delivery.exitReason)) {
    return delivery.sideEffectsCommitted
      ? { kind: 'dead_letter', code: delivery.exitReason, outcome: 'unsafe_to_retry' }
      : { kind: 'retry', code: delivery.exitReason };
  }

  // 3. O turno correu até o fim sem produzir resposta.
  return { kind: 'complete', outcome: 'no_reply_produced' };
}
