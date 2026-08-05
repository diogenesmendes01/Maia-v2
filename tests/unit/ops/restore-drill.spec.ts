import { describe, it, expect } from 'vitest';
import {
  assertSafeDatabaseName,
  drillDatabaseName,
  drillFailureCode,
  runRestoreDrill,
  type DrillCandidate,
  type RestoreDrillPorts,
} from '../../../src/ops/backup/drill.js';
import { CRITICAL_TABLES, type ProbeRow } from '../../../src/ops/backup/drill-probes.js';
import {
  MANIFEST_VERSION,
  signManifest,
  type BackupManifest,
} from '../../../src/ops/backup/manifest.js';
import { resolveBackupProfile, type BackupConfigInput } from '../../../src/ops/backup/profile.js';
import {
  signTombstone,
  type TombstoneRecord,
} from '../../../src/ops/retention/tombstones.js';
import { TypedError } from '../../../src/lib/utils.js';

/**
 * Issue #536 §1 — the restore drill. Every port is faked, so the whole
 * lifecycle (fetch → bind → decrypt → restore → probe → reconcile → teardown)
 * runs without S3, Postgres or a `pg_restore` binary.
 *
 * The properties these tests defend, in one line each:
 *   - a drill NEVER reports `passed` for a step it could not prove;
 *   - a drill ALWAYS leaves evidence in `restore_drills`, especially a failure;
 *   - teardown ALWAYS runs — the baseline leaked its database and its
 *     decrypted plaintext on every failing path;
 *   - teardown is PROVEN, not assumed: `passed` requires the ephemeral database
 *     and the decrypted plaintext to be checked gone AFTER the removal, and a
 *     residue is reported on an axis of its own so it can never be masked by,
 *     nor mask, a restore-phase diagnosis (issue #536, review of PR #541);
 *   - the local artifact is never deleted by the drill that reads it.
 */

const MANIFEST_SECRET = 'unit-manifest-secret';
const LEDGER_SECRET = 'unit-ledger-secret';
const PLAIN_DIGEST = 'a'.repeat(64);
const CIPHER_DIGEST = 'c'.repeat(64);
const PLAIN_BYTES = 4096;
const CIPHER_BYTES = 4200;
const BACKUP_ID = '11111111-2222-4333-8444-555555555555';
const WATERMARK = '2026-07-28T03:00:00.000Z';

function cfg(over: Partial<BackupConfigInput> = {}): BackupConfigInput {
  return {
    profile: 'development',
    BACKUP_ENABLED: true,
    BACKUP_DIR: '/backups',
    BACKUP_RETENTION_LOCAL_DAYS: 7,
    BACKUP_RETENTION_CLOUD_DAYS: 30,
    BACKUP_ENCRYPTION_MODE: 'envelope_aes256_gcm',
    BACKUP_ENCRYPTION_KEYRING: '{"k1":"x"}',
    BACKUP_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    BACKUP_S3_BUCKET: 'maia-backups',
    BACKUP_DUMP_TIMEOUT_MS: 1000,
    BACKUP_UPLOAD_TIMEOUT_MS: 1000,
    BACKUP_RESTORE_TIMEOUT_MS: 1000,
    BACKUP_MIN_ARTIFACT_BYTES: 100,
    BACKUP_RPO_TARGET_HOURS: 24,
    BACKUP_RTO_TARGET_MINUTES: 120,
    BACKUP_RESTORE_DRILL_INTERVAL_HOURS: 168,
    RETENTION_DRY_RUN: true,
    ...over,
  };
}

function manifest(over: Partial<BackupManifest> = {}): BackupManifest {
  return {
    manifest_version: MANIFEST_VERSION,
    backup_id: BACKUP_ID,
    correlation_id: 'corr-1',
    started_at: '2026-07-28T03:00:00.000Z',
    finished_at: '2026-07-28T03:10:00.000Z',
    environment: 'production',
    profile: 'production',
    source_id: 'host-abc123',
    app_version: '3.1.0',
    commit: null,
    pg_client_version: null,
    pg_server_version: '16.4',
    dump_format: 'custom',
    migration_head: '107_runtime_trace_attempt_grouping.sql',
    schema_fingerprint: 'b'.repeat(64),
    config_fingerprint: 'd'.repeat(64),
    size_bytes: PLAIN_BYTES,
    sha256: PLAIN_DIGEST,
    encryption: {
      mode: 'envelope_aes256_gcm',
      key_id: 'k1',
      key_version: 1,
      ciphertext_sha256: CIPHER_DIGEST,
    },
    destination: { kind: 's3', locator: 'e'.repeat(32), artifact_ref: 'maia-2026-07-28.dump' },
    verification: {
      catalog_readable: true,
      local_checksum_verified: true,
      remote_checksum_verified: true,
      remote_verification_method: 'provider_checksum',
      remote_verification_reason: 'ok',
      remote_verified_at: '2026-07-28T03:10:00.000Z',
    },
    data_classes_included: ['postgres.messages'],
    data_classes_excluded: ['media.blobs'],
    tombstone_watermark: WATERMARK,
    retention_class: 'backup.artifact',
    delete_after: '2026-08-27T03:10:00.000Z',
    legal_hold: 'none',
    last_restore_drill_at: null,
    last_restore_drill_result: null,
    outcome: 'completed',
    outcome_reason: 'verified',
    ...over,
  };
}

