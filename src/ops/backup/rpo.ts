/**
 * Issue #520 §8 — measurable RPO/RTO and operational readiness.
 *
 * Baseline gap: there was no objective at all. `docs/runbooks/operational.md`
 * acknowledged a "janela de perda de até 24 horas" in prose, and nothing
 * computed the age of the last RESTORABLE backup, so an operator could not
 * answer "are we within our recovery objective right now?" without SSHing to
 * the host and listing a directory.
 *
 * This module is PURE: it takes the facts (timestamps read from `backup_runs`
 * and `restore_drills`) and the profile, and returns a verdict with EVIDENCE
 * and REMEDIATION for each check — the shape `maia doctor` and the readiness
 * endpoint both render.
 *
 * Two rules it will not bend:
 *  - "Backup exists" is never the same as "backup is restorable". A run that
 *    was never verified does not count toward the RPO.
 *  - The platform never reports OK for an objective it cannot meet.
 */
import { METRIC } from '@/observability/taxonomy.js';
import type { ResolvedBackupProfile } from './profile.js';

export type ReadinessLevel = 'OK' | 'WARN' | 'FAIL';

export interface ReadinessCheck {
  /** Stable id — safe as a metric label (low cardinality). */
  id: string;
  level: ReadinessLevel;
  /** Non-sensitive facts behind the verdict. No path, URL, key or PII. */
  evidence: Record<string, number | string | boolean | null>;
  /** What the operator must do. Never quotes a secret value. */
  remediation: string;
}

export interface BackupReadinessInput {
  now: Date;
  profile: ResolvedBackupProfile;
  /** Last run whose LOCAL checksum + catalog were verified. */
  last_local_verified_at: Date | null;
  /** Last run whose OFF-SITE copy was verified at the destination. */
  last_offsite_verified_at: Date | null;
  last_restore_drill_at: Date | null;
  last_restore_drill_result: 'passed' | 'failed' | null;
  /**
   * Start time of the OLDEST restore drill that never reached a terminal state
   * — `null` when there is none (issue #536, owner review of #553).
   *
   * A drill whose process died between `createDrill` and `finishDrill` leaves
   * `status='running'` / `cleanup_status='unknown'`, which `drill.ts` defines
   * as "residue possible, nobody checked". Grading only TERMINAL rows made that
   * state invisible: readiness reported OK while a decrypted copy of every
   * tenant's data might be sitting on the host. It is a fact of the readiness
   * verdict for the same reason `last_restore_drill_result` is.
   */
  open_restore_drill_started_at: Date | null;
  /** Duration of the last passing drill — the measured RTO contribution. */
  last_restore_drill_duration_ms: number | null;
  /** Consecutive failed runs since the last success. */
  consecutive_failures: number;
}

export interface BackupReadiness {
  level: ReadinessLevel;
  checks: ReadinessCheck[];
  /** Age in seconds of the newest RESTORABLE artifact; null when none exists. */
  measured_rpo_seconds: number | null;
  /** Duration of the last successful restore drill; null when never measured. */
  measured_rto_seconds: number | null;
}

const HOUR_MS = 3_600_000;

/** Early-warning threshold: warn at 75% of the budget, before the violation. */
const WARN_FRACTION = 0.75;

/**
 * Floor under the abandonment cutoff. A development/test profile can set the
 * stage budgets to milliseconds; without a floor, a drill that is legitimately
 * running would be declared a corpse seconds after it started, and the gate
 * would block the very execution that is about to refresh it.
 */
const ABANDONED_DRILL_FLOOR_MS = 3_600_000;

/**
 * How old a NON-TERMINAL `restore_drills` row has to be before it is a corpse
 * rather than a drill in flight (issue #536, owner review of #553).
 *
 * The rule mirrors `reclaimAbandonedRuns` (`src/workers/backup.ts`), which uses
 * TWICE the dump budget for the same judgement on `backup_runs`: past twice the
 * budget, no legitimate execution could still be running, so what is left is
 * debris from a process that died. Here the drill's budget is the sum of the
 * two stages the profile actually bounds — the transfer (`uploadMs`, the only
 * knob for the S3 leg; the download itself is NOT separately time-boxed) and
 * `pg_restore` (`restoreMs`). With the shipped defaults that is 2 × (30min +
 * 1h) = 3h.
 *
 * WHY THE DISTINCTION EXISTS AT ALL, given that both states block: an operator
 * paged at 03:00 has to know whether to wait (a drill IS running) or to go look
 * at the host (a drill died holding a plaintext copy). Collapsing them would
 * make the second one indistinguishable from normal operation.
 */
