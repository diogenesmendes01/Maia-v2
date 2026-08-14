/**
 * Issue #536 — the restore-drill gate as a scraped signal.
 *
 * `src/ops/backup/rpo.ts` has graded backup readiness since #520, and until now
 * NOTHING in production ever called it: `evaluateBackupReadiness` had zero
 * callers outside its unit test. An evaluator nobody asks is documentation.
 * This collector is the ask.
 *
 * The series that matters here is `maia_restore_drill_check_level` — 0 while a
 * recent drill proves an artifact restorable, 2 once the evidence is older than
 * `BACKUP_RESTORE_DRILL_INTERVAL_HOURS`, older than a failed drill, or (in
 * production) while no drill has ever run.
 *
 * WHY A SCRAPE-TIME COLLECTOR AND NOT A VALUE THE WORKER PUBLISHES. The gate
 * has to be honest about the worker itself. If the drill scheduler
 * (`restore_drill` in `src/workers/index.ts`) is unscheduled, crashed, or
 * deployed to a role that never runs cron, a worker-published gauge would
 * freeze at its last value — green — which is the exact failure this gate
 * exists to catch. Reading the evidence at scrape time means the level goes red
 * as the evidence ages, no matter why nothing refreshed it.
 *
 * WHY NOT /readyz. A stale restore drill does not make THIS replica unable to
 * serve a request, and `/readyz` decides whether the load balancer routes here
 * (`src/runtime/lifecycle/readiness.ts`). Failing it on drill age would take
 * the platform offline over a backup-evidence problem — an outage caused by the
 * monitor. The correct surface for "our recovery posture is not provable" is
 * the operational readiness view: this gauge, plus the alert rule in
 * `monitoring/alerts/backup.rules.yml`, plus the per-tick log line.
 */
import { setGaugeProvider } from '@/lib/metrics.js';
import { logger } from '@/lib/logger.js';
import { redactSecrets } from '@/ops/backup/redaction.js';
import { evaluateBackupReadiness, readinessGauges } from '@/ops/backup/rpo.js';
import type { ResolvedBackupProfile } from '@/ops/backup/profile.js';
import type { DrillEvidenceFacts } from '@/ops/backup/drill-schedule.js';

/**
 * Snapshot window. Every series below shares one read, so a scrape costs one
 * round of queries regardless of how many gauges are registered — same reason
 * `turn-state-collector.ts` caches.
 */
const SNAPSHOT_TTL_MS = 30_000;

/**
 * Level values, mirroring `readinessGauges`. `2` (FAIL) is the value used when
 * the evidence CANNOT BE READ — see `refresh`.
 */
const UNKNOWN_IS_FAIL = 2;

/** Sentinel for an age/duration that was never measured. See `OPTIONAL_SERIES`. */
const NEVER_MEASURED = -1;

export interface BackupReadinessCollectorDeps {
  now: () => Date;
  readFacts: () => Promise<DrillEvidenceFacts>;
  /** May be async so the caller can import the config projection lazily. */
  resolveProfile: () => ResolvedBackupProfile | Promise<ResolvedBackupProfile>;
}

let snapshot: Record<string, number> | null = null;
let lastRefreshAt = 0;
let inFlight: Promise<void> | null = null;
let registered = false;

/**
 * Recompute the gauge set, at most once per window.
 *
 * FAIL-CLOSED, and this is where this collector deliberately differs from
 * `turn-state-collector.ts`. That one keeps its last snapshot when a refresh
 * fails, because a stale turn count is better than a 500 on `/metrics`. Here
 * the snapshot IS a safety verdict: keeping the last known-good value would
 * report "a backup is known to be restorable" on the strength of a read that
 * did not happen. A failed refresh drops the snapshot, and the providers fall
 * back to FAIL.
 */
async function refresh(deps: BackupReadinessCollectorDeps): Promise<void> {
  // The window is measured on the INJECTED clock, the same one the verdict is
  // computed against — a test can then advance time and prove that a refresh
  // which fails drops the previous verdict instead of re-serving it.
  const nowMs = deps.now().getTime();
  if (snapshot !== null && nowMs - lastRefreshAt < SNAPSHOT_TTL_MS) return;
  if (inFlight) return inFlight;
  lastRefreshAt = nowMs;
  inFlight = (async () => {
    try {
      const profile = await deps.resolveProfile();
      const facts = await deps.readFacts();
      snapshot = readinessGauges(
        evaluateBackupReadiness({ now: deps.now(), profile, ...facts }),
      );
    } catch (err) {
      snapshot = null;
      // Redacted: a driver error can carry the connection URL with the password.
      logger.warn(
        { error: redactSecrets((err as Error).message) },
        'backup_readiness_collector.refresh_failed',
      );
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Series that must exist on EVERY scrape, with the value they take when the
 * evidence could not be read. A missing series is ambiguous — "not wired" and
 * "nothing to report" look identical to Prometheus — so both gates always
 * report, and they report the pessimistic value.
 */
const ALWAYS_EMITTED = ['maia_backup_readiness_level', 'maia_restore_drill_check_level'] as const;

/**
 * Age/duration series. `backupReadinessGaugeSnapshot` OMITS them when nothing
 * was ever measured; a registered Prometheus gauge cannot be omitted, so on
 * `/metrics` they carry `NEVER_MEASURED` instead.
 *
 * The sentinel is negative on purpose. `0` would read as "measured, and it just
 * happened" — the most dangerous possible lie for an age — and a large positive
 * value would trip every `> threshold` alert with a fabricated number. A
 * negative age is impossible, so it is unambiguous to a human and inert to
 * every alert written the natural way. The gate lives in `ALWAYS_EMITTED`
 * above, never in these.
 */
const OPTIONAL_SERIES = [
  'maia_backup_age_seconds',
  'maia_restore_drill_age_seconds',
  'maia_restore_drill_duration_seconds',
] as const;

/** Compute the current gauge set without registering anything (tests, doctor). */
export async function backupReadinessGaugeSnapshot(
  deps: BackupReadinessCollectorDeps,
): Promise<Record<string, number>> {
  await refresh(deps);
  const current = snapshot;
  const out: Record<string, number> = {};
  for (const name of ALWAYS_EMITTED) out[name] = current?.[name] ?? UNKNOWN_IS_FAIL;
  for (const name of OPTIONAL_SERIES) {
    const v = current?.[name];
    if (typeof v === 'number') out[name] = v;
  }
  return out;
}

/**
 * Register the backup-readiness gauges. Idempotent (providers are keyed by
 * series name, so a second call would replace rather than stack; the flag keeps
 * repeated `buildServer()` cycles in tests from re-reading the config).
 */
export function registerBackupReadinessGauges(deps: BackupReadinessCollectorDeps): void {
  if (registered) return;
  for (const name of ALWAYS_EMITTED) {
    setGaugeProvider(name, async () => {
      await refresh(deps);
      return snapshot?.[name] ?? UNKNOWN_IS_FAIL;
    });
  }
  for (const name of OPTIONAL_SERIES) {
    setGaugeProvider(name, async () => {
      await refresh(deps);
      return snapshot?.[name] ?? NEVER_MEASURED;
    });
  }
  registered = true;
}

/** Reset for tests — module state survives between cases. */
export function _resetBackupReadinessCollectorForTests(): void {
  snapshot = null;
  lastRefreshAt = 0;
  inFlight = null;
  registered = false;
}