function candidate(over: Partial<DrillCandidate> = {}, m: BackupManifest = manifest()): DrillCandidate {
  return {
    backup_id: BACKUP_ID,
    artifact_ref: 'maia-2026-07-28T03-00-00-111122224333.dump',
    source: 'offsite',
    signed_manifest: signManifest(m, MANIFEST_SECRET, 1),
    ...over,
  };
}

function tombstone(over: Partial<TombstoneRecord> = {}): TombstoneRecord {
  const body = {
    id: over.id ?? 'ts-1',
    tenant_id: 'acme',
    agent_id: 'fin',
    data_class: 'postgres.messages',
    subject_ref: 'pseudo-1',
    resource_locator: null,
    action: 'delete' as const,
    effective_at: over.effective_at ?? new Date('2026-07-29T00:00:00.000Z'),
    origin: 'privacy_request' as const,
    version: 1,
    ...over,
  };
  return {
    ...body,
    hmac: signTombstone(body, LEDGER_SECRET),
    hmac_key_version: 1,
  };
}

function healthyProbeRows(): Record<string, ProbeRow | null> {
  return {
    core_tables_present: { present: CRITICAL_TABLES.length },
    tenant_seed_present: { tenants: 1, agents: 1 },
    tenant_scope_valid: { unscoped_mensagens: 0, unscoped_conversas: 0 },
    conversation_integrity: { orphan_mensagens: 0 },
    tombstone_ledger_restored: { tombstones: 0 },
    financial_rows_readable: { transacoes: 5 },
    audit_trail_readable: { audit_logs: 5 },
    outbox_dispatchable: { pending: 0 },
    migration_head_matches: { head: '107_runtime_trace_attempt_grouping.sql', applied: 97 },
  };
}

interface Harness {
  ports: RestoreDrillPorts;
  drills: Record<string, unknown>[];
  audits: { action: string; metadata: Record<string, unknown> }[];
  logs: { event: string; detail: Record<string, unknown> }[];
  removed: string[];
  droppedDatabases: string[];
  createdDatabases: string[];
  restored: { db: string; path: string }[];
  /** Which resources the drill actually asked about AFTER removing them. */
  existenceChecks: string[];
}

/**
 * The fake host keeps REAL state: `createIsolatedDatabase` and the staging
 * writes add to it, `dropDatabase` and `removeFile` take away from it, and the
 * existence ports answer from it. So a test that makes `dropDatabase` throw
 * gets a host where the database is genuinely still there — no separate knob
 * to remember, and no way to write a test whose host is self-contradictory.
 *
 * `HostState` is for the OTHER case, the one no exception announces: the
 * removal reports success and the resource is still there anyway.
 */
interface HostState {
  /** Force "still present" regardless of what `dropDatabase` reported. */
  databasesLeft?: (name: string) => boolean;
  /** Force "still present" regardless of what `removeFile` reported. */
  filesLeft?: (path: string) => boolean;
}

