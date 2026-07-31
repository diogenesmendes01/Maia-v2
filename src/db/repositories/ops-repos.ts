/**
 * Issue #520 — persistence for backup evidence (migration 101).
 *
 * Deliberately small: the runner in `src/ops/backup/service.ts` decides WHAT
 * to record; this module only writes it. Every row lands under the reserved
 * `system` sentinel (a `pg_dump` is DB-wide and has no owning tenant), which
 * migration 101 enforces with a CHECK — so a caller that somehow arrived under
 * a real tenant context is rejected by the database, not silently accepted.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  backup_manifests,
  backup_runs,
  legal_holds,
  restore_drills,
  retention_runs,
} from '@/db/schema.js';
import type { SignedManifest } from '@/ops/backup/manifest.js';
import type { RetentionCandidate } from '@/ops/backup/retention.js';
import type { BackupEvidenceStore, BackupTrigger } from '@/ops/backup/service.js';
import type { BackupState } from '@/ops/backup/state-machine.js';

export const backupEvidenceStore: BackupEvidenceStore = {
  async createRun(row: {
    id: string;
    correlation_id: string;
    profile: string;
    trigger: BackupTrigger;
    state: BackupState;
  }): Promise<void> {
    await db.insert(backup_runs).values({
      id: row.id,
      correlation_id: row.correlation_id,
      profile: row.profile,
      trigger: row.trigger,
      state: row.state,
      // tenant_id/agent_id default to 'system' (migration 101 CHECK).
    });
  },

  async updateRun(id: string, patch: Record<string, unknown>): Promise<void> {
    await db
      .update(backup_runs)
      .set({ ...patch, updated_at: new Date() } as never)
      .where(eq(backup_runs.id, id));
  },

  async saveManifest(
    runId: string,
    signed: SignedManifest,
    manifestSha256: string,
  ): Promise<void> {
    await db.insert(backup_manifests).values({
      backup_run_id: runId,
      manifest_version: signed.manifest.manifest_version,
      manifest: signed.manifest,
      manifest_sha256: manifestSha256,
      signature: signed.signature,
      signature_alg: signed.signature_alg,
      signature_key_version: signed.signature_key_version,
    });
  },
};

/** A run that produced an artifact, whatever destination it ended up on. */
export interface ArtifactRunRow {
  backup_id: string;
  artifact_ref: string;
  state: RetentionCandidate['state'];
  destination_kind: 'local' | 's3';
  /** Remote expiry, from the policy at run time. */
  delete_after: Date | null;
  /** When the run finished — the base for the LOCAL expiry. */
  finished_at: Date | null;
  has_manifest: boolean;
}

/**
 * Every run that produced an artifact, keyed for retention (issue #520 §10).
 *
 * The join to `backup_manifests` is what makes `has_manifest` real: an artifact
 * with no signed manifest cannot be identified, so the planner refuses to
 * delete it. Selection is by EVIDENCE (state, expiry, manifest), never by file
 * mtime or `LastModified` — that was the round-1 P1 finding.
 *
 * ROUND-2 REVIEW FINDING: this used to filter by `destination_kind`, so the
 * LOCAL copy of a run that uploaded to S3 (`destination_kind='s3'`) was
 * invisible to the local pass and accumulated forever — disk, yes, but more
 * importantly data under a retention policy living outside the lifecycle this
 * issue promises to govern. The filter is gone; callers scope by destination.
 */
export async function listArtifactRuns(): Promise<ArtifactRunRow[]> {
  const rows = await db.execute<{
    backup_id: string;
    artifact_ref: string | null;
    state: string;
    destination_kind: string;
    delete_after: string | null;
    finished_at: string | null;
    has_manifest: boolean;
  }>(sql`
    SELECT r.id AS backup_id,
           r.artifact_ref,
           r.state,
           r.destination_kind,
           r.delete_after::text AS delete_after,
           r.finished_at::text AS finished_at,
           (m.id IS NOT NULL) AS has_manifest
      FROM ${backup_runs} r
      LEFT JOIN ${backup_manifests} m ON m.backup_run_id = r.id
     WHERE r.state <> 'deleted'
       AND r.artifact_ref IS NOT NULL
     ORDER BY r.delete_after ASC NULLS LAST
  `);
  return rows.rows.map((r) => ({
    backup_id: r.backup_id,
    artifact_ref: r.artifact_ref ?? '',
    state: r.state as RetentionCandidate['state'],
    destination_kind: r.destination_kind === 's3' ? 's3' : 'local',
    delete_after: r.delete_after ? new Date(r.delete_after) : null,
    finished_at: r.finished_at ? new Date(r.finished_at) : null,
    has_manifest: r.has_manifest === true,
  }));
}

