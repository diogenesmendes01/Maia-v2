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
import { backup_manifests, backup_runs, restore_drills } from '@/db/schema.js';
import type { SignedManifest } from '@/ops/backup/manifest.js';
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
