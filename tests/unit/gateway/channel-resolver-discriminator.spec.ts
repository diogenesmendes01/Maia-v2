/**
 * [🔴 CRITICAL + 🟠 HIGH + 🟠 MEDIUM — PR #417 review] REAL-discriminator
 * coverage for `channelsRepo.findDefaultCatchAllChannel`.
 *
 * The existing resolver specs (`channel-resolver.spec.ts`,
 * `channel-resolver-fail-loud.spec.ts`) MOCK `findDefaultCatchAllChannel`
 * wholesale, so they could NOT catch:
 *   - an inverted discriminator, or
 *   - the CRITICAL cross-`channel_type` bug (the discriminator scoped its
 *     "is this multi-tenant?" probe to the inbound's channel_type, so a real
 *     tenant whose only channel was a DIFFERENT type stayed invisible →
 *     hasRealTenant=false → default/default handed to a deployment that HAS a
 *     real tenant → cross-tenant leak, violating #268).
 *
 * These specs exercise the REAL method by mocking the DB QUERY LAYER, NOT the
 * function. The fake `tx` models an in-memory `channels` table and EVALUATES
 * the real WHERE predicate against the rows (drizzle's `eq`/`ne`/`and` are
 * mocked to return inspectable descriptors). So the channel_type filter the
 * CRITICAL bug hinges on is actually applied — which is what lets the
 * cross-`channel_type` test FAIL against the old (channel_type-scoped)
 * discriminator and PASS against the fixed (global) one.
 *
 * ── REGRESSION GUARD for the CRITICAL bug ──────────────────────────────────
 * The "real tenant of OTHER channel_type" case asserts `multi_tenant: true`.
 * OLD discriminator (a single `WHERE channel_type = ?` scan): a telegram tenant
 * is invisible to a whatsapp inbound → returns the default catch-all → the
 * assertion FAILS (leak). NEW discriminator (a GLOBAL `WHERE active AND
 * tenant_id != 'default'` probe with NO channel_type filter): sees it →
 * fail-closed → the assertion PASSES. Proven below in a dedicated test that
 * runs BOTH semantics over the same dataset.
 *
 * NOTE (live-DB CI): these specs evaluate the predicate in-memory. That the SQL
 * runs as one consistent transaction at the database level is additionally
 * covered by the live-DB integration test
 * `tests/integration/p6-channel-role-policy.spec.ts` (skips here without
 * Docker; must run in CI with Postgres).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Channel } from '@/db/schema.js';

// ── In-memory channels dataset the fake `tx` queries against ────────────────
type Row = {
  id: string;
  tenant_id: string;
  agent_id: string;
  external_id: string;
  channel_type: string;
  active: boolean;
};
const dataset: { rows: Row[] } = { rows: [] };
// Captured so the TOCTOU test can assert a single transaction wraps both reads.
let withTxCalls = 0;

// Inspectable WHERE descriptors (drizzle operators mocked below build these).
type Cond =
  | { op: 'eq'; col: string; val: unknown }
  | { op: 'ne'; col: string; val: unknown }
  | { op: 'and'; parts: Cond[] };

function evalCond(cond: Cond | undefined, row: Row): boolean {
  if (!cond) return true;
  if (cond.op === 'and') return cond.parts.every((c) => evalCond(c, row));
  const actual = (row as unknown as Record<string, unknown>)[cond.col];
  if (cond.op === 'eq') return actual === cond.val;
  if (cond.op === 'ne') return actual !== cond.val;
  return true;
}

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: unknown) => ({ op: 'eq', col, val }),
  ne: (col: string, val: unknown) => ({ op: 'ne', col, val }),
  and: (...parts: Cond[]) => ({ op: 'and', parts }),
  // `sql` template tag — only used for the `{ one: 1 }` projection; harmless.
  sql: () => ({ __sql: true }),
}));

// Schema columns as string markers so the descriptors carry the column name.
vi.mock('@/db/schema.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/db/schema.js');
  return {
    ...actual,
    channels: {
      id: 'id',
      tenant_id: 'tenant_id',
      agent_id: 'agent_id',
      external_id: 'external_id',
      channel_type: 'channel_type',
      active: 'active',
    },
  };
});

vi.mock('@/db/client.js', () => {
  // A fake query builder that records the WHERE condition and, on `.limit()`,
  // returns the matching rows from the in-memory dataset.
  const makeTx = () => {
    const state: { where?: Cond } = {};
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.from = () => chain;
    chain.where = (cond: Cond) => {
      state.where = cond;
      return chain;
    };
    chain.limit = (n: number) =>
      Promise.resolve(dataset.rows.filter((r) => evalCond(state.where, r)).slice(0, n));
    return chain;
  };
  return {
    db: { select: () => makeTx() },
    withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      withTxCalls += 1;
      return fn(makeTx());
    }),
    pgErrorCode: () => undefined,
    pool: { connect: vi.fn() },
    shutdownDb: vi.fn(),
    isDbConnected: () => true,
    probeDb: vi.fn(),
  };
});

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: `ch-${Math.random().toString(36).slice(2)}`,
    tenant_id: 'default',
    agent_id: 'default',
    external_id: 'default-channel',
    channel_type: 'whatsapp',
    active: true,
    ...overrides,
  };
}

describe('channelsRepo.findDefaultCatchAllChannel — REAL discriminator (PR #417)', () => {
  beforeEach(() => {
    dataset.rows = [];
    withTxCalls = 0;
    vi.clearAllMocks();
  });

  it('zero rows anywhere → single-tenant, NO catch-all (seed missing) → { multi_tenant:false, channel:null }', async () => {
    dataset.rows = [];
    const { channelsRepo } = await import('@/db/repositories.js');
    const out = await channelsRepo.findDefaultCatchAllChannel({ channel_type: 'whatsapp' });
    expect(out).toEqual({ multi_tenant: false, channel: null });
  });

  it('exactly 1 active default/default channel, no real tenant → returns the catch-all', async () => {
    dataset.rows = [row({ id: 'ch-default-uuid' })];
    const { channelsRepo } = await import('@/db/repositories.js');
    const out = await channelsRepo.findDefaultCatchAllChannel({ channel_type: 'whatsapp' });
    expect(out.multi_tenant).toBe(false);
    expect(out.channel).not.toBeNull();
    expect((out.channel as Channel).tenant_id).toBe('default');
    expect((out.channel as Channel).agent_id).toBe('default');
    expect((out.channel as Channel).id).toBe('ch-default-uuid');
  });

  it('active non-default tenant of the SAME channel_type → { multi_tenant:true, channel:null } (fail-closed)', async () => {
    dataset.rows = [
      row({ id: 'ch-acme', tenant_id: 'tenant-acme', agent_id: 'agent-acme', channel_type: 'whatsapp', active: true }),
      row({ id: 'ch-default', channel_type: 'whatsapp' }), // the seed also exists
    ];
    const { channelsRepo } = await import('@/db/repositories.js');
    const out = await channelsRepo.findDefaultCatchAllChannel({ channel_type: 'whatsapp' });
    expect(out).toEqual({ multi_tenant: true, channel: null });
  });

  // ── THE CRITICAL REGRESSION TEST ──────────────────────────────────────────
  // A real tenant whose ACTIVE channel is a DIFFERENT channel_type than the
  // inbound. The GLOBAL discriminator (no channel_type filter) MUST still see
  // it → fail-closed. Against the OLD channel_type-scoped query this returned
  // the default catch-all (cross-tenant leak). This is the guard for #268.
  it('🔴 CRITICAL: active non-default tenant of a DIFFERENT channel_type → { multi_tenant:true } (cross-channel_type leak guard, #268)', async () => {
    // Inbound is whatsapp; the only real tenant owns a *telegram* channel; the
    // seeded default/default whatsapp catch-all also exists.
    dataset.rows = [
      row({ id: 'ch-acme-tg', tenant_id: 'tenant-acme', agent_id: 'agent-acme', channel_type: 'telegram', active: true }),
      row({ id: 'ch-default-wa', channel_type: 'whatsapp' }),
    ];
    const { channelsRepo } = await import('@/db/repositories.js');
    const out = await channelsRepo.findDefaultCatchAllChannel({ channel_type: 'whatsapp' });

    // The hole the CRITICAL fix closes: a real tenant of another channel_type
    // must NOT be invisible. Must be fail-closed (no default/default handout).
    expect(out.multi_tenant).toBe(true);
    expect(out.channel).toBeNull();
    // Hard invariant: it must NEVER return the default catch-all here.
    expect(out).not.toMatchObject({ multi_tenant: false });
  });

  // Proves the assertion above genuinely guards the regression: the SAME
  // dataset, run through the OLD channel_type-scoped discriminator, LEAKS.
  it('🔴 CRITICAL (proof): the same cross-channel_type dataset LEAKS under the OLD channel_type-scoped discriminator', () => {
    const rows: Row[] = [
      row({ id: 'ch-acme-tg', tenant_id: 'tenant-acme', agent_id: 'agent-acme', channel_type: 'telegram', active: true }),
      row({ id: 'ch-default-wa', channel_type: 'whatsapp' }),
    ];
    const inboundType = 'whatsapp';

    // OLD: discriminator filtered by channel_type (the bug).
    const oldScoped = rows.filter((r) => r.channel_type === inboundType);
    const oldHasReal = oldScoped.some((r) => r.active && r.tenant_id !== 'default');
    const oldFallback = oldScoped.find((r) => r.active && r.tenant_id === 'default' && r.agent_id === 'default') ?? null;
    const oldOut = oldHasReal ? { multi_tenant: true, channel: null } : { multi_tenant: false, channel: oldFallback };

    // NEW: GLOBAL discriminator (no channel_type filter).
    const newHasReal = rows.some((r) => r.active && r.tenant_id !== 'default');
    const newOut = newHasReal ? { multi_tenant: true, channel: null } : { multi_tenant: false, channel: null };

    // OLD leaks: it returns the default catch-all to a deployment that HAS a
    // real (telegram) tenant.
    expect(oldOut.multi_tenant).toBe(false);
    expect(oldOut.channel).not.toBeNull();
    // NEW fails closed.
    expect(newOut.multi_tenant).toBe(true);
  });

  it('inactive-only non-default rows (no ACTIVE real tenant) → single-tenant, returns catch-all', async () => {
    // The discriminator only counts ACTIVE non-default channels. An inactive
    // foreign row does NOT make the deployment multi-tenant (the `active`
    // predicate excludes it), so we fall through to the catch-all — a
    // recently-offboarded tenant must not strand the bot.
    dataset.rows = [
      row({ id: 'ch-old', tenant_id: 'tenant-gone', agent_id: 'agent-gone', channel_type: 'whatsapp', active: false }),
      row({ id: 'ch-default', channel_type: 'whatsapp' }),
    ];
    const { channelsRepo } = await import('@/db/repositories.js');
    const out = await channelsRepo.findDefaultCatchAllChannel({ channel_type: 'whatsapp' });
    expect(out.multi_tenant).toBe(false);
    expect(out.channel).not.toBeNull();
    expect((out.channel as Channel).tenant_id).toBe('default');
  });

  it('2+ active non-default tenants → still { multi_tenant:true } (existence probe; LIMIT 1)', async () => {
    dataset.rows = [
      row({ id: 'ch-a', tenant_id: 'tenant-a', agent_id: 'agent-a', channel_type: 'sms', active: true }),
      row({ id: 'ch-b', tenant_id: 'tenant-b', agent_id: 'agent-b', channel_type: 'whatsapp', active: true }),
    ];
    const { channelsRepo } = await import('@/db/repositories.js');
    const out = await channelsRepo.findDefaultCatchAllChannel({ channel_type: 'sms' });
    expect(out).toEqual({ multi_tenant: true, channel: null });
  });

  it('catch-all is scoped to the inbound channel_type (a default channel of another type is NOT returned)', async () => {
    // Single-tenant, but the only default/default channel is telegram while the
    // inbound is whatsapp → no whatsapp catch-all → { multi_tenant:false,
    // channel:null } (resolver then fails loud as "seed missing").
    dataset.rows = [row({ id: 'ch-default-tg', channel_type: 'telegram' })];
    const { channelsRepo } = await import('@/db/repositories.js');
    const out = await channelsRepo.findDefaultCatchAllChannel({ channel_type: 'whatsapp' });
    expect(out).toEqual({ multi_tenant: false, channel: null });
  });

  it('🟠 HIGH (TOCTOU): discriminator + catch-all run inside a SINGLE withTx transaction', async () => {
    const client = await import('@/db/client.js');
    dataset.rows = [row({ id: 'ch-default', channel_type: 'whatsapp' })];
    const { channelsRepo } = await import('@/db/repositories.js');
    await channelsRepo.findDefaultCatchAllChannel({ channel_type: 'whatsapp' });
    // Exactly ONE transaction wraps BOTH reads (consistent snapshot — a
    // concurrent activation can't slip between the discriminator and its use).
    expect(client.withTx).toHaveBeenCalledTimes(1);
    expect(withTxCalls).toBe(1);
  });
});
