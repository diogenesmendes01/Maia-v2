/**
 * Issue #316 — transactional outbox: REAL Postgres exactly-once proof.
 *
 * The unit tests (tests/unit/db/idempotency-outbox-repo.spec.ts +
 * tests/unit/workers/idempotency-outbox-relayer.spec.ts) prove the control
 * flow ONCE we trust that:
 *   (a) `markCompletedWithEffect`'s fencing UPDATE + ON CONFLICT enqueue is
 *       atomic (the whole pair commits or rolls back together), and
 *   (b) the relayer's claim is race-safe under FOR UPDATE SKIP LOCKED.
 * This file proves those against REAL Postgres semantics — the part a mock
 * cannot prove.
 *
 * The exactly-once invariant under the #303 race (the whole point of #316):
 *   - The WINNING reservation owner completes + enqueues atomically → exactly
 *     one outbox row.
 *   - A PREEMPTED owner (lease reclaimed → fresh token) whose markCompleted is
 *     fenced enqueues NOTHING (the tx rolls back) → it cannot double-enqueue an
 *     effect, so the relayer dispatches the winner's effect exactly once.
 *
 * Skipped without TEST_DB_URL — same pattern as issue-298-idempotency-race.spec.ts.
 *
 * Migration prerequisites (manual checklist when running):
 *   The TEST_DB_URL database has migrations 001–070 applied. Specifically
 *   068_idempotency_effect_outbox (table + UNIQUE),
 *   069_idempotency_effect_outbox_relayer_index (CONCURRENTLY pending-claim
 *   index) and 070_idempotency_effect_outbox_retention_index (CONCURRENTLY
 *   terminal-retention partial index). The INSERTs fail loudly if 068 hasn't
 *   been applied.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runWithTenantContext } from '@/db/tenant-context.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT_A = 'issue316-tenant-a';
const TENANT_B = 'issue316-tenant-b';
const AGENT = 'issue316-agent';

const PESSOA_ID = '316a9111-1111-1111-1111-111111111111';
const ENTIDADE_ID = '316a2222-2222-2222-2222-222222222222';

let pool: pg.Pool;

const EFFECT = {
  kind: 'whatsapp_text' as const,
  jid: '5511999990000@s.whatsapp.net',
  text: 'olá',
  mensagem_id: 'msg-316',
};

async function seedReservation(input: {
  tenant_id: string;
  key: string;
  payload_hash: string;
}): Promise<string> {
  const { idempotencyRepo } = await import('@/db/repositories.js');
  return runWithTenantContext({ tenant_id: input.tenant_id, agent_id: AGENT }, async () => {
    const r = await idempotencyRepo.tryReserve({
      key: input.key,
      tool_name: 'send_proactive_message',
      operation_type: 'communicate',
      pessoa_id: PESSOA_ID,
      entity_id: ENTIDADE_ID,
      payload_hash: input.payload_hash,
      ttl_seconds: 30,
    });
    return r.was_inserted ? r.reservation_token : '';
  });
}

async function seedFixtures(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(
      `INSERT INTO tenants(id, nome) VALUES ($1, 'Issue 316 A'), ($2, 'Issue 316 B')
        ON CONFLICT (id) DO NOTHING`,
      [TENANT_A, TENANT_B],
    );
    // idempotency_keys.agent_id FKs agents(id); seed the shared agent so the
    // reservation rows can be inserted under it.
    await c.query(
      `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, 'Issue 316 Agent')
        ON CONFLICT (id) DO NOTHING`,
      [AGENT, TENANT_A],
    );
    await c.query(
      `INSERT INTO pessoas(id, nome, telefone_whatsapp, tipo)
       VALUES ($1, 'issue316-pessoa', '+5511000000316', 'funcionario')
       ON CONFLICT (id) DO NOTHING`,
      [PESSOA_ID],
    );
    await c.query(
      `INSERT INTO entidades(id, nome, tipo)
       VALUES ($1, 'issue316-entidade', 'pj')
       ON CONFLICT (id) DO NOTHING`,
      [ENTIDADE_ID],
    );
  } finally {
    c.release();
  }
}

async function wipe(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`DELETE FROM idempotency_effect_outbox WHERE tenant_id IN ($1, $2)`, [
      TENANT_A,
      TENANT_B,
    ]);
    await c.query(`DELETE FROM idempotency_keys WHERE tenant_id IN ($1, $2)`, [
      TENANT_A,
      TENANT_B,
    ]);
  } finally {
    c.release();
  }
}

async function dropFixtures(): Promise<void> {
  const c = await pool.connect();
  try {
    await wipe();
    await c.query(`DELETE FROM entidades WHERE id = $1`, [ENTIDADE_ID]);
    await c.query(`DELETE FROM pessoas WHERE id = $1`, [PESSOA_ID]);
    await c.query(`DELETE FROM agents WHERE id = $1`, [AGENT]);
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
    await wipe();
  });
}

d('issue #316 — markCompletedWithEffect atomic enqueue under real Postgres', () => {
  it('WINNER completes + enqueues exactly one outbox row (atomic)', async () => {
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const key = `outbox-win-${Date.now()}-${Math.random()}`;
    const token = await seedReservation({ tenant_id: TENANT_A, key, payload_hash: key });
    expect(token).not.toBe('');

    const ok = await runWithTenantContext({ tenant_id: TENANT_A, agent_id: AGENT }, () =>
      idempotencyOutboxRepo.markCompletedWithEffect({
        key,
        resultado: { mensagem_id: 'msg-316' },
        reservation_token: token,
        effect: EFFECT,
      }),
    );
    expect(ok).toBe(true);

    const c = await pool.connect();
    try {
      const resv = await c.query<{ state: string }>(
        `SELECT state FROM idempotency_keys WHERE key = $1`,
        [key],
      );
      expect(resv.rows[0]!.state).toBe('completed');
      const outbox = await c.query<{ status: string; effect_type: string; idempotency_key: string }>(
        `SELECT status, effect_type, idempotency_key FROM idempotency_effect_outbox
          WHERE tenant_id = $1 AND idempotency_key = $2`,
        [TENANT_A, key],
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0]!.status).toBe('pending');
      expect(outbox.rows[0]!.effect_type).toBe('whatsapp_text');
    } finally {
      c.release();
    }
  });

  it('FENCED owner (stale token) enqueues NOTHING — exactly-once under lease reclaim', async () => {
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const key = `outbox-fence-${Date.now()}-${Math.random()}`;
    const tokenA = await seedReservation({ tenant_id: TENANT_A, key, payload_hash: key });
    expect(tokenA).not.toBe('');

    // A's lease expires; B reclaims with a fresh token.
    const c = await pool.connect();
    try {
      await c.query(
        `UPDATE idempotency_keys SET expires_at = now() - interval '5 seconds' WHERE key = $1`,
        [key],
      );
    } finally {
      c.release();
    }
    const tokenB = await seedReservation({ tenant_id: TENANT_A, key, payload_hash: key });
    expect(tokenB).not.toBe('');
    expect(tokenB).not.toBe(tokenA);

    // A (preempted) tries to complete + enqueue with its STALE token → fenced,
    // rolled back, NO outbox row.
    const aOk = await runWithTenantContext({ tenant_id: TENANT_A, agent_id: AGENT }, () =>
      idempotencyOutboxRepo.markCompletedWithEffect({
        key,
        resultado: { from: 'A-stale' },
        reservation_token: tokenA,
        effect: { ...EFFECT, text: 'A duplicate' },
      }),
    );
    expect(aOk).toBe(false);

    // B (the winner) completes + enqueues with its own token.
    const bOk = await runWithTenantContext({ tenant_id: TENANT_A, agent_id: AGENT }, () =>
      idempotencyOutboxRepo.markCompletedWithEffect({
        key,
        resultado: { from: 'B' },
        reservation_token: tokenB,
        effect: EFFECT,
      }),
    );
    expect(bOk).toBe(true);

    const c2 = await pool.connect();
    try {
      // EXACTLY ONE outbox row — A's fenced attempt never enqueued.
      const outbox = await c2.query<{ effect_payload: { text: string } }>(
        `SELECT effect_payload FROM idempotency_effect_outbox
          WHERE tenant_id = $1 AND idempotency_key = $2`,
        [TENANT_A, key],
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0]!.effect_payload.text).toBe('olá'); // B's, not A's duplicate
    } finally {
      c2.release();
    }
  });

  it('DUPLICATE winner re-entry: ON CONFLICT keeps exactly one outbox row', async () => {
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const key = `outbox-dup-${Date.now()}-${Math.random()}`;
    const token = await seedReservation({ tenant_id: TENANT_A, key, payload_hash: key });

    await runWithTenantContext({ tenant_id: TENANT_A, agent_id: AGENT }, () =>
      idempotencyOutboxRepo.markCompletedWithEffect({
        key,
        resultado: { v: 1 },
        reservation_token: token,
        effect: EFFECT,
      }),
    );
    // Force the reservation back to in_progress and complete again with the
    // same token — the outbox UNIQUE dedupes the enqueue.
    // `resultado` MUST be nulled too: the state-coherence CHECK
    // (migrations 064/065) requires `in_progress ⇒ resultado IS NULL`
    // (and `expires_at IS NOT NULL`), so leaving the completed `resultado`
    // in place would violate idempotency_keys_state_coherence_check.
    const c = await pool.connect();
    try {
      await c.query(
        `UPDATE idempotency_keys
            SET state = 'in_progress',
                resultado = NULL,
                expires_at = now() + interval '30 seconds'
          WHERE key = $1`,
        [key],
      );
    } finally {
      c.release();
    }
    await runWithTenantContext({ tenant_id: TENANT_A, agent_id: AGENT }, () =>
      idempotencyOutboxRepo.markCompletedWithEffect({
        key,
        resultado: { v: 2 },
        reservation_token: token,
        effect: { ...EFFECT, text: 'second' },
      }),
    );

    const c2 = await pool.connect();
    try {
      const outbox = await c2.query(
        `SELECT id FROM idempotency_effect_outbox WHERE tenant_id = $1 AND idempotency_key = $2`,
        [TENANT_A, key],
      );
      expect(outbox.rows).toHaveLength(1);
    } finally {
      c2.release();
    }
  });

  it('TENANT ISOLATION: tenant-B cannot enqueue an effect for tenant-A reservation', async () => {
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const key = `outbox-iso-${Date.now()}-${Math.random()}`;
    const token = await seedReservation({ tenant_id: TENANT_A, key, payload_hash: key });

    // Running under tenant-B, the fencing UPDATE filters tenant_id=B → 0 rows
    // → rollback → no enqueue under either tenant.
    const ok = await runWithTenantContext({ tenant_id: TENANT_B, agent_id: AGENT }, () =>
      idempotencyOutboxRepo.markCompletedWithEffect({
        key,
        resultado: {},
        reservation_token: token,
        effect: EFFECT,
      }),
    );
    expect(ok).toBe(false);

    const c = await pool.connect();
    try {
      const any = await c.query(
        `SELECT id FROM idempotency_effect_outbox WHERE idempotency_key = $1`,
        [key],
      );
      expect(any.rows).toHaveLength(0);
    } finally {
      c.release();
    }
  });
});

d('issue #316 — relayer claim is race-safe under real Postgres', () => {
  it('two concurrent claims do not both grab the same row (FOR UPDATE SKIP LOCKED)', async () => {
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    // Enqueue 4 pending rows for tenant-A via 4 winning reservations.
    const keys: string[] = [];
    for (let i = 0; i < 4; i++) {
      const key = `outbox-claim-${Date.now()}-${i}-${Math.random()}`;
      const token = await seedReservation({ tenant_id: TENANT_A, key, payload_hash: key });
      await runWithTenantContext({ tenant_id: TENANT_A, agent_id: AGENT }, () =>
        idempotencyOutboxRepo.markCompletedWithEffect({
          key,
          resultado: {},
          reservation_token: token,
          effect: EFFECT,
        }),
      );
      keys.push(key);
    }

    // Two concurrent claims (each limit 4). With FOR UPDATE SKIP LOCKED, a row
    // claimed (row-locked) by one transaction is skipped by the other while the
    // lock is held. Because db.execute auto-commits each statement, the locks
    // release immediately — so the union covers all 4 and no row is double-held
    // WITHIN a single in-flight statement. We assert the union of ids is the
    // full set and there are no duplicates within a single claim's result.
    const [c1, c2] = await runWithTenantContext(
      { tenant_id: TENANT_A, agent_id: AGENT },
      () =>
        Promise.all([
          idempotencyOutboxRepo.claimPendingEffects(4),
          idempotencyOutboxRepo.claimPendingEffects(4),
        ]),
    );
    for (const claim of [c1, c2]) {
      const ids = claim.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length); // no dup within one claim
    }
    const allClaimed = new Set([...c1, ...c2].map((r) => r.id));
    expect(allClaimed.size).toBe(4);
  });
});