/**
 * Is ANY legal hold active right now?
 *
 * A dump is a container of every tenant's data, so a hold anywhere freezes the
 * whole artifact. Returns `null` when the question could not be answered — the
 * caller FAILS the pass rather than treating "I could not check" as "no hold".
 */
export async function anyActiveLegalHold(
  at: Date,
): Promise<{ held: boolean; hold_ids: string[] } | null> {
  try {
    const res = await db.execute<{ id: string }>(sql`
      SELECT id FROM ${legal_holds}
       WHERE status = 'active'
         AND effective_from <= ${at}
         AND (effective_until IS NULL OR effective_until > ${at})
       LIMIT 50
    `);
    const ids = res.rows.map((r) => r.id);
    return { held: ids.length > 0, hold_ids: ids };
  } catch {
    return null;
  }
}

/**
 * Terminalize runs abandoned by a process that never came back.
 *
 * WHY THIS EXISTS (issue #512 interaction). `nightly_backup` and
 * `backup_retention` are ordinary cron jobs, so #512's shutdown sequence
 * already covers them: `runTick` refuses to start new work once draining, and
 * step 2 (`cron_workers`) awaits the in-flight tick. But the drain budget is
 * `SHUTDOWN_GRACE_MS` (25s default) while a dump may legitimately run for
 * `BACKUP_DUMP_TIMEOUT_MS` (1h default) — so a backup caught by SIGTERM is
 * reported as `pending`, the process exits, and its row stays non-terminal.
 * The single-active partial index then refuses EVERY future run.
 *
 * Rather than special-casing shutdown, this reclaims on the way IN, which also
 * covers SIGKILL, OOM and a hard crash — none of which get to run cleanup code.
 *
 * The cutoff is what makes it safe: a run is only abandoned once it is older
 * than any live run could possibly be (the dump stage is itself bounded), so a
 * genuinely-running backup is never stolen from under itself.
 */
export async function reclaimAbandonedRuns(olderThan: Date): Promise<string[]> {
  const res = await db.execute<{ id: string }>(sql`
    UPDATE ${backup_runs}
       SET state = 'failed',
           outcome = 'failed',
           outcome_reason = 'abandoned',
           error_code = 'abandoned',
           finished_at = now(),
           updated_at = now()
     WHERE state NOT IN ('completed', 'completed_degraded', 'failed', 'expired', 'deleted')
       AND started_at < ${olderThan}
    RETURNING id
  `);
  return res.rows.map((r) => r.id);
}

/** Move a run row to `deleted` once its artifact is confirmed gone. */
export async function markRunDeleted(backupId: string): Promise<void> {
  await db
    .update(backup_runs)
    .set({ state: 'deleted', updated_at: new Date() })
    .where(eq(backup_runs.id, backupId));
}

/** Persist the retention pass itself (the evidence that it ran, and how). */
export async function recordRetentionRun(row: {
  correlation_id: string;
  data_class: string;
  dry_run: boolean;
  policy_version: string;
  status: 'completed' | 'partial' | 'failed';
  scanned: number;
  eligible: number;
  deleted: number;
  skipped_held: number;
  failed: number;
  cursor_watermark: Date | null;
  error_code: string | null;
}): Promise<void> {
  await db.insert(retention_runs).values({
    // Backup artifacts are DB-wide; the reserved `system` sentinel is their
    // explicit home (migration 102 only forbids the legacy `default`).
    tenant_id: 'system',
    agent_id: 'system',
    correlation_id: row.correlation_id,
    data_class: row.data_class,
    dry_run: row.dry_run,
    policy_version: row.policy_version,
    status: row.status,
    scanned: row.scanned,
    eligible: row.eligible,
    deleted: row.deleted,
    skipped_held: row.skipped_held,
    failed: row.failed,
    cursor_watermark: row.cursor_watermark,
    error_code: row.error_code,
    finished_at: new Date(),
  });
}

