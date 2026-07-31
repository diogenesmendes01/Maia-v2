import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';
import type { AuditAction } from '@/governance/audit-actions.js';
import { sendAlert } from '@/lib/alerts.js';
import { logger } from '@/lib/logger.js';
import { pool } from '@/db/client.js';
import { deleteBackupObject, headBackupObject, isS3Configured } from './backup-s3.js';
import { runWithSystemContext } from '@/db/tenant-context.js';
import { resolveProfile } from '@/config/profiles.js';
import { resolveBackupProfile, type BackupConfigInput } from '@/ops/backup/profile.js';
import { createBackupPorts } from '@/ops/backup/adapters.js';
import { runVerifiedBackup, type BackupTrigger } from '@/ops/backup/service.js';
import { runArtifactRetention } from '@/ops/backup/retention.js';
import {
  isSafeArtifactRef,
  resolveArtifactObjectKey,
  resolveArtifactPath,
} from '@/ops/backup/artifact-path.js';
import { OPS_LOCK_KEYS, requireOpsLock, withOpsLock } from '@/ops/backup/single-flight.js';
import { parseRetentionPolicy } from '@/ops/retention/data-classes.js';
import { resolveActivation, type ActivationVerdict } from '@/ops/retention/activation.js';
import {
  anyActiveLegalHold,
  countCompletedDryRunCycles,
  listArtifactRuns,
  markRunDeleted,
  reclaimAbandonedRuns,
  recordRetentionRun,
} from '@/db/repositories/ops-repos.js';
import type { RetentionCandidate } from '@/ops/backup/retention.js';

/**
 * Nightly backup runner — issue #520.
 *
 * WHAT CHANGED FROM THE BASELINE. This worker used to spawn `pg_dump`, prune by
 * mtime, best-effort the S3 upload, and then audit `backup_completed` with the
 * file's SIZE as the only evidence — even when the upload had just failed
 * (old `src/workers/backup.ts:50-85`). "Backup concluído" meant "pg_dump
 * exited 0".
 *
 * It is now a thin adapter over ONE shared service:
 *   - `scripts/backup.ts` (the CLI) calls the SAME `runVerifiedBackup`, so the
 *     two can no longer drift;
 *   - a global advisory lock makes a cron/CLI collision impossible — the loser
 *     reports `already_running` and starts nothing;
 *   - the terminal state is COMPUTED from evidence (catalog readable, checksum
 *     verified, encrypted if required, remote copy verified), so a local-only
 *     or upload-failed run is `completed_degraded`/`failed`, never a green
 *     `backup_completed`.
 *
 * Still GENUINELY-GLOBAL maintenance (issue #323 phase 2): a `pg_dump` covers
 * the whole database and has no owning tenant, so the run executes under the
 * reserved `system` sentinel — never the legacy `default` literal.
 */
export async function runNightlyBackup(): Promise<void> {
  await runWithSystemContext(() => executeBackup('schedule'));
}

/**
 * Terminalize runs no live process can still own.
 *
 * The cutoff is TWICE the dump budget: past that, no legitimate run could
 * still be in flight, because the dump stage is itself bounded by
 * `BACKUP_DUMP_TIMEOUT_MS`. Anything older is debris from a process that died,
 * and every reclaim is audited — it is a state change on evidence.
 *
 * Failures here are non-fatal: if the reclaim cannot run, the backup simply
 * proceeds and either succeeds or is refused by the single-active index, which
 * is the pre-existing behaviour. Blocking the nightly backup on housekeeping
 * would be the wrong trade.
 */
async function reclaimAbandoned(): Promise<void> {
  const cutoff = new Date(Date.now() - config.BACKUP_DUMP_TIMEOUT_MS * 2);
  try {
    const reclaimed = await reclaimAbandonedRuns(cutoff);
    if (reclaimed.length === 0) return;
    logger.warn(
      { count: reclaimed.length, cutoff: cutoff.toISOString() },
      'backup.abandoned_runs_reclaimed',
    );
    for (const backup_id of reclaimed) {
      await audit({
        acao: 'backup_run_failed',
        metadata: {
          backup_id,
          outcome: 'failed',
          reason: 'abandoned',
          detail: 'run was left non-terminal by a process that did not come back',
        },
      });
    }
  } catch (err) {
    logger.error({ err: (err as Error).name }, 'backup.abandoned_reclaim_failed');
  }
}

