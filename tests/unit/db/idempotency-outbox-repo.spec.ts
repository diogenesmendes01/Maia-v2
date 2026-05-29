/**
 * Issue #316 — idempotencyOutboxRepo write-side + tenant-isolation contract.
 *
 * The crux this spec proves:
 *
 *  1. ATOMIC, FENCED write side (`markCompletedWithEffect`):
 *     - winner (matching reservation_token): completes the reservation AND
 *       enqueues the effect → returns true.
 *     - preempted owner (STALE token): the fencing UPDATE matches 0 rows → the
 *       whole tx ROLLS BACK → NO outbox row enqueued → returns false. This is
 *       the exactly-once invariant: a fenced racer can never enqueue an effect.
 *     - duplicate winner re-entry (effect already enqueued): ON CONFLICT DO
 *       NOTHING → no second outbox row (never a second physical effect).
 *  2. TENANT ISOLATION (inviolable): the enqueued row is stamped with the
 *     routed (tenant_id, agent_id); a missing context throws.
 *  3. RETRY state machine (`markEffectRetry`): bumps attempts, stays pending
 *     until max_attempts, then flips terminal 'failed'.
 *  4. markEffectSent CAS on status='pending'.
 *
 * Strategy: mock `@/db/client.js` with in-memory stores for `idempotency_keys`
 * and `idempotency_effect_outbox` behind chainable drizzle builders
 * (update/insert) + a `db.execute` SQL dispatcher (for the raw-SQL retry/claim
 * methods). `withTx` runs the fn against a tx that shares the SAME stores and
 * supports rollback-on-throw. Mirrors tests/unit/governance/idempotency-cross-tenant.spec.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
    __pred: (row: Row) => conds.every((c) => (isPredObj(c) ? c.__pred(row) : true)),
  });
  const or = (...conds: unknown[]): PredObj => ({
    __pred: (row: Row) => conds.some((c) => (isPredObj(c) ? c.__pred(row) : false)),
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
  const gt = () => ({ __pred: () => true });
  const lt = () => ({ __pred: () => true });
  const desc = (col: unknown) => col;
  // Capture the raw template parts + interpolated values so the db.execute
  // dispatcher can introspect the SQL WITHOUT the real PgDialect (which can't
  // serialize our mocked tables/values). `__sqlTag` carries the joined text
  // (with `?` placeholders) and the ordered values — EXCLUDING table-ref
  // interpolations (our schema mock makes tables Proxies carrying `__table`),
  // so `values` lines up with the scalar bind params the repo passes.
  const isTableRef = (v: unknown): boolean =>
    !!v && typeof v === 'object' && '__table' in (v as object);
  const sql = (strings: TemplateStringsArray, ...vals: unknown[]) => ({
    __sqlTag: true,
    text: strings.join('?'),
    values: vals.filter((v) => !isTableRef(v)),
  });
  return { eq, and, or, desc, sql, inArray, isNull, ne, gt, lt };
});

function makeTable(name: string): unknown {
  return new Proxy(
    { __table: name },
    { get: (_t, prop: string) => (prop === '__table' ? name : { __col: prop }) },
  );
}

vi.mock('@/db/schema.js', () => {
  const tables = [
    'idempotency_keys',
    'idempotency_effect_outbox',
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
    'outbound_messages',
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
  for (const t of tables) out[t] = makeTable(t);
  return out;
});

// In-memory stores keyed by table name.
const stores: Record<string, Row[]> = {
  idempotency_keys: [],
  idempotency_effect_outbox: [],
};

function tableName(t: unknown): string {
  return (t as { __table: string }).__table;
}

class UpdateBuilder {
  private _set: Row = {};
  private _pred: Pred = () => true;
  constructor(private _table: string) {}
  set(v: Row) {
    this._set = v;
    return this;
  }
  where(p: unknown) {
    if (isPredObj(p)) this._pred = p.__pred;
    return this;
  }
  returning(_cols?: unknown) {
    const matched = stores[this._table]!.filter(this._pred);
    for (const row of matched) Object.assign(row, this._set);
    return Promise.resolve(matched.map((r) => ({ ...r })));
  }
}

class InsertBuilder {
  private _values: Row | null = null;
  private _onConflictTargets: string[] | null = null;
  constructor(private _table: string) {}
  values(v: Row) {
    this._values = v;
    return this;
  }
  onConflictDoNothing(opts?: { target?: Array<{ __col: string }> }) {
    this._onConflictTargets = (opts?.target ?? []).map((c) => c.__col);
    return this;
  }
  private exec(): Row[] {
    if (!this._values) return [];
    if (this._onConflictTargets && this._onConflictTargets.length > 0) {
      const conflict = stores[this._table]!.find((r) =>
        this._onConflictTargets!.every((col) => r[col] === this._values![col]),
      );
      if (conflict) return [];
    }
    const row = { id: `outbox-${stores[this._table]!.length + 1}`, ...this._values };
    stores[this._table]!.push(row);
    return [{ ...row }];
  }
  returning() {
    return Promise.resolve(this.exec());
  }
  then(resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) {
    try {
      resolve(this.exec());
    } catch (e) {
      reject?.(e);
    }
  }
}

// db.execute SQL dispatcher for the raw-SQL repo methods (markEffectRetry,
// claimPendingEffects, listTenantsWithWork, markEffectFailed, cleanupTerminal). We
// re-implement each by shape over the in-memory outbox store. The mocked `sql`
// tag (above) captures the template text + ordered interpolated values, so we
// introspect WITHOUT the real PgDialect (which can't serialize our mocks).
const dbExecuteMock = vi.fn(async (query: unknown) => {
  const tag = query as { text: string; values: unknown[] };
  const text = tag.text;
  const params = tag.values;

  if (/UPDATE.+SET\s+attempts\s*=\s*attempts\s*\+\s*1/is.test(text)) {
    // markEffectRetry interpolation order: error, backoff, tenant, agent, id.
    const error = params[0] as string;
    const tenant_id = params[2] as string;
    const agent_id = params[3] as string;
    const id = params[4] as string;
    const row = stores.idempotency_effect_outbox!.find(
      (r) =>
        r.id === id &&
        r.tenant_id === tenant_id &&
        r.agent_id === agent_id &&
        r.status === 'pending',
    );
    if (!row) return { rows: [] };
    const attempts = (row.attempts as number) + 1;
    const maxAttempts = row.max_attempts as number;
    row.attempts = attempts;
    row.last_error = error;
    row.status = attempts >= maxAttempts ? 'failed' : 'pending';
    return { rows: [{ status: row.status }] };
  }

  if (/UPDATE.+SET\s+status\s*=\s*'failed'/is.test(text)) {
    // markEffectFailed (force-terminal) interpolation order: error, tenant,
    // agent, id. CAS on status='pending'; attempts are NOT touched.
    const error = params[0] as string;
    const tenant_id = params[1] as string;
    const agent_id = params[2] as string;
    const id = params[3] as string;
    const row = stores.idempotency_effect_outbox!.find(
      (r) =>
        r.id === id &&
        r.tenant_id === tenant_id &&
        r.agent_id === agent_id &&
        r.status === 'pending',
    );
    if (!row) return { rows: [] };
    row.status = 'failed';
    row.last_error = error;
    return { rows: [{ id: row.id }] };
  }

  if (/SELECT\s+DISTINCT\s+tenant_id,\s*agent_id/i.test(text)) {
    // listTenantsWithWork: param[0] = retentionDays. A tenant has work when it
    // has a pending row OR a terminal row past the retention window. The unit
    // store has no real timestamps, so we honor an explicit `__age_days` marker
    // on terminal rows (default 0 = fresh, i.e. within retention).
    const retentionDays = Number(params[0]);
    const seen = new Set<string>();
    const out: Array<{ tenant_id: string; agent_id: string }> = [];
    for (const r of stores.idempotency_effect_outbox!) {
      const isPending = r.status === 'pending';
      const isAgedTerminal =
        (r.status === 'sent' || r.status === 'failed') &&
        ((r.__age_days as number) ?? 0) > retentionDays;
      if (!isPending && !isAgedTerminal) continue;
      const key = `${r.tenant_id}|${r.agent_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ tenant_id: r.tenant_id as string, agent_id: r.agent_id as string });
    }
    return { rows: out };
  }

  if (/SELECT\s+id,\s*idempotency_key.+FOR\s+UPDATE\s+SKIP\s+LOCKED/is.test(text)) {
    // claimPendingEffects: params → [tenant, agent, limit]
    const tenant_id = params[0] as string;
    const agent_id = params[1] as string;
    const limit = Number(params[2]);
    const rows = stores.idempotency_effect_outbox!
      .filter((r) => r.tenant_id === tenant_id && r.agent_id === agent_id && r.status === 'pending')
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        idempotency_key: r.idempotency_key,
        effect_type: r.effect_type,
        effect_payload: r.effect_payload,
        attempts: r.attempts,
        max_attempts: r.max_attempts,
      }));
    return { rows };
  }

  if (/DELETE\s+FROM/i.test(text)) {
    // cleanupTerminal interpolation order (with the #326 note (a) outer scope):
    // outer tenant, outer agent, inner tenant, inner agent, olderThanDays,
    // batchSize. Delete tenant/agent-scoped aged terminal rows, capped by batch.
    const tenant_id = params[0] as string;
    const agent_id = params[1] as string;
    const olderThanDays = Number(params[4]);
    const batchSize = Number(params[5]);
    const victims = stores
      .idempotency_effect_outbox!.filter(
        (r) =>
          r.tenant_id === tenant_id &&
          r.agent_id === agent_id &&
          (r.status === 'sent' || r.status === 'failed') &&
          ((r.__age_days as number) ?? 0) > olderThanDays,
      )
      .slice(0, batchSize);
    for (const v of victims) {
      const idx = stores.idempotency_effect_outbox!.indexOf(v);
      if (idx >= 0) stores.idempotency_effect_outbox!.splice(idx, 1);
    }
    return { rows: victims.map((v) => ({ id: v.id })) };
  }

  return { rows: [] };
});

vi.mock('@/db/client.js', () => {
  const makeDb = () => ({
    update: (t: unknown) => new UpdateBuilder(tableName(t)),
    insert: (t: unknown) => new InsertBuilder(tableName(t)),
    execute: dbExecuteMock,
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
    delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
  });
  const db = makeDb();
  // withTx shares the SAME in-memory stores (the builders read `stores` by
  // table name, so a tx tx and the top-level db operate on the same data).
  // Rollback semantics: if `fn` throws, we must UNDO mutations. We snapshot the
  // stores before and restore on throw.
  const withTx = async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot: Record<string, Row[]> = {
      idempotency_keys: stores.idempotency_keys!.map((r) => ({ ...r })),
      idempotency_effect_outbox: stores.idempotency_effect_outbox!.map((r) => ({ ...r })),
    };
    try {
      return await fn(makeDb());
    } catch (err) {
      stores.idempotency_keys = snapshot.idempotency_keys!;
      stores.idempotency_effect_outbox = snapshot.idempotency_effect_outbox!;
      throw err;
    }
  };
  return { db, withTx, pool: { connect: vi.fn() } };
});

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/metrics.js', () => ({ incCounter: vi.fn() }));

import {
  runWithTenantContext,
  MissingTenantContextError,
} from '@/db/tenant-context.js';
import type { PlannedEffect } from '@/governance/idempotency-effects.js';

const A_CTX = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B_CTX = { tenant_id: 'tenant-B', agent_id: 'agent-B' };

const EFFECT: PlannedEffect = {
  kind: 'whatsapp_text',
  jid: '5511999990000@s.whatsapp.net',
  text: 'olá',
  mensagem_id: 'msg-1',
};

function seedReservation(input: {
  tenant_id: string;
  agent_id: string;
  key: string;
  token: string;
}) {
  stores.idempotency_keys!.push({
    key: input.key,
    tenant_id: input.tenant_id,
    agent_id: input.agent_id,
    state: 'in_progress',
    reservation_token: input.token,
    resultado: null,
    expires_at: new Date(Date.now() + 30_000),
  });
}

beforeEach(() => {
  stores.idempotency_keys = [];
  stores.idempotency_effect_outbox = [];
  dbExecuteMock.mockClear();
});

describe('idempotencyOutboxRepo.markCompletedWithEffect — atomic, fenced write side', () => {
  it('WINNER (matching token): completes the reservation AND enqueues the effect (returns true)', async () => {
    seedReservation({ ...A_CTX, key: 'k1', token: 'tok-win' });
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');

    const ok = await runWithTenantContext(A_CTX, () =>
      idempotencyOutboxRepo.markCompletedWithEffect({
        key: 'k1',
        resultado: { ok: true },
        reservation_token: 'tok-win',
        effect: EFFECT,
      }),
    );
    expect(ok).toBe(true);
    // Reservation transitioned.
    const resv = stores.idempotency_keys!.find((r) => r.key === 'k1')!;
    expect(resv.state).toBe('completed');
    expect(resv.resultado).toEqual({ ok: true });
    // Effect enqueued, tenant-stamped.
    const outbox = stores.idempotency_effect_outbox!;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      idempotency_key: 'k1',
      effect_type: 'whatsapp_text',
      status: 'pending',
    });
    expect(outbox[0]!.effect_payload).toEqual(EFFECT);
  });

  it('FENCED owner (stale token): rolls back — NO effect enqueued, NO completion (returns false)', async () => {
    // The reservation is owned by a NEW token (lease reclaimed). The preempted
    // owner presents a STALE token → the fencing UPDATE matches 0 rows → the
    // whole tx rolls back. This is the exactly-once invariant: a fenced racer
    // can NEVER enqueue an effect.
    seedReservation({ ...A_CTX, key: 'k2', token: 'tok-NEW-owner' });
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');

    const ok = await runWithTenantContext(A_CTX, () =>
      idempotencyOutboxRepo.markCompletedWithEffect({
        key: 'k2',
        resultado: { from: 'preempted' },
        reservation_token: 'tok-STALE',
        effect: EFFECT,
      }),
    );
    expect(ok).toBe(false);
    // NO effect enqueued.
    expect(stores.idempotency_effect_outbox).toHaveLength(0);
    // Reservation NOT completed by the fenced owner (still in_progress, new token).
    const resv = stores.idempotency_keys!.find((r) => r.key === 'k2')!;
    expect(resv.state).toBe('in_progress');
    expect(resv.reservation_token).toBe('tok-NEW-owner');
  });

  it('DUPLICATE winner re-entry: ON CONFLICT DO NOTHING → no second effect row', async () => {
    seedReservation({ ...A_CTX, key: 'k3', token: 'tok-win' });
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');

    await runWithTenantContext(A_CTX, () =>
      idempotencyOutboxRepo.markCompletedWithEffect({
        key: 'k3',
        resultado: { ok: 1 },
        reservation_token: 'tok-win',
        effect: EFFECT,
      }),
    );
    // Re-seed an in_progress reservation under the SAME key+token (simulating a
    // retry that re-won) and complete again — the outbox UNIQUE makes the second
    // enqueue a no-op (the completion UPDATE still succeeds → returns true).
    const resv = stores.idempotency_keys!.find((r) => r.key === 'k3')!;
    resv.state = 'in_progress';
    const okAgain = await runWithTenantContext(A_CTX, () =>
      idempotencyOutboxRepo.markCompletedWithEffect({
        key: 'k3',
        resultado: { ok: 2 },
        reservation_token: 'tok-win',
        effect: { ...EFFECT, text: 'second attempt' },
      }),
    );
    expect(okAgain).toBe(true);
    // Still exactly ONE outbox row (the first effect; the second was deduped).
    expect(stores.idempotency_effect_outbox).toHaveLength(1);
    expect((stores.idempotency_effect_outbox![0]!.effect_payload as PlannedEffect).text).toBe('olá');
  });

  it('TENANT ISOLATION: missing tenant context throws (no untenated enqueue)', async () => {
    seedReservation({ ...A_CTX, key: 'k4', token: 'tok' });
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    await expect(
      idempotencyOutboxRepo.markCompletedWithEffect({
        key: 'k4',
        resultado: {},
        reservation_token: 'tok',
        effect: EFFECT,
      }),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
    expect(stores.idempotency_effect_outbox).toHaveLength(0);
  });

  it('TENANT ISOLATION: tenant-B cannot complete/enqueue tenant-A reservation (fenced by scope)', async () => {
    // The reservation belongs to tenant-A. Running under tenant-B, the fencing
    // UPDATE filters tenant_id=tenant-B → 0 rows → rollback → no enqueue.
    seedReservation({ ...A_CTX, key: 'k5', token: 'tok' });
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const ok = await runWithTenantContext(B_CTX, () =>
      idempotencyOutboxRepo.markCompletedWithEffect({
        key: 'k5',
        resultado: {},
        reservation_token: 'tok',
        effect: EFFECT,
      }),
    );
    expect(ok).toBe(false);
    expect(stores.idempotency_effect_outbox).toHaveLength(0);
    // tenant-A's reservation untouched.
    expect(stores.idempotency_keys!.find((r) => r.key === 'k5')!.state).toBe('in_progress');
  });
});

describe('idempotencyOutboxRepo.markEffectRetry — backoff + terminal failure state machine', () => {
  function seedOutbox(attempts: number, maxAttempts = 3) {
    stores.idempotency_effect_outbox!.push({
      id: 'ob-1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      idempotency_key: 'k',
      effect_type: 'whatsapp_text',
      effect_payload: EFFECT,
      status: 'pending',
      attempts,
      max_attempts: maxAttempts,
      last_error: null,
    });
  }

  it('stays pending and bumps attempts when below max_attempts', async () => {
    seedOutbox(0, 3);
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const status = await runWithTenantContext(A_CTX, () =>
      idempotencyOutboxRepo.markEffectRetry({ id: 'ob-1', error: 'boom', backoff_seconds: 30 }),
    );
    expect(status).toBe('pending');
    const row = stores.idempotency_effect_outbox![0]!;
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('boom');
  });

  it('flips to terminal failed when attempts+1 reaches max_attempts', async () => {
    seedOutbox(2, 3); // next attempt = 3 = max → failed
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const status = await runWithTenantContext(A_CTX, () =>
      idempotencyOutboxRepo.markEffectRetry({ id: 'ob-1', error: 'final', backoff_seconds: 60 }),
    );
    expect(status).toBe('failed');
    expect(stores.idempotency_effect_outbox![0]!.status).toBe('failed');
    expect(stores.idempotency_effect_outbox![0]!.last_error).toBe('final');
  });
});

describe('idempotencyOutboxRepo.markEffectSent — CAS on pending', () => {
  it('marks sent + stores provider_ref when row is pending', async () => {
    stores.idempotency_effect_outbox!.push({
      id: 'ob-9',
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      idempotency_key: 'k',
      effect_type: 'whatsapp_text',
      effect_payload: EFFECT,
      status: 'pending',
      attempts: 0,
      max_attempts: 5,
      last_error: null,
    });
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const ok = await runWithTenantContext(A_CTX, () =>
      idempotencyOutboxRepo.markEffectSent({ id: 'ob-9', provider_ref: 'wa-id-xyz' }),
    );
    expect(ok).toBe(true);
    const row = stores.idempotency_effect_outbox![0]!;
    expect(row.status).toBe('sent');
    expect(row.provider_ref).toBe('wa-id-xyz');
  });

  it('is a no-op (returns false) when the row is already terminal', async () => {
    stores.idempotency_effect_outbox!.push({
      id: 'ob-10',
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      idempotency_key: 'k',
      effect_type: 'whatsapp_text',
      effect_payload: EFFECT,
      status: 'sent',
      attempts: 0,
      max_attempts: 5,
      last_error: null,
    });
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const ok = await runWithTenantContext(A_CTX, () =>
      idempotencyOutboxRepo.markEffectSent({ id: 'ob-10', provider_ref: 'dup' }),
    );
    expect(ok).toBe(false);
  });
});

describe('idempotencyOutboxRepo.markEffectFailed — force-terminal (#326 note (b))', () => {
  function seedPending(attempts = 0, maxAttempts = 5) {
    stores.idempotency_effect_outbox!.push({
      id: 'ob-ft',
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      idempotency_key: 'k',
      effect_type: 'whatsapp_text',
      effect_payload: EFFECT,
      status: 'pending',
      attempts,
      max_attempts: maxAttempts,
      last_error: null,
    });
  }

  it('flips a pending row STRAIGHT to failed without touching attempts', async () => {
    seedPending(0, 5);
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const ok = await runWithTenantContext(A_CTX, () =>
      idempotencyOutboxRepo.markEffectFailed({ id: 'ob-ft', error: 'invalid_effect_payload:x' }),
    );
    expect(ok).toBe(true);
    const row = stores.idempotency_effect_outbox![0]!;
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('invalid_effect_payload:x');
    // Retry budget UNTOUCHED — no pointless retries were consumed.
    expect(row.attempts).toBe(0);
  });

  it('is a no-op (returns false) when the row is not pending', async () => {
    stores.idempotency_effect_outbox!.push({
      id: 'ob-ft2',
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      idempotency_key: 'k2',
      effect_type: 'whatsapp_text',
      effect_payload: EFFECT,
      status: 'sent',
      attempts: 0,
      max_attempts: 5,
      last_error: null,
    });
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const ok = await runWithTenantContext(A_CTX, () =>
      idempotencyOutboxRepo.markEffectFailed({ id: 'ob-ft2', error: 'late' }),
    );
    expect(ok).toBe(false);
    expect(stores.idempotency_effect_outbox![0]!.status).toBe('sent');
  });

  it('TENANT ISOLATION: tenant-B cannot fail a tenant-A row', async () => {
    seedPending(0, 5);
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const ok = await runWithTenantContext(B_CTX, () =>
      idempotencyOutboxRepo.markEffectFailed({ id: 'ob-ft', error: 'cross-tenant' }),
    );
    expect(ok).toBe(false);
    // tenant-A's row untouched (still pending).
    expect(stores.idempotency_effect_outbox![0]!.status).toBe('pending');
  });
});

describe('idempotencyOutboxRepo.listTenantsWithWork — retention reaches idle tenants (#326 blocker)', () => {
  function seedRow(input: {
    tenant_id: string;
    agent_id: string;
    status: 'pending' | 'sent' | 'failed';
    age_days?: number;
  }) {
    stores.idempotency_effect_outbox!.push({
      id: `ob-${stores.idempotency_effect_outbox!.length + 1}`,
      tenant_id: input.tenant_id,
      agent_id: input.agent_id,
      idempotency_key: `k-${stores.idempotency_effect_outbox!.length + 1}`,
      effect_type: 'whatsapp_text',
      effect_payload: EFFECT,
      status: input.status,
      attempts: 0,
      max_attempts: 5,
      last_error: input.status === 'failed' ? 'boom' : null,
      __age_days: input.age_days ?? 0,
    });
  }

  it('enumerates a tenant whose ONLY rows are AGED terminal rows (no pending)', async () => {
    seedRow({ tenant_id: 'tenant-idle', agent_id: 'agent-idle', status: 'sent', age_days: 90 });
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const tenants = await idempotencyOutboxRepo.listTenantsWithWork(30);
    expect(tenants).toEqual([{ tenant_id: 'tenant-idle', agent_id: 'agent-idle' }]);
  });

  it('does NOT enumerate a tenant whose terminal rows are within the retention window', async () => {
    seedRow({ tenant_id: 'tenant-fresh', agent_id: 'agent-fresh', status: 'sent', age_days: 1 });
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const tenants = await idempotencyOutboxRepo.listTenantsWithWork(30);
    expect(tenants).toEqual([]);
  });

  it('enumerates a pending tenant AND an aged-terminal-only tenant together', async () => {
    seedRow({ tenant_id: 'tenant-A', agent_id: 'agent-A', status: 'pending' });
    seedRow({ tenant_id: 'tenant-B', agent_id: 'agent-B', status: 'failed', age_days: 60 });
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const tenants = await idempotencyOutboxRepo.listTenantsWithWork(30);
    const keys = new Set(tenants.map((t) => `${t.tenant_id}|${t.agent_id}`));
    expect(keys).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
  });
});

describe('idempotencyOutboxRepo.cleanupTerminal — bounded, tenant-scoped (#326 note (a))', () => {
  function seedTerminal(tenant_id: string, agent_id: string, age_days: number) {
    stores.idempotency_effect_outbox!.push({
      id: `ob-${stores.idempotency_effect_outbox!.length + 1}`,
      tenant_id,
      agent_id,
      idempotency_key: `k-${stores.idempotency_effect_outbox!.length + 1}`,
      effect_type: 'whatsapp_text',
      effect_payload: EFFECT,
      status: 'sent',
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      __age_days: age_days,
    });
  }

  it('deletes ONLY the current tenant aged terminal rows; leaves other tenants intact', async () => {
    seedTerminal('tenant-A', 'agent-A', 90); // aged → deleted under A
    seedTerminal('tenant-A', 'agent-A', 0); // fresh → kept
    seedTerminal('tenant-B', 'agent-B', 90); // aged but OTHER tenant → kept
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const deleted = await runWithTenantContext(A_CTX, () =>
      idempotencyOutboxRepo.cleanupTerminal({ olderThanDays: 30, batchSize: 1000 }),
    );
    expect(deleted).toBe(1);
    // tenant-A fresh row + tenant-B aged row remain.
    const remaining = stores.idempotency_effect_outbox!;
    expect(remaining).toHaveLength(2);
    expect(remaining.some((r) => r.tenant_id === 'tenant-B')).toBe(true);
    expect(remaining.some((r) => r.tenant_id === 'tenant-A')).toBe(true);
  });

  it('honors the batchSize cap (bounded DELETE)', async () => {
    for (let i = 0; i < 5; i++) seedTerminal('tenant-A', 'agent-A', 90);
    const { idempotencyOutboxRepo } = await import('@/db/repositories.js');
    const deleted = await runWithTenantContext(A_CTX, () =>
      idempotencyOutboxRepo.cleanupTerminal({ olderThanDays: 30, batchSize: 2 }),
    );
    expect(deleted).toBe(2);
    expect(stores.idempotency_effect_outbox!).toHaveLength(3);
  });
});
