/**
 * `npm run backup` — issue #520.
 *
 * This script used to carry its OWN copy of the dump + prune logic
 * (old `scripts/backup.ts:11-36`), which the issue called out as a divergence
 * risk: a fix landed in the worker never reached the CLI. It now calls exactly
 * the same `executeBackup` the nightly cron does, so cron and CLI cannot drift
 * and cannot run two dumps at once — the shared advisory lock makes the second
 * caller report `already_running` instead of starting a competing `pg_dump`.
 *
 * Exit codes are meaningful for a deploy script:
 *   0  completed (verified, and off-site-verified when the profile requires it)
 *   0  already running (not an error — another runner holds the lock)
 *   0  disabled by configuration
 *   2  completed DEGRADED (artifact exists but no verified off-site copy)
 *   1  failed
 */
import { runWithSystemContext } from '@/db/tenant-context.js';
import { executeBackup } from '@/workers/backup.js';

async function run(): Promise<number> {
  // A DB-wide dump has no owning tenant — the reserved `system` sentinel is its
  // explicit, justified home (never the legacy `default` literal).
  const res = await runWithSystemContext(() => executeBackup('cli'));

  if (res.status === 'disabled') {
    console.log('backup disabled by configuration (BACKUP_ENABLED=false)');
    return 0;
  }
  if (res.status === 'already_running') {
    console.log('another backup run holds the lock — no second dump was started');
    return 0;
  }

  // Outcome codes only. The artifact path and the destination URL are
  // deliberately NOT printed: this output ends up in deploy logs.
  console.log(`backup outcome=${res.outcome} reason=${res.reason}`);
  if (res.outcome === 'completed') return 0;
  if (res.outcome === 'completed_degraded') {
    console.warn(
      'DEGRADED: the artifact was produced and verified locally, but there is no verified off-site copy.',
    );
    return 2;
  }
  console.error('FAILED: inspect backup_runs.error_code for the stable failure code.');
  return 1;
}

run()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // Never echo the raw error: pg_dump stderr can contain DATABASE_URL.
    console.error(`backup crashed: ${(err as Error).name}`);
    process.exit(1);
  });