/**
 * Project the loaded configuration onto the slice `resolveBackupProfile` reads.
 *
 * Explicit rather than passing `config` wholesale: the field list is the
 * compile-time contract between this worker and `src/ops/backup/profile.ts`, so
 * renaming a variable in `src/config/contract.ts` breaks the build here instead
 * of silently resolving to `undefined`.
 *
 * The Maia PROFILE comes from `resolveProfile` (issue #515), not from a
 * backup-specific selector — `MAIA_ENV` is the single source of truth, and
 * `resolveProfile` is pure (it reads the snapshot it is handed, not
 * `process.env`).
 */
function backupConfigInput(): BackupConfigInput {
  const { profile } = resolveProfile({
    MAIA_ENV: config.MAIA_ENV,
    NODE_ENV: config.NODE_ENV,
  });
  return {
    profile,
    BACKUP_ENABLED: config.BACKUP_ENABLED,
    BACKUP_DIR: config.BACKUP_DIR,
    BACKUP_RETENTION_LOCAL_DAYS: config.BACKUP_RETENTION_LOCAL_DAYS,
    BACKUP_RETENTION_CLOUD_DAYS: config.BACKUP_RETENTION_CLOUD_DAYS,
    BACKUP_S3_BUCKET: config.BACKUP_S3_BUCKET,
    BACKUP_S3_ACCESS_KEY: config.BACKUP_S3_ACCESS_KEY,
    BACKUP_S3_SECRET_KEY: config.BACKUP_S3_SECRET_KEY,
    BACKUP_S3_ENDPOINT: config.BACKUP_S3_ENDPOINT,
    BACKUP_OFFSITE_REQUIRED: config.BACKUP_OFFSITE_REQUIRED,
    BACKUP_ENCRYPTION_MODE: config.BACKUP_ENCRYPTION_MODE,
    BACKUP_ENCRYPTION_KEYRING: config.BACKUP_ENCRYPTION_KEYRING,
    BACKUP_ENCRYPTION_ACTIVE_KEY_ID: config.BACKUP_ENCRYPTION_ACTIVE_KEY_ID,
    BACKUP_DUMP_TIMEOUT_MS: config.BACKUP_DUMP_TIMEOUT_MS,
    BACKUP_UPLOAD_TIMEOUT_MS: config.BACKUP_UPLOAD_TIMEOUT_MS,
    BACKUP_RESTORE_TIMEOUT_MS: config.BACKUP_RESTORE_TIMEOUT_MS,
    BACKUP_MIN_ARTIFACT_BYTES: config.BACKUP_MIN_ARTIFACT_BYTES,
    BACKUP_RPO_TARGET_HOURS: config.BACKUP_RPO_TARGET_HOURS,
    BACKUP_RTO_TARGET_MINUTES: config.BACKUP_RTO_TARGET_MINUTES,
    BACKUP_RESTORE_DRILL_INTERVAL_HOURS: config.BACKUP_RESTORE_DRILL_INTERVAL_HOURS,
    RETENTION_DRY_RUN: config.RETENTION_DRY_RUN,
  };
}

/**
 * Shared entry point for cron and CLI. Returns the outcome so the CLI can pick
 * a process exit code.
 */
export async function executeBackup(trigger: BackupTrigger): Promise<{
  status: 'ran' | 'already_running' | 'disabled';
  outcome?: 'completed' | 'completed_degraded' | 'failed';
  reason?: string;
}> {
  const profile = resolveBackupProfile(backupConfigInput());
  if (!profile.enabled) {
    logger.warn({ profile: profile.name }, 'backup.disabled');
    return { status: 'disabled' };
  }

  // Reclaim runs abandoned by a process that never came back (SIGTERM whose
  // drain budget expired mid-dump, SIGKILL, OOM, crash). Without this the
  // single-active partial index refuses every future run — see
  // `reclaimAbandonedRuns` for why the cutoff makes it safe.
  await reclaimAbandoned();

  // Single-flight: cron, CLI and any retry contend for one global lock. The
  // loser does NOT wait and does NOT start a second dump.
  const result = await withOpsLock(
    OPS_LOCK_KEYS.backup_run,
    { pool, onWarn: (event, detail) => logger.warn(detail, event) },
    () => runVerifiedBackup(createBackupPorts(), profile, trigger),
  );

  if (result.status === 'already_running') {
    logger.info({ trigger }, 'backup.already_running');
    return { status: 'already_running' };
  }

  const run = result.result;
  // Debris only. Artifact retention is a separate, hold-aware, manifest-driven
  // job (`runBackupRetention`) — never a side effect of taking a backup.
  sweepPartials();

  if (run.outcome !== 'completed') {
    await sendAlert({
      subject:
        run.outcome === 'failed'
          ? 'Nightly backup FAILED'
          : 'Nightly backup DEGRADED (no verified off-site copy)',
      // Codes only — the alert channel is not a place for a path or a URL.
      body:
        `Backup ${run.backup_id} finished with outcome=${run.outcome} reason=${run.reason}.\n` +
        `Inspect backup_runs for this correlation id: ${run.correlation_id}.`,
    }).catch(() => null);
  }

  return { status: 'ran', outcome: run.outcome, reason: run.reason };
}

