/**
 * Codex Adversarial Review on PR #187 round 1 ([medium], issue #184):
 *
 * `agentsRepo.createWithSeedAndAudit` previously let a primary-key 23505
 * bubble up as an INTERNAL_SERVER_ERROR when the router's out-of-tx
 * `findById` preflight raced with a concurrent create. Two callers could
 * both pass the preflight, both reach the agents INSERT, and the loser of
 * the unique-constraint contest would surface a raw pg error to the UI
 * (500) instead of the documented CONFLICT (typed `duplicate_id`).
 *
 * The fix: the atomic helper now catches PK 23505 inside the tx and returns
 * `{ ok: false, reason: 'duplicate_id', agent_id }` so the router can map
 * it to TRPC CONFLICT without inspecting pg error codes. The router's
 * preflight `findById` is removed — the atomic helper is the single source
 * of truth on duplicate ids, eliminating the TOCTOU window.
 *
 * This integration test exercises the real concurrent-create race against
 * a live Postgres so we have end-to-end evidence (not just a mock) that:
 *   1. Two concurrent `Promise.all` calls to `createWithSeedAndAudit` for
 *      the same agent id BOTH complete WITHOUT an unhandled throw.
 *   2. Exactly one returns `{ ok: true, ... }` (the winner of the PK race).
 *   3. The other returns `{ ok: false, reason: 'duplicate_id', agent_id }`
 *      (typed, not a raw pg error).
 *   4. The DB ends with exactly one agents row, one seed profile_version
 *      row (the winner's), and one admin_audit_log row for `agent_create`
 *      (the winner's). The loser's tx rolled back cleanly — no orphaned
 *      seed_profile, no forensics ghost.
 *
 * Skipped without TEST_DB_URL (matches `issue-166-propose-version-race.spec.ts`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'issue184-tenant';
// We use a DIFFERENT agent id per test (the whole point is the agent didn't
// exist before the concurrent create). The constant below is just the
// shared prefix; per-test ids are appended.
const A_PREFIX = 'issue184-agent';
const ACTOR = 'issue184-actor';

let pool: pg.Pool;

// Build a valid `profile_body` that passes `validateProfileBodyP8d` — see
// the repository's `validateProfileBodyP8d` in `src/db/repositories.ts`.
const validProfileBody = {
  schema_version: '3.1.1',
  identity: {
    role_descriptor: 'integration test agent',
    voice: { tone: 'profissional', formality: 'medium', verbosity: 'medium' },
    cognitive_limits: {
      max_inference_depth: 3,
      max_speculation_in_response: 0.2,
      confidence_floor_for_action: 0.7,
    },
    priorities: ['precisao', 'clareza'],
    learned_voice_modifiers: [],
  },
  style: { language: 'pt-BR', rhythm: {} },
  metadata: {
    effective_from: new Date().toISOString(),
    created_by: ACTOR,
    previous_version_id: null,
  },
} as const;

async function cleanupAgent(agentId: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`DELETE FROM admin_audit_log WHERE tenant_id = $1 AND resource_id = $2`, [T, agentId]);
    await c.query(`DELETE FROM agent_operational_profile_versions WHERE tenant_id = $1 AND agent_id = $2`, [T, agentId]);
    await c.query(`DELETE FROM agents WHERE tenant_id = $1 AND id = $2`, [T, agentId]);
  } finally {
    c.release();
  }
}

if (SHOULD_RUN) {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO tenants(id, nome) VALUES ($1, 'Issue 184 Tenant') ON CONFLICT (id) DO NOTHING`,
        [T],
      );
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM admin_audit_log WHERE tenant_id = $1`, [T]);
      await c.query(`DELETE FROM agent_operational_profile_versions WHERE tenant_id = $1`, [T]);
      await c.query(`DELETE FROM agents WHERE tenant_id = $1`, [T]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [T]);
    } finally {
      c.release();
      await pool.end();
    }
  });

  // Ensure no row from a previous run survives — every test gets a clean
  // (tenant, agent) slot.
  beforeEach(async () => {
    // Per-test ids are derived below; we wipe the whole tenant slot to keep
    // resets cheap and predictable.
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM admin_audit_log WHERE tenant_id = $1`, [T]);
      await c.query(`DELETE FROM agent_operational_profile_versions WHERE tenant_id = $1`, [T]);
      await c.query(`DELETE FROM agents WHERE tenant_id = $1`, [T]);
    } finally {
      c.release();
    }
  });
}

d('agentsRepo.createWithSeedAndAudit (concurrent create race, real DB)', () => {
  it('two concurrent creates for the same agent id → one ok, one duplicate_id, no throw', async () => {
    const { agentsRepo } = await import('../../src/db/repositories.js');

    const agentId = `${A_PREFIX}-race-1`;

    const baseArgs = {
      agent: {
        id: agentId,
        tenant_id: T,
        nome: 'Concurrent Agent',
      },
      seed_profile: {
        profile_body: validProfileBody,
        proposed_by: ACTOR,
        proposed_reason: 'concurrent create race',
      },
      audit: {
        actor_id: ACTOR,
        actor_role: 'founder',
      },
    } as const;

    // Both callers race for the same agent id. Promise.all preserves both
    // results regardless of which lost — neither call should throw, both
    // must return a typed discriminated-union result.
    const [a, b] = await Promise.all([
      agentsRepo.createWithSeedAndAudit({ ...baseArgs }),
      agentsRepo.createWithSeedAndAudit({ ...baseArgs }),
    ]);

    // Exactly one ok, exactly one duplicate_id. The order is not guaranteed
    // (Promise.all races + Postgres lock acquisition timing).
    const oks = [a, b].filter((r) => r.ok);
    const dups = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(dups).toHaveLength(1);

    // Discriminated-union shape: the duplicate carries the agent_id we
    // asked for (NOT a raw pg error string).
    const loser = dups[0]!;
    if (!loser.ok) {
      expect(loser.reason).toBe('duplicate_id');
      expect(loser.agent_id).toBe(agentId);
    }

    // The winner's payload references the same agent + a v1 proposed seed.
    const winner = oks[0]!;
    if (winner.ok) {
      expect(winner.agent.id).toBe(agentId);
      expect(winner.seed_profile.version).toBe(1);
      expect(winner.seed_profile.status).toBe('proposed');
    }

    // DB invariants — the loser's tx rolled back cleanly.
    const c = await pool.connect();
    try {
      const agentRows = await c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM agents WHERE tenant_id = $1 AND id = $2`,
        [T, agentId],
      );
      expect(agentRows.rows[0]!.count).toBe('1');

      const profileRows = await c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM agent_operational_profile_versions
          WHERE tenant_id = $1 AND agent_id = $2`,
        [T, agentId],
      );
      expect(profileRows.rows[0]!.count).toBe('1');

      const auditRows = await c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM admin_audit_log
          WHERE tenant_id = $1 AND action = 'agent_create' AND resource_id = $2`,
        [T, agentId],
      );
      expect(auditRows.rows[0]!.count).toBe('1');
    } finally {
      c.release();
    }

    await cleanupAgent(agentId);
  });

  it('sequential create after first commit → second call returns duplicate_id', async () => {
    // Covers the SECOND ordering window: the duplicate was already
    // committed BEFORE the call started (i.e. a normal "this id is taken"
    // case, not a race). Same typed-miss contract.
    const { agentsRepo } = await import('../../src/db/repositories.js');

    const agentId = `${A_PREFIX}-race-2`;

    const baseArgs = {
      agent: {
        id: agentId,
        tenant_id: T,
        nome: 'Sequential Agent',
      },
      seed_profile: {
        profile_body: validProfileBody,
        proposed_by: ACTOR,
        proposed_reason: 'sequential duplicate-id attempt',
      },
      audit: {
        actor_id: ACTOR,
        actor_role: 'founder',
      },
    } as const;

    // First call wins.
    const first = await agentsRepo.createWithSeedAndAudit({ ...baseArgs });
    expect(first.ok).toBe(true);

    // Second call MUST surface duplicate_id (not throw).
    const second = await agentsRepo.createWithSeedAndAudit({ ...baseArgs });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('duplicate_id');
      expect(second.agent_id).toBe(agentId);
    }

    // Still exactly one of each row (loser's tx didn't append).
    const c = await pool.connect();
    try {
      const auditRows = await c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM admin_audit_log
          WHERE tenant_id = $1 AND action = 'agent_create' AND resource_id = $2`,
        [T, agentId],
      );
      expect(auditRows.rows[0]!.count).toBe('1');

      const profileRows = await c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM agent_operational_profile_versions
          WHERE tenant_id = $1 AND agent_id = $2`,
        [T, agentId],
      );
      expect(profileRows.rows[0]!.count).toBe('1');
    } finally {
      c.release();
    }

    await cleanupAgent(agentId);
  });
});
