/**
 * Issue #520 §2/§3/§4/§6 — the ONE backup runner, shared by cron and CLI.
 *
 * Baseline gap: `src/workers/backup.ts` and `scripts/backup.ts` each had their
 * own copy of the dump + prune logic (issue evidence: "scripts/backup.ts:11-36
 * duplica parte da lógica do worker, aumentando risco de divergência"). They
 * could also run at the same time. Acceptance criterion: "Cron e CLI
 * compartilham o mesmo serviço" + "Lock impede dois dumps simultâneos".
 *
 * Everything IO-shaped is a PORT so the whole lifecycle can be exercised with
 * fakes — no Postgres, no S3, no `pg_dump` binary. The worker supplies the
 * real adapters.
 *
 * Order of operations, and why:
 *   1. take the global lock             — a second runner must not start
 *   2. dump to `<name>.partial`         — a partial file is never a candidate
 *   3. read the catalog (`pg_restore --list`) and the size floor
 *   4. checksum by streaming
 *   5. encrypt (if the profile requires it) — BEFORE anything leaves the host
 *   6. promote atomically (rename)      — the final name appears fully-formed
 *   7. upload, then verify at the destination
 *   8. classify from evidence, persist run + signed manifest, audit
 *
 * Step 6 is what makes a crash safe: the `.partial` file is cleaned up and no
 * consumer ever sees a truncated artifact under a final name.
 */
import { randomUUID } from 'node:crypto';
import { TypedError } from '@/lib/utils.js';
import type { ResolvedBackupProfile } from './profile.js';
import {
  classifyOutcome,
  outcomeAuditAction,
  type BackupEvidence,
  type BackupOutcome,
  type BackupState,
} from './state-machine.js';
import {
  MANIFEST_VERSION,
  canonicalize,
  signManifest,
  type BackupManifest,
  type SignedManifest,
} from './manifest.js';
import { artifactRef, redactSecrets } from './redaction.js';
import { sha256Buffer } from './checksum.js';
import { classesIncludedInDump, classesExcludedFromDump } from '@/ops/retention/data-classes.js';

export interface Provenance {
  environment: 'development' | 'test' | 'production';
  /** Non-sensitive origin id — a hash of the hostname, never the hostname. */
  source_id: string;
  app_version: string;
  commit: string | null;
  pg_client_version: string | null;
  pg_server_version: string | null;
  migration_head: string | null;
  schema_fingerprint: string | null;
  config_fingerprint: string | null;
}

export interface UploadOutcome {
  /** Opaque destination locator (redaction.opaqueLocator). */
  locator: string;
  /** Size the destination reports for the object. */
  remote_bytes: number | null;
  /** Checksum the destination reports, when the provider supports it. */
  remote_sha256: string | null;
}

export interface BackupPorts {
  now(): Date;
  newId(): string;

  /** Absolute path for an artifact named `name` inside the backup directory. */
  resolvePath(name: string): string;
  ensureBackupDir(): Promise<void>;

  /** Run `pg_dump -Fc` into `target`. Rejects with a TypedError carrying a CODE. */
  dump(target: string, timeoutMs: number): Promise<void>;
  /** `pg_restore --list` — proves the catalog is readable, not just that bytes exist. */
  readCatalog(path: string, timeoutMs: number): Promise<boolean>;

  digest(path: string): Promise<{ sha256: string; bytes: number }>;
  /** Envelope-encrypt `src` into `dest`; returns the key IDENTIFIER used. */
  encrypt(src: string, dest: string): Promise<{ key_id: string }>;
  /** fsync + atomic rename. The final name must appear fully-formed. */
  promote(tempPath: string, finalPath: string): Promise<void>;
  remove(path: string): Promise<void>;

  upload(path: string, timeoutMs: number): Promise<UploadOutcome>;
  /** HEAD/metadata check at the destination against the local evidence. */
  verifyRemote(upload: UploadOutcome, expected: { sha256: string; bytes: number }): Promise<boolean>;

  provenance(): Promise<Provenance>;
  /** Newest tombstone instant at dump time — the §13 replay watermark. */
  tombstoneWatermark(): Promise<Date | null>;

