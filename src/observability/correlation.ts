/**
 * Issue #514 §1 — the correlation contract.
 *
 * ONE `trace_id` per turn, stable across retries and recovery, propagated
 * through ALS → BullMQ job payload → worker → decision engine → runtime trace
 * → logs. Each *attempt* at the same turn gets its own `attempt` ordinal and
 * `attempt_id` so a retry is distinguishable from the original without
 * splitting the root trace.
 *
 * Design notes:
 *
 * 1. **Derived, not minted.** `deriveTraceId(seed)` is a pure function of the
 *    persisted inbound id. That is what makes "recovery preserves the root
 *    trace" free: the message-recovery sweep re-enqueues the same `mensagem_id`
 *    and therefore lands on the same trace id, with no state to carry. It also
 *    removes the divergence the issue calls out between
 *    `runtime/decision/build-base-context.ts` (used `inbound.id`) and
 *    `runtime/context-packet/base-context-builder.ts` (minted a fresh UUID).
 *
 * 2. **Separate ALS from the tenant ALS.** `src/db/tenant-context.ts` is a
 *    fail-CLOSED security boundary — a missing tenant must throw. Correlation
 *    is diagnostic: a missing trace id must never break a turn. Mixing them
 *    would force one of the two semantics onto the other. Two stores, two
 *    contracts.
 *
 * 3. **Additive.** Nothing here is required for a turn to run. Every reader is
 *    `try*`-shaped and degrades to `null`. Branches that rewrite the hot path
 *    in parallel (#503 turn state machine, #508 LLM gateway, #512 lifecycle)
 *    can adopt this contract incrementally without a coordinated cut-over.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

/** Where the current attempt came from. Bounded, safe as a metric label. */
export type CorrelationOrigin =
  | 'ingress'
  | 'queue'
  | 'recovery'
  | 'replay'
  | 'probe'
  | 'internal';

