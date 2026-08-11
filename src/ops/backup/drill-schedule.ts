/**
 * Issue #536 — the restore drill SCHEDULE, and the gate that reproves when the
 * drill's evidence ages out.
 *
 * WHAT THE BASELINE DID. `drill.ts` (#541) made the drill real and honest, and
 * `runRestoreDrillJob` (`src/workers/backup.ts`) made it callable — but NOTHING
 * called it on a schedule. The runbook said, in prose, "o drill não está no
 * cron por decisão […] agende-o pelo cron do host". At the same time
 * `evaluateBackupReadiness` (`rpo.ts`) had ZERO production callers: the
 * evaluator that grades drill age existed and nobody ever asked it. So
 * `BACKUP_RESTORE_DRILL_INTERVAL_HOURS` was a number nothing honoured and
 * nothing enforced — documentation, not a control.
 *
 * WHAT THE INTERVAL MEANS. `BACKUP_RESTORE_DRILL_INTERVAL_HOURS` is the MAXIMUM
 * ACCEPTABLE AGE OF THE EVIDENCE. It is not a cron expression and it does not
 * schedule an execution. That distinction is the whole design of this module:
 *
 *   - the WORKER wakes on a fixed, frequent tick (hourly — see
 *     `src/workers/index.ts` and `DRILL_TICK_HOURS`), which has nothing to do
 *     with the interval;
 *   - each tick asks THIS module whether the evidence in `restore_drills` is
 *     close enough to expiring that a new drill should start now;
 *   - a tick that finds fresh evidence does NOTHING. The drill is expensive —
 *     it downloads a multi-gigabyte artifact, decrypts it into a full plaintext
 *     copy of every tenant's data, and creates and drops a database — so
 *     re-running it because a clock ticked would be both wasteful and, while it
 *     runs, a standing exposure.
 *
 * WHY 75%. The drill becomes due at `DRILL_DUE_FRACTION` of the interval, the
 * same fraction `rpo.ts` uses to raise its early WARN. So the drill starts at
 * the exact moment readiness first turns amber and has the remaining 25% of the
 * budget to finish — the evidence is refreshed BEFORE the check would go red,
 * which is what "the interval is honoured" has to mean operationally.
 *
 * PURE. No DB, no config singleton, no clock. `runRestoreDrillTick` orchestrates
 * over injected ports exactly like `runVerifiedBackup` and `runRestoreDrill`, so
 * every branch below — including the adversarial ones — is exercised without
 * Postgres, S3 or a `pg_restore` binary.
 */
import type { ResolvedBackupProfile } from './profile.js';
import { redactSecrets } from './redaction.js';
import {
  drillCheckLevel,
  evaluateBackupReadiness,
  type BackupReadinessInput,
  type ReadinessLevel,
} from './rpo.js';

/**
 * Fraction of the interval after which a drill becomes due.
 *
 * Deliberately the same 0.75 as `rpo.ts`'s `WARN_FRACTION`: the scheduler fires
 * when the readiness check first warns, so a drill of normal duration lands
 * well before the check would FAIL. Raising this shrinks the safety margin;
 * lowering it re-runs an expensive job for no extra evidence.
 */
export const DRILL_DUE_FRACTION = 0.75;

/**
 * Fraction of the interval after which a FAILED drill is retried.
 *
 * A failed drill is not just stale evidence — it is a live "nothing is known to
 * be restorable" verdict, and a good share of the ways a drill fails are
 * transient (an S3 blip, a host that was out of disk for an hour). Waiting the
 * full 75% before trying again would hold the platform in FAIL for days over a
 * blip. Retrying every tick, on the other hand, would hammer a genuinely broken
 * pipeline with an expensive job — so the retry is its own, much shorter window
 * (a weekly interval retries in ~21h, a daily one in ~3h) and never faster.
 */
export const DRILL_RETRY_FRACTION = 0.125;

/**
 * The tick cadence the worker registry uses, in hours (`40 * * * *`). Declared
 * here so the honourability floor below is derived from it rather than from a
 * number someone has to remember to keep in sync.
 */
