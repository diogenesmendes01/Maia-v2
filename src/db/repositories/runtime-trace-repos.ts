/**
 * Issue #514 §7 — Trace Explorer repository.
 *
 * Replaces the `listTraces`/`getTrace` stubs in
 * `src/admin-ui/trpc/routers/traces.ts` with real, tenant-scoped queries over
 * the P10b tables.
 *
 * Non-negotiables encoded here (not in the router):
 *
 *  1. **Tenant scoping is in the QUERY, not in a post-filter.** Every method
 *     takes `tenantId` as a required argument and every WHERE starts with it.
 *     `runtime_trace_bodies` is keyed by `trace_id` alone, so fetching by id
 *     and *then* checking the tenant would mean the row already crossed the
 *     boundary. It does not: the tenant predicate is part of the lookup.
 *  2. **Fail-closed.** A blank/`'default'` tenant id throws instead of
 *     returning rows (AGENTS.md §4.2 / §4.8).
 *  3. **No full scans.** Listing is keyset-paginated on
 *     `(created_at, trace_id)` DESC, served by the indexes in migration 100.
 *     There is no OFFSET anywhere — deep pages stay O(page), not O(offset).
 *  4. **Redacted by default.** `getTrace` returns the body exactly as the body
 *     writer persisted it (already redaction-applied). Un-redacted access
 *     remains the existing governed `debug_snapshot_grant` flow; this repo
 *     does not widen it.
 */
import { and, desc, eq, gte, lte, sql, inArray } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  runtime_trace_envelopes,
  runtime_trace_bodies,
} from '@/db/schema.js';
import { assertNotDefaultLiteral } from '@/db/tenant-context.js';
import {
  verifyEnvelopeIntegrity,
  verifyBodyIntegrity,
  type EnvelopeIntegrity,
  type BodyIntegrity,
} from '@/control-plane/runtime-trace/verify-envelope.js';
import type {
  Decision as VerifiableDecision,
  SideEffectLevel as VerifiableSideEffectLevel,
} from '@/control-plane/runtime-trace/types.js';

/** Side-effect levels the Explorer treats as "touched the world". */
const SIDE_EFFECT_LEVELS = ['medium', 'high', 'critical'] as const;

export interface TraceListItem {
  trace_id: string;
  tenant_id: string;
  agent_id: string;
  conversa_id: string | null;
  turno_id: string | null;
  /** Root trace id of the turn — equal to `trace_id` on attempt 1. */
  root_trace_id: string | null;
  /** 1-based attempt ordinal. */
  attempt: number;
  decision: string;
  side_effect_level: string;
  redaction_class: string;
  body_status: string;
  body_persisted_at: Date | null;
  created_at: Date;
}

export interface TraceDetail extends TraceListItem {
  policy_id: string | null;
  envelope_hmac: string;
  hmac_key_version: number;
  /**
   * Result of RECOMPUTING the envelope HMAC over this row (issue #514 review
   * round 1 [P2]). Not a "is the string non-empty" check.
   */
  integrity: EnvelopeIntegrity;
  /**
   * Result of recomputing the BODY's `packet_hmac` (issue #514 review round 2).
   * `absent` when the body has not been persisted yet — distinct from
   * `unknown` (could not verify) and from `invalid` (does not match).
   */
  body_integrity: BodyIntegrity;
  /** Redacted packet as persisted by the body writer; null while pending. */
  redacted_packet: unknown;
  redaction_applied: string | null;
  bytes_redacted: number | null;
  encrypted: boolean;
  /** True when the body row exists but holds an encrypted snapshot. */
  body_available: boolean;
}

export interface ListTracesInput {
  tenantId: string;
  agentId?: string;
  conversaId?: string;
  fromDate?: Date;
  toDate?: Date;
  /** Filter by envelope decision (allow/deny/escalate/…). */
  decision?: string;
  /** Only traces whose side effect level is medium/high/critical. */
  sideEffectOnly?: boolean;
  /** Filter by body persistence state — surfaces pending/orphaned bodies. */
  bodyStatus?: 'pending' | 'persisted' | 'orphaned';
  limit: number;
  cursor?: string | null;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/**
 * Opaque composite cursor: base64url of `{ts, id}` from the last row returned.
 * Composite because `created_at` ties (envelopes written in the same batch),
 * and the id breaks the tie in the SAME order as the keyset predicate.
 *
 * Mirrors `encodeListCursor`/`decodeListCursor` in `admin-repos.ts` — kept
 * local rather than imported so the two paginations can evolve independently
 * (their sort keys differ: `proposed_at` vs `created_at`).
 */
export function encodeTraceCursor(item: { created_at: Date; trace_id: string }): string {
  return Buffer.from(
    JSON.stringify({ ts: item.created_at.toISOString(), id: item.trace_id }),
  ).toString('base64url');
}

/** Unreadable/hostile cursor ⇒ null (first page). Never throws. */
export function decodeTraceCursor(
  cursor: string | null | undefined,
): { ts: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      ts?: unknown;
      id?: unknown;
    };
    if (typeof parsed.ts !== 'string' || typeof parsed.id !== 'string') return null;
    const ts = new Date(parsed.ts);
    if (Number.isNaN(ts.getTime())) return null;
    // A cursor id that is not a UUID cannot appear in the keyset comparison
    // (the column is UUID) — reject rather than let Postgres raise.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.id)) {
      return null;
    }
    return { ts, id: parsed.id };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export class TraceTenantScopeError extends Error {
  readonly code = 'TRACE_TENANT_SCOPE_REQUIRED';
  constructor(detail: string) {
    super(`runtimeTraceRepo: ${detail}`);
    this.name = 'TraceTenantScopeError';
  }
}

