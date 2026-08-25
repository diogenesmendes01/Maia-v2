/**
 * P10b — Synchronous envelope writer (CRITICAL invariant 12).
 *
 * MUST be called BEFORE any side effect with side_effect_level >= medium.
 * The envelope is the audit record proving the decision was made and
 * recorded; if the side effect crashes after this, we still have proof.
 *
 * Hot path discipline:
 *   - Single INSERT (or paired INSERT envelope + outbox in one transaction).
 *   - HMAC over canonical-JSON of the envelope minus envelope_hmac.
 *   - p99 < 20ms (audit gate).
 *
 * On failure: throws. Callers MUST NOT proceed with the side effect when
 * envelope write fails — that would violate invariant 12.
 *
 * Codex review #102 — issue 4 (durability):
 *   When `outbox_body` is provided, we write envelope + body outbox row
 *   in the same DB transaction. This means a process crash between the
 *   envelope write and the in-process enqueueBody() call no longer loses
 *   the packet — the worker picks it up from the durable outbox table.
 */
import { db } from '@/db/client.js';
import {
  runtime_trace_envelopes,
  runtime_trace_body_outbox,
} from '@/db/schema.js';
import type {
  TraceEnvelopeInput,
  TraceEnvelopeWritten,
  SideEffectLevel,
  Decision,
  TraceBodyInput,
} from './types.js';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { signHmac, currentKeyVersion, canonicalJson } from './lib/hmac.js';
import {
  CURRENT_ENVELOPE_SIGNATURE_VERSION,
  envelopeSignedPayload,
  normalizeAttempt,
  type EnvelopeSignatureVersion,
  type EnvelopeSignedFields,
} from './lib/signature.js';
import { logger } from '@/lib/logger.js';
import { incCounter, observeHistogram } from '@/lib/metrics.js';

/**
 * The exact field set covered by `envelope_hmac` lives in ONE place —
 * `lib/signature.ts` — and both the signer (below) and the verifier
 * (`verify-envelope.ts`) build their bytes from it.
 *
 * Issue #514 review round 1 [P2]: the Trace Explorer needs to VERIFY this
 * signature, not just check that the string is non-empty. Signer and verifier
 * must agree byte-for-byte, so both go through the same builder — a field added
 * to the signature there is automatically covered by the check, and the two
 * cannot silently drift apart.
 *
 * Issue #535: the builder is now VERSIONED. This module re-exports the pieces
 * so the historical import path (`envelopeSignedPayload` from the writer) keeps
 * working for the specs and the repo that already use it.
 */
export {
  envelopeSignedPayload,
  envelopeSignedPayloadV1,
  envelopeSignedPayloadV2,
  normalizeAttempt,
  CURRENT_ENVELOPE_SIGNATURE_VERSION,
  ENVELOPE_SIGNATURE_V1,
  ENVELOPE_SIGNATURE_V2,
  SUPPORTED_ENVELOPE_SIGNATURE_VERSIONS,
  isSupportedSignatureVersion,
} from './lib/signature.js';
export type {
  EnvelopeSignatureVersion,
  EnvelopeSignedFields,
  EnvelopeSignedFieldsV1,
  EnvelopeSignedFieldsV2,
} from './lib/signature.js';

/**
 * A replay reused an existing `trace_id` but carries DIFFERENT content.
 *
 * Issue #514 review round 2 [P2]. `onConflictDoNothing` made the writer
 * idempotent for an identical re-write (BullMQ retry, recovery sweep, outbox
 * relayer) — and, in the same move, silently swallowed a DIVERGENT one: the
 * call returned "written" while the table kept different evidence. In an
 * evidence system that is worse than the original crash, because the trail
 * asserts something it did not store.
 *
 * So a conflict is only accepted when the stored row is byte-identical on the
 * fields that matter. Anything else fails closed and is audited: it means an
 * id collision or tampering, neither of which may be papered over.
 */