export interface CorrelationContext {
  /** Root id of the turn. Stable across every attempt and recovery. */
  readonly trace_id: string;
  /** The persisted inbound row id this turn is about, when known. */
  readonly turn_id: string | null;
  /** 1-based attempt ordinal. A BullMQ retry increments it. */
  readonly attempt: number;
  /** Unique per attempt — the span/attempt discriminator. */
  readonly attempt_id: string;
  /** How this attempt was started. */
  readonly origin: CorrelationOrigin;
  /** `mensagens.created_at` in epoch ms — the SLI clock for E2E latency. */
  readonly received_at_ms: number | null;
  /** When the job was armed, epoch ms — the queue-wait clock. */
  readonly enqueued_at_ms: number | null;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Namespace separator for derived ids — keeps the derivation domain-scoped. */
const TRACE_NAMESPACE = 'maia.trace.v1:';

/**
 * Deterministically map a stable persisted id to a trace id.
 *
 * - Already a UUID (the common case: `mensagens.id`) → returned verbatim, so
 *   the trace id keeps pointing at the row an operator can look up, and the
 *   pre-existing behaviour of `build-base-context.ts` is preserved bit-for-bit.
 * - Anything else → a deterministic RFC-4122-shaped v5-style id derived from
 *   SHA-256 over the namespaced seed. Same seed ⇒ same id, forever, in any
 *   process.
 *
 * Never random: randomness here would break recovery correlation.
 */
export function deriveTraceId(seed: string): string {
  if (UUID_RE.test(seed)) return seed.toLowerCase();
  const h = createHash('sha256').update(TRACE_NAMESPACE + seed).digest();
  // Force RFC-4122 version 5 + variant bits so the value is a well-formed UUID
  // and cannot collide with a v4 the runtime mints elsewhere.
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

export interface StartCorrelationInput {
  /** Explicit trace id (e.g. carried on a job payload). */
  trace_id?: string | null;
  /** Stable seed to derive from when `trace_id` is absent. */
  seed?: string | null;
  turn_id?: string | null;
  attempt?: number;
  origin?: CorrelationOrigin;
  received_at_ms?: number | null;
  enqueued_at_ms?: number | null;
}

/**
 * Build a context without entering it. Exported so callers can serialise the
 * trace id onto a job payload before the async boundary.
 */
export function buildCorrelation(input: StartCorrelationInput): CorrelationContext {
  const trace_id =
    (input.trace_id && input.trace_id.trim().length > 0
      ? input.trace_id.trim()
      : null) ??
    (input.seed ? deriveTraceId(input.seed) : null) ??
    randomUUID();
  return Object.freeze({
    trace_id,
    turn_id: input.turn_id ?? null,
    attempt: Math.max(1, Math.floor(input.attempt ?? 1)),
    attempt_id: randomUUID(),
    origin: input.origin ?? 'internal',
    received_at_ms: input.received_at_ms ?? null,
    enqueued_at_ms: input.enqueued_at_ms ?? null,
  });
}

/** Run `fn` under a fresh correlation context. */
export async function runWithCorrelation<T>(
  input: StartCorrelationInput | CorrelationContext,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx =
    'attempt_id' in input && typeof (input as CorrelationContext).attempt_id === 'string'
      ? (input as CorrelationContext)
      : buildCorrelation(input as StartCorrelationInput);
  return storage.run(ctx, fn);
}

/**
 * Run `fn` under the CURRENT trace id but as a new attempt. Used by retry /
 * recovery paths that must preserve the root trace while separating attempts
 * (issue #514: "Recovery mantém o mesmo root trace e cria novo attempt/span").
 */
export async function runAsNewAttempt<T>(
  overrides: Partial<StartCorrelationInput>,
  fn: () => Promise<T>,
): Promise<T> {
  const cur = tryGetCorrelation();
  return runWithCorrelation(
    {
      trace_id: overrides.trace_id ?? cur?.trace_id ?? null,
      seed: overrides.seed ?? cur?.turn_id ?? null,
      turn_id: overrides.turn_id ?? cur?.turn_id ?? null,
      attempt: overrides.attempt ?? (cur?.attempt ?? 0) + 1,
      origin: overrides.origin ?? cur?.origin ?? 'internal',
      received_at_ms: overrides.received_at_ms ?? cur?.received_at_ms ?? null,
      enqueued_at_ms: overrides.enqueued_at_ms ?? cur?.enqueued_at_ms ?? null,
    },
    fn,
  );
}

/** Current correlation context, or `null` outside one. Never throws. */
export function tryGetCorrelation(): CorrelationContext | null {
  return storage.getStore() ?? null;
}

/** Current trace id, or `null`. Never throws. */
export function currentTraceId(): string | null {
  return storage.getStore()?.trace_id ?? null;
}

/**
 * Structured-log fields for the current correlation. Merge into every log line
 * on the hot path so log ↔ trace ↔ audit join on `trace_id`.
 *
 * These are LOG fields, not metric labels — high-cardinality ids belong here
 * and are explicitly forbidden by `observability/taxonomy.ts` as labels.
 */
export function correlationLogFields(): Record<string, string | number> {
  const ctx = storage.getStore();
  if (!ctx) return {};
  const out: Record<string, string | number> = {
    trace_id: ctx.trace_id,
    attempt: ctx.attempt,
    attempt_id: ctx.attempt_id,
    origin: ctx.origin,
  };
  if (ctx.turn_id) out.turn_id = ctx.turn_id;
  return out;
}

/**
 * Serialisable slice to put on a queue job payload. Deliberately tiny: the
 * trace id plus the two clocks the SLIs need. Everything else is re-derived on
 * the consumer side.
 */
export interface CorrelationJobFields {
  trace_id: string;
  enqueued_at_ms: number;
  received_at_ms?: number;
}

/**
 * Build the job-payload fields for a turn keyed by `seed` (the inbound row id).
 * Reuses the ambient trace id when the producer already has one.
 */
export function correlationForJob(
  seed: string,
  received_at_ms?: number | null,
): CorrelationJobFields {
  const cur = tryGetCorrelation();
  const trace_id =
    cur && cur.turn_id === seed ? cur.trace_id : deriveTraceId(seed);
  return {
    trace_id,
    enqueued_at_ms: Date.now(),
    ...(received_at_ms != null ? { received_at_ms } : {}),
  };
}
