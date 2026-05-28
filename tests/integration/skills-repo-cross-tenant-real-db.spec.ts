/**
 * Issue #218 — Cross-tenant isolation proof on REAL Postgres (P9a).
 *
 * This is the real-DB complement to the in-memory proof in
 * `tests/unit/skills/skills-repo-cross-tenant-isolation.spec.ts` (PR #222).
 *
 * Why both?
 *   - The in-memory spec proves the WHERE clause shape inside the repo by
 *     evaluating drizzle predicates against a hand-rolled fake. That is fast
 *     and exhaustive across overload branches.
 *   - The Codex review of PR #222 explicitly flagged that the fake CANNOT
 *     prove the real `ORDER BY agent_id IS NULL` tie-break semantics in
 *     Postgres — production stacks an ORDER BY on a SQL boolean expression
 *     that, in Postgres, sorts FALSE before TRUE (NULLS LAST). The fake
 *     models that, but a real-Postgres pass closes the residual doubt.
 *
 * This spec runs the in-memory cross-tenant scenarios against a real
 * pgvector/pgvector:pg16 testcontainer with the FULL production migration
 * chain applied. Adversarial scenarios from PR #222 are mirrored 1:1; the
 * critical `seedTenantWideOnlyBFirst` case (only tenant-wide rows from BOTH
 * tenants — the ORDER BY tie-break is the SOLE disambiguator) is exercised
 * directly because that is the gap the in-memory fake could not prove.
 *
 * ---------------------------------------------------------------------------
 * RUNTIME REQUIREMENT — DOCKER DAEMON
 *
 * This spec requires a reachable Docker daemon. Locally that means Docker
 * Desktop running (or equivalent). In CI it requires a job with Docker
 * enabled — the existing `integration` CI job uses postgres SERVICE
 * containers (no Docker daemon inside the runner), so testcontainer-based
 * specs need a separate job. Until that lands, this suite is gated behind
 * an explicit npm script:
 *
 *     npm run test:integration:real-db
 *
 * Setting `SKIP_DOCKER_TESTS=1` forces skip (handy for `vitest --watch`).
 * ---------------------------------------------------------------------------
 *
 * Mutation-kill / proof strength:
 *   The strongest scenarios in the in-memory spec relied on the fake to
 *   detect a tenant leak. Here we rely on REAL Postgres: if the production
 *   query EVER dropped the `tenant_id` WHERE filter, the tenant-wide-only
 *   adversarial seed would surface the wrong tenant's row under the routed
 *   tenant's context. We do NOT monkey-patch production to drop the filter
 *   in this PR (test-only constraint per dispatch); a future task could add
 *   a small "mutation harness" that runs the same queries with a hand-built
 *   no-tenant predicate and asserts they FAIL — surfacing as test-only
 *   follow-up work.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  startPostgresContainer,
  stopPostgresContainer,
  isDockerAvailable,
  type StartedPostgres,
} from './_fixtures/postgres-testcontainer.js';

// We import these LATE (inside beforeAll) because production `@/db/client.js`
// captures `DATABASE_URL` at module load. The container URI is only known
// after the container starts — so we must set the env BEFORE the first
// import of any module that pulls in the db client.
//
// Typed lazy holders. `let` instead of `const` keeps TS happy and lets us
// assign inside beforeAll without `// @ts-expect-error`.
type SkillsRepoModule = typeof import('@/control-plane/skill-registry/skills-repo.js');
type TenantContextModule = typeof import('@/db/tenant-context.js');
let skillsRepoMod: SkillsRepoModule;
let tenantContextMod: TenantContextModule;

let pg: StartedPostgres;

// Test-wide skip when Docker is not available. We probe the container
// runtime synchronously at module-load (top-level await) so an unreachable
// daemon cleanly maps to a SKIPPED suite, not a failed beforeAll. The probe
// uses testcontainers' own runtime-discovery helper so it honours the same
// auto-detection as start() would — DOCKER_HOST, default sockets per OS,
// Rancher/Colima/podman, etc. Setting SKIP_DOCKER_TESTS=1 forces skip.
const SHOULD_RUN = await isDockerAvailable();
const d = SHOULD_RUN ? describe : describe.skip;

// Tenant slugs we seed. Distinct from the legacy 'default' tenant that
// migration 007 seeds so we don't trip the `created_at` overlap or step on
// any other test's data. Each test TRUNCATEs `skills` in beforeEach to avoid
// cross-test contamination.
const TENANT_A = 'tenant-A-issue-218';
const TENANT_B = 'tenant-B-issue-218';
const AGENT_A = 'agent-A-issue-218';
const AGENT_B = 'agent-B-issue-218';

interface SeedSkill {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  skill_descriptor: string;
  category: string;
  status: string;
  version: number;
}

/**
 * Insert a skill row directly via raw SQL so we can control insertion order
 * (which matters for the adversarial seeds — see PR #222 review item 3).
 * Mirrors `baseRow` in the in-memory spec: only the fields that participate
 * in the WHERE/ORDER BY are non-default; the rest fall back to schema
 * defaults (empty jsonb / text[] / etc.).
 */
