/**
 * #318 migration-window fix — versioned payload_hash + legacy-aware collision.
 *
 * THE BUG THIS GUARDS AGAINST
 * ---------------------------
 * #318 changed the BYTES `computePayloadHash` emits (per-segment
 * `encodeURIComponent` before the `'|'` join) to defeat a delimiter-aliasing
 * collision. Idempotency rows written BEFORE that build deploys store an
 * OLD-format hash. The #299/#301 revalidation in `idempotencyRepo.tryReserve`
 * and `idempotencyRepo.waitForCompletion` compares the freshly computed
 * (new-format) hash against the stored value; against a legacy row it would
 * NEVER match, so a legit idempotent retry would be mis-reported as a
 * `collision` (fail-closed typed error) for the row's whole remaining TTL —
 * breaking real retries across the deploy window.
 *
 * THE FIX
 * -------
 * `computePayloadHash` now tags its output with `PAYLOAD_HASH_VERSION_PREFIX`
 * (`v2:`). The repo's comparison (`isRealPayloadHashCollision`) only raises a
 * collision when the STORED hash is ALSO `v2:`-prefixed AND differs. A legacy
 * (unprefixed) stored hash is treated as a hit / wait-resolve (pre-#318
 * behavior); two distinct `v2:` hashes still collide (the #299/#301 contract).
 *
 * WHAT THIS SPEC PROVES
 * ---------------------
 *   1. tryReserve('completed' row, LEGACY stored hash)   → HIT (no collision)
 *   2. tryReserve('completed' row, two distinct v2:)     → collision
 *   3. waitForCompletion('completed', LEGACY stored hash)→ completed (no collision)
 *   4. waitForCompletion('completed', two distinct v2:)  → collision
 *
 * Pure unit — `@/db/client.js` is mocked so we feed the repo arbitrary stored
 * rows. Mirrors the mock style of `idempotency-payload-hash.spec.ts`. Tenant
 * isolation is unaffected (the repo scopes by `(tenant_id, agent_id, key)` in
 * its WHERE clause); these tests run inside a fixed tenant context.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  computePayloadHash,
  PAYLOAD_HASH_VERSION_PREFIX,
} from '@/governance/idempotency.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

const TEST_CTX = { tenant_id: 'test-tenant', agent_id: 'test-agent' };

const recorder = {
  // Rows the next `.select(...).from(...).where(...).limit(1)` resolves to.
  selectRows: [] as Array<Record<string, unknown>>,
  // Rows the next `db.execute(...)` resolves to (the ON CONFLICT INSERT probe).
  executeRows: [] as Array<Record<string, unknown>>,
};

vi.mock('@/db/client.js', () => {
  const fakeDb = {
    // tryReserve's INSERT … ON CONFLICT DO NOTHING RETURNING probe.
    execute: vi.fn(async () => ({ rows: recorder.executeRows })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => recorder.selectRows),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(async () => ({ rowCount: 1 })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => []),
      })),
    })),
  };
  return {
    db: fakeDb,
    withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb)),
  };
});

const warnSpy = vi.fn();
vi.mock('@/lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
    error: vi.fn(),
  },
}));

const incCounterSpy = vi.fn();
vi.mock('@/lib/metrics.js', () => ({
  incCounter: (...args: unknown[]) => incCounterSpy(...args),
  observeHistogram: vi.fn(),
  setGaugeProvider: vi.fn(),
  renderPrometheus: vi.fn(),
  _resetForTests: vi.fn(),
}));

// Import the repo AFTER the mocks so the resolver picks up the fakes.
import { idempotencyRepo } from '@/db/repositories.js';

const COLLISION_METRIC = 'maia_idempotency_payload_hash_collision_total';

const baseFingerprint = {
  pessoa_id: 'p1',
  entity_id: 'e1',
  tool_name: 'register_transaction',
  operation_type: 'create',
  payload: { valor: 50, descricao: 'Mercado', data_competencia: '2026-04-28' },
};

/**
 * A LEGACY (pre-#318) payload_hash: a bare 64-hex sha256 with NO version
 * prefix. We strip the prefix off a current hash so the value is a realistic
 * stand-in for what an old build wrote to the row.
 */
function legacyHashOf(input: typeof baseFingerprint): string {
  const current = computePayloadHash(input);
  expect(current.startsWith(PAYLOAD_HASH_VERSION_PREFIX)).toBe(true);
  return current.slice(PAYLOAD_HASH_VERSION_PREFIX.length);
}

beforeEach(() => {
  vi.clearAllMocks();
  recorder.selectRows = [];
  recorder.executeRows = [];
  warnSpy.mockReset();
  incCounterSpy.mockReset();
});

