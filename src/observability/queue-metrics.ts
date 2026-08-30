/**
 * Issue #514 §5 (Fila) — queue depth, oldest job age, backlog by state.
 *
 * These are the two SLIs the issue singles out ("Queue depth e oldest age
 * estão disponíveis", "oldest agent job < 2s em operação normal") and the ones
 * that make a latency incident attributable: a p95 blowup with a flat queue is
 * a DB/LLM problem, the same blowup with a growing `oldest_job_age` is a
 * capacity problem.
 *
 * Implemented as SCRAPE-TIME gauge providers rather than counters so the
 * values are correct with multiple replicas: every replica reports the same
 * shared Redis queue, so Prometheus sees N identical series that `max by
 * (queue, state)` collapses correctly. A counter incremented per replica would
 * have to be summed and would drift on restart.
 *
 * Failure posture: a provider that cannot reach Redis returns NaN (via
 * `metrics.gauge`), never 0 — issue #514 invariant "métrica ausente não é
 * interpretada como zero saudável". A dashboard that plots 0 for a dead Redis
 * is worse than one that plots a gap.
 */
import type { Queue } from 'bullmq';
import { gauge } from './metrics.js';
import { METRIC } from './taxonomy.js';

/**
 * States we expose. Bounded, enumerated — safe as a label.
 *
 * ─── Por que `paused` saiu na migração para a BullMQ 6 ──────────────────────
 *
 * Até a 5.x, `paused` era um ESTADO DE JOB: `Queue.pause()` renomeava a lista
 * `bull:<fila>:wait` para `bull:<fila>:paused` e o backlog inteiro mudava de
 * série. Na 6.x isso acabou — pausar grava um campo `paused` no hash
 * `bull:<fila>:meta` e os jobs FICAM em `wait`. Por isso a 6.x removeu
 * `'paused'` de `JobType`, e é esse o único erro de compilação que a PR
 * automática #649 produziu (`queue-metrics.ts:52`).
 *
 * Medido nesta máquina, fila pausada com 2 jobs (`scratchpad/paused-probe`):
 *
 *   bullmq 5.78.0 → getJobCounts(...) = { waiting: 0, paused: 2 }, chave `paused`
 *   bullmq 6.2.0  → getJobCounts(...) = { waiting: 2 },            chave `wait`
 *
 * O CONSERTO ERRADO seria um cast que mantivesse o label: na 6.x
 * `getJobCounts('paused')` não lança — devolve `0`, sempre, porque lê uma chave
 * que ninguém mais escreve. A série viraria um zero confiante e permanente, que
 * é exatamente o que a "postura de falha" acima proíbe ("métrica ausente não é
 * interpretada como zero saudável"). Um label morto mente melhor que um gap.
 *
 * O sinal não se perdeu, MELHOROU: o backlog de uma fila pausada agora aparece
 * em `state="waiting"` em vez de sumir dela. Na 5.x, pausar a fila `agent`
 * zerava `maia_queue_depth{state="waiting"}` com jobs represados atrás —
 * um ponto cego para `MaiaQueueOldestJobAge`/`maia:queue_depth:max`
 * (`monitoring/alerts/slo.rules.yml`). Nenhuma regra e nenhum painel
 * referenciam `state="paused"` (conferido em `monitoring/`), então a série sai
 * sem quebrar alerta nem legenda.
 *
 * O que a 6.x oferece no lugar, se algum dia se quiser o sinal de "esta fila
 * está pausada", é `Queue.isPaused()` (booleano por fila, lido do meta) — uma
 * métrica NOVA, não um estado de profundidade. Fica fora desta PR de propósito:
 * é decisão de taxonomia, não de migração.
 */
const TRACKED_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;
type TrackedState = (typeof TRACKED_STATES)[number];

/**
 * Age (ms) of the oldest job still waiting. `getJobs(['waiting'], 0, 0, true)`
 * asks Redis for the FIRST job in ascending order — one entry, not the whole
 * backlog, so this stays O(1) regardless of queue size.
 */
async function oldestWaitingAgeMs(queue: Queue): Promise<number> {
  const jobs = await queue.getJobs(['waiting'], 0, 0, true);
  const oldest = jobs[0];
  if (!oldest || typeof oldest.timestamp !== 'number') return 0;
  return Math.max(0, Date.now() - oldest.timestamp);
}

/**
 * Register depth + age gauges for `queue`.
 *
 * Idempotent: `setGaugeProvider` is keyed by series name, so calling this
 * twice (test harness, hot reload) replaces the provider instead of stacking.
 */
export function registerQueueGauges(queue: Queue, name: string): void {
  for (const state of TRACKED_STATES) {
    gauge(
      METRIC.QUEUE_DEPTH,
      async () => {
        const counts = await queue.getJobCounts(...TRACKED_STATES);
        const v = (counts as Record<TrackedState, number | undefined>)[state];
        // A state Redis did not report is unknown, not zero.
        return typeof v === 'number' ? v : Number.NaN;
      },
      { queue: name, state },
    );
  }

  gauge(METRIC.QUEUE_OLDEST_JOB_AGE_MS, () => oldestWaitingAgeMs(queue), { queue: name });
}

/** Exposed for tests — the state set the gauges cover. */
export const _TRACKED_STATES = TRACKED_STATES;