/**
 * Fail-closed tenant guard. Missing/blank ⇒ throw; the `'default'` literal is
 * routed through the shared `assertNotDefaultLiteral` so this repo cannot
 * diverge from the platform-wide policy.
 */
function assertTenant(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
    throw new TraceTenantScopeError('tenantId is required (fail-closed)');
  }
  assertNotDefaultLiteral(tenantId, 'tenant_id');
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export const runtimeTraceRepo = {
  /**
   * Paginated, tenant-scoped listing, newest first.
   *
   * Fetches `limit + 1` rows to detect `hasMore` without a COUNT — a COUNT
   * over a growing evidence table is the classic way a "cheap" list page turns
   * into a sequential scan.
   */
  async list(input: ListTracesInput): Promise<{
    items: TraceListItem[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    assertTenant(input.tenantId);
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit)));
    const cursor = decodeTraceCursor(input.cursor);
    const t = runtime_trace_envelopes;

    const conditions = [eq(t.tenant_id, input.tenantId)];
    if (input.agentId) conditions.push(eq(t.agent_id, input.agentId));
    if (input.conversaId) conditions.push(eq(t.conversa_id, input.conversaId));
    if (input.fromDate) conditions.push(gte(t.created_at, input.fromDate));
    if (input.toDate) conditions.push(lte(t.created_at, input.toDate));
    if (input.decision) conditions.push(eq(t.decision, input.decision));
    if (input.bodyStatus) conditions.push(eq(t.body_status, input.bodyStatus));
    if (input.sideEffectOnly) {
      conditions.push(inArray(t.side_effect_level, [...SIDE_EFFECT_LEVELS]));
    }
    if (cursor) {
      // Composite keyset — matches the (tenant_id, created_at DESC,
      // trace_id DESC) index from migration 100.
      conditions.push(
        sql`(${t.created_at}, ${t.trace_id}) < (${cursor.ts}, ${cursor.id}::uuid)`,
      );
    }

    const rows = await db
      .select({
        trace_id: t.trace_id,
        tenant_id: t.tenant_id,
        agent_id: t.agent_id,
        conversa_id: t.conversa_id,
        turno_id: t.turno_id,
        root_trace_id: t.root_trace_id,
        attempt: t.attempt,
        decision: t.decision,
        side_effect_level: t.side_effect_level,
        redaction_class: t.redaction_class,
        body_status: t.body_status,
        body_persisted_at: t.body_persisted_at,
        created_at: t.created_at,
      })
      .from(t)
      .where(and(...conditions))
      .orderBy(desc(t.created_at), desc(t.trace_id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows) as TraceListItem[];
    const last = items[items.length - 1];
    return {
      items,
      hasMore,
      nextCursor: hasMore && last ? encodeTraceCursor(last) : null,
    };
  },

  /**
   * Single trace with its redacted body, tenant-scoped.
   *
   * Returns `null` — not a "forbidden" error — when the trace belongs to
   * another tenant. An existence oracle is itself a cross-tenant leak: "403"
   * would confirm the id exists somewhere.
   */
  async get(input: { tenantId: string; traceId: string }): Promise<TraceDetail | null> {
    assertTenant(input.tenantId);
    const e = runtime_trace_envelopes;

    const envRows = await db
      .select()
      .from(e)
      .where(and(eq(e.tenant_id, input.tenantId), eq(e.trace_id, input.traceId)))
      .limit(1);
    const env = envRows[0];
    if (!env) return null;

    const b = runtime_trace_bodies;
    // Tenant predicate repeated on purpose — see the class docstring.
    const bodyRows = await db
      .select()
      .from(b)
      .where(and(eq(b.tenant_id, input.tenantId), eq(b.trace_id, input.traceId)))
      .limit(1);
    const body = bodyRows[0] ?? null;

    return {
      trace_id: env.trace_id,
      tenant_id: env.tenant_id,
      agent_id: env.agent_id,
      conversa_id: env.conversa_id,
      turno_id: env.turno_id,
      root_trace_id: env.root_trace_id,
      attempt: env.attempt,
      policy_id: env.policy_id,
      decision: env.decision,
      side_effect_level: env.side_effect_level,
      redaction_class: env.redaction_class,
      envelope_hmac: env.envelope_hmac,
      hmac_key_version: env.hmac_key_version,
      // Recomputed over the row we just read, so a tampered field or a
      // tampered signature both surface as `invalid`.
      integrity: verifyEnvelopeIntegrity({
        trace_id: env.trace_id,
        tenant_id: env.tenant_id,
        agent_id: env.agent_id,
        conversa_id: env.conversa_id,
        turno_id: env.turno_id,
        policy_id: env.policy_id,
        decision: env.decision as VerifiableDecision,
        side_effect_level: env.side_effect_level as VerifiableSideEffectLevel,
        redaction_class: env.redaction_class,
        hmac_key_version: env.hmac_key_version,
        envelope_hmac: env.envelope_hmac,
      }),
      body_status: env.body_status,
      body_persisted_at: env.body_persisted_at,
      created_at: env.created_at,
      // An encrypted body is NOT handed out here — that is the governed
      // debug-snapshot flow. We only report that it exists.
      redacted_packet: body && !body.encrypted ? body.packet : null,
      redaction_applied: body?.redaction_applied ?? null,
      bytes_redacted: body?.bytes_redacted ?? null,
      encrypted: body?.encrypted ?? false,
      // Recomputed over the stored `packet` jsonb — the same value the body
      // writer signed, encrypted bodies included (it signs the cipher envelope
      // it stores, not the plaintext).
      body_integrity: verifyBodyIntegrity(
        body
          ? {
              tenant_id: body.tenant_id,
              hmac_key_version: body.hmac_key_version,
              packet_hmac: body.packet_hmac,
              packet: body.packet,
            }
          : null,
      ),
      body_available: body !== null,
    };
  },

  /**
   * All attempts of ONE turn, oldest attempt first (issue #514 review round 2).
   *
   * Retries deliberately get their own `trace_id` so they cannot collide on the
   * primary key; without this query the Explorer would show them as N unrelated
   * traces and a retry investigation would stay fragmented.
   *
   * Served by `runtime_trace_env_attempt_group_idx (tenant_id, root_trace_id,
   * attempt)` from migration 107 — tenant-leading like every other read here.
   *
   * Bounded at 50: an attempt count beyond that is a runaway retry loop, and
   * the operator needs the first few plus the fact that it ran away, not 500
   * rows.
   */
  async listAttempts(input: {
    tenantId: string;
    rootTraceId: string;
  }): Promise<TraceListItem[]> {
    assertTenant(input.tenantId);
    const t = runtime_trace_envelopes;
    const rows = await db
      .select({
        trace_id: t.trace_id,
        tenant_id: t.tenant_id,
        agent_id: t.agent_id,
        conversa_id: t.conversa_id,
        turno_id: t.turno_id,
        root_trace_id: t.root_trace_id,
        attempt: t.attempt,
        decision: t.decision,
        side_effect_level: t.side_effect_level,
        redaction_class: t.redaction_class,
        body_status: t.body_status,
        body_persisted_at: t.body_persisted_at,
        created_at: t.created_at,
      })
      .from(t)
      .where(and(eq(t.tenant_id, input.tenantId), eq(t.root_trace_id, input.rootTraceId)))
      .orderBy(t.attempt, t.created_at)
      .limit(50);
    return rows as TraceListItem[];
  },

  /**
   * Counts by body status for a tenant — powers the "body pending/orphaned"
   * indicator the issue asks for, without listing the rows.
   */
  async bodyStatusCounts(input: {
    tenantId: string;
    agentId?: string;
  }): Promise<Record<string, number>> {
    assertTenant(input.tenantId);
    const t = runtime_trace_envelopes;
    const conditions = [eq(t.tenant_id, input.tenantId)];
    if (input.agentId) conditions.push(eq(t.agent_id, input.agentId));

    const rows = await db
      .select({ body_status: t.body_status, n: sql<number>`count(*)::int` })
      .from(t)
      .where(and(...conditions))
      .groupBy(t.body_status);

    const out: Record<string, number> = { pending: 0, persisted: 0, orphaned: 0 };
    for (const r of rows) out[r.body_status] = Number(r.n);
    return out;
  },
};

export const _internal = { SIDE_EFFECT_LEVELS };