function harness(
  over: Partial<RestoreDrillPorts> = {},
  seed: {
    candidates?: Partial<Record<'local' | 'offsite', DrillCandidate | null>>;
    tombstones?: TombstoneRecord[];
    ledgerAvailable?: boolean;
    probeRows?: Record<string, ProbeRow | null>;
    host?: HostState;
  } = {},
): Harness {
  const drills: Record<string, unknown>[] = [];
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const logs: { event: string; detail: Record<string, unknown> }[] = [];
  const removed: string[] = [];
  const droppedDatabases: string[] = [];
  const createdDatabases: string[] = [];
  const restored: { db: string; path: string }[] = [];
  const existenceChecks: string[] = [];
  const liveDatabases = new Set<string>();
  const liveFiles = new Set<string>();
  let clock = new Date('2026-08-01T05:00:00.000Z').getTime();

  const candidates = seed.candidates ?? { offsite: candidate() };

  const ports: RestoreDrillPorts = {
    now: () => new Date((clock += 1000)),
    newId: () => '99999999-8888-4777-8666-555555555555',
    selectCandidate: async (source) => candidates[source] ?? null,
    manifestSecret: () => ({ secret: MANIFEST_SECRET }),
    stagingPath: (name) => `/backups/restore-drill/${name}`,
    fetchArtifact: async (c, dest) => {
      const path = c.source === 'offsite' ? dest : `/backups/${c.artifact_ref}`;
      liveFiles.add(path);
      return {
        path,
        sha256: CIPHER_DIGEST,
        bytes: CIPHER_BYTES,
        ephemeral: c.source === 'offsite',
      };
    },
    decrypt: async (_src, dest) => {
      liveFiles.add(dest);
      return { sha256: PLAIN_DIGEST, bytes: PLAIN_BYTES };
    },
    createIsolatedDatabase: async (name) => {
      createdDatabases.push(name);
      liveDatabases.add(name);
    },
    restore: async (db, path) => {
      restored.push({ db, path });
    },
    runProbes: async () => seed.probeRows ?? healthyProbeRows(),
    dropDatabase: async (name) => {
      droppedDatabases.push(name);
      liveDatabases.delete(name);
    },
    removeFile: async (path) => {
      removed.push(path);
      liveFiles.delete(path);
    },
    databaseExists: async (name) => {
      existenceChecks.push(`db:${name}`);
      return seed.host?.databasesLeft?.(name) ?? liveDatabases.has(name);
    },
    fileExists: async (path) => {
      existenceChecks.push(`file:${path}`);
      return seed.host?.filesLeft?.(path) ?? liveFiles.has(path);
    },
    readLedger: async () => ({
      available: seed.ledgerAvailable ?? true,
      tombstones: seed.tombstones ?? [],
    }),
    tombstoneSecret: () => LEDGER_SECRET,
    store: {
      createDrill: async (row) => {
        drills.push({ ...row });
      },
      finishDrill: async (id, patch) => {
        const row = drills.find((d) => d.id === id);
        if (row) Object.assign(row, patch);
      },
    },
    audit: async (action, metadata) => {
      audits.push({ action, metadata });
    },
    log: (event, detail) => {
      logs.push({ event, detail });
    },
    ...over,
  };

  return {
    ports,
    drills,
    audits,
    logs,
    removed,
    droppedDatabases,
    createdDatabases,
    restored,
    existenceChecks,
  };
}

const devProfile = () => resolveBackupProfile(cfg());
const prodProfile = () =>
  resolveBackupProfile(cfg({ profile: 'production', BACKUP_OFFSITE_REQUIRED: true }));