async function insertSeed(row: SeedSkill): Promise<void> {
  await pg.pool.query(
    `
    INSERT INTO skills (
      id, tenant_id, agent_id, skill_descriptor, category, execution_mode,
      goal, when_to_use, input_schema, output_schema, status, version,
      proposed_by, activated_at, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, 'prompt_only',
      'goal', 'when', '{}'::jsonb, '{}'::jsonb, $6, $7,
      'test', now(), now()
    )
    `,
    [row.id, row.tenant_id, row.agent_id, row.skill_descriptor, row.category, row.status, row.version],
  );
}

/**
 * Truncate skills (and pre-create tenants + agents the FK requires). Called
 * in beforeEach so every test starts from the same fixture-free baseline.
 */
async function resetSkills(): Promise<void> {
  // skills doesn't have an FK to tenants in the migration (see 043_p9a_skills.sql
  // — `tenant_id TEXT NOT NULL` with no REFERENCES), so we don't need to
  // create rows in `tenants` first. But we DO need to clear any prior test's
  // skills rows for the slugs we use.
  await pg.pool.query('DELETE FROM skills WHERE tenant_id IN ($1, $2)', [TENANT_A, TENANT_B]);
}

// ---------------------------------------------------------------------------
// Seed fixtures — bit-for-bit mirrors of the in-memory spec (PR #222) so a
// real-DB regression surfaces in the same shape as the in-memory one would.
// ---------------------------------------------------------------------------

/** Default seed (tenant-A first, then tenant-B). */
async function seedTwoTenants(): Promise<void> {
  // tenant-A: own agent skill + tenant-wide skill (shared INSIDE tenant-A).
  await insertSeed({ id: 's_A_owned',  tenant_id: TENANT_A, agent_id: AGENT_A, skill_descriptor: 'shared.descr', category: 'tool_mediated', status: 'active', version: 1 });
  await insertSeed({ id: 's_A_shared', tenant_id: TENANT_A, agent_id: null,    skill_descriptor: 'shared.descr', category: 'tool_mediated', status: 'active', version: 1 });
  // tenant-B: own agent skill + tenant-wide skill. The s_B_shared row is the
  // canonical leak risk — tenant-wide for tenant-B but MUST NEVER appear
  // under tenant-A's context.
  await insertSeed({ id: 's_B_owned',  tenant_id: TENANT_B, agent_id: AGENT_B, skill_descriptor: 'shared.descr', category: 'tool_mediated', status: 'active', version: 1 });
  await insertSeed({ id: 's_B_shared', tenant_id: TENANT_B, agent_id: null,    skill_descriptor: 'shared.descr', category: 'tool_mediated', status: 'active', version: 1 });
  // Extras so listAll/listSummaries surface > 1 row per tenant and the
  // cross-tenant absence is a stronger signal.
  await insertSeed({ id: 's_A_extra', tenant_id: TENANT_A, agent_id: AGENT_A, skill_descriptor: 'a.extra', category: 'classify', status: 'active', version: 1 });
  await insertSeed({ id: 's_B_extra', tenant_id: TENANT_B, agent_id: AGENT_B, skill_descriptor: 'b.extra', category: 'classify', status: 'active', version: 1 });
}

