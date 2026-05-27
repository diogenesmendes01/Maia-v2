/**
 * Issue #218 — Cross-tenant (cross-empresa) isolation invariant tests.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Skill-registry-specific contract this spec PROVES:
 *   Skills com `agent_id IS NULL` são TENANT-WIDE (compartilhadas entre os
 *   agentes do mesmo tenant), MAS NUNCA cross-tenant. Todas as queries de
 *   leitura DEVEM respeitar o `WHERE tenant_id = <ctx>`, de forma que o
 *   ramo `agent_id IS NULL` só possa unir skills do tenant roteado — jamais
 *   skills de outra empresa.
 *
 * Strategy (mirrors skills-repo-atomic.spec.ts):
 *   - mock `drizzle-orm` so eq/and/or/desc/sql produce predicate-bearing
 *     objects (`{ __pred(row) }`) that our fake builder can evaluate;
 *   - mock `@/db/schema.js` with proxy table objects whose columns resolve
 *     to `{ __col: <name> }`;
 *   - mock `@/db/client.js` with an in-memory `db.select/insert/update/withTx`
 *     fake that runs each predicate against the seeded store.
 *
 * Seed (two tenants):
 *   tenant-A: { s_A_owned (agent_id=agent-A), s_A_shared (agent_id=NULL) }
 *   tenant-B: { s_B_owned (agent_id=agent-B), s_B_shared (agent_id=NULL) }
 *
 * For every read method called out in issue #218 — listByCategory, listAll,
 * listSummaries, listSummariesPage, getById, getByDescriptor (+ findActive
 * and listVersions for completeness) — we route as tenant-A/agent-A and assert
 * the result contains ZERO tenant-B rows (including s_B_shared, which is
 * tenant-WIDE for tenant-B but MUST NOT cross into tenant-A). Then we run the
 * symmetric assertion as tenant-B/agent-B.
 *
 * This does NOT use a real DB (out of scope, per the issue's "idealmente
 * P9a"). The fake faithfully reproduces drizzle's WHERE/ORDER BY/LIMIT
 * semantics against the seeded rows so the REAL skills-repo code paths are
 * exercised end-to-end — only the SQL execution layer is replaced.
 *
 * --------------------------------------------------------------------------
 * Codex PR #222 review fixes (items 2, 3, 4, 5, 6, 8):
 *  - Fake `listByCategory`/etc. now evaluate the FULL production predicate
 *    including `status='active'` (item 2 / fidelity).
 *  - Adversarial seed order: every singleton test (`limit(1)`) runs with BOTH
 *    insertion orders (A-first AND B-first) so a missing tenant_id filter on
 *    the WHERE would surface as the OTHER tenant's row sliding in front of
 *    the routed tenant's row (item 3 / CRITICAL).
 *  - Every test that asserts "as tenant-A no tenant-B leak" has a sibling
 *    "as tenant-B no tenant-A leak" (item 4 / symmetry).
 *  - The fake `orderBy` evaluates the `sql\`agent_id IS NULL\`` template as a
 *    SORT KEY (NULLS-LAST style) so production's `ORDER BY agent_id IS NULL`
 *    truly determines which row wins in findActive (item 5).
 *  - `listSummariesPage` is exercised at high cardinality (>200 per tenant)
 *    so a cross-tenant leak would surface as a tenant-B row in tenant-A's
 *    page; we assert per-row tenant_id, not just `hasMore=false` (item 6).
 *  - Method overload branches: `findActive(descriptor, agentId)` explicit,
 *    `listVersions` with explicit agent + with null, `getByDescriptor` with
 *    explicit version (item 8).
 *  - Regression test for the `status='active'` filter on `listByCategory`
 *    seeded with `status='inactive'` rows that MUST NOT surface (item 2).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// In-memory store + drizzle/db fakes (pattern from skills-repo-atomic.spec.ts)
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

// Marker for SQL expressions that we treat as a SORT KEY (not a predicate)
// when seen inside orderBy(). The repo uses `sql\`agent_id IS NULL\`` as both
// a WHERE leaf AND an orderBy sort key (NULLS LAST style: rows where
// agent_id IS NULL come AFTER rows where agent_id IS NOT NULL because
// `false<true` in SQL boolean ordering, i.e. real-agent rows first).
interface SortKey {
  __sortKey: (row: Row) => number;
  __dir?: 'asc' | 'desc';
}
function isSortKey(x: unknown): x is SortKey {
  return !!x && typeof x === 'object' && '__sortKey' in (x as object);
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
  // desc() applied to a plain column ref → sort key (descending).
  const desc = (col: unknown): SortKey => {
    if (isColRef(col)) {
      const c = col.__col;
      return {
        __sortKey: (row: Row) => {
          const v = row[c];
          if (v == null) return -Infinity;
          if (typeof v === 'number') return v;
          if (v instanceof Date) return v.getTime();
          // string fallback: lex by char code (good enough for descriptors).
          return Array.from(String(v)).reduce(
            (acc, ch) => acc + ch.charCodeAt(0) / 1e6,
            0,
          );
        },
        __dir: 'desc',
      };
    }
    // desc(sortKey) — flip direction. Repo doesn't do this today, but keep it
    // defensive.
    if (isSortKey(col)) {
      return { ...col, __dir: col.__dir === 'desc' ? 'asc' : 'desc' };
    }
    return { __sortKey: () => 0, __dir: 'desc' };
  };
  // The repo uses sql`agent_id IS NULL` in two contexts:
  //   1. inside a WHERE / OR predicate (item 5: fidelity matters)
  //   2. as an orderBy SORT KEY in findActive — production ordering is
  //      `ORDER BY agent_id IS NULL` (ASC), which puts rows where the
  //      expression is FALSE (real agent_id) BEFORE rows where the
  //      expression is TRUE (agent_id is NULL). That is the NULLS-LAST
  //      semantic the repo relies on so an agent-scoped match beats a
  //      tenant-wide match for the same descriptor.
  // We return a dual-shape: it carries BOTH `__pred` AND `__sortKey`. The
  // builder's `where()` reads `__pred`; `orderBy()` reads `__sortKey`.
  const sql = (strings: TemplateStringsArray): PredObj & SortKey => {
    const text = strings.join('');
    if (text.includes('agent_id IS NULL')) {
      return {
        __pred: (row: Row) => row.agent_id === null,
        // ASC: false (0) first, true (1) last. So real-agent rows come BEFORE
        // tenant-wide rows for the same descriptor — matches production.
        __sortKey: (row: Row) => (row.agent_id === null ? 1 : 0),
        __dir: 'asc',
      };
    }
    return {
      __pred: () => true,
      __sortKey: () => 0,
      __dir: 'asc',
    };
  };
  return { eq, and, or, desc, sql };
});

function makeTable(): any {
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => ({ __col: prop }),
    },
  );
}

vi.mock('@/db/schema.js', () => {
  const skills = makeTable();
  const admin_audit_log = makeTable();
  return { skills, admin_audit_log };
});

class SelectBuilder {
  private _table: unknown = null;
  private _pred: Pred = () => true;
  private _cols: Record<string, ColRef> | null;
  private _limit = Infinity;
  // Multiple sort keys — orderBy(a, b, c) sorts by a then b then c. Each entry
  // carries its own direction. We collect SortKey shapes only; bare column
  // refs are promoted to ASC sort keys to match production behaviour.
  private _sortKeys: SortKey[] = [];
  constructor(cols?: Record<string, ColRef> | null) {
    this._cols = cols ?? null;
  }
  from(t: unknown) {
    this._table = t;
    return this;
  }
  where(p: unknown) {
    if (isPredObj(p)) this._pred = p.__pred;
    return this;
  }
  orderBy(...args: unknown[]) {
    for (const a of args) {
      if (isSortKey(a)) {
        this._sortKeys.push(a);
      } else if (isColRef(a)) {
        // Bare column ref → ASC sort by that column.
        const c = a.__col;
        this._sortKeys.push({
          __sortKey: (row: Row) => {
            const v = row[c];
            if (v == null) return -Infinity;
            if (typeof v === 'number') return v;
            if (v instanceof Date) return v.getTime();
            return Array.from(String(v)).reduce(
              (acc, ch) => acc + ch.charCodeAt(0) / 1e6,
              0,
            );
          },
          __dir: 'asc',
        });
      }
    }
    return this;
  }
  limit(n: number) {
    this._limit = n;
    return this;
  }
  for(_mode: string) {
    return this;
  }
  private exec(): Row[] {
    let rows = tableOf(this._table).filter(this._pred);
    if (this._sortKeys.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const sk of this._sortKeys) {
          const av = sk.__sortKey(a);
          const bv = sk.__sortKey(b);
          if (av < bv) return sk.__dir === 'desc' ? 1 : -1;
          if (av > bv) return sk.__dir === 'desc' ? -1 : 1;
        }
        return 0;
      });
    }
    rows = rows.slice(0, this._limit);
    if (this._cols) {
      const keys = Object.keys(this._cols);
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

function makeDbHandle() {
  return {
    select: (cols?: Record<string, ColRef> | null) => new SelectBuilder(cols),
    // insert/update unused by the read tests but kept for shape parity.
    insert: () => ({
      values: () => ({ returning: () => ({ then: (r: (v: Row[]) => unknown) => r([]) }) }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ then: (r: (v: Row[]) => unknown) => r([]) }) }),
    }),
  };
}

vi.mock('@/db/client.js', () => {
  const db = makeDbHandle();
  const withTx = async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(makeDbHandle());
  return { db, withTx };
});

// ---------------------------------------------------------------------------
// Seed helpers — two-tenant fixture.
// ---------------------------------------------------------------------------
let skillsTable: any;

beforeEach(async () => {
  store.clear();
  const schema = await import('@/db/schema.js');
  skillsTable = (schema as any).skills;
});

function baseRow(over: Row): Row {
  return {
    skill_descriptor: 'descr',
    category: 'tool_mediated',
    execution_mode: 'prompt_only',
    goal: 'g',
    when_to_use: 'w',
    procedure: {},
    constraints: [],
    input_schema: {},
    output_schema: {},
    allowed_tools: [],
    policy_descriptors: [],
    success_criteria: [],
    failure_modes: [],
    runtime_hints: {},
    status: 'active',
    version: 1,
    proposed_by: 'u',
    proposed_reason: null,
    approved_by: null,
    approved_at: null,
    activated_at: new Date(),
    deprecated_at: null,
    rolled_back_at: null,
    rollback_reason: null,
    created_at: new Date(),
    ...over,
  };
}

// Default seed: tenant-A inserted BEFORE tenant-B. This is the original order;
// keep it as the default so existing tests stay symmetric with the production
// migration order intuition. Item 3 tests use `seedTwoTenantsReverse` to flip.
function seedTwoTenants() {
  // tenant-A: own agent skill + tenant-wide skill (shared INSIDE tenant-A).
  tableOf(skillsTable).push(
    baseRow({ id: 's_A_owned',  tenant_id: 'tenant-A', agent_id: 'agent-A', skill_descriptor: 'shared.descr', category: 'tool_mediated' }),
    baseRow({ id: 's_A_shared', tenant_id: 'tenant-A', agent_id: null,      skill_descriptor: 'shared.descr', category: 'tool_mediated' }),
  );
  // tenant-B: own agent skill + tenant-wide skill (shared INSIDE tenant-B).
  // The `s_B_shared` row is the canonical leak risk — it is tenant-wide for
  // tenant-B, but MUST NEVER appear under a tenant-A query.
  tableOf(skillsTable).push(
    baseRow({ id: 's_B_owned',  tenant_id: 'tenant-B', agent_id: 'agent-B', skill_descriptor: 'shared.descr', category: 'tool_mediated' }),
    baseRow({ id: 's_B_shared', tenant_id: 'tenant-B', agent_id: null,      skill_descriptor: 'shared.descr', category: 'tool_mediated' }),
  );
  // A few extra differently-named/typed rows so listAll/listSummaries surface
  // > 1 row per tenant and the cross-tenant absence is a stronger signal.
  tableOf(skillsTable).push(
    baseRow({ id: 's_A_extra', tenant_id: 'tenant-A', agent_id: 'agent-A', skill_descriptor: 'a.extra', category: 'classify', version: 2 }),
    baseRow({ id: 's_B_extra', tenant_id: 'tenant-B', agent_id: 'agent-B', skill_descriptor: 'b.extra', category: 'classify', version: 2 }),
  );
}

// Item 3 (CRITICAL — adversarial seed): same rows as seedTwoTenants but with
// tenant-B inserted FIRST. A `limit(1)` query routed to tenant-A must STILL
// return a tenant-A row even though tenant-B rows come first in the unfiltered
// candidate set. If the WHERE clause silently dropped `tenant_id`, this seed
// would surface the leak as a tenant-B row sliding in front of tenant-A's.
function seedTwoTenantsReverse() {
  tableOf(skillsTable).push(
    baseRow({ id: 's_B_owned',  tenant_id: 'tenant-B', agent_id: 'agent-B', skill_descriptor: 'shared.descr', category: 'tool_mediated' }),
    baseRow({ id: 's_B_shared', tenant_id: 'tenant-B', agent_id: null,      skill_descriptor: 'shared.descr', category: 'tool_mediated' }),
  );
  tableOf(skillsTable).push(
    baseRow({ id: 's_A_owned',  tenant_id: 'tenant-A', agent_id: 'agent-A', skill_descriptor: 'shared.descr', category: 'tool_mediated' }),
    baseRow({ id: 's_A_shared', tenant_id: 'tenant-A', agent_id: null,      skill_descriptor: 'shared.descr', category: 'tool_mediated' }),
  );
  tableOf(skillsTable).push(
    baseRow({ id: 's_B_extra', tenant_id: 'tenant-B', agent_id: 'agent-B', skill_descriptor: 'b.extra', category: 'classify', version: 2 }),
    baseRow({ id: 's_A_extra', tenant_id: 'tenant-A', agent_id: 'agent-A', skill_descriptor: 'a.extra', category: 'classify', version: 2 }),
  );
}

function idsOf<T extends { id: string }>(rows: T[]): string[] {
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Cross-tenant isolation — REAL skillsRepo across every read method.
// ---------------------------------------------------------------------------
describe('skillsRepo — cross-tenant isolation (issue #218)', () => {
  // listByCategory --------------------------------------------------------
  it('listByCategory: tenant-A query never returns tenant-B rows (incl. tenant-B `agent_id IS NULL`)', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const got = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.listByCategory('tool_mediated'),
    );
    const ids = idsOf(got);
    expect(ids.sort()).toEqual(['s_A_owned', 's_A_shared'].sort());
    expect(ids).not.toContain('s_B_owned');
    expect(ids).not.toContain('s_B_shared');
  });

  it('listByCategory: symmetric — tenant-B query never returns tenant-A rows', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const got = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () => skillsRepo.listByCategory('tool_mediated'),
    );
    const ids = idsOf(got);
    expect(ids.sort()).toEqual(['s_B_owned', 's_B_shared'].sort());
    expect(ids).not.toContain('s_A_owned');
    expect(ids).not.toContain('s_A_shared');
  });

  // listByCategory — item 2 / fidelity: status='active' filter.
  // Production listByCategory ALSO includes `eq(status, 'active')`. Seed
  // tenant-A with an INACTIVE row at the queried category — it MUST NOT
  // surface even though it is tenant-A's own row. This proves the fake
  // evaluates the FULL production predicate (status + tenant + agent), not a
  // tenant-only subset; a regression that drops `status` from the WHERE
  // would surface the inactive row.
  it("listByCategory: status='active' filter — inactive tenant-A rows are excluded (regression for fake fidelity)", async () => {
    tableOf(skillsTable).push(
      // active tenant-A skill — should surface
      baseRow({ id: 's_A_active', tenant_id: 'tenant-A', agent_id: 'agent-A', category: 'tool_mediated', status: 'active' }),
      // deprecated tenant-A skill — MUST NOT surface
      baseRow({ id: 's_A_deprecated', tenant_id: 'tenant-A', agent_id: 'agent-A', category: 'tool_mediated', status: 'deprecated' }),
      // proposed tenant-A skill — MUST NOT surface
      baseRow({ id: 's_A_proposed', tenant_id: 'tenant-A', agent_id: 'agent-A', category: 'tool_mediated', status: 'proposed' }),
    );
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const got = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.listByCategory('tool_mediated'),
    );
    const ids = idsOf(got);
    expect(ids).toContain('s_A_active');
    expect(ids).not.toContain('s_A_deprecated');
    expect(ids).not.toContain('s_A_proposed');
  });

  // listAll ---------------------------------------------------------------
  it('listAll: tenant-A sees only tenant-A rows across all categories', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const got = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.listAll(),
    );
    const ids = idsOf(got);
    expect(ids.sort()).toEqual(['s_A_extra', 's_A_owned', 's_A_shared'].sort());
    for (const banned of ['s_B_owned', 's_B_shared', 's_B_extra']) {
      expect(ids).not.toContain(banned);
    }
  });

  it('listAll: symmetric — tenant-B sees only tenant-B rows', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const got = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () => skillsRepo.listAll(),
    );
    const ids = idsOf(got);
    expect(ids.sort()).toEqual(['s_B_extra', 's_B_owned', 's_B_shared'].sort());
    for (const banned of ['s_A_owned', 's_A_shared', 's_A_extra']) {
      expect(ids).not.toContain(banned);
    }
  });

  // listSummaries ---------------------------------------------------------
  it('listSummaries: tenant-A summary list is tenant-A-only', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const got = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.listSummaries(),
    );
    const ids = idsOf(got);
    expect(ids.sort()).toEqual(['s_A_extra', 's_A_owned', 's_A_shared'].sort());
    for (const banned of ['s_B_owned', 's_B_shared', 's_B_extra']) {
      expect(ids).not.toContain(banned);
    }
  });

  it('listSummaries: symmetric — tenant-B summary list is tenant-B-only', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const got = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () => skillsRepo.listSummaries(),
    );
    const ids = idsOf(got);
    expect(ids.sort()).toEqual(['s_B_extra', 's_B_owned', 's_B_shared'].sort());
    for (const banned of ['s_A_owned', 's_A_shared', 's_A_extra']) {
      expect(ids).not.toContain(banned);
    }
  });

  // listSummariesPage -----------------------------------------------------
  // Item 6: hasMore=false alone doesn't prove scope. Replace with explicit
  // every-row-belongs-to-routed-tenant assertion.
  it('listSummariesPage: every row in tenant-A page belongs to tenant-A (per-row tenant_id check)', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const page = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.listSummariesPage(),
    );
    const ids = idsOf(page.items);
    expect(ids.sort()).toEqual(['s_A_extra', 's_A_owned', 's_A_shared'].sort());
    // Item 6: explicit per-row tenant_id assertion. Any leak surfaces here
    // even with `hasMore=false`.
    expect(page.items.every((r) => r.tenant_id === 'tenant-A')).toBe(true);
    for (const banned of ['s_B_owned', 's_B_shared', 's_B_extra']) {
      expect(ids).not.toContain(banned);
    }
  });

  it('listSummariesPage: symmetric — every row in tenant-B page belongs to tenant-B', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const page = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () => skillsRepo.listSummariesPage(),
    );
    const ids = idsOf(page.items);
    expect(ids.sort()).toEqual(['s_B_extra', 's_B_owned', 's_B_shared'].sort());
    expect(page.items.every((r) => r.tenant_id === 'tenant-B')).toBe(true);
    for (const banned of ['s_A_owned', 's_A_shared', 's_A_extra']) {
      expect(ids).not.toContain(banned);
    }
  });

  // Item 6 (continued): pagination math with > cap rows per tenant. Seed >200
  // rows for EACH tenant. The page returns up to SKILLS_LIST_MAX_LIMIT (200)
  // rows; we assert every row is tenant-A and no tenant-B row appears.
  it('listSummariesPage: with >200 rows per tenant, tenant-A page contains zero tenant-B rows (pagination math)', async () => {
    // 220 active tenant-A skills + 220 active tenant-B skills (well above the
    // 200-row cap). The probe fetches 201 rows; we slice to 200 and expect 0
    // tenant-B leak.
    for (let i = 0; i < 220; i++) {
      tableOf(skillsTable).push(
        baseRow({
          id: `s_A_${String(i).padStart(3, '0')}`,
          tenant_id: 'tenant-A',
          agent_id: 'agent-A',
          skill_descriptor: `a.${i}`,
          category: 'tool_mediated',
        }),
        baseRow({
          id: `s_B_${String(i).padStart(3, '0')}`,
          tenant_id: 'tenant-B',
          agent_id: 'agent-B',
          skill_descriptor: `b.${i}`,
          category: 'tool_mediated',
        }),
      );
    }
    const { skillsRepo, SKILLS_LIST_MAX_LIMIT } = await import('@/control-plane/skill-registry/skills-repo.js');
    const page = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.listSummariesPage(),
    );
    expect(page.items.length).toBe(SKILLS_LIST_MAX_LIMIT);
    // hasMore=true here because tenant-A alone has 220 > 200. Useful sanity.
    expect(page.hasMore).toBe(true);
    // The strict assertion: no tenant-B row appears in the page, regardless
    // of pagination math.
    for (const item of page.items) {
      expect(item.tenant_id).toBe('tenant-A');
      expect(item.id.startsWith('s_A_')).toBe(true);
    }
  });

  it('listSummariesPage: symmetric — with >200 rows per tenant, tenant-B page contains zero tenant-A rows', async () => {
    for (let i = 0; i < 220; i++) {
      tableOf(skillsTable).push(
        baseRow({
          id: `s_A_${String(i).padStart(3, '0')}`,
          tenant_id: 'tenant-A',
          agent_id: 'agent-A',
          skill_descriptor: `a.${i}`,
          category: 'tool_mediated',
        }),
        baseRow({
          id: `s_B_${String(i).padStart(3, '0')}`,
          tenant_id: 'tenant-B',
          agent_id: 'agent-B',
          skill_descriptor: `b.${i}`,
          category: 'tool_mediated',
        }),
      );
    }
    const { skillsRepo, SKILLS_LIST_MAX_LIMIT } = await import('@/control-plane/skill-registry/skills-repo.js');
    const page = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () => skillsRepo.listSummariesPage(),
    );
    expect(page.items.length).toBe(SKILLS_LIST_MAX_LIMIT);
    expect(page.hasMore).toBe(true);
    for (const item of page.items) {
      expect(item.tenant_id).toBe('tenant-B');
      expect(item.id.startsWith('s_B_')).toBe(true);
    }
  });

  // getById ---------------------------------------------------------------
  it('getById: tenant-A scope cannot read ANY tenant-B id (incl. tenant-B `agent_id IS NULL`)', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const leakedOwned = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.getById('s_B_owned'),
    );
    const leakedShared = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.getById('s_B_shared'),
    );
    expect(leakedOwned).toBeNull();
    expect(leakedShared).toBeNull(); // tenant-WIDE ≠ cross-tenant
    // Sanity: tenant-A own rows still resolve under tenant-A scope.
    const ownA = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.getById('s_A_owned'),
    );
    const sharedA = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.getById('s_A_shared'),
    );
    expect(ownA?.id).toBe('s_A_owned');
    expect(sharedA?.id).toBe('s_A_shared');
  });

  it('getById: symmetric — tenant-B scope cannot read tenant-A ids', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const leakedOwned = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () => skillsRepo.getById('s_A_owned'),
    );
    const leakedShared = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () => skillsRepo.getById('s_A_shared'),
    );
    expect(leakedOwned).toBeNull();
    expect(leakedShared).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Item 3 (CRITICAL) — adversarial seed order. limit(1) singletons would
  // pass even with a missing tenant_id filter if the routed tenant's row
  // happens to be first in the unfiltered candidate set. We re-run each
  // singleton with BOTH insertion orders.
  // ---------------------------------------------------------------------
  describe('item 3 — adversarial seed order for singleton (limit 1) queries', () => {
    for (const seedName of ['A-first', 'B-first'] as const) {
      const doSeed =
        seedName === 'A-first' ? seedTwoTenants : seedTwoTenantsReverse;

      it(`getByDescriptor with seed order [${seedName}]: tenant-A returns ONLY tenant-A row`, async () => {
        doSeed();
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        const got = await runWithTenantContext(
          { tenant_id: 'tenant-A', agent_id: 'agent-A' },
          () => skillsRepo.getByDescriptor('shared.descr'),
        );
        expect(got).not.toBeNull();
        expect(['s_A_owned', 's_A_shared']).toContain(got!.id);
        // Strongest check for adversarial order: explicit tenant_id check.
        expect(got!.tenant_id).toBe('tenant-A');
        expect(['s_B_owned', 's_B_shared']).not.toContain(got!.id);
      });

      it(`getByDescriptor with seed order [${seedName}]: symmetric — tenant-B returns ONLY tenant-B row`, async () => {
        doSeed();
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        const got = await runWithTenantContext(
          { tenant_id: 'tenant-B', agent_id: 'agent-B' },
          () => skillsRepo.getByDescriptor('shared.descr'),
        );
        expect(got).not.toBeNull();
        expect(['s_B_owned', 's_B_shared']).toContain(got!.id);
        expect(got!.tenant_id).toBe('tenant-B');
        expect(['s_A_owned', 's_A_shared']).not.toContain(got!.id);
      });

      it(`findActive with seed order [${seedName}]: tenant-A returns ONLY tenant-A row`, async () => {
        doSeed();
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        const got = await runWithTenantContext(
          { tenant_id: 'tenant-A', agent_id: 'agent-A' },
          () => skillsRepo.findActive('shared.descr'),
        );
        expect(got).not.toBeNull();
        expect(['s_A_owned', 's_A_shared']).toContain(got!.id);
        expect(got!.tenant_id).toBe('tenant-A');
        expect(['s_B_owned', 's_B_shared']).not.toContain(got!.id);
      });

      it(`findActive with seed order [${seedName}]: symmetric — tenant-B returns ONLY tenant-B row`, async () => {
        doSeed();
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        const got = await runWithTenantContext(
          { tenant_id: 'tenant-B', agent_id: 'agent-B' },
          () => skillsRepo.findActive('shared.descr'),
        );
        expect(got).not.toBeNull();
        expect(['s_B_owned', 's_B_shared']).toContain(got!.id);
        expect(got!.tenant_id).toBe('tenant-B');
        expect(['s_A_owned', 's_A_shared']).not.toContain(got!.id);
      });
    }
  });

  // ---------------------------------------------------------------------
  // Item 5 — ORDER BY fidelity. Production's findActive does
  // `ORDER BY agent_id IS NULL` (NULLS LAST). With BOTH a real-agent row
  // (s_A_owned) AND a tenant-wide row (s_A_shared) at the same descriptor,
  // findActive(descriptor) — agent_id=undefined → "current agent OR
  // tenant-wide" — MUST pick the AGENT-OWNED row first. If the fake
  // mistreats sql`agent_id IS NULL` as a predicate (the pre-fix bug), it
  // discards the tenant-wide candidate and the test passes by accident; if
  // it ignores ORDER BY, the tenant-wide row can win. The fixed fake puts
  // the sort key first → s_A_owned wins.
  // ---------------------------------------------------------------------
  it('item 5 — findActive (default) prefers agent-scoped over tenant-wide via NULLS-LAST ORDER BY', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const got = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.findActive('shared.descr'),
    );
    expect(got?.id).toBe('s_A_owned'); // agent-scoped wins over tenant-wide
  });

  it('item 5 — findActive (default) on tenant-B prefers tenant-B agent-scoped', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const got = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () => skillsRepo.findActive('shared.descr'),
    );
    expect(got?.id).toBe('s_B_owned');
  });

  // getByDescriptor -------------------------------------------------------
  it('getByDescriptor: tenant-A reading a descriptor present in BOTH tenants returns ONLY the tenant-A row', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    // Both tenants own a skill at 'shared.descr'. The query resolves under
    // tenant-A — it must pick a tenant-A row, NEVER s_B_owned or s_B_shared.
    const got = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.getByDescriptor('shared.descr'),
    );
    expect(got).not.toBeNull();
    expect(['s_A_owned', 's_A_shared']).toContain(got!.id);
    expect(['s_B_owned', 's_B_shared']).not.toContain(got!.id);
  });

  it('getByDescriptor: symmetric — tenant-B never picks up a tenant-A row for a shared descriptor', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const got = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () => skillsRepo.getByDescriptor('shared.descr'),
    );
    expect(got).not.toBeNull();
    expect(['s_B_owned', 's_B_shared']).toContain(got!.id);
    expect(['s_A_owned', 's_A_shared']).not.toContain(got!.id);
  });

  // findActive ------------------------------------------------------------
  it('findActive: tenant-A on a descriptor present in BOTH tenants returns ONLY a tenant-A row', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const got = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.findActive('shared.descr'),
    );
    expect(got).not.toBeNull();
    expect(['s_A_owned', 's_A_shared']).toContain(got!.id);
    expect(['s_B_owned', 's_B_shared']).not.toContain(got!.id);
  });

  it('findActive: explicit tenant-wide (agent_id=null) on tenant-A scope still returns ONLY tenant-A null-owner rows', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const got = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.findActive('shared.descr', null),
    );
    expect(got?.id).toBe('s_A_shared');
    // s_B_shared is also agent_id=null but belongs to tenant-B; MUST NOT leak.
    expect(got?.id).not.toBe('s_B_shared');
  });

  // listVersions ----------------------------------------------------------
  it('listVersions: tenant-A version history of a shared descriptor never includes tenant-B versions', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const got = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.listVersions('shared.descr'),
    );
    const ids = idsOf(got);
    // Versions for tenant-A only: s_A_owned and s_A_shared share the same
    // descriptor (different scope; that is the existing intra-tenant rule).
    expect(ids.sort()).toEqual(['s_A_owned', 's_A_shared'].sort());
    expect(ids).not.toContain('s_B_owned');
    expect(ids).not.toContain('s_B_shared');
  });

  it('listVersions: symmetric — tenant-B version history never includes tenant-A versions', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const got = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () => skillsRepo.listVersions('shared.descr'),
    );
    const ids = idsOf(got);
    expect(ids.sort()).toEqual(['s_B_owned', 's_B_shared'].sort());
    expect(ids).not.toContain('s_A_owned');
    expect(ids).not.toContain('s_A_shared');
  });

  // -----------------------------------------------------------------------
  // Item 8 — uncovered method overloads.
  // -----------------------------------------------------------------------
  describe('item 8 — uncovered method overload branches', () => {
    // findActive(descriptor, agentId) explicit — the explicit-agent branch in
    // skills-repo.ts:380-386. Tested previously only with the default-arg
    // (agent_id=undefined) and explicit-null cases.
    it('findActive(descriptor, agentId): explicit tenant-A agent — returns only tenant-A own row, never tenant-B', async () => {
      seedTwoTenants();
      const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
      const got = await runWithTenantContext(
        { tenant_id: 'tenant-A', agent_id: 'agent-A' },
        () => skillsRepo.findActive('shared.descr', 'agent-A'),
      );
      expect(got?.id).toBe('s_A_owned'); // exact agent_id match
      expect(got?.tenant_id).toBe('tenant-A');
    });

    it('findActive(descriptor, agentId): explicit tenant-B agent — returns only tenant-B own row, never tenant-A', async () => {
      seedTwoTenants();
      const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
      const got = await runWithTenantContext(
        { tenant_id: 'tenant-B', agent_id: 'agent-B' },
        () => skillsRepo.findActive('shared.descr', 'agent-B'),
      );
      expect(got?.id).toBe('s_B_owned');
      expect(got?.tenant_id).toBe('tenant-B');
    });

    // findActive: explicit agent != context agent must reject (anti-leak
    // guard from skills-repo.ts:382-384). Surfaces the agent_scope_violation
    // error path; cross-tenant data exists so a missing guard would leak.
    it('findActive(descriptor, agentId): mismatched agent_id throws agent_scope_violation (never returns cross-tenant data)', async () => {
      seedTwoTenants();
      const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
      // Context is tenant-A/agent-A; ask for agent-B (a different agent,
      // belongs to a different tenant in our seed). MUST throw, not return
      // tenant-B's row.
      await expect(
        runWithTenantContext(
          { tenant_id: 'tenant-A', agent_id: 'agent-A' },
          () => skillsRepo.findActive('shared.descr', 'agent-B'),
        ),
      ).rejects.toThrow(/agent_scope_violation/);
    });

    // listVersions with explicit agentId — scopeClauseFor branch in
    // skills-repo.ts:194: exactly that agent_id.
    it('listVersions(descriptor, explicit agentId): tenant-A asks for agent-A — returns only s_A_owned, excludes tenant-wide AND tenant-B', async () => {
      seedTwoTenants();
      const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
      const got = await runWithTenantContext(
        { tenant_id: 'tenant-A', agent_id: 'agent-A' },
        () => skillsRepo.listVersions('shared.descr', 'agent-A'),
      );
      const ids = idsOf(got);
      // ONLY the agent-scoped tenant-A version — tenant-wide s_A_shared is
      // excluded (scopeClauseFor explicit string = exactly that agent_id),
      // and tenant-B's two rows are excluded by tenant_id.
      expect(ids).toEqual(['s_A_owned']);
    });

    it('listVersions(descriptor, agentId: null): tenant-A asks for tenant-wide — returns only s_A_shared, excludes tenant-B tenant-wide', async () => {
      seedTwoTenants();
      const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
      const got = await runWithTenantContext(
        { tenant_id: 'tenant-A', agent_id: 'agent-A' },
        () => skillsRepo.listVersions('shared.descr', null),
      );
      const ids = idsOf(got);
      // ONLY the tenant-wide tenant-A version. tenant-B's tenant-wide row
      // s_B_shared shares the same `agent_id IS NULL` shape — a missing
      // tenant_id filter would surface it. It MUST NOT.
      expect(ids).toEqual(['s_A_shared']);
    });

    it('listVersions(descriptor, agentId: null): symmetric — tenant-B asks for tenant-wide — returns only s_B_shared', async () => {
      seedTwoTenants();
      const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
      const got = await runWithTenantContext(
        { tenant_id: 'tenant-B', agent_id: 'agent-B' },
        () => skillsRepo.listVersions('shared.descr', null),
      );
      const ids = idsOf(got);
      expect(ids).toEqual(['s_B_shared']);
    });

    // getByDescriptor with explicit version. Production query adds
    // `eq(version, version)` and limits to 1. With both tenants having the
    // same descriptor at version 1, the routed tenant's row must win.
    it('getByDescriptor(descriptor, version=1): tenant-A explicit version — returns only tenant-A row, never tenant-B', async () => {
      seedTwoTenants();
      const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
      const got = await runWithTenantContext(
        { tenant_id: 'tenant-A', agent_id: 'agent-A' },
        () => skillsRepo.getByDescriptor('shared.descr', 1),
      );
      expect(got).not.toBeNull();
      expect(got!.tenant_id).toBe('tenant-A');
      expect(['s_A_owned', 's_A_shared']).toContain(got!.id);
    });

    it('getByDescriptor(descriptor, version=1): symmetric — tenant-B explicit version — returns only tenant-B row, never tenant-A', async () => {
      seedTwoTenants();
      const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
      const got = await runWithTenantContext(
        { tenant_id: 'tenant-B', agent_id: 'agent-B' },
        () => skillsRepo.getByDescriptor('shared.descr', 1),
      );
      expect(got).not.toBeNull();
      expect(got!.tenant_id).toBe('tenant-B');
      expect(['s_B_owned', 's_B_shared']).toContain(got!.id);
    });

    it('getByDescriptor(descriptor, version=99): version mismatch — returns null even though tenant-B has version 1', async () => {
      seedTwoTenants();
      const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
      const got = await runWithTenantContext(
        { tenant_id: 'tenant-A', agent_id: 'agent-A' },
        () => skillsRepo.getByDescriptor('shared.descr', 99),
      );
      // tenant-A has no version 99; tenant-B has none either. But a missing
      // tenant_id filter combined with a missing version filter would surface
      // tenant-B's version 1. We expect null.
      expect(got).toBeNull();
    });
  });
});
