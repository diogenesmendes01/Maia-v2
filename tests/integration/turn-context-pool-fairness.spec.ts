/**
 * Issue #525 / PR #541 review, finding 1 — ONE turn must not be able to take
 * the whole Postgres pool.
 *
 * ## What this measures, and why a round-trip count could not
 *
 * `tests/unit/turn-context-round-trips.spec.ts` proves the turn's TOTAL cost.
 * That number says nothing about contention: thirteen round-trips paid one at a
 * time and thirteen paid all at once look identical to it, and only the second
 * one starves the other tenants. The bug this file guards is exactly that
 * distinction — #525 collapsed the loader's waterfall by starting the critical
 * group (5 reads) and the optional group (5 reads) in the same tick, without
 * any ceiling over the two, against `max: 10` in `src/db/client.ts`. A single
 * cold-cache turn could hold every connection in the process.
 *
 * So this spec measures the INSTANTANEOUS shape instead:
 *
 *  - a real `pg.Pool` (the production one — `pool.options.max` is asserted, not
 *    assumed), with real statements on it;
 *  - the repository layer replaced by BARRIERS that hold a real connection open
 *    (`SELECT pg_sleep(…)`) for long enough that everything issued in the same
 *    tick genuinely overlaps, so "peak" is a measurement and not a race;
 *  - TWO `loadTurnContext` calls in flight at once, tagged through an
 *    `AsyncLocalStorage` frame so every read can be attributed to its turn.
 *
 * Two properties are asserted, and they pull in opposite directions on purpose:
 *
 *  1. CEILING — no turn ever has more than `TURN_CONTEXT_MAX_CONCURRENT_READS`
 *     statements in flight, so at least `max - 6` connections stay available to
 *     everyone else. Remove the gate in `turn-context/loader.ts` and the peak
 *     goes to 10 (the entire pool) and this fails.
 *  2. NO WATERFALL — the peak REACHES the ceiling. The cheap way to bound
 *     concurrency is to serialise, which would give up everything #525 bought;
 *     asserting the peak is exactly 6 makes "fixed by making it slow" fail too.
 *
 * Plus fairness: both turns must have work in flight at the same time (neither
 * is parked behind the other), and neither may take more than its share while
 * the other still has pending reads.
 *
 * Skipped without TEST_DB_URL so unit-only lanes pass without Postgres.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

/**
 * How long each barrier holds its connection. Long enough that every statement
 * issued in one tick is still open when the next one starts (so the peak is
 * observed, not missed), short enough that the whole spec is ~1s.
 */
const HOLD_SECONDS = 0.05;

type TurnTag = { id: string };

const turnTag = new AsyncLocalStorage<TurnTag>();

/**
 * One observation of the world, taken on every read start and every read end.
 * Declared inline in the hoisted block below because `vi.hoisted` runs before
 * type-only declarations in module order.
 */
const h = vi.hoisted(() => ({
  /** Reads currently issued and not yet returned, per turn id. */
  inFlight: {} as Record<string, number>,
  /** High-water mark of the above, per turn id. */
  peak: {} as Record<string, number>,
  /** Every transition, so fairness can be read off the timeline afterwards. */
  samples: [] as Array<{ at: number; inFlight: Record<string, number>; total: number }>,
  /** Reads issued per turn, so a "fix" that simply skips work is visible. */
  reads: {} as Record<string, number>,
  currentTurn: (): string => 'unattributed',
  hold: async (): Promise<void> => {},
}));

h.currentTurn = (): string => turnTag.getStore()?.id ?? 'unattributed';

function sample(): void {
  const inFlight = { ...h.inFlight };
  h.samples.push({
    at: performance.now(),
    inFlight,
    total: Object.values(inFlight).reduce((a, b) => a + b, 0),
  });
}

/**
 * The barrier. Every mocked repository method goes through here, so a "read"
 * in this spec is one real statement on the real pool, attributed to a turn,
 * held open for `HOLD_SECONDS`.
 */
async function barrier<T>(value: T): Promise<T> {
  const turn = h.currentTurn();
  h.reads[turn] = (h.reads[turn] ?? 0) + 1;
  h.inFlight[turn] = (h.inFlight[turn] ?? 0) + 1;
  h.peak[turn] = Math.max(h.peak[turn] ?? 0, h.inFlight[turn]!);
  sample();
  try {
    await h.hold();
    return value;
  } finally {
    h.inFlight[turn] = h.inFlight[turn]! - 1;
    sample();
  }
}