  /** Secret used to sign the manifest. Lives OUTSIDE the artifact (§5). */
  manifestSecret(): { secret: string; key_version: number };

  store: BackupEvidenceStore;
  audit(action: string, metadata: Record<string, unknown>): Promise<void>;
  log(event: string, detail: Record<string, unknown>): void;
}

export interface BackupEvidenceStore {
  createRun(row: {
    id: string;
    correlation_id: string;
    profile: string;
    trigger: BackupTrigger;
    state: BackupState;
  }): Promise<void>;
  updateRun(id: string, patch: Record<string, unknown>): Promise<void>;
  saveManifest(runId: string, signed: SignedManifest, manifestSha256: string): Promise<void>;
}

export type BackupTrigger = 'schedule' | 'cli' | 'retry';

export interface BackupRunResult {
  backup_id: string;
  correlation_id: string;
  outcome: BackupOutcome;
  reason: string;
  artifact_ref: string | null;
  state: BackupState;
}

/** Timestamped artifact name. Deterministic shape, no host/tenant in it. */
export function artifactName(at: Date): string {
  return `maia-${at.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.dump`;
}

/**
 * Stable, non-sensitive failure codes. The raw `pg_dump` stderr NEVER reaches
 * a log or an audit row: on a connection failure it contains `DATABASE_URL`
 * with the password.
 */
export type BackupErrorCode =
  | 'dump_failed'
  | 'catalog_unreadable'
  | 'artifact_too_small'
  | 'encryption_failed'
  | 'promote_failed'
  | 'upload_failed'
  | 'remote_verification_failed'
  | 'manifest_failed'
  | 'unexpected';

function codeOf(err: unknown): BackupErrorCode {
  const code = (err as TypedError)?.code;
  const known: BackupErrorCode[] = [
    'dump_failed',
    'catalog_unreadable',
    'artifact_too_small',
    'encryption_failed',
    'promote_failed',
    'upload_failed',
    'remote_verification_failed',
    'manifest_failed',
  ];
  return known.includes(code as BackupErrorCode) ? (code as BackupErrorCode) : 'unexpected';
}

/**
 * Execute one verified backup run.
 *
 * Callers MUST already hold the global single-flight lock (see
 * `withOpsLock(OPS_LOCK_KEYS.backup_run, …)`); this function does not take it,
 * so the same body is reusable from a context that holds a longer-lived lock.
 */
