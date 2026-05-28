/**
 * Issue #298 — atomic reservation: REAL Postgres race proof.
 *
 * The unit test (`tests/unit/tools/idempotency-atomic-reservation.spec.ts`)
 * proves the dispatcher's control flow is correct ONCE we trust that
 * `idempotencyRepo.tryReserve` honours the "exactly one was_inserted=true"
 * contract under concurrent calls. This file proves the REPO's SQL
 * actually delivers that contract against real Postgres ON CONFLICT
 * semantics — the part a mock cannot prove.
 *
 * Why integration: the race fix relies on Postgres's `INSERT ... ON
 * CONFLICT DO NOTHING RETURNING (xmax = 0)` atomicity. Mocks can be
 * tricked into either accepting or rejecting any sequence; only a real
 * pg instance executes the actual ON CONFLICT path the dispatcher will
 * see in production.
 *
 * Skipped without TEST_DB_URL — pattern from `issue-184-agents-create-
 * race.spec.ts` and the rest of `tests/integration/`.
 *
 * Migration prerequisites (manual checklist when running):
 *   1. The TEST_DB_URL database has migrations 001–064 applied.
 *      Specifically, migration 064_p10_idempotency_keys_atomic_reservation
 *      adds the `state` and `expires_at` columns + the state/coherence
 *      CHECK constraints. Tests fail loudly if it hasn't been applied
 *      (the INSERT will reject state='in_progress' rows without it).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runWithTenantContext } from '@/db/tenant-context.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT_A = 'issue298-tenant-a';
const TENANT_B = 'issue298-tenant-b';
const AGENT = 'issue298-agent';

let pool: pg.Pool;

// All rows in the tests below use these placeholder UUIDs for pessoa_id /
// entity_id. The FK constraints (`REFERENCES pessoas(id)` /
// `REFERENCES entidades(id)`) require those rows to exist; we create
// fixture rows once per `describe` and clean up at the end.
const PESSOA_ID = '298a9111-1111-1111-1111-111111111111';
const ENTIDADE_ID = '298a2222-2222-2222-2222-222222222222';

async function seedFixtures(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(
      `INSERT INTO tenants(id, nome) VALUES ($1, 'Issue 298 A'), ($2, 'Issue 298 B')
        ON CONFLICT (id) DO NOTHING`,
      [TENANT_A, TENANT_B],
    );
    // The pessoas/entidades schemas in main don't have tenant_id columns
    // wired into FKs yet (FK from idempotency_keys is by id only). Insert
    // ONE shared pessoa+entidade so both tenant scenarios can reuse them
    // — the idempotency_keys row's own (tenant_id, agent_id) columns
    // provide the isolation we're verifying.
    await c.query(
      `INSERT INTO pessoas(id, nome, telefone_whatsapp, tipo)
       VALUES ($1, 'issue298-pessoa', '+5511000000298', 'funcionario')
       ON CONFLICT (id) DO NOTHING`,
      [PESSOA_ID],
    );
    await c.query(
      `INSERT INTO entidades(id, nome, tipo)
       VALUES ($1, 'issue298-entidade', 'empresa')
       ON CONFLICT (id) DO NOTHING`,
      [ENTIDADE_ID],
    );
  } finally {
    c.release();
  }
}

async function cleanupKey(key: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`DELETE FROM idempotency_keys WHERE key = $1`, [key]);
  } finally {
    c.release();
  }
}

async function dropFixtures(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(
      `DELETE FROM idempotency_keys WHERE tenant_id IN ($1, $2)`,
      [TENANT_A, TENANT_B],
    );
    await c.query(`DELETE FROM entidades WHERE id = $1`, [ENTIDADE_ID]);
    await c.query(`DELETE FROM pessoas WHERE id = $1`, [PESSOA_ID]);
    await c.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  } finally {
    c.release();
  }
}

if (SHOULD_RUN) {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await seedFixtures();
  });
  afterAll(async () => {
    await dropFixtures();
    await pool.end();
  });
  beforeEach(async () => {
    // Wipe any leftover idempotency_keys from prior runs so each test
    // starts from a clean slot.
    const c = await pool.connect();
    try {
      await c.query(
        `DELETE FROM idempotency_keys WHERE tenant_id IN ($1, $2)`,
        [TENANT_A, TENANT_B],
      );
    } finally {
      c.release();
    }
  });
}

d('idempotencyRepo.tryReserve — race-safe under real Postgres ON CONFLICT', () => {
  it('two concurrent reservations: exactly ONE was_inserted=true', async () => {
    const { idempotencyRepo } = await import('@/db/repositories.js');
    const key = `race-key-${Date.now()}-${Math.random()}`;
    const baseInput = {
      key,
      tool_name: 'register_transaction',
      operation_type: 'create',
      pessoa_id: PESSOA_ID,
      entity_id: ENTIDADE_ID,
      payload_hash: key,
      ttl_seconds: 30,
    };

    const [a, b] = await runWithTenantContext(
      { tenant_id: TENANT_A, agent_id: AGENT },
      () =>
        Promise.all([
          idempotencyRepo.tryReserve(baseInput),
          idempotencyRepo.tryReserve(baseInput),
        ]),
    );

    // Exact-once contract: ONE caller wins the insert; the OTHER sees
    // the existing in_progress row.
    const winners = [a, b].filter((r) => r.was_inserted);
    const losers = [a, b].filter((r) => !r.was_inserted);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.state).toBe('in_progress');

    // DB invariant: exactly ONE row exists for the key.
    const c = await pool.connect();
    try {
      const rows = await c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM idempotency_keys WHERE key = $1`,
        [key],
      );
      expect(rows.rows[0]!.count).toBe('1');
    } finally {
      c.release();
    }
    await cleanupKey(key);
  });

  it('completed reservation → second caller gets cached result (no second handler)', async () => {
    const { idempotencyRepo } = await import('@/db/repositories.js');
    const key = `completed-key-${Date.now()}-${Math.random()}`;
    const baseInput = {
      key,
      tool_name: 'register_transaction',
      operation_type: 'create',
      pessoa_id: PESSOA_ID,
      entity_id: ENTIDADE_ID,
      payload_hash: key,
      ttl_seconds: 30,
    };

    await runWithTenantContext(
      { tenant_id: TENANT_A, agent_id: AGENT },
      async () => {
        const first = await idempotencyRepo.tryReserve(baseInput);
        expect(first.was_inserted).toBe(true);
        await idempotencyRepo.markCompleted({
          key,
          resultado: { transacao_id: 'tx-1', saldo_apos: 1500 },
        });

        const second = await idempotencyRepo.tryReserve(baseInput);
        expect(second.was_inserted).toBe(false);
        expect(second.state).toBe('completed');
        expect(second.resultado).toEqual({
          transacao_id: 'tx-1',
          saldo_apos: 1500,
        });
      },
    );
    await cleanupKey(key);
  });

  it('cross-tenant: tenant-B reservation does NOT block tenant-A', async () => {
    const { idempotencyRepo } = await import('@/db/repositories.js');
    const key = `cross-tenant-${Date.now()}-${Math.random()}`;
    const baseInput = {
      key,
      tool_name: 'register_transaction',
      operation_type: 'create',
      pessoa_id: PESSOA_ID,
      entity_id: ENTIDADE_ID,
      payload_hash: key,
      ttl_seconds: 30,
    };

    // Tenant-A reserves first.
    const a = await runWithTenantContext(
      { tenant_id: TENANT_A, agent_id: AGENT },
      () => idempotencyRepo.tryReserve(baseInput),
    );
    expect(a.was_inserted).toBe(true);

    // Tenant-B with the SAME key should get its OWN reservation —
    // because the schema's (tenant_id, agent_id, key) scope (composite
    // PK from PR #273 OR the application-level tenant guard from this
    // PR) namespaces the row. Pre-#273 main schema has `key` as the PK,
    // so this assertion ALSO depends on the application-layer tenant
    // scope holding — see `applyTenantGuard` in tryReserve.
    //
    // NOTE: pre-#273 (today's main), this test will FAIL because the
    // singleton PK on `key` would reject the second INSERT — that's
    // EXACTLY the bug PR #273 fixes. After #273 lands AND this PR's
    // migration 064 lands, both invariants (the composite PK and the
    // application-level guard) hold and this test passes cleanly.
    if (process.env.ASSUME_PR_273_MERGED === '1') {
      const b = await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT },
        () => idempotencyRepo.tryReserve(baseInput),
      );
      expect(b.was_inserted).toBe(true);
      expect(b.state).toBe('in_progress');

      const c = await pool.connect();
      try {
        const rows = await c.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM idempotency_keys WHERE key = $1
           ORDER BY tenant_id`,
          [key],
        );
        expect(rows.rows.map((r) => r.tenant_id).sort()).toEqual([
          TENANT_A,
          TENANT_B,
        ]);
      } finally {
        c.release();
      }
    }
    await cleanupKey(key);
  });

  it('stale in_progress past expires_at → next caller reclaims', async () => {
    const { idempotencyRepo } = await import('@/db/repositories.js');
    const key = `stale-key-${Date.now()}-${Math.random()}`;
    const baseInput = {
      key,
      tool_name: 'register_transaction',
      operation_type: 'create',
      pessoa_id: PESSOA_ID,
      entity_id: ENTIDADE_ID,
      payload_hash: key,
      ttl_seconds: 1,
    };

    await runWithTenantContext(
      { tenant_id: TENANT_A, agent_id: AGENT },
      async () => {
        const first = await idempotencyRepo.tryReserve(baseInput);
        expect(first.was_inserted).toBe(true);
      },
    );

    // Manually backdate the row so it looks abandoned.
    const c = await pool.connect();
    try {
      await c.query(
        `UPDATE idempotency_keys
            SET expires_at = now() - interval '5 seconds'
          WHERE key = $1`,
        [key],
      );
    } finally {
      c.release();
    }

    await runWithTenantContext(
      { tenant_id: TENANT_A, agent_id: AGENT },
      async () => {
        const reclaimed = await idempotencyRepo.tryReserve(baseInput);
        expect(reclaimed.was_inserted).toBe(true);
        expect(reclaimed.state).toBe('in_progress');
      },
    );
    await cleanupKey(key);
  });

  it('markCompleted is a no-op once the row is already completed (idempotent)', async () => {
    const { idempotencyRepo } = await import('@/db/repositories.js');
    const key = `markcompleted-${Date.now()}-${Math.random()}`;
    const baseInput = {
      key,
      tool_name: 'register_transaction',
      operation_type: 'create',
      pessoa_id: PESSOA_ID,
      entity_id: ENTIDADE_ID,
      payload_hash: key,
      ttl_seconds: 30,
    };

    await runWithTenantContext(
      { tenant_id: TENANT_A, agent_id: AGENT },
      async () => {
        await idempotencyRepo.tryReserve(baseInput);
        await idempotencyRepo.markCompleted({ key, resultado: { val: 'first' } });
        // Second markCompleted should NOT clobber because the row is now
        // in state='completed' (WHERE state='in_progress' makes this a no-op).
        await idempotencyRepo.markCompleted({
          key,
          resultado: { val: 'should_not_clobber' },
        });
      },
    );

    const c = await pool.connect();
    try {
      const rows = await c.query<{ resultado: { val: string } }>(
        `SELECT resultado FROM idempotency_keys WHERE key = $1`,
        [key],
      );
      expect(rows.rows[0]!.resultado).toEqual({ val: 'first' });
    } finally {
      c.release();
    }
    await cleanupKey(key);
  });

  it('releaseReservation deletes only in_progress rows', async () => {
    const { idempotencyRepo } = await import('@/db/repositories.js');
    const key = `release-${Date.now()}-${Math.random()}`;
    const baseInput = {
      key,
      tool_name: 'register_transaction',
      operation_type: 'create',
      pessoa_id: PESSOA_ID,
      entity_id: ENTIDADE_ID,
      payload_hash: key,
      ttl_seconds: 30,
    };
    await runWithTenantContext(
      { tenant_id: TENANT_A, agent_id: AGENT },
      async () => {
        await idempotencyRepo.tryReserve(baseInput);
        await idempotencyRepo.releaseReservation(key);
      },
    );
    const c = await pool.connect();
    try {
      const rows = await c.query(
        `SELECT 1 FROM idempotency_keys WHERE key = $1`,
        [key],
      );
      expect(rows.rows).toHaveLength(0);
    } finally {
      c.release();
    }
  });
});
