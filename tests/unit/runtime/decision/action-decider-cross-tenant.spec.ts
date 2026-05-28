/**
 * Issue #226 — `ActionDeciderImpl` fallback `skillsRepo.find` cross-tenant
 * guard + fallback branch coverage.
 *
 * Sibling spec to `tests/unit/skills/skill-entrypoints-cross-tenant.spec.ts`,
 * which proved the DE adapter's `find()` is tenant-scoped by construction but
 * never instantiated the real `ActionDeciderImpl`. The fallback path at
 * `src/runtime/decision/action-decider.ts:161-179` (where `selected_skill` is
 * absent so the decider falls into `this.deps.skillsRepo.find(...)`) and the
 * full fan-out of `action_mode` branches reached via that fallback were
 * therefore NOT exercised end-to-end.
 *
 * Codex review on PR #236 (REQUEST_CHANGES) — what changed in this revision:
 *
 *   1. MAJOR (own from reval): the previous revision mocked `getById` and
 *      re-implemented the tenant filter inside the mock. A mutation removing
 *      `WHERE tenant_id = ...` from the production `getById`
 *      (`src/control-plane/skill-registry/skills-repo.ts:823`) would have
 *      passed the test. This revision uses the SAME pattern as PR #232
 *      (`tests/unit/memory/procedural-cross-tenant.spec.ts`): the REAL
 *      `skillsRepo` runs against a fake DB whose `select()` chain evaluates
 *      the REAL `WHERE` predicate produced by `eq`/`and` against an in-memory
 *      store. Dropping the tenant predicate from production now causes this
 *      spec to fail.
 *
 *   2. MAJOR-1: added 3 missing branches —
 *        a. fallback-resolved `execute_skill` (action-decider.ts:204)
 *        b. tool-reduction-to-empty (`:225`)
 *        c. default `respond` (`:256`)
 *
 *   3. MAJOR-2: `BaseContextPacket` fixtures now centralised in
 *      `tests/fixtures/base-context-packet.ts` (`mkBaseContextPacket`). The
 *      ad-hoc `mkBase` was missing required fields per
 *      `src/runtime/context-packet/types.ts:18-50` (`session_id`,
 *      `actor.role`, `received_at: string`, …).
 *
 *   4. MINOR-3: added a same-ID cross-tenant case proving positional
 *      insensitivity AND id-collision tenant isolation.
 *
 * Strategy:
 *   - Mock `drizzle-orm` so `eq`/`and`/`or`/`sql` produce predicate-bearing
 *     objects (`{ __pred(row) }`) that our fake `select().from().where()`
 *     chain can evaluate against the store.
 *   - Mock `@/db/schema.js` so the `skills` table is a column-proxy
 *     (`{ id: { __col: 'id' }, ... }`) — the production query uses
 *     `eq(skills.tenant_id, ...)`, so the mocked `eq` reads `__col` to know
 *     which row field to compare against.
 *   - Mock `@/db/client.js` with an in-memory `db.select()` chain that
 *     captures the WHERE predicate from `where(...)`, the limit from
 *     `limit(...)`, and on `await` returns the rows whose predicate holds —
 *     so the production `skillsRepo.getById` (which builds
 *     `WHERE tenant_id = getCurrentTenant() AND id = $id` then applies an
 *     agent-scope post-filter in JS) runs END-TO-END against the seeded
 *     store, NOT against a mock that re-implements the filter.
 *   - Import the REAL `skillsRepo` (`@/control-plane/skill-registry/skills-repo.js`)
 *     AFTER the mocks register, the REAL `createProductionDecisionEngineEnv`
 *     (which wraps `skillsRepo.getById` in `runWithTenantContext({scope})`),
 *     and the REAL `ActionDeciderImpl`. The only layer replaced is the SQL
 *     execution engine.
 *
 * Item 2 outcome (issue body #2 — "confirm/harden the fallback `find()`"):
 *   The production `skillsRepo.find()` (prod-env.ts:426) wraps `getById` in
 *   `runWithTenantContext({tenant_id, agent_id})` pinned to the ROUTED scope
 *   passed by ActionDecider, and `getById` (skills-repo.ts:823) filters on
 *   `WHERE tenant_id = getCurrentTenant() AND id = ...` plus an agent-scope
 *   post-filter. This spec proves the end-to-end invariant: the REAL
 *   ActionDeciderImpl driving the REAL adapter `find()` against the REAL
 *   `skillsRepo` cannot resolve cross-tenant skills via the fallback path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// In-memory row store + drizzle/db fakes.
//
// Pattern lifted verbatim from `tests/unit/memory/procedural-cross-tenant.spec.ts`
// (PR #232) so the production code paths exercise the SAME WHERE-predicate
// evaluation, never a mock-level re-implementation of tenant isolation.
// ---------------------------------------------------------------------------
type Row = Record<string, any>;
const store = new Map<unknown, Row[]>();

function tableOf(t: unknown): Row[] {
  if (!store.has(t)) store.set(t, []);
  return store.get(t)!;
}

type Pred = (row: Row) => boolean;
interface PredObj {
  __pred: Pred;
}
function isPredObj(x: unknown): x is PredObj {
  return !!x && typeof x === 'object' && '__pred' in (x as object);
}
interface ColRef {
  __col: string;
}
function isColRef(x: unknown): x is ColRef {
  return !!x && typeof x === 'object' && '__col' in (x as object);
}

// Symbolic SQL marker — for raw fragments like `agent_id IS NULL` in the
// production WHERE clauses (skills-repo.ts findActive/getByDescriptor). The
// fragment is parsed enough to evaluate against the row being matched.
interface SqlExpr {
  __sqlEval: (row: Row) => boolean;
}
function isSqlExpr(x: unknown): x is SqlExpr {
  return !!x && typeof x === 'object' && '__sqlEval' in (x as object);
}

vi.mock('drizzle-orm', () => {
  const evalAny = (x: unknown, row: Row): boolean => {
    if (isPredObj(x)) return x.__pred(row);
    if (isSqlExpr(x)) return x.__sqlEval(row);
    return Boolean(x);
  };
  const eq = (left: unknown, right: unknown): PredObj => ({
    __pred: (row: Row) => {
      const key = isColRef(left) ? left.__col : String(left);
      return row[key] === right;
    },
  });
  const and = (...conds: unknown[]): PredObj => ({
    __pred: (row: Row) => conds.every((c) => evalAny(c, row)),
  });
  const or = (...conds: unknown[]): PredObj => ({
    __pred: (row: Row) => conds.some((c) => evalAny(c, row)),
  });
  const inArray = (col: unknown, vals: unknown[]): PredObj => ({
    __pred: (row: Row) => {
      const key = isColRef(col) ? col.__col : String(col);
      return vals.includes(row[key]);
    },
  });
  const isNull = (col: unknown): PredObj => ({
    __pred: (row: Row) => {
      const key = isColRef(col) ? col.__col : String(col);
      return row[key] === null || row[key] === undefined;
    },
  });
  const ne = (left: unknown, right: unknown): PredObj => ({
    __pred: (row: Row) => {
      const key = isColRef(left) ? left.__col : String(left);
      return row[key] !== right;
    },
  });
  const gt = (left: unknown, right: unknown): PredObj => ({
    __pred: (row: Row) => {
      const key = isColRef(left) ? left.__col : String(left);
      return row[key] > (right as number);
    },
  });
  const lt = (left: unknown, right: unknown): PredObj => ({
    __pred: (row: Row) => {
      const key = isColRef(left) ? left.__col : String(left);
      return row[key] < (right as number);
    },
  });
  // desc is used in orderBy only — pass-through (we don't assert order beyond
  // limit(1) results which are determined by predicate match in our fake).
  const desc = (col: unknown) => col;
  // sql`...` for fragments like `agent_id IS NULL`. The skills-repo.ts uses
  // it for the tenant-wide branch of the agent-scope OR. We parse a tiny
  // dialect: anything containing `agent_id IS NULL` evaluates to row.agent_id
  // == null; anything else falls back to a symbolic pass that never matches
  // (so an unrecognised expr can't silently widen the predicate).
  const sql = (strings: TemplateStringsArray, ..._vals: unknown[]): SqlExpr => {
    const text = strings.join('').toLowerCase();
    if (text.includes('agent_id is null')) {
      return {
        __sqlEval: (row: Row) =>
          row.agent_id === null || row.agent_id === undefined,
      };
    }
    // Unrecognised — fail-closed so a future refactor doesn't silently widen.
    return { __sqlEval: () => false };
  };
  // The production code occasionally uses `type SQL` — provide a type marker.
  return { eq, and, or, ne, gt, lt, inArray, isNull, desc, sql };
});

function makeTable(): any {
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => ({ __col: prop }),
    },
  );
}

// vi.mock cannot resolve exports via a Proxy `get` trap — vitest enumerates
// own-properties at module-binding time. We explicitly list every table
// `src/db/repositories.ts` and `src/control-plane/skill-registry/skills-repo.ts`
// import so top-level binding resolution succeeds. Only `skills` is exercised
// at runtime by this test; the rest are inert proxy stubs.
vi.mock('@/db/schema.js', () => {
  const tables = [
    'skills',
    'admin_audit_log',
    'learned_rules',
    'procedure_status_events',
    'pessoas',
    'permissoes',
    'permission_profiles',
    'conversas',
    'mensagens',
    'entidades',
    'contas_bancarias',
    'transacoes',
    'contrapartes',
    'categorias',
    'agent_facts',
    'pending_questions',
    'idempotency_keys',
    'audit_log',
    'workflows',
    'workflow_steps',
    'entity_states',
    'self_state',
    'system_health_events',
    'dead_letter_jobs',
    'tenants',
    'agents',
    'cognitive_module_log',
    'cognitive_candidates',
    'memory_entry',
    'behavioral_hint',
    'agent_capabilities_domain',
    'agent_capabilities_skill',
    'agent_capability_gaps',
    'procedure_definitions',
    'procedure_assignments',
    'procedure_executions',
    'procedure_execution_events',
    'procedure_selector_decisions',
    'procedure_tests',
    'procedure_metrics',
    'agent_operational_profile_versions',
    'agent_drift_alerts',
    'gap_escalation_rules',
    'capability_proposals',
    'capability_test_results',
    'channels',
    'roles',
    'channel_policies',
    'role_selector_decisions',
    'app_users',
    'app_sessions',
    'proposal_approvals',
    'debug_snapshot_grants',
    'global_settings',
  ];
  const out: Record<string, any> = {};
  for (const t of tables) out[t] = makeTable();
  // PROFILE_BODY_SCHEMA_VERSION is imported by some downstream modules.
  out.PROFILE_BODY_SCHEMA_VERSION = '1.0.0';
  return out;
});

class SelectBuilder {
  private _table: unknown = null;
  private _pred: Pred = () => true;
  private _limit = Infinity;
  from(t: unknown) {
    this._table = t;
    return this;
  }
  where(p: unknown) {
    if (isPredObj(p)) this._pred = p.__pred;
    else if (isSqlExpr(p)) this._pred = (row) => p.__sqlEval(row);
    return this;
  }
  limit(n: number) {
    this._limit = n;
    return this;
  }
  orderBy(..._args: unknown[]) {
    return this;
  }
  private exec(): Row[] {
    return tableOf(this._table)
      .filter(this._pred)
      .slice(0, this._limit)
      .map((r) => ({ ...r }));
  }
  then(resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) {
    try {
      resolve(this.exec());
    } catch (e) {
      reject?.(e);
    }
  }
}

class InsertBuilder {
  values() {
    return {
      returning: () => ({ then: (r: (v: Row[]) => unknown) => r([]) }),
    };
  }
}

class UpdateBuilder {
  set(_v: Record<string, unknown>) {
    return this;
  }
  where(_p: unknown) {
    return this;
  }
  returning(_cols: unknown) {
    return this;
  }
  then(resolve: (v: Row[]) => unknown) {
    resolve([]);
  }
}

function makeDbHandle() {
  return {
    select: (_cols?: unknown) => new SelectBuilder(),
    insert: () => new InsertBuilder(),
    update: () => new UpdateBuilder(),
  };
}

vi.mock('@/db/client.js', () => {
  const db = makeDbHandle();
  const withTx = async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(makeDbHandle());
  return {
    db,
    withTx,
    pool: {},
    isDbConnected: () => true,
    probeDb: async () => true,
    shutdownDb: async () => {},
  };
});

// ---------------------------------------------------------------------------
// Imports AFTER mocks — these resolve to the production code, but their
// `drizzle-orm`/`@/db/schema.js`/`@/db/client.js` bindings hit the fakes
// above. Critically we are NOT mocking `@/control-plane/skill-registry/skills-repo.js`
// any more — the REAL `skillsRepo.getById` runs and its WHERE predicate is
// evaluated by our fake `SelectBuilder`. A regression dropping the tenant
// filter from `getById` would surface as a failing test here.
// ---------------------------------------------------------------------------
import { createProductionDecisionEngineEnv } from '@/runtime/decision/prod-env.js';
import { ActionDeciderImpl } from '@/runtime/decision/action-decider.js';
import type { ActionDeciderInput } from '@/runtime/decision/types.js';
import type { NewSkillRow } from '@/db/schema.js';
import { mkBaseContextPacket } from '../../../fixtures/base-context-packet.js';
import { mkSkillRow } from '../../../fixtures/skill-row.js';

// ---------------------------------------------------------------------------
// Seed shape. We seed using the REAL `NewSkillRow` type (`skills.$inferInsert`)
// via the centralised `mkSkillRow` fixture (Codex PR #236 review v2): rows
// carry every NOT NULL column of the production schema, not just the columns
// `skillRowToSkill` (prod-env.ts) projects from + the columns the WHERE
// predicate inspects (`tenant_id`, `id`, `agent_id`, `status`). A future
// regression where the production INSERT path adds a real constraint OR where
// a code path begins reading one of the previously-omitted JSONB columns
// (`goal`/`procedure`/`input_schema`/...) would PASS the stripped-down
// fixture but FAIL in production. Mirroring the full row shape closes that
// gap.
// ---------------------------------------------------------------------------
type SeedRow = NewSkillRow;

function mkRow(over: {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  descriptor?: string;
  category?: NewSkillRow['category'];
  execution_mode?: NewSkillRow['execution_mode'];
  allowed_tools?: string[];
}): SeedRow {
  return mkSkillRow({
    id: over.id,
    tenant_id: over.tenant_id,
    agent_id: over.agent_id,
    skill_descriptor: over.descriptor ?? over.id,
    category: over.category ?? 'tool_mediated',
    execution_mode: over.execution_mode ?? 'tool_mediated',
    allowed_tools: over.allowed_tools ?? ['tool_for_' + over.id],
  });
}

// ---------------------------------------------------------------------------
// Two-tenant seeding helpers. We rebuild the store per test so seed insertion
// ORDER can be varied (adversarial direction).
// ---------------------------------------------------------------------------
let skillsTable: any;

function pushSkills(rows: SeedRow[]) {
  tableOf(skillsTable).push(...rows);
}

function seedDefault() {
  pushSkills([
    mkRow({ id: 's_A_owned',  tenant_id: 'tenant-A', agent_id: 'agent-A' }),
    mkRow({ id: 's_A_shared', tenant_id: 'tenant-A', agent_id: null      }),
    mkRow({ id: 's_B_owned',  tenant_id: 'tenant-B', agent_id: 'agent-B' }),
    mkRow({ id: 's_B_shared', tenant_id: 'tenant-B', agent_id: null      }),
  ]);
}

/**
 * Adversarial direction — tenant-B inserted FIRST. Mirrors the
 * `seedTwoTenantsReverse` pattern from PR #232: if a regression silently
 * dropped the `tenant_id` filter from `getById`'s WHERE clause, the store
 * order would dictate which row surfaces, and tenant-B's row would slide in
 * front of tenant-A's. With the filter present, only the routed tenant's row
 * matches and the order is irrelevant.
 */
