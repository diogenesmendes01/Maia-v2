/**
 * Issue #536 §1 — the remote restore drill.
 *
 * WHAT THE BASELINE DID (`scripts/restore-test.ts`, unchanged by #520):
 * picked the newest LOCAL `.dump` by mtime, never decrypted, never consulted a
 * manifest, restored it, counted rows in `transacoes`, dropped the database on
 * the happy path only, and wrote nothing to `restore_drills`. Every RPO/RTO
 * readiness check that depends on a drill therefore had no input, and
 * "o backup é restaurável" remained an assertion.
 *
 * WHAT THIS DOES, and why each step is not optional:
 *
 *   1. select a candidate BY EVIDENCE — the newest run whose off-site copy was
 *      VERIFIED AT THE DESTINATION and that carries a signed manifest. Never by
 *      mtime, never "the newest file in the directory";
 *   2. verify the manifest SIGNATURE and refuse a version this build does not
 *      understand (manifest v1's `remote_checksum_verified` means something
 *      different from v2's — reading it with v2 semantics would treat an
 *      uploader metadata stamp as proof of the stored bytes);
 *   3. FETCH the artifact from the destination the manifest names, and bind the
 *      bytes that arrived to the manifest's digest;
 *   4. DECRYPT it, then bind the PLAINTEXT to the manifest's plaintext digest —
 *      a check nothing else in the system performs;
 *   5. restore into an ISOLATED, ephemeral database;
 *   6. run the probe suite (`drill-probes.ts`), which is not one count;
 *   7. run the tombstone reconciliation as a DRY RUN and evaluate the release
 *      gate, so a drill answers "could this artifact go back to production?"
 *      and not merely "did pg_restore exit 0";
 *   8. record everything in `restore_drills` — including a failure — and audit;
 *   9. tear down the database and every staged file in `finally`.
 *
 * FAIL-CLOSED. Every doubt is a FAILED drill. There is no path through this
 * function that reports `passed` for a step it could not prove: no candidate,
 * an unverifiable manifest, a checksum that does not bind, a required probe
 * that failed, a reconciliation plan that is not `ok` — all of them fail. An
 * unverifiable backup is not a good backup.
 *
 * PURE ORCHESTRATION over injected ports, exactly like
 * `src/ops/backup/service.ts`: no Postgres, no S3, no `pg_restore` binary is
 * needed to exercise the whole lifecycle, including the adversarial branches.
 */
import { randomUUID } from 'node:crypto';
import { TypedError } from '@/lib/utils.js';
import {
  canReleaseTraffic,
  planReconciliation,
  type TombstoneRecord,
} from '@/ops/retention/tombstones.js';
import {
  MANIFEST_VERSION,
  assertArtifactMatchesManifest,
  verifyManifest,
  type BackupManifest,
} from './manifest.js';
import { digestsMatch } from './checksum.js';
import { redactSecrets } from './redaction.js';
import type { ResolvedBackupProfile } from './profile.js';
import { gradeProbeSuite, type ProbeContext, type ProbeRow } from './drill-probes.js';

export type RestoreDrillSource = 'local' | 'offsite';
export type RestoreDrillStatus = 'passed' | 'failed' | 'skipped';

/**
 * Stable, non-sensitive failure codes. Like `BackupErrorCode`, these are what
 * reaches `restore_drills.failure_code`, an audit row and a metric label — the
 * raw `pg_restore` stderr never does, because on a connection failure it echoes
 * the connection URL WITH the password.
 */
export type RestoreDrillFailureCode =
  | 'backups_disabled'
  | 'no_drill_candidate'
  | 'no_offsite_candidate'
  | 'manifest_version_unsupported'
  | 'manifest_unverifiable'
  | 'artifact_fetch_failed'
  | 'artifact_checksum_mismatch'
  | 'decryption_failed'
  | 'plaintext_checksum_mismatch'
  | 'isolation_failed'
  | 'restore_failed'
  | 'probe_failed'
  | 'reconciliation_blocked'
  | 'drill_not_recorded'
  | 'unexpected';