describe('tryReserve — legacy payload_hash does NOT trigger a false collision (#318)', () => {
  // Force tryReserve down the ON CONFLICT path: was_inserted=false means a row
  // already exists, so the repo SELECTs it and runs the collision comparison.
  const conflict = [{ was_inserted: false, state: 'completed', resultado: null }];

  it('returns the cached result for a COMPLETED row whose stored hash is LEGACY (no v2: prefix)', async () => {
    const storedLegacy = legacyHashOf(baseFingerprint);
    const requested = computePayloadHash(baseFingerprint); // current-format (v2:)
    expect(requested.startsWith(PAYLOAD_HASH_VERSION_PREFIX)).toBe(true);
    expect(storedLegacy.startsWith(PAYLOAD_HASH_VERSION_PREFIX)).toBe(false);

    recorder.executeRows = conflict;
    recorder.selectRows = [
      {
        state: 'completed',
        resultado: { ok: true, transaction_id: 'tx-legacy' },
        expires_at: null,
        payload_hash: storedLegacy,
      },
    ];

    const result = await runWithTenantContext(TEST_CTX, async () =>
      idempotencyRepo.tryReserve({
        key: 'KEY1',
        tool_name: baseFingerprint.tool_name,
        operation_type: baseFingerprint.operation_type,
        pessoa_id: baseFingerprint.pessoa_id,
        entity_id: baseFingerprint.entity_id,
        payload_hash: requested,
        ttl_seconds: 60,
      }),
    );

    // The crux: a legit retry during the deploy window is a HIT, not a
    // spurious collision.
    expect(result.state).toBe('completed');
    expect(result.resultado).toEqual({ ok: true, transaction_id: 'tx-legacy' });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(incCounterSpy).not.toHaveBeenCalledWith(COLLISION_METRIC);
  });

  it('STILL collides for a COMPLETED row when two distinct v2: hashes differ', async () => {
    const stored = computePayloadHash(baseFingerprint); // v2:
    const requested = computePayloadHash({
      ...baseFingerprint,
      payload: { ...baseFingerprint.payload, valor: 51 },
    }); // v2:, different content
    expect(stored).not.toBe(requested);
    expect(stored.startsWith(PAYLOAD_HASH_VERSION_PREFIX)).toBe(true);
    expect(requested.startsWith(PAYLOAD_HASH_VERSION_PREFIX)).toBe(true);

    recorder.executeRows = conflict;
    recorder.selectRows = [
      {
        state: 'completed',
        resultado: { ok: true, transaction_id: 'tx-foreign' },
        expires_at: null,
        payload_hash: stored,
      },
    ];

    const result = await runWithTenantContext(TEST_CTX, async () =>
      idempotencyRepo.tryReserve({
        key: 'KEY1',
        tool_name: baseFingerprint.tool_name,
        operation_type: baseFingerprint.operation_type,
        pessoa_id: baseFingerprint.pessoa_id,
        entity_id: baseFingerprint.entity_id,
        payload_hash: requested,
        ttl_seconds: 60,
      }),
    );

    // Fail closed — never expose the foreign result.
    expect(result.state).toBe('collision');
    expect(result.resultado).toBeUndefined();
    expect(incCounterSpy).toHaveBeenCalledWith(COLLISION_METRIC);
  });
});

describe('waitForCompletion — legacy payload_hash does NOT trigger a false collision (#318)', () => {
  it('adopts the owner result for a COMPLETED row whose stored hash is LEGACY (no v2: prefix)', async () => {
    const storedLegacy = legacyHashOf(baseFingerprint);
    const expected = computePayloadHash(baseFingerprint); // current-format (v2:)

    recorder.selectRows = [
      {
        state: 'completed',
        resultado: { ok: true, from: 'owner-legacy' },
        payload_hash: storedLegacy,
      },
    ];

    const result = await runWithTenantContext(TEST_CTX, async () =>
      idempotencyRepo.waitForCompletion('KEY1', 1000, expected),
    );

    expect(result.status).toBe('completed');
    expect(result).toMatchObject({ resultado: { ok: true, from: 'owner-legacy' } });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(incCounterSpy).not.toHaveBeenCalledWith(COLLISION_METRIC);
  });

  it('STILL reports collision when the owner settled a distinct v2: payload', async () => {
    const stored = computePayloadHash(baseFingerprint); // v2:
    const expected = computePayloadHash({
      ...baseFingerprint,
      payload: { ...baseFingerprint.payload, valor: 51 },
    }); // v2:, different
    expect(stored).not.toBe(expected);

    recorder.selectRows = [
      {
        state: 'completed',
        resultado: { ok: true, from: 'owner-foreign' },
        payload_hash: stored,
      },
    ];

    const result = await runWithTenantContext(TEST_CTX, async () =>
      idempotencyRepo.waitForCompletion('KEY1', 1000, expected),
    );

    expect(result.status).toBe('collision');
    expect(incCounterSpy).toHaveBeenCalledWith(COLLISION_METRIC);
  });
});