/** Adversarial seed: tenant-B FIRST, then tenant-A (PR #222 review item 3). */
async function seedTwoTenantsReverse(): Promise<void> {
  await insertSeed({ id: 's_B_owned',  tenant_id: TENANT_B, agent_id: AGENT_B, skill_descriptor: 'shared.descr', category: 'tool_mediated', status: 'active', version: 1 });
  await insertSeed({ id: 's_B_shared', tenant_id: TENANT_B, agent_id: null,    skill_descriptor: 'shared.descr', category: 'tool_mediated', status: 'active', version: 1 });
  await insertSeed({ id: 's_A_owned',  tenant_id: TENANT_A, agent_id: AGENT_A, skill_descriptor: 'shared.descr', category: 'tool_mediated', status: 'active', version: 1 });
  await insertSeed({ id: 's_A_shared', tenant_id: TENANT_A, agent_id: null,    skill_descriptor: 'shared.descr', category: 'tool_mediated', status: 'active', version: 1 });
  await insertSeed({ id: 's_B_extra', tenant_id: TENANT_B, agent_id: AGENT_B, skill_descriptor: 'b.extra', category: 'classify', status: 'active', version: 1 });
  await insertSeed({ id: 's_A_extra', tenant_id: TENANT_A, agent_id: AGENT_A, skill_descriptor: 'a.extra', category: 'classify', status: 'active', version: 1 });
}

/**
 * CRITICAL adversarial seed for the `agent_id IS NULL` branch (PR #222 review
 * item 3 — the gap the in-memory fake could not prove on real Postgres).
 *
 * Production findActive's default-arg path builds:
 *   WHERE tenant_id=ctx AND descriptor=... AND status='active'
 *         AND (agent_id = ctxAgent OR agent_id IS NULL)
 *   ORDER BY agent_id IS NULL ASC
 *   LIMIT 1
 *
 * If a regression dropped the `tenant_id` filter:
 *   - The seed has ONLY tenant-wide rows (no agent-scoped rows), so BOTH
 *     `s_A_shared` and `s_B_shared` would match the (now broken) WHERE
 *     because both have `agent_id IS NULL`.
 *   - The ORDER BY `agent_id IS NULL ASC` evaluates the SAME truthy value
 *     for both rows → cannot disambiguate by sort key.
 *   - `LIMIT 1` then returns whichever was inserted FIRST → tenant-B's row
 *     under tenant-A's context → leak surfaces.
 *
 * The unique partial index on `(tenant_id, COALESCE(agent_id, 'tenant_wide'),
 * skill_descriptor) WHERE status='active'` (migration 043 line 73) allows
 * ONE active tenant-wide row per tenant for the same descriptor — exactly
 * what we exercise here.
 */
async function seedTenantWideOnlyBFirst(): Promise<void> {
  // B's tenant-wide row FIRST so it sorts ahead in insertion order.
  await insertSeed({ id: 's_B_shared', tenant_id: TENANT_B, agent_id: null, skill_descriptor: 'shared.descr', category: 'tool_mediated', status: 'active', version: 1 });
  await insertSeed({ id: 's_A_shared', tenant_id: TENANT_A, agent_id: null, skill_descriptor: 'shared.descr', category: 'tool_mediated', status: 'active', version: 1 });
}

/** Symmetric counterpart: A FIRST. */
async function seedTenantWideOnlyAFirst(): Promise<void> {
  await insertSeed({ id: 's_A_shared', tenant_id: TENANT_A, agent_id: null, skill_descriptor: 'shared.descr', category: 'tool_mediated', status: 'active', version: 1 });
  await insertSeed({ id: 's_B_shared', tenant_id: TENANT_B, agent_id: null, skill_descriptor: 'shared.descr', category: 'tool_mediated', status: 'active', version: 1 });
}

