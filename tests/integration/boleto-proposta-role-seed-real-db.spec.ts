/**
 * Issue #415 — boleto proposta attendant ROLE + role-specific SKILLS seed
 * (migration 079) on REAL Postgres.
 *
 * Proves the acceptance criteria end-to-end against the migrated schema:
 *   - the role `whatsapp_boleto_proposta_attendant` is seeded with the EXACT
 *     display name and the 6 granted tool packs (role → tool-pack axis);
 *   - the 8 role-specific skills are seeded TENANT-WIDE (`agent_id IS NULL`,
 *     `status='active'`, `proposed_by='system'`, v1), each scoped to the role via
 *     `applicable_to_role` (role → skill axis);
 *   - the seed is IDEMPOTENT (re-running 079 creates no duplicates);
 *   - tenant isolation: the seed is scoped to tenant 'default' and the skills
 *     repo never surfaces these skills for a DIFFERENT tenant.
 *
 * ---------------------------------------------------------------------------
 * RUNTIME REQUIREMENT — DOCKER DAEMON. Mirrors
 * tests/integration/baseline-skills-seed-real-db.spec.ts: gated behind a Docker
 * probe; run via `npm run test:integration:real-db`. This suite did NOT run in
 * the implementing environment (no Docker / Postgres); it runs in CI's
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

const TENANT = 'default';
const AGENT = 'default';
const ROLE_KEY = 'whatsapp_boleto_proposta_attendant';
const DISPLAY_NAME = 'Atendente de Boleto Proposta - WhatsApp';

const SKILL_KEYS = [
  'identify_company_customer',
  'inspect_customer_billing_context',
  'cancel_proposal_billing',
  'refund_intake',
  'refund_followup',
  'analyze_customer_documents',
  'answer_boleto_proposal_questions',
  'evaluate_escalation_need',
] as const;

const TOOL_PACKS = [
  'boleto_proposal_read_pack',
  'boleto_proposal_write_pack',
  'refund_intake_pack',
  'refund_followup_pack',
  'document_analysis_pack',
  'risk_escalation_pack',
] as const;

d('boleto proposta role + skills seed (migration 079) — real DB', () => {
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

  it('seeds the role with the EXACT key, display name, and 6 granted packs', async () => {
    const { rows } = await pg.pool.query<{
      role_key: string;
      display_name: string;
      is_default: boolean;
      active: boolean;
      granted_packs: string[];
      prompt_addendum: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT role_key, display_name, is_default, active, granted_packs, prompt_addendum, metadata
         FROM roles
        WHERE tenant_id = $1 AND agent_id = $2 AND role_key = $3`,
      [TENANT, AGENT, ROLE_KEY],
    );
    expect(rows).toHaveLength(1);
    const role = rows[0]!;
    expect(role.display_name).toBe(DISPLAY_NAME);
    expect(role.is_default).toBe(false);
    expect(role.active).toBe(true);
    expect([...role.granted_packs].sort()).toEqual([...TOOL_PACKS].sort());
    // prompt_addendum is the role's only behavioural injection (taxonomy §3).
    expect(role.prompt_addendum).toBeTruthy();
    // Responsibility + objectives available to Admin UI / runtime config.
    expect(role.metadata['responsibility']).toBeTruthy();
    expect(Array.isArray(role.metadata['operational_objectives'])).toBe(true);
  });

  it('seeds the 8 role-specific skills tenant-wide, active, scoped to the role', async () => {
    const { rows } = await pg.pool.query<{
      skill_descriptor: string;
      agent_id: string | null;
      status: string;
      proposed_by: string;
      approved_by: string | null;
      version: number;
      applicable_to_role: string[];
      allowed_tools: string[];
      policy_descriptors: string[];
    }>(
      `SELECT skill_descriptor, agent_id, status, proposed_by, approved_by,
              version, applicable_to_role, allowed_tools, policy_descriptors
         FROM skills
        WHERE tenant_id = $1
          AND $2 = ANY(applicable_to_role)
        ORDER BY skill_descriptor`,
      [TENANT, ROLE_KEY],
    );
    expect(rows.map((r) => r.skill_descriptor).sort()).toEqual([...SKILL_KEYS].sort());
    for (const r of rows) {
      expect(r.agent_id, `${r.skill_descriptor} must be tenant-wide`).toBeNull();
      expect(r.status).toBe('active');
      expect(r.proposed_by).toBe('system');
      expect(r.approved_by).toBe('system');
      expect(r.version).toBe(1);
      expect(r.applicable_to_role).toContain(ROLE_KEY);
    }
  });

  it('refund is split — intake can create, followup is status-only', async () => {
    const byKey = async (key: string) => {
      const { rows } = await pg.pool.query<{ allowed_tools: string[] }>(
        `SELECT allowed_tools FROM skills WHERE tenant_id=$1 AND skill_descriptor=$2 AND version=1`,
        [TENANT, key],
      );
      return rows[0]!.allowed_tools;
    };
    expect(await byKey('refund_intake')).toContain('refund_create');
    expect(await byKey('refund_followup')).not.toContain('refund_create');
    expect(await byKey('refund_followup')).toContain('refund_lookup');
  });

  it('write-intent skills carry policy descriptors; non-write skills do not', async () => {
    const byKey = async (key: string) => {
      const { rows } = await pg.pool.query<{ policy_descriptors: string[] }>(
        `SELECT policy_descriptors FROM skills WHERE tenant_id=$1 AND skill_descriptor=$2 AND version=1`,
        [TENANT, key],
      );
      return rows[0]!.policy_descriptors;
    };
    expect((await byKey('cancel_proposal_billing')).length).toBeGreaterThan(0);
    expect(await byKey('refund_intake')).toEqual(
      expect.arrayContaining([
        'confirm_before_write_policy',
        'small_risk_write_policy',
        'human_confirmation_policy',
      ]),
    );
    expect(await byKey('refund_followup')).toEqual([]);
    expect(await byKey('answer_boleto_proposal_questions')).toEqual([]);
  });

  it('re-running migration 079 is IDEMPOTENT (no duplicate role or skill rows)', async () => {
    const sql = await readFile(
      new URL('../../migrations/079_boleto_proposta_attendant_role_and_skills.sql', import.meta.url),
      'utf8',
    );
    await pg.pool.query(sql);

    const role = await pg.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM roles WHERE tenant_id=$1 AND role_key=$2`,
      [TENANT, ROLE_KEY],
    );
    expect(Number(role.rows[0]!.count)).toBe(1);

    const skillsCount = await pg.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM skills WHERE tenant_id=$1 AND $2 = ANY(applicable_to_role)`,
      [TENANT, ROLE_KEY],
    );
    expect(Number(skillsCount.rows[0]!.count)).toBe(SKILL_KEYS.length);
  });

  it('the role-specific skills are VISIBLE to the selector for the default agent', async () => {
    await tenantContextMod.runWithTenantContext(
      { tenant_id: TENANT, agent_id: AGENT },
      async () => {
        for (const descr of SKILL_KEYS) {
          const row = await skillsRepoMod.skillsRepo.findActive(descr);
          expect(row, `findActive(${descr})`).not.toBeNull();
          expect(row!.agent_id).toBeNull(); // tenant-wide
          expect(row!.applicable_to_role).toContain(ROLE_KEY);
        }
      },
    );
  });

  it('TENANT ISOLATION — the seeded skills never surface for a different tenant', async () => {
    await tenantContextMod.runWithTenantContext(
      { tenant_id: 'some-other-tenant', agent_id: 'whatever' },
      async () => {
        for (const descr of SKILL_KEYS) {
          const row = await skillsRepoMod.skillsRepo.findActive(descr);
          expect(row, `${descr} must NOT be visible cross-tenant`).toBeNull();
        }
      },
    );
  });
});
