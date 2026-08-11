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
  data_tombstones,
  legal_holds,
  restore_drills,
  retention_runs,
} from '@/db/schema.js';
import type { DrillCandidate, RestoreDrillStore } from '@/ops/backup/drill.js';
import type { SignedManifest } from '@/ops/backup/manifest.js';
import type { RetentionCandidate } from '@/ops/backup/retention.js';
import type { BackupEvidenceStore, BackupTrigger } from '@/ops/backup/service.js';
import type { BackupState } from '@/ops/backup/state-machine.js';
import type { TombstoneRecord } from '@/ops/retention/tombstones.js';

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

/* ────────────────────────── restore drill (issue #536) ────────────────────── */

/**
 * The artifact a drill should exercise, selected BY EVIDENCE.
 *
 * The rules, and why each one is there:
 *
 *  - a candidate MUST carry a signed manifest (`INNER JOIN`). Without one there
 *    is nothing to bind the bytes to, and a drill that restored an
 *    unidentifiable file would prove nothing about the backup discipline;
 *  - an OFF-SITE candidate MUST have `remote_verified`. That flag means, since
 *    manifest v2, that a provider-computed checksum matched or the object was
 *    re-downloaded and re-hashed — never the uploader's own metadata stamp;
 *  - a LOCAL candidate MUST have `local_verified`, i.e. its catalog was read
 *    and its checksum computed. "The file exists" was the baseline's bar and is
 *    exactly what this issue exists to raise;
 *  - `state = 'deleted'` is excluded: retention already reaped those bytes.
 *
 * Ordering is by `finished_at DESC` — the NEWEST artifact, because a drill
 * proves the CURRENT recovery point, not a historical one.
 */
export async function selectDrillCandidate(
  source: 'local' | 'offsite',
): Promise<DrillCandidate | null> {
  const verifiedPredicate =
    source === 'offsite'
      ? sql`r.remote_verified = true AND r.destination_kind = 's3'`
      : sql`r.local_verified = true`;

  const res = await db.execute<{
    backup_id: string;
    artifact_ref: string | null;
    manifest: unknown;
    signature: string;
    signature_alg: string;
    signature_key_version: number;
  }>(sql`
    SELECT r.id AS backup_id,
           r.artifact_ref,
           m.manifest,
           m.signature,
           m.signature_alg,
           m.signature_key_version
      FROM ${backup_runs} r
      JOIN ${backup_manifests} m ON m.backup_run_id = r.id
     WHERE r.state IN ('completed', 'completed_degraded')
       AND r.artifact_ref IS NOT NULL
       AND ${verifiedPredicate}
     ORDER BY r.finished_at DESC
     LIMIT 1
  `);

  const row = res.rows[0];
  if (!row || !row.artifact_ref) return null;
  return {
    backup_id: row.backup_id,
    artifact_ref: row.artifact_ref,
    source,
    // Reassembled into the envelope shape `verifyManifest` expects. The drill
    // re-verifies the signature itself — this repository never asserts that a
    // manifest is valid, it only hands over what was stored.
    signed_manifest: {
      manifest: row.manifest,
      signature: row.signature,
      signature_alg: row.signature_alg,
      signature_key_version: row.signature_key_version,
    },
  };
}

export const restoreDrillStore: RestoreDrillStore = {
  async createDrill(row): Promise<void> {
    await db.insert(restore_drills).values({
      id: row.id,
      correlation_id: row.correlation_id,
      backup_run_id: row.backup_run_id,
      source: row.source,
      status: 'running',
      // tenant_id/agent_id default to 'system' (migration 101 CHECK).
    });
  },

  async finishDrill(id, patch): Promise<void> {
    await db
      .update(restore_drills)
      .set(patch as never)
      .where(eq(restore_drills.id, id));
  },
};

/**
 * Read the tombstone ledger for the drill's reconciliation dry run.
 *
 * `available: false` on ANY read failure — the caller must be able to tell an
 * unreadable ledger from an empty one, because the first blocks a restore and
 * the second does not (issue #520 round-1 P1, preserved here).
 *
 * DELIBERATELY UNBOUNDED BY TENANT: a `pg_dump` is a container of every
 * tenant's data, so the reconciliation that guards its restore has to see every
 * tenant's tombstones. The rows carry PSEUDONYMS only, so reading them all does
 * not disclose a single identifier.
 *
 * BOUNDED BY COUNT, and fail-closed at the bound. A silently truncated ledger
 * is the worst possible answer here: the missing rows are exactly the deletions
 * that would NOT be replayed, so a restore would resurrect them while the plan
 * reported `ok`. Hitting the cap therefore reports the ledger as UNREADABLE,
 * which blocks the restore and asks a human to reconcile in batches.
 */
export const TOMBSTONE_LEDGER_READ_LIMIT = 100_000;

export async function readTombstoneLedger(): Promise<{
  available: boolean;
  tombstones: TombstoneRecord[];
}> {
  try {
    const rows = await db
      .select()
      .from(data_tombstones)
      .orderBy(data_tombstones.effective_at)
      // +1 so the cap is DETECTED rather than silently reached.
      .limit(TOMBSTONE_LEDGER_READ_LIMIT + 1);
    if (rows.length > TOMBSTONE_LEDGER_READ_LIMIT) {
      return { available: false, tombstones: [] };
    }
    return {
      available: true,
      tombstones: rows.map((r) => ({
        id: r.id,
        tenant_id: r.tenant_id,
        agent_id: r.agent_id,
        data_class: r.data_class,
        subject_ref: r.subject_ref,
        resource_locator: r.resource_locator,
        action: r.action as TombstoneRecord['action'],
        effective_at: r.effective_at,
        origin: r.origin as TombstoneRecord['origin'],
        version: r.version,
        hmac: r.hmac,
        hmac_key_version: r.hmac_key_version,
      })),
    };
  } catch {
    return { available: false, tombstones: [] };
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
