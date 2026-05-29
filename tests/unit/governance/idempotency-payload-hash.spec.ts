/**
 * #299 — idempotencyRepo.lookup revalidates payload_hash on cache hit.
 *
 * Setup mocks `@/db/client.js`'s `db.select(...)` chain so we can feed
 * arbitrary rows to the lookup and assert exactly what the repo does:
 *   - hit + matching payload_hash → return resultado
 *   - hit + DIFFERENT payload_hash → treat as miss, log warn, bump counter
 *   - miss (no row)               → return null
 *
 * Pure unit — no real DB. The integration with #273 (tenant/agent scoping)
 * is intentionally NOT covered here; #273 owns that test surface.
 *
 * NOTE on tenant context: #273 made `lookup` resolve `tenant_id`/`agent_id`
 * from ALS via `getCurrentTenant`/`getCurrentAgent`, which throws outside
 * `runWithTenantContext`. To keep this spec focused on the payload-hash
 * behavior, every lookup is wrapped in a fixed tenant context.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computePayloadHash } from '@/governance/idempotency.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

const TEST_CTX = { tenant_id: 'test-tenant', agent_id: 'test-agent' };

const recorder = {
  // What the next .limit(1) returns.
  returnedRows: [] as Array<Record<string, unknown>>,
};

vi.mock('@/db/client.js', () => {
  const fakeDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => recorder.returnedRows),
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

// Defer importing the repo until after the mocks so the resolver picks up
// the fakes.
import { idempotencyRepo } from '@/db/repositories.js';

beforeEach(() => {
  vi.clearAllMocks();
  recorder.returnedRows = [];
  warnSpy.mockReset();
  incCounterSpy.mockReset();
});

describe('idempotencyRepo.lookup — payload_hash revalidation (#299)', () => {
  const baseInput = {
    pessoa_id: 'p1',
    entity_id: 'e1',
    tool_name: 'register_transaction',
    operation_type: 'create',
    payload: { valor: 50, descricao: 'Mercado', data_competencia: '2026-04-28' },
  };

  it('returns resultado when key matches and payload_hash matches', async () => {
    const payload_hash = computePayloadHash(baseInput);
    const cached = { ok: true, transaction_id: 'tx1' };
    recorder.returnedRows = [
      {
        key: 'KEY1',
        tool_name: 'register_transaction',
        payload_hash,
        resultado: cached,
      },
    ];

    const result = await runWithTenantContext(TEST_CTX, async () =>
      idempotencyRepo.lookup({ key: 'KEY1', payload_hash }),
    );

    expect(result).toEqual(cached);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(incCounterSpy).not.toHaveBeenCalled();
  });

  it('returns null + warns + increments collision metric when payload_hash differs', async () => {
    const storedHash = computePayloadHash(baseInput);
    const requestedHash = computePayloadHash({
      ...baseInput,
      payload: { ...baseInput.payload, valor: 51 },
    });
    expect(storedHash).not.toBe(requestedHash);

    recorder.returnedRows = [
      {
        key: 'KEY1',
        tool_name: 'register_transaction',
        payload_hash: storedHash,
        resultado: { ok: true, transaction_id: 'tx-old' },
      },
    ];

    const result = await runWithTenantContext(TEST_CTX, async () =>
      idempotencyRepo.lookup({
        key: 'KEY1',
        payload_hash: requestedHash,
      }),
    );

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [logObj, msg] = warnSpy.mock.calls[0]!;
    expect(msg).toBe('idempotency.payload_hash_mismatch');
    expect(logObj).toMatchObject({
      event: 'idempotency_key_collision_payload_mismatch',
      key: 'KEY1',
      stored_payload_hash: storedHash,
      expected_payload_hash: requestedHash,
      stored_tool_name: 'register_transaction',
    });
    expect(incCounterSpy).toHaveBeenCalledWith(
      'maia_idempotency_payload_hash_collision_total',
    );
  });

  it('returns null when no row exists (real miss, no warn/metric)', async () => {
    recorder.returnedRows = [];
    const payload_hash = computePayloadHash(baseInput);

    const result = await runWithTenantContext(TEST_CTX, async () =>
      idempotencyRepo.lookup({ key: 'KEY1', payload_hash }),
    );

    expect(result).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(incCounterSpy).not.toHaveBeenCalled();
  });

  it('preserves isolation: a cross-tenant request that happens to compute the same key but a different payload_hash is treated as miss', async () => {
    // Simulate the row stored by tenant A (the legacy lookup didn't filter by
    // tenant — #273 fixes that; #299 catches the same class of bug at the
    // payload layer). Tenant B asks for the same key but its inputs hash
    // differently → must be treated as miss.
    const tenantA_payloadHash = computePayloadHash({
      ...baseInput,
      pessoa_id: 'pessoa-tenant-A',
    });
    const tenantB_payloadHash = computePayloadHash({
      ...baseInput,
      pessoa_id: 'pessoa-tenant-B',
    });
    expect(tenantA_payloadHash).not.toBe(tenantB_payloadHash);

    recorder.returnedRows = [
      {
        key: 'COLLIDING_KEY',
        tool_name: 'register_transaction',
        payload_hash: tenantA_payloadHash,
        resultado: { from: 'tenant-A' },
      },
    ];

    const result = await runWithTenantContext(TEST_CTX, async () =>
      idempotencyRepo.lookup({
        key: 'COLLIDING_KEY',
        payload_hash: tenantB_payloadHash,
      }),
    );

    expect(result).toBeNull();
    expect(incCounterSpy).toHaveBeenCalledWith(
      'maia_idempotency_payload_hash_collision_total',
    );
  });

  it('lookup signature requires payload_hash (compile-time guarantee)', async () => {
    // This test is here to lock the public type — if a future refactor
    // accidentally widens the signature back to accepting a bare key, the
    // following expression will fail to compile under `tsc --noEmit`.
    // (Compile-time check; runtime executes the happy path.)
    const payload_hash = computePayloadHash(baseInput);
    recorder.returnedRows = [
      { key: 'K', tool_name: 't', payload_hash, resultado: { ok: true } },
    ];
    await runWithTenantContext(TEST_CTX, async () =>
      // @ts-expect-error — payload_hash is required.
      idempotencyRepo.lookup({ key: 'K' }).catch(() => undefined),
    );
    // Happy path keeps the test green and exercises the proper signature.
    const ok = await runWithTenantContext(TEST_CTX, async () =>
      idempotencyRepo.lookup({ key: 'K', payload_hash }),
    );
    expect(ok).toEqual({ ok: true });
  });
});

describe('computePayloadHash — invariants (#299)', () => {
  const base = {
    pessoa_id: 'p1',
    entity_id: 'e1',
    tool_name: 'register_transaction',
    operation_type: 'create',
    payload: { valor: 50, descricao: 'Mercado', data_competencia: '2026-04-28' },
  };

  it('stable across runs for the same canonical payload', () => {
    const h1 = computePayloadHash(base);
    const h2 = computePayloadHash(base);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('insensitive to descricao case/accents (delegates to normalizePayload)', () => {
    const h1 = computePayloadHash(base);
    const h2 = computePayloadHash({
      ...base,
      payload: { ...base.payload, descricao: 'mercado' },
    });
    expect(h1).toBe(h2);
  });

  it('sensitive to valor changes', () => {
    const h1 = computePayloadHash(base);
    const h2 = computePayloadHash({
      ...base,
      payload: { ...base.payload, valor: 51 },
    });
    expect(h1).not.toBe(h2);
  });

  it('INDEPENDENT of timestamp/bucket (so revalidation matches across buckets)', async () => {
    // computeIdempotencyKey bakes in bucketMinutes, computePayloadHash MUST NOT.
    // Otherwise two requests in different buckets with the same content would
    // produce different payload_hashes and a legit hit would be miscategorized.
    //
    // #273: computeIdempotencyKey now folds tenant_id+agent_id into the hash
    // and rejects without an active tenant context — wrap in
    // runWithTenantContext for the bucket comparison.
    const { computeIdempotencyKey } = await import('@/governance/idempotency.js');
    const t1 = new Date('2026-04-28T14:32:00Z');
    const t2 = new Date('2026-04-28T15:32:00Z');
    const key1 = await runWithTenantContext(TEST_CTX, async () =>
      computeIdempotencyKey({ ...base, timestamp: t1 }),
    );
    const key2 = await runWithTenantContext(TEST_CTX, async () =>
      computeIdempotencyKey({ ...base, timestamp: t2 }),
    );
    expect(key1).not.toBe(key2); // keys differ across buckets…
    const ph1 = computePayloadHash(base);
    const ph2 = computePayloadHash(base);
    expect(ph1).toBe(ph2); // …but payload_hash is stable.
  });

  it('file_sha256 path ignores payload (file IS the fingerprint)', () => {
    const h1 = computePayloadHash({
      ...base,
      file_sha256: 'aaa',
      payload: { something: 'A' },
    });
    const h2 = computePayloadHash({
      ...base,
      file_sha256: 'aaa',
      payload: { something: 'B' },
    });
    expect(h1).toBe(h2);
    const h3 = computePayloadHash({
      ...base,
      file_sha256: 'bbb',
      payload: { something: 'A' },
    });
    expect(h1).not.toBe(h3);
  });
});