describe('restore drill — the happy path is EVIDENCE, not an assertion', () => {
  it('fetches the OFF-SITE artifact, decrypts it, restores, probes and passes', async () => {
    const h = harness();
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(result.status).toBe('passed');
    expect(result.failure_code).toBeNull();
    // The gap the issue names first: the drill consumed the off-site copy, not
    // "the newest local dump by mtime".
    expect(result.source).toBe('offsite');
    expect(result.backup_id).toBe(BACKUP_ID);
    expect(h.restored).toHaveLength(1);
  });

  it('writes the result to restore_drills — the table #520 created and nothing filled', async () => {
    const h = harness();
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(h.drills).toHaveLength(1);
    expect(h.drills[0]).toMatchObject({
      id: result.drill_id,
      backup_run_id: BACKUP_ID,
      source: 'offsite',
      status: 'passed',
      failure_code: null,
      tombstones_pending: 0,
    });
    // Feeds the measured RTO (`src/ops/backup/rpo.ts`).
    expect(h.drills[0]?.duration_ms).toBeGreaterThan(0);
    expect(h.drills[0]?.finished_at).toBeInstanceOf(Date);
  });

  it('audits start and completion with codes only — no path, no key, no URL', async () => {
    const h = harness();
    await runRestoreDrill(h.ports, prodProfile());

    expect(h.audits.map((a) => a.action)).toEqual([
      'restore_drill_started',
      'restore_drill_completed',
    ]);
    const serialized = JSON.stringify(h.audits);
    expect(serialized).not.toContain('/backups');
    expect(serialized).not.toContain('maia-backups');
    expect(serialized).not.toMatch(/postgres:\/\//);
  });

  it('records the full probe suite, not one count', async () => {
    const h = harness();
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(Object.keys(result.probes)).toEqual(
      expect.arrayContaining([
        'core_tables_present',
        'tenant_seed_present',
        'tenant_scope_valid',
        'conversation_integrity',
        'tombstone_ledger_restored',
        'financial_rows_readable',
        'reconciliation',
      ]),
    );
  });
});

describe('restore drill — teardown always runs (the baseline leaked on failure)', () => {
  it('drops the ephemeral database and removes staged files on SUCCESS', async () => {
    const h = harness();
    await runRestoreDrill(h.ports, prodProfile());
    expect(h.droppedDatabases).toEqual(h.createdDatabases);
    expect(h.removed).toContain(`/backups/restore-drill/${BACKUP_ID}.artifact`);
    expect(h.removed).toContain(`/backups/restore-drill/${BACKUP_ID}.plain`);
  });

  it('drops the ephemeral database and removes staged files when the RESTORE throws', async () => {
    const h = harness({
      restore: async () => {
        throw new TypedError('restore_failed', 'pg_restore exited with code 1', {});
      },
    });
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(result.status).toBe('failed');
    expect(result.failure_code).toBe('restore_failed');
    // The whole point: the old script's cleanup lived on the happy path, so a
    // failed drill left a full copy of production data on the host.
    expect(h.droppedDatabases).toEqual(h.createdDatabases);
    expect(h.droppedDatabases).toHaveLength(1);
    expect(h.removed).toContain(`/backups/restore-drill/${BACKUP_ID}.plain`);
  });

  it('never deletes a LOCAL artifact it read in place', async () => {
    const h = harness({}, { candidates: { local: candidate({ source: 'local' }) } });
    const result = await runRestoreDrill(h.ports, devProfile());

    expect(result.source).toBe('local');
    expect(result.status).toBe('passed');
    // The recovery point survives the drill that validated it.
    expect(h.removed).not.toContain('/backups/maia-2026-07-28T03-00-00-111122224333.dump');
    expect(h.removed).toContain(`/backups/restore-drill/${BACKUP_ID}.plain`);
  });

  it('does not try to drop a database it never created', async () => {
    const h = harness({
      createIsolatedDatabase: async () => {
        throw new Error('permission denied');
      },
    });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.failure_code).toBe('isolation_failed');
    expect(h.droppedDatabases).toEqual([]);
  });

  /**
   * CONTRACT CHANGED (issue #536, round-2 review of PR #541).
   *
   * This test used to assert `status === 'passed'` — a refused `DROP DATABASE`
   * was pinned as an acceptable outcome for a drill that still gets certified.
   * That was the defect, pinned: the teardown caught only to log, `failure`
   * stayed null, and the status computed afterwards certified the drill while a
   * full copy of production data remained on the host, in plaintext, in a
   * database nobody was tracking. A green drill that leaks a production copy is
   * worse than a red one — it teaches the operator to trust a harmful signal.
   *
   * What survives from the old assertion, because it was right: the drill must
   * still NOT THROW, and it must still log the leak with its impact. What
   * changed is the verdict.
   */
  it('does NOT certify a drill whose ephemeral database could not be dropped', async () => {
    const h = harness({
      dropDatabase: async () => {
        throw new Error('still connected');
      },
    });
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(result.status).toBe('failed');
    expect(result.failure_code).toBe('cleanup_failed');
    expect(result.cleanup).toEqual({
      status: 'unsafe',
      residue: [{ kind: 'drill_database', reason: 'removal_failed' }],
    });
    // Still no throw, and the operator log is still there.
    const leak = h.logs.find((l) => l.event === 'restore_drill.database_not_dropped');
    expect(leak?.detail.impact).toContain('full copy of production data');
  });
});