export interface DrillCandidate {
  backup_id: string;
  /** Basename. Never an absolute path, never an object URL. */
  artifact_ref: string;
  /** Where this candidate will be read from. */
  source: RestoreDrillSource;
  /** The signed-manifest envelope exactly as persisted. */
  signed_manifest: unknown;
}

export interface FetchedArtifact {
  /**
   * Where the bytes are readable. May differ from the requested destination:
   * a LOCAL candidate is read in place rather than copied, because a nightly
   * artifact is gigabytes.
   */
  path: string;
  sha256: string;
  bytes: number;
  /**
   * Whether the drill OWNS this file and must delete it during teardown.
   * `false` for a local artifact read in place — deleting it would be the
   * drill destroying the very recovery point it exists to prove.
   */
  ephemeral: boolean;
}

export interface RestoreDrillStore {
  createDrill(row: {
    id: string;
    correlation_id: string;
    backup_run_id: string | null;
    source: RestoreDrillSource;
  }): Promise<void>;
  finishDrill(id: string, patch: Record<string, unknown>): Promise<void>;
}

export interface RestoreDrillPorts {
  now(): Date;
  newId(): string;

  /**
   * The newest artifact the evidence tables say is restorable from `source`.
   * `null` when there is none — which is a FAILED drill, not a quiet skip.
   */
  selectCandidate(source: RestoreDrillSource): Promise<DrillCandidate | null>;

  /** Secret the manifest signature is verified against. Lives outside the artifact. */
  manifestSecret(): { secret: string };

  /** Path inside the drill workspace for a staged file named `name`. */
  stagingPath(name: string): string;

  /** Fetch the artifact AS STORED. Rejects with a TypedError carrying a code. */
  fetchArtifact(candidate: DrillCandidate, dest: string): Promise<FetchedArtifact>;

  /** Envelope-decrypt `src` into `dest`; returns the PLAINTEXT digest. */
  decrypt(src: string, dest: string): Promise<{ sha256: string; bytes: number }>;

  createIsolatedDatabase(name: string): Promise<void>;
  restore(databaseName: string, artifactPath: string): Promise<void>;
  runProbes(databaseName: string, ctx: ProbeContext): Promise<Record<string, ProbeRow | null>>;
  dropDatabase(name: string): Promise<void>;
  removeFile(path: string): Promise<void>;

  /**
   * Read the tombstone ledger for the reconciliation dry run. `available:
   * false` means the boundary could not be READ — distinct from an empty
   * ledger, and a blocking condition (§13).
   */
  readLedger(): Promise<{ available: boolean; tombstones: readonly TombstoneRecord[] }>;
  /** HMAC secret each ledger row is verified against. */
  tombstoneSecret(): string;

  store: RestoreDrillStore;
  audit(action: string, metadata: Record<string, unknown>): Promise<void>;
  log(event: string, detail: Record<string, unknown>): void;
}

export interface RestoreDrillResult {
  drill_id: string;
  correlation_id: string;
  backup_id: string | null;
  source: RestoreDrillSource;
  status: RestoreDrillStatus;
  failure_code: RestoreDrillFailureCode | null;
  duration_ms: number;
  /** Tombstones this snapshot would have to replay before releasing traffic. */
  tombstones_pending: number | null;
  probes: Record<string, unknown>;
}

/**
 * Ephemeral database name for one drill.
 *
 * Same reasoning as `artifactName` (issue #520 round-1 P1): a second-resolution
 * timestamp alone collides, and here a collision is worse than a lost file —
 * `CREATE DATABASE` would fail and the drill would report a false negative, or
 * (if the previous drill leaked its database) restore INTO a stale one and
 * report a false positive. The run's own id discriminates.
 *
 * The shape is constrained to `[a-z0-9_]` so it is a legal unquoted PostgreSQL
 * identifier and cannot carry a quote out of an interpolated DDL statement —
 * `assertSafeDatabaseName` proves that before any adapter uses it.
 */