function seedBFirst() {
  pushSkills([
    mkRow({ id: 's_B_owned',  tenant_id: 'tenant-B', agent_id: 'agent-B' }),
    mkRow({ id: 's_B_shared', tenant_id: 'tenant-B', agent_id: null      }),
    mkRow({ id: 's_A_owned',  tenant_id: 'tenant-A', agent_id: 'agent-A' }),
    mkRow({ id: 's_A_shared', tenant_id: 'tenant-A', agent_id: null      }),
  ]);
}

// ---------------------------------------------------------------------------
// Test helpers — build an ActionDeciderInput that drives the FALLBACK branch
// (selected_skill_id set, selected_skill absent).
// ---------------------------------------------------------------------------
function mkInputFallback(args: {
  tenant_id: string;
  agent_id: string;
  selected_skill_id: string;
  midPepOutcome?: ActionDeciderInput['midPepOutcome'];
}): ActionDeciderInput {
  return {
    base: mkBaseContextPacket({
      tenant_id: args.tenant_id,
      agent_id: args.agent_id,
    }),
    intent: { label: 'shared.descr', confidence: 0.9 },
    risk: { level: 'low', reasons: [], requires_human_review: false },
    workflow: { mode: 'none' },
    // FALLBACK PATH: selected_skill_id present, selected_skill ABSENT — so
    // ActionDecider must resolve via `deps.skillsRepo.find()`
    // (action-decider.ts:174).
    skill: {
      selected_skill_id: args.selected_skill_id,
      candidate_skill_ids: [args.selected_skill_id],
    },
    midPepOutcome: args.midPepOutcome ?? { pep: 'mid', warnings: [] },
    earlyWarnings: [],
  };
}

