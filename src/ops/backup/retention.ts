/**
 * Issue #520 §10 — manifest-driven, hold-aware artifact retention.
 *
 * ROUND-1 REVIEW FINDING (P1). The destructive paths ignored everything this
 * issue built:
 *
 *  - `pruneLocal` deleted final artifacts by FILE MTIME, consulting neither the
 *    manifest nor legal hold — so an artifact frozen by a hold could be
 *    destroyed. Destroying data under legal hold is the worst outcome this
 *    issue has, because preventing it is the mechanism it exists to provide.
 *  - `pruneCloud` selected by `LastModified`, swallowed a per-chunk delete
 *    failure, returned a partial count, and the caller audited
 *    `backup_cloud_rotation_completed` regardless. A retention pass that
 *    deleted half of what it intended reported success, so the evidence lied.
 *
 * The replacement plans every deletion from the RUN + MANIFEST and the policy,
 * evaluates hold before each one, CONFIRMS each result, and reports a
 * conclusive outcome. `mtime` survives in exactly one place: sweeping orphaned
 * `.partial` files, which by construction have no manifest and are not backups.
 *
 * Pure planner + injected-IO executor, so the adversarial cases (a delete that
 * lies, a hold evaluator that fails) are reachable from tests.
 */
import { TypedError } from '@/lib/utils.js';
import type { BackupState } from './state-machine.js';

/** One artifact as the evidence tables describe it. */
export interface RetentionCandidate {
  backup_id: string;
  /** Basename. Never an absolute path. */
  artifact_ref: string;
  state: BackupState;
  destination_kind: 'local' | 's3';
  /** From the manifest/run. `null` = the policy never assigned an expiry. */
  delete_after: Date | null;
  /** Whether a signed manifest exists for this run. */
  has_manifest: boolean;
}

export type KeepReason =
  | 'not_terminal'
  | 'not_expired'
  | 'no_expiry_set'
  | 'no_manifest'
  | 'legal_hold';

export type RetentionDecision =
  | { action: 'keep'; reason: KeepReason }
  | { action: 'delete'; reason: 'expired' };

export interface PlannedArtifact {
  candidate: RetentionCandidate;
  decision: RetentionDecision;
}

const TERMINAL_DELETABLE: ReadonlySet<BackupState> = new Set<BackupState>([
  'completed',
  'completed_degraded',
  'failed',
  'expired',
]);

/**
 * Decide, per artifact, from evidence only. PURE — no clock, no IO.
 *
 * `held` is passed in because the hold verdict must be taken under the
 * retention lock, immediately before the delete, not cached from a column that
 * may be minutes stale.
 */
export function planArtifactRetention(
  candidates: readonly RetentionCandidate[],
  now: Date,
  held: boolean,
): PlannedArtifact[] {
  return candidates.map((candidate) => ({
    candidate,
    decision: decide(candidate, now, held),
  }));
}

function decide(c: RetentionCandidate, now: Date, held: boolean): RetentionDecision {
  // A run still in flight owns its artifact.
  if (!TERMINAL_DELETABLE.has(c.state)) return { action: 'keep', reason: 'not_terminal' };

  // Legal hold beats every other consideration while it is active (§11).
  if (held) return { action: 'keep', reason: 'legal_hold' };

  // No manifest ⇒ we cannot prove WHAT this artifact is, so we do not destroy
  // it. This is the direct inverse of the mtime bug: an unidentifiable file is
  // reported to the operator, never reaped on a guess. (Pre-#520 artifacts land
  // here; the runbook covers retiring them by hand.)
  if (!c.has_manifest) return { action: 'keep', reason: 'no_manifest' };

  if (c.delete_after === null) return { action: 'keep', reason: 'no_expiry_set' };
  if (c.delete_after.getTime() > now.getTime()) return { action: 'keep', reason: 'not_expired' };

  return { action: 'delete', reason: 'expired' };
}

export interface RetentionPorts {
  now(): Date;
  /** Artifacts the evidence tables know about, for one destination. */
  listCandidates(destination: 'local' | 's3'): Promise<RetentionCandidate[]>;
  /**
   * Is ANY legal hold active right now? A dump is a container of every
   * tenant's data, so a hold anywhere freezes the whole artifact. Returns
   * `null` when the evaluation could not be made — which FAILS the pass rather
   * than defaulting to "no hold".
   */
  anyActiveHold(at: Date): Promise<{ held: boolean; hold_ids: string[] } | null>;
  /** Delete one artifact. */
  deleteArtifact(candidate: RetentionCandidate): Promise<void>;
  /** Prove it is gone. "delete returned success" is not evidence. */
  confirmDeleted(candidate: RetentionCandidate): Promise<boolean>;
  /** Mark the run row as `deleted`. */
  markDeleted(backup_id: string): Promise<void>;
  audit(action: string, metadata: Record<string, unknown>): Promise<void>;
  log(event: string, detail: Record<string, unknown>): void;
}