export function drillDatabaseName(base: string, at: Date, drillId: string): string {
  const stamp = at.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const discriminator = drillId.replace(/[^0-9a-f]/gi, '').slice(0, 12).toLowerCase();
  const safeBase = base.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 24);
  return `${safeBase}_drill_${stamp}_${discriminator}`;
}

const SAFE_DB_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Gate before a database name reaches DDL.
 *
 * `CREATE DATABASE` cannot be parameterised, so the name is interpolated — the
 * one place in this module where a string becomes SQL. It is proven to be a
 * bare lowercase identifier first, which is the same "positive marker, refuse
 * rather than sanitise" rule `artifact-path.ts` applies to filenames.
 */
export function assertSafeDatabaseName(name: string): string {
  if (typeof name !== 'string' || !SAFE_DB_NAME.test(name)) {
    throw new TypedError('unsafe_drill_database_name', 'refusing to use this database name', {
      name_sample: String(name ?? '').slice(0, 64),
    });
  }
  return name;
}

/** Codes this module raises itself and records verbatim. */
const OWN_FAILURE_CODES: ReadonlySet<string> = new Set<RestoreDrillFailureCode>([
  'no_drill_candidate',
  'no_offsite_candidate',
  'manifest_version_unsupported',
  'manifest_unverifiable',
  'artifact_fetch_failed',
  'artifact_checksum_mismatch',
  'decryption_failed',
  'plaintext_checksum_mismatch',
  'isolation_failed',
  'restore_failed',
  'probe_failed',
  'reconciliation_blocked',
]);

/**
 * Codes raised by the shared primitives (`manifest.ts`, `encryption.ts`,
 * `drill.ts`'s own name guard), translated into this module's vocabulary so an
 * operator reads one table of failure codes, not three.
 */
const TRANSLATED_FAILURE_CODES: Readonly<Record<string, RestoreDrillFailureCode>> = Object.freeze({
  backup_checksum_mismatch: 'artifact_checksum_mismatch',
  backup_size_mismatch: 'artifact_checksum_mismatch',
  backup_manifest_missing_digest: 'manifest_unverifiable',
  backup_decrypt_failed: 'decryption_failed',
  backup_key_unavailable: 'decryption_failed',
  backup_key_unwrap_failed: 'decryption_failed',
  backup_envelope_invalid: 'decryption_failed',
  backup_keyring_missing: 'decryption_failed',
  backup_keyring_invalid: 'decryption_failed',
  unsafe_artifact_ref: 'artifact_fetch_failed',
  unsafe_drill_database_name: 'isolation_failed',
  // An unkeyable ledger cannot be verified, and an unverifiable ledger cannot
  // clear a restore for production. Blocked, never "no tombstones found".
  tombstone_secret_missing: 'reconciliation_blocked',
});

/**
 * Map a thrown error onto a stable failure code.
 *
 * Anything unrecognised becomes `unexpected` rather than being echoed: an
 * arbitrary error message could carry the connection URL, and a failure code is
 * persisted, audited and used as a metric label.
 */
export function drillFailureCode(err: unknown): RestoreDrillFailureCode {
  const code = (err as TypedError)?.code;
  if (typeof code !== 'string') return 'unexpected';
  if (OWN_FAILURE_CODES.has(code)) return code as RestoreDrillFailureCode;
  return TRANSLATED_FAILURE_CODES[code] ?? 'unexpected';
}

/**
 * Execute one restore drill.
 *
 * Callers hold `OPS_LOCK_KEYS.restore_drill`; this function does not take it,
 * mirroring `runVerifiedBackup`.
 */