export class DivergentTraceReplayError extends Error {
  readonly code = 'RUNTIME_TRACE_DIVERGENT_REPLAY';
  constructor(
    readonly trace_id: string,
    readonly tenant_id: string,
    /** Which fields differed. Names only — never the values (PII risk). */
    readonly diverged_fields: readonly string[],
  ) {
    super(
      `Runtime trace: divergent replay for trace_id=${trace_id} tenant=${tenant_id}; ` +
        `stored evidence differs on [${diverged_fields.join(', ')}] — refusing to report success`,
    );
    this.name = 'DivergentTraceReplayError';
  }
}

/**
 * Compare a conflicting row against what we tried to write.
 *
 * `envelope_hmac` alone covers every SIGNED field (and is tenant-keyed, so a
 * cross-tenant collision changes it too), which makes it a single sufficient
 * check for the decision evidence. `tenant_id` is compared explicitly anyway —
 * relying on a hash to prove tenant isolation would be indirect where the
 * invariant deserves to be direct.
 *
 * Issue #535: `root_trace_id`/`attempt` ARE signed from v2 on, and
 * `signature_version` is signed too, so all three are already implied by the
 * HMAC comparison. They stay in this list on purpose — the comparison must keep
 * naming the diverging FIELD for the audit row (`diverged_fields`), and
 * "envelope_hmac" alone would tell an operator that something differs without
 * telling them what. A v1 row still needs them compared directly, since v1
 * leaves them outside the signature.
 *
 * @returns the names of the fields that differ; empty ⇒ identical replay.
 */
export interface ComparableEnvelope {
  tenant_id: string;
  envelope_hmac: string;
  root_trace_id: string | null;
  attempt: number;
  signature_version: number;
}

export function divergedEnvelopeFields(
  stored: ComparableEnvelope,
  attempted: ComparableEnvelope,
): string[] {
  const diverged: string[] = [];
  if (stored.tenant_id !== attempted.tenant_id) diverged.push('tenant_id');
  if (stored.envelope_hmac !== attempted.envelope_hmac) diverged.push('envelope_hmac');
  if ((stored.root_trace_id ?? null) !== (attempted.root_trace_id ?? null)) {
    diverged.push('root_trace_id');
  }
  if (stored.attempt !== attempted.attempt) diverged.push('attempt');
  if (stored.signature_version !== attempted.signature_version) {
    diverged.push('signature_version');
  }
  return diverged;
}

/** Stable digest of an outbox payload, for divergence comparison only. */
export function bodyPayloadDigest(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('base64');
}

export interface EnvelopeWriteOptions {
  /**
   * If supplied, write a durable outbox row in the same transaction as
   * the envelope. The body-writer worker will drain the outbox via
   * FOR UPDATE SKIP LOCKED. Without this option, the caller is
   * responsible for in-process enqueueBody (less durable; recoverable
   * via the recoverer cron at the cost of evidence detail).
   */
  outbox_body?: TraceBodyInput;
}

/** Minimal query surface shared by `db` and a transaction handle. */
type Queryable = Pick<typeof db, 'select'>;

/**
 * A conflicting envelope insert is acceptable ONLY when the stored row is the
 * same evidence. Anything else throws `DivergentTraceReplayError`.
 *
 * Runs only on the conflict path, so the p99 budget of the happy path is
 * untouched by the extra SELECT.
 */
