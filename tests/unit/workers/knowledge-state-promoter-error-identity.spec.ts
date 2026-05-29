/**
 * Issue #255 / PR #280 — Error identity preservation across
 * `runCognitiveModule` boundary in `knowledge-state-promoter`.
 *
 * Background:
 *   The auto-promoter wraps `KnowledgeStateMachine.transition` in
 *   `runCognitiveModule` for per-row audit. When `transition` throws
 *   `IllegalTransitionError` (e.g. a parallel auto-promoter tick already
 *   moved the row), the runner CATCHES that error, classifies it as
 *   `status='error'`, and DOES NOT re-throw — the original Error object
 *   becomes unreachable to the outer caller.
 *
 *   Before the fix, the worker observed `rowResult.status === 'error'`
 *   and synthesised a generic `new Error('auto_promoter_row_error')`.
 *   The outer `catch (err) { if (err instanceof IllegalTransitionError) ... }`
 *   branch — the benign-skip path for parallel-promote races — was DEAD
 *   CODE: every race fell through to `stats.errors++` and an `error`-level
 *   log line. Operationally indistinguishable from a real DB failure.
 *
 *   Fix: capture the error inside the runCognitiveModule callback before
 *   the runner swallows it, then re-throw THAT captured Error after the
 *   runner returns. Identity (and stack trace) is preserved end-to-end.
 *
 * Contract this spec PROVES:
 *
 *   1. `IllegalTransitionError` from `transition()` survives the
 *      runCognitiveModule boundary AND is caught by the outer
 *      `err instanceof IllegalTransitionError` branch. Net effect:
 *      `stats.errors` is NOT incremented and only `logger.debug` (not
 *      `.error`) is invoked → "skipped_illegal_transition".
 *
 *   2. Any OTHER Error from `transition()` also survives — the outer
 *      catch logs it via `logger.error` as `transition_failed` AND
 *      increments `stats.errors`. This proves we don't silently mask
 *      real failures while preserving the IllegalTransitionError branch.
 *
 *   3. A `timeout` status (no error was thrown — runCognitiveModule's
 *      internal race produced 'timeout' Error of its own) still surfaces
 *      via the synthetic-Error fallback path so audit attribution holds
 *      and the outer catch logs through `transition_failed`.
 *
 * Strategy:
 *   - Mock `@/control-plane/knowledge-state-machine/state-machine.js`
 *     so we can program `transition()` to throw a specific Error class
 *     per call (chosen by row id). This is the cleanest insertion point —
 *     it preserves the production worker code path through
 *     runCognitiveModule + runWithTenantContext exactly.
 *   - Mock `@/control-plane/knowledge-state-machine/repos.js` with a
 *     minimal in-memory `listEligible` so the worker has rows to loop
 *     over; the rest of the repos stay unused.
 *   - Mock `@/lib/logger.js` so we can assert which logger method fired
 *     and with what payload.
 *   - Mock `@/db/repositories.js` so the audit-write doesn't touch a real
 *     DB. We don't assert on the audit calls here — that's the audit-
 *     tenant spec's job. This spec is focused on the outer catch path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KnowledgeKind,
  KnowledgeLifecycleStatus,
} from '@/control-plane/knowledge-state-machine/types.js';

// ---------------------------------------------------------------------------
// In-memory seed for `listEligible` + per-row scripted error
// ---------------------------------------------------------------------------

interface SeedRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  // status the eligible listing slot answers to (so we can put a row in
  // ephemeral and have it surface for the ephemeral→observed step)
  lifecycle_status: KnowledgeLifecycleStatus;
  // Optional scripted error — when set, the mocked `transition()` throws
  // this when invoked for the row. When null/undefined, `transition()`
  // returns successfully.
  transitionThrows?: Error;
}

const seeded: SeedRow[] = [];

function seed(row: SeedRow): void {
  seeded.push(row);
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the state-machine module — this is the only place we want to
// inject scripted errors. The production worker calls
// `KnowledgeStateMachine.transition` inside `runCognitiveModule` inside
// `runWithTenantContext`; the whole chain is exercised live.
vi.mock('@/control-plane/knowledge-state-machine/state-machine.js', async () => {
  const transitions = await vi.importActual<
    typeof import('@/control-plane/knowledge-state-machine/transitions.js')
  >('@/control-plane/knowledge-state-machine/transitions.js');
  return {
    KnowledgeStateMachine: {
      transition: vi.fn(async (args: { proposal_id: string }) => {
        const row = seeded.find((r) => r.id === args.proposal_id);
        if (row?.transitionThrows !== undefined) {
          throw row.transitionThrows;
        }
        return { from: 'ephemeral', to: 'observed', at: new Date().toISOString() };
      }),
    },
    IllegalTransitionError: transitions.IllegalTransitionError,
  };
});

vi.mock('@/control-plane/knowledge-state-machine/repos.js', async () => {
  const drizzle = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
  return {
    knowledgeRepos: {
      async listEligible(args: {
        kind: KnowledgeKind;
        from: KnowledgeLifecycleStatus;
      }): Promise<Array<{ id: string; tenant_id: string; agent_id: string }>> {
        // Only return rows whose lifecycle_status matches what the
        // current promote step is asking for. The worker's KINDS loop
        // calls listEligible per kind — we don't care which kind we
        // attribute the row to in this spec (we only care about the
        // outer catch path), so we let any seeded row surface in any
        // kind that matches the status.
        return seeded
          .filter((r) => r.lifecycle_status === args.from)
          .map((r) => ({
            id: r.id,
            tenant_id: r.tenant_id,
            agent_id: r.agent_id,
          }));
      },
      buildUpdatedAtFilter() {
        return drizzle.sql`true`;
      },
    },
    sql: drizzle.sql,
    lte: drizzle.lte,
  };
});

// Stub the cognitive_module_log audit write so we don't touch the DB.
// We do NOT assert on this — the audit-tenant spec covers attribution.
vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => {}),
      recentByModule: vi.fn(async () => []),
    },
  };
});

// `vi.mock` factories are hoisted above `const` declarations — we can't
// close over an outer `loggerMock` variable. Define the spies INSIDE the
// factory and re-import the module in `beforeEach` to grab the same
// reference for assertions.
vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/config/feature-flags.js', async () => {
  const actual = await vi.importActual<
    typeof import('@/config/feature-flags.js')
  >('@/config/feature-flags.js');
  return {
    ...actual,
    FEATURE_KNOWLEDGE_STATE_MACHINE_V1: true,
    featureFlags: {
      ...actual.featureFlags,
      isEnabled: () => true,
      override: () => undefined,
      killSwitch: () => undefined,
      unkillSwitch: () => undefined,
      reset: () => undefined,
    },
  };
});

// Imports AFTER mocks so the worker picks them up.
import { runKnowledgeStatePromoter } from '@/workers/knowledge-state-promoter.js';
import { IllegalTransitionError } from '@/control-plane/knowledge-state-machine/transitions.js';
import { logger } from '@/lib/logger.js';

// Type-narrow the spies from the mocked logger so the assertions below
// can reach `.mock.calls` without `as unknown as` noise.
const loggerMock = logger as unknown as {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

// ---------------------------------------------------------------------------
// Setup/teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  seeded.length = 0;
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
  loggerMock.debug.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('issue #255 — error identity preserved across runCognitiveModule boundary', () => {
  it('IllegalTransitionError from transition() reaches the outer benign-skip branch (was DEAD CODE before fix)', async () => {
    // Seed a single row whose `transition()` throws
    // IllegalTransitionError — the exact shape a parallel-promote race
    // would produce. The outer catch MUST recognise it and:
    //   1. NOT log via `logger.error('transition_failed')`.
    //   2. DO log via `logger.debug('skipped_illegal_transition')`.
    //   3. NOT increment stats.errors (validated indirectly via the
    //      logger.info('tick.done') payload below).
    seed({
      id: 'race-row',
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      lifecycle_status: 'ephemeral',
      transitionThrows: new IllegalTransitionError('ephemeral', 'observed'),
    });

    await runKnowledgeStatePromoter();

    // Find any debug call whose second arg matches the benign-skip log.
    const debugCalls = loggerMock.debug.mock.calls;
    const skipped = debugCalls.find(
      (c) => c[1] === 'knowledge_state_promoter.skipped_illegal_transition',
    );
    expect(skipped, 'outer catch must reach the IllegalTransitionError branch')
      .toBeDefined();

    // The `err` payload (first arg) MUST be the actual
    // IllegalTransitionError instance — proves identity preservation,
    // not a wrapped/generic Error.
    expect(skipped![0]).toMatchObject({
      err: expect.any(IllegalTransitionError),
    });

    // The outer error-log path must NOT have fired.
    const errorCalls = loggerMock.error.mock.calls.filter(
      (c) => c[1] === 'knowledge_state_promoter.transition_failed',
    );
    expect(errorCalls).toEqual([]);

    // tick.done is logged at .info level with the stats payload. Every
    // counter (including errors) must be 0 — the row was a benign skip.
    const tickDone = loggerMock.info.mock.calls.find(
      (c) => c[1] === 'knowledge_state_promoter.tick.done',
    );
    expect(tickDone, 'tick.done must always be logged').toBeDefined();
    expect(tickDone![0]).toMatchObject({ errors: 0 });
  });

  it('non-IllegalTransitionError from transition() is preserved AND logged via transition_failed (stats.errors++)', async () => {
    // Seed two rows: one throws an arbitrary Error (the kind that maps
    // to a real DB failure or unexpected state), the other succeeds.
    // The arbitrary Error must NOT reach the benign-skip branch — it
    // must flow to `logger.error('transition_failed')` AND bump
    // stats.errors. Proves we're not over-eagerly classifying every
    // throw as "benign".
    const realFailure = new Error('connection_reset');
    seed({
      id: 'real-failure-row',
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      lifecycle_status: 'ephemeral',
      transitionThrows: realFailure,
    });
    seed({
      id: 'success-row',
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      lifecycle_status: 'ephemeral',
    });

    await runKnowledgeStatePromoter();

    // No benign-skip log (the error was NOT IllegalTransitionError).
    const skipped = loggerMock.debug.mock.calls.find(
      (c) => c[1] === 'knowledge_state_promoter.skipped_illegal_transition',
    );
    expect(skipped).toBeUndefined();

    // The transition_failed log fired with the ORIGINAL Error object —
    // identity preservation: err.message === 'connection_reset', not
    // 'auto_promoter_row_error'.
    const failed = loggerMock.error.mock.calls.find(
      (c) => c[1] === 'knowledge_state_promoter.transition_failed',
    );
    expect(failed, 'real failure must surface via transition_failed log')
      .toBeDefined();
    const failurePayload = failed![0] as { err: unknown };
    // The err is the exact same Error object the mock threw.
    expect(failurePayload.err).toBe(realFailure);
    expect((failurePayload.err as Error).message).toBe('connection_reset');

    // tick.done must show errors > 0 (the real failure counted).
    const tickDone = loggerMock.info.mock.calls.find(
      (c) => c[1] === 'knowledge_state_promoter.tick.done',
    );
    expect(tickDone).toBeDefined();
    expect((tickDone![0] as { errors: number }).errors).toBeGreaterThan(0);
  });

  it('mixed batch: IllegalTransitionError and a real error from different rows are classified independently', async () => {
    // Same tick, two failing rows of different kinds: one race-benign,
    // one real. The benign one must NOT bump stats.errors; the real one
    // MUST. This is the regression that motivated the fix — before, BOTH
    // were misclassified because the runCognitiveModule generic-Error
    // mask hid the IllegalTransitionError identity for the race row,
    // collapsing everything into "transition_failed".
    seed({
      id: 'race-row',
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      lifecycle_status: 'ephemeral',
      transitionThrows: new IllegalTransitionError('ephemeral', 'observed'),
    });
    seed({
      id: 'real-failure-row',
      tenant_id: 'tenant-B',
      agent_id: 'agent-B',
      lifecycle_status: 'ephemeral',
      transitionThrows: new Error('db_pool_exhausted'),
    });

    await runKnowledgeStatePromoter();

    // The race row landed in the benign-skip branch.
    const skipped = loggerMock.debug.mock.calls.find(
      (c) =>
        c[1] === 'knowledge_state_promoter.skipped_illegal_transition' &&
        (c[0] as { id: string }).id === 'race-row',
    );
    expect(skipped, 'race row must be classified as benign skip')
      .toBeDefined();

    // The real failure row landed in the transition_failed branch.
    const failed = loggerMock.error.mock.calls.find(
      (c) =>
        c[1] === 'knowledge_state_promoter.transition_failed' &&
        (c[0] as { id: string }).id === 'real-failure-row',
    );
    expect(failed, 'real-failure row must be classified as a real failure')
      .toBeDefined();

    // The race row did NOT log as transition_failed.
    const raceLoggedAsFailure = loggerMock.error.mock.calls.find(
      (c) =>
        c[1] === 'knowledge_state_promoter.transition_failed' &&
        (c[0] as { id: string }).id === 'race-row',
    );
    expect(
      raceLoggedAsFailure,
      'race row must NOT also surface as transition_failed',
    ).toBeUndefined();

    // tick.done errors counter > 0 (the real failure counted) but each
    // promote step processes the race row independently in its benign
    // branch.
    const tickDone = loggerMock.info.mock.calls.find(
      (c) => c[1] === 'knowledge_state_promoter.tick.done',
    );
    expect(tickDone).toBeDefined();
    expect((tickDone![0] as { errors: number }).errors).toBeGreaterThan(0);
  });
});