/**
 * Weekly cron — manifest-driven, hold-aware artifact retention.
 *
 * ROUND-1 REVIEW FINDING (P1). This used to call `pruneCloud`, which selected
 * objects by `LastModified`, swallowed a per-chunk delete failure and returned
 * a partial count that this function audited as
 * `backup_cloud_rotation_completed`. Two separate defects: an artifact under
 * LEGAL HOLD could be destroyed, and a half-finished pass reported success — so
 * the evidence lied about the one thing it exists to prove.
 *
 * Now every deletion is planned from `backup_runs` + `backup_manifests`, legal
 * hold is evaluated under the retention lock before anything is touched, each
 * delete is CONFIRMED, and the audited outcome is conclusive: `completed` only
 * when nothing failed.
 */
export async function runBackupRetention(): Promise<void> {
  // Genuinely-GLOBAL maintenance: a dump has no owning tenant, so the pass runs
  // under the reserved `system` sentinel (issue #323 phase 2).
  await runWithSystemContext(async () => {
    const correlationId = randomUUID();
    const profile = resolveBackupProfile(backupConfigInput());

    // ISSUE #536 — the activation gate, not just the global lever.
    //
    // `RETENTION_DRY_RUN=false` used to be SUFFICIENT to arm this pass. It is
    // now NECESSARY BUT NOT SUFFICIENT: the class also needs a homologated
    // policy that names AND arms it, its wave reached, and two completed
    // dry-run cycles of the SAME policy version on record. That is the #520
    // rollout ("dry-run → comparar contagens → desligar dry-run por classe")
    // as a mechanism instead of a runbook step someone has to remember.
    //
    // Fail-closed by construction: an unreadable `retention_runs` yields zero
    // observed cycles, and zero cycles means dry-run.
    const policy = parseRetentionPolicy(config.RETENTION_POLICY);
    const cyclesByClass = await countCompletedDryRunCycles(policy.version);
    const activation = resolveActivation({
      classId: 'backup.artifact',
      policy,
      dryRunConfigured: profile.retention.dryRun,
      cyclesByClass,
    });
    const dryRun = activation.mode !== 'enforce';

    if (!profile.retention.dryRun && dryRun) {
      // The operator turned the global lever off and the class still did not
      // arm. Say so, with the code — otherwise this looks like the setting was
      // ignored.
      logger.warn(
        {
          data_class: 'backup.artifact',
          reason: activation.reason,
          wave: activation.wave,
          observed_cycles: activation.observed_cycles,
          required_cycles: activation.required_cycles,
          blocking_class: activation.blocking_class,
          policy_version: policy.version,
        },
        'retention.activation_withheld',
      );
    }

    // Destructive work is single-flight and FAILS CLOSED on contention: losing
    // the race must not be mistaken for "nothing to do".
    await requireOpsLock(
      OPS_LOCK_KEYS.retention_run,
      { pool, onWarn: (event, detail) => logger.warn(detail, event) },
      async () => {
        for (const destination of ['local', 's3'] as const) {
          if (destination === 's3' && !isS3Configured()) continue;
          await runOneRetentionPass(destination, dryRun, correlationId, activation);
        }
      },
    );
  });
}