async function assertIdenticalEnvelopeReplay(
  q: Queryable,
  trace_id: string,
  attempted: ComparableEnvelope,
): Promise<void> {
  const rows = await q
    .select({
      tenant_id: runtime_trace_envelopes.tenant_id,
      envelope_hmac: runtime_trace_envelopes.envelope_hmac,
      root_trace_id: runtime_trace_envelopes.root_trace_id,
      attempt: runtime_trace_envelopes.attempt,
      signature_version: runtime_trace_envelopes.signature_version,
    })
    .from(runtime_trace_envelopes)
    .where(eq(runtime_trace_envelopes.trace_id, trace_id))
    .limit(1);

  const stored = rows[0];
  if (!stored) {
    // Conflict reported but the row is gone: another writer deleted it between
    // the INSERT and this SELECT. Nothing to contradict, so treat as a benign
    // race rather than inventing a divergence.
    return;
  }

  const diverged = divergedEnvelopeFields(stored, attempted);
  if (diverged.length > 0) {
    throw new DivergentTraceReplayError(trace_id, attempted.tenant_id, diverged);
  }
}

/**
 * Same rule for the body outbox: an identical replay is a no-op, a divergent
 * one is refused.
 *
 * A MISSING outbox row is the normal case, not a divergence — the body writer
 * drains the row once persisted, so a later replay finds nothing to compare
 * against and the evidence is already durable in `runtime_trace_bodies`.
 */
async function assertIdenticalBodyReplay(
  q: Queryable,
  trace_id: string,
  tenant_id: string,
  attemptedPayload: unknown,
): Promise<void> {
  const rows = await q
    .select({
      tenant_id: runtime_trace_body_outbox.tenant_id,
      payload: runtime_trace_body_outbox.payload,
    })
    .from(runtime_trace_body_outbox)
    .where(eq(runtime_trace_body_outbox.trace_id, trace_id))
    .limit(1);

  const stored = rows[0];
  if (!stored) return; // already drained — see docstring

  const diverged: string[] = [];
  if (stored.tenant_id !== tenant_id) diverged.push('body.tenant_id');
  if (bodyPayloadDigest(stored.payload) !== bodyPayloadDigest(attemptedPayload)) {
    diverged.push('body.payload');
  }
  if (diverged.length > 0) {
    throw new DivergentTraceReplayError(trace_id, tenant_id, diverged);
  }
}

/**
 * Write the envelope synchronously. Returns the written record + sync
 * latency. Throws on DB failure — caller MUST abort the side effect.
 */
