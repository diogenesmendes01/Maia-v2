/**
 * Issue #520 §13 — tombstone ledger and post-restore reconciliation.
 *
 * The problem, stated plainly: a backup taken BEFORE a deletion still contains
 * the deleted record. Restoring it RESURRECTS personal data that a subject
 * asked to have erased. Nothing in the baseline prevented that.
 *
 * The ledger is the answer. Every deletion (whether from a privacy request, an
 * ordinary retention pass, or an operator action) writes a tombstone carrying
 * the instant it took effect. After restoring a snapshot, the runtime must
 * replay every tombstone newer than the snapshot's watermark BEFORE releasing
 * traffic — and if it cannot prove it did, the restore fails closed.
 *
 * Two privacy properties this module holds:
 *  - The ledger stores PSEUDONYMS. A tombstone containing the phone number it
 *    claims to have erased would be a copy of the very data it deleted, so
 *    `subject_ref`/`resource_locator` are HMACs. The ledger can RECOGNISE a
 *    subject it is given; it cannot ENUMERATE subjects.
 *  - Each row is HMAC-signed. A planted or edited tombstone (either to hide a
 *    deletion, or to trigger one) fails verification and BLOCKS the restore
 *    rather than being skipped.
 */
import { createHmac } from 'node:crypto';
import { TypedError } from '@/lib/utils.js';
import { digestsMatch } from '@/ops/backup/checksum.js';

export type TombstoneAction = 'delete' | 'anonymize' | 'redact';
export type TombstoneOrigin = 'privacy_request' | 'retention_policy' | 'operator';

export interface TombstoneRecord {
  id: string;
  tenant_id: string;
  agent_id: string;
  data_class: string;
  /** Pseudonymised subject reference (see `pseudonymize`). */
  subject_ref: string | null;
  /** Pseudonymised resource locator (media key, file path, …). */
  resource_locator: string | null;
  action: TombstoneAction;
  effective_at: Date;
  origin: TombstoneOrigin;
  version: number;
  hmac: string;
  hmac_key_version: number;
}

/**
 * Domain-separation label for the ledger's keying material (issue #536).
 *
 * The ledger has no dedicated secret in the configuration contract, and adding
 * one would be a config change nobody can roll out before the first tombstone
 * is written. Instead the ledger key is DERIVED from the platform's existing
 * HMAC master secret with a fixed label, so:
 *
 *  - the ledger key is not the manifest-signing key, even though both descend
 *    from the same master (using one secret for two protocols is how a
 *    signature from one becomes a valid signature in the other);
 *  - the derivation is defined ONCE, here, before anything writes a tombstone.
 *    A future writer that derives it differently would produce rows that fail
 *    verification and BLOCK every restore — so this function is the contract,
 *    not a helper.
 *
 * MUST NOT change: rotating the label invalidates every existing tombstone's
 * HMAC, and an unverifiable ledger blocks the return to production by design.
 */
export const TOMBSTONE_KEY_LABEL = 'maia.tombstone.hmac.v1';

export function deriveTombstoneSecret(masterSecret: string | undefined): string {
  if (!masterSecret) {
    throw new TypedError(
      'tombstone_secret_missing',
      'no master secret is configured — the tombstone ledger cannot be keyed',
      {},
    );
  }
  return createHmac('sha256', masterSecret).update(TOMBSTONE_KEY_LABEL, 'utf8').digest('hex');
}

/**
 * One-way, keyed pseudonym. Keyed (not a bare hash) so an attacker holding the
 * ledger cannot brute-force the small space of Brazilian phone numbers.
 *
 * The same input under the same key always yields the same pseudonym, which is
 * what lets reconciliation match a restored row against a tombstone.
 */