export function abandonedDrillAfterMs(profile: ResolvedBackupProfile): number {
  return Math.max(
    ABANDONED_DRILL_FLOOR_MS,
    2 * (profile.timeouts.uploadMs + profile.timeouts.restoreMs),
  );
}

function ageSeconds(now: Date, then: Date | null): number | null {
  if (then === null) return null;
  return Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
}

function worst(levels: readonly ReadinessLevel[]): ReadinessLevel {
  if (levels.includes('FAIL')) return 'FAIL';
  if (levels.includes('WARN')) return 'WARN';
  return 'OK';
}

/**
 * Age check against a budget, with an early warning before the violation
 * (issue §"RPO/RTO": "alertas ocorrem antes/depois da violação conforme
 * política").
 */
function gradeAge(
  age: number | null,
  budgetSeconds: number,
  missingLevel: ReadinessLevel,
): ReadinessLevel {
  if (age === null) return missingLevel;
  if (age > budgetSeconds) return 'FAIL';
  if (age > budgetSeconds * WARN_FRACTION) return 'WARN';
  return 'OK';
}

export function evaluateBackupReadiness(input: BackupReadinessInput): BackupReadiness {
  const { now, profile } = input;
  const checks: ReadinessCheck[] = [];

  const rpoSeconds = profile.objectives.rpoHours * 3600;
  const localAge = ageSeconds(now, input.last_local_verified_at);
  const offsiteAge = ageSeconds(now, input.last_offsite_verified_at);
  const drillAge = ageSeconds(now, input.last_restore_drill_at);

  // ── 1. Backups disabled ────────────────────────────────────────────────
  if (!profile.enabled) {
    checks.push({
      id: 'backup_enabled',
      // Disabled backups in production are already rejected at boot; anywhere
      // else this is a deliberate operator choice, so WARN and move on.
      level: 'WARN',
      evidence: { profile: profile.name, enabled: false },
      remediation: 'Backups are disabled (BACKUP_ENABLED=false). No recovery point is being produced.',
    });
    return {
      level: 'WARN',
      checks,
      measured_rpo_seconds: null,
      measured_rto_seconds: null,
    };
  }

  // ── 2. Local recovery point ────────────────────────────────────────────
  checks.push({
    id: 'backup_age_local',
    level: gradeAge(localAge, rpoSeconds, 'FAIL'),
    evidence: {
      age_seconds: localAge,
      rpo_target_seconds: rpoSeconds,
      // "Verified" is what counts — an unverified dump is not a recovery point.
      verified: localAge !== null,
    },
    remediation:
      localAge === null
        ? 'No locally-verified backup exists. Run `npm run backup` and inspect the failure — an unverified dump is not a recovery point.'
        : 'The newest verified local backup is older than the RPO target. Check the nightly job and the disk.',
  });

  // ── 3. Off-site recovery point ─────────────────────────────────────────
  if (profile.offsite.required) {
    checks.push({
      id: 'backup_age_offsite',
      level: gradeAge(offsiteAge, rpoSeconds, 'FAIL'),
      evidence: {
        age_seconds: offsiteAge,
        rpo_target_seconds: rpoSeconds,
        required: true,
        configured: profile.offsite.configured,
      },
      remediation:
        offsiteAge === null
          ? 'This profile requires an off-site copy and none has ever been verified. Losing the host would take the only artifact with it.'
          : 'The newest verified off-site backup is older than the RPO target. Check destination credentials and connectivity.',
    });
  } else if (profile.offsite.configured) {
    checks.push({
      id: 'backup_age_offsite',
      // Not required by this profile, so a stale remote copy is a warning —
      // but "no remote copy at all" is still never OK.
      level: offsiteAge === null ? 'WARN' : gradeAge(offsiteAge, rpoSeconds, 'WARN'),
      evidence: { age_seconds: offsiteAge, rpo_target_seconds: rpoSeconds, required: false },
      remediation:
        'An off-site destination is configured but its copy is stale or missing. Runs are completing DEGRADED, not OK.',
    });
  } else {
    checks.push({
      id: 'backup_age_offsite',
      level: 'WARN',
      evidence: { age_seconds: null, required: false, configured: false },
      remediation:
        'No off-site destination is configured. Every run completes DEGRADED by design in this profile; a host loss is unrecoverable.',
    });
  }

  // ── 4. Restore drill (the only proof a backup is restorable) ───────────
  const drillBudget = profile.objectives.restoreDrillIntervalHours * 3600;
  // An execution that never reached a terminal state and is too old to still
  // be in flight (issue #536, owner review of #553). It is graded on the SAME
  // check as drill age, not a new one, because it answers the same question —
  // "is any backup known to be restorable right now?" — and because
  // `drillCheckLevel` (hence `maia_restore_drill_check_level` and the alert in
  // `monitoring/alerts/backup.rules.yml`) reads exactly this id. A separate
  // check would have been a second gate nobody alerts on.
  const openDrillAge = ageSeconds(now, input.open_restore_drill_started_at);
  const abandonedDrill =
    openDrillAge !== null && openDrillAge * 1000 >= abandonedDrillAfterMs(profile);
  const drillLevel: ReadinessLevel = abandonedDrill
    ? 'FAIL'
    : input.last_restore_drill_result === 'failed'
      ? 'FAIL'
      : gradeAge(drillAge, drillBudget, profile.name === 'production' ? 'FAIL' : 'WARN');
  checks.push({
    id: 'restore_drill_age',
    level: drillLevel,
    evidence: {
      age_seconds: drillAge,
      interval_target_seconds: drillBudget,
      last_result: input.last_restore_drill_result,
      open_drill_age_seconds: openDrillAge,
      abandoned_drill: abandonedDrill,
    },
    remediation: abandonedDrill
      ? // Deliberately ahead of the "last drill FAILED" wording below: this
        // state is not a verdict about an artifact, it is a possible copy of
        // production data on the host that NOBODY has checked. The remediation
        // is a host inspection, not a re-drill.
        'A restore drill never reached a terminal state and is too old to still be running: ' +
        'its process died with a decrypted copy of production possibly still on the host, and ' +
        'nothing has proven the teardown. Inspect the host and terminalize the row before ' +
        'another drill may start (runbook §4.2).'
      :
      input.last_restore_drill_result === 'failed'
        ? // Readiness grades on `status` alone, which is deliberately
          // conservative: a drill that restored perfectly but left a copy of
          // production on the host is `failed` too (`cleanup_failed`), and it
          // is not a certification either. `restore_drills.failure_code` +
          // `cleanup_status` say which of the two happened — and they ask for
          // opposite actions, so the operator must read the row.
          'The last restore drill FAILED. Read restore_drills: `failure_code` says whether nothing is known to be restorable, or the artifact IS restorable and the drill left a copy of production data on the host (`cleanup_failed` / `cleanup_status=unsafe`, runbook §4.1).'
        : drillAge === null
          ? 'No restore drill has ever run. Run `npm run restore:test` in an isolated environment.'
          : 'The last successful restore drill is older than the configured interval.',
  });

  // ── 5. Consecutive failures ────────────────────────────────────────────
  checks.push({
    id: 'backup_consecutive_failures',
    level:
      input.consecutive_failures >= 3 ? 'FAIL' : input.consecutive_failures >= 1 ? 'WARN' : 'OK',
    evidence: { consecutive_failures: input.consecutive_failures },
    remediation:
      'Consecutive backup failures. Inspect `backup_runs.error_code` for the most recent runs (the message is a stable code, not raw stderr).',
  });

  // ── 6. Encryption posture ──────────────────────────────────────────────
  checks.push({
    id: 'backup_encryption',
    level: profile.encryption.required && !profile.encryption.keyConfigured ? 'FAIL' : 'OK',
    evidence: {
      mode: profile.encryption.mode,
      required: profile.encryption.required,
      key_configured: profile.encryption.keyConfigured,
      // Identifier only — never key material.
      active_key_id: profile.encryption.activeKeyId,
    },
    remediation:
      'Encryption is required but no usable key is configured. Runs will FAIL closed rather than writing a plaintext dump.',
  });

  // ── 7. Objective feasibility ───────────────────────────────────────────
  // Never advertise an RPO the architecture cannot honour (§8).
  checks.push({
    id: 'rpo_feasibility',
    level: profile.objectives.rpoHours < 24 ? 'FAIL' : 'OK',
    evidence: { rpo_target_hours: profile.objectives.rpoHours, dump_cadence_hours: 24 },
    remediation:
      'The configured RPO is shorter than the nightly dump cadence. Either raise the target or land PITR/WAL archiving — do not advertise an objective the architecture cannot meet.',
  });

  // The RPO we can actually claim is driven by the copy the profile treats as
  // authoritative: off-site when it is required, local otherwise.
  const authoritativeAge = profile.offsite.required ? offsiteAge : (localAge ?? offsiteAge);

  return {
    level: worst(checks.map((c) => c.level)),
    checks,
    measured_rpo_seconds: authoritativeAge,
    measured_rto_seconds:
      input.last_restore_drill_result === 'passed' && input.last_restore_drill_duration_ms !== null
        ? Math.round(input.last_restore_drill_duration_ms / 1000)
        : null,
  };
}

