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
  const desc = (col: unknown) => ({ __desc: isColRef(col) ? col.__col : col });
  // Repo uses sql`agent_id IS NULL` both as a WHERE leaf AND as an orderBy
  // expression. Map to predicate that matches null on agent_id; harmless as
  // an orderBy.
  const sql = (strings: TemplateStringsArray): PredObj => {
    const text = strings.join('');
    if (text.includes('agent_id IS NULL')) {
      return { __pred: (row: Row) => row.agent_id === null };
    }
    return { __pred: () => true };
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
  private _orderDescCol: string | null = null;
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
      if (a && typeof a === 'object' && '__desc' in (a as object)) {
        this._orderDescCol = String((a as any).__desc);
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
    if (this._orderDescCol) {
      const c = this._orderDescCol;
      rows = [...rows].sort((a, b) => (b[c] > a[c] ? 1 : b[c] < a[c] ? -1 : 0));
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
  it('listSummariesPage: tenant-A page only contains tenant-A rows; hasMore is computed only over tenant-A', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const page = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => skillsRepo.listSummariesPage(),
    );
    const ids = idsOf(page.items);
    expect(ids.sort()).toEqual(['s_A_extra', 's_A_owned', 's_A_shared'].sort());
    for (const banned of ['s_B_owned', 's_B_shared', 's_B_extra']) {
      expect(ids).not.toContain(banned);
    }
    // With only 3 tenant-A rows and a cap of 200, hasMore is false REGARDLESS
    // of how many tenant-B rows exist (proves the probe is tenant-scoped).
    expect(page.hasMore).toBe(false);
  });

  it('listSummariesPage: symmetric — tenant-B page only contains tenant-B rows', async () => {
    seedTwoTenants();
    const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
    const page = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () => skillsRepo.listSummariesPage(),
    );
    const ids = idsOf(page.items);
    expect(ids.sort()).toEqual(['s_B_extra', 's_B_owned', 's_B_shared'].sort());
    for (const banned of ['s_A_owned', 's_A_shared', 's_A_extra']) {
      expect(ids).not.toContain(banned);
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
});
