/**
 * Migration 085 — calendar as default pack: backfill test (real DB).
 *
 * Proves:
 *  1. BACKFILL: a legacy grant {baseline.core} gains domain.calendar after
 *     migration 085 runs (via startPostgresContainer which applies ALL
 *     forward migrations including 085).
 *  2. IDEMPOTENCY: re-running the migration SQL does NOT duplicate
 *     domain.calendar in granted_packs.
 *  3. DENIED_TOOLS INVARIANT: a grant with denied_tools set keeps those
 *     denies intact — 085 never touches denied_tools.
 *  4. COLUMN DEFAULT: a fresh INSERT with no explicit granted_packs value
 *     lands on {baseline.core, domain.calendar}.
 *
 * TENANT HOME — 'primary' (not 'default'): issue #323 (migrations 081-084)
 * re-homes the single-tenant runtime off the legacy 'default' bucket onto the
 * reserved 'primary' tenant/agent, then DELETES 'default'. So after the full
 * forward chain the grant migration 076 seeded for the legacy 'default' agent
 * now lives under 'primary'/'primary', and 'default' no longer exists. This
 * spec therefore asserts on — and inserts under — 'primary'. (Mirrors the
 * 'default' → 'primary' switch the sibling baseline-skills-seed-real-db spec
 * made for the same reason.)
 *
 * ---------------------------------------------------------------------------
 * RUNTIME REQUIREMENT — DOCKER DAEMON. Gated behind isDockerAvailable(); set
 * SKIP_DOCKER_TESTS=1 to force-skip. Run via:
 *   npm run test:integration:real-db
 *
 * This suite did NOT run in the implementing environment (no Docker / Postgres);
 * it must run in CI's Docker-enabled lane. See AGENTS.md §7.
 * ---------------------------------------------------------------------------
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  startPostgresContainer,
  stopPostgresContainer,
  isDockerAvailable,
  type StartedPostgres,
} from './_fixtures/postgres-testcontainer.js';

let pg: StartedPostgres;

const SHOULD_RUN = await isDockerAvailable();
const d = SHOULD_RUN ? describe : describe.skip;

// After the full forward chain the single-tenant runtime home is 'primary'
// (issue #323 migrations 081-084 rehome 'default' → 'primary' then delete
// 'default'). The grant migration 076 seeded for the legacy 'default' agent is
// therefore now under 'primary'/'primary'. The 'primary' tenant/agent are
// seeded by migration 081, so inserts below can reference 'primary' directly.
const TENANT = 'primary';
const AGENT = 'primary';

d('migration 085 — calendar backfill (real DB)', () => {
  beforeAll(async () => {
    // startPostgresContainer applies ALL forward migrations (incl. 085)
    // against a fresh ephemeral Postgres. After this point the schema is
    // identical to production with 085 applied.
    pg = await startPostgresContainer();
  }, 120_000);

  afterAll(async () => {
    await stopPostgresContainer(pg);
  });

  // -------------------------------------------------------------------------
  // Prerequisite: migration 076 seeded one row per existing agent with
  // granted_packs = {baseline.core}; #323 rehomed the legacy 'default' grant to
  // 'primary'; migration 085 then backfills domain.calendar into every row.
  // -------------------------------------------------------------------------

  it('after migration 085, the primary agent grant contains domain.calendar', async () => {
    const { rows } = await pg.pool.query<{ granted_packs: string[] }>(
      `SELECT granted_packs FROM agent_tool_grants
        WHERE tenant_id = $1 AND agent_id = $2`,
      [TENANT, AGENT],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.granted_packs).toContain('baseline.core');
    expect(rows[0]!.granted_packs).toContain('domain.calendar');
  });

  it('all existing agent_tool_grants rows contain domain.calendar (no legacy rows missed)', async () => {
    // Every row in the table must contain domain.calendar after the backfill.
    const { rows: missing } = await pg.pool.query<{ tenant_id: string; agent_id: string }>(
      `SELECT tenant_id, agent_id FROM agent_tool_grants
        WHERE NOT ('domain.calendar' = ANY(granted_packs))`,
    );
    expect(missing).toHaveLength(0);
  });

  it('re-running migration 085 is IDEMPOTENT — domain.calendar is NOT duplicated', async () => {
    const sql = await readFile(
      new URL('../../migrations/085_calendar_default_pack.sql', import.meta.url),
      'utf8',
    );

    // Apply the forward migration body a second time.
    await pg.pool.query(sql);

    // Every row must still contain domain.calendar exactly once.
    const { rows } = await pg.pool.query<{ granted_packs: string[] }>(
      `SELECT granted_packs FROM agent_tool_grants`,
    );
    for (const row of rows) {
      const calendarEntries = row.granted_packs.filter((p) => p === 'domain.calendar');
      expect(
        calendarEntries,
        `row has domain.calendar ${calendarEntries.length} times, want exactly 1`,
      ).toHaveLength(1);
    }
  });

  it('denied_tools are preserved — migration 085 does NOT touch denied_tools', async () => {
    const client = await pg.pool.connect();
    const agentId = `agent-085-denied-test-${Date.now()}`;
    try {
      // The 'primary' tenant already exists (seeded by migration 081); create a
      // fresh agent under it carrying an explicit deny.
      await client.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
        [agentId, TENANT],
      );
      // Insert a legacy-style grant with only baseline.core and a denied_tool.
      await client.query(
        `INSERT INTO agent_tool_grants (tenant_id, agent_id, granted_packs, denied_tools)
           VALUES ($1, $2, '{baseline.core}', '{some_sensitive_tool}')`,
        [TENANT, agentId],
      );

      // Now re-apply migration 085 (should only touch granted_packs, not denied_tools).
      const sql = await readFile(
        new URL('../../migrations/085_calendar_default_pack.sql', import.meta.url),
        'utf8',
      );
      await client.query(sql);

      const { rows } = await client.query<{ granted_packs: string[]; denied_tools: string[] }>(
        `SELECT granted_packs, denied_tools FROM agent_tool_grants
          WHERE tenant_id = $1 AND agent_id = $2`,
        [TENANT, agentId],
      );
      expect(rows).toHaveLength(1);
      // granted_packs must now include domain.calendar
      expect(rows[0]!.granted_packs).toContain('domain.calendar');
      // denied_tools must be UNCHANGED
      expect(rows[0]!.denied_tools).toContain('some_sensitive_tool');
    } finally {
      // Cleanup — cascade deletes the grant via ON DELETE CASCADE.
      await client
        .query(`DELETE FROM agents WHERE id = $1`, [agentId])
        .catch(() => undefined);
      client.release();
    }
  });

  it('column DEFAULT produces {baseline.core, domain.calendar} on fresh INSERT without explicit packs', async () => {
    const client = await pg.pool.connect();
    const agentId = `agent-085-default-col-${Date.now()}`;
    try {
      await client.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
        [agentId, TENANT],
      );
      // INSERT omitting granted_packs — must land on the column default.
      const { rows } = await client.query<{ granted_packs: string[] }>(
        `INSERT INTO agent_tool_grants (tenant_id, agent_id)
           VALUES ($1, $2)
           RETURNING granted_packs`,
        [TENANT, agentId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.granted_packs).toContain('baseline.core');
      expect(rows[0]!.granted_packs).toContain('domain.calendar');
    } finally {
      // Cleanup — cascade deletes the grant.
      await client
        .query(`DELETE FROM agents WHERE id = $1`, [agentId])
        .catch(() => undefined);
      client.release();
    }
  });
});