/**
 * Is the measured RTO within the target? Returns null when no passing drill
 * has ever measured it — "unknown" is deliberately distinct from "within".
 */
export function rtoWithinTarget(
  readiness: BackupReadiness,
  profile: ResolvedBackupProfile,
): boolean | null {
  if (readiness.measured_rto_seconds === null) return null;
  return readiness.measured_rto_seconds <= profile.objectives.rtoMinutes * 60;
}

/**
 * Level of the `restore_drill_age` check — the restore-drill gate verdict on
 * its own, separated from the aggregate so a scheduler and a metric can both
 * read it without re-deriving the check id.
 *
 * The check is absent from exactly one verdict: the short-circuit for disabled
 * backups, which stops after `backup_enabled`. There the overall level (WARN)
 * IS the answer — nothing is drilled because nothing is backed up, and that
 * degradation is already reported.
 */
export function drillCheckLevel(readiness: BackupReadiness): ReadinessLevel {
  return readiness.checks.find((c) => c.id === 'restore_drill_age')?.level ?? readiness.level;
}

const LEVEL_VALUE: Record<ReadinessLevel, number> = { OK: 0, WARN: 1, FAIL: 2 };

/**
 * Gauge values for `/metrics`.
 *
 * Deliberately label-free apart from `destination` (issue §"Observabilidade":
 * "evitar labels de alta cardinalidade como tenant, agent, backup ID, request
 * ID, telefone ou object key").
 *
 * Every series name comes from `METRIC` (`src/observability/taxonomy.ts`), so
 * the alert rules' drift guard (`tests/unit/observability/slo-rules.spec.ts`)
 * can prove that what `monitoring/alerts/backup.rules.yml` queries is what this
 * function emits — the failure mode that made issue #541's review: an alert
 * pointing at a series nobody emits looks like coverage and fires never.
 *
 * `maia_restore_drill_check_level` is the RESTORE-DRILL GATE (issue #536): 0
 * while a recent drill proves an artifact restorable, 2 once the evidence is
 * past `BACKUP_RESTORE_DRILL_INTERVAL_HOURS`, past a failed drill, or — in
 * production — while no drill has ever run. It is ALWAYS emitted, including
 * when nothing has ever been measured, precisely because "never drilled" is the
 * state that must not read as green: a missing series would be indistinguishable
 * from a collector that is not wired.
 */
