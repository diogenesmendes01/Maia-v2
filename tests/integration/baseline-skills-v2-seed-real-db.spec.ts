/**
 * Issue #448 — baseline skills v2 seed (migration 080) on REAL Postgres.
 *
 * Proves the acceptance criteria end-to-end against the migrated schema:
 *   - the 5 v1 prompt_only rows are deprecated by migration 080;
 *   - 8 new/upgraded baseline skills are seeded TENANT-WIDE (`agent_id IS NULL`,
 *     `status='active'`, `proposed_by='system'`, `execution_mode='tool_mediated'`);
 *   - each new row's allowed_tools are a strict subset of BASELINE_CORE_PACK v2;
 *   - the 3 gap tools appear in at least one skill's allowed_tools;
 *   - all new rows have usage_policy set (not NULL);
 *   - the seed is IDEMPOTENT: re-running migration 080 creates no duplicate rows;
 *   - `skillsRepo.findActive` surfaces the new baseline skills tenant-wide.
 *
 * ---------------------------------------------------------------------------
 * RUNTIME REQUIREMENT — DOCKER DAEMON. Mirrors
 * `tests/integration/baseline-skills-seed-real-db.spec.ts`: gated behind a
 * Docker probe; run via `npm run test:integration:real-db`. This suite did NOT
 * run in the implementing environment (no Docker / Postgres); it runs in CI's
 * Docker-enabled lane.
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

// Migration 080 operates under the bootstrap tenant 'default' (migration 007
// seeds the tenant + the legacy 'default' agent, migration 075 seeds v1 skills).
const TENANT = 'default';
const AGENT = 'default';

// -------------------------------------------------------------------------
// Expected row sets — mirrors the VALUES clause in 080_baseline_skills_v2.sql
// -------------------------------------------------------------------------

// 5 skills converted from v1 prompt_only → v2 tool_mediated
const V2_DESCRIPTORS = [
  'safe_conversation',
  'retrieve_context',
  'handoff_to_owner',
  'remember_safe_fact',
  'audit_decision',
] as const;

// 3 wholly new skills added at v1 tool_mediated
const NEW_DESCRIPTORS = [
  'escalate_on_risk',
  'summarization',
  'manage_conversation_state',
] as const;

const ALL_NEW_DESCRIPTORS = [...V2_DESCRIPTORS, ...NEW_DESCRIPTORS] as const;

// BASELINE_CORE_PACK v2 tools — these are the ONLY tools a baseline skill may
// reference. Kept in sync with src/tools/grant-math.ts BASELINE_CORE_PACK.
const BASELINE_CORE_TOOLS_V2 = new Set([
  'read_turn_context',
  'recall_memory',
  'remember_safe_fact',
  'request_confirmation',
  'handoff_to_owner',
  'audit_decision',
  'explain_limitation',
  'risk_signal_classify',
  'conversation_summary_compose',
  'conversation_state_update',
]);

// The 3 tools added by #433 that migration 080 must wire into skills
const GAP_TOOLS = [
  'risk_signal_classify',
  'conversation_summary_compose',
  'conversation_state_update',
] as const;

// Domain/sensitive tools that MUST NOT appear in any baseline skill allowed_tools
const DOMAIN_TOOLS = new Set([
  'register_transaction',
  'cancel_transaction',
  'query_balance',
  'list_transactions',
  'classify_transaction',
  'compare_entities',
  'generate_report',
  'start_recurring_payment',
  'identify_entity',
  'send_proactive_message',
  'start_recurring_outreach',
  'start_workflow',
  'schedule_reminder',
  'cancel_reminder',
  'register_custom_holiday',
]);

// -------------------------------------------------------------------------
// Test suite (Docker-gated)
// -------------------------------------------------------------------------
d('baseline skills v2 seed (migration 080) — real DB', () => {
  beforeAll(async () => {
    pg = await startPostgresContainer();
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = pg.uri;
    skillsRepoMod = await import('@/control-plane/skill-registry/skills-repo.js');
    tenantContextMod = await import('@/db/tenant-context.js');
    dbClientMod = await import('@/db/client.js');
  }, 120_000);

  afterAll(async () => {
    if (dbClientMod) await dbClientMod.shutdownDb().catch(() => undefined);
    if (pg) await stopPostgresContainer(pg);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  // -----------------------------------------------------------------------
  // Test 1 — the 5 v1 prompt_only rows are deprecated by migration 080
  // -----------------------------------------------------------------------
  it('5 v1 prompt_only rows are deprecated by migration 080 (status=deprecated, deprecated_at IS NOT NULL)', async () => {
    const { rows } = await pg.pool.query<{
      skill_descriptor: string;
      status: string;
      deprecated_at: Date | null;
      version: number;
      execution_mode: string;
    }>(
      `SELECT skill_descriptor, status, deprecated_at, version, execution_mode
         FROM skills
        WHERE tenant_id = $1
          AND agent_id IS NULL
          AND proposed_by = 'system'
          AND skill_descriptor = ANY($2)
          AND version = 1
          AND execution_mode = 'prompt_only'
        ORDER BY skill_descriptor`,
      [TENANT, [...V2_DESCRIPTORS]],
    );

    expect(rows).toHaveLength(V2_DESCRIPTORS.length);
    for (const r of rows) {
      expect(r.status, `${r.skill_descriptor} v1 must be deprecated`).toBe('deprecated');
      expect(
        r.deprecated_at,
        `${r.skill_descriptor} v1 must have deprecated_at set`,
      ).not.toBeNull();
    }
  });

  // -----------------------------------------------------------------------
  // Test 2 — 8 new/upgraded rows are seeded active, tenant-wide, tool_mediated
  // -----------------------------------------------------------------------
  it('8 new/upgraded baseline skills are active, tenant-wide, tool_mediated, proposed_by=system', async () => {
    const { rows } = await pg.pool.query<{
      skill_descriptor: string;
      agent_id: string | null;
      status: string;
      execution_mode: string;
      proposed_by: string;
      approved_by: string | null;
      version: number;
      allowed_tools: string[];
    }>(
      `SELECT skill_descriptor, agent_id, status, execution_mode,
              proposed_by, approved_by, version, allowed_tools
         FROM skills
        WHERE tenant_id = $1
          AND status = 'active'
          AND proposed_by = 'system'
          AND skill_descriptor = ANY($2)
        ORDER BY skill_descriptor`,
      [TENANT, [...ALL_NEW_DESCRIPTORS]],
    );

    // Exactly 8 rows — no duplicates, no missing rows.
    expect(rows.map((r) => r.skill_descriptor).sort()).toEqual(
      [...ALL_NEW_DESCRIPTORS].sort(),
    );

    for (const r of rows) {
      expect(r.agent_id, `${r.skill_descriptor} must be tenant-wide`).toBeNull();
      expect(r.status, `${r.skill_descriptor} must be active`).toBe('active');
      expect(r.execution_mode, `${r.skill_descriptor} must be tool_mediated`).toBe(
        'tool_mediated',
      );
      expect(r.proposed_by).toBe('system');
      expect(r.approved_by).toBe('system');

      // Version expectations: 5 converted skills are version=2, 3 new are version=1.
      if ((V2_DESCRIPTORS as readonly string[]).includes(r.skill_descriptor)) {
        expect(r.version, `${r.skill_descriptor} v2 converted skill must be version=2`).toBe(2);
      } else {
        expect(r.version, `${r.skill_descriptor} new baseline skill must be version=1`).toBe(1);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Test 3 — allowed_tools subset invariant: only BASELINE_CORE_PACK v2 tools
  // -----------------------------------------------------------------------
  it('all new baseline skill allowed_tools are a subset of BASELINE_CORE_PACK v2 tools, with no domain tool', async () => {
    const { rows } = await pg.pool.query<{
      skill_descriptor: string;
      allowed_tools: string[];
    }>(
      `SELECT skill_descriptor, allowed_tools
         FROM skills
        WHERE tenant_id = $1
          AND status = 'active'
          AND proposed_by = 'system'
          AND skill_descriptor = ANY($2)`,
      [TENANT, [...ALL_NEW_DESCRIPTORS]],
    );

    for (const r of rows) {
      expect(
        r.allowed_tools.length,
        `${r.skill_descriptor} must have at least one allowed_tool`,
      ).toBeGreaterThan(0);

      for (const t of r.allowed_tools) {
        expect(
          BASELINE_CORE_TOOLS_V2.has(t),
          `${r.skill_descriptor}.allowed_tools contains ${t} which is NOT in BASELINE_CORE_PACK v2`,
        ).toBe(true);

        expect(
          DOMAIN_TOOLS.has(t),
          `${r.skill_descriptor}.allowed_tools must NOT contain domain tool ${t}`,
        ).toBe(false);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Test 4 — each gap tool appears in at least one baseline skill
  // -----------------------------------------------------------------------
  it('gap tools (risk_signal_classify, conversation_summary_compose, conversation_state_update) appear in at least one skill', async () => {
    const { rows } = await pg.pool.query<{
      allowed_tools: string[];
    }>(
      `SELECT allowed_tools
         FROM skills
        WHERE tenant_id = $1
          AND status = 'active'
          AND proposed_by = 'system'
          AND skill_descriptor = ANY($2)`,
      [TENANT, [...ALL_NEW_DESCRIPTORS]],
    );

    const allAllowedTools = rows.flatMap((r) => r.allowed_tools);

    for (const gapTool of GAP_TOOLS) {
      expect(
        allAllowedTools,
        `gap tool ${gapTool} must appear in at least one baseline skill's allowed_tools`,
      ).toContain(gapTool);
    }
  });

  // -----------------------------------------------------------------------
  // Test 5 — all new rows have usage_policy set (not NULL)
  // -----------------------------------------------------------------------
  it('all 8 new baseline skill rows have usage_policy set (not NULL)', async () => {
    const { rows } = await pg.pool.query<{
      skill_descriptor: string;
      usage_policy: unknown;
    }>(
      `SELECT skill_descriptor, usage_policy
         FROM skills
        WHERE tenant_id = $1
          AND status = 'active'
          AND proposed_by = 'system'
          AND skill_descriptor = ANY($2)`,
      [TENANT, [...ALL_NEW_DESCRIPTORS]],
    );

    expect(rows).toHaveLength(ALL_NEW_DESCRIPTORS.length);
    for (const r of rows) {
      expect(
        r.usage_policy,
        `${r.skill_descriptor} must have usage_policy set`,
      ).not.toBeNull();
    }
  });

  // -----------------------------------------------------------------------
  // Test 6 — migration 080 idempotency: re-running inserts no duplicate rows
  // -----------------------------------------------------------------------
  it('migration 080 idempotency — re-running the forward migration inserts no duplicate rows', async () => {
    const sql = await readFile(
      new URL('../../migrations/080_baseline_skills_v2.sql', import.meta.url),
      'utf8',
    );
    // Apply the forward migration body a second time.
    await pg.pool.query(sql);

    // The 8 expected active rows must still be exactly 8 — no duplicates.
    const { rows } = await pg.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM skills
        WHERE tenant_id = $1
          AND status = 'active'
          AND proposed_by = 'system'
          AND skill_descriptor = ANY($2)`,
      [TENANT, [...ALL_NEW_DESCRIPTORS]],
    );
    expect(Number(rows[0]!.count)).toBe(ALL_NEW_DESCRIPTORS.length);
  });

  // -----------------------------------------------------------------------
  // Test 7 — findActive surfaces a new baseline skill for any agent (tenant-wide)
  // -----------------------------------------------------------------------
  it('baseline skills are tenant-wide visible to any agent (findActive escalate_on_risk)', async () => {
    await tenantContextMod.runWithTenantContext(
      { tenant_id: TENANT, agent_id: AGENT },
      async () => {
        const row = await skillsRepoMod.skillsRepo.findActive('escalate_on_risk');
        expect(row, 'findActive(escalate_on_risk) must not be null').not.toBeNull();
        expect(row!.agent_id).toBeNull(); // tenant-wide row
        expect(row!.execution_mode).toBe('tool_mediated');
        expect(row!.status).toBe('active');
      },
    );
  });

  it('all 8 new baseline skills are findable by descriptor under the default agent', async () => {
    await tenantContextMod.runWithTenantContext(
      { tenant_id: TENANT, agent_id: AGENT },
      async () => {
        for (const descr of ALL_NEW_DESCRIPTORS) {
          const row = await skillsRepoMod.skillsRepo.findActive(descr);
          expect(row, `findActive(${descr}) must not be null`).not.toBeNull();
          expect(row!.agent_id).toBeNull();
          expect(row!.status).toBe('active');
          expect(row!.execution_mode).toBe('tool_mediated');
        }
      },
    );
  });
});