/**
 * Candidates for one destination.
 *
 * ROUND-2 REVIEW FINDING: a run that uploads to S3 ALSO leaves a local copy,
 * and the previous lister filtered on `destination_kind`, so that local copy
 * was invisible to the local pass and accumulated forever.
 *
 * The two destinations are now enumerated differently, on purpose:
 *
 *  - S3 is driven by the RUN ROWS (`destination_kind='s3'`), whose
 *    `delete_after` is the remote expiry the policy assigned at run time.
 *  - LOCAL is driven by WHAT IS ON DISK, cross-referenced with the runs. That
 *    reaches the local copy of an S3 run, applies the (shorter) local retention
 *    window, and — the other half of the finding — surfaces a file with NO run
 *    row at all as `unidentified` instead of leaving it invisible.
 *
 * Every filename is validated before it becomes a candidate, so a hostile
 * entry in the directory cannot ride into the delete path.
 */
export async function listRetentionCandidatesFor(
  destination: 'local' | 's3',
): Promise<RetentionCandidate[]> {
  const runs = await listArtifactRuns();

  if (destination === 's3') {
    return runs
      .filter((r) => r.destination_kind === 's3' && isSafeArtifactRef(r.artifact_ref))
      .map((r) => ({
        backup_id: r.backup_id,
        artifact_ref: r.artifact_ref,
        state: r.state,
        destination_kind: 's3' as const,
        delete_after: r.delete_after,
        has_manifest: r.has_manifest,
      }));
  }

  const byRef = new Map(runs.map((r) => [r.artifact_ref, r]));
  let files: string[];
  try {
    files = readdirSync(config.BACKUP_DIR);
  } catch {
    return [];
  }
  const localMs = config.BACKUP_RETENTION_LOCAL_DAYS * 86_400_000;
  return files.filter(isSafeArtifactRef).map((name) => {
    const run = byRef.get(name);
    if (!run) {
      // On disk, unknown to the evidence tables. Reported, never reaped:
      // deleting an unidentifiable artifact on a guess is the original defect.
      return {
        backup_id: `unknown:${name}`,
        artifact_ref: name,
        state: 'completed' as const,
        destination_kind: 'local' as const,
        delete_after: null,
        has_manifest: false,
      };
    }
    return {
      backup_id: run.backup_id,
      artifact_ref: name,
      state: run.state,
      destination_kind: 'local' as const,
      // The LOCAL window is its own, and shorter: the off-site copy is the
      // authoritative one, so the local copy need not live as long.
      delete_after: run.finished_at ? new Date(run.finished_at.getTime() + localMs) : null,
      has_manifest: run.has_manifest,
    };
  });
}