export const DRILL_TICK_HOURS = 1;

/**
 * Shortest interval this schedule can actually HONOUR.
 *
 * The margin between "due" and "expired" is 25% of the interval, and the tick
 * only wakes every `DRILL_TICK_HOURS`. So the worst case from becoming due to a
 * drill finishing is one tick plus one drill duration, and the interval can be
 * honoured only while that fits in the margin. At 6h the margin is 90 minutes —
 * a tick plus a drill of half an hour.
 *
 * `BACKUP_RESTORE_DRILL_INTERVAL_HOURS` accepts any positive integer, so an
 * operator CAN configure 2h. The scheduler does not silently pretend to honour
 * it: the tick says so, every tick, and the gate still goes red when the
 * evidence expires. Refusing the value outright would be a change to the config
 * contract, which is not this module's call.
 */
export const MIN_HONOURABLE_INTERVAL_HOURS = DRILL_TICK_HOURS * 6;

/**
 * Terminal cleanup verdicts as persisted in `restore_drills.cleanup_status`.
 * `unknown` is the state of a row whose process died before it could check —
 * "residue possible, nobody looked" (see `drill.ts`).
 */
export type DrillCleanupStatusFact = 'clean' | 'unsafe' | 'unknown';

/**
 * The evidence a scheduling decision and a readiness verdict are computed from.
 * Structurally the `readReadinessFacts()` row set (`ops-repos.ts`), declared
 * here so this module does not depend on the DB layer.
 */
export interface DrillEvidenceFacts extends Omit<BackupReadinessInput, 'now' | 'profile'> {
  /**
   * Teardown verdict of the most recent terminal drill. `null` when no drill
   * has ever reached a terminal state.
   */
  last_restore_drill_cleanup_status: DrillCleanupStatusFact | null;
}

export type RestoreDrillDueReason =
  /** Backups are off by configuration — there is nothing to drill. */
  | 'backups_disabled'
  /** The previous drill left (or may have left) a copy of production behind. */
  | 'residue_blocks_drill'
  /** No drill has ever reached a terminal state. */
  | 'never_ran'
  /** The last drill is old enough that the evidence is about to expire. */
  | 'evidence_stale'
  /** The last drill FAILED and its (shorter) retry window has elapsed. */
  | 'retry_after_failure'
  /** Recent enough — this tick does nothing. */
  | 'evidence_fresh';

export interface RestoreDrillScheduleInput {
  now: Date;
  profile: ResolvedBackupProfile;
  last_restore_drill_at: Date | null;
  last_restore_drill_result: 'passed' | 'failed' | null;
  last_restore_drill_cleanup_status: DrillCleanupStatusFact | null;
}

export interface RestoreDrillScheduleDecision {
  due: boolean;
  reason: RestoreDrillDueReason;
  /** Age of the newest terminal drill; `null` when none has ever run. */
  evidence_age_seconds: number | null;
  /** Age at which a drill becomes due (75% of the budget, 12.5% after a failure). */
  due_after_seconds: number;
  /** `BACKUP_RESTORE_DRILL_INTERVAL_HOURS` in seconds — the max acceptable age. */
  max_age_seconds: number;
  /**
   * The evidence is already PAST its maximum acceptable age, or there is none.
   * This is the gate condition, and it is deliberately true for "never ran":
   * absence of evidence is not evidence of a restorable backup.
   */
  evidence_expired: boolean;
}

function ageSeconds(now: Date, then: Date | null): number | null {
  if (then === null) return null;
  return Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
}

/**
 * Should a drill start now?
 *
 * FAIL-CLOSED in both directions, which are not the same direction:
 *  - never having run makes a drill DUE and the evidence EXPIRED. A platform
 *    that never drilled is not a platform whose backups are fine;
 *  - a previous drill that could not prove its own teardown BLOCKS the next
 *    one. The drill is the single job that materialises a decrypted copy of
 *    every tenant's data; starting another one while the last one's copy is
 *    (or may be) still on the host multiplies the exposure instead of proving
 *    anything. The evidence stays expired and readiness stays red — the
 *    operator is not being told everything is fine, they are being told to go
 *    clean the host first (runbook §4.2).
 */