vi.mock('../../src/db/repositories.js', () => ({
  operationalProfileVersionsRepo: { getActive: () => barrier(null) },
  selfStateRepo: {
    getActive: () =>
      barrier({ system_prompt: 'Você é a Maia.', versao: 1, resumo_aprendizados: '(vazio)' }),
  },
  mensagensRepo: { recentInConversation: () => barrier([]) },
  entidadesRepo: {
    byIdsWithState: (ids: string[]) =>
      barrier(ids.map((id) => ({ entidade: { id, nome: `Entidade ${id}` }, state: null }))),
  },
  entityStatesRepo: { byIds: () => barrier([]) },
  factsRepo: { listMentionableForScopes: () => barrier([]) },
  rulesRepo: { listActive: () => barrier([]) },
  memoryEntryRepo: { findRelevant: () => barrier([]) },
  behavioralHintRepo: { findActiveForScopes: () => barrier([]) },
  capabilitiesSkillRepo: { listAll: () => barrier([]) },
  capabilityGapsRepo: { listParaOTurno: () => barrier([]) },
  procedureExecutionsRepo: { findActiveForConversa: () => barrier(null) },
  procedureDefinitionsRepo: { findById: () => barrier(null) },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { pool, db } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
import { loadTurnContext } from '../../src/agent/turn-context/loader.js';
import { TURN_CONTEXT_MAX_CONCURRENT_READS } from '../../src/agent/turn-context/types.js';
import { runWithTenantContext } from '../../src/db/tenant-context.js';

/**
 * A real statement that occupies a real pooled connection for the hold window.
 * `pg_sleep` is the point: the connection is CHECKED OUT for the duration, so
 * the peak this spec records is demand the pool actually sees.
 */
async function holdAConnection(): Promise<void> {
  await db.execute(sql.raw(`SELECT pg_sleep(${HOLD_SECONDS})`));
}

function runTurn(id: string, entidade_ids: string[]): Promise<unknown> {
  return turnTag.run({ id }, () =>
    runWithTenantContext({ tenant_id: `i541-${id}`, agent_id: `i541-ag-${id}` }, () =>
      loadTurnContext({
        pessoa_id: `pessoa-${id}`,
        conversa_id: `conv-${id}`,
        entidade_ids,
        // `undefined` (not null) so the loader resolves the procedure itself —
        // the most expensive path, i.e. the widest fan-out the finding is about.
        activeExecution: undefined,
      }),
    ),
  );
}

d('#541 finding 1 — a turn cannot monopolise the shared Postgres pool', () => {
  beforeEach(() => {
    for (const k of Object.keys(h.inFlight)) delete h.inFlight[k];
    for (const k of Object.keys(h.peak)) delete h.peak[k];
    for (const k of Object.keys(h.reads)) delete h.reads[k];
    h.samples.length = 0;
    h.hold = holdAConnection;
  });

  it('the pool this ceiling is sized against is still 10 connections', () => {
    // The gate's number only means something relative to this one. If someone
    // resizes the pool, the two must be re-reviewed together — that is what
    // this assertion is for.
    expect(pool.options.max).toBe(10);
    expect(TURN_CONTEXT_MAX_CONCURRENT_READS).toBeLessThan(pool.options.max!);
  });

  it(
    'two simultaneous turns each stay under the ceiling, and neither is starved',
    async () => {
      const started = performance.now();
      await Promise.all([runTurn('A', ['ent-a']), runTurn('B', ['ent-b'])]);
      const elapsed = performance.now() - started;

      // Both turns did the full read set — a "fix" that skipped work would
      // lower the peak too, so the work itself is asserted first. 11 reads:
      // profile + self_state + history + entities⋈states + facts + rules +
      // memories + hints + capabilities + gaps + procedure.
      expect(h.reads['A']).toBe(11);
      expect(h.reads['B']).toBe(11);
      expect(h.reads['unattributed']).toBeUndefined();

      // (1) THE CEILING. This is the assertion the finding is about: before the
      //     shared gate, a cold-cache turn with an unresolved procedure issued
      //     all ten of its tasks in one tick and the peak here was 10 — the
      //     entire pool, held by one turn, with two of them competing for it.
      expect(h.peak['A']).toBeLessThanOrEqual(TURN_CONTEXT_MAX_CONCURRENT_READS);
      expect(h.peak['B']).toBeLessThanOrEqual(TURN_CONTEXT_MAX_CONCURRENT_READS);

      // (2) NO WATERFALL. Bounding concurrency by serialising would pass (1)
      //     and throw away everything #525 bought. The gate must actually
      //     saturate: 10 tasks against 6 permits means 6 in flight from the
      //     first tick.
      expect(h.peak['A']).toBe(TURN_CONTEXT_MAX_CONCURRENT_READS);
      expect(h.peak['B']).toBe(TURN_CONTEXT_MAX_CONCURRENT_READS);

      // (3) CAPACITY LEFT FOR OTHERS, stated in pool terms rather than in the
      //     gate's own units — the property an operator cares about.
      const reservedForEveryoneElse = pool.options.max! - Math.max(h.peak['A']!, h.peak['B']!);
      expect(reservedForEveryoneElse).toBeGreaterThanOrEqual(4);

      // (4) FAIRNESS — the two turns genuinely interleave. Not just "both
      //     finished", which a serial execution would also satisfy: there is a
      //     moment where both had reads open at once.
      const overlapping = h.samples.filter((s) => (s.inFlight['A'] ?? 0) > 0 && (s.inFlight['B'] ?? 0) > 0);
      expect(overlapping.length).toBeGreaterThan(0);

      // (5) FAIRNESS, the sharper form: while both turns are active, neither
      //     ever holds more than half the pool. This is what "one turn's
      //     latency win became everyone else's queue" looks like as a number.
      const worstShareWhileContending = Math.max(
        ...overlapping.map((s) => Math.max(s.inFlight['A'] ?? 0, s.inFlight['B'] ?? 0)),
      );
      expect(worstShareWhileContending).toBeLessThanOrEqual(pool.options.max! / 2 + 1);

      // Sanity: the whole thing still ran concurrently rather than as 22
      // sequential holds. 22 reads × 50ms serial would be ≥ 1.1s.
      expect(elapsed).toBeLessThan(1_000);
    },
    30_000,
  );

  it('the gate does not change the failure contract of either group', async () => {
    // A gated CRITICAL rejection must still fail the turn, and a gated OPTIONAL
    // rejection must still degrade only its own section. The gate wraps both,
    // so this is the regression that would show up if a future edit moved the
    // gate outside `optional()`'s try (turning a degraded section into a failed
    // turn) or inside the critical group's error handling (turning a failed
    // turn into a silently thin prompt).
    const repos = await import('../../src/db/repositories.js');

    const criticalBoom = vi
      .spyOn(repos.factsRepo, 'listMentionableForScopes')
      .mockRejectedValue(new Error('facts exploded'));
    await expect(runTurn('C', ['ent-c'])).rejects.toThrow('facts exploded');
    criticalBoom.mockRestore();

    const optionalBoom = vi
      .spyOn(repos.memoryEntryRepo, 'findRelevant')
      .mockRejectedValue(new Error('memories exploded'));
    const snapshot = (await runTurn('D', ['ent-d'])) as {
      degraded_sections: string[];
      memories: { status: string };
      hints: { status: string };
    };
    optionalBoom.mockRestore();

    expect(snapshot.degraded_sections).toEqual(['memories']);
    expect(snapshot.memories.status).toBe('degraded');
    // …and its neighbours in the same group still loaded, so a rejection did
    // not take the gate's permits down with it.
    expect(snapshot.hints.status).toBe('empty');
  }, 30_000);

  it('a permit is released even when the read rejects (no gate leak)', async () => {
    // If `finally` ever stopped releasing, the second turn below would deadlock
    // rather than fail — a leak is a much worse bug than the one it guards, and
    // it is silent until production runs out of permits.
    const repos = await import('../../src/db/repositories.js');
    const boom = vi
      .spyOn(repos.rulesRepo, 'listActive')
      .mockRejectedValue(new Error('rules exploded'));
    await expect(runTurn('E', ['ent-e'])).rejects.toThrow('rules exploded');
    boom.mockRestore();

    // A completely normal turn afterwards still reaches every read.
    await runTurn('F', ['ent-f']);
    expect(h.reads['F']).toBe(11);
  }, 30_000);
});
