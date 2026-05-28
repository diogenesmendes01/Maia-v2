/**
 * Issue #254 — Cross-tenant (cross-empresa) isolation invariant for the
 * KnowledgeStateMachine facade over the FOUR non-rule kinds:
 *   - `fact`              → table `agent_facts`
 *   - `memory`            → table `memory_entry`
 *   - `behavioral_hint`   → table `behavioral_hint`
 *   - `procedure_hint`    → table `behavioral_hint` (shared)
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados
 *    ou herdam aprendizado. Sem exceção."
 *
 * The contract this spec PROVES (kind ∈ {fact, memory, behavioral_hint,
 * procedure_hint}):
 *   `knowledgeRepos.findById(<kind>, id)` and
 *   `knowledgeRepos.update(<kind>, id, ...)` — and by extension
 *   `KnowledgeStateMachine.transition` and `.revoke` for each kind — pin
 *   `tenant_id = <ALS> AND agent_id = <ALS>` into their WHERE clauses,
 *   AND throw `TypedError('<kind>_not_in_scope', ...)` when 0 rows match
 *   (foreign-tenant id, foreign-agent id, OR unknown id).
 *
 * Companion to PR #243 / issue #234 which closed the same structural
 * bypass for `kind: 'rule'`. The pattern is mechanical — same ALS guard,
 * same loud-failure on zero rows, same expected_previous_status
 * disambiguation via re-read.
 *
 * Strategy (mirrors the procedural-cross-tenant + ksm-rules-cross-tenant
 * fake-Drizzle harness from PR #232 / PR #243):
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
 * Seed shape (two tenants per kind):
 *   tenant-A / agent-A: { <kind>_A_alpha, <kind>_A_beta }
 *   tenant-B / agent-B: { <kind>_B_gamma, <kind>_B_delta }
 *
 * Each kind exercises the REAL `knowledgeRepos`/`KnowledgeStateMachine`
 * code path; only the SQL execution layer is faked. The adversarial
 * seed (`seedTwoTenantsReverse`) inserts tenant-B rows FIRST so a
 * missing tenant_id filter on the UPDATE would surface as tenant-B's
 * row sliding in front of tenant-A's.
 *
 * Note on `kind: 'rule'`: OUT OF SCOPE for this spec — it's tracked by
 * issue #234 and PR #243. This spec extends the SAME guard pattern to the
 * four other kinds while keeping the rule code path untouched.
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
  // sql template — passthrough sentinel for buildUpdatedAtFilter / etc.
  // Always evaluates to TRUE in the in-memory fake because we don't
  // exercise listEligible filter paths in this spec.
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
  // Not exercised by this spec (transition/revoke don't INSERT). Provide
  // a no-op shape so the production code compiles if it ever calls
  // db.insert() during a path the tests touch.
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
// Seed helpers — two-tenant fixtures across the 3 backing tables.
// ---------------------------------------------------------------------------
let factsTable: any;
let memoryTable: any;
let hintTable: any;

beforeEach(async () => {
  store.clear();
  const schema = await import('@/db/schema.js');
  factsTable = (schema as any).agent_facts;
  memoryTable = (schema as any).memory_entry;
  hintTable = (schema as any).behavioral_hint;
});

function baseFact(over: Row): Row {
  return {
    escopo: 'tenant',
    chave: 'k',
    valor: { v: 1 },
    confianca: '0.5',
    fonte: 'aprendido',
    ultima_validacao: null,
    lifecycle_status: 'pending_review',
    evidence_count: 0,
    lifecycle_transitions: [],
    last_recall_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

function baseMemory(over: Row): Row {
  return {
    content: 'content',
    memory_type: 'episodic',
    scope_type: 'agent',
    subject_id: null,
    interlocutor_id: null,
    conversa_id: null,
    sensitivity: 'low',
    proactive_use: false,
    mention_allowed: false,
    ttl_days: 90,
    needs_review: false,
    source_event_id: null,
    expires_at: null,
    confidence: '0.5',
    lifecycle_status: 'pending_review',
    evidence_count: 0,
    lifecycle_transitions: [],
    last_recall_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

function baseHint(over: Row): Row {
  return {
    scope_type: 'agent',
    subject_id: null,
    hint_text: 'hint',
    derived_from_memory_id: null,
    derived_sensitivity: 'low',
    ttl_days: 60,
    extension_reason: null,
    extension_approved_by: null,
    extension_approved_at: null,
    expires_at: null,
    revoked_at: null,
    confidence: '0.5',
    lifecycle_status: 'pending_review',
    evidence_count: 0,
    lifecycle_transitions: [],
    last_recall_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

// Generic seed helpers parameterised by table + row factory. Same shape
// for every kind: two tenant-A rows, two tenant-B rows; reverse variant
// seeds tenant-B FIRST so a missing tenant_id filter would surface as
// row-order bug.
type KindSeed = {
  table: () => any;
  base: (over: Row) => Row;
  idPrefix: string;
};

function seedTwoTenants(s: KindSeed) {
  tableOf(s.table()).push(
    s.base({
      id: `${s.idPrefix}_A_alpha`,
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      lifecycle_status: 'pending_review',
    }),
    s.base({
      id: `${s.idPrefix}_A_beta`,
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      lifecycle_status: 'active',
    }),
  );
  tableOf(s.table()).push(
    s.base({
      id: `${s.idPrefix}_B_gamma`,
      tenant_id: 'tenant-B',
      agent_id: 'agent-B',
      lifecycle_status: 'pending_review',
    }),
    s.base({
      id: `${s.idPrefix}_B_delta`,
      tenant_id: 'tenant-B',
      agent_id: 'agent-B',
      lifecycle_status: 'active',
    }),
  );
}

function seedTwoTenantsReverse(s: KindSeed) {
  tableOf(s.table()).push(
    s.base({
      id: `${s.idPrefix}_B_gamma`,
      tenant_id: 'tenant-B',
      agent_id: 'agent-B',
      lifecycle_status: 'pending_review',
    }),
    s.base({
      id: `${s.idPrefix}_B_delta`,
      tenant_id: 'tenant-B',
      agent_id: 'agent-B',
      lifecycle_status: 'active',
    }),
  );
  tableOf(s.table()).push(
    s.base({
      id: `${s.idPrefix}_A_alpha`,
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      lifecycle_status: 'pending_review',
    }),
    s.base({
      id: `${s.idPrefix}_A_beta`,
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      lifecycle_status: 'active',
    }),
  );
}

const A_CTX = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B_CTX = { tenant_id: 'tenant-B', agent_id: 'agent-B' };

function findRow(table: any, id: string): Row | undefined {
  return tableOf(table).find((r) => r.id === id);
}

// ---------------------------------------------------------------------------
// Per-kind kind-spec registry. Drives the parameterised describe blocks.
// `tableGetter` is a thunk because the schema mocks live behind a beforeEach
// — calling `factsTable` at module load would resolve `undefined`.
// ---------------------------------------------------------------------------
interface KindSpec {
  kind: 'fact' | 'memory' | 'behavioral_hint' | 'procedure_hint';
  scopeError: string;
  table: () => any;
  base: (over: Row) => Row;
  idPrefix: string;
}

const KIND_SPECS: KindSpec[] = [
  {
    kind: 'fact',
    scopeError: 'fact_not_in_scope',
    table: () => factsTable,
    base: baseFact,
    idPrefix: 'fact',
  },
  {
    kind: 'memory',
    scopeError: 'memory_not_in_scope',
    table: () => memoryTable,
    base: baseMemory,
    idPrefix: 'memory',
  },
  {
    kind: 'behavioral_hint',
    scopeError: 'behavioral_hint_not_in_scope',
    table: () => hintTable,
    base: baseHint,
    idPrefix: 'bhint',
  },
  {
    kind: 'procedure_hint',
    // procedure_hint shares the behavioral_hint table; the error code is
    // kind-specific (per repos.ts: `${kind}_not_in_scope`) so callers can
    // grep telemetry by the requested kind, not the storage table.
    scopeError: 'procedure_hint_not_in_scope',
    table: () => hintTable,
    base: baseHint,
    idPrefix: 'phint',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #254 — KSM facade for non-rule kinds is tenant/agent-scoped', () => {
  for (const spec of KIND_SPECS) {
    describe(`kind='${spec.kind}'`, () => {
      const seedSpec: KindSeed = {
        table: spec.table,
        base: spec.base,
        idPrefix: spec.idPrefix,
      };

      describe(`knowledgeRepos.findById (${spec.kind})`, () => {
        it('SUCCESS — same-scope findById returns the row', async () => {
          seedTwoTenants(seedSpec);
          const { knowledgeRepos } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          const row = await runWithTenantContext(A_CTX, async () =>
            knowledgeRepos.findById(spec.kind, `${spec.idPrefix}_A_alpha`),
          );
          expect(row).not.toBeNull();
          expect(row!.id).toBe(`${spec.idPrefix}_A_alpha`);
          expect(row!.tenant_id).toBe('tenant-A');
        });

        it('REJECTION — tenant-A context returns null for tenant-B row', async () => {
          seedTwoTenants(seedSpec);
          const { knowledgeRepos } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          const row = await runWithTenantContext(A_CTX, async () =>
            knowledgeRepos.findById(spec.kind, `${spec.idPrefix}_B_gamma`),
          );
          expect(row).toBeNull();
        });

        it('SYMMETRY — tenant-B context returns null for tenant-A row', async () => {
          seedTwoTenants(seedSpec);
          const { knowledgeRepos } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          const row = await runWithTenantContext(B_CTX, async () =>
            knowledgeRepos.findById(spec.kind, `${spec.idPrefix}_A_alpha`),
          );
          expect(row).toBeNull();
        });

        it('ADVERSARIAL SEED — B-first ordering does not change scope-miss behaviour', async () => {
          seedTwoTenantsReverse(seedSpec);
          const { knowledgeRepos } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          const same = await runWithTenantContext(A_CTX, async () =>
            knowledgeRepos.findById(spec.kind, `${spec.idPrefix}_A_alpha`),
          );
          const cross = await runWithTenantContext(A_CTX, async () =>
            knowledgeRepos.findById(spec.kind, `${spec.idPrefix}_B_gamma`),
          );
          expect(same!.id).toBe(`${spec.idPrefix}_A_alpha`);
          expect(cross).toBeNull();
        });

        it('REJECTION — same tenant cross-agent returns null', async () => {
          tableOf(spec.table()).push(
            spec.base({
              id: `${spec.idPrefix}_A_other_agent`,
              tenant_id: 'tenant-A',
              agent_id: 'agent-OTHER',
            }),
          );
          const { knowledgeRepos } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          const row = await runWithTenantContext(A_CTX, async () =>
            knowledgeRepos.findById(
              spec.kind,
              `${spec.idPrefix}_A_other_agent`,
            ),
          );
          expect(row).toBeNull();
        });
      });

      describe(`knowledgeRepos.update (${spec.kind})`, () => {
        it('SUCCESS — same-scope update applies lifecycle_status change', async () => {
          seedTwoTenants(seedSpec);
          const { knowledgeRepos } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          await runWithTenantContext(A_CTX, async () => {
            await knowledgeRepos.update(
              spec.kind,
              `${spec.idPrefix}_A_alpha`,
              { lifecycle_status: 'active' },
            );
          });
          expect(
            findRow(spec.table(), `${spec.idPrefix}_A_alpha`)!.lifecycle_status,
          ).toBe('active');
        });

        it(`REJECTION — tenant-A cannot update tenant-B row (TypedError ${spec.scopeError})`, async () => {
          seedTwoTenants(seedSpec);
          const { knowledgeRepos } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          const { TypedError } = await import('@/lib/utils.js');
          await runWithTenantContext(A_CTX, async () => {
            await expect(
              knowledgeRepos.update(spec.kind, `${spec.idPrefix}_B_gamma`, {
                lifecycle_status: 'active',
              }),
            ).rejects.toBeInstanceOf(TypedError);
            await expect(
              knowledgeRepos.update(spec.kind, `${spec.idPrefix}_B_gamma`, {
                lifecycle_status: 'active',
              }),
            ).rejects.toMatchObject({ code: spec.scopeError });
          });
          // Defense in depth: tenant-B's row was NOT touched.
          expect(
            findRow(spec.table(), `${spec.idPrefix}_B_gamma`)!.lifecycle_status,
          ).toBe('pending_review');
        });

        it('SYMMETRY — tenant-B cannot update tenant-A row', async () => {
          seedTwoTenants(seedSpec);
          const { knowledgeRepos } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          await runWithTenantContext(B_CTX, async () => {
            await expect(
              knowledgeRepos.update(spec.kind, `${spec.idPrefix}_A_alpha`, {
                lifecycle_status: 'active',
              }),
            ).rejects.toMatchObject({ code: spec.scopeError });
          });
          expect(
            findRow(spec.table(), `${spec.idPrefix}_A_alpha`)!.lifecycle_status,
          ).toBe('pending_review');
        });

        it(`REJECTION — unknown id throws ${spec.scopeError}`, async () => {
          seedTwoTenants(seedSpec);
          const { knowledgeRepos } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          await runWithTenantContext(A_CTX, async () => {
            await expect(
              knowledgeRepos.update(
                spec.kind,
                `${spec.idPrefix}_does_not_exist`,
                { lifecycle_status: 'active' },
              ),
            ).rejects.toMatchObject({ code: spec.scopeError });
          });
        });

        it('ADVERSARIAL SEED — B-first does not change cross-tenant update rejection', async () => {
          seedTwoTenantsReverse(seedSpec);
          const { knowledgeRepos } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          await runWithTenantContext(A_CTX, async () => {
            await expect(
              knowledgeRepos.update(spec.kind, `${spec.idPrefix}_B_gamma`, {
                lifecycle_status: 'active',
              }),
            ).rejects.toMatchObject({ code: spec.scopeError });
            await knowledgeRepos.update(
              spec.kind,
              `${spec.idPrefix}_A_alpha`,
              { lifecycle_status: 'active' },
            );
          });
          expect(
            findRow(spec.table(), `${spec.idPrefix}_A_alpha`)!.lifecycle_status,
          ).toBe('active');
          expect(
            findRow(spec.table(), `${spec.idPrefix}_B_gamma`)!.lifecycle_status,
          ).toBe('pending_review');
        });

        it('REJECTION — cross-agent within same tenant throws scope error', async () => {
          // Same tenant, different agent — must still be rejected by the
          // agent_id predicate.
          tableOf(spec.table()).push(
            spec.base({
              id: `${spec.idPrefix}_A_other_agent`,
              tenant_id: 'tenant-A',
              agent_id: 'agent-OTHER',
            }),
          );
          const { knowledgeRepos } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          await runWithTenantContext(A_CTX, async () => {
            await expect(
              knowledgeRepos.update(
                spec.kind,
                `${spec.idPrefix}_A_other_agent`,
                { lifecycle_status: 'active' },
              ),
            ).rejects.toMatchObject({ code: spec.scopeError });
          });
          // Other-agent row untouched.
          expect(
            findRow(spec.table(), `${spec.idPrefix}_A_other_agent`)!
              .lifecycle_status,
          ).toBe('pending_review');
        });

        it('expected_previous_status — same-scope conditional update applies on match', async () => {
          seedTwoTenants(seedSpec);
          const { knowledgeRepos } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          await runWithTenantContext(A_CTX, async () => {
            await knowledgeRepos.update(
              spec.kind,
              `${spec.idPrefix}_A_alpha`,
              {
                lifecycle_status: 'ephemeral',
                expected_previous_status: 'pending_review',
              },
            );
          });
          expect(
            findRow(spec.table(), `${spec.idPrefix}_A_alpha`)!.lifecycle_status,
          ).toBe('ephemeral');
        });

        it(`expected_previous_status — cross-tenant attempt throws ${spec.scopeError} (NOT KnowledgeConflictError)`, async () => {
          // Even when expected_previous_status is set, a cross-tenant
          // attempt must surface as the scope-error (telemetry-greppable),
          // not as a benign concurrency conflict. The repo disambiguates
          // via re-read.
          seedTwoTenants(seedSpec);
          const { knowledgeRepos, KnowledgeConflictError } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          await runWithTenantContext(A_CTX, async () => {
            await expect(
              knowledgeRepos.update(spec.kind, `${spec.idPrefix}_B_gamma`, {
                lifecycle_status: 'active',
                expected_previous_status: 'pending_review',
              }),
            ).rejects.toMatchObject({ code: spec.scopeError });
            // Defense-in-depth: explicit check it is NOT a conflict error.
            await expect(
              knowledgeRepos.update(spec.kind, `${spec.idPrefix}_B_gamma`, {
                lifecycle_status: 'active',
                expected_previous_status: 'pending_review',
              }),
            ).rejects.not.toBeInstanceOf(KnowledgeConflictError);
          });
          expect(
            findRow(spec.table(), `${spec.idPrefix}_B_gamma`)!.lifecycle_status,
          ).toBe('pending_review');
        });

        it('expected_previous_status — same-scope on lifecycle_status mismatch throws KnowledgeConflictError', async () => {
          // Same-scope row exists but its persisted lifecycle_status
          // diverges from the expected — this IS a real
          // optimistic-concurrency conflict. Production must throw
          // KnowledgeConflictError (NOT the scope error) so the
          // state-machine's catch translates to IllegalTransitionError
          // and the auto-promoter can treat it as benign.
          seedTwoTenants(seedSpec);
          const { knowledgeRepos, KnowledgeConflictError } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          await runWithTenantContext(A_CTX, async () => {
            // <kind>_A_alpha is in 'pending_review', not 'active'. Asking
            // the repo to flip pending_review→active under
            // expected='active' must raise the conflict.
            await expect(
              knowledgeRepos.update(spec.kind, `${spec.idPrefix}_A_alpha`, {
                lifecycle_status: 'verified',
                expected_previous_status: 'active',
              }),
            ).rejects.toBeInstanceOf(KnowledgeConflictError);
          });
          // Defense-in-depth: row state unchanged.
          expect(
            findRow(spec.table(), `${spec.idPrefix}_A_alpha`)!.lifecycle_status,
          ).toBe('pending_review');
        });
      });

      describe(`KnowledgeStateMachine.transition (${spec.kind}) end-to-end`, () => {
        it('SUCCESS — same-scope transition pending_review→active applies', async () => {
          seedTwoTenants(seedSpec);
          const { KnowledgeStateMachine } = await import(
            '@/control-plane/knowledge-state-machine/state-machine.js'
          );
          await runWithTenantContext(A_CTX, async () => {
            const t = await KnowledgeStateMachine.transition({
              kind: spec.kind,
              proposal_id: `${spec.idPrefix}_A_alpha`,
              to: 'active',
              reason: 'test_same_scope',
              decided_by: 'human_approval',
            });
            expect(t.from).toBe('pending_review');
            expect(t.to).toBe('active');
          });
          expect(
            findRow(spec.table(), `${spec.idPrefix}_A_alpha`)!.lifecycle_status,
          ).toBe('active');
        });

        it('REJECTION — tenant-A transition on tenant-B row throws knowledge_not_found', async () => {
          // Because findById is now tenant-scoped, the cross-tenant row
          // returns null and the state-machine throws knowledge_not_found
          // BEFORE reaching the update step. This is the desired
          // defense-in-depth: out-of-scope rows are invisible to the
          // state-machine entirely.
          seedTwoTenants(seedSpec);
          const { KnowledgeStateMachine } = await import(
            '@/control-plane/knowledge-state-machine/state-machine.js'
          );
          await runWithTenantContext(A_CTX, async () => {
            await expect(
              KnowledgeStateMachine.transition({
                kind: spec.kind,
                proposal_id: `${spec.idPrefix}_B_gamma`,
                to: 'active',
                reason: 'should_fail',
                decided_by: 'human_approval',
              }),
            ).rejects.toThrow(
              new RegExp(
                `knowledge_not_found:${spec.kind}:${spec.idPrefix}_B_gamma`,
              ),
            );
          });
          // Defense-in-depth: tenant-B's row was NOT touched.
          expect(
            findRow(spec.table(), `${spec.idPrefix}_B_gamma`)!.lifecycle_status,
          ).toBe('pending_review');
        });

        it('SYMMETRY — tenant-B transition on tenant-A row throws knowledge_not_found', async () => {
          seedTwoTenants(seedSpec);
          const { KnowledgeStateMachine } = await import(
            '@/control-plane/knowledge-state-machine/state-machine.js'
          );
          await runWithTenantContext(B_CTX, async () => {
            await expect(
              KnowledgeStateMachine.transition({
                kind: spec.kind,
                proposal_id: `${spec.idPrefix}_A_alpha`,
                to: 'active',
                reason: 'should_fail',
                decided_by: 'human_approval',
              }),
            ).rejects.toThrow(
              new RegExp(
                `knowledge_not_found:${spec.kind}:${spec.idPrefix}_A_alpha`,
              ),
            );
          });
          expect(
            findRow(spec.table(), `${spec.idPrefix}_A_alpha`)!.lifecycle_status,
          ).toBe('pending_review');
        });

        it('ADVERSARIAL SEED — B-first transitions still pin tenant-A only', async () => {
          seedTwoTenantsReverse(seedSpec);
          const { KnowledgeStateMachine } = await import(
            '@/control-plane/knowledge-state-machine/state-machine.js'
          );
          await runWithTenantContext(A_CTX, async () => {
            await KnowledgeStateMachine.transition({
              kind: spec.kind,
              proposal_id: `${spec.idPrefix}_A_alpha`,
              to: 'active',
              reason: 'adversarial_seed',
              decided_by: 'human_approval',
            });
          });
          expect(
            findRow(spec.table(), `${spec.idPrefix}_A_alpha`)!.lifecycle_status,
          ).toBe('active');
          // tenant-B rows untouched even though they were seeded first.
          expect(
            findRow(spec.table(), `${spec.idPrefix}_B_gamma`)!.lifecycle_status,
          ).toBe('pending_review');
          expect(
            findRow(spec.table(), `${spec.idPrefix}_B_delta`)!.lifecycle_status,
          ).toBe('active');
        });
      });

      describe(`KnowledgeStateMachine.revoke (${spec.kind}) end-to-end`, () => {
        it('SUCCESS — same-scope revoke moves row to revoked', async () => {
          seedTwoTenants(seedSpec);
          const { KnowledgeStateMachine } = await import(
            '@/control-plane/knowledge-state-machine/state-machine.js'
          );
          await runWithTenantContext(A_CTX, async () => {
            const r = await KnowledgeStateMachine.revoke({
              kind: spec.kind,
              proposal_id: `${spec.idPrefix}_A_beta`,
              reason: 'test_revoke',
              decided_by: 'incident_response',
            });
            expect(r.from).toBe('active');
            expect(r.to).toBe('revoked');
          });
          expect(
            findRow(spec.table(), `${spec.idPrefix}_A_beta`)!.lifecycle_status,
          ).toBe('revoked');
        });

        it('REJECTION — tenant-A revoke on tenant-B row throws knowledge_not_found', async () => {
          seedTwoTenants(seedSpec);
          const { KnowledgeStateMachine } = await import(
            '@/control-plane/knowledge-state-machine/state-machine.js'
          );
          await runWithTenantContext(A_CTX, async () => {
            await expect(
              KnowledgeStateMachine.revoke({
                kind: spec.kind,
                proposal_id: `${spec.idPrefix}_B_gamma`,
                reason: 'should_fail',
                decided_by: 'incident_response',
              }),
            ).rejects.toThrow(
              new RegExp(
                `knowledge_not_found:${spec.kind}:${spec.idPrefix}_B_gamma`,
              ),
            );
          });
          // Defense-in-depth: tenant-B's rows were NOT touched.
          expect(
            findRow(spec.table(), `${spec.idPrefix}_B_gamma`)!.lifecycle_status,
          ).toBe('pending_review');
          expect(
            findRow(spec.table(), `${spec.idPrefix}_B_delta`)!.lifecycle_status,
          ).toBe('active');
        });

        it('SYMMETRY — tenant-B revoke on tenant-A row throws knowledge_not_found', async () => {
          seedTwoTenants(seedSpec);
          const { KnowledgeStateMachine } = await import(
            '@/control-plane/knowledge-state-machine/state-machine.js'
          );
          await runWithTenantContext(B_CTX, async () => {
            await expect(
              KnowledgeStateMachine.revoke({
                kind: spec.kind,
                proposal_id: `${spec.idPrefix}_A_beta`,
                reason: 'should_fail',
                decided_by: 'incident_response',
              }),
            ).rejects.toThrow(
              new RegExp(
                `knowledge_not_found:${spec.kind}:${spec.idPrefix}_A_beta`,
              ),
            );
          });
          expect(
            findRow(spec.table(), `${spec.idPrefix}_A_beta`)!.lifecycle_status,
          ).toBe('active');
        });

        it('ADVERSARIAL SEED — B-first revoke still scopes to tenant-A', async () => {
          seedTwoTenantsReverse(seedSpec);
          const { KnowledgeStateMachine } = await import(
            '@/control-plane/knowledge-state-machine/state-machine.js'
          );
          await runWithTenantContext(A_CTX, async () => {
            await KnowledgeStateMachine.revoke({
              kind: spec.kind,
              proposal_id: `${spec.idPrefix}_A_beta`,
              reason: 'adversarial_seed',
              decided_by: 'incident_response',
            });
          });
          expect(
            findRow(spec.table(), `${spec.idPrefix}_A_beta`)!.lifecycle_status,
          ).toBe('revoked');
          expect(
            findRow(spec.table(), `${spec.idPrefix}_B_delta`)!.lifecycle_status,
          ).toBe('active');
        });
      });

      describe(`MissingTenantContextError — defensive check on the ALS guard (${spec.kind})`, () => {
        it(`findById(${spec.kind}, ...) outside runWithTenantContext throws MissingTenantContextError`, async () => {
          seedTwoTenants(seedSpec);
          const { knowledgeRepos } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          const { MissingTenantContextError } = await import(
            '@/db/tenant-context.js'
          );
          await expect(
            knowledgeRepos.findById(spec.kind, `${spec.idPrefix}_A_alpha`),
          ).rejects.toBeInstanceOf(MissingTenantContextError);
        });

        it(`update(${spec.kind}, ...) outside runWithTenantContext throws MissingTenantContextError`, async () => {
          seedTwoTenants(seedSpec);
          const { knowledgeRepos } = await import(
            '@/control-plane/knowledge-state-machine/repos.js'
          );
          const { MissingTenantContextError } = await import(
            '@/db/tenant-context.js'
          );
          await expect(
            knowledgeRepos.update(spec.kind, `${spec.idPrefix}_A_alpha`, {
              lifecycle_status: 'active',
            }),
          ).rejects.toBeInstanceOf(MissingTenantContextError);
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Concern 2 (Codex #267 — LOW): behavioral_hint and procedure_hint share
  // the `behavioral_hint` table without a DB-level `kind` discriminator.
  // The architectural decision (documented in repos.ts) is that this is
  // safe because (tenant_id, agent_id, id) is unique and UUID v4 collision
  // across kinds is ≈ 0. These tests PIN the current intentional behavior:
  //   - same-row lookup works under both kinds (proves shared storage)
  //   - cross-tenant isolation still holds independently of kind label
  // If a `kind` column is added later, these tests must be updated to
  // reflect the new discrimination semantics.
  // ---------------------------------------------------------------------------
  describe('Concern 2 — behavioral_hint / procedure_hint shared table semantics', () => {
    it('a row written under one hint-kind is findable under the OTHER hint-kind (same tenant/agent)', async () => {
      // This documents the *intentional* shared-table design. If a real
      // `kind` column is introduced, this test must flip to expect null
      // for the foreign kind and become the regression guard for the
      // discriminator.
      tableOf(hintTable).push(
        baseHint({
          id: 'shared_hint_id_001',
          tenant_id: 'tenant-A',
          agent_id: 'agent-A',
          lifecycle_status: 'pending_review',
        }),
      );
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      const asBehavioral = await runWithTenantContext(A_CTX, async () =>
        knowledgeRepos.findById('behavioral_hint', 'shared_hint_id_001'),
      );
      const asProcedure = await runWithTenantContext(A_CTX, async () =>
        knowledgeRepos.findById('procedure_hint', 'shared_hint_id_001'),
      );
      // Both lookups resolve to the same physical row — shared storage.
      expect(asBehavioral).not.toBeNull();
      expect(asProcedure).not.toBeNull();
      expect(asBehavioral!.id).toBe('shared_hint_id_001');
      expect(asProcedure!.id).toBe('shared_hint_id_001');
    });

    it('cross-tenant isolation holds for BOTH hint kinds against the same shared row', async () => {
      // Defense-in-depth: even with shared storage and no kind column,
      // a foreign-tenant context cannot read or mutate the row under
      // EITHER hint-kind. The tenant_id+agent_id ALS guard does the
      // work; the shared-table absence of a `kind` column does NOT
      // open any cross-tenant path.
      tableOf(hintTable).push(
        baseHint({
          id: 'shared_hint_id_002',
          tenant_id: 'tenant-A',
          agent_id: 'agent-A',
          lifecycle_status: 'pending_review',
        }),
      );
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      // tenant-B sees null under both kinds.
      const bSawBehavioral = await runWithTenantContext(B_CTX, async () =>
        knowledgeRepos.findById('behavioral_hint', 'shared_hint_id_002'),
      );
      const bSawProcedure = await runWithTenantContext(B_CTX, async () =>
        knowledgeRepos.findById('procedure_hint', 'shared_hint_id_002'),
      );
      expect(bSawBehavioral).toBeNull();
      expect(bSawProcedure).toBeNull();

      // tenant-B can't mutate under either kind label.
      await runWithTenantContext(B_CTX, async () => {
        await expect(
          knowledgeRepos.update('behavioral_hint', 'shared_hint_id_002', {
            lifecycle_status: 'active',
          }),
        ).rejects.toMatchObject({ code: 'behavioral_hint_not_in_scope' });
        await expect(
          knowledgeRepos.update('procedure_hint', 'shared_hint_id_002', {
            lifecycle_status: 'active',
          }),
        ).rejects.toMatchObject({ code: 'procedure_hint_not_in_scope' });
      });

      // Row state unchanged.
      expect(findRow(hintTable, 'shared_hint_id_002')!.lifecycle_status).toBe(
        'pending_review',
      );
    });

    it('an update under one hint-kind is observable under the OTHER hint-kind (shared row)', async () => {
      // Pins the shared-storage write semantics. Updating
      // `behavioral_hint`(id) and re-reading as `procedure_hint`(id)
      // must reflect the change — they are the same row.
      tableOf(hintTable).push(
        baseHint({
          id: 'shared_hint_id_003',
          tenant_id: 'tenant-A',
          agent_id: 'agent-A',
          lifecycle_status: 'pending_review',
        }),
      );
      const { knowledgeRepos } = await import(
        '@/control-plane/knowledge-state-machine/repos.js'
      );
      await runWithTenantContext(A_CTX, async () => {
        await knowledgeRepos.update('behavioral_hint', 'shared_hint_id_003', {
          lifecycle_status: 'active',
        });
        const viaProcedure = await knowledgeRepos.findById(
          'procedure_hint',
          'shared_hint_id_003',
        );
        expect(viaProcedure!.lifecycle_status).toBe('active');
      });
    });
  });
});