describe('restore drill — `passed` is PROVEN clean, not assumed clean (#541)', () => {
  it('asks the host whether each resource is really gone, AFTER removing it', async () => {
    const h = harness();
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(result.status).toBe('passed');
    expect(result.cleanup).toEqual({ status: 'clean', residue: [] });
    // The proof itself: a check per resource the drill created.
    expect(h.existenceChecks).toEqual([
      `db:${h.createdDatabases[0]}`,
      `file:/backups/restore-drill/${BACKUP_ID}.artifact`,
      `file:/backups/restore-drill/${BACKUP_ID}.plain`,
    ]);
    expect(h.drills[0]).toMatchObject({ status: 'passed', cleanup_status: 'clean' });
    expect(h.drills[0]?.probes).toMatchObject({ cleanup: { ok: true, status: 'clean' } });
  });

  it('fails when DROP DATABASE reports success and the database is still there', async () => {
    // The case a `try { drop() } catch { log() }` teardown is blind to, and the
    // reason the check exists at all: `DROP DATABASE IF EXISTS` also "succeeds"
    // against a name the server never had.
    const h = harness({}, { host: { databasesLeft: () => true } });
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(result.status).toBe('failed');
    expect(result.failure_code).toBe('cleanup_failed');
    expect(result.cleanup.residue).toEqual([
      { kind: 'drill_database', reason: 'still_present' },
    ]);
    // The removal was attempted and reported fine — only the proof caught it.
    expect(h.droppedDatabases).toEqual(h.createdDatabases);
  });

  it('fails when the DECRYPTED plaintext survives the removal', async () => {
    const h = harness(
      {},
      { host: { filesLeft: (p) => p.endsWith('.plain') } },
    );
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(result.status).toBe('failed');
    expect(result.failure_code).toBe('cleanup_failed');
    expect(result.cleanup.residue).toEqual([
      { kind: 'decrypted_plaintext', reason: 'still_present' },
    ]);
    const leak = h.logs.find((l) => l.event === 'restore_drill.staged_file_not_removed');
    expect(leak?.detail.kind).toBe('decrypted_plaintext');
  });

  it('treats an absence it CANNOT PROVE exactly like a proven leak', async () => {
    // `fileExists` rejecting means the drill has no idea. Fail-closed: the
    // operator has to go look either way.
    const h = harness({
      fileExists: async () => {
        throw new Error('EACCES');
      },
    });
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(result.status).toBe('failed');
    expect(result.failure_code).toBe('cleanup_failed');
    expect(result.cleanup.residue).toEqual([
      { kind: 'staged_artifact', reason: 'unverified' },
      { kind: 'decrypted_plaintext', reason: 'unverified' },
    ]);
  });

  it('is clean when the removal threw but the resource is provably gone', async () => {
    // The mirror case, and the reason the check is the authority rather than
    // the call: a connection dropped after `DROP DATABASE` committed leaked
    // nothing, and reporting it as a leak would cry wolf.
    const h = harness(
      {
        dropDatabase: async () => {
          throw new Error('connection reset after commit');
        },
      },
      { host: { databasesLeft: () => false } },
    );
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(result.status).toBe('passed');
    expect(result.cleanup).toEqual({ status: 'clean', residue: [] });
  });

  it('registers the plaintext path BEFORE decrypting, so a half-written dump is swept', async () => {
    const h = harness({
      decrypt: async () => {
        throw new TypedError('backup_decrypt_failed', 'GCM tag mismatch at byte 4M', {});
      },
    });
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(result.failure_code).toBe('decryption_failed');
    // A teardown that only knew about files whose write SUCCEEDED would walk
    // past the partial plaintext this failure left behind.
    expect(h.removed).toContain(`/backups/restore-drill/${BACKUP_ID}.plain`);
    expect(h.existenceChecks).toContain(`file:/backups/restore-drill/${BACKUP_ID}.plain`);
  });
});

describe('restore drill — a probe failure and a residue never mask each other (#541)', () => {
  it('keeps the RESTORE diagnosis in failure_code and the residue in cleanup_status', async () => {
    const rows = healthyProbeRows();
    rows.tenant_seed_present = { tenants: 0, agents: 0 };
    const h = harness({}, { probeRows: rows, host: { databasesLeft: () => true } });
    const result = await runRestoreDrill(h.ports, prodProfile());

    // Two different diagnoses, two different remediations, both recoverable
    // from the persisted row.
    expect(result.failure_code).toBe('probe_failed');
    expect(result.cleanup.status).toBe('unsafe');
    expect(h.drills[0]).toMatchObject({
      status: 'failed',
      failure_code: 'probe_failed',
      cleanup_status: 'unsafe',
    });
    expect(h.drills[0]?.probes).toMatchObject({
      tenant_seed_present: { ok: false },
      cleanup: { ok: false, status: 'unsafe' },
    });
  });

  it('uses cleanup_failed ONLY when the restore itself proved out', async () => {
    const h = harness({}, { host: { databasesLeft: () => true } });
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(result.failure_code).toBe('cleanup_failed');
    // The restore-phase evidence is intact — this artifact IS restorable; what
    // is not true is that the host is clean.
    expect(result.probes).toMatchObject({ tenant_seed_present: { ok: true } });
    expect(result.tombstones_pending).toBe(0);
  });

  it('audits the residue as its OWN action, with codes only', async () => {
    const h = harness({}, { host: { databasesLeft: () => true } });
    await runRestoreDrill(h.ports, prodProfile());

    const residue = h.audits.find((a) => a.action === 'restore_drill_unsafe_residue');
    expect(residue?.metadata).toMatchObject({
      residue: [{ kind: 'drill_database', reason: 'still_present' }],
      failure_code: 'cleanup_failed',
    });
    // `restore_drill_failed` still closes the drill — the residue action is an
    // addition, not a replacement.
    expect(h.audits.map((a) => a.action)).toEqual([
      'restore_drill_started',
      'restore_drill_unsafe_residue',
      'restore_drill_failed',
    ]);
    const serialized = JSON.stringify(h.audits);
    expect(serialized).not.toContain('/backups');
    expect(serialized).not.toContain(h.createdDatabases[0]);
  });

  it('announces the residue even when the drill row cannot be finished', async () => {
    // The worst pair in this function: a leaked plaintext copy AND no evidence
    // row. The operator must still learn about the copy, so the residue audit
    // fires BEFORE `finishDrill`.
    const h = harness(
      {
        store: {
          createDrill: async () => undefined,
          finishDrill: async () => {
            throw new Error('update failed');
          },
        },
      },
      { host: { filesLeft: (p) => p.endsWith('.plain') } },
    );
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(result.failure_code).toBe('drill_not_recorded');
    expect(result.cleanup.status).toBe('unsafe');
    expect(h.audits.map((a) => a.action)).toContain('restore_drill_unsafe_residue');
  });
});

