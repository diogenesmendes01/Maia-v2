/**
 * Issue #230 — Cross-tenant (cross-empresa) isolation invariant for the
 * procedural memory layer (`learned_rules`) MUTATIONS.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Procedural-memory-specific contract this spec PROVES:
 *   The 3 mutators on `rulesRepo` — `incrementAcerto`, `incrementErro`,
 *   `setStatus` — pin `tenant_id = <ctx> AND agent_id = <ctx>` in the WHERE
 *   clause of their UPDATE, AND throw `TypedError('rule_not_in_scope', ...)`
 *   when 0 rows match (foreign-tenant id, foreign-agent id, OR unknown id).
 *
 * Before this fix the WHERE was `id = ?` only — any agent in any tenant
 * could mutate ANY rule by knowing the UUID. That broke the inviolable
 * cross-tenant isolation invariant for procedural memory (reads via
 * `listActive` / `findByContext` / `byId` were already scoped, but writes
 * leaked).
 *
 * Strategy:
 *   - Mock `drizzle-orm` so `eq`/`and` produce predicate-bearing objects
 *     (`{ __pred(row) }`) that our fake builder can evaluate. `sql` is
 *     passed through opaquely (not used in the UPDATE WHERE clauses we
 *     care about; it appears in the SET expressions where we evaluate it
 *     symbolically).
 *   - Mock `@/db/schema.js` with a proxy table object whose columns resolve
 *     to `{ __col: <name> }`.
 *   - Mock `@/db/client.js` with an in-memory `db.update()` chain that:
 *       1. captures the WHERE predicate from `where(...)`,
 *       2. captures the SET object from `set(...)` (with symbolic sql exprs
 *          for `acertos + 1`, `LEAST(...)`, `GREATEST(...)`),
 *       3. captures the RETURNING column projection,
 *       4. on `await`: filters the store by the predicate, applies SET to
 *          each matching row, returns the projection (so the production
 *          code's `rows.length === 0` check fires correctly).
 *   - Wrap every test in `runWithTenantContext({tenant_id, agent_id}, ...)`
 *     so the production code's `getCurrentTenant()`/`getCurrentAgent()`
 *     return the routed values.
 *
 * Seed (two tenants, four rules):
 *   tenant-A / agent-A: { rule_A_alpha, rule_A_beta }
 *   tenant-B / agent-B: { rule_B_gamma, rule_B_delta }
 *
 * For every mutator we run:
 *   - SUCCESS path: routed as tenant-A/agent-A, mutate rule_A_alpha → asserts
 *     the row's columns were ACTUALLY updated (acertos +1, confianca capped,
 *     etc.).
 *   - REJECTION path: routed as tenant-A/agent-A, attempt to mutate
 *     rule_B_gamma → asserts `TypedError('rule_not_in_scope', ...)` is thrown
 *     AND that tenant-B's row was NOT touched (defense in depth).
 *   - SYMMETRY: same shape routed as tenant-B/agent-B against tenant-A's id.
 *
 * Adversarial seed (`seedTwoTenantsReverse`): tenant-B rules inserted FIRST
 * so a missing tenant_id filter on the UPDATE would surface as tenant-B's
 * row sliding in front of tenant-A's (the failure mode the bug actually
 * has). The production WHERE pins `tenant_id` AND `agent_id`, so row order
 * is irrelevant — the test exists to PROVE that with the worst seed order
 * the guard still fires.
 *
 * This does NOT use a real DB (out of scope for this PR; P9a tracks the
 * real-Postgres proof). The fake faithfully reproduces drizzle's
 * `update().set().where().returning()` semantics against the seeded rows
 * so the REAL `rulesRepo` code paths are exercised end-to-end — only the
 * SQL execution layer is replaced.
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

// Symbolic SQL marker — for SET expressions like `acertos + 1`,
// `LEAST(1.00, confianca + 0.10)`, `GREATEST(0.00, confianca - 0.20)`.
// We evaluate them against the row being updated.
interface SqlExpr {
  __sqlEval: (row: Row) => unknown;
}
function isSqlExpr(x: unknown): x is SqlExpr {
  return !!x && typeof x === 'object' && '__sqlEval' in (x as object);
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
  // Pass-through stubs for operators the production code may import even if
  // unused on the UPDATE paths under test.
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
  // sql`acertos + 1` / sql`LEAST(...)` / sql`GREATEST(...)` — for the SET
  // expressions. We parse the literal template enough to evaluate against the
  // row being updated. Anything we don't recognise falls back to "no change"
  // so a future code edit doesn't silently break under this mock.
  const sql = (strings: TemplateStringsArray, ..._vals: unknown[]): SqlExpr => {
    const text = strings.join('');
    if (text.includes('acertos + 1')) {
      return { __sqlEval: (row) => (row.acertos as number) + 1 };
    }
    if (text.includes('erros + 1')) {
      return { __sqlEval: (row) => (row.erros as number) + 1 };
    }
    if (text.includes('LEAST(1.00, confianca + 0.10)')) {
      return {
        __sqlEval: (row) =>
          Math.min(1.0, Number(row.confianca) + 0.1),
      };
    }
    if (text.includes('GREATEST(0.00, confianca - 0.20)')) {
      return {
        __sqlEval: (row) =>
          Math.max(0.0, Number(row.confianca) - 0.2),
      };
    }
    return { __sqlEval: () => undefined };
  };
  return { eq, and, or, desc, sql, inArray, isNull, ne, gt, lt };
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
// `src/db/repositories.ts` imports so its top-level binding resolution
// succeeds. Only `learned_rules` is exercised at runtime by this test; the
// rest are inert stubs.
vi.mock('@/db/schema.js', () => {
  const tables = [
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
    'admin_audit_log',
    'debug_snapshot_grants',
    'global_settings',
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
      // Apply SET values: literal values overwrite, SqlExpr values are
      // evaluated against the row pre-update.
      for (const [k, v] of Object.entries(this._setValues)) {
        if (isSqlExpr(v)) {
          row[k] = v.__sqlEval(row);
        } else {
          row[k] = v;
        }
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
    return tableOf(this._table).filter(this._pred).slice(0, this._limit).map((r) => ({ ...r }));
  }
  then(resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) {
    try {
      resolve(this.exec());
    } catch (e) {
      reject?.(e);
    }
  }
}

function makeDbHandle() {
  return {
    select: () => new SelectBuilder(),
    insert: () => ({
      values: () => ({
        returning: () => ({ then: (r: (v: Row[]) => unknown) => r([]) }),
      }),
    }),
    update: (table: unknown) => new UpdateBuilder(table),
  };
}

vi.mock('@/db/client.js', () => {
  const db = makeDbHandle();
  const withTx = async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(makeDbHandle());
  return { db, withTx };
});

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
    confianca: 0.5,
    acertos: 0,
    erros: 0,
    ativa: true,
    exemplo_origem_id: null,
    lifecycle_status: 'active',
    evidence_count: 1,
    lifecycle_transitions: [],
    last_recall_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

// Default seed: tenant-A inserted FIRST. The mutations under test don't rely
// on ordering, but having a deterministic baseline helps test reads.
function seedTwoTenants() {
  tableOf(rulesTable).push(
    baseRule({ id: 'rule_A_alpha', tenant_id: 'tenant-A', agent_id: 'agent-A', tipo: 'foo' }),
    baseRule({ id: 'rule_A_beta',  tenant_id: 'tenant-A', agent_id: 'agent-A', tipo: 'bar' }),
  );
  tableOf(rulesTable).push(
    baseRule({ id: 'rule_B_gamma', tenant_id: 'tenant-B', agent_id: 'agent-B', tipo: 'foo' }),
    baseRule({ id: 'rule_B_delta', tenant_id: 'tenant-B', agent_id: 'agent-B', tipo: 'bar' }),
  );
}

// Adversarial seed: tenant-B rules inserted FIRST. With a missing tenant_id
// filter on the UPDATE WHERE, the first matching `id = ?` row would be
// tenant-B's. The production WHERE pins tenant_id+agent_id, so row order is
// irrelevant — this seed exists to prove that explicitly.
function seedTwoTenantsReverse() {
  tableOf(rulesTable).push(
    baseRule({ id: 'rule_B_gamma', tenant_id: 'tenant-B', agent_id: 'agent-B', tipo: 'foo' }),
    baseRule({ id: 'rule_B_delta', tenant_id: 'tenant-B', agent_id: 'agent-B', tipo: 'bar' }),
  );
  tableOf(rulesTable).push(
    baseRule({ id: 'rule_A_alpha', tenant_id: 'tenant-A', agent_id: 'agent-A', tipo: 'foo' }),
    baseRule({ id: 'rule_A_beta',  tenant_id: 'tenant-A', agent_id: 'agent-A', tipo: 'bar' }),
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

describe('Issue #230 — procedural memory rule mutations are tenant/agent-scoped', () => {
  describe('incrementAcerto', () => {
    it('SUCCESS — same-scope mutation increments acertos and bumps confianca', async () => {
      seedTwoTenants();
      const { rulesRepo } = await import('@/db/repositories.js');
      await runWithTenantContext(A_CTX, async () => {
        await rulesRepo.incrementAcerto('rule_A_alpha');
      });
      const row = findRow('rule_A_alpha');
      expect(row).toBeDefined();
      expect(row!.acertos).toBe(1);
      expect(row!.confianca).toBeCloseTo(0.6, 5);
    });

    it('REJECTION — tenant-A context cannot mutate tenant-B rule (throws rule_not_in_scope)', async () => {
      seedTwoTenants();
      const { rulesRepo } = await import('@/db/repositories.js');
      const { TypedError } = await import('@/lib/utils.js');
      await runWithTenantContext(A_CTX, async () => {
        await expect(rulesRepo.incrementAcerto('rule_B_gamma')).rejects.toBeInstanceOf(TypedError);
        await expect(rulesRepo.incrementAcerto('rule_B_gamma')).rejects.toMatchObject({
          code: 'rule_not_in_scope',
        });
      });
      // Defense in depth: tenant-B's row was NOT touched.
      const rowB = findRow('rule_B_gamma');
      expect(rowB!.acertos).toBe(0);
      expect(rowB!.confianca).toBe(0.5);
    });

    it('SYMMETRY — tenant-B context cannot mutate tenant-A rule', async () => {
      seedTwoTenants();
      const { rulesRepo } = await import('@/db/repositories.js');
      await runWithTenantContext(B_CTX, async () => {
        await expect(rulesRepo.incrementAcerto('rule_A_alpha')).rejects.toMatchObject({
          code: 'rule_not_in_scope',
        });
      });
      expect(findRow('rule_A_alpha')!.acertos).toBe(0);
    });

    it('ADVERSARIAL SEED — tenant-B inserted first, tenant-A mutation still hits tenant-A row only', async () => {
      seedTwoTenantsReverse();
      const { rulesRepo } = await import('@/db/repositories.js');
      await runWithTenantContext(A_CTX, async () => {
        await rulesRepo.incrementAcerto('rule_A_alpha');
      });
      expect(findRow('rule_A_alpha')!.acertos).toBe(1);
      // Tenant-B's row (inserted first in the store) must NOT have been touched.
      expect(findRow('rule_B_gamma')!.acertos).toBe(0);
      expect(findRow('rule_B_delta')!.acertos).toBe(0);
    });

    it('REJECTION — unknown id (not in any tenant) also throws rule_not_in_scope', async () => {
      seedTwoTenants();
      const { rulesRepo } = await import('@/db/repositories.js');
      await runWithTenantContext(A_CTX, async () => {
        await expect(rulesRepo.incrementAcerto('rule_does_not_exist')).rejects.toMatchObject({
          code: 'rule_not_in_scope',
        });
      });
    });

    it('REJECTION — same-tenant but cross-agent id throws rule_not_in_scope', async () => {
      // Seed: tenant-A but a row owned by a DIFFERENT agent within tenant-A.
      tableOf(rulesTable).push(
        baseRule({ id: 'rule_A_other_agent', tenant_id: 'tenant-A', agent_id: 'agent-OTHER' }),
      );
      const { rulesRepo } = await import('@/db/repositories.js');
      await runWithTenantContext(A_CTX, async () => {
        await expect(rulesRepo.incrementAcerto('rule_A_other_agent')).rejects.toMatchObject({
          code: 'rule_not_in_scope',
        });
      });
      expect(findRow('rule_A_other_agent')!.acertos).toBe(0);
    });
  });

  describe('incrementErro', () => {
    it('SUCCESS — same-scope mutation increments erros and dampens confianca', async () => {
      seedTwoTenants();
      const { rulesRepo } = await import('@/db/repositories.js');
      await runWithTenantContext(A_CTX, async () => {
        await rulesRepo.incrementErro('rule_A_alpha');
      });
      const row = findRow('rule_A_alpha');
      expect(row!.erros).toBe(1);
      expect(row!.confianca).toBeCloseTo(0.3, 5);
    });

    it('REJECTION — tenant-A context cannot mutate tenant-B rule', async () => {
      seedTwoTenants();
      const { rulesRepo } = await import('@/db/repositories.js');
      await runWithTenantContext(A_CTX, async () => {
        await expect(rulesRepo.incrementErro('rule_B_gamma')).rejects.toMatchObject({
          code: 'rule_not_in_scope',
        });
      });
      expect(findRow('rule_B_gamma')!.erros).toBe(0);
    });

    it('SYMMETRY — tenant-B context cannot mutate tenant-A rule', async () => {
      seedTwoTenants();
      const { rulesRepo } = await import('@/db/repositories.js');
      await runWithTenantContext(B_CTX, async () => {
        await expect(rulesRepo.incrementErro('rule_A_alpha')).rejects.toMatchObject({
          code: 'rule_not_in_scope',
        });
      });
      expect(findRow('rule_A_alpha')!.erros).toBe(0);
    });

    it('ADVERSARIAL SEED — B-first does not change behaviour', async () => {
      seedTwoTenantsReverse();
      const { rulesRepo } = await import('@/db/repositories.js');
      await runWithTenantContext(A_CTX, async () => {
        await rulesRepo.incrementErro('rule_A_alpha');
      });
      expect(findRow('rule_A_alpha')!.erros).toBe(1);
      expect(findRow('rule_B_gamma')!.erros).toBe(0);
    });
  });

  describe('setStatus', () => {
    it('SUCCESS — same-scope mutation updates ativa and confianca', async () => {
      seedTwoTenants();
      const { rulesRepo } = await import('@/db/repositories.js');
      await runWithTenantContext(A_CTX, async () => {
        await rulesRepo.setStatus('rule_A_alpha', { ativa: false, confianca: 0.95 });
      });
      const row = findRow('rule_A_alpha');
      expect(row!.ativa).toBe(false);
      // Production stringifies confianca via `String(update.confianca)`.
      expect(row!.confianca).toBe('0.95');
    });

    it('REJECTION — tenant-A context cannot setStatus on tenant-B rule', async () => {
      seedTwoTenants();
      const { rulesRepo } = await import('@/db/repositories.js');
      await runWithTenantContext(A_CTX, async () => {
        await expect(
          rulesRepo.setStatus('rule_B_gamma', { ativa: false }),
        ).rejects.toMatchObject({ code: 'rule_not_in_scope' });
      });
      expect(findRow('rule_B_gamma')!.ativa).toBe(true);
    });

    it('SYMMETRY — tenant-B context cannot setStatus on tenant-A rule', async () => {
      seedTwoTenants();
      const { rulesRepo } = await import('@/db/repositories.js');
      await runWithTenantContext(B_CTX, async () => {
        await expect(
          rulesRepo.setStatus('rule_A_alpha', { ativa: false }),
        ).rejects.toMatchObject({ code: 'rule_not_in_scope' });
      });
      expect(findRow('rule_A_alpha')!.ativa).toBe(true);
    });

    it('ADVERSARIAL SEED — B-first does not change behaviour', async () => {
      seedTwoTenantsReverse();
      const { rulesRepo } = await import('@/db/repositories.js');
      await runWithTenantContext(A_CTX, async () => {
        await rulesRepo.setStatus('rule_A_alpha', { ativa: false });
      });
      expect(findRow('rule_A_alpha')!.ativa).toBe(false);
      expect(findRow('rule_B_gamma')!.ativa).toBe(true);
    });

    it('REJECTION — empty update on foreign rule still throws (guard fires before SET inspection)', async () => {
      seedTwoTenants();
      const { rulesRepo } = await import('@/db/repositories.js');
      await runWithTenantContext(A_CTX, async () => {
        // Even with no actual changes (only updated_at), the cross-tenant
        // attempt MUST surface as rule_not_in_scope — the guard is the WHERE
        // clause, not the SET payload.
        await expect(
          rulesRepo.setStatus('rule_B_gamma', {}),
        ).rejects.toMatchObject({ code: 'rule_not_in_scope' });
      });
    });
  });
});