function idsOf<T extends { id: string }>(rows: T[]): string[] {
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
d('skillsRepo — cross-tenant isolation on REAL Postgres (issue #218)', () => {
  beforeAll(async () => {
    pg = await startPostgresContainer();
    // Set DATABASE_URL to the container's URI BEFORE importing anything that
    // pulls in @/db/client.js. The drizzle Pool captures the URL at module
    // load; if we imported earlier, it would point at the unreachable
    // localhost default from tests/setup.ts.
    process.env.DATABASE_URL = pg.uri;
    skillsRepoMod = await import('@/control-plane/skill-registry/skills-repo.js');
    tenantContextMod = await import('@/db/tenant-context.js');
  }, /* timeout for image pull on first run */ 180_000);

  afterAll(async () => {
    if (pg) await stopPostgresContainer(pg);
  });

  beforeEach(async () => {
    await resetSkills();
  });

  const runAs = async <T>(tenant: string, agent: string, fn: () => Promise<T>): Promise<T> =>
    tenantContextMod.runWithTenantContext({ tenant_id: tenant, agent_id: agent }, fn);

  // -------------------------------------------------------------------------
  // listByCategory
  // -------------------------------------------------------------------------
  it('listByCategory: tenant-A query never returns tenant-B rows', async () => {
    await seedTwoTenants();
    const got = await runAs(TENANT_A, AGENT_A, () =>
      skillsRepoMod.skillsRepo.listByCategory('tool_mediated'),
    );
    const ids = idsOf(got);
    expect(ids.sort()).toEqual(['s_A_owned', 's_A_shared'].sort());
    expect(got.every((r) => r.tenant_id === TENANT_A)).toBe(true);
  });

  it('listByCategory: symmetric — tenant-B query never returns tenant-A rows', async () => {
    await seedTwoTenants();
    const got = await runAs(TENANT_B, AGENT_B, () =>
      skillsRepoMod.skillsRepo.listByCategory('tool_mediated'),
    );
    const ids = idsOf(got);
    expect(ids.sort()).toEqual(['s_B_owned', 's_B_shared'].sort());
    expect(got.every((r) => r.tenant_id === TENANT_B)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // listAll / listSummaries (per-row tenant_id check)
  // -------------------------------------------------------------------------
  it('listAll: every row in tenant-A result is tenant-A (real-Postgres scope filter)', async () => {
    await seedTwoTenants();
    const got = await runAs(TENANT_A, AGENT_A, () => skillsRepoMod.skillsRepo.listAll());
    expect(got.every((r) => r.tenant_id === TENANT_A)).toBe(true);
    expect(idsOf(got).sort()).toEqual(['s_A_extra', 's_A_owned', 's_A_shared'].sort());
  });

  it('listAll: symmetric — every row in tenant-B result is tenant-B', async () => {
    await seedTwoTenants();
    const got = await runAs(TENANT_B, AGENT_B, () => skillsRepoMod.skillsRepo.listAll());
    expect(got.every((r) => r.tenant_id === TENANT_B)).toBe(true);
    expect(idsOf(got).sort()).toEqual(['s_B_extra', 's_B_owned', 's_B_shared'].sort());
  });

  it('listSummariesPage: every row in tenant-A page is tenant-A (per-row tenant_id check)', async () => {
    await seedTwoTenants();
    const page = await runAs(TENANT_A, AGENT_A, () =>
      skillsRepoMod.skillsRepo.listSummariesPage(),
    );
    expect(page.items.every((r) => r.tenant_id === TENANT_A)).toBe(true);
    expect(idsOf(page.items).sort()).toEqual(['s_A_extra', 's_A_owned', 's_A_shared'].sort());
  });

  it('listSummariesPage: symmetric — every row in tenant-B page is tenant-B', async () => {
    await seedTwoTenants();
    const page = await runAs(TENANT_B, AGENT_B, () =>
      skillsRepoMod.skillsRepo.listSummariesPage(),
    );
    expect(page.items.every((r) => r.tenant_id === TENANT_B)).toBe(true);
    expect(idsOf(page.items).sort()).toEqual(['s_B_extra', 's_B_owned', 's_B_shared'].sort());
  });

  // -------------------------------------------------------------------------
  // getById — both directions
  // -------------------------------------------------------------------------
  it('getById: tenant-A scope cannot read tenant-B ids (incl. tenant-wide)', async () => {
    await seedTwoTenants();
    const leakedOwned = await runAs(TENANT_A, AGENT_A, () =>
      skillsRepoMod.skillsRepo.getById('s_B_owned'),
    );
    const leakedShared = await runAs(TENANT_A, AGENT_A, () =>
      skillsRepoMod.skillsRepo.getById('s_B_shared'),
    );
    expect(leakedOwned).toBeNull();
    expect(leakedShared).toBeNull(); // tenant-WIDE ≠ cross-tenant
    // Positive control: own rows still resolve under tenant-A scope.
    const ownA = await runAs(TENANT_A, AGENT_A, () =>
      skillsRepoMod.skillsRepo.getById('s_A_owned'),
    );
    expect(ownA?.id).toBe('s_A_owned');
  });

  it('getById: symmetric — tenant-B scope cannot read tenant-A ids', async () => {
    await seedTwoTenants();
    const leakedOwned = await runAs(TENANT_B, AGENT_B, () =>
      skillsRepoMod.skillsRepo.getById('s_A_owned'),
    );
    const leakedShared = await runAs(TENANT_B, AGENT_B, () =>
      skillsRepoMod.skillsRepo.getById('s_A_shared'),
    );
    expect(leakedOwned).toBeNull();
    expect(leakedShared).toBeNull();
  });

  // -------------------------------------------------------------------------
  // getByDescriptor — both seed orders (adversarial)
  // -------------------------------------------------------------------------
  describe('getByDescriptor — adversarial seed orders (PR #222 review item 3)', () => {
    for (const seedName of ['A-first', 'B-first'] as const) {
      const doSeed = seedName === 'A-first' ? seedTwoTenants : seedTwoTenantsReverse;

      it(`tenant-A with seed [${seedName}]: returns ONLY a tenant-A row`, async () => {
        await doSeed();
        const got = await runAs(TENANT_A, AGENT_A, () =>
          skillsRepoMod.skillsRepo.getByDescriptor('shared.descr'),
        );
        expect(got).not.toBeNull();
        expect(got!.tenant_id).toBe(TENANT_A);
        expect(['s_A_owned', 's_A_shared']).toContain(got!.id);
      });

      it(`tenant-B with seed [${seedName}]: symmetric — returns ONLY a tenant-B row`, async () => {
        await doSeed();
        const got = await runAs(TENANT_B, AGENT_B, () =>
          skillsRepoMod.skillsRepo.getByDescriptor('shared.descr'),
        );
        expect(got).not.toBeNull();
        expect(got!.tenant_id).toBe(TENANT_B);
        expect(['s_B_owned', 's_B_shared']).toContain(got!.id);
      });
    }
  });

  // -------------------------------------------------------------------------
  // findActive — default + explicit-null branches with adversarial seed order
  // -------------------------------------------------------------------------
  describe('findActive — agent-scoped vs tenant-wide ORDER BY tie-break (real Postgres)', () => {
    it('findActive (default arg): tenant-A prefers agent-scoped over tenant-wide', async () => {
      await seedTwoTenants();
      const got = await runAs(TENANT_A, AGENT_A, () =>
        skillsRepoMod.skillsRepo.findActive('shared.descr'),
      );
      expect(got?.id).toBe('s_A_owned'); // ORDER BY agent_id IS NULL: real agent first
      expect(got?.tenant_id).toBe(TENANT_A);
    });

    it('findActive (default arg): tenant-B prefers agent-scoped over tenant-wide', async () => {
      await seedTwoTenants();
      const got = await runAs(TENANT_B, AGENT_B, () =>
        skillsRepoMod.skillsRepo.findActive('shared.descr'),
      );
      expect(got?.id).toBe('s_B_owned');
      expect(got?.tenant_id).toBe(TENANT_B);
    });

    // ---------------------------------------------------------------------
    // THE critical case the in-memory fake couldn't prove (PR #222 review).
    //
    // Both tenants have ONLY tenant-wide rows for the descriptor. With the
    // production `tenant_id` filter in place, only one matches the WHERE per
    // tenant context — fine. Without it (regression), both match the WHERE,
    // the ORDER BY agent_id IS NULL ASC sees `true=true` and CANNOT
    // disambiguate; `LIMIT 1` then returns whichever was inserted first
    // (B-first → s_B_shared under tenant-A's context → wrong tenant).
    //
    // Real Postgres confirms the production WHERE actually excludes the
    // other tenant's row — the in-memory fake would only prove this for the
    // fake's own predicate semantics.
    // ---------------------------------------------------------------------
    it('findActive (default): TENANT-WIDE-ONLY seed [B-first], tenant-A returns s_A_shared (ORDER BY tie-break on real Postgres)', async () => {
      await seedTenantWideOnlyBFirst();
      const got = await runAs(TENANT_A, AGENT_A, () =>
        skillsRepoMod.skillsRepo.findActive('shared.descr'),
      );
      expect(got).not.toBeNull();
      expect(got!.id).toBe('s_A_shared');
      expect(got!.tenant_id).toBe(TENANT_A);
    });

    it('findActive (default): TENANT-WIDE-ONLY seed [A-first], tenant-B returns s_B_shared (symmetric)', async () => {
      await seedTenantWideOnlyAFirst();
      const got = await runAs(TENANT_B, AGENT_B, () =>
        skillsRepoMod.skillsRepo.findActive('shared.descr'),
      );
      expect(got).not.toBeNull();
      expect(got!.id).toBe('s_B_shared');
      expect(got!.tenant_id).toBe(TENANT_B);
    });

    it('findActive(d, null): explicit tenant-wide branch — tenant-A returns s_A_shared even with B seeded first', async () => {
      await seedTenantWideOnlyBFirst();
      const got = await runAs(TENANT_A, AGENT_A, () =>
        skillsRepoMod.skillsRepo.findActive('shared.descr', null),
      );
      expect(got).not.toBeNull();
      expect(got!.id).toBe('s_A_shared');
      expect(got!.tenant_id).toBe(TENANT_A);
    });

    it('findActive(d, null): symmetric — tenant-B returns s_B_shared even with A seeded first', async () => {
      await seedTenantWideOnlyAFirst();
      const got = await runAs(TENANT_B, AGENT_B, () =>
        skillsRepoMod.skillsRepo.findActive('shared.descr', null),
      );
      expect(got).not.toBeNull();
      expect(got!.id).toBe('s_B_shared');
      expect(got!.tenant_id).toBe(TENANT_B);
    });

    it('findActive(d, explicit-agent): mismatched agent_id throws agent_scope_violation (does not silently leak)', async () => {
      await seedTwoTenants();
      // tenant-A context asking for agent-B's row. MUST throw, not return.
      await expect(
        runAs(TENANT_A, AGENT_A, () =>
          skillsRepoMod.skillsRepo.findActive('shared.descr', AGENT_B),
        ),
      ).rejects.toThrow(/agent_scope_violation/);
    });
  });

  // -------------------------------------------------------------------------
  // listVersions — scope-exact branches (PR #209 finding 3)
  // -------------------------------------------------------------------------
  describe('listVersions — explicit-agent and explicit-null branches', () => {
    it('listVersions(d): legacy default branch — tenant-A history never includes tenant-B versions', async () => {
      await seedTwoTenants();
      const got = await runAs(TENANT_A, AGENT_A, () =>
        skillsRepoMod.skillsRepo.listVersions('shared.descr'),
      );
      const ids = idsOf(got);
      expect(ids.sort()).toEqual(['s_A_owned', 's_A_shared'].sort());
      expect(ids).not.toContain('s_B_owned');
      expect(ids).not.toContain('s_B_shared');
    });

    it('listVersions(d, AGENT_A): explicit-agent branch — tenant-A asks for agent-A — returns only s_A_owned', async () => {
      await seedTwoTenants();
      const got = await runAs(TENANT_A, AGENT_A, () =>
        skillsRepoMod.skillsRepo.listVersions('shared.descr', AGENT_A),
      );
      expect(idsOf(got)).toEqual(['s_A_owned']);
    });

    it('listVersions(d, null): explicit-tenant-wide branch — tenant-A returns only s_A_shared, never tenant-B tenant-wide', async () => {
      await seedTwoTenants();
      const got = await runAs(TENANT_A, AGENT_A, () =>
        skillsRepoMod.skillsRepo.listVersions('shared.descr', null),
      );
      expect(idsOf(got)).toEqual(['s_A_shared']);
    });

    it('listVersions(d, null): symmetric — tenant-B returns only s_B_shared', async () => {
      await seedTwoTenants();
      const got = await runAs(TENANT_B, AGENT_B, () =>
        skillsRepoMod.skillsRepo.listVersions('shared.descr', null),
      );
      expect(idsOf(got)).toEqual(['s_B_shared']);
    });
  });
});
