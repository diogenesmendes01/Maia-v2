/**
 * Migration 081 — calendar as default pack: backfill test (real DB).
 *
 * Proves:
 *  1. BACKFILL: a legacy grant {baseline.core} gains domain.calendar after
 *     migration 081 runs (via startPostgresContainer which applies ALL
 *     forward migrations including 081).
 *  2. IDEMPOTENCY: re-running the migration SQL does NOT duplicate
 *     domain.calendar in granted_packs.
 *  3. DENIED_TOOLS INVARIANT: a grant with denied_tools set keeps those
 *     denies intact — 081 never touches denied_tools.
 *  4. COLUMN DEFAULT: a fresh INSERT with no explicit granted_packs value
 *     lands on {baseline.core, domain.calendar}.
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

d('migration 081 — calendar backfill (real DB)', () => {
  beforeAll(async () => {
    // startPostgresContainer applies ALL forward migrations (incl. 081)
    // against a fresh ephemeral Postgres. After this point the schema is
    // identical to production with 081 applied.
    pg = await startPostgresContainer();
  }, 120_000);

  afterAll(async () => {
    await stopPostgresContainer(pg);
  });

  // -------------------------------------------------------------------------
  // Prerequisite: migration 076 seeded one row per existing agent in the
  // container with granted_packs = {baseline.core}. Migration 081 backfills
  // those rows. At a minimum the 'default' agent row must exist.
  // -------------------------------------------------------------------------

  it('after migration 081, the default agent grant contains domain.calendar', async () => {
    const { rows } = await pg.pool.query<{ granted_packs: string[] }>(
      `SELECT granted_packs FROM agent_tool_grants
        WHERE tenant_id = 'default' AND agent_id = 'default'`,
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

  it('re-running migration 081 is IDEMPOTENT — domain.calendar is NOT duplicated', async () => {
    const sql = await readFile(
      new URL('../../migrations/081_calendar_default_pack.sql', import.meta.url),
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

  it('denied_tools are preserved — migration 081 does NOT touch denied_tools', async () => {
    const client = await pg.pool.connect();
    const agentId = `agent-081-denied-test-${Date.now()}`;
    try {
      // Insert a grant with denied_tools set (simulating an agent that has an
      // explicit deny on some tool).
      await client.query(
        `INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
        ['default'],
      );
      await client.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, 'default', $1) ON CONFLICT (id) DO NOTHING`,
        [agentId],
      );
      // Insert a legacy-style grant with only baseline.core and a denied_tool.
      await client.query(
        `INSERT INTO agent_tool_grants (tenant_id, agent_id, granted_packs, denied_tools)
           VALUES ('default', $1, '{baseline.core}', '{some_sensitive_tool}')`,
        [agentId],
      );

      // Now re-apply migration 081 (should only touch granted_packs, not denied_tools).
      const sql = await readFile(
        new URL('../../migrations/081_calendar_default_pack.sql', import.meta.url),
        'utf8',
      );
      await client.query(sql);

      const { rows } = await client.query<{ granted_packs: string[]; denied_tools: string[] }>(
        `SELECT granted_packs, denied_tools FROM agent_tool_grants
          WHERE tenant_id = 'default' AND agent_id = $1`,
        [agentId],
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
    const agentId = `agent-081-default-col-${Date.now()}`;
    try {
      await client.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, 'default', $1) ON CONFLICT (id) DO NOTHING`,
        [agentId],
      );
      // INSERT omitting granted_packs — must land on the column default.
      const { rows } = await client.query<{ granted_packs: string[] }>(
        `INSERT INTO agent_tool_grants (tenant_id, agent_id)
           VALUES ('default', $1)
           RETURNING granted_packs`,
        [agentId],
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
