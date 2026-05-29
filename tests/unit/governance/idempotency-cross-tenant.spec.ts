/**
 * Issue #261 — Cross-tenant (cross-empresa) isolation invariant for the tool
 * idempotency cache (`idempotency_keys`).
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Idempotency-cache-specific contract this spec PROVES:
 *   1. `computeIdempotencyKey` REQUIRES an active tenant context — without one
 *      it throws `MissingTenantContextError` (no silent fall-through to a
 *      tenant-less hash, which would collide cross-tenant).
 *   2. `computeIdempotencyKey` folds `tenant_id` + `agent_id` from
 *      `getCurrentTenant()` / `getCurrentAgent()` into the hash input. Two
 *      tenants with otherwise-identical inputs MUST produce DIFFERENT keys —
 *      no cross-tenant hash collision.
 *   3. The same property holds for the file-based code path (file_sha256
 *      branch).
 *   4. Symmetry: A → B and B → A behave identically; neither leaks across.
 *   5. Same tenant, different agents → different keys (per existing
 *      tenant+agent isolation pattern).
 *   6. Within the SAME (tenant, agent) scope, the idempotency property still
 *      holds: same params → same key, so a real second invocation hits the
 *      cache.
 *   7. `idempotencyRepo.lookup` pins `tenant_id = <ctx> AND agent_id = <ctx>
 *      AND key = <key>` in the WHERE. Adversarial seed: tenant-B
 *      pre-populates a row with key K; tenant-A's lookup of key K MUST
 *      miss (`null`). This is the most direct test of the cache-poisoning
 *      vector documented in the issue.
 *   8. `idempotencyRepo.store` writes through `applyTenantGuard`, stamping
 *      the routed tenant_id/agent_id on every row.
 *
 * Before this fix:
 *   - `computeIdempotencyKey` ignored tenant/agent → same params across
 *     tenants produced the SAME key → cross-tenant cache collision on a
 *     shared row, leaking the first tenant's tool output to the second.
 *   - `idempotencyRepo.lookup` filtered ONLY by `key` → defense in depth
 *     was absent; even if a future caller bypassed `computeIdempotencyKey`
 *     and used a raw key, a foreign-tenant row could surface.
 *   - `idempotencyRepo.store` set columns from the input only; nothing
 *     guaranteed the row's `tenant_id`/`agent_id` matched the routed context.
 *
 * Strategy:
 *   The hash invariants (tests 1–6) need no DB at all — they call
 *   `computeIdempotencyKey` directly inside `runWithTenantContext` and
 *   compare hashes. The repo invariants (tests 7–8) mock `@/db/client.js`
 *   with a chainable in-memory builder that captures both the WHERE
 *   predicate (lookup) and the inserted row (store), then dispatches
 *   against an in-memory store. Drizzle's `eq`/`and` are mocked to produce
 *   predicate-bearing objects so the fake builder can evaluate them
 *   row-by-row. This is the same pattern used by
 *   `tests/unit/memory/procedural-cross-tenant.spec.ts`.
 *
 * This does NOT use a real DB or real pgvector — that's tracked separately
 * (P9a-style real-Postgres proof). The fake faithfully reproduces drizzle's
 * `select().from().where().limit()` and `insert().values().onConflictDoNothing()`
 * semantics against the seeded rows so the REAL `idempotencyRepo` code
 * paths are exercised end-to-end; only the SQL execution layer is replaced.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock drizzle-orm — `eq`/`and` produce predicate-bearing objects we can
// evaluate against rows in the in-memory store.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
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
  // Pass-through stubs for operators imported by `repositories.ts` even if
  // unused on the idempotency paths under test.
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
      return (row[key] as number) > (right as number);
    },
  });
  const lt = (left: unknown, right: unknown): PredObj => ({
    __pred: (row: Row) => {
      const key = isColRef(left) ? left.__col : String(left);
      return (row[key] as number) < (right as number);
    },
  });
  // sql`<>` — opaque tag; not used by the idempotency lookup/store but
  // imported at module level in repositories.ts. Returning a no-op SqlExpr
  // keeps `cleanup` callable if a future test exercises it.
  const sql = (_strings: TemplateStringsArray, ..._vals: unknown[]) => ({
    __sql: true,
  });
  return { eq, and, or, desc, sql, inArray, isNull, ne, gt, lt };
});

// ---------------------------------------------------------------------------
// Mock @/db/schema.js — proxy tables whose columns resolve to {__col: name}.
// repositories.ts enumerates a long import list; we must export every name.
// Only `idempotency_keys` is exercised at runtime by this test.
// ---------------------------------------------------------------------------
function makeTable(): unknown {
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => ({ __col: prop }),
    },
  );
}

vi.mock('@/db/schema.js', () => {
  const tables = [
    'idempotency_keys',
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
    'learned_rules',
    'pending_questions',
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
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = makeTable();
  return out;
});

// ---------------------------------------------------------------------------
// In-memory db with chainable select/insert builders.
// ---------------------------------------------------------------------------
const store: Row[] = [];

class SelectBuilder {
  private _pred: Pred = () => true;
  private _limit = Infinity;
  from(_t: unknown) {
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
    return store.filter(this._pred).slice(0, this._limit).map((r) => ({ ...r }));
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
  private _values: Row | null = null;
  private _onConflictDoNothing = false;
  values(v: Row) {
    this._values = v;
    return this;
  }
  onConflictDoNothing() {
    this._onConflictDoNothing = true;
    return this;
  }
  returning() {
    return Promise.resolve(this._values ? [this._values] : []);
  }
  private exec(): Row[] {
    if (!this._values) return [];
    // Honor composite PK (tenant_id, agent_id, key) per migration 063.
    const existing = store.find(
      (r) =>
        r.tenant_id === this._values!.tenant_id &&
        r.agent_id === this._values!.agent_id &&
        r.key === this._values!.key,
    );
    if (existing && this._onConflictDoNothing) return [];
    if (existing && !this._onConflictDoNothing) {
      throw new Error('duplicate key — composite PK collision');
    }
    store.push({ ...this._values });
    return [{ ...this._values }];
  }
  then(resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) {
    try {
      resolve(this.exec());
    } catch (e) {
      reject?.(e);
    }
  }
}

class DeleteBuilder {
  where(_p: unknown) {
    return this;
  }
  returning() {
    return Promise.resolve([]);
  }
}

vi.mock('@/db/client.js', () => {
  const db = {
    select: () => new SelectBuilder(),
    insert: (_t: unknown) => new InsertBuilder(),
    delete: (_t: unknown) => new DeleteBuilder(),
  };
  const withTx = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return { db, withTx };
});

// ---------------------------------------------------------------------------
// Imports — pulled AFTER mocks per vitest hoisting rules.
// ---------------------------------------------------------------------------
import {
  runWithTenantContext,
  MissingTenantContextError,
} from '@/db/tenant-context.js';

const A_CTX = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B_CTX = { tenant_id: 'tenant-B', agent_id: 'agent-B' };
// Same tenant, different agent.
const A_OTHER_AGENT_CTX = { tenant_id: 'tenant-A', agent_id: 'agent-OTHER' };

const baseInput = {
  pessoa_id: '11111111-1111-1111-1111-111111111111',
  entity_id: '22222222-2222-2222-2222-222222222222',
  tool_name: 'register_transaction',
  operation_type: 'create',
  payload: { valor: 50, descricao: 'Mercado', data_competencia: '2026-04-28' },
};

const fixedTs = new Date('2026-04-28T14:32:00Z');

beforeEach(() => {
  store.length = 0;
});

// ===========================================================================
// HASH-LEVEL INVARIANTS — computeIdempotencyKey
// ===========================================================================
describe('Issue #261 — computeIdempotencyKey folds tenant_id+agent_id into the hash', () => {
  it('REJECTION — computeIdempotencyKey OUTSIDE tenant context throws MissingTenantContextError', async () => {
    const { computeIdempotencyKey } = await import('@/governance/idempotency.js');
    expect(() => computeIdempotencyKey({ ...baseInput, timestamp: fixedTs })).toThrow(
      MissingTenantContextError,
    );
  });

  it('REJECTION (file branch) — computeIdempotencyKey OUTSIDE tenant context throws even for file_sha256 path', async () => {
    const { computeIdempotencyKey } = await import('@/governance/idempotency.js');
    expect(() =>
      computeIdempotencyKey({
        pessoa_id: 'a',
        entity_id: 'b',
        tool_name: 'parse_boleto',
        operation_type: 'parse_only',
        payload: {},
        file_sha256: 'abc',
        timestamp: fixedTs,
      }),
    ).toThrow(MissingTenantContextError);
  });

  it('CROSS-TENANT — same params, different tenants → DIFFERENT keys (no hash collision)', async () => {
    const { computeIdempotencyKey } = await import('@/governance/idempotency.js');
    const kA = await runWithTenantContext(A_CTX, async () =>
      computeIdempotencyKey({ ...baseInput, timestamp: fixedTs }),
    );
    const kB = await runWithTenantContext(B_CTX, async () =>
      computeIdempotencyKey({ ...baseInput, timestamp: fixedTs }),
    );
    expect(kA).not.toBe(kB);
  });

  it('CROSS-TENANT (file branch) — same file_sha256, different tenants → DIFFERENT keys', async () => {
    const { computeIdempotencyKey } = await import('@/governance/idempotency.js');
    const input = {
      pessoa_id: 'a',
      entity_id: 'b',
      tool_name: 'parse_boleto',
      operation_type: 'parse_only',
      payload: {},
      file_sha256: 'sha-abc-123',
      timestamp: fixedTs,
    };
    const kA = await runWithTenantContext(A_CTX, async () => computeIdempotencyKey(input));
    const kB = await runWithTenantContext(B_CTX, async () => computeIdempotencyKey(input));
    expect(kA).not.toBe(kB);
  });

  it('SYMMETRY — A → B and B → A both produce DIFFERENT keys (commutative)', async () => {
    const { computeIdempotencyKey } = await import('@/governance/idempotency.js');
    const kA1 = await runWithTenantContext(A_CTX, async () =>
      computeIdempotencyKey({ ...baseInput, timestamp: fixedTs }),
    );
    const kB1 = await runWithTenantContext(B_CTX, async () =>
      computeIdempotencyKey({ ...baseInput, timestamp: fixedTs }),
    );
    const kA2 = await runWithTenantContext(A_CTX, async () =>
      computeIdempotencyKey({ ...baseInput, timestamp: fixedTs }),
    );
    const kB2 = await runWithTenantContext(B_CTX, async () =>
      computeIdempotencyKey({ ...baseInput, timestamp: fixedTs }),
    );
    // A produces a stable key across calls.
    expect(kA1).toBe(kA2);
    // B produces a stable key across calls.
    expect(kB1).toBe(kB2);
    // A ≠ B in both directions.
    expect(kA1).not.toBe(kB1);
    expect(kA2).not.toBe(kB2);
  });

  it('CROSS-AGENT — same tenant, different agents → DIFFERENT keys', async () => {
    const { computeIdempotencyKey } = await import('@/governance/idempotency.js');
    const kAgentA = await runWithTenantContext(A_CTX, async () =>
      computeIdempotencyKey({ ...baseInput, timestamp: fixedTs }),
    );
    const kAgentOther = await runWithTenantContext(A_OTHER_AGENT_CTX, async () =>
      computeIdempotencyKey({ ...baseInput, timestamp: fixedTs }),
    );
    expect(kAgentA).not.toBe(kAgentOther);
  });

  it('SAME-SCOPE IDEMPOTENCY — same (tenant, agent, key inputs) within same bucket → SAME key', async () => {
    // The whole point of the cache: a real second invocation under the same
    // scope MUST hit the cache.
    const { computeIdempotencyKey } = await import('@/governance/idempotency.js');
    const k1 = await runWithTenantContext(A_CTX, async () =>
      computeIdempotencyKey({ ...baseInput, timestamp: fixedTs }),
    );
    const k2 = await runWithTenantContext(A_CTX, async () =>
      computeIdempotencyKey({
        ...baseInput,
        timestamp: new Date(fixedTs.getTime() + 30_000),
      }),
    );
    expect(k1).toBe(k2);
  });

  // ── PR #273 review iter 2/4 — delimiter aliasing (defense in depth) ──────
  //
  // The Codex primary reviewer flagged that `[...].join('|')` could alias
  // pairs if `'|'` were present in `tenant_id`/`agent_id`. The reval refuted
  // this with evidence: admin UI restricts tenant/agent IDs to
  // `[a-z0-9_-]` (`src/admin-ui/trpc/routers/{tenants,agents}.ts:25-29/37-41`)
  // — `'|'` cannot appear in production.
  //
  // STILL, `runWithTenantContext` accepts arbitrary strings (see
  // `src/db/tenant-context.ts:24-29`). If a future caller bypasses the admin
  // UI (e.g. a test harness, a future router, a misconfigured fixture) and
  // injects `'|'` (or any URI-reserved char) into the tenant context, the
  // hash MUST still distinguish tuples — same defense-in-depth contract as
  // `idempotencyRepo.lookup`/`.store`.
  //
  // Fix applied in PR #273: `computeIdempotencyKey` `encodeURIComponent`s each
  // segment before joining. This pin proves the encoder is in place so the
  // adversarial collision (which the admin UI today prevents anyway) does
  // not regress.
  it('DELIMITER ALIASING — adversarial tenant/agent with literal `|` MUST NOT alias to a real pair', async () => {
    // Adversarial setup. If `computeIdempotencyKey` joined raw segments with
    // `'|'`, these two tuples would produce the SAME hash input:
    //   - tenant='alpha|beta', agent='gamma' → "alpha|beta|gamma|..."
    //   - tenant='alpha',      agent='beta|gamma' → "alpha|beta|gamma|..."
    // The encoder makes them distinct:
    //   - "alpha%7Cbeta|gamma|..." vs "alpha|beta%7Cgamma|..."
    const { computeIdempotencyKey } = await import('@/governance/idempotency.js');
    const kAliased = await runWithTenantContext(
      { tenant_id: 'alpha|beta', agent_id: 'gamma' },
      async () => computeIdempotencyKey({ ...baseInput, timestamp: fixedTs }),
    );
    const kReal = await runWithTenantContext(
      { tenant_id: 'alpha', agent_id: 'beta|gamma' },
      async () => computeIdempotencyKey({ ...baseInput, timestamp: fixedTs }),
    );
    expect(kAliased).not.toBe(kReal);
  });

  it('DELIMITER ALIASING (file branch) — adversarial `|` in tenant/agent MUST NOT alias on file path', async () => {
    const { computeIdempotencyKey } = await import('@/governance/idempotency.js');
    const fileInput = {
      pessoa_id: 'a',
      entity_id: 'b',
      tool_name: 'parse_boleto',
      operation_type: 'parse_only',
      payload: {},
      file_sha256: 'sha-abc',
      timestamp: fixedTs,
    };
    const kAliased = await runWithTenantContext(
      { tenant_id: 'alpha|beta', agent_id: 'gamma' },
      async () => computeIdempotencyKey(fileInput),
    );
    const kReal = await runWithTenantContext(
      { tenant_id: 'alpha', agent_id: 'beta|gamma' },
      async () => computeIdempotencyKey(fileInput),
    );
    expect(kAliased).not.toBe(kReal);
  });

  // ── PR #273 review iter 2/4 — mutation kill gap (reval finding) ──────────
  //
  // The cross-tenant tests above used A=tenant-A/agent-A and B=tenant-B/agent-B.
  // A mutant that omits ONLY the `tenant_id` from the hash (keeping agent_id)
  // would still see different agents (agent-A vs agent-B) and pass.
  // Add a case where the agent_id is held CONSTANT across tenants so the
  // mutation surfaces.
  it('CROSS-TENANT (mutation kill) — tenant-A/agent-X vs tenant-B/agent-X → DIFFERENT keys', async () => {
    const { computeIdempotencyKey } = await import('@/governance/idempotency.js');
    const tenantA_agentX = { tenant_id: 'tenant-A', agent_id: 'agent-X' };
    const tenantB_agentX = { tenant_id: 'tenant-B', agent_id: 'agent-X' };
    const kA = await runWithTenantContext(tenantA_agentX, async () =>
      computeIdempotencyKey({ ...baseInput, timestamp: fixedTs }),
    );
    const kB = await runWithTenantContext(tenantB_agentX, async () =>
      computeIdempotencyKey({ ...baseInput, timestamp: fixedTs }),
    );
    // If a mutant drops tenant_id from the hash, kA === kB; this pin kills
    // that mutation because agent_id is held constant.
    expect(kA).not.toBe(kB);
  });
});

// ===========================================================================
// REPO-LEVEL INVARIANTS — idempotencyRepo.lookup / .store
// ===========================================================================
describe('Issue #261 — idempotencyRepo.lookup + .store are tenant/agent-scoped', () => {
  it('REJECTION — lookup OUTSIDE tenant context throws MissingTenantContextError', async () => {
    const { idempotencyRepo } = await import('@/db/repositories.js');
    await expect(idempotencyRepo.lookup('any-key')).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
  });

  it('REJECTION — store OUTSIDE tenant context throws MissingTenantContextError', async () => {
    // applyTenantGuard runs synchronously and throws before db.insert is touched.
    const { idempotencyRepo } = await import('@/db/repositories.js');
    await expect(
      idempotencyRepo.store({
        key: 'k',
        tool_name: 'register_transaction',
        operation_type: 'create',
        pessoa_id: 'p',
        entity_id: 'e',
        payload_hash: 'k',
        resultado: { ok: true },
      }),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('store INSIDE tenant-A stamps tenant_id=tenant-A AND agent_id=agent-A on the row', async () => {
    const { idempotencyRepo } = await import('@/db/repositories.js');
    await runWithTenantContext(A_CTX, async () =>
      idempotencyRepo.store({
        key: 'k-A',
        tool_name: 'register_transaction',
        operation_type: 'create',
        pessoa_id: 'pA',
        entity_id: 'eA',
        payload_hash: 'k-A',
        resultado: { ok: 'A' },
      }),
    );
    const row = store.find((r) => r.key === 'k-A');
    expect(row).toBeDefined();
    expect(row!.tenant_id).toBe('tenant-A');
    expect(row!.agent_id).toBe('agent-A');
    // The result is stored verbatim.
    expect(row!.resultado).toEqual({ ok: 'A' });
  });

  it('SYMMETRY — store INSIDE tenant-B stamps tenant_id=tenant-B AND agent_id=agent-B', async () => {
    const { idempotencyRepo } = await import('@/db/repositories.js');
    await runWithTenantContext(B_CTX, async () =>
      idempotencyRepo.store({
        key: 'k-B',
        tool_name: 'register_transaction',
        operation_type: 'create',
        pessoa_id: 'pB',
        entity_id: 'eB',
        payload_hash: 'k-B',
        resultado: { ok: 'B' },
      }),
    );
    const row = store.find((r) => r.key === 'k-B');
    expect(row!.tenant_id).toBe('tenant-B');
    expect(row!.agent_id).toBe('agent-B');
  });

  it('ADVERSARIAL — tenant-B pre-populates a row with key K; tenant-A lookup of K MUST miss (null)', async () => {
    // This is the most direct test of the cache-poisoning vector documented
    // in the issue: pre-compute a result under one tenant, then assert a
    // foreign tenant's lookup does NOT surface it even with the SAME key.
    // We seed `store` directly so we can guarantee both rows share the same
    // `key` string — that's the failure mode the bug had.
    const sharedKey = 'collision-key-K';
    store.push({
      key: sharedKey,
      tenant_id: 'tenant-B',
      agent_id: 'agent-B',
      tool_name: 'register_transaction',
      operation_type: 'create',
      pessoa_id: 'pB',
      entity_id: 'eB',
      payload_hash: sharedKey,
      file_sha256: null,
      resultado: { leaked_from_B: true, secret: 'tenant-B-secret' },
      created_at: new Date(),
    });
    const { idempotencyRepo } = await import('@/db/repositories.js');
    const hit = await runWithTenantContext(A_CTX, async () =>
      idempotencyRepo.lookup(sharedKey),
    );
    // The lookup MUST return null — tenant-A is NOT allowed to see tenant-B's
    // cached result, even when supplying an identical key.
    expect(hit).toBeNull();
  });

  it('SYMMETRY (lookup) — tenant-A row seeded; tenant-B lookup of same key MUST miss', async () => {
    const sharedKey = 'collision-key-symmetric';
    store.push({
      key: sharedKey,
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      tool_name: 'register_transaction',
      operation_type: 'create',
      pessoa_id: 'pA',
      entity_id: 'eA',
      payload_hash: sharedKey,
      file_sha256: null,
      resultado: { leaked_from_A: true, secret: 'tenant-A-secret' },
      created_at: new Date(),
    });
    const { idempotencyRepo } = await import('@/db/repositories.js');
    const hit = await runWithTenantContext(B_CTX, async () =>
      idempotencyRepo.lookup(sharedKey),
    );
    expect(hit).toBeNull();
  });

  it('CROSS-AGENT (lookup) — same tenant, different agent: lookup MUST miss', async () => {
    // Same invariant for agents within the same tenant. Required by the
    // existing pattern in #232/#237/#241 — every cache/store filters by
    // BOTH tenant_id AND agent_id.
    const sharedKey = 'collision-key-cross-agent';
    store.push({
      key: sharedKey,
      tenant_id: 'tenant-A',
      agent_id: 'agent-OTHER',
      tool_name: 'register_transaction',
      operation_type: 'create',
      pessoa_id: 'pA',
      entity_id: 'eA',
      payload_hash: sharedKey,
      file_sha256: null,
      resultado: { leaked_from_other_agent: true },
      created_at: new Date(),
    });
    const { idempotencyRepo } = await import('@/db/repositories.js');
    const hit = await runWithTenantContext(A_CTX, async () =>
      idempotencyRepo.lookup(sharedKey),
    );
    expect(hit).toBeNull();
  });

  it('SAME-SCOPE — tenant-A row seeded; tenant-A lookup of same key HITS the cache', async () => {
    // Idempotency must still work under the legitimate same-scope path —
    // the whole feature exists to deduplicate retries.
    const k = 'same-scope-key';
    store.push({
      key: k,
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      tool_name: 'register_transaction',
      operation_type: 'create',
      pessoa_id: 'pA',
      entity_id: 'eA',
      payload_hash: k,
      file_sha256: null,
      resultado: { ok: 'A-cached' },
      created_at: new Date(),
    });
    const { idempotencyRepo } = await import('@/db/repositories.js');
    const hit = await runWithTenantContext(A_CTX, async () =>
      idempotencyRepo.lookup(k),
    );
    expect(hit).toEqual({ ok: 'A-cached' });
  });

  it('store + lookup round-trip — write under tenant-A, read under tenant-A → hit; read under tenant-B → miss', async () => {
    // End-to-end: round-trip the public API. Stores a row via the repo
    // (so applyTenantGuard runs), then performs same-tenant and
    // cross-tenant lookups against it.
    const { idempotencyRepo } = await import('@/db/repositories.js');
    await runWithTenantContext(A_CTX, async () =>
      idempotencyRepo.store({
        key: 'round-trip-key',
        tool_name: 'register_transaction',
        operation_type: 'create',
        pessoa_id: 'pA',
        entity_id: 'eA',
        payload_hash: 'round-trip-key',
        resultado: { ok: 'A-round-trip' },
      }),
    );

    // Same scope → hit.
    const hitA = await runWithTenantContext(A_CTX, async () =>
      idempotencyRepo.lookup('round-trip-key'),
    );
    expect(hitA).toEqual({ ok: 'A-round-trip' });

    // Cross-tenant → miss.
    const missB = await runWithTenantContext(B_CTX, async () =>
      idempotencyRepo.lookup('round-trip-key'),
    );
    expect(missB).toBeNull();

    // Cross-agent (same tenant) → miss.
    const missOther = await runWithTenantContext(A_OTHER_AGENT_CTX, async () =>
      idempotencyRepo.lookup('round-trip-key'),
    );
    expect(missOther).toBeNull();
  });
});