export async function runVerifiedBackup(
  ports: BackupPorts,
  profile: ResolvedBackupProfile,
  trigger: BackupTrigger = 'schedule',
): Promise<BackupRunResult> {
  const backup_id = ports.newId();
  const correlation_id = randomUUID();
  const started = ports.now();

  await ports.store.createRun({
    id: backup_id,
    correlation_id,
    profile: profile.name,
    trigger,
    state: 'running',
  });
  await ports.audit('backup_run_started', { backup_id, correlation_id, profile: profile.name });

  const finalName = artifactName(started);
  const finalPath = ports.resolvePath(finalName);
  // The `.partial` suffix is the contract every consumer (drill, retention,
  // readiness) filters on. A crash leaves a file nothing will ever restore.
  const partialPath = `${finalPath}.partial`;
  // Encryption writes a second temp file; both are swept in `finally`.
  const encPath = `${finalPath}.enc.partial`;

  const evidence: BackupEvidence = {
    locally_verified: false,
    encryption_required: profile.encryption.required,
    encrypted: false,
    offsite_required: profile.offsite.required,
    offsite_configured: profile.offsite.configured,
    offsite_attempted: false,
    offsite_verified: false,
  };

  let state: BackupState = 'running';
  let artifact = partialPath;
  let digest: { sha256: string; bytes: number } | null = null;
  let plaintextDigest: { sha256: string; bytes: number } | null = null;
  let keyId: string | null = null;
  let upload: UploadOutcome | null = null;
  let errorCode: BackupErrorCode | null = null;
  let dumpMs: number | null = null;
  let uploadMs: number | null = null;
  const temps = new Set<string>([partialPath, encPath]);

  try {
    await ports.ensureBackupDir();

    // ── dump ──────────────────────────────────────────────────────────────
    const t0 = ports.now().getTime();
    await ports.dump(partialPath, profile.timeouts.dumpMs);
    dumpMs = ports.now().getTime() - t0;
    state = 'dump_created';

    // ── local verification ────────────────────────────────────────────────
    // Size alone is not evidence (the baseline's only signal). The catalog
    // must be readable and the artifact must clear the floor.
    plaintextDigest = await ports.digest(partialPath);
    if (plaintextDigest.bytes < profile.artifact.minBytes) {
      throw new TypedError('artifact_too_small', 'dump is smaller than the configured floor', {
        bytes: plaintextDigest.bytes,
        min_bytes: profile.artifact.minBytes,
      });
    }
    if (!(await ports.readCatalog(partialPath, profile.timeouts.dumpMs))) {
      throw new TypedError('catalog_unreadable', 'pg_restore could not read the dump catalog', {});
    }
    evidence.locally_verified = true;
    digest = plaintextDigest;
    state = 'locally_verified';

    // ── encryption (before anything leaves the host) ──────────────────────
    if (profile.encryption.required) {
      const enc = await ports.encrypt(partialPath, encPath);
      keyId = enc.key_id;
      // Verify-after-write: re-read what actually landed on disk.
      digest = await ports.digest(encPath);
      evidence.encrypted = true;
      artifact = encPath;
      state = 'encrypted';
    }

    // ── atomic promotion ──────────────────────────────────────────────────
    await ports.promote(artifact, finalPath);
    temps.delete(artifact);
    artifact = finalPath;

    // ── off-site ──────────────────────────────────────────────────────────
    if (profile.offsite.configured) {
      const u0 = ports.now().getTime();
      try {
        evidence.offsite_attempted = true;
        upload = await ports.upload(finalPath, profile.timeouts.uploadMs);
        uploadMs = ports.now().getTime() - u0;
        state = 'uploaded';
        evidence.offsite_verified = await ports.verifyRemote(upload, digest!);
        if (evidence.offsite_verified) {
          state = 'remotely_verified';
          await ports.audit('backup_artifact_verified', {
            backup_id,
            correlation_id,
            stage: 'remote',
          });
        }
      } catch (err) {
        // An upload failure is NOT swallowed: it feeds the classifier, which
        // turns it into `failed` (production) or `completed_degraded`.
        uploadMs = ports.now().getTime() - u0;
        ports.log('backup.upload_failed', {
          backup_id,
          error: redactSecrets((err as Error).message),
        });
      }
    }
  } catch (err) {
    errorCode = codeOf(err);
    ports.log('backup.stage_failed', {
      backup_id,
      stage: state,
      // Redacted: pg_dump stderr contains DATABASE_URL with the password.
      error: redactSecrets((err as Error).message),
      code: errorCode,
    });
  } finally {
    // Partials are ALWAYS swept — success, failure, or crash-in-between.
    for (const p of temps) await ports.remove(p).catch(() => undefined);
  }

  // ── classify from evidence ──────────────────────────────────────────────
  const verdict = classifyOutcome(evidence);
  const finished = ports.now();
  const finalState: BackupState =
    verdict.outcome === 'failed'
      ? 'failed'
      : verdict.outcome === 'completed'
        ? 'completed'
        : 'completed_degraded';

  const runPatch: Record<string, unknown> = {
    state: finalState,
    outcome: verdict.outcome,
    outcome_reason: errorCode ?? verdict.reason,
    finished_at: finished,
    dump_duration_ms: dumpMs,
    upload_duration_ms: uploadMs,
    artifact_ref: evidence.locally_verified ? artifactRef(finalPath) : null,
    size_bytes: digest?.bytes ?? null,
    sha256: digest?.sha256 ?? null,
    encryption_mode: profile.encryption.mode,
    encryption_key_id: keyId,
    destination_kind: upload ? 's3' : 'local',
    destination_locator: upload?.locator ?? null,
    local_verified: evidence.locally_verified,
    remote_verified: evidence.offsite_verified,
    remote_verified_at: evidence.offsite_verified ? finished : null,
    error_code: errorCode,
  };

  // ── manifest (only for a run that produced a real artifact) ─────────────
  if (evidence.locally_verified && digest !== null && plaintextDigest !== null) {
    try {
      const prov = await ports.provenance();
      const watermark = await ports.tombstoneWatermark();
      const manifest: BackupManifest = {
        manifest_version: MANIFEST_VERSION,
        backup_id,
        correlation_id,
        started_at: started.toISOString(),
        finished_at: finished.toISOString(),
        environment: prov.environment,
        profile: profile.name,
        source_id: prov.source_id,
        app_version: prov.app_version,
        commit: prov.commit,
        pg_client_version: prov.pg_client_version,
        pg_server_version: prov.pg_server_version,
        dump_format: 'custom',
        migration_head: prov.migration_head,
        schema_fingerprint: prov.schema_fingerprint,
        config_fingerprint: prov.config_fingerprint,
        size_bytes: plaintextDigest.bytes,
        sha256: plaintextDigest.sha256,
        encryption: {
          mode: profile.encryption.mode,
          key_id: keyId,
          key_version: keyId ? 1 : null,
          ciphertext_sha256: evidence.encrypted ? digest.sha256 : null,
        },
        destination: {
          kind: upload ? 's3' : 'local',
          locator: upload?.locator ?? null,
          artifact_ref: artifactRef(finalPath),
        },
        verification: {
          catalog_readable: true,
          local_checksum_verified: true,
          remote_checksum_verified: evidence.offsite_verified,
          remote_verified_at: evidence.offsite_verified ? finished.toISOString() : null,
        },
        data_classes_included: classesIncludedInDump(),
        data_classes_excluded: classesExcludedFromDump(),
        tombstone_watermark: watermark ? watermark.toISOString() : null,
        retention_class: 'backup.artifact',
        delete_after: new Date(
          finished.getTime() + profile.retention.cloudDays * 86_400_000,
        ).toISOString(),
        legal_hold: 'none',
        last_restore_drill_at: null,
        last_restore_drill_result: null,
        outcome: verdict.outcome,
        outcome_reason: errorCode ?? verdict.reason,
      };
      const { secret, key_version } = ports.manifestSecret();
      const signed = signManifest(manifest, secret, key_version);
      await ports.store.saveManifest(backup_id, signed, sha256Buffer(canonicalize(manifest)));
      runPatch.tombstone_watermark = watermark;
      runPatch.retention_class = 'backup.artifact';
      runPatch.delete_after = new Date(
        finished.getTime() + profile.retention.cloudDays * 86_400_000,
      );
    } catch (err) {
      // A run whose evidence cannot be signed is not verifiable evidence.
      // Fail the run rather than publish an artifact nobody can validate.
      runPatch.state = 'failed';
      runPatch.outcome = 'failed';
      runPatch.outcome_reason = 'manifest_failed';
      runPatch.error_code = 'manifest_failed';
      ports.log('backup.manifest_failed', {
        backup_id,
        error: redactSecrets((err as Error).message),
      });
    }
  }

  await ports.store.updateRun(backup_id, runPatch);

  const outcome = runPatch.outcome as BackupOutcome;
  const reason = runPatch.outcome_reason as string;
  await ports.audit(outcomeAuditAction(outcome), {
    backup_id,
    correlation_id,
    outcome,
    reason,
    // Basename only. Never the absolute path, never the object URL.
    artifact_ref: runPatch.artifact_ref,
    size_bytes: runPatch.size_bytes,
    destination_kind: runPatch.destination_kind,
    encryption_mode: profile.encryption.mode,
    dump_duration_ms: dumpMs,
    upload_duration_ms: uploadMs,
  });

  return {
    backup_id,
    correlation_id,
    outcome,
    reason,
    artifact_ref: (runPatch.artifact_ref as string | null) ?? null,
    state: runPatch.state as BackupState,
  };
}