beforeEach(async () => {
  store.clear();
  vi.clearAllMocks();
  // Re-bind the proxy table reference per test so the store map is keyed by
  // the SAME proxy instance the production query reads.
  const schema = await import('@/db/schema.js');
  skillsTable = (schema as any).skills;
});

// ===========================================================================
// Issue #226 — REAL ActionDeciderImpl fallback through skillsRepo.find with
// cross-tenant guard.
// ===========================================================================
describe('issue #226 — ActionDeciderImpl fallback skillsRepo.find cross-tenant guard', () => {
  it('A→B leak path: tenant-A scope NEVER resolves tenant-B skill via the real ActionDecider fallback', async () => {
    seedDefault();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    // Ambient context = tenant-B (the would-be leak). The decider operates on
    // base={tenant_id:tenant-A, agent_id:agent-A}, and the fallback `find()`
    // MUST pin to that scope — not the ambient tenant-B/agent-B.
    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () =>
        decider.decide(
          // Ask for tenant-B's ID under tenant-A scope. The fallback `find()`
          // re-resolves under {tenant-A, agent-A}; getById's WHERE drops the
          // tenant-B row → null → ActionDecider emits ask_clarification.
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_B_owned',
          }),
        ),
    );

    // Production behaviour for a skill_id that does not exist in the routed
    // scope: ActionDecider emits ask_clarification with `skill_lookup_failed`
    // (action-decider.ts:181-189). The CRITICAL invariant is that the
    // tenant-B skill never surfaced — `allowed_tools` came up empty, NOT
    // loaded with tenant-B's `tool_for_s_B_owned`.
    expect(result.action_mode).toBe('ask_clarification');
    expect(result.rationale).toBe('skill_lookup_failed:s_B_owned');
    expect(result.tool_permissions.allowed_tools).toEqual([]);
    expect(result.tool_permissions.allowed_tools).not.toContain('tool_for_s_B_owned');
  });

  it('A→B leak path: sanity — tenant-A own skill resolves under tenant-A scope (the fallback IS exercised)', async () => {
    seedDefault();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' }, // ambient = tenant-B
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_A_owned',
          }),
        ),
    );

    // tenant-A's own tool_mediated skill resolves and routes to call_tool.
    expect(result.action_mode).toBe('call_tool');
    expect(result.rationale).toBe('call_tool:s_A_owned');
    expect(result.tool_permissions.allowed_tools).toContain('tool_for_s_A_owned');
    // No tenant-B leak — explicit non-tenant-B tool assertion.
    expect(result.tool_permissions.allowed_tools).not.toContain('tool_for_s_B_owned');
  });

  it('B→A leak path (symmetric): tenant-B scope NEVER resolves tenant-A skill via the real ActionDecider fallback', async () => {
    seedDefault();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    // Ambient = tenant-A; routed/decider scope = tenant-B. Ask for tenant-A's id.
    const result = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-B',
            agent_id: 'agent-B',
            selected_skill_id: 's_A_owned',
          }),
        ),
    );

    expect(result.action_mode).toBe('ask_clarification');
    expect(result.rationale).toBe('skill_lookup_failed:s_A_owned');
    expect(result.tool_permissions.allowed_tools).toEqual([]);
    expect(result.tool_permissions.allowed_tools).not.toContain('tool_for_s_A_owned');
  });

  it('B→A leak path: sanity — tenant-B own skill resolves under tenant-B scope', async () => {
    seedDefault();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' }, // ambient = tenant-A
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-B',
            agent_id: 'agent-B',
            selected_skill_id: 's_B_owned',
          }),
        ),
    );

    expect(result.action_mode).toBe('call_tool');
    expect(result.rationale).toBe('call_tool:s_B_owned');
    expect(result.tool_permissions.allowed_tools).toContain('tool_for_s_B_owned');
    expect(result.tool_permissions.allowed_tools).not.toContain('tool_for_s_A_owned');
  });

  // -------------------------------------------------------------------------
  // Adversarial seed: tenant-B FIRST. If a future regression dropped the
  // `tenant_id` filter, insertion order would matter and tenant-B's row
  // could slide ahead of tenant-A's. With the filter intact, this test
  // behaves identically to the default seed direction — proving the guard
  // is positional-insensitive.
  // -------------------------------------------------------------------------
  it('adversarial seed (tenant-B inserted FIRST): tenant-A scope still NEVER resolves tenant-B skill', async () => {
    seedBFirst();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_B_owned',
          }),
        ),
    );

    expect(result.action_mode).toBe('ask_clarification');
    expect(result.rationale).toBe('skill_lookup_failed:s_B_owned');
    expect(result.tool_permissions.allowed_tools).not.toContain('tool_for_s_B_owned');
  });

  it('adversarial seed (tenant-B inserted FIRST): tenant-A own skill still resolves under tenant-A scope', async () => {
    seedBFirst();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_A_owned',
          }),
        ),
    );

    expect(result.action_mode).toBe('call_tool');
    expect(result.rationale).toBe('call_tool:s_A_owned');
    expect(result.tool_permissions.allowed_tools).toContain('tool_for_s_A_owned');
  });

  // -------------------------------------------------------------------------
  // Tenant-wide leak path: a row with `agent_id IS NULL` is shared across
  // agents of the SAME tenant, but NEVER cross-tenant. Verify the fallback
  // never returns tenant-B's tenant-wide row under tenant-A scope.
  // -------------------------------------------------------------------------
  it('tenant-wide skill: tenant-A scope NEVER resolves tenant-B `agent_id IS NULL` skill via the fallback', async () => {
    seedDefault();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () =>
        decider.decide(
          // Ask for tenant-B's TENANT-WIDE id under tenant-A scope.
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_B_shared',
          }),
        ),
    );

    expect(result.action_mode).toBe('ask_clarification');
    expect(result.rationale).toBe('skill_lookup_failed:s_B_shared');
    expect(result.tool_permissions.allowed_tools).not.toContain('tool_for_s_B_shared');
  });

  it('tenant-wide skill: tenant-A scope DOES resolve tenant-A `agent_id IS NULL` skill (intra-tenant sharing is fine)', async () => {
    seedDefault();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    // A different agent inside tenant-A asks for the tenant-wide skill —
    // must resolve (tenant-wide is shared INSIDE the tenant by design).
    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_A_shared',
          }),
        ),
    );

    expect(result.action_mode).toBe('call_tool');
    expect(result.rationale).toBe('call_tool:s_A_shared');
    expect(result.tool_permissions.allowed_tools).toContain('tool_for_s_A_shared');
  });

  // -------------------------------------------------------------------------
  // Same-ID cross-tenant collision (MINOR-3 from PR #236 review): each tenant
  // has a skill named `compose_message`. Tenant-A's lookup must return ONLY
  // tenant-A's row regardless of insert order, and tenant-B's lookup must
  // return ONLY tenant-B's row.
  //
  // Why this matters: the previous adversarial test used DISTINCT IDs
  // (`s_A_owned` / `s_B_owned`) — so insertion order could not have surfaced
  // the wrong row even with NO tenant filter at all (a missing filter would
  // have returned a "wrong row" only if a row with the SAME id existed). This
  // suite uses colliding ids so the WHERE predicate's tenant clause is the
  // ONLY thing preventing a leak.
  //
  // Mutation-test guarantee: we deliberately use `agent_id = null`
  // (tenant-wide) on both rows so the `getById` agent-scope POST-filter
  // (skills-repo.ts:836) does NOT compensate for a missing tenant predicate
  // — a `null` agent_id passes the post-filter regardless of routed agent,
  // so a regression dropping `WHERE tenant_id = ...` would leak tenant-B's
  // row into tenant-A's lookup and FAIL the assertion below. If the rows
  // were `agent_id = 'agent-X'`-scoped, the post-filter would mask the bug.
  // -------------------------------------------------------------------------
  it('same-id collision (A-first): both tenants own tenant-wide `compose_message` — tenant-A scope returns tenant-A row only', async () => {
    pushSkills([
      mkRow({
        id: 'compose_message',
        tenant_id: 'tenant-A',
        agent_id: null, // tenant-wide — post-filter cannot mask a missing tenant predicate
        allowed_tools: ['tool_for_A_compose'],
      }),
      mkRow({
        id: 'compose_message',
        tenant_id: 'tenant-B',
        agent_id: null,
        allowed_tools: ['tool_for_B_compose'],
      }),
    ]);

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' }, // ambient = tenant-B
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 'compose_message',
          }),
        ),
    );

    // tenant-A's row resolved — tenant-B's `tool_for_B_compose` did NOT leak.
    expect(result.action_mode).toBe('call_tool');
    expect(result.rationale).toBe('call_tool:compose_message');
    expect(result.tool_permissions.allowed_tools).toContain('tool_for_A_compose');
    expect(result.tool_permissions.allowed_tools).not.toContain('tool_for_B_compose');
  });

  it('same-id collision (B-first): both tenants own tenant-wide `compose_message` — tenant-A scope STILL returns tenant-A row only (positional insensitivity)', async () => {
    // Insert tenant-B first. A missing `WHERE tenant_id` filter would surface
    // tenant-B's row via `limit(1)` order-of-insertion ahead of tenant-A's;
    // the tenant-wide (`agent_id = null`) shape ensures the agent-scope
    // post-filter cannot also drop the wrong-tenant row.
    pushSkills([
      mkRow({
        id: 'compose_message',
        tenant_id: 'tenant-B',
        agent_id: null,
        allowed_tools: ['tool_for_B_compose'],
      }),
      mkRow({
        id: 'compose_message',
        tenant_id: 'tenant-A',
        agent_id: null,
        allowed_tools: ['tool_for_A_compose'],
      }),
    ]);

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 'compose_message',
          }),
        ),
    );

    expect(result.action_mode).toBe('call_tool');
    expect(result.rationale).toBe('call_tool:compose_message');
    expect(result.tool_permissions.allowed_tools).toContain('tool_for_A_compose');
    expect(result.tool_permissions.allowed_tools).not.toContain('tool_for_B_compose');
  });

  it('same-id collision symmetric: tenant-B scope returns tenant-B row only when both tenants own tenant-wide `compose_message`', async () => {
    pushSkills([
      mkRow({
        id: 'compose_message',
        tenant_id: 'tenant-A',
        agent_id: null,
        allowed_tools: ['tool_for_A_compose'],
      }),
      mkRow({
        id: 'compose_message',
        tenant_id: 'tenant-B',
        agent_id: null,
        allowed_tools: ['tool_for_B_compose'],
      }),
    ]);

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' }, // ambient = tenant-A
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-B',
            agent_id: 'agent-B',
            selected_skill_id: 'compose_message',
          }),
        ),
    );

    expect(result.action_mode).toBe('call_tool');
    expect(result.rationale).toBe('call_tool:compose_message');
    expect(result.tool_permissions.allowed_tools).toContain('tool_for_B_compose');
    expect(result.tool_permissions.allowed_tools).not.toContain('tool_for_A_compose');
  });
});

