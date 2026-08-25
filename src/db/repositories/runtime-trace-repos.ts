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
  attemptGroupingIsSigned,
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
  /**
   * Issue #535: which canonical material `envelope_hmac` covers. 2 ⇒
   * `root_trace_id`/`attempt` are inside the signature; 1 ⇒ they are not.
   */
  signature_version: number;
  decision: string;
  side_effect_level: string;
  redaction_class: string;
  body_status: string;
  body_persisted_at: Date | null;
  created_at: Date;
}

/**
 * An attempt as the Explorer's grouping view returns it: the list row plus the
 * verdict this repo reached about the row's OWN signature.
 *
 * The verdict travels with the row on purpose. `listAttempts()` already refuses
 * to return an `invalid` sibling, but "we checked and it held" and "we could
 * not check" are different facts and the operator is the one who has to weigh
 * them during an incident.
 */
export interface TraceAttemptItem extends TraceListItem {
  integrity: EnvelopeIntegrity;
  /** False on a v1 row: `root_trace_id`/`attempt` are outside its signature. */
  grouping_signed: boolean;
}

/**
 * A row that reached the group's predicate and was refused by its own
 * signature. Ids and the verdict only — never a field value.
 */
export interface TraceAttemptRefusal {
  trace_id: string;
  attempt: number;
  integrity: EnvelopeIntegrity;
}

export interface TraceAttemptGroup {
  items: TraceAttemptItem[];
  refused: TraceAttemptRefusal[];
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
 * Issue #535 — `listAttempts()` was called without the signed `turno_id`.
 *
 * Its own class, not a reused `TraceTenantScopeError`: this is not a tenant
 * problem and an operator reading the log should not be sent looking for one.
 */
export class TraceAttemptScopeError extends Error {
  readonly code = 'TRACE_ATTEMPT_TURN_SCOPE_REQUIRED';
  constructor(detail: string) {
    super(`runtimeTraceRepo: ${detail}`);
    this.name = 'TraceAttemptScopeError';
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
        signature_version: t.signature_version,
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
      signature_version: env.signature_version,
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
        // Issue #535: signed from v2 on. Passing them for a v1 row is harmless
        // — `envelopeSignedPayloadV1` never reads them.
        root_trace_id: env.root_trace_id,
        attempt: env.attempt,
        signature_version: env.signature_version,
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
   * All attempts of ONE turn, oldest attempt first (issue #514 review round 2;
   * hardened in #535).
   *
   * Retries deliberately get their own `trace_id` so they cannot collide on the
   * primary key; without this query the Explorer would show them as N unrelated
   * traces and a retry investigation would stay fragmented.
   *
   * ## Why `turnoId` is REQUIRED (issue #535)
   *
   * `root_trace_id` is the field that says "these rows belong together". Before
   * #535 it was not signed at all; from v2 on it is — but v1 rows exist (in
   * fixtures, and in any environment that already wrote some), and on those it
   * is still an ordinary editable column. A single edited `root_trace_id` there
   * would splice one turn's attempt into ANOTHER turn's attempt list, and the
   * Explorer would render two distinct turns as one retry chain. That is the
   * "fusão visual entre turnos" the owner asked to close.
   *
   * `turno_id` has been inside `envelope_hmac` since migration 052, in EVERY
   * version. Requiring it as a second predicate means a row can only join this
   * group if it agrees with the group on a field its own signature covers.
   *
   * Two more rules follow from the same reasoning, and neither is optional:
   *
   *   1. A blank/absent `turnoId` FAILS CLOSED (throws) rather than falling
   *      back to grouping by `root_trace_id` alone. A fallback would be the
   *      whole control, switched off by omitting an argument.
   *   2. A returned row whose own signature does NOT verify is DROPPED. Letting
   *      an `invalid` row into the group would let a forger re-add exactly the
   *      row this predicate excluded, by also rewriting its `turno_id` — the
   *      signature is what makes that rewrite detectable, so it has to be
   *      checked, not merely relied upon.
   *
   * This is DEFENCE IN DEPTH, not the primary control. The primary control is
   * that production signs `root_trace_id` and `attempt` (v2). This layer is what
   * still holds when the row predates that.
   *
   * Served by `runtime_trace_env_attempt_turn_idx (tenant_id, root_trace_id,
   * turno_id, attempt)` from migration 119 — tenant-leading like every other
   * read here.
   *
   * Bounded at 50: an attempt count beyond that is a runaway retry loop, and the
   * operator needs the first few plus the fact that it ran away, not 500 rows.
   *
   * Returns the accepted attempts AND the ones it refused. The refusals are the
   * interesting half: a row that satisfied the tenant/root/turno predicate and
   * still failed its own signature is a row someone edited to reach this group.
   * Dropping it silently would leave that fact only in a log line, so the caller
   * gets it back and audits it.
   */
  async listAttempts(input: {
    tenantId: string;
    rootTraceId: string;
    /**
     * The SIGNED `turno_id` of the trace being viewed. Required — see the
     * docstring. Callers get it from a row they have already verified.
     */
    turnoId: string;
  }): Promise<TraceAttemptGroup> {
    assertTenant(input.tenantId);
    if (typeof input.turnoId !== 'string' || input.turnoId.trim().length === 0) {
      // Fail closed. The alternative — grouping by `root_trace_id` alone — is
      // the exact behaviour #535 removed, and it would be reachable by simply
      // not passing the argument.
      throw new TraceAttemptScopeError(
        'listAttempts requires the signed turno_id (fail-closed): grouping by root_trace_id ' +
          'alone lets a tampered root splice two turns into one attempt chain',
      );
    }
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
        signature_version: t.signature_version,
        policy_id: t.policy_id,
        decision: t.decision,
        side_effect_level: t.side_effect_level,
        redaction_class: t.redaction_class,
        envelope_hmac: t.envelope_hmac,
        hmac_key_version: t.hmac_key_version,
        body_status: t.body_status,
        body_persisted_at: t.body_persisted_at,
        created_at: t.created_at,
      })
      .from(t)
      .where(
        and(
          eq(t.tenant_id, input.tenantId),
          eq(t.root_trace_id, input.rootTraceId),
          // The signed predicate. Everything above it is grouping metadata; this
          // is the one field an attacker cannot move without breaking the HMAC.
          eq(t.turno_id, input.turnoId),
        ),
      )
      .orderBy(t.attempt, t.created_at)
      .limit(50);