export async function runRestoreDrill(
  ports: RestoreDrillPorts,
  profile: ResolvedBackupProfile,
): Promise<RestoreDrillResult> {
  const drill_id = ports.newId();
  const correlation_id = randomUUID();
  const started = ports.now();

  const base = (): Omit<RestoreDrillResult, 'status' | 'failure_code'> => ({
    drill_id,
    correlation_id,
    backup_id: null,
    source: 'local',
    duration_ms: Math.max(0, ports.now().getTime() - started.getTime()),
    tombstones_pending: null,
    probes: {},
  });

  // A profile with backups disabled has nothing to drill. This is the ONE
  // legitimate `skipped`: it is not evidence of a restorable backup, and
  // `readReadinessFacts` deliberately ignores skipped rows, so readiness keeps
  // reporting "no drill has ever run" instead of being fooled into OK.
  if (!profile.enabled) {
    ports.log('restore_drill.skipped', { drill_id, reason: 'backups_disabled' });
    return { ...base(), status: 'skipped', failure_code: 'backups_disabled' };
  }

  // ── candidate selection, by evidence ────────────────────────────────────
  let candidate: DrillCandidate | null = null;
  try {
    if (profile.offsite.configured) candidate = await ports.selectCandidate('offsite');
    if (candidate === null) candidate = await ports.selectCandidate('local');
  } catch (err) {
    ports.log('restore_drill.candidate_lookup_failed', {
      drill_id,
      error: redactSecrets((err as Error).message),
    });
    candidate = null;
  }

  const source: RestoreDrillSource = candidate?.source ?? 'local';

  // From here on the drill is RECORDED, success or failure. A drill that
  // failed to even find an artifact is the single most important one to
  // persist: it is the state in which nothing is known to be restorable.
  try {
    await ports.store.createDrill({
      id: drill_id,
      correlation_id,
      backup_run_id: candidate?.backup_id ?? null,
      source,
    });
  } catch (err) {
    // Without a row there is no evidence, and a drill that leaves no evidence
    // must not be reported as anything but a failure.
    ports.log('restore_drill.not_recorded', {
      drill_id,
      error: redactSecrets((err as Error).message),
      impact: 'restore_drills row was not created; readiness cannot see this drill',
    });
    return {
      ...base(),
      backup_id: candidate?.backup_id ?? null,
      source,
      status: 'failed',
      failure_code: 'drill_not_recorded',
    };
  }

  await ports
    .audit('restore_drill_started', { drill_id, correlation_id, source, profile: profile.name })
    .catch((err: unknown) => {
      ports.log('restore_drill.start_audit_failed', {
        drill_id,
        error: redactSecrets((err as Error).message),
      });
    });

  let failure: RestoreDrillFailureCode | null = null;
  let tombstonesPending: number | null = null;
  let probes: Record<string, unknown> = {};
  let databaseName: string | null = null;
  let createdDatabase = false;
  const ephemeralFiles = new Set<string>();

  try {
    if (candidate === null) {
      throw new TypedError(
        'no_drill_candidate',
        'no backup run carries both an artifact and a signed manifest — nothing is known to be restorable',
        {},
      );
    }

    // A profile that REQUIRES an off-site copy is not exercised by drilling the
    // local one: the artifact that matters after losing the host is the remote
    // one, and only fetching it proves it is readable, decryptable and whole.
    if (profile.offsite.required && candidate.source !== 'offsite') {
      throw new TypedError(
        'no_offsite_candidate',
        'this profile requires an off-site copy and no verified off-site artifact is available to drill',
        {},
      );
    }

    // ── manifest: version, then signature ────────────────────────────────
    const declaredVersion = (candidate.signed_manifest as { manifest?: { manifest_version?: unknown } })
      ?.manifest?.manifest_version;
    if (declaredVersion !== MANIFEST_VERSION) {
      // Manifest v1's `remote_checksum_verified` could be true because the
      // uploader's own metadata stamp came back from HEAD. Reading it with v2
      // semantics would treat that as proof about the stored bytes.
      throw new TypedError(
        'manifest_version_unsupported',
        'manifest version is not the one this build understands',
        { expected: MANIFEST_VERSION, declared: String(declaredVersion) },
      );
    }

    const verified = verifyManifest(candidate.signed_manifest, ports.manifestSecret().secret);
    if (!verified.ok) {
      throw new TypedError('manifest_unverifiable', 'signed manifest did not verify', {
        reason: verified.reason,
      });
    }
    const manifest: BackupManifest = verified.manifest;

    // ── fetch + bind the STORED bytes to the manifest ────────────────────
    const stagedCipher = ports.stagingPath(`${manifest.backup_id}.artifact`);
    const fetched = await ports.fetchArtifact(candidate, stagedCipher);
    if (fetched.ephemeral) ephemeralFiles.add(fetched.path);
    // Throws `backup_checksum_mismatch` / `backup_size_mismatch`, translated by
    // `drillFailureCode`. Compares against the CIPHERTEXT digest when encrypted.
    assertArtifactMatchesManifest(manifest, { sha256: fetched.sha256, bytes: fetched.bytes });

    // ── decrypt, and bind the PLAINTEXT too ──────────────────────────────
    //
    // Nothing else in the system re-checks `manifest.sha256` against real
    // plaintext: the writer computed it, and the reader (until now) only ever
    // compared the ciphertext. A key that decrypts to the wrong plaintext, or a
    // manifest whose two digests disagree, is caught exactly here.
    let restorePath = fetched.path;
    if (manifest.encryption.mode !== 'none') {
      const stagedPlain = ports.stagingPath(`${manifest.backup_id}.plain`);
      const plain = await ports.decrypt(fetched.path, stagedPlain);
      ephemeralFiles.add(stagedPlain);
      restorePath = stagedPlain;
      if (
        !digestsMatch(plain.sha256, manifest.sha256) ||
        plain.bytes !== manifest.size_bytes
      ) {
        throw new TypedError(
          'plaintext_checksum_mismatch',
          'decrypted artifact does not match the plaintext digest the manifest signed',
          {},
        );
      }
    }

    // ── isolated restore ─────────────────────────────────────────────────
    databaseName = assertSafeDatabaseName(drillDatabaseName('maia', started, drill_id));
    try {
      await ports.createIsolatedDatabase(databaseName);
      createdDatabase = true;
    } catch (err) {
      throw new TypedError('isolation_failed', 'could not create the ephemeral drill database', {
        cause: (err as TypedError).code ?? (err as Error).name,
      });
    }
    await ports.restore(databaseName, restorePath);

    // ── probes ───────────────────────────────────────────────────────────
    const ctx: ProbeContext = { manifest_migration_head: manifest.migration_head };
    const rows = await ports.runProbes(databaseName, ctx);
    const suite = gradeProbeSuite(rows, ctx);
    probes = { ...suite.probes };

    // ── reconciliation DRY RUN + release gate (§13) ──────────────────────
    //
    // This is what turns "pg_restore exited 0" into "this artifact could go
    // back to production". `planReconciliation` blocks on an unreadable ledger,
    // a missing watermark or a row that fails HMAC verification; a drill that
    // ignored that would certify an artifact the real restore path refuses.
    const ledger = await ports.readLedger().catch(() => ({
      available: false,
      tombstones: [] as readonly TombstoneRecord[],
    }));
    const watermarkRaw = manifest.tombstone_watermark;
    const plan = planReconciliation({
      watermark: watermarkRaw === null ? null : new Date(watermarkRaw),
      ledger_available: ledger.available,
      tombstones: ledger.tombstones,
      secret: ports.tombstoneSecret(),
    });
    tombstonesPending = plan.pending.length;
    // Nothing is replayed in a drill, so the gate reports what a REAL restore
    // would still owe. `release: false` with `tombstones_not_reapplied` is the
    // expected, healthy answer whenever the ledger moved on since the snapshot.
    const gate = canReleaseTraffic(plan, []);
    probes.reconciliation = {
      ok: plan.ok,
      blocked_reason: plan.blocked_reason,
      pending: plan.pending.length,
      invalid_tombstones: plan.invalid_ids.length,
      release_without_replay: gate.release,
      release_reason: gate.reason,
      // Counts per class only — the plan itself carries pseudonyms, never
      // identifiers, and not even those are persisted here.
      by_class: plan.by_class,
    };

    if (!plan.ok) {
      throw new TypedError(
        'reconciliation_blocked',
        'the restored snapshot could not be reconciled against the tombstone ledger',
        { blocked_reason: plan.blocked_reason },
      );
    }

    if (!suite.passed) {
      throw new TypedError('probe_failed', 'a required sanity probe failed on the restored snapshot', {
        failed: suite.failed_required,
      });
    }
  } catch (err) {
    failure = drillFailureCode(err);
    ports.log('restore_drill.failed', {
      drill_id,
      correlation_id,
      source,
      // Redacted: `pg_restore` stderr contains the connection URL with the
      // password, exactly like `pg_dump`'s.
      error: redactSecrets((err as Error).message),
      failure_code: failure,
    });
  } finally {
    // Teardown ALWAYS runs — the baseline's cleanup lived on the happy path, so
    // a failed drill leaked its database AND its decrypted plaintext copy of
    // every tenant's data. Both are swept here.
    if (createdDatabase && databaseName !== null) {
      await ports.dropDatabase(databaseName).catch((err: unknown) => {
        ports.log('restore_drill.database_not_dropped', {
          drill_id,
          error: redactSecrets((err as Error).message),
          impact: 'ephemeral drill database still exists and holds a full copy of production data',
        });
      });
    }
    for (const path of ephemeralFiles) {
      await ports.removeFile(path).catch((err: unknown) => {
        ports.log('restore_drill.staged_file_not_removed', {
          drill_id,
          error: redactSecrets((err as Error).message),
          impact: 'a staged artifact copy remains on disk',
        });
      });
    }
  }

  const finished = ports.now();
  const duration_ms = Math.max(0, finished.getTime() - started.getTime());
  const status: RestoreDrillStatus = failure === null ? 'passed' : 'failed';

  try {
    await ports.store.finishDrill(drill_id, {
      status,
      finished_at: finished,
      duration_ms,
      probes,
      tombstones_pending: tombstonesPending,
      failure_code: failure,
    });
  } catch (err) {
    // The drill row is the evidence. A drill whose result was not persisted is
    // not a drill that happened, so it is downgraded rather than reported.
    ports.log('restore_drill.result_not_recorded', {
      drill_id,
      correlation_id,
      error: redactSecrets((err as Error).message),
      impact: 'restore_drills row left non-terminal; readiness will not count this drill',
    });
    return {
      drill_id,
      correlation_id,
      backup_id: candidate?.backup_id ?? null,
      source,
      status: 'failed',
      failure_code: 'drill_not_recorded',
      duration_ms,
      tombstones_pending: tombstonesPending,
      probes,
    };
  }

  await ports
    .audit(status === 'passed' ? 'restore_drill_completed' : 'restore_drill_failed', {
      drill_id,
      correlation_id,
      backup_id: candidate?.backup_id ?? null,
      source,
      status,
      failure_code: failure,
      duration_ms,
      tombstones_pending: tombstonesPending,
    })
    .catch((err: unknown) => {
      ports.log('restore_drill.outcome_audit_failed', {
        drill_id,
        error: redactSecrets((err as Error).message),
      });
    });

  return {
    drill_id,
    correlation_id,
    backup_id: candidate?.backup_id ?? null,
    source,
    status,
    failure_code: failure,
    duration_ms,
    tombstones_pending: tombstonesPending,
    probes,
  };
}