// ===========================================================================
// MAJOR-1 — Fallback branch coverage. The cross-tenant cases above exercise
// only `call_tool` (FOUND tool_mediated) and `ask_clarification` (NOT FOUND).
// Production has 3 OTHER branches reachable via the fallback that were
// previously uncovered.
// ===========================================================================
describe('issue #226 — ActionDeciderImpl fallback branch coverage (3 missing branches)', () => {
  // -------------------------------------------------------------------------
  // BRANCH a — fallback-resolved `execute_skill` (action-decider.ts:204).
  // A skill whose execution_mode is `prompt_only` or `evaluator` is terminal
  // and side-effect-free; the decider emits `execute_skill` directly.
  // -------------------------------------------------------------------------
  it('fallback-resolved execute_skill: prompt_only skill yields action_mode=execute_skill', async () => {
    pushSkills([
      mkRow({
        id: 's_A_prompt',
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        // Compose-category is one of the valid DB categories used by
        // prompt_only skills (e.g. a draft-message skill).
        category: 'compose',
        execution_mode: 'prompt_only',
      }),
      // Tenant-B same-shape skill to prove no cross-tenant leak slips in.
      mkRow({
        id: 's_B_prompt',
        tenant_id: 'tenant-B',
        agent_id: 'agent-B',
        category: 'compose',
        execution_mode: 'prompt_only',
      }),
    ]);

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' }, // ambient = tenant-B (would-be leak source)
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_A_prompt',
          }),
        ),
    );

    expect(result.action_mode).toBe('execute_skill');
    expect(result.rationale).toBe('execute_skill:s_A_prompt');
    // execute_skill emits empty tool permissions (action-decider.ts:207).
    expect(result.tool_permissions.allowed_tools).toEqual([]);
  });

  it('fallback-resolved execute_skill: evaluator skill yields action_mode=execute_skill', async () => {
    pushSkills([
      mkRow({
        id: 's_A_eval',
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        category: 'evaluator',
        execution_mode: 'evaluator',
      }),
    ]);

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_A_eval',
          }),
        ),
    );

    expect(result.action_mode).toBe('execute_skill');
    expect(result.rationale).toBe('execute_skill:s_A_eval');
  });

  // -------------------------------------------------------------------------
  // BRANCH b — tool-reduction-to-empty (action-decider.ts:225). When a Mid
  // PEP reduce_tool_set strips EVERY allowed tool from a tool-mediated skill
  // that originally had at least one tool, the decider emits
  // `ask_clarification:tool_set_reduced_to_empty:<skill_id>` (NOT call_tool
  // with empty allowed_tools).
  // -------------------------------------------------------------------------
  it('tool-reduction-to-empty: Mid PEP reduces all tools → ask_clarification:tool_set_reduced_to_empty', async () => {
    pushSkills([
      mkRow({
        id: 's_A_owned',
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        // Single tool — Mid PEP will reduce it away.
        allowed_tools: ['tool_for_s_A_owned'],
      }),
    ]);

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_A_owned',
            midPepOutcome: {
              pep: 'mid',
              warnings: [],
              tool_reductions: [
                {
                  policy_id: 'policy_x',
                  rule_descriptor: 'rule.no_outbound',
                  removed_tools: ['tool_for_s_A_owned'],
                  reason: 'channel locked',
                },
              ],
            },
          }),
        ),
    );

    expect(result.action_mode).toBe('ask_clarification');
    expect(result.rationale).toBe('tool_set_reduced_to_empty:s_A_owned');
    // The reduction MUST have moved the tool to blocked_tools (the decider's
    // bookkeeping at action-decider.ts:317-323).
    expect(result.tool_permissions.allowed_tools).toEqual([]);
    expect(result.tool_permissions.blocked_tools).toContain('tool_for_s_A_owned');
  });

  // -------------------------------------------------------------------------
  // BRANCH c — default `respond` (action-decider.ts:257). When the resolved
  // skill's category is NOT `tool_mediated`/`decide` AND its execution_mode
  // is NOT `prompt_only`/`evaluator`, the decider falls through to `respond`.
  // The combination satisfied by a `classify`/`extract`-category skill with
  // `tool_mediated` execution_mode is contrived but represents the literal
  // shape needed to exercise this branch (a `respond`-category skill would
  // hit the same branch but `respond` is not in the DB CHECK constraint;
  // the DE port admits it though, so we use `classify` as the DB-valid
  // analogue with the non-directly-executable execution_mode).
  //
  // Wait — read the production logic again: line 219 is
  //   `if (skill.category === 'tool_mediated' || skill.category === 'decide')`
  // — anything NOT in that set falls through. Default categories like
  // `classify`/`extract`/`plan` thus hit `respond`. The execution_mode gate
  // at line 204 (`isDirectlyExecutable`) only matters if execution_mode is
  // `prompt_only`/`evaluator` — for `tool_mediated` execution_mode + a
  // non-tool_mediated/decide category, neither gate fires and we land in
  // the default `respond` (line 257).
  // -------------------------------------------------------------------------
  it('default respond: classify-category skill with tool_mediated execution_mode falls through to respond', async () => {
    pushSkills([
      mkRow({
        id: 's_A_classify',
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        // category=classify is NOT in {tool_mediated, decide}, so the
        // call_tool branch is skipped.
        category: 'classify',
        // execution_mode=tool_mediated is NOT directly executable
        // (isDirectlyExecutable returns false), so the execute_skill branch
        // is also skipped. Only the default `respond` branch remains.
        execution_mode: 'tool_mediated',
      }),
    ]);

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_A_classify',
          }),
        ),
    );

    expect(result.action_mode).toBe('respond');
    expect(result.rationale).toBe('respond:s_A_classify');
    // The default `respond` branch uses EMPTY_TOOL_PERMS, not the skill's
    // own allowed_tools (action-decider.ts:259).
    expect(result.tool_permissions.allowed_tools).toEqual([]);
  });
});