export function restoreDrillDue(
  input: RestoreDrillScheduleInput,
): RestoreDrillScheduleDecision {
  const maxAge = Math.round(input.profile.objectives.restoreDrillIntervalHours * 3600);
  const age = ageSeconds(input.now, input.last_restore_drill_at);
  const failed = input.last_restore_drill_result === 'failed';
  const dueAfter = Math.round(maxAge * (failed ? DRILL_RETRY_FRACTION : DRILL_DUE_FRACTION));
  const expired = age === null || age > maxAge;

  const base = {
    evidence_age_seconds: age,
    due_after_seconds: dueAfter,
    max_age_seconds: maxAge,
    evidence_expired: expired,
  };

  if (!input.profile.enabled) {
    // `evaluateBackupReadiness` reports disabled backups as WARN and stops
    // there; the scheduler agrees and runs nothing. `runRestoreDrill` would
    // return `skipped` anyway, and a `skipped` row is not evidence.
    return { ...base, due: false, reason: 'backups_disabled' };
  }

  if (input.last_restore_drill_cleanup_status === 'unsafe') {
    return { ...base, due: false, reason: 'residue_blocks_drill' };
  }

  if (age === null) return { ...base, due: true, reason: 'never_ran' };
  if (age < dueAfter) return { ...base, due: false, reason: 'evidence_fresh' };
  return { ...base, due: true, reason: failed ? 'retry_after_failure' : 'evidence_stale' };
}

/** Outcome of the drill invocation, as `runRestoreDrillJob` reports it. */
export type DrillInvocation =
  | { status: 'already_running' }
  | { status: 'ran'; drill_status: 'passed' | 'failed' | 'skipped' };

export interface RestoreDrillTickPorts {
  now(): Date;
  /** Evidence from `restore_drills` + `backup_runs`. May reject. */
  readFacts(): Promise<DrillEvidenceFacts>;
  /** Run ONE drill under the global `restore_drill` advisory lock. May reject. */
  runDrill(): Promise<DrillInvocation>;
  log(level: 'info' | 'warn' | 'error', event: string, detail: Record<string, unknown>): void;
}

export type RestoreDrillTickOutcome =
  | 'ran'
  | 'already_running'
  | 'not_due'
  | 'evidence_unreadable'
  | 'error';

export interface RestoreDrillTickResult {
  outcome: RestoreDrillTickOutcome;
  decision: RestoreDrillScheduleDecision;
  /** Level of the `restore_drill_age` readiness check — THE gate verdict. */
  drill_check_level: ReadinessLevel;
  /** Level of the whole backup readiness view. */
  readiness_level: ReadinessLevel;
}

/**
 * One scheduler tick: grade the evidence, then drill if (and only if) the
 * evidence needs refreshing.
 *
 * The GRADING happens on every tick, before and independently of any decision
 * to run — that is what makes this a gate rather than a job. A tick that cannot
 * even READ the evidence reports FAIL and drills nothing: an unreadable
 * `restore_drills` is not proof of a fresh drill, and the drill itself needs
 * the same database.
 *
 * Nothing thrown from a port reaches a log unredacted. `pg_restore` and
 * `pg_dump` echo the connection URL — password included — on a connection
 * failure (issue #520's real leak), and a drill error can carry the same
 * string, so every message here goes through `redactSecrets` first.
 */
