/**
 * Issue #410 — baseline SKILLS seed (migration 075) on REAL Postgres.
 *
 * DoD (c): the 8 baseline skills are seeded TENANT-WIDE (`agent_id IS NULL`,
 * `status='active'`, `proposed_by='system'`, version=1) and are VISIBLE to the
 * skill selector for ANY agent in the tenant — because the selector reads
 * `agent_id IS NULL OR agent_id = $agent` (proven here via the production
 * `skillsRepo.findActive` / `listByCategory` against the migrated schema).
 *
 * Also proves the seed is IDEMPOTENT: re-running migration 075 does NOT create
 * duplicate rows (the `ON CONFLICT DO NOTHING` on the version-unique index).
 *
 * ---------------------------------------------------------------------------
 * RUNTIME REQUIREMENT — DOCKER DAEMON. Mirrors
 * `tests/integration/skills-repo-cross-tenant-real-db.spec.ts`: gated behind a
 * Docker probe; SKIP_DOCKER_TESTS=1 forces skip; run via
 *   npm run test:integration:real-db
 * This suite did NOT run in the implementing environment (no Docker / Postgres);
 * it runs in CI's Docker-enabled lane.
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

type SkillsRepoModule = typeof import('@/control-plane/skill-registry/skills-repo.js');
type TenantContextModule = typeof import('@/db/tenant-context.js');
type DbClientModule = typeof import('@/db/client.js');
let skillsRepoMod: SkillsRepoModule;
let tenantContextMod: TenantContextModule;
let dbClientMod: DbClientModule;

let pg: StartedPostgres;
let previousDatabaseUrl: string | undefined;

const SHOULD_RUN = await isDockerAvailable();
const d = SHOULD_RUN ? describe : describe.skip;

// Migration 075 seeds under the bootstrap tenant 'default' (migration 007 seeds
// the tenant + the legacy 'default' agent).
const TENANT = 'default';
const AGENT = 'default';
// An arbitrary OTHER agent in the same tenant — proves tenant-wide visibility
// (agent_id IS NULL skills must surface for it too).
const OTHER_AGENT = 'some-other-agent';

const BASELINE_DESCRIPTORS = [
  'safe_conversation',
  'ask_clarification',
  'request_confirmation',
  'handoff_to_owner',
  'remember_safe_fact',
  'retrieve_context',
  'explain_limitation',
  'audit_decision',
] as const;

// The universe of baseline.core tool names (the only tools allowed_tools may
// reference). Kept in sync with src/tools/packs.ts BASELINE_CORE_PACK.
const BASELINE_TOOLS = new Set([
  'read_turn_context',
  'recall_memory',
  'remember_safe_fact',
  'request_confirmation',
  'handoff_to_owner',
  'audit_decision',
  'explain_limitation',
]);

d('baseline skills seed (migration 075) — real DB', () => {
  beforeAll(async () => {
    pg = await startPostgresContainer();
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = pg.uri;
    skillsRepoMod = await import('@/control-plane/skill-registry/skills-repo.js');
    tenantContextMod = await import('@/db/tenant-context.js');
    dbClientMod = await import('@/db/client.js');
  }, 120_000);

  afterAll(async () => {
    // Drain the production pool created against the container (mirrors the
    // sibling real-db spec) before stopping the container.
    if (dbClientMod) await dbClientMod.shutdownDb().catch(() => undefined);
    if (pg) await stopPostgresContainer(pg);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('seeds exactly the 8 baseline skills tenant-wide, active, proposed_by=system', async () => {
    const { rows } = await pg.pool.query<{
      skill_descriptor: string;
      agent_id: string | null;
      status: string;
      proposed_by: string;
      approved_by: string | null;
      version: number;
      execution_mode: string;
      allowed_tools: string[];
    }>(
      // Scope to the known baseline descriptors AND version=1: migration 080
      // adds v2 rows for 5 of these descriptors; without the version filter the
      // query returns 13 rows (v1 + v2) instead of 8.
      `SELECT skill_descriptor, agent_id, status, proposed_by, approved_by,
              version, execution_mode, allowed_tools
         FROM skills
        WHERE tenant_id = $1 AND proposed_by = 'system'
          AND skill_descriptor = ANY($2)
          AND version = 1
        ORDER BY skill_descriptor`,
      [TENANT, [...BASELINE_DESCRIPTORS]],
    );

    expect(rows.map((r) => r.skill_descriptor).sort()).toEqual(
      [...BASELINE_DESCRIPTORS].sort(),
    );
    for (const r of rows) {
      expect(r.agent_id, `${r.skill_descriptor} must be tenant-wide`).toBeNull();
      // Migration 080 deprecates the 5 converted skills (they become tool_mediated v2);
      // the 3 prompt_only skills that were not converted stay active.
      expect(['active', 'deprecated']).toContain(r.status);
      expect(r.proposed_by).toBe('system');
      expect(r.approved_by).toBe('system');
      expect(r.version).toBe(1);
      expect(r.execution_mode).toBe('prompt_only');
      // allowed_tools references ONLY baseline tools.
      expect(r.allowed_tools.length).toBeGreaterThan(0);
      for (const t of r.allowed_tools) {
        expect(BASELINE_TOOLS.has(t), `${r.skill_descriptor} allowed_tool ${t} must be a baseline tool`).toBe(true);
      }
    }
  });

  it('re-running migration 075 is IDEMPOTENT (no duplicate rows)', async () => {
    const sql = await readFile(
      new URL('../../migrations/075_baseline_skills_seed.sql', import.meta.url),
      'utf8',
    );
    // Apply the forward migration body a second time.
    await pg.pool.query(sql);

    const { rows } = await pg.pool.query<{ count: string }>(
      // Count only version=1 rows: migration 080 adds v2 rows for 5 of these
      // descriptors; without this filter the count exceeds 8.
      `SELECT COUNT(*)::text AS count
         FROM skills
        WHERE tenant_id = $1 AND proposed_by = 'system'
          AND skill_descriptor = ANY($2)
          AND version = 1`,
      [TENANT, [...BASELINE_DESCRIPTORS]],
    );
    expect(Number(rows[0]!.count)).toBe(BASELINE_DESCRIPTORS.length);
  });

  it('baseline skills are VISIBLE to the selector for the default agent (findActive)', async () => {
    await tenantContextMod.runWithTenantContext(
      { tenant_id: TENANT, agent_id: AGENT },
      async () => {
        for (const descr of BASELINE_DESCRIPTORS) {
          const row = await skillsRepoMod.skillsRepo.findActive(descr);
          expect(row, `findActive(${descr}) under default agent`).not.toBeNull();
          expect(row!.agent_id).toBeNull(); // resolved the tenant-wide row
          expect(row!.status).toBe('active');
        }
      },
    );
  });

  it('baseline skills are VISIBLE to ANY OTHER agent in the tenant (tenant-wide)', async () => {
    await tenantContextMod.runWithTenantContext(
      { tenant_id: TENANT, agent_id: OTHER_AGENT },
      async () => {
        // findActive defaults scope to (current agent OR tenant-wide); a brand
        // new agent with no own skills still sees the tenant-wide baseline.
        const row = await skillsRepoMod.skillsRepo.findActive('safe_conversation');
        expect(row).not.toBeNull();
        expect(row!.agent_id).toBeNull();

        // listByCategory('compose') surfaces the compose-category baseline skills.
        const composeRows = await skillsRepoMod.skillsRepo.listByCategory('compose');
        const composeDescriptors = composeRows.map((r) => r.skill_descriptor);
        expect(composeDescriptors).toEqual(
          expect.arrayContaining(['safe_conversation', 'explain_limitation', 'retrieve_context']),
        );
      },
    );
  });
});
