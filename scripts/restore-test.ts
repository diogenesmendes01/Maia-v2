/**
 * `npm run restore:test` — issue #536 §1.
 *
 * WHAT THIS SCRIPT USED TO BE. It picked the newest LOCAL `*.dump` by mtime,
 * never decrypted it, never looked at a manifest, restored it, counted rows in
 * `transacoes`, and dropped the ephemeral database only on the happy path — so
 * a failed drill leaked both the database and any staged plaintext. It wrote
 * nothing to `restore_drills`, which meant the RPO/RTO readiness evaluator
 * (`src/ops/backup/rpo.ts`) had no drill to grade and the platform could not
 * answer "is any backup known to be restorable?".
 *
 * WHAT IT IS NOW: a thin CLI over `runRestoreDrillJob`, which shares the
 * lifecycle in `src/ops/backup/drill.ts` with any scheduler that calls it — the
 * same cron/CLI convergence `scripts/backup.ts` got in #520, for the same
 * reason (two copies of a safety-critical procedure drift).
 *
 * Exit codes are meaningful for an operator script:
 *   0  passed (artifact fetched, bound to its signed manifest, decrypted,
 *      restored, probed, and reconcilable against the tombstone ledger)
 *   0  another drill holds the lock — not an error
 *   0  skipped because backups are disabled by configuration
 *   1  failed — nothing is known to be restorable; see restore_drills
 */
import { runRestoreDrillJob } from '@/workers/backup.js';

async function run(): Promise<number> {
  const outcome = await runRestoreDrillJob();

  if (outcome.status === 'already_running') {
    console.log('another restore drill holds the lock — no second drill was started');
    return 0;
  }

  const r = outcome.result;
  if (r.status === 'skipped') {
    console.log(`restore drill skipped (${r.failure_code})`);
    return 0;
  }

  // Codes and counts only. The artifact path, the object key and the ephemeral
  // database name are deliberately NOT printed: this output lands in operator
  // logs and CI transcripts.
  console.log(
    `restore drill ${r.status} source=${r.source} duration_ms=${r.duration_ms} ` +
      `tombstones_pending=${r.tombstones_pending ?? 'n/a'}`,
  );

  if (r.status === 'passed') {
    if ((r.tombstones_pending ?? 0) > 0) {
      console.warn(
        `NOTE: a real restore of this artifact would still owe ${r.tombstones_pending} tombstone(s) ` +
          'before traffic may be released (runbook §3.6).',
      );
    }
    return 0;
  }

  console.error(
    `FAILED: ${r.failure_code}. Inspect restore_drills (drill ${r.drill_id}) for the probe detail. ` +
      'Until a drill passes, no artifact is known to be restorable.',
  );
  return 1;
}

run()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // Never echo the raw error: pg_restore stderr contains the connection URL
    // with the password, exactly like pg_dump's.
    console.error(`restore drill crashed: ${(err as Error).name}`);
    process.exit(1);
  });