export async function writeEnvelope(
  input: TraceEnvelopeInput,
  options: EnvelopeWriteOptions = {},
): Promise<TraceEnvelopeWritten> {
  const t0 = performance.now();
  const redaction_class = input.redaction_class ?? 'standard';
  const side_effect_level: SideEffectLevel = input.decision.side_effect_level;
  const decision: Decision = input.decision.decision;
  const policy_id = input.decision.policy_id ?? null;
  const hmac_key_version = currentKeyVersion();
  // Issue #514 review round 2: attempt grouping. Defaults keep every existing
  // caller (and attempt 1) writing exactly what it wrote before.
  const root_trace_id = input.root_trace_id ?? input.trace_id;
  const attempt = normalizeAttempt(input.attempt);

  // Issue #535 — PRODUCTION WRITES ONLY v2. This is the single place a written
  // envelope's signature version is decided, and it is a constant, not an
  // input: a caller-chosen version would be a downgrade oracle handed to
  // whoever can reach the writer. v1 stays readable (`verify-envelope.ts`) and
  // is never re-signed — a v1 row keeps its v1 signature forever.
  const signature_version: EnvelopeSignatureVersion = CURRENT_ENVELOPE_SIGNATURE_VERSION;

  // Payload to sign — canonical JSON guarantees stable bytes regardless of
  // insertion order. We sign the envelope contents (no DB-assigned fields).
  const signedFields: EnvelopeSignedFields = {
    trace_id: input.trace_id,
    tenant_id: input.tenant_id,
    agent_id: input.agent_id,
    conversa_id: input.conversa_id ?? null,
    turno_id: input.turno_id ?? null,
    policy_id,
    decision,
    side_effect_level,
    redaction_class,
    hmac_key_version,
    // Signed from v2 on. Before #535 an `attempt` edit was undetectable and a
    // `root_trace_id` edit could move an attempt into another turn's group.
    root_trace_id,
    attempt,
  };
  const signedPayload = envelopeSignedPayload(signedFields, signature_version);
  const envelope_hmac = signHmac(input.tenant_id, hmac_key_version, signedPayload);

  // ONE row definition for both write paths — they had drifted into
  // copy-paste twins, and a column added to one but not the other is a silent
  // evidence gap.
  const envelopeRow = {
    trace_id: input.trace_id,
    tenant_id: input.tenant_id,
    agent_id: input.agent_id,
    conversa_id: input.conversa_id ?? null,
    turno_id: input.turno_id ?? null,
    root_trace_id,
    attempt,
    policy_id,
    decision,
    side_effect_level,
    redaction_class,
    envelope_hmac,
    hmac_key_version,
    signature_version,
    body_status: 'pending' as const,
  };

  try {
    if (options.outbox_body) {
      // Durable path: envelope + outbox row in one transaction.
      // If the body INSERT fails, the envelope is rolled back too — we'd
      // rather lose the envelope (no proof) than the body (lost evidence
      // attached to a phantom envelope).
      await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(runtime_trace_envelopes)
          .values(envelopeRow)
          // Issue #514 review round 1 [P1]: the writer is at-least-once by
          // construction (BullMQ retries, the recovery sweep, the outbox
          // relayer). Re-writing the SAME envelope must be a no-op, not a
          // unique violation that fails the turn closed. Distinct ATTEMPTS get
          // distinct ids upstream (`envelopeTraceIdForAttempt`), so a conflict
          // normally means "this exact attempt was already recorded".
          //
          // Round 2 [P2]: "normally" is not "always". `returning()` tells us a
          // conflict happened, and we then PROVE the stored row is the same
          // evidence before reporting success.
          .onConflictDoNothing()
          .returning({ trace_id: runtime_trace_envelopes.trace_id });

        if (inserted.length === 0) {
          await assertIdenticalEnvelopeReplay(tx, input.trace_id, envelopeRow);
        }

        const bodyForOutbox = options.outbox_body!;
        const outboxInserted = await tx
          .insert(runtime_trace_body_outbox)
          .values({
            trace_id: input.trace_id,
            tenant_id: input.tenant_id,
            agent_id: input.agent_id,
            payload: bodyForOutbox as unknown as Record<string, unknown>,
            redaction_class,
          })
          .onConflictDoNothing()
          .returning({ trace_id: runtime_trace_body_outbox.trace_id });

        if (outboxInserted.length === 0) {
          await assertIdenticalBodyReplay(tx, input.trace_id, input.tenant_id, bodyForOutbox);
        }
      });
    } else {
      // Best-effort path (legacy callers / minimal redaction).
      const inserted = await db
        .insert(runtime_trace_envelopes)
        .values(envelopeRow)
        // Same at-least-once rationale as the transactional path above.
        .onConflictDoNothing()
        .returning({ trace_id: runtime_trace_envelopes.trace_id });
      if (inserted.length === 0) {
        await assertIdenticalEnvelopeReplay(db, input.trace_id, envelopeRow);
      }
    }
  } catch (err) {
    incCounter('maia_runtime_trace_envelope_write_failed_total', {
      decision,
      side_effect_level,
    });
    logger.error(
      { err, trace_id: input.trace_id, decision, side_effect_level },
      'runtime_trace.envelope_write_failed',
    );
    throw err;
  }

  const sync_latency_ms = performance.now() - t0;
  incCounter('maia_runtime_trace_envelope_written_total', {
    decision,
    side_effect_level,
    redaction_class,
  });
  observeHistogram('maia_runtime_trace_envelope_latency_ms', sync_latency_ms);

  return {
    trace_id: input.trace_id,
    root_trace_id,
    attempt,
    envelope_hmac,
    hmac_key_version,
    signature_version,
    side_effect_level,
    decision,
    policy_id,
    redaction_class,
    sync_latency_ms,
  };
}
