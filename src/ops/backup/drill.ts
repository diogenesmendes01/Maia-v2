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
 *   8. tear down the database and every staged file in `finally`, and PROVE
 *      each one is gone;
 *   9. record everything in `restore_drills` — including a failure and any
 *      residue — and audit.
 *
 * FAIL-CLOSED. Every doubt is a FAILED drill. There is no path through this
 * function that reports `passed` for a step it could not prove: no candidate,
 * an unverifiable manifest, a checksum that does not bind, a required probe
 * that failed, a reconciliation plan that is not `ok` — all of them fail. An
 * unverifiable backup is not a good backup.
 *
 * THE STATUS VOCABULARY, precisely (issue #541 round-2 review):
 *
 *   `passed`  — the artifact was proven restorable AND the host was proven
 *               clean: the ephemeral database and every file this drill staged
 *               (including the DECRYPTED plaintext copy of every tenant's data)
 *               are gone, checked after the removal rather than assumed from a
 *               call that did not throw.
 *   `failed`  — at least one of those two could not be proven. `failure_code`
 *               names the RESTORE-phase diagnosis; `cleanup_status` is an
 *               INDEPENDENT axis that names the host's state. A drill whose
 *               restore was perfect but whose teardown left a copy behind is a
 *               successful restore WITH AN UNSAFE RESIDUE — it is reported as
 *               `failed` / `cleanup_failed` / `cleanup_status='unsafe'`, never
 *               as a certification, because a green drill that leaks a
 *               production copy trains the operator to trust a harmful signal.
 *   `skipped` — the one legitimate non-verdict: backups are disabled by
 *               configuration, so there is nothing to drill.
 *
 * The two axes are deliberately orthogonal so neither diagnosis masks the
 * other: a probe failure keeps `failure_code='probe_failed'` even when the
 * teardown ALSO failed, and the residue is still recoverable from the same row
 * via `cleanup_status` + `probes.cleanup`.
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
  type ManifestKeyring,
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
  // The restore itself proved out, but the drill could not prove the host is
  // clean afterwards. It is NOT interchangeable with the codes above: those
  // mean "nothing is known to be restorable", this one means "this artifact IS
  // restorable and a full copy of production data is still sitting on the
  // host". Only ever set when no restore-phase code applies — see
  // `cleanup_status` for the axis that survives regardless.
  | 'cleanup_failed'
  | 'drill_not_recorded'
  | 'unexpected';

/** What the drill could not prove it removed. Stable, non-sensitive, no paths. */
export type RestoreDrillResidueKind =
  /** The ephemeral database — a full, unencrypted, untracked copy of production. */
  | 'drill_database'
  /**
   * A PLAINTEXT dump on disk: every tenant's data, readable. Normally the
   * decrypted copy the drill produced — but also the staged artifact itself
   * under `encryption.mode='none'`, where "as stored" already means cleartext.
   */
  | 'decrypted_plaintext'
  /**
   * The staged copy of the artifact as stored. Ciphertext by construction — a
   * cleartext one is reported as `decrypted_plaintext`.
   */
  | 'staged_artifact';

/**
 * WHY a resource counts as residue. `unverified` is not a lesser case: an
 * absence that cannot be proven is treated exactly like a proven presence,
 * because the operator has to go look either way.
 */
export type RestoreDrillResidueReason = 'removal_failed' | 'still_present' | 'unverified';

export interface RestoreDrillResidue {
  kind: RestoreDrillResidueKind;
  reason: RestoreDrillResidueReason;
}

/**
 * The teardown verdict — an axis of its own, never folded into `failure_code`.
 *
 * `clean`  — every resource this drill created was PROVEN gone after teardown.
 * `unsafe` — at least one is still there, or its absence could not be proven.
 *
 * The database column additionally carries `unknown`, which this module never
 * produces: it is the state of a row whose process died between `createDrill`
 * and `finishDrill`, and it means "residue possible, nobody checked".
 */
export type RestoreDrillCleanupStatus = 'clean' | 'unsafe';

export interface RestoreDrillCleanup {
  status: RestoreDrillCleanupStatus;
  residue: readonly RestoreDrillResidue[];
}

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

  /**
   * The keyring the manifest signature is verified against. Lives outside the
   * artifact, so an attacker holding the dump cannot forge a manifest for it.
   *
   * A KEYRING, not a secret: the envelope records `signature_key_version`, and
   * a verifier handed only the CURRENT secret stops verifying every recovery
   * point signed before the last rotation — so rotating the HMAC key would
   * operationally destroy the ability to restore backups that are still inside
   * their retention window. Resolution is by the version the envelope names,
   * and an unknown version fails closed (issue #536, round-2 review of #541).
   */
  manifestKeyring(): ManifestKeyring;

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
   * Does this database still exist? Asked AFTER `dropDatabase`, because a call
   * that returned without throwing is not proof: `DROP DATABASE IF EXISTS`
   * succeeds against a name the server never had, and a pooled/misrouted admin
   * connection can drop nothing at all and still report success.
   *
   * Rejecting is meaningful: the drill cannot prove the copy is gone, which is
   * `unsafe`, not `clean`.
   */
  databaseExists(name: string): Promise<boolean>;

  /**
   * Does this staged file still exist? Same reasoning as `databaseExists`, and
   * this one guards the worse artifact of the two: the DECRYPTED dump.
   */
  fileExists(path: string): Promise<boolean>;

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
  /**
   * The teardown verdict, INDEPENDENT of `failure_code`. `status: 'unsafe'`
   * means a copy of production data is (or may be) still on the host and a
   * human has to remove it — see the runbook, §4.
   */
  cleanup: RestoreDrillCleanup;
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

/**
 * Codes this module raises itself and records verbatim.
 *
 * `cleanup_failed` and `drill_not_recorded` are deliberately absent: they are
 * ASSIGNED from observed state after the try/finally, never thrown, so an error
 * arriving with one of those codes did not come from this module and must not
 * be echoed as if it had.
 */
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
 * Remove one resource and PROVE it is gone.
 *
 * The asymmetry is the whole point:
 *
 *  - a removal that THREW but whose target is provably absent is clean — a
 *    connection dropped after `DROP DATABASE` committed did not leak anything;
 *  - a removal that RETURNED but whose target is still there is residue, which
 *    is exactly the case a `try { … } catch { log }` teardown cannot see;
 *  - a check that could not run at all is residue too. An absence that cannot
 *    be proven is worth nothing here: the operator has to go look either way,
 *    and the alternative is certifying a drill on the strength of a call that
 *    returned.
 */
async function removeAndProveGone(
  kind: RestoreDrillResidueKind,
  remove: () => Promise<void>,
  stillExists: () => Promise<boolean>,
  onProblem: (stage: 'remove' | 'verify', err: unknown) => void,
): Promise<RestoreDrillResidue | null> {
  let removalFailed = false;
  try {
    await remove();
  } catch (err) {
    removalFailed = true;
    onProblem('remove', err);
  }

  try {
    if (await stillExists()) {
      return { kind, reason: removalFailed ? 'removal_failed' : 'still_present' };
    }
    return null;
  } catch (err) {
    onProblem('verify', err);
    return { kind, reason: 'unverified' };
  }
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
    // Every early return below happens before anything was created, so the
    // host carries no residue from this drill. `clean` is a statement of fact
    // here, not an optimistic default.
    cleanup: { status: 'clean', residue: [] },
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
  /** Tracked apart from the rest: this is the file that holds PLAINTEXT. */
  let plaintextPath: string | null = null;
  /**
   * Left DEFINITELY UNASSIGNED on purpose. The teardown in `finally` always
   * runs and always sets it, so there is no initial value that could survive to
   * the status computation — and an optimistic `clean` default sitting here is
   * exactly the shape of the bug this fixes.
   */
  let cleanup: RestoreDrillCleanup;

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

    // The envelope names WHICH key signed it. The keyring resolves that
    // version — never "the current key" — so a recovery point signed before the
    // last rotation stays verifiable for its whole retention window (issue
    // #536, round-2 review of PR #541).
    const declaredKeyVersion = (candidate.signed_manifest as { signature_key_version?: unknown })
      ?.signature_key_version;
    const verified = verifyManifest(candidate.signed_manifest, ports.manifestKeyring());
    if (!verified.ok) {
      // The verdict collapses to one failure code on purpose — no oracle — but
      // the operator still needs the two cases apart, and they have opposite
      // remediations: `key_version_unknown` means THIS DEPLOYMENT no longer
      // holds the key that signed a backup still inside its retention window
      // (restore it into `RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS`), while
      // `signature_mismatch` means the manifest does not match its signature.
      // The reason is a stable code and the key version is an integer, so
      // neither discloses anything.
      ports.log('restore_drill.manifest_unverifiable', {
        drill_id,
        correlation_id,
        reason: verified.reason,
        signature_key_version: typeof declaredKeyVersion === 'number' ? declaredKeyVersion : null,
      });
      throw new TypedError('manifest_unverifiable', 'signed manifest did not verify', {
        reason: verified.reason,
      });
    }
    const manifest: BackupManifest = verified.manifest;

    // ── fetch + bind the STORED bytes to the manifest ────────────────────
    const stagedCipher = ports.stagingPath(`${manifest.backup_id}.artifact`);
    // OWNERSHIP IS REGISTERED BEFORE THE FETCH, for the same reason the
    // plaintext path is registered before `decrypt` below — and this one was the
    // hole that reason did not close (issue #536, round-2 review of PR #541).
    // `fetchArtifact` STREAMS into this destination; a stream that dies after
    // writing bytes leaves them there and throws. Registering on the way OUT —
    // `if (fetched.ephemeral)`, which only runs when the fetch RETURNED — meant
    // the teardown below never saw that partial artifact, swept an empty
    // inventory, and let the drill finish `failed` + `cleanup_status='clean'`: a
    // certification that the host is clean while a truncated production dump
    // sits in the workspace, with no `unsafe` residue audit and no alert. Under
    // `encryption.mode='none'` — legal outside the production profile — those
    // bytes are a CLEARTEXT dump of every tenant.
    //
    // Registering up front is fail-closed and does not depend on any adapter's
    // `catch` being right (a SIGKILL mid-stream has no `catch` at all): the
    // drill NAMED this path, inside its own workspace, so it owns the slot
    // whether or not anything was ever written to it. A slot that was never
    // created is proven absent by `fileExists` and grades `clean` — the sweep's
    // authority is the host, not this bookkeeping.
    ephemeralFiles.add(stagedCipher);
    const fetched = await ports.fetchArtifact(candidate, stagedCipher);
    // A LOCAL candidate is read IN PLACE and reports `ephemeral: false` over the
    // recovery point itself, which must never be registered — the drill would
    // delete the very artifact it exists to validate.
    if (fetched.ephemeral) ephemeralFiles.add(fetched.path);
    // With `mode: 'none'` the artifact AS STORED is already the plaintext dump,
    // so the staged copy is classified — and reported to the operator — with the
    // severity it actually carries, rather than as a merely "staged" (implicitly
    // still-encrypted) file.
    if (manifest.encryption.mode === 'none') plaintextPath = stagedCipher;
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
      // Registered BEFORE the write, not after: a `decrypt` that throws
      // half-way still leaves plaintext bytes at that path, and a teardown that
      // only knows about files whose write SUCCEEDED would walk past them.
      ephemeralFiles.add(stagedPlain);
      plaintextPath = stagedPlain;
      const plain = await ports.decrypt(fetched.path, stagedPlain);
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
    // every tenant's data (#536). Both are swept here, and — since #541 — each
    // sweep is VERIFIED: a teardown that merely did not throw used to leave
    // `failure` null, and the status computed below then CERTIFIED the drill
    // while a full copy of production sat on the host in a database nobody was
    // tracking. Certifying a leak is worse than reporting a failure.
    const residue: RestoreDrillResidue[] = [];

    /**
     * Remove one resource, prove it is gone, and say so exactly once.
     *
     * The log fires on the VERDICT, not on the exception, because the two do
     * not coincide: a removal can return cleanly and leave the resource there
     * (nothing thrown, real leak), and it can throw over a resource that is
     * provably gone (something thrown, nothing leaked). Logging the exception
     * alone is how the old teardown managed to be both noisy and blind.
     */
    const sweep = async (
      kind: RestoreDrillResidueKind,
      event: string,
      impact: string,
      remove: () => Promise<void>,
      stillExists: () => Promise<boolean>,
    ): Promise<void> => {
      const problems: { stage: string; error: string }[] = [];
      const left = await removeAndProveGone(kind, remove, stillExists, (stage, err) => {
        problems.push({ stage, error: redactSecrets((err as Error).message) });
      });

      if (left !== null) {
        residue.push(left);
        // The KIND, never the path or the database name: this reaches operator
        // logs. The runbook turns a kind into the command that removes it.
        ports.log(event, { drill_id, kind, reason: left.reason, problems, impact });
        return;
      }
      if (problems.length > 0) {
        ports.log('restore_drill.teardown_error_recovered', { drill_id, kind, problems });
      }
    };

    if (createdDatabase && databaseName !== null) {
      const name = databaseName;
      await sweep(
        'drill_database',
        'restore_drill.database_not_dropped',
        'ephemeral drill database still exists and holds a full copy of production data',
        () => ports.dropDatabase(name),
        () => ports.databaseExists(name),
      );
    }

    for (const path of ephemeralFiles) {
      const isPlaintext = path === plaintextPath;
      await sweep(
        isPlaintext ? 'decrypted_plaintext' : 'staged_artifact',
        'restore_drill.staged_file_not_removed',
        isPlaintext
          ? 'a DECRYPTED copy of every tenant’s data remains on disk'
          : 'a staged artifact copy remains on disk',
        () => ports.removeFile(path),
        () => ports.fileExists(path),
      );
    }

    cleanup =
      residue.length === 0 ? { status: 'clean', residue: [] } : { status: 'unsafe', residue };
  }

  // The teardown verdict is its OWN axis. It never overwrites a restore-phase
  // diagnosis — a drill that failed its probes AND leaked its database keeps
  // `probe_failed` here and carries the leak in `cleanup_status` — and it never
  // gets swallowed by one either.
  if (failure === null && cleanup.status !== 'clean') failure = 'cleanup_failed';
  probes.cleanup = {
    ok: cleanup.status === 'clean',
    status: cleanup.status,
    residue: cleanup.residue,
  };

  const finished = ports.now();
  const duration_ms = Math.max(0, finished.getTime() - started.getTime());
  // `passed` requires BOTH: the restore proved out and the host is proven clean.
  const status: RestoreDrillStatus = failure === null ? 'passed' : 'failed';

  // Audited BEFORE the row is finished, on purpose: a leaked plaintext copy
  // plus a `finishDrill` that fails is the worst pair in this function, and the
  // operator must still learn about the copy. This is the notice they act on.
  if (cleanup.status !== 'clean') {
    ports.log('restore_drill.unsafe_residue', {
      drill_id,
      correlation_id,
      residue: cleanup.residue,
      restore_verdict: failure === 'cleanup_failed' ? 'restore_proved_out' : failure,
    });
    await ports
      .audit('restore_drill_unsafe_residue', {
        drill_id,
        correlation_id,
        source,
        backup_id: candidate?.backup_id ?? null,
        // Kinds and reasons only — no path, no database name, no key.
        residue: cleanup.residue,
        failure_code: failure,
      })
      .catch((err: unknown) => {
        ports.log('restore_drill.residue_audit_failed', {
          drill_id,
          error: redactSecrets((err as Error).message),
        });
      });
  }

  try {
    await ports.store.finishDrill(drill_id, {
      status,
      finished_at: finished,
      duration_ms,
      probes,
      tombstones_pending: tombstonesPending,
      failure_code: failure,
      // Persisted as its own column so "which drills left a copy of production
      // data behind?" is one indexed predicate, not a jsonb hunt — and so it
      // survives even when `failure_code` is describing the restore phase.
      cleanup_status: cleanup.status,
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
      // Carried out even though the row is unusable: the caller alerts on it,
      // and the residue audit above already fired.
      cleanup,
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
      cleanup_status: cleanup.status,
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
    cleanup,
  };
}