/**
 * Completed dry-run CYCLES per data class, for one policy version (#536).
 *
 * This is the evidence `resolveActivation` requires before a class may stop
 * counting and start deleting. Three things make the count mean what the
 * activation gate needs:
 *
 *  - DISTINCT `correlation_id`, not row count. One weekly pass writes one row
 *    per destination (local + off-site), and two destinations in one night are
 *    one cycle of observation, not two.
 *  - `policy_version` scoped. Editing the policy restarts the observation,
 *    because the counts the operator compared were counts of a different
 *    policy.
 *  - `status = 'completed'` only. A partial or failed pass proves nothing about
 *    what the plan would have deleted.
 *
 * Fails CLOSED: on any error the caller gets an empty map, which reads as zero
 * observed cycles, which keeps every class in dry-run.
 */
export async function countCompletedDryRunCycles(
  policyVersion: string,
): Promise<Record<string, number>> {
  try {
    const res = await db.execute<{ data_class: string; cycles: string }>(sql`
      SELECT data_class, count(DISTINCT correlation_id)::text AS cycles
        FROM ${retention_runs}
       WHERE dry_run = true
         AND status = 'completed'
         AND policy_version = ${policyVersion}
       GROUP BY data_class
    `);
    const out: Record<string, number> = {};
    for (const row of res.rows) {
      const n = Number(row.cycles);
      if (Number.isFinite(n) && n > 0) out[row.data_class] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export interface ReadinessFacts {
  last_local_verified_at: Date | null;
  last_offsite_verified_at: Date | null;
  last_restore_drill_at: Date | null;
  last_restore_drill_result: 'passed' | 'failed' | null;
  last_restore_drill_duration_ms: number | null;
  consecutive_failures: number;
}

/**
 * Facts behind the RPO/RTO verdict (`src/ops/backup/rpo.ts`).
 *
 * "Verified" is the operative word in both age queries: a run that produced a
 * file but never proved its checksum is NOT a recovery point, so it is
 * excluded — this is the query that makes `backup_age_local` honest.
 */
export async function readReadinessFacts(): Promise<ReadinessFacts> {
  const [localRow] = await db
    .select({ at: backup_runs.finished_at })
    .from(backup_runs)
    .where(and(eq(backup_runs.local_verified, true)))
    .orderBy(desc(backup_runs.finished_at))
    .limit(1);

  const [offsiteRow] = await db
    .select({ at: backup_runs.remote_verified_at })
    .from(backup_runs)
    .where(and(eq(backup_runs.remote_verified, true)))
    .orderBy(desc(backup_runs.remote_verified_at))
    .limit(1);

  const [drillRow] = await db
    .select({
      at: restore_drills.finished_at,
      status: restore_drills.status,
      duration: restore_drills.duration_ms,
    })
    .from(restore_drills)
    .where(sql`${restore_drills.status} IN ('passed', 'failed')`)
    .orderBy(desc(restore_drills.finished_at))
    .limit(1);

  // Consecutive failures since the last non-failed terminal run.
  const failures = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n
    FROM (
      SELECT state
      FROM ${backup_runs}
      WHERE state IN ('completed', 'completed_degraded', 'failed')
      ORDER BY started_at DESC
      LIMIT 50
    ) recent
    WHERE state = 'failed'
      AND NOT EXISTS (
        SELECT 1 FROM ${backup_runs} ok
        WHERE ok.state IN ('completed', 'completed_degraded')
          AND ok.started_at > (
            SELECT min(started_at) FROM ${backup_runs} f WHERE f.state = 'failed'
          )
      )
  `);

  return {
    last_local_verified_at: localRow?.at ?? null,
    last_offsite_verified_at: offsiteRow?.at ?? null,
    last_restore_drill_at: drillRow?.at ?? null,
    last_restore_drill_result:
      drillRow?.status === 'passed' || drillRow?.status === 'failed'
        ? (drillRow.status as 'passed' | 'failed')
        : null,
    last_restore_drill_duration_ms: drillRow?.duration ?? null,
    consecutive_failures: Number(failures.rows[0]?.n ?? 0),
  };
}
