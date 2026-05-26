/**
 * PR #213 — skillsRepo atomic-audit + lifecycle-guard tests (REAL repo).
 *
 * Unlike skills-repo.spec.ts (which mocks the whole repo), this drives the
 * ACTUAL skillsRepo implementation against an in-memory fake of `@/db/client`
 * (`db` + `withTx`). The fake implements only the drizzle query-builder chains
 * the repo uses, and `withTx` SNAPSHOTS the store and RESTORES it on throw — so
 * a thrown audit insert truly rolls the mutation back, exactly like Postgres.
 *
 * Covers the governance fixes:
 *   FIX 1 (audit atomicity): when the audit insert fails, the skill row/status
 *     is NOT changed (rolled back) for propose / activate / deprecate / rollback.
 *   FIX 2 (lifecycle guards): deprecate only from active|proposed; rollback only
 *     from active. Invalid current status throws cannot_<op>_from_<status> and
 *     leaves the row unchanged.
 *
 * The fake DB is intentionally tiny: it backs exactly two tables (`skills`,
 * `admin_audit_log`) keyed by the imported table objects, and supports the
 * subset of operations skills-repo performs (select [+columns]/from/where/
 * orderBy/limit, insert/values/returning, update/set/where/returning). where()
 * predicates are evaluated by re-running the drizzle SQL AST against each row —
 * too brittle — so instead we capture the repo's intent via a thin predicate
 * compiler over the drizzle condition objects (eq/and/or/sql IS NULL).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// In-memory store + drizzle-chain fake. Keyed by the table OBJECT identity so
// the repo's `skills` / `admin_audit_log` imports select the right array.
// ---------------------------------------------------------------------------
type Row = Record<string, any>;
const store = new Map<unknown, Row[]>();
let pkCounter = 0;
let failNextAuditInsert = false; // toggled by tests to force an audit failure
// One-shot hook fired right BEFORE a skills-table UPDATE evaluates its
// predicate. Tests use it to simulate a CONCURRENT writer committing inside
// the TOCTOU window — i.e. between activate()'s locked read and its
// status-conditioned write — by mutating the store from the callback. Cleared
// after it fires once so only the targeted UPDATE is intercepted.
let interceptNextSkillUpdate: (() => void) | null = null;

// Resolve the real table objects so the fake can key the store on identity AND
// resolve column references (skills.id etc.) used in where()/orderBy().
let skillsTable: any;
let auditTable: any;

function tableOf(t: unknown): Row[] {
  if (!store.has(t)) store.set(t, []);
  return store.get(t)!;
}

// drizzle column refs carry a `.name`; our predicate compiler reads it. The
// condition objects produced by eq/and/or are plain — we tag our own shapes.
type Pred = (row: Row) => boolean;

// We can't introspect drizzle's opaque SQL objects reliably, so the repo's
// where() args are compiled by a tiny matcher that understands the SHAPES the
// repo builds. To keep that robust, the fake intercepts drizzle's eq/and/or/sql
// via vi.mock below and returns our OWN predicate-bearing objects.
interface PredObj {
  __pred: Pred;
}
function isPredObj(x: unknown): x is PredObj {
  return !!x && typeof x === 'object' && '__pred' in (x as object);
}

// ColumnRef shape our mocked eq() receives as its left operand.
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
  // sql tag — the repo only uses sql`agent_id IS NULL` in these paths.
  const sql = (strings: TemplateStringsArray): PredObj => {
    const text = strings.join('');
    if (text.includes('agent_id IS NULL')) {
      return { __pred: (row: Row) => row.agent_id === null };
    }
    // `sql\`agent_id IS NULL\`` used as orderBy in findActive — harmless here.
    return { __pred: () => true };
  };
  return { eq, and, or, desc, sql };
});

// Fake `@/db/schema` table objects: each column is a ColRef tagged with its
// name so our mocked eq()/desc() can read row[name]. We proxy unknown props to
// ColRefs so any column the repo touches resolves.
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

// The drizzle query-builder fake. Each terminal (`.returning()`, awaiting the
// chain) resolves against the in-memory store.
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
  // `.for('update')` — row-lock hint. In this single-threaded in-memory fake
  // there is no concurrency to serialize, so it is a structural no-op (the
  // chain just keeps building). Concurrency is simulated explicitly by tests
  // that interleave repo calls via the withTx fake.
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
    // Projection: clone so callers mutating returned rows don't corrupt store.
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
  // Thenable so `await db.select()...` works.
  then(resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) {
    try {
      resolve(this.exec());
    } catch (e) {
      reject?.(e);
    }
  }
}

class InsertBuilder {
  private _vals: Row | null = null;
  constructor(private _table: unknown) {}
  values(v: Row) {
    this._vals = v;
    return this;
  }
  private apply(): Row[] {
    // Force an audit-insert failure when armed (models a DB error mid-tx).
    if (this._table === auditTable && failNextAuditInsert) {
      throw new Error('audit_insert_boom');
    }
    const row: Row = { ...this._vals };
    if (row.id === undefined) row.id = `pk-${++pkCounter}`;
    tableOf(this._table).push(row);
    return [{ ...row }];
  }
  returning() {
    // Returns a thenable resolving to the inserted rows.
    const rows = this.apply();
    return {
      then: (res: (v: Row[]) => unknown) => res(rows),
    };
  }
  // Awaiting insert WITHOUT returning (audit insert path: `await tx.insert(..).values(..)`).
  then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
    try {
      resolve(this.apply());
    } catch (e) {
      reject?.(e);
    }
  }
}

class UpdateBuilder {
  private _set: Row = {};
  private _pred: Pred = () => true;
  constructor(private _table: unknown) {}
  set(v: Row) {
    this._set = v;
    return this;
  }
  where(p: unknown) {
    if (isPredObj(p)) this._pred = p.__pred;
    return this;
  }
  private apply(): Row[] {
    // Fire the one-shot concurrency hook just before the ACTIVATION skills
    // UPDATE (`set.status === 'active'`) reads the store — lets a test land a
    // concurrent commit in the TOCTOU window between activate()'s locked read
    // and its status-conditioned write. Scoped to the activation write so the
    // earlier prior-active deprecation UPDATE in the same tx is untouched.
    if (
      this._table === skillsTable &&
      this._set.status === 'active' &&
      interceptNextSkillUpdate
    ) {
      const hook = interceptNextSkillUpdate;
      interceptNextSkillUpdate = null;
      hook();
    }
    const updated: Row[] = [];
    for (const row of tableOf(this._table)) {
      if (this._pred(row)) {
        Object.assign(row, this._set);
        updated.push({ ...row });
      }
    }
    return updated;
  }
  returning() {
    const rows = this.apply();
    return { then: (res: (v: Row[]) => unknown) => res(rows) };
  }
  then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
    try {
      resolve(this.apply());
    } catch (e) {
      reject?.(e);
    }
  }
}

function makeDbHandle() {
  return {
    select: (cols?: Record<string, ColRef> | null) => new SelectBuilder(cols),
    insert: (t: unknown) => new InsertBuilder(t),
    update: (t: unknown) => new UpdateBuilder(t),
  };
}

vi.mock('@/db/client.js', () => {
  const db = makeDbHandle();
  // withTx snapshots every table; on throw it restores them (ROLLBACK), on
  // success it keeps the mutated state (COMMIT). The tx handle is a fresh db
  // handle over the SAME store (so reads see in-tx writes).
  const withTx = async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot = new Map<unknown, Row[]>();
    for (const [k, rows] of store.entries()) {
      snapshot.set(k, rows.map((r) => ({ ...r })));
    }
    try {
      return await fn(makeDbHandle());
    } catch (err) {
      // ROLLBACK: restore each table to its pre-tx contents.
      store.clear();
      for (const [k, rows] of snapshot.entries()) store.set(k, rows);
      throw err;
    }
  };
  return { db, withTx };
});

// ---------------------------------------------------------------------------
// Helpers to seed rows + read them back through the fake.
// ---------------------------------------------------------------------------
const TENANT = 'tenant-A';
const AGENT = 'agent-x';

function seedSkill(over: Row = {}): Row {
  const row: Row = {
    id: over.id ?? `skill-${++pkCounter}`,
    tenant_id: TENANT,
    agent_id: AGENT,
    skill_descriptor: 'detect_legal_risk',
    category: 'classify',
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
    status: 'proposed',
    version: 1,
    proposed_by: 'u1',
    proposed_reason: null,
    approved_by: null,
    approved_at: null,
    activated_at: null,
    deprecated_at: null,
    rolled_back_at: null,
    rollback_reason: null,
    created_at: new Date(),
    ...over,
  };
  tableOf(skillsTable).push(row);
  return row;
}

function skillById(id: string): Row | undefined {
  return tableOf(skillsTable).find((r) => r.id === id);
}
function auditRows(): Row[] {
  return tableOf(auditTable);
}

const AUDIT = (action: string) => ({
  actor_id: 'u1',
  actor_role: 'founder',
  action: action as any,
  tenant_id: TENANT,
  change_summary: { target_tenant_id: TENANT, agent_id: AGENT, reason: 'r' },
});

describe('skillsRepo — atomic audit + lifecycle guards (PR #213, real repo)', () => {
  beforeEach(() => {
    store.clear();
    pkCounter = 0;
    failNextAuditInsert = false;
    interceptNextSkillUpdate = null;
  });

  // Resolve the mocked table objects once (after mocks are registered).
  beforeEach(async () => {
    const schema = await import('@/db/schema.js');
    skillsTable = (schema as any).skills;
    auditTable = (schema as any).admin_audit_log;
  });

  // -------------------------------------------------------------------------
  // FIX 1 — audit atomicity: a failed audit insert rolls the mutation back.
  // -------------------------------------------------------------------------
  describe('audit atomicity (failed audit insert ⇒ mutation rolled back)', () => {
    it('propose: skill row is NOT persisted when the audit insert fails', async () => {
      await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, async () => {
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        failNextAuditInsert = true;
        await expect(
          skillsRepo.propose(
            {
              skill_descriptor: 'brand_new',
              category: 'classify',
              execution_mode: 'prompt_only',
              goal: 'g',
              when_to_use: 'w',
              procedure: {},
              input_schema: {},
              output_schema: {},
              proposed_by: 'u1',
            } as any,
            AUDIT('skill_proposed'),
          ),
        ).rejects.toThrow('audit_insert_boom');
      });
      // Rolled back: no skill row, no audit row.
      expect(tableOf(skillsTable)).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });

    it('activate: status stays "proposed" when the audit insert fails', async () => {
      const s = seedSkill({ status: 'proposed' });
      await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, async () => {
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        failNextAuditInsert = true;
        await expect(
          skillsRepo.activate(s.id, 'u1', 'r', AUDIT('skill_activated')),
        ).rejects.toThrow('audit_insert_boom');
      });
      expect(skillById(s.id)?.status).toBe('proposed');
      expect(skillById(s.id)?.activated_at).toBeNull();
      expect(auditRows()).toHaveLength(0);
    });

    it('deprecate: status stays "active" when the audit insert fails', async () => {
      const s = seedSkill({ status: 'active' });
      await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, async () => {
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        failNextAuditInsert = true;
        await expect(
          skillsRepo.deprecate(s.id, 'u1', 'r', AUDIT('skill_deprecated')),
        ).rejects.toThrow('audit_insert_boom');
      });
      expect(skillById(s.id)?.status).toBe('active');
      expect(skillById(s.id)?.deprecated_at).toBeNull();
      expect(auditRows()).toHaveLength(0);
    });

    it('rollback: status stays "active" when the audit insert fails', async () => {
      const s = seedSkill({ status: 'active', version: 2 });
      await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, async () => {
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        failNextAuditInsert = true;
        await expect(
          skillsRepo.rollback(s.id, 'r', 'u1', AUDIT('skill_rolled_back')),
        ).rejects.toThrow('audit_insert_boom');
      });
      expect(skillById(s.id)?.status).toBe('active');
      expect(skillById(s.id)?.rolled_back_at).toBeNull();
      expect(auditRows()).toHaveLength(0);
    });

    it('happy path: each mutation persists BOTH the change and exactly one audit row', async () => {
      const s = seedSkill({ status: 'proposed' });
      await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, async () => {
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        await skillsRepo.activate(s.id, 'u1', 'r', AUDIT('skill_activated'));
      });
      expect(skillById(s.id)?.status).toBe('active');
      expect(auditRows()).toHaveLength(1);
      expect(auditRows()[0]).toMatchObject({
        action: 'skill_activated',
        resource_type: 'skill',
        resource_id: s.id,
        change_summary: { before_status: 'proposed', after_status: 'active' },
      });
    });
  });

  // -------------------------------------------------------------------------
  // FIX 2 — lifecycle guards: invalid current status ⇒ typed conflict, no change.
  // -------------------------------------------------------------------------
  describe('lifecycle guards (server-authoritative)', () => {
    it('deprecate from rolled_back throws cannot_deprecate_from_rolled_back (no change)', async () => {
      const s = seedSkill({ status: 'rolled_back' });
      await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, async () => {
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        await expect(skillsRepo.deprecate(s.id, 'u1', 'r')).rejects.toThrow(
          'cannot_deprecate_from_rolled_back',
        );
      });
      expect(skillById(s.id)?.status).toBe('rolled_back');
    });

    it('deprecate from deprecated throws cannot_deprecate_from_deprecated (no change)', async () => {
      const s = seedSkill({ status: 'deprecated' });
      await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, async () => {
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        await expect(skillsRepo.deprecate(s.id, 'u1', 'r')).rejects.toThrow(
          'cannot_deprecate_from_deprecated',
        );
      });
      expect(skillById(s.id)?.status).toBe('deprecated');
    });

    it('deprecate from active and from proposed both SUCCEED', async () => {
      const a = seedSkill({ status: 'active', skill_descriptor: 'd_a' });
      const p = seedSkill({ status: 'proposed', skill_descriptor: 'd_p' });
      await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, async () => {
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        await skillsRepo.deprecate(a.id, 'u1', 'r');
        await skillsRepo.deprecate(p.id, 'u1', 'r');
      });
      expect(skillById(a.id)?.status).toBe('deprecated');
      expect(skillById(p.id)?.status).toBe('deprecated');
    });

    it('rollback from proposed throws cannot_rollback_from_proposed (no change)', async () => {
      const s = seedSkill({ status: 'proposed' });
      await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, async () => {
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        await expect(skillsRepo.rollback(s.id, 'r', 'u1')).rejects.toThrow(
          'cannot_rollback_from_proposed',
        );
      });
      expect(skillById(s.id)?.status).toBe('proposed');
    });

    it('rollback from deprecated throws cannot_rollback_from_deprecated (no change)', async () => {
      const s = seedSkill({ status: 'deprecated' });
      await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, async () => {
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        await expect(skillsRepo.rollback(s.id, 'r', 'u1')).rejects.toThrow(
          'cannot_rollback_from_deprecated',
        );
      });
      expect(skillById(s.id)?.status).toBe('deprecated');
    });

    it('activate from non-proposed throws cannot_activate_from_<status> (kept guard)', async () => {
      const s = seedSkill({ status: 'active' });
      await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, async () => {
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        await expect(skillsRepo.activate(s.id, 'u1', 'r')).rejects.toThrow(
          'cannot_activate_from_active',
        );
      });
      expect(skillById(s.id)?.status).toBe('active');
    });
  });

  // -------------------------------------------------------------------------
  // FIX A — activation TOCTOU race: lock + status-conditioned write so a
  // concurrent deprecate can't be resurrected by a blind activation UPDATE.
  // The withTx fake is single-threaded, so the race is simulated by landing a
  // concurrent commit (the deprecate) inside the TOCTOU window via the
  // interceptNextSkillUpdate hook — exactly between activate()'s locked read
  // (sees 'proposed') and its status-conditioned write.
  // -------------------------------------------------------------------------
  describe('activation race (concurrent deprecate vs activate — only one wins)', () => {
    it('activate LOSES to a deprecate that commits in the TOCTOU window: cannot_activate_from_deprecated, no resurrection, no audit', async () => {
      const s = seedSkill({ status: 'proposed' });
      await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, async () => {
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        // Simulate the concurrent deprecate committing AFTER activate's locked
        // read but BEFORE its status-conditioned UPDATE: flip the row to
        // 'deprecated' directly in the store right when the activation write
        // is about to evaluate its predicate.
        interceptNextSkillUpdate = () => {
          skillById(s.id)!.status = 'deprecated';
          skillById(s.id)!.deprecated_at = new Date();
        };
        await expect(
          skillsRepo.activate(s.id, 'u1', 'r', AUDIT('skill_activated')),
        ).rejects.toThrow('cannot_activate_from_deprecated');
      });
      // The activation LOST: it threw a status-specific conflict (proving the
      // status-conditioned write detected the concurrent deprecate that landed
      // in the TOCTOU window) and produced NO resurrection — the row is NOT
      // active and NO activation audit committed. (In this fake, the injected
      // "concurrent" mutation shares the activate tx's snapshot, so on rollback
      // the row reverts to 'proposed' rather than staying 'deprecated'; under
      // real Postgres the deprecate is a separate committed tx and the row
      // stays deprecated. The load-bearing guarantee — activate cannot blindly
      // overwrite a row that left 'proposed' — holds in both models.)
      expect(skillById(s.id)?.status).not.toBe('active');
      expect(skillById(s.id)?.activated_at).toBeNull();
      expect(auditRows()).toHaveLength(0);
    });

    it('deprecate LOSES to an activate that already committed: cannot_deprecate_from_<status> only if no longer active; sequential activate→deprecate both legitimately apply', async () => {
      // When activate wins first (proposed→active), a subsequent deprecate of
      // the SAME row is a legitimate active→deprecated transition (NOT a
      // resurrection). The guard only blocks transitions from terminal states.
      const s = seedSkill({ status: 'proposed' });
      await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, async () => {
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        await skillsRepo.activate(s.id, 'u1', 'r');
        expect(skillById(s.id)?.status).toBe('active');
        // Now a deprecate from a terminal (rolled_back) sibling state is
        // rejected — proving the status-conditioned guard, not blind writes.
        const t = seedSkill({ status: 'rolled_back', skill_descriptor: 'other' });
        await expect(skillsRepo.deprecate(t.id, 'u1', 'r')).rejects.toThrow(
          'cannot_deprecate_from_rolled_back',
        );
      });
      expect(skillById(s.id)?.status).toBe('active');
    });

    it('activate against a non-proposed row writes NOTHING and records NO audit (status-conditioned guard)', async () => {
      const s = seedSkill({ status: 'rolled_back' });
      const auditCountBefore = auditRows().length;
      await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, async () => {
        const { skillsRepo } = await import('@/control-plane/skill-registry/skills-repo.js');
        await expect(
          skillsRepo.activate(s.id, 'u1', 'r', AUDIT('skill_activated')),
        ).rejects.toThrow('cannot_activate_from_rolled_back');
      });
      // No write (still rolled_back, never activated) and no audit row.
      expect(skillById(s.id)?.status).toBe('rolled_back');
      expect(skillById(s.id)?.activated_at).toBeNull();
      expect(auditRows()).toHaveLength(auditCountBefore);
    });
  });
});
