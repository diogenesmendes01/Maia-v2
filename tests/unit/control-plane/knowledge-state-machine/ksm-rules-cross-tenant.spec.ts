/**
 * Issue #234 — Cross-tenant (cross-empresa) isolation invariant for the
 * KnowledgeStateMachine facade over `learned_rules`.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * The contract this spec PROVES (kind: 'rule' only — issue #234 is scoped
 * to procedural memory; other kinds are out-of-scope and follow up in a
 * separate fix):
 *   `knowledgeRepos.findById('rule', id)` and `knowledgeRepos.update('rule',
 *   id, ...)` — and by extension `KnowledgeStateMachine.transition` and
 *   `.revoke` for `kind:'rule'` — pin
 *   `tenant_id = <ALS> AND agent_id = <ALS>` into their WHERE clauses,
 *   AND throw `TypedError('rule_not_in_scope', ...)` when 0 rows match
 *   (foreign-tenant id, foreign-agent id, OR unknown id).
 *
 * Before this fix the WHERE was `id = ?` only — any caller that could
 * trigger `KnowledgeStateMachine.transition`/`.revoke` with a foreign-
 * tenant UUID could mutate the lifecycle_status of a `learned_rules` row
 * cross-tenant, bypassing the guard PR #232 added to `rulesRepo` (issue
 * #230). Only the auto-promoter exercises `transition()` in production
 * today, but the API is exported and the issue is a STRUCTURAL bypass
 * surfaced by 2 Codex passes.
 *
 * Strategy:
 *   - Mock `drizzle-orm` so `eq`/`and` produce predicate-bearing objects
 *     (`{__pred(row)}`) that our fake builder can evaluate. `sql` is
 *     passed through opaquely.
 *   - Mock `@/db/schema.js` with a proxy table object whose columns
 *     resolve to `{__col:<name>}`.
 *   - Mock `@/db/client.js` with an in-memory `db.update()` + `db.select()`
 *     chain that:
 *       1. captures the WHERE predicate,
 *       2. captures the SET object on UPDATE,
 *       3. captures the RETURNING column projection on UPDATE,
 *       4. on await: filters the store, applies SET, returns projection
 *          (so the production `rows.length === 0` check fires).
 *   - Wrap every test in `runWithTenantContext` so the production code's
 *     `getCurrentTenant()/getCurrentAgent()` return routed values.
 *
 * Seed (two tenants, four rules):
 *   tenant-A / agent-A: { rule_A_alpha, rule_A_beta }
 *   tenant-B / agent-B: { rule_B_gamma, rule_B_delta }
 *
 * Each test exercises the REAL `KnowledgeStateMachine.transition`/`.revoke`
 * → `knowledgeRepos.findById`/`.update` code path; only the SQL execution
 * layer is faked. The pattern mirrors `tests/unit/memory/procedural-cross-
 * tenant.spec.ts` (PR #232, issue #230) — same fake-Drizzle harness shape.
 *
 * Adversarial seed (`seedTwoTenantsReverse`): tenant-B rules inserted
 * FIRST so a missing tenant_id filter on the UPDATE would surface as
 * tenant-B's row sliding in front of tenant-A's. The production WHERE
 * pins tenant_id + agent_id, so row order is irrelevant — this seed
 * exists to PROVE that explicitly.
 *
 * This does NOT use a real DB. The fake faithfully reproduces drizzle's
 * `update().set().where().returning()` and `select().from().where().limit()`
 * semantics against seeded rows so the REAL `knowledgeRepos` code paths are
 * exercised end-to-end.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// In-memory store + drizzle/db fakes
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

vi.mock('drizzle-orm', () => {
  const eq = (left: unknown, right: unknown): PredObj => ({
    __pred: (row: Row) => {
      const key = isColRef(left) ? left.__col : String(left);
      return row[key] === right;
    },
  });
  const and = (...conds: unknown[]): PredObj => ({
    __pred: (row: Row) =>
      conds.every((c) => (isPredObj(c) ? c.__pred(row) : true)),
  });
  const or = (...conds: unknown[]): PredObj => ({
    __pred: (row: Row) =>
      conds.some((c) => (isPredObj(c) ? c.__pred(row) : false)),
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
  const desc = (col: unknown) => col;
  const lte = (left: unknown, right: unknown): PredObj => ({
    __pred: (row: Row) => {
      const key = isColRef(left) ? left.__col : String(left);
      return row[key] <= (right as number);
    },
  });
  // sql template — passthrough sentinel for the buildUpdatedAtFilter helper
  // and any other SQL fragments the KSM uses. Always evaluates to TRUE in
  // the in-memory fake because we don't exercise the listEligible filter
  // paths in this spec.
  const sql = (_strings: TemplateStringsArray, ..._vals: unknown[]) =>
    ({ __pred: () => true }) as PredObj;
  sql.raw = (_text: string) => ({ __pred: () => true }) as PredObj;
  return { eq, and, or, desc, sql, inArray, isNull, lte };
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
// own-properties at module-binding time. List every table
// `src/control-plane/knowledge-state-machine/repos.ts` imports from
// `@/db/schema.js`.
vi.mock('@/db/schema.js', () => {
  const tables = [
    'agent_facts',
    'behavioral_hint',
    'learned_rules',
    'memory_entry',
  ];
  const out: Record<string, any> = {};
  for (const t of tables) out[t] = makeTable();
  return out;
});

class UpdateBuilder {
  private _table: unknown = null;
  private _setValues: Record<string, unknown> = {};
  private _pred: Pred = () => true;
  private _returningCols: Record<string, ColRef> | null = null;
  constructor(table: unknown) {
    this._table = table;
  }
  set(values: Record<string, unknown>) {
    this._setValues = values;
    return this;
  }
  where(p: unknown) {
    if (isPredObj(p)) this._pred = p.__pred;
    return this;
  }
  returning(cols: Record<string, ColRef>) {
    this._returningCols = cols;
    return this;
  }
  private exec(): Row[] {
    const rows = tableOf(this._table);
    const matched: Row[] = [];
    for (const row of rows) {
      if (!this._pred(row)) continue;
      for (const [k, v] of Object.entries(this._setValues)) {
        row[k] = v;
      }
      matched.push(row);
    }
    if (this._returningCols) {
      const keys = Object.keys(this._returningCols);
      return matched.map((r) => {
        const out: Row = {};
        for (const k of keys) out[k] = r[k];
        return out;
      });
    }
    return matched.map((r) => ({ ...r }));
  }
  then(resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) {
    try {
      resolve(this.exec());
    } catch (e) {
      reject?.(e);
    }
  }
}

class SelectBuilder {
  private _table: unknown = null;
  private _pred: Pred = () => true;
  private _limit = Infinity;
  private _projection: Record<string, ColRef> | null = null;
  constructor(projection?: Record<string, ColRef>) {
    this._projection = projection ?? null;
  }
  from(t: unknown) {
    this._table = t;
    return this;
  }
  where(p: unknown) {
    if (isPredObj(p)) this._pred = p.__pred;
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
    const rows = tableOf(this._table)
      .filter(this._pred)
      .slice(0, this._limit);
    if (this._projection) {
      const keys = Object.keys(this._projection);
      return rows.map((r) => {
        const out: Row = {};
        for (const k of keys) out[k] = r[k];
        return out;
      });
    }
    return rows.map((r) => ({ ...r }));
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
  // Not exercised by this spec (state-machine.transition/revoke don't
  // INSERT). Provide a no-op shape so the production code compiles if it
  // ever calls db.insert() during a path the tests touch.
  private _table: unknown = null;
  constructor(table: unknown) {
    this._table = table;
  }
  values(_v: unknown) {
    return {
      returning: (_cols: unknown) => ({
        then: (resolve: (v: Row[]) => unknown) => resolve([]),
      }),
    };
  }
}

function makeDbHandle() {
  return {
    select: (projection?: Record<string, ColRef>) =>
      new SelectBuilder(projection),
    insert: (table: unknown) => new InsertBuilder(table),
    update: (table: unknown) => new UpdateBuilder(table),
  };
}

vi.mock('@/db/client.js', () => {
  const db = makeDbHandle();
  const withTx = async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(makeDbHandle());
  return { db, withTx };
});

// Silence the audit_missing_tenant_context / cognitive-module-log path
// in runner — these tests focus on the repo guard, not the audit layer.
vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Seed helpers — two-tenant fixture for `learned_rules`.
// ---------------------------------------------------------------------------
let rulesTable: any;

beforeEach(async () => {
  store.clear();
  const schema = await import('@/db/schema.js');
  rulesTable = (schema as any).learned_rules;
});

function baseRule(over: Row): Row {
  return {
    tipo: 'comportamento',
    contexto: 'ctx',
    acao: 'acao',
    contexto_jsonb: {},
    acoes_jsonb: {},
    confianca: '0.5',
    acertos: 0,
    erros: 0,
    ativa: true,
    exemplo_origem_id: null,
    lifecycle_status: 'pending_review',
    evidence_count: 0,
    lifecycle_transitions: [],
    last_recall_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

function seedTwoTenants() {
  tableOf(rulesTable).push(
    baseRule({
      id: 'rule_A_alpha',
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      lifecycle_status: 'pending_review',
    }),
    baseRule({
      id: 'rule_A_beta',
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      lifecycle_status: 'active',
    }),
  );
  tableOf(rulesTable).push(
    baseRule({
      id: 'rule_B_gamma',
      tenant_id: 'tenant-B',
      agent_id: 'agent-B',
      lifecycle_status: 'pending_review',
    }),
    baseRule({
      id: 'rule_B_delta',
      tenant_id: 'tenant-B',
      agent_id: 'agent-B',
      lifecycle_status: 'active',
    }),
  );
}

// Adversarial seed: tenant-B rules inserted FIRST so any "first match wins"
// shortcut in a buggy WHERE would surface as tenant-B's row sliding in
// front of tenant-A's.
function seedTwoTenantsReverse() {
  tableOf(rulesTable).push(
    baseRule({
      id: 'rule_B_gamma',
      tenant_id: 'tenant-B',
      agent_id: 'agent-B',
      lifecycle_status: 'pending_review',
    }),
    baseRule({
      id: 'rule_B_delta',
      tenant_id: 'tenant-B',
      agent_id: 'agent-B',
      lifecycle_status: 'active',
    }),
  );
  tableOf(rulesTable).push(
    baseRule({
      id: 'rule_A_alpha',
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      lifecycle_status: 'pending_review',
    }),
    baseRule({
      id: 'rule_A_beta',
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      lifecycle_status: 'active',
    }),
  );
}

const A_CTX = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B_CTX = { tenant_id: 'tenant-B', agent_id: 'agent-B' };

function findRow(id: string): Row | undefined {
  return tableOf(rulesTable).find((r) => r.id === id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #234 — KSM facade for kind:rule is tenant/agent-scoped', () => {
  describe('knowledgeRepos.findById (rule)', () => {
    it('SUCCESS — same-scope findById returns the row', async () => {
      seedTwoTenants();
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      const row = await runWithTenantContext(A_CTX, async () =>
        knowledgeRepos.findById('rule', 'rule_A_alpha'),
      );
      expect(row).not.toBeNull();
      expect(row!.id).toBe('rule_A_alpha');
      expect(row!.tenant_id).toBe('tenant-A');
    });

    it('REJECTION — tenant-A context returns null for tenant-B rule', async () => {
      seedTwoTenants();
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      const row = await runWithTenantContext(A_CTX, async () =>
        knowledgeRepos.findById('rule', 'rule_B_gamma'),
      );
      expect(row).toBeNull();
    });

    it('SYMMETRY — tenant-B context returns null for tenant-A rule', async () => {
      seedTwoTenants();
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      const row = await runWithTenantContext(B_CTX, async () =>
        knowledgeRepos.findById('rule', 'rule_A_alpha'),
      );
      expect(row).toBeNull();
    });

    it('ADVERSARIAL SEED — B-first ordering does not change scope-miss behaviour', async () => {
      seedTwoTenantsReverse();
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      const same = await runWithTenantContext(A_CTX, async () =>
        knowledgeRepos.findById('rule', 'rule_A_alpha'),
      );
      const cross = await runWithTenantContext(A_CTX, async () =>
        knowledgeRepos.findById('rule', 'rule_B_gamma'),
      );
      expect(same!.id).toBe('rule_A_alpha');
      expect(cross).toBeNull();
    });

    it('REJECTION — same tenant cross-agent returns null', async () => {
      tableOf(rulesTable).push(
        baseRule({
          id: 'rule_A_other_agent',
          tenant_id: 'tenant-A',
          agent_id: 'agent-OTHER',
        }),
      );
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      const row = await runWithTenantContext(A_CTX, async () =>
        knowledgeRepos.findById('rule', 'rule_A_other_agent'),
      );
      expect(row).toBeNull();
    });
  });

  describe('knowledgeRepos.update (rule)', () => {
    it('SUCCESS — same-scope update applies lifecycle_status change', async () => {
      seedTwoTenants();
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      await runWithTenantContext(A_CTX, async () => {
        await knowledgeRepos.update('rule', 'rule_A_alpha', {
          lifecycle_status: 'active',
        });
      });
      expect(findRow('rule_A_alpha')!.lifecycle_status).toBe('active');
    });

    it('REJECTION — tenant-A context cannot update tenant-B rule (TypedError rule_not_in_scope)', async () => {
      seedTwoTenants();
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      const { TypedError } = await import('@/lib/utils.js');
      await runWithTenantContext(A_CTX, async () => {
        await expect(
          knowledgeRepos.update('rule', 'rule_B_gamma', {
            lifecycle_status: 'active',
          }),
        ).rejects.toBeInstanceOf(TypedError);
        await expect(
          knowledgeRepos.update('rule', 'rule_B_gamma', {
            lifecycle_status: 'active',
          }),
        ).rejects.toMatchObject({ code: 'rule_not_in_scope' });
      });
      // Defense in depth: tenant-B's row was NOT touched.
      expect(findRow('rule_B_gamma')!.lifecycle_status).toBe('pending_review');
    });

    it('SYMMETRY — tenant-B context cannot update tenant-A rule', async () => {
      seedTwoTenants();
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      await runWithTenantContext(B_CTX, async () => {
        await expect(
          knowledgeRepos.update('rule', 'rule_A_alpha', {
            lifecycle_status: 'active',
          }),
        ).rejects.toMatchObject({ code: 'rule_not_in_scope' });
      });
      expect(findRow('rule_A_alpha')!.lifecycle_status).toBe('pending_review');
    });

    it('REJECTION — unknown id throws rule_not_in_scope', async () => {
      seedTwoTenants();
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      await runWithTenantContext(A_CTX, async () => {
        await expect(
          knowledgeRepos.update('rule', 'rule_does_not_exist', {
            lifecycle_status: 'active',
          }),
        ).rejects.toMatchObject({ code: 'rule_not_in_scope' });
      });
    });

    it('ADVERSARIAL SEED — B-first does not change cross-tenant update rejection', async () => {
      seedTwoTenantsReverse();
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      await runWithTenantContext(A_CTX, async () => {
        await expect(
          knowledgeRepos.update('rule', 'rule_B_gamma', {
            lifecycle_status: 'active',
          }),
        ).rejects.toMatchObject({ code: 'rule_not_in_scope' });
        await knowledgeRepos.update('rule', 'rule_A_alpha', {
          lifecycle_status: 'active',
        });
      });
      // tenant-A row updated, tenant-B untouched (even though tenant-B is
      // first in store order).
      expect(findRow('rule_A_alpha')!.lifecycle_status).toBe('active');
      expect(findRow('rule_B_gamma')!.lifecycle_status).toBe('pending_review');
    });

    it('expected_previous_status — same-scope conditional update applies on match', async () => {
      seedTwoTenants();
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      await runWithTenantContext(A_CTX, async () => {
        await knowledgeRepos.update('rule', 'rule_A_alpha', {
          lifecycle_status: 'ephemeral',
          expected_previous_status: 'pending_review',
        });
      });
      expect(findRow('rule_A_alpha')!.lifecycle_status).toBe('ephemeral');
    });

    it('expected_previous_status — cross-tenant attempt throws rule_not_in_scope (NOT KnowledgeConflictError)', async () => {
      // Even when expected_previous_status is set, a cross-tenant attempt
      // must surface as rule_not_in_scope (telemetry-greppable), not as a
      // benign concurrency conflict. The repo disambiguates via re-read.
      seedTwoTenants();
      const { knowledgeRepos, KnowledgeConflictError } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      await runWithTenantContext(A_CTX, async () => {
        await expect(
          knowledgeRepos.update('rule', 'rule_B_gamma', {
            lifecycle_status: 'active',
            expected_previous_status: 'pending_review',
          }),
        ).rejects.toMatchObject({ code: 'rule_not_in_scope' });
        // Defense-in-depth: explicit check it is NOT a conflict error.
        await expect(
          knowledgeRepos.update('rule', 'rule_B_gamma', {
            lifecycle_status: 'active',
            expected_previous_status: 'pending_review',
          }),
        ).rejects.not.toBeInstanceOf(KnowledgeConflictError);
      });
      expect(findRow('rule_B_gamma')!.lifecycle_status).toBe('pending_review');
    });

    it('expected_previous_status — same-scope conditional update on lifecycle_status mismatch throws KnowledgeConflictError', async () => {
      // Same-scope row exists but its persisted lifecycle_status diverges
      // from the expected — this IS a real optimistic-concurrency conflict.
      // Production must throw KnowledgeConflictError (NOT
      // rule_not_in_scope) so the state-machine's catch translates to
      // IllegalTransitionError and the auto-promoter can treat it as benign.
      seedTwoTenants();
      const { knowledgeRepos, KnowledgeConflictError } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      await runWithTenantContext(A_CTX, async () => {
        // rule_A_alpha is in 'pending_review', not 'active'. Asking the
        // repo to flip pending_review→active under expected='active' must
        // raise the conflict.
        await expect(
          knowledgeRepos.update('rule', 'rule_A_alpha', {
            lifecycle_status: 'verified',
            expected_previous_status: 'active',
          }),
        ).rejects.toBeInstanceOf(KnowledgeConflictError);
      });
      // Defense-in-depth: row state unchanged.
      expect(findRow('rule_A_alpha')!.lifecycle_status).toBe('pending_review');
    });
  });

  describe('KnowledgeStateMachine.transition (rule) end-to-end', () => {
    it('SUCCESS — same-scope transition pending_review→active applies', async () => {
      seedTwoTenants();
      const { KnowledgeStateMachine } = await import(
        '@/control-plane/knowledge-state-machine/state-machine.js'
      );
      await runWithTenantContext(A_CTX, async () => {
        const t = await KnowledgeStateMachine.transition({
          kind: 'rule',
          proposal_id: 'rule_A_alpha',
          to: 'active',
          reason: 'test_same_scope',
          decided_by: 'human_approval',
        });
        expect(t.from).toBe('pending_review');
        expect(t.to).toBe('active');
      });
      expect(findRow('rule_A_alpha')!.lifecycle_status).toBe('active');
    });

    it('REJECTION — tenant-A transition on tenant-B rule throws knowledge_not_found (findById is scoped)', async () => {
      // Because findById is now tenant-scoped, the cross-tenant rule
      // returns null and the state-machine throws knowledge_not_found
      // BEFORE reaching the update step. This is the desired defense-in-
      // depth: out-of-scope rows are invisible to the state-machine
      // entirely.
      seedTwoTenants();
      const { KnowledgeStateMachine } = await import(
        '@/control-plane/knowledge-state-machine/state-machine.js'
      );
      await runWithTenantContext(A_CTX, async () => {
        await expect(
          KnowledgeStateMachine.transition({
            kind: 'rule',
            proposal_id: 'rule_B_gamma',
            to: 'active',
            reason: 'should_fail',
            decided_by: 'human_approval',
          }),
        ).rejects.toThrow(/knowledge_not_found:rule:rule_B_gamma/);
      });
      // Defense-in-depth: tenant-B's row was NOT touched.
      expect(findRow('rule_B_gamma')!.lifecycle_status).toBe('pending_review');
    });

    it('SYMMETRY — tenant-B transition on tenant-A rule throws knowledge_not_found', async () => {
      seedTwoTenants();
      const { KnowledgeStateMachine } = await import(
        '@/control-plane/knowledge-state-machine/state-machine.js'
      );
      await runWithTenantContext(B_CTX, async () => {
        await expect(
          KnowledgeStateMachine.transition({
            kind: 'rule',
            proposal_id: 'rule_A_alpha',
            to: 'active',
            reason: 'should_fail',
            decided_by: 'human_approval',
          }),
        ).rejects.toThrow(/knowledge_not_found:rule:rule_A_alpha/);
      });
      expect(findRow('rule_A_alpha')!.lifecycle_status).toBe('pending_review');
    });

    it('ADVERSARIAL SEED — B-first transitions still pin tenant-A only', async () => {
      seedTwoTenantsReverse();
      const { KnowledgeStateMachine } = await import(
        '@/control-plane/knowledge-state-machine/state-machine.js'
      );
      await runWithTenantContext(A_CTX, async () => {
        await KnowledgeStateMachine.transition({
          kind: 'rule',
          proposal_id: 'rule_A_alpha',
          to: 'active',
          reason: 'adversarial_seed',
          decided_by: 'human_approval',
        });
      });
      expect(findRow('rule_A_alpha')!.lifecycle_status).toBe('active');
      // tenant-B rows untouched even though they were seeded first.
      expect(findRow('rule_B_gamma')!.lifecycle_status).toBe('pending_review');
      expect(findRow('rule_B_delta')!.lifecycle_status).toBe('active');
    });
  });

  describe('KnowledgeStateMachine.revoke (rule) end-to-end', () => {
    it('SUCCESS — same-scope revoke moves rule to revoked', async () => {
      seedTwoTenants();
      const { KnowledgeStateMachine } = await import(
        '@/control-plane/knowledge-state-machine/state-machine.js'
      );
      await runWithTenantContext(A_CTX, async () => {
        const r = await KnowledgeStateMachine.revoke({
          kind: 'rule',
          proposal_id: 'rule_A_beta',
          reason: 'test_revoke',
          decided_by: 'incident_response',
        });
        expect(r.from).toBe('active');
        expect(r.to).toBe('revoked');
      });
      expect(findRow('rule_A_beta')!.lifecycle_status).toBe('revoked');
    });

    it('REJECTION — tenant-A revoke on tenant-B rule throws knowledge_not_found', async () => {
      seedTwoTenants();
      const { KnowledgeStateMachine } = await import(
        '@/control-plane/knowledge-state-machine/state-machine.js'
      );
      await runWithTenantContext(A_CTX, async () => {
        await expect(
          KnowledgeStateMachine.revoke({
            kind: 'rule',
            proposal_id: 'rule_B_gamma',
            reason: 'should_fail',
            decided_by: 'incident_response',
          }),
        ).rejects.toThrow(/knowledge_not_found:rule:rule_B_gamma/);
      });
      // Defense-in-depth: tenant-B's row was NOT touched.
      expect(findRow('rule_B_gamma')!.lifecycle_status).toBe('pending_review');
      expect(findRow('rule_B_delta')!.lifecycle_status).toBe('active');
    });

    it('SYMMETRY — tenant-B revoke on tenant-A rule throws knowledge_not_found', async () => {
      seedTwoTenants();
      const { KnowledgeStateMachine } = await import(
        '@/control-plane/knowledge-state-machine/state-machine.js'
      );
      await runWithTenantContext(B_CTX, async () => {
        await expect(
          KnowledgeStateMachine.revoke({
            kind: 'rule',
            proposal_id: 'rule_A_beta',
            reason: 'should_fail',
            decided_by: 'incident_response',
          }),
        ).rejects.toThrow(/knowledge_not_found:rule:rule_A_beta/);
      });
      expect(findRow('rule_A_beta')!.lifecycle_status).toBe('active');
    });

    it('ADVERSARIAL SEED — B-first revoke still scopes to tenant-A', async () => {
      seedTwoTenantsReverse();
      const { KnowledgeStateMachine } = await import(
        '@/control-plane/knowledge-state-machine/state-machine.js'
      );
      await runWithTenantContext(A_CTX, async () => {
        await KnowledgeStateMachine.revoke({
          kind: 'rule',
          proposal_id: 'rule_A_beta',
          reason: 'adversarial_seed',
          decided_by: 'incident_response',
        });
      });
      expect(findRow('rule_A_beta')!.lifecycle_status).toBe('revoked');
      expect(findRow('rule_B_delta')!.lifecycle_status).toBe('active');
    });
  });

  describe('MissingTenantContextError — defensive check on the ALS guard', () => {
    it('findById(rule, ...) outside runWithTenantContext throws MissingTenantContextError', async () => {
      seedTwoTenants();
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      const { MissingTenantContextError } = await import(
        '@/db/tenant-context.js'
      );
      await expect(
        knowledgeRepos.findById('rule', 'rule_A_alpha'),
      ).rejects.toBeInstanceOf(MissingTenantContextError);
    });

    it('update(rule, ...) outside runWithTenantContext throws MissingTenantContextError', async () => {
      seedTwoTenants();
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      const { MissingTenantContextError } = await import(
        '@/db/tenant-context.js'
      );
      await expect(
        knowledgeRepos.update('rule', 'rule_A_alpha', {
          lifecycle_status: 'active',
        }),
      ).rejects.toBeInstanceOf(MissingTenantContextError);
    });
  });
});
