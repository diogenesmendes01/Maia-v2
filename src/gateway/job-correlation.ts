/**
 * Issue #514 §1 — correlation stamping for `AgentJob` payloads.
 *
 * Lives in its own module (not in `queue.ts`) on purpose: `debouncer.ts` needs
 * it too, and the debouncer's unit suite mocks `queue.js` wholesale. Importing
 * the stamper from the mocked module would force every one of those specs to
 * re-declare it. A leaf module with no Redis/BullMQ import is also trivially
 * unit-testable and adds no startup cost.
 */
import { correlationForJob } from '@/observability/correlation.js';
import { isAgentTurnJobV2, type AgentJob } from './types.js';

/**
 * Return `data` with the turn's correlation fields stamped on.
 *
 * Precedence:
 *   - `trace_id` supplied by the caller WINS — the recovery sweep and the
 *     unrouted replay re-enqueue an existing turn and must keep its root.
 *   - otherwise the id is DERIVED from `mensagem_id`, so re-enqueueing the
 *     same row (crash recovery, debounce reset, DLQ replay) always lands on
 *     the same root trace with no state carried between attempts.
 *
 * `enqueued_at_ms` is always refreshed: it measures THIS arming, which is what
 * the queue-wait SLI wants (a debounce reset legitimately restarts the clock).
 */
export function withCorrelation<T extends AgentJob>(data: T): T {
  // Semente da derivação: a IDENTIDADE do job em cada versão. Um job V2 semeia
  // pelo `turn_id`, um V1 pelo `mensagem_id` — dentro de cada versão a
  // derivação é estável, que é a propriedade de que o rearmamento depende.
  //
  // Nota de rollout (#504): o mesmo turno armado como V1 e depois como V2
  // produziria DOIS root traces. Isso é aceito de propósito: a alternativa
  // seria ler o banco aqui (este módulo é folha, sem I/O, e é o que permite ao
  // debouncer mocká-lo). O turno em si continua único — o que muda é a árvore
  // de trace, e só na janela de migração.
  const seed = isAgentTurnJobV2(data) ? data.turn_id : data.mensagem_id;
  const derived = correlationForJob(seed, data.received_at_ms);
  return {
    ...data,
    trace_id: data.trace_id ?? derived.trace_id,
    enqueued_at_ms: derived.enqueued_at_ms,
    ...(derived.received_at_ms != null ? { received_at_ms: derived.received_at_ms } : {}),
  };
}