async function runOneRetentionPass(
  destination: 'local' | 's3',
  dryRun: boolean,
  correlationId: string,
  activation: ActivationVerdict,
): Promise<void> {
  await audit({
    acao: 'retention_run_started',
    metadata: {
      correlation_id: correlationId,
      destination,
      dry_run: dryRun,
      // #536 — WHY this pass is counting rather than deleting, as a stable code.
      activation_reason: activation.reason,
      activation_wave: activation.wave,
      policy_version: activation.policy_version,
      observed_cycles: activation.observed_cycles,
    },
  });

  const outcome = await runArtifactRetention(
    {
      now: () => new Date(),
      listCandidates: listRetentionCandidatesFor,
      anyActiveHold: anyActiveLegalHold,
      // ROUND-2 REVIEW FINDING: `artifact_ref` comes from a DB row, and this is
      // a REMOVAL path. A corrupted or tampered row carrying `../…`, an
      // absolute path or a Windows separator would have deleted a file outside
      // BACKUP_DIR. Every reference is now validated as a bare Maia filename
      // and PROVEN to resolve to a direct child of the root (or, off-site, of
      // the configured prefix) before anything is removed. A refusal throws,
      // which the executor counts as a failed delete — so a poisoned row makes
      // the pass non-conclusive and alerts, instead of silently doing damage.
      deleteArtifact: async (candidate) => {
        if (candidate.destination_kind === 's3') {
          await deleteBackupObject(
            resolveArtifactObjectKey(config.BACKUP_S3_PREFIX, candidate.artifact_ref),
          );
        } else {
          await rm(resolveArtifactPath(config.BACKUP_DIR, candidate.artifact_ref), {
            force: true,
          });
        }
      },
      confirmDeleted: async (candidate) => {
        if (candidate.destination_kind === 's3') {
          const key = resolveArtifactObjectKey(config.BACKUP_S3_PREFIX, candidate.artifact_ref);
          return (await headBackupObject(key)) === null;
        }
        return !existsSync(resolveArtifactPath(config.BACKUP_DIR, candidate.artifact_ref));
      },
      // A run reaches `deleted` only when NO copy remains. Removing the local
      // copy of an S3 run must not mark the run gone while the authoritative
      // off-site object is still there — that would hide it from the next
      // remote pass and strand it outside retention forever.
      markDeleted: async (candidate) => {
        if (candidate.backup_id.startsWith('unknown:')) return;
        const localGone = !existsSync(
          resolveArtifactPath(config.BACKUP_DIR, candidate.artifact_ref),
        );
        const remoteGone =
          !isS3Configured() ||
          (await headBackupObject(
            resolveArtifactObjectKey(config.BACKUP_S3_PREFIX, candidate.artifact_ref),
          )) === null;
        if (localGone && remoteGone) await markRunDeleted(candidate.backup_id);
      },
      audit: (acao, metadata) => audit({ acao: acao as AuditAction, metadata }),
      log: (event, detail) => logger.warn(detail, event),
    },
    destination,
    { dryRun, correlationId },
  );

  // The version recorded is the one actually IN FORCE — an unapproved or
  // malformed `RETENTION_POLICY` resolves to `v0-pending-dpo`, exactly as
  // before. Recording it (rather than the constant) is what lets
  // `countCompletedDryRunCycles` scope the two-cycle observation to a policy
  // version, so editing the policy restarts the count.
  await recordRetentionRun({
    correlation_id: correlationId,
    data_class: 'backup.artifact',
    dry_run: dryRun,
    policy_version: activation.policy_version,
    status: outcome.status,
    scanned: outcome.scanned,
    eligible: outcome.eligible,
    deleted: outcome.deleted,
    skipped_held: outcome.skipped_held,
    failed: outcome.failed,
    cursor_watermark: outcome.cursor_watermark,
    error_code: outcome.error_code,
  }).catch((err: unknown) => {
    logger.error({ err: (err as Error).name }, 'backup.retention_run_not_recorded');
  });

  // The audited action is derived from the OUTCOME — a partial pass can never
  // be recorded as completed.
  await audit({
    acao: outcome.status === 'completed' ? 'retention_run_completed' : 'retention_run_failed',
    metadata: {
      correlation_id: correlationId,
      destination,
      dry_run: dryRun,
      activation_reason: activation.reason,
      policy_version: activation.policy_version,
      status: outcome.status,
      scanned: outcome.scanned,
      eligible: outcome.eligible,
      deleted: outcome.deleted,
      skipped_held: outcome.skipped_held,
      unidentified: outcome.unidentified,
      failed: outcome.failed,
      error_code: outcome.error_code,
    },
  });

  if (outcome.status !== 'completed') {
    await sendAlert({
      subject: `Backup retention ${outcome.status.toUpperCase()} (${destination})`,
      body:
        `Retention pass ${correlationId} ended ${outcome.status} ` +
        `(deleted=${outcome.deleted} failed=${outcome.failed} error=${outcome.error_code ?? 'n/a'}).\n` +
        'Inspect retention_runs for this correlation id.',
    }).catch(() => null);
  }
}

/**
 * Sweep ORPHANED `.partial` files.
 *
 * This is the ONLY place mtime survives, and legitimately: a `.partial` has by
 * construction no manifest and is not a backup — it is the debris of a crashed
 * run. Final artifacts are never touched here; their lifecycle belongs to
 * `runBackupRetention`, which consults the manifest and legal hold.
 */
function sweepPartials(): void {
  let files: string[];
  try {
    files = readdirSync(config.BACKUP_DIR);
  } catch {
    return;
  }
  // A partial older than two dump budgets is definitively orphaned — no run
  // still in flight could own it.
  const cutoff = Date.now() - config.BACKUP_DUMP_TIMEOUT_MS * 2;
  for (const name of files) {
    if (!name.startsWith('maia-') || !name.endsWith('.partial')) continue;
    const path = join(config.BACKUP_DIR, name);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path);
        logger.info({ file: name }, 'backup.partial_swept');
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, file: name }, 'backup.partial_sweep_failed');
    }
  }
}