export function pseudonymize(value: string, secret: string): string {
  if (!secret) {
    throw new TypedError(
      'tombstone_secret_missing',
      'pseudonymisation secret is not configured — a tombstone must never store a raw identifier',
      {},
    );
  }
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

/**
 * Canonical byte string a tombstone's HMAC covers. Field order is fixed here
 * (not derived from object key order) so the signature is stable across
 * runtimes and serialisation changes.
 */
export function tombstonePayload(t: Omit<TombstoneRecord, 'hmac' | 'hmac_key_version'>): string {
  return [
    `v${t.version}`,
    t.id,
    t.tenant_id,
    t.agent_id,
    t.data_class,
    t.subject_ref ?? '',
    t.resource_locator ?? '',
    t.action,
    t.origin,
    t.effective_at.toISOString(),
  ].join('');
}

export function signTombstone(
  t: Omit<TombstoneRecord, 'hmac' | 'hmac_key_version'>,
  secret: string,
): string {
  if (!secret) {
    throw new TypedError(
      'tombstone_secret_missing',
      'tombstone signing secret is not configured — an unsigned ledger cannot block resurrection',
      {},
    );
  }
  return createHmac('sha256', secret).update(tombstonePayload(t), 'utf8').digest('hex');
}

export function verifyTombstone(t: TombstoneRecord, secret: string): boolean {
  if (!secret) return false;
  const { hmac: _h, hmac_key_version: _v, ...body } = t;
  void _h;
  void _v;
  let expected: string;
  try {
    expected = createHmac('sha256', secret).update(tombstonePayload(body), 'utf8').digest('hex');
  } catch {
    return false;
  }
  return digestsMatch(expected, t.hmac);
}

export type ReconciliationBlockReason =
  | 'ledger_unavailable'
  | 'watermark_missing'
  | 'invalid_tombstone';

export interface ReconciliationPlan {
  /**
   * `false` means the restored runtime MUST NOT be released to production.
   * Issue §13: "sem reconciliação conclusiva, restore falha fechado".
   */
  ok: boolean;
  blocked_reason: ReconciliationBlockReason | null;
  /** Tombstones newer than the watermark, in deterministic order. */
  pending: TombstoneRecord[];
  /** Ids that failed HMAC verification — surfaced, never silently dropped. */
  invalid_ids: string[];
  /** Counts per data class, for the drill's evidence row (no PII). */
  by_class: Record<string, number>;
}

export interface ReconciliationInput {
  /**
   * The restored snapshot's tombstone watermark. `null` means the artifact
   * predates the ledger (or the manifest is missing) — we cannot know what to
   * replay, so the restore is blocked.
   */
  watermark: Date | null;
  /**
   * Whether the ledger boundary was actually readable. `false` blocks the
   * restore (§13 "falha de acesso ao ledger bloqueia retorno à produção").
   */
  ledger_available: boolean;
  tombstones: readonly TombstoneRecord[];
  /** HMAC secret used to verify each row. */
  secret: string;
}

/**
 * Build the reconciliation plan for a restored snapshot.
 *
 * Deliberately conservative: any doubt (unreadable ledger, unknown watermark,
 * a row that fails verification) yields `ok: false`. The caller's only correct
 * response to `ok: false` is to keep the runtime in maintenance mode.
 */
export function planReconciliation(input: ReconciliationInput): ReconciliationPlan {
  const empty = { pending: [], invalid_ids: [], by_class: {} };

  if (!input.ledger_available) {
    return { ok: false, blocked_reason: 'ledger_unavailable', ...empty };
  }
  if (input.watermark === null || Number.isNaN(input.watermark.getTime())) {
    return { ok: false, blocked_reason: 'watermark_missing', ...empty };
  }

  const invalid_ids: string[] = [];
  const pending: TombstoneRecord[] = [];
  for (const t of input.tombstones) {
    if (!verifyTombstone(t, input.secret)) {
      invalid_ids.push(t.id);
      continue;
    }
    if (t.effective_at.getTime() > input.watermark.getTime()) pending.push(t);
  }

  // Deterministic order: oldest effect first, ties broken by id. Replaying in
  // a stable order makes a partially-applied reconciliation resumable.
  pending.sort((a, b) => {
    const d = a.effective_at.getTime() - b.effective_at.getTime();
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });

  const by_class: Record<string, number> = {};
  for (const t of pending) by_class[t.data_class] = (by_class[t.data_class] ?? 0) + 1;

  if (invalid_ids.length > 0) {
    // A ledger containing a row we cannot verify is a ledger we cannot trust to
    // tell us what was deleted. Block, and report which rows to investigate.
    return {
      ok: false,
      blocked_reason: 'invalid_tombstone',
      pending,
      invalid_ids: invalid_ids.sort(),
      by_class,
    };
  }

  return { ok: true, blocked_reason: null, pending, invalid_ids: [], by_class };
}

/**
 * The release gate (§13 step 10). Traffic and side effects are enabled only
 * when the plan is sound AND every pending tombstone has been re-applied.
 *
 * `applied_ids` is what the executor actually confirmed, not what it intended.
 */
export function canReleaseTraffic(
  plan: ReconciliationPlan,
  applied_ids: readonly string[],
): { release: boolean; reason: string } {
  if (!plan.ok) {
    return { release: false, reason: plan.blocked_reason ?? 'reconciliation_not_ok' };
  }
  const applied = new Set(applied_ids);
  const missing = plan.pending.filter((t) => !applied.has(t.id));
  if (missing.length > 0) {
    return { release: false, reason: 'tombstones_not_reapplied' };
  }
  return { release: true, reason: 'ok' };
}

/**
 * Does a restored row correspond to something already deleted? Used while
 * replaying: the executor pseudonymises the restored identifier with the same
 * secret and asks the ledger.
 */
export function isResurrected(
  plan: ReconciliationPlan,
  candidate: { data_class: string; subject_ref: string | null; resource_locator: string | null },
): boolean {
  return plan.pending.some(
    (t) =>
      t.data_class === candidate.data_class &&
      ((t.subject_ref !== null && t.subject_ref === candidate.subject_ref) ||
        (t.resource_locator !== null && t.resource_locator === candidate.resource_locator)),
  );
}