describe('restore drill — fail-closed selection', () => {
  it('FAILS (never skips) when no artifact carries a signed manifest', async () => {
    const h = harness({}, { candidates: {} });
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(result.status).toBe('failed');
    expect(result.failure_code).toBe('no_drill_candidate');
    // Nullable `backup_run_id` exists precisely for this row: the attempt
    // matters even when nothing was selected.
    expect(h.drills[0]).toMatchObject({ backup_run_id: null, status: 'failed' });
    expect(h.audits.at(-1)?.action).toBe('restore_drill_failed');
  });

  it('refuses to certify a profile that REQUIRES off-site using the local copy', async () => {
    const h = harness({}, { candidates: { local: candidate({ source: 'local' }) } });
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(result.status).toBe('failed');
    expect(result.failure_code).toBe('no_offsite_candidate');
  });

  it('falls back to the local copy when the profile does not require off-site', async () => {
    const h = harness({}, { candidates: { local: candidate({ source: 'local' }) } });
    const result = await runRestoreDrill(h.ports, devProfile());
    expect(result.status).toBe('passed');
    expect(result.source).toBe('local');
  });

  it('skips — with a code — only when backups are disabled by configuration', async () => {
    const h = harness();
    const result = await runRestoreDrill(h.ports, resolveBackupProfile(cfg({ BACKUP_ENABLED: false })));
    expect(result.status).toBe('skipped');
    expect(result.failure_code).toBe('backups_disabled');
    // `readReadinessFacts` ignores skipped rows, so readiness keeps saying
    // "no drill has ever run" rather than being fooled into OK.
    expect(h.drills).toHaveLength(0);
  });

  it('fails when a candidate lookup throws, rather than proceeding blind', async () => {
    const h = harness({
      selectCandidate: async () => {
        throw new Error('db down');
      },
    });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.failure_code).toBe('no_drill_candidate');
  });
});

describe('restore drill — the manifest is the contract', () => {
  it('refuses a manifest VERSION this build does not understand (v1 under v2 semantics)', async () => {
    // A v1 manifest's `remote_checksum_verified` could be true because the
    // uploader's own metadata stamp came back from HEAD.
    const legacy = { manifest: { ...manifest(), manifest_version: 1 }, signature: 'x', signature_alg: 'HMAC-SHA256', signature_key_version: 1 };
    const h = harness({}, { candidates: { offsite: candidate({ signed_manifest: legacy }) } });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.failure_code).toBe('manifest_version_unsupported');
  });

  it('refuses a FORGED manifest', async () => {
    const signed = signManifest(manifest(), MANIFEST_SECRET, 1);
    const forged = { ...signed, manifest: { ...signed.manifest, size_bytes: 1 } };
    const h = harness({}, { candidates: { offsite: candidate({ signed_manifest: forged }) } });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.failure_code).toBe('manifest_unverifiable');
    expect(h.drills[0]).toMatchObject({ status: 'failed', failure_code: 'manifest_unverifiable' });
  });

  it('refuses a manifest signed with a different secret', async () => {
    const h = harness({ manifestSecret: () => ({ secret: 'a-different-secret' }) });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.failure_code).toBe('manifest_unverifiable');
  });

  it('binds the FETCHED bytes to the manifest ciphertext digest', async () => {
    const h = harness({
      fetchArtifact: async (_c, dest) => ({
        path: dest,
        sha256: 'f'.repeat(64),
        bytes: CIPHER_BYTES,
        ephemeral: true,
      }),
    });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.failure_code).toBe('artifact_checksum_mismatch');
    // Never reached the database.
    expect(h.createdDatabases).toEqual([]);
  });

  /**
   * A check nothing else in the system performs: the writer computes the
   * plaintext digest and every later reader (until now) only compared the
   * ciphertext.
   */
  it('binds the DECRYPTED bytes to the manifest plaintext digest', async () => {
    const h = harness({ decrypt: async () => ({ sha256: 'e'.repeat(64), bytes: PLAIN_BYTES }) });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.failure_code).toBe('plaintext_checksum_mismatch');
    expect(h.createdDatabases).toEqual([]);
  });

  it('binds the decrypted SIZE too', async () => {
    const h = harness({ decrypt: async () => ({ sha256: PLAIN_DIGEST, bytes: PLAIN_BYTES + 1 }) });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.failure_code).toBe('plaintext_checksum_mismatch');
  });

  it('maps a decryption failure to a stable code and never reaches the database', async () => {
    const h = harness({
      decrypt: async () => {
        throw new TypedError('backup_key_unavailable', "artifact references key 'k9'", {});
      },
    });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.failure_code).toBe('decryption_failed');
    expect(h.createdDatabases).toEqual([]);
  });

  it('skips decryption for an unencrypted artifact and binds the plaintext digest directly', async () => {
    const plain = manifest({
      encryption: { mode: 'none', key_id: null, key_version: null, ciphertext_sha256: null },
      size_bytes: CIPHER_BYTES,
      sha256: CIPHER_DIGEST,
    });
    const h = harness(
      {
        decrypt: async () => {
          throw new Error('decrypt must not be called');
        },
      },
      { candidates: { offsite: candidate({}, plain) } },
    );
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.status).toBe('passed');
  });

  it('maps a fetch failure to artifact_fetch_failed', async () => {
    const h = harness({
      fetchArtifact: async () => {
        throw new TypedError('artifact_fetch_failed', 'could not read the off-site object', {});
      },
    });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.failure_code).toBe('artifact_fetch_failed');
  });
});