export interface RetentionOutcome {
  status: 'completed' | 'partial' | 'failed';
  scanned: number;
  eligible: number;
  deleted: number;
  skipped_held: number;
  /** Artifacts kept because nothing identifies them. Operator-actionable. */
  unidentified: number;
  failed: number;
  /** Stable code when the whole pass could not run. */
  error_code: string | null;
  /** Oldest artifact NOT yet processed — where a resumed pass restarts. */
  cursor_watermark: Date | null;
}

/**
 * Execute one retention pass for one destination.
 *
 * Contract the finding demands:
 *  - a hold evaluation that FAILS aborts the pass (`failed`), it does not
 *    default to "not held";
 *  - every delete is confirmed; an unconfirmed one counts as failed;
 *  - any failure downgrades the outcome to `partial`/`failed`, so the audit can
 *    never say `completed` for a pass that half-worked;
 *  - `dryRun` counts without deleting anything.
 */
export async function runArtifactRetention(
  ports: RetentionPorts,
  destination: 'local' | 's3',
  options: { dryRun: boolean; correlationId: string },
): Promise<RetentionOutcome> {
  const now = ports.now();
  const outcome: RetentionOutcome = {
    status: 'completed',
    scanned: 0,
    eligible: 0,
    deleted: 0,
    skipped_held: 0,
    unidentified: 0,
    failed: 0,
    error_code: null,
    cursor_watermark: null,
  };

  let candidates: RetentionCandidate[];
  try {
    candidates = await ports.listCandidates(destination);
  } catch (err) {
    ports.log('backup.retention_list_failed', {
      destination,
      error: (err as Error).name,
    });
    return { ...outcome, status: 'failed', error_code: 'candidate_listing_failed' };
  }
  outcome.scanned = candidates.length;

  // The hold verdict is taken ONCE per pass, under the caller's retention lock,
  // and before any delete. A failure here is fatal: proceeding would mean
  // deleting while blind to holds.
  const holdVerdict = await ports.anyActiveHold(now).catch(() => null);
  if (holdVerdict === null) {
    ports.log('backup.retention_hold_unavailable', {
      destination,
      impact: 'refusing to delete while legal holds cannot be evaluated',
    });
    return { ...outcome, status: 'failed', error_code: 'legal_hold_unavailable' };
  }

  const planned = planArtifactRetention(candidates, now, holdVerdict.held);
  outcome.skipped_held = planned.filter((p) => p.decision.reason === 'legal_hold').length;
  outcome.unidentified = planned.filter((p) => p.decision.reason === 'no_manifest').length;
  const toDelete = planned.filter((p) => p.decision.action === 'delete');
  outcome.eligible = toDelete.length;

  if (options.dryRun) {
    // Counts only. The row this produces is what an operator compares against
    // expectation before ever arming the executor.
    return outcome;
  }

  for (const { candidate } of toDelete) {
    try {
      await ports.deleteArtifact(candidate);
      if (!(await ports.confirmDeleted(candidate))) {
        outcome.failed += 1;
        ports.log('backup.retention_delete_unconfirmed', {
          backup_id: candidate.backup_id,
          destination,
          impact: 'delete reported success but the artifact is still present',
        });
        continue;
      }
      await ports.markDeleted(candidate.backup_id);
      outcome.deleted += 1;
      await ports.audit('backup_artifact_deleted', {
        backup_id: candidate.backup_id,
        correlation_id: options.correlationId,
        destination,
        // Basename only — never a path or an object URL.
        artifact_ref: candidate.artifact_ref,
        reason: 'expired',
      });
    } catch (err) {
      outcome.failed += 1;
      // First unprocessed artifact defines where a resumed pass restarts.
      outcome.cursor_watermark ??= candidate.delete_after;
      ports.log('backup.retention_delete_failed', {
        backup_id: candidate.backup_id,
        destination,
        error: (err as Error).name,
      });
    }
  }

  // A pass that failed even once is NEVER `completed`. This is the half of the
  // finding about evidence lying.
  if (outcome.failed > 0) {
    outcome.status = outcome.deleted > 0 ? 'partial' : 'failed';
    outcome.error_code = 'delete_failed';
  }
  return outcome;
}

/**
 * Guard for callers: turn a non-conclusive outcome into a throw so a caller
 * cannot accidentally audit success.
 */
export function assertConclusive(outcome: RetentionOutcome): void {
  if (outcome.status !== 'completed') {
    throw new TypedError(
      'retention_not_conclusive',
      `retention pass ended ${outcome.status}`,
      { status: outcome.status, failed: outcome.failed, error_code: outcome.error_code },
    );
  }
}