export function readinessGauges(readiness: BackupReadiness): Record<string, number> {
  const out: Record<string, number> = {
    [METRIC.BACKUP_READINESS_LEVEL]: LEVEL_VALUE[readiness.level],
    [METRIC.RESTORE_DRILL_CHECK_LEVEL]: LEVEL_VALUE[drillCheckLevel(readiness)],
  };
  if (readiness.measured_rpo_seconds !== null) {
    out[METRIC.BACKUP_AGE_SECONDS] = readiness.measured_rpo_seconds;
  }
  if (readiness.measured_rto_seconds !== null) {
    out[METRIC.RESTORE_DRILL_DURATION_SECONDS] = readiness.measured_rto_seconds;
  }
  // Age of the newest terminal drill. Omitted when none ever ran — the gate
  // level above carries that case; a sentinel age would be a lie either way
  // (0 reads as "just drilled", a huge number as "drilled long ago"). The
  // collector, which cannot omit a registered series, renders `-1` instead.
  const drillAge = readiness.checks.find((c) => c.id === 'restore_drill_age')?.evidence
    .age_seconds;
  if (typeof drillAge === 'number') out[METRIC.RESTORE_DRILL_AGE_SECONDS] = drillAge;
  return out;
}

/** Milliseconds → whole hours, for humans reading a runbook. */
export function hoursBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / HOUR_MS;
}