describe('restore drill — probes decide, and a required failure fails the drill', () => {
  it('fails when a required probe fails, and records WHICH', async () => {
    const rows = healthyProbeRows();
    rows.tenant_seed_present = { tenants: 0, agents: 0 };
    const h = harness({}, { probeRows: rows });
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(result.status).toBe('failed');
    expect(result.failure_code).toBe('probe_failed');
    expect(h.drills[0]?.probes).toMatchObject({ tenant_seed_present: { ok: false } });
  });

  it('passes with a WARNING when only informational probes are dirty', async () => {
    const rows = healthyProbeRows();
    rows.outbox_dispatchable = { pending: 9 };
    const h = harness({}, { probeRows: rows });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.status).toBe('passed');
    expect(result.probes.outbox_dispatchable).toMatchObject({ ok: false, detail: { pending: 9 } });
  });
});

describe('restore drill — the anti-resurrection gate is exercised, not described', () => {
  it('counts the tombstones a real restore would still owe, and reports the gate verdict', async () => {
    const h = harness({}, { tombstones: [tombstone({ id: 'ts-1' }), tombstone({ id: 'ts-2' })] });
    const result = await runRestoreDrill(h.ports, prodProfile());

    expect(result.status).toBe('passed');
    expect(result.tombstones_pending).toBe(2);
    expect(result.probes.reconciliation).toMatchObject({
      ok: true,
      pending: 2,
      // Nothing is replayed in a drill, so the gate correctly refuses release.
      release_without_replay: false,
      release_reason: 'tombstones_not_reapplied',
    });
    expect(h.drills[0]?.tombstones_pending).toBe(2);
  });

  it('reports release_without_replay=true only when the ledger has nothing newer', async () => {
    const h = harness(
      {},
      { tombstones: [tombstone({ id: 'ts-old', effective_at: new Date('2026-07-01T00:00:00.000Z') })] },
    );
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.tombstones_pending).toBe(0);
    expect(result.probes.reconciliation).toMatchObject({ release_without_replay: true, release_reason: 'ok' });
  });

  it('FAILS the drill when the ledger cannot be read (unreadable ≠ empty)', async () => {
    const h = harness({}, { ledgerAvailable: false });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.status).toBe('failed');
    expect(result.failure_code).toBe('reconciliation_blocked');
    expect(result.probes.reconciliation).toMatchObject({ blocked_reason: 'ledger_unavailable' });
  });

  it('FAILS the drill when a ledger row does not verify', async () => {
    const planted: TombstoneRecord = { ...tombstone({ id: 'ts-planted' }), hmac: 'deadbeef' };
    const h = harness({}, { tombstones: [planted] });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.failure_code).toBe('reconciliation_blocked');
    expect(result.probes.reconciliation).toMatchObject({
      blocked_reason: 'invalid_tombstone',
      invalid_tombstones: 1,
    });
  });

  it('FAILS the drill when the manifest carries no watermark', async () => {
    const h = harness(
      {},
      { candidates: { offsite: candidate({}, manifest({ tombstone_watermark: null })) } },
    );
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.failure_code).toBe('reconciliation_blocked');
    expect(result.probes.reconciliation).toMatchObject({ blocked_reason: 'watermark_missing' });
  });

  it('blocks — never silently passes — when the ledger secret is unavailable', async () => {
    const h = harness({
      tombstoneSecret: () => {
        throw new TypedError('tombstone_secret_missing', 'no master secret', {});
      },
    });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.failure_code).toBe('reconciliation_blocked');
  });

  it('records only counts per class — the plan itself never reaches the row', async () => {
    const h = harness({}, { tombstones: [tombstone({ id: 'ts-1' })] });
    const result = await runRestoreDrill(h.ports, prodProfile());
    const recon = result.probes.reconciliation as { by_class: Record<string, number> };
    expect(recon.by_class).toEqual({ 'postgres.messages': 1 });
    expect(JSON.stringify(result.probes)).not.toContain('pseudo-1');
  });
});