    const out: TraceAttemptItem[] = [];
    const refused: TraceAttemptRefusal[] = [];
    for (const r of rows) {
      const integrity = verifyEnvelopeIntegrity({
        trace_id: r.trace_id,
        tenant_id: r.tenant_id,
        agent_id: r.agent_id,
        conversa_id: r.conversa_id,
        turno_id: r.turno_id,
        policy_id: r.policy_id,
        decision: r.decision as VerifiableDecision,
        side_effect_level: r.side_effect_level as VerifiableSideEffectLevel,
        redaction_class: r.redaction_class,
        hmac_key_version: r.hmac_key_version,
        root_trace_id: r.root_trace_id,
        attempt: r.attempt,
        signature_version: r.signature_version,
        envelope_hmac: r.envelope_hmac,
      });
      // `invalid` is the only verdict that excludes. `unknown` (secret not
      // configured here) and `rejected_version` (policy) are reported, not
      // silently dropped: hiding a row an operator can see in the list view
      // would look like evidence going missing.
      if (integrity === 'invalid') {
        refused.push({ trace_id: r.trace_id, attempt: r.attempt, integrity });
        continue;
      }
      out.push({
        trace_id: r.trace_id,
        tenant_id: r.tenant_id,
        agent_id: r.agent_id,
        conversa_id: r.conversa_id,
        turno_id: r.turno_id,
        root_trace_id: r.root_trace_id,
        attempt: r.attempt,
        signature_version: r.signature_version,
        decision: r.decision,
        side_effect_level: r.side_effect_level,
        redaction_class: r.redaction_class,
        body_status: r.body_status,
        body_persisted_at: r.body_persisted_at,
        created_at: r.created_at,
        integrity,
        grouping_signed: attemptGroupingIsSigned(r),
      });
    }
    return { items: out, refused };
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