export async function runRestoreDrillTick(
  ports: RestoreDrillTickPorts,
  profile: ResolvedBackupProfile,
): Promise<RestoreDrillTickResult> {
  const now = ports.now();

  let facts: DrillEvidenceFacts;
  try {
    facts = await ports.readFacts();
  } catch (err) {
    ports.log('error', 'restore_drill.evidence_unreadable', {
      error: redactSecrets((err as Error).message),
      impact: 'cannot prove any backup is restorable; treating the gate as FAILED',
    });
    const unknown: RestoreDrillScheduleDecision = {
      due: false,
      reason: 'never_ran',
      evidence_age_seconds: null,
      due_after_seconds: 0,
      max_age_seconds: Math.round(profile.objectives.restoreDrillIntervalHours * 3600),
      evidence_expired: true,
    };
    return {
      outcome: 'evidence_unreadable',
      decision: unknown,
      drill_check_level: 'FAIL',
      readiness_level: 'FAIL',
    };
  }

  const readiness = evaluateBackupReadiness({ now, profile, ...facts });
  const checkLevel = drillCheckLevel(readiness);
  const decision = restoreDrillDue({
    now,
    profile,
    last_restore_drill_at: facts.last_restore_drill_at,
    last_restore_drill_result: facts.last_restore_drill_result,
    last_restore_drill_cleanup_status: facts.last_restore_drill_cleanup_status,
  });

  if (profile.objectives.restoreDrillIntervalHours < MIN_HONOURABLE_INTERVAL_HOURS) {
    // Said out loud rather than assumed away: the operator asked for an
    // evidence age this schedule cannot guarantee, and the gate will flap red
    // between drills as a result. That is a configuration problem, not a drill
    // problem, and the log is where the two get told apart.
    ports.log('warn', 'restore_drill.interval_below_tick_floor', {
      interval_hours: profile.objectives.restoreDrillIntervalHours,
      tick_hours: DRILL_TICK_HOURS,
      min_honourable_interval_hours: MIN_HONOURABLE_INTERVAL_HOURS,
      impact:
        'the scheduler cannot guarantee evidence stays inside this interval; ' +
        'raise BACKUP_RESTORE_DRILL_INTERVAL_HOURS or drill from the host cron',
    });
  }

  const verdict = {
    gate: checkLevel,
    readiness: readiness.level,
    reason: decision.reason,
    evidence_age_seconds: decision.evidence_age_seconds,
    max_age_seconds: decision.max_age_seconds,
    due_after_seconds: decision.due_after_seconds,
    last_result: facts.last_restore_drill_result,
    cleanup_status: facts.last_restore_drill_cleanup_status,
  };

  // The verdict is logged on EVERY tick, at a level that matches it. An expired
  // gate that only ever shows up as a Prometheus series is invisible to whoever
  // is reading logs during an incident.
  if (checkLevel === 'FAIL') {
    ports.log('error', 'restore_drill.evidence_expired', verdict);
  } else if (checkLevel === 'WARN') {
    ports.log('warn', 'restore_drill.evidence_aging', verdict);
  } else {
    ports.log('info', 'restore_drill.evidence_ok', verdict);
  }

  const result = (outcome: RestoreDrillTickOutcome): RestoreDrillTickResult => ({
    outcome,
    decision,
    drill_check_level: checkLevel,
    readiness_level: readiness.level,
  });

  if (!decision.due) {
    if (decision.reason === 'residue_blocks_drill') {
      ports.log('error', 'restore_drill.blocked_by_residue', {
        ...verdict,
        impact:
          'the previous drill could not prove it removed the decrypted copy it made; ' +
          'refusing to start another until the host is cleaned (runbook §4.2)',
      });
    }
    return result('not_due');
  }

  let invocation: DrillInvocation;
  try {
    invocation = await ports.runDrill();
  } catch (err) {
    // A drill that threw left no verdict of its own. It is NOT a pass.
    ports.log('error', 'restore_drill.tick_failed', {
      error: redactSecrets((err as Error).message),
      reason: decision.reason,
    });
    return result('error');
  }

  if (invocation.status === 'already_running') {
    // Single-flight: another tick, the CLI, or a replica holds the lock. This
    // tick starts nothing and reports nothing new — the drill in flight owns
    // the evidence it is about to write.
    ports.log('info', 'restore_drill.tick_already_running', { reason: decision.reason });
    return result('already_running');
  }

  ports.log(
    invocation.drill_status === 'passed' ? 'info' : 'error',
    'restore_drill.tick_completed',
    { reason: decision.reason, drill_status: invocation.drill_status },
  );
  return result('ran');
}
