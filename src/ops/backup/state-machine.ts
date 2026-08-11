/**
 * Issue #520 — backup lifecycle state machine.
 *
 * The baseline treated "pg_dump exited 0" as success (`src/workers/backup.ts`
 * audited `backup_completed` even when the S3 upload had just failed). That is
 * the core defect this module closes: a backup run now advances through an
 * EXPLICIT, ordered lifecycle and the terminal classification is COMPUTED from
 * the evidence gathered at each stage, never assumed.
 *
 * States (issue §2):
 *   scheduled → running → dump_created → locally_verified
 *              → [encrypted] → [uploaded → remotely_verified]
 *              → completed | completed_degraded | failed
 *   completed / completed_degraded / failed → expired → deleted
 *
 * The machine is PURE (no IO, no config import) so it can be exercised
 * exhaustively in unit tests and reused by both the worker and the CLI.
 */
import { TypedError } from '@/lib/utils.js';

export const BACKUP_STATES = [
  'scheduled',
  'running',
  'dump_created',
  'locally_verified',
  'encrypted',
  'uploaded',
  'remotely_verified',
  'completed',
  'completed_degraded',
  'failed',
  'expired',
  'deleted',
] as const;

export type BackupState = (typeof BACKUP_STATES)[number];

/**
 * Terminal outcome of a run. `completed_degraded` exists precisely so that a
 * local-only run is NEVER reported as a normal success (issue §6): the
 * operator sees a distinct, alertable state instead of a green
 * `backup_completed` that hides a missing off-site copy.
 */
export type BackupOutcome = 'completed' | 'completed_degraded' | 'failed';

/**
 * Legal forward transitions. Encryption and upload are OPTIONAL stages (a
 * profile may not require them), which is why `locally_verified` can fan out
 * to `encrypted`, `uploaded` or straight to a terminal classification.
 *
 * `failed` is reachable from every non-terminal state — any stage can abort.
 * `deleted` is reachable from every terminal state so retention/cleanup can
 * reap both successful artifacts and the partial files left by a failure.
 */
const TRANSITIONS: Readonly<Record<BackupState, readonly BackupState[]>> = Object.freeze({
  scheduled: ['running', 'failed'],
  running: ['dump_created', 'failed'],
  dump_created: ['locally_verified', 'failed'],
  locally_verified: ['encrypted', 'uploaded', 'completed', 'completed_degraded', 'failed'],
  encrypted: ['uploaded', 'completed', 'completed_degraded', 'failed'],
  uploaded: ['remotely_verified', 'completed_degraded', 'failed'],
  remotely_verified: ['completed', 'completed_degraded', 'failed'],
  completed: ['expired', 'deleted'],
  completed_degraded: ['expired', 'deleted'],
  failed: ['deleted'],
  expired: ['deleted'],
  deleted: [],
});

const TERMINAL: ReadonlySet<BackupState> = new Set<BackupState>([
  'completed',
  'completed_degraded',
  'failed',
  'expired',
  'deleted',
]);

export function isBackupState(value: unknown): value is BackupState {
  return typeof value === 'string' && (BACKUP_STATES as readonly string[]).includes(value);
}

export function isTerminalState(state: BackupState): boolean {
  return TERMINAL.has(state);
}

export function canTransition(from: BackupState, to: BackupState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Fail-closed transition guard. A run that tries to skip a stage (e.g. jump
 * from `running` straight to `completed`, which is exactly what the baseline
 * did) throws instead of silently recording a success it never proved.
 */
export function assertTransition(from: BackupState, to: BackupState): void {
  if (!canTransition(from, to)) {
    throw new TypedError(
      'backup_invalid_transition',
      `illegal backup lifecycle transition ${from} → ${to}`,
      { from, to, allowed: TRANSITIONS[from] },
    );
  }
}

/**
 * Evidence gathered during a run. Every field is a FACT the runner observed —
 * never an intention. `classifyOutcome` maps evidence to the terminal state.
 */
export interface BackupEvidence {
  /** `pg_dump` exited 0 AND `pg_restore --list` read the catalog AND size >= floor. */
  locally_verified: boolean;
  /** Profile demands an encrypted artifact. */
  encryption_required: boolean;
  /** The artifact on disk/at rest is actually encrypted. */
  encrypted: boolean;
  /** Profile demands an off-site copy (production). */
  offsite_required: boolean;
  /** An off-site destination is configured at all. */
  offsite_configured: boolean;
  /** Upload was attempted (regardless of result). */
  offsite_attempted: boolean;
  /** Remote checksum/metadata verification succeeded at the destination. */
  offsite_verified: boolean;
}

export interface OutcomeVerdict {
  outcome: BackupOutcome;
  /**
   * Stable, non-sensitive reason code. Safe for logs, metrics labels and
   * `maia doctor` output — carries no path, URL, key or PII.
   */
  reason:
    | 'ok'
    | 'local_verification_failed'
    | 'encryption_required_but_absent'
    | 'offsite_required_but_unverified'
    | 'offsite_upload_failed'
    | 'offsite_not_configured';
}

/**
 * Classify a finished run from its evidence (issue §2/§6 + acceptance
 * criteria "perfil de produção não aceita local-only como sucesso normal" and
 * "falha parcial produz estado não ambíguo").
 *
 * Ordering matters — the checks run most-severe first so the reported reason
 * is the ROOT cause, not the last thing that happened.
 */
export function classifyOutcome(evidence: BackupEvidence): OutcomeVerdict {
  if (!evidence.locally_verified) {
    return { outcome: 'failed', reason: 'local_verification_failed' };
  }
  // A backup that the profile says must be encrypted but is not is a FAILURE,
  // never a degraded success: shipping readable PII off-site is worse than
  // having no backup at all for this run (issue §5 "falha de KMS não gera
  // backup plaintext").
  if (evidence.encryption_required && !evidence.encrypted) {
    return { outcome: 'failed', reason: 'encryption_required_but_absent' };
  }
  if (evidence.offsite_required && !evidence.offsite_verified) {
    return { outcome: 'failed', reason: 'offsite_required_but_unverified' };
  }
  if (evidence.offsite_verified) {
    return { outcome: 'completed', reason: 'ok' };
  }
  // Off-site is NOT required by this profile. Local-only is still not a
  // normal success (issue §6) — it is explicitly degraded so the operator can
  // see the difference between "we have a remote copy" and "we do not".
  if (!evidence.offsite_configured) {
    return { outcome: 'completed_degraded', reason: 'offsite_not_configured' };
  }
  return { outcome: 'completed_degraded', reason: 'offsite_upload_failed' };
}

/**
 * The audit action label for a terminal outcome. Kept next to the machine so
 * a new state cannot be added without deciding how it is audited.
 */
export function outcomeAuditAction(
  outcome: BackupOutcome,
): 'backup_run_completed' | 'backup_run_degraded' | 'backup_run_failed' {
  switch (outcome) {
    case 'completed':
      return 'backup_run_completed';
    case 'completed_degraded':
      return 'backup_run_degraded';
    case 'failed':
      return 'backup_run_failed';
  }
}