describe('restore drill — a drill that left no evidence is not a drill', () => {
  it('fails when the drill row cannot be created', async () => {
    const h = harness({
      store: {
        createDrill: async () => {
          throw new Error('insert failed');
        },
        finishDrill: async () => undefined,
      },
    });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.status).toBe('failed');
    expect(result.failure_code).toBe('drill_not_recorded');
    // Nothing destructive was attempted without a place to record it.
    expect(h.createdDatabases).toEqual([]);
  });

  it('downgrades a passing drill whose RESULT could not be persisted', async () => {
    const h = harness({
      store: {
        createDrill: async () => undefined,
        finishDrill: async () => {
          throw new Error('update failed');
        },
      },
    });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.status).toBe('failed');
    expect(result.failure_code).toBe('drill_not_recorded');
    // Teardown still happened.
    expect(h.droppedDatabases).toHaveLength(1);
  });

  it('a broken audit sink degrades observability, never the drill', async () => {
    const h = harness({
      audit: async () => {
        throw new Error('audit sink down');
      },
    });
    const result = await runRestoreDrill(h.ports, prodProfile());
    expect(result.status).toBe('passed');
    expect(h.logs.map((l) => l.event)).toEqual(
      expect.arrayContaining([
        'restore_drill.start_audit_failed',
        'restore_drill.outcome_audit_failed',
      ]),
    );
  });

  it('redacts a connection string that reaches a failure log', async () => {
    const h = harness({
      restore: async () => {
        throw new TypedError(
          'restore_failed',
          'could not connect to postgres://maia:s3cr3t@db:5432/maia',
          {},
        );
      },
    });
    await runRestoreDrill(h.ports, prodProfile());
    const failed = h.logs.find((l) => l.event === 'restore_drill.failed');
    expect(String(failed?.detail.error)).not.toContain('s3cr3t');
    expect(String(failed?.detail.error)).toContain('[redacted]');
  });
});

describe('drillDatabaseName / assertSafeDatabaseName', () => {
  it('discriminates two drills started in the same second', () => {
    const at = new Date('2026-08-01T05:00:00.000Z');
    const a = drillDatabaseName('maia', at, '11111111-2222-4333-8444-555555555555');
    const b = drillDatabaseName('maia', at, '99999999-8888-4777-8666-555555555555');
    expect(a).not.toBe(b);
  });

  it('produces a bare lowercase identifier that the DDL guard accepts', () => {
    const name = drillDatabaseName('Maia-Prod DB', new Date('2026-08-01T05:00:00.000Z'), 'abc-def');
    expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(assertSafeDatabaseName(name)).toBe(name);
  });

  it('refuses anything that could carry a quote out of interpolated DDL', () => {
    for (const bad of [
      'maia"; DROP DATABASE maia; --',
      'maia drill',
      'MaiaDrill',
      '1maia',
      '',
      'maia-drill',
      'a'.repeat(64),
    ]) {
      expect(() => assertSafeDatabaseName(bad)).toThrow(TypedError);
    }
  });

  it('never echoes the offending name in full', () => {
    try {
      assertSafeDatabaseName('x'.repeat(500));
      throw new Error('should have thrown');
    } catch (err) {
      const details = (err as TypedError).details as { name_sample: string };
      expect(details.name_sample.length).toBeLessThanOrEqual(64);
    }
  });
});

describe('drillFailureCode', () => {
  it('maps the shared primitives onto this module vocabulary', () => {
    expect(drillFailureCode(new TypedError('backup_checksum_mismatch', '', {}))).toBe(
      'artifact_checksum_mismatch',
    );
    expect(drillFailureCode(new TypedError('backup_keyring_missing', '', {}))).toBe(
      'decryption_failed',
    );
    expect(drillFailureCode(new TypedError('unsafe_artifact_ref', '', {}))).toBe(
      'artifact_fetch_failed',
    );
  });

  it('never echoes an unrecognised code', () => {
    expect(drillFailureCode(new TypedError('postgres://user:pw@host/db', '', {}))).toBe('unexpected');
    expect(drillFailureCode(new Error('boom'))).toBe('unexpected');
    expect(drillFailureCode(null)).toBe('unexpected');
  });

  it('does not accept `cleanup_failed` from a thrown error', () => {
    // It is ASSIGNED from observed teardown state, never thrown. An error
    // arriving with that code did not come from this module, and letting it
    // through would let a restore-phase failure disguise itself as "the
    // artifact is fine, only the host is dirty".
    expect(drillFailureCode(new TypedError('cleanup_failed', '', {}))).toBe('unexpected');
    expect(drillFailureCode(new TypedError('drill_not_recorded', '', {}))).toBe('unexpected');
  });
});
