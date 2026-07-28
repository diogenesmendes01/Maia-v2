import { describe, it, expect, vi } from 'vitest';
import {
  runVerifiedBackup,
  artifactName,
  type BackupPorts,
  type UploadOutcome,
} from '../../../src/ops/backup/service.js';
import { resolveBackupProfile, type BackupConfigInput } from '../../../src/ops/backup/profile.js';
import { verifyManifest } from '../../../src/ops/backup/manifest.js';
import {
  canReleaseTraffic,
  planReconciliation,
} from '../../../src/ops/retention/tombstones.js';
import { TypedError } from '../../../src/lib/utils.js';

/**
 * Issue #520 — the runner shared by cron and CLI. Every port is faked, so the
 * whole lifecycle is exercised without pg_dump, Postgres or S3.
 */

const SECRET = 'unit-manifest-secret';
const DIGEST = 'a'.repeat(64);
const ENC_DIGEST = 'c'.repeat(64);

function cfg(over: Partial<BackupConfigInput> = {}): BackupConfigInput {
  return {
    profile: 'development',
    BACKUP_ENABLED: true,
    BACKUP_DIR: '/backups',
    BACKUP_RETENTION_LOCAL_DAYS: 7,
    BACKUP_RETENTION_CLOUD_DAYS: 30,
    BACKUP_ENCRYPTION_MODE: 'none',
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

interface Harness {
  ports: BackupPorts;
  runs: Record<string, unknown>[];
  manifests: { runId: string; signed: unknown }[];
  audits: { action: string; metadata: Record<string, unknown> }[];
  logs: { event: string; detail: Record<string, unknown> }[];
  removed: string[];
  promoted: { from: string; to: string }[];
  /**
   * Files "on disk", path → the run that wrote them. Round-1 P1: the old fake
   * only RECORDED promotions, so a second run publishing over the first looked
   * identical to two independent successes. This models the real thing.
   */
  fs: Map<string, string>;
}

function harness(over: Partial<BackupPorts> = {}, opts: { frozenClock?: boolean; id?: string } = {}): Harness {
  const runs: Record<string, unknown>[] = [];
  const manifests: { runId: string; signed: unknown }[] = [];
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const logs: { event: string; detail: Record<string, unknown> }[] = [];
  const removed: string[] = [];
  const promoted: { from: string; to: string }[] = [];
  const fs = new Map<string, string>();
  /** Mirrors the partial unique index: at most one non-terminal run. */
  let activeRunId: string | null = null;
  let clock = new Date('2026-07-28T03:00:00.000Z').getTime();

  const ports: BackupPorts = {
    now: () => new Date(opts.frozenClock ? clock : (clock += 1000)),
    newId: () => opts.id ?? '11111111-2222-4333-8444-555555555555',
    resolvePath: (name) => `/backups/${name}`,
    ensureBackupDir: async () => undefined,
    dump: async () => undefined,
    readCatalog: async () => true,
    digest: async (p) =>
      p.endsWith('.enc.partial')
        ? { sha256: ENC_DIGEST, bytes: 2048 }
        : { sha256: DIGEST, bytes: 1024 },
    encrypt: async () => ({ key_id: 'k1' }),
    // NO-REPLACE, like `link(2)`. A collision must be a loud failure, not a
    // silent overwrite — that is the whole point of the finding.
    promote: async (from, to) => {
      if (fs.has(to)) {
        throw new TypedError('promote_failed', 'destination already exists', { cause: 'EEXIST' });
      }
      promoted.push({ from, to });
      fs.set(to, opts.id ?? 'run');
    },
    remove: async (p) => {
      removed.push(p);
      fs.delete(p);
    },
    upload: async (): Promise<UploadOutcome> => ({
      locator: 'f'.repeat(32),
      remote_bytes: 1024,
      remote_sha256: DIGEST,
    }),
    // Round-1 P1: the old fake was `async () => true`, which let the service
    // record a verified off-site copy no matter what the destination said. The
    // port now returns the METHOD, and the service must carry it into the
    // manifest — `none` is what an unverifiable copy looks like.
    verifyRemote: async () => ({
      verified: true,
      method: 'provider_checksum' as const,
      reason: 'ok' as const,
    }),
    provenance: async () => ({
      environment: 'development',
      source_id: 'host-9f2c',
      app_version: '3.1.0',
      commit: 'd93624b',
      pg_client_version: '16.4',
      pg_server_version: '16.4',
      migration_head: '102_data_lifecycle.sql',
      schema_fingerprint: 'b'.repeat(64),
      config_fingerprint: 'b'.repeat(64),
    }),
    // Round-1 P1: the old fake returned a bare Date, so "ledger empty" and
    // "ledger unreachable" were indistinguishable — exactly the collapse the
    // production code had. The fake now models a REACHABILITY probe, and the
    // cases below drive it into all three states.
    tombstoneWatermark: async (reference: Date) => ({
      available: true,
      watermark: reference,
      rows_present: true,
    }),
    manifestSecret: () => ({ secret: SECRET, key_version: 1 }),
    // Round-1 P2: the old store was a bag of pushes, so a run left in `running`
    // looked harmless. This one models `backup_runs_single_active_uq` — at most
    // ONE non-terminal row — which is what turns a stranded row into the
    // permanent outage the finding describes.
    store: {
      createRun: async (row) => {
        if (activeRunId !== null) {
          throw new TypedError(
            'backup_runs_single_active_uq',
            'a non-terminal backup run already exists',
            { holder: activeRunId },
          );
        }
        activeRunId = row.id;
        runs.push({ ...row });
      },
      updateRun: async (id, patch) => {
        const state = patch.state as string | undefined;
        if (
          state !== undefined &&
          ['completed', 'completed_degraded', 'failed', 'expired', 'deleted'].includes(state)
        ) {
          activeRunId = null;
        }
        runs.push({ id, ...patch });
      },
      saveManifest: async (runId, signed) => {
        manifests.push({ runId, signed });
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
  return { ports, runs, manifests, audits, logs, removed, promoted, fs };
}

function lastRun(h: Harness): Record<string, unknown> {
  return h.runs[h.runs.length - 1]!;
}

describe('artifactName', () => {
  const AT = new Date('2026-07-28T03:00:00.000Z');
  const ID_A = '11111111-2222-4333-8444-555555555555';
  const ID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('is a sortable timestamp with no host or tenant in it', () => {
    expect(artifactName(AT, ID_A)).toMatch(/^maia-2026-07-28T03-00-00-[0-9a-f]{12}\.dump$/);
  });

  it('is deterministic for the same instant AND run', () => {
    expect(artifactName(AT, ID_A)).toBe(artifactName(AT, ID_A));
  });

  it('differs for two runs in the SAME second (the round-1 collision)', () => {
    expect(artifactName(AT, ID_A)).not.toBe(artifactName(AT, ID_B));
  });
});

describe('two runs starting in the same second (round-1 P1)', () => {
  const AT = '2026-07-28T03:00:00.000Z';

  it('publish under DIFFERENT names — neither overwrites the other', async () => {
    const a = harness({}, { frozenClock: true, id: '11111111-2222-4333-8444-555555555555' });
    const b = harness({}, { frozenClock: true, id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    // Same wall clock for both runs.
    a.ports.now = () => new Date(AT);
    b.ports.now = () => new Date(AT);

    const r1 = await runVerifiedBackup(a.ports, resolveBackupProfile(cfg()));
    const r2 = await runVerifiedBackup(b.ports, resolveBackupProfile(cfg()));

    expect(r1.artifact_ref).not.toBe(r2.artifact_ref);
    expect(r1.outcome).not.toBe('failed');
    expect(r2.outcome).not.toBe('failed');
  });

  it('a run whose destination somehow exists FAILS loudly instead of replacing it', async () => {
    // Simulates the pre-fix world: the same name resolved twice. The no-replace
    // promotion turns it into `promote_failed` rather than silent data loss —
    // which would have left run 1's signed manifest describing run 2's bytes.
    const h = harness({}, { frozenClock: true });
    h.ports.now = () => new Date(AT);
    const first = await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(first.outcome).not.toBe('failed');

    const second = await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(second.outcome).toBe('failed');
    expect(lastRun(h).error_code).toBe('promote_failed');
    // And the first artifact is still the one on disk.
    expect(h.fs.size).toBe(1);
  });

  it('emits no manifest for the run that failed to publish', async () => {
    const h = harness({}, { frozenClock: true });
    h.ports.now = () => new Date(AT);
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    const before = h.manifests.length;
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(h.manifests.length).toBe(before);
  });
});

describe('happy path — local only', () => {
  it('completes DEGRADED (local-only is never a normal success)', async () => {
    const h = harness();
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(res.outcome).toBe('completed_degraded');
    expect(res.reason).toBe('offsite_not_configured');
    expect(res.state).toBe('completed_degraded');
  });

  it('writes to a .partial name and promotes atomically', async () => {
    const h = harness();
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(h.promoted).toHaveLength(1);
    expect(h.promoted[0]!.from).toMatch(/\.partial$/);
    expect(h.promoted[0]!.to).not.toMatch(/\.partial$/);
  });

  it('audits a distinct degraded action (the baseline audited plain completed)', async () => {
    const h = harness();
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(h.audits.map((a) => a.action)).toEqual(['backup_run_started', 'backup_run_degraded']);
  });

  it('records a basename in audit metadata, never the absolute path', async () => {
    const h = harness();
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    const meta = h.audits.at(-1)!.metadata;
    expect(meta.artifact_ref).toMatch(/^maia-2026-07-28T03-00-\d\d-[0-9a-f]{12}\.dump$/);
    expect(JSON.stringify(meta)).not.toContain('/backups/');
  });
});

describe('local verification is real evidence, not a size check', () => {
  it('fails when pg_restore cannot read the catalog', async () => {
    const h = harness({ readCatalog: async () => false });
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(res.outcome).toBe('failed');
    expect(lastRun(h).error_code).toBe('catalog_unreadable');
    expect(lastRun(h).local_verified).toBe(false);
  });

  it('fails a truncated artifact that is below the size floor', async () => {
    const h = harness({ digest: async () => ({ sha256: DIGEST, bytes: 10 }) });
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(res.outcome).toBe('failed');
    expect(lastRun(h).error_code).toBe('artifact_too_small');
  });

  it('fails when pg_dump itself fails, and never promotes the partial', async () => {
    const h = harness({
      dump: async () => {
        throw new TypedError('dump_failed', 'pg_dump exit=1', {});
      },
    });
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(res.outcome).toBe('failed');
    expect(h.promoted).toHaveLength(0);
    expect(h.manifests).toHaveLength(0);
  });
});

describe('secrets never reach a log or an audit row', () => {
  it('redacts a DATABASE_URL that leaked through pg_dump stderr', async () => {
    const h = harness({
      dump: async () => {
        throw new TypedError(
          'dump_failed',
          'pg_dump: error: connection failed: postgres://maia:hunter2@db.internal:5432/maia',
          {},
        );
      },
    });
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    const body = JSON.stringify(h.logs);
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('db.internal');
    expect(body).toContain('[redacted]');
  });

  it('stores only a stable error CODE on the run row', async () => {
    const h = harness({
      dump: async () => {
        throw new TypedError('dump_failed', 'postgres://u:p@h/db', {});
      },
    });
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(lastRun(h).error_code).toBe('dump_failed');
    expect(JSON.stringify(lastRun(h))).not.toContain('postgres://');
  });
});

describe('temporary files are always swept', () => {
  it('removes the partials on the happy path', async () => {
    const h = harness();
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(h.removed.every((p) => p.endsWith('.partial'))).toBe(true);
  });

  it('removes the partials after a mid-stage failure', async () => {
    const h = harness({
      readCatalog: async () => {
        throw new TypedError('catalog_unreadable', 'boom', {});
      },
    });
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(h.removed.length).toBeGreaterThan(0);
  });

  it('tolerates a cleanup that itself fails', async () => {
    const h = harness({
      remove: async () => {
        throw new Error('EBUSY');
      },
    });
    await expect(runVerifiedBackup(h.ports, resolveBackupProfile(cfg()))).resolves.toBeTruthy();
  });
});

describe('encryption', () => {
  const encCfg = cfg({
    BACKUP_ENCRYPTION_MODE: 'envelope_aes256_gcm',
    BACKUP_ENCRYPTION_KEYRING: '{"k1":"x"}',
    BACKUP_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
  });

  it('encrypts before promotion and records the CIPHERTEXT digest', async () => {
    const h = harness();
    await runVerifiedBackup(h.ports, resolveBackupProfile(encCfg));
    expect(h.promoted[0]!.from).toMatch(/\.enc\.partial$/);
    expect(lastRun(h).sha256).toBe(ENC_DIGEST);
    expect(lastRun(h).encryption_key_id).toBe('k1');
  });

  it('fails (never writes plaintext to the destination) when encryption fails', async () => {
    const h = harness({
      encrypt: async () => {
        throw new TypedError('encryption_failed', 'kms unavailable', {});
      },
    });
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(encCfg));
    expect(res.outcome).toBe('failed');
    expect(lastRun(h).error_code).toBe('encryption_failed');
    expect(h.promoted).toHaveLength(0);
  });

  it('keeps the plaintext digest in the manifest and the ciphertext digest beside it', async () => {
    const h = harness();
    await runVerifiedBackup(h.ports, resolveBackupProfile(encCfg));
    const verdict = verifyManifest(h.manifests[0]!.signed, SECRET);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.manifest.sha256).toBe(DIGEST);
    expect(verdict.manifest.encryption.ciphertext_sha256).toBe(ENC_DIGEST);
    expect(JSON.stringify(verdict.manifest)).not.toContain('"x"');
  });
});

describe('off-site', () => {
  const s3Cfg = cfg({ BACKUP_S3_BUCKET: 'maia-backups' });
  const prodCfg = cfg({
    profile: 'production',
    BACKUP_S3_BUCKET: 'maia-backups',
    BACKUP_ENCRYPTION_MODE: 'envelope_aes256_gcm',
    BACKUP_ENCRYPTION_KEYRING: '{"k1":"x"}',
    BACKUP_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
  });

  it('completes only after the destination verifies the artifact', async () => {
    const h = harness();
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(s3Cfg));
    expect(res.outcome).toBe('completed');
    expect(lastRun(h).remote_verified).toBe(true);
    expect(h.audits.map((a) => a.action)).toContain('backup_artifact_verified');
  });

  it('degrades (does not fail) when a non-mandatory upload throws', async () => {
    const h = harness({
      upload: async () => {
        throw new Error('network');
      },
    });
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(s3Cfg));
    expect(res.outcome).toBe('completed_degraded');
    expect(res.reason).toBe('offsite_upload_failed');
  });

  it('FAILS a production run whose upload threw (the baseline audited success)', async () => {
    const h = harness({
      upload: async () => {
        throw new Error('network');
      },
    });
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(prodCfg));
    expect(res.outcome).toBe('failed');
    expect(res.reason).toBe('offsite_required_but_unverified');
  });

  it('FAILS a production run whose remote checksum did not verify', async () => {
    const h = harness({
      verifyRemote: async () => ({
        verified: false,
        method: 'provider_checksum' as const,
        reason: 'checksum_mismatch' as const,
      }),
    });
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(prodCfg));
    expect(res.outcome).toBe('failed');
    expect(lastRun(h).remote_verified).toBe(false);
  });

  it('FAILS a production run the destination could not attest at all', async () => {
    // The exact shape of the round-1 finding: nothing proved the stored bytes.
    const h = harness({
      verifyRemote: async () => ({
        verified: false,
        method: 'none' as const,
        reason: 'no_provider_checksum' as const,
      }),
    });
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(prodCfg));
    expect(res.outcome).toBe('failed');
    expect(res.reason).toBe('offsite_required_but_unverified');
  });

  it('records HOW the remote copy was verified in the manifest', async () => {
    const h = harness();
    await runVerifiedBackup(h.ports, resolveBackupProfile(s3Cfg));
    const verdict = verifyManifest(h.manifests[0]!.signed, SECRET);
    if (!verdict.ok) throw new Error('manifest invalid');
    expect(verdict.manifest.verification.remote_verification_method).toBe('provider_checksum');
    expect(verdict.manifest.verification.remote_checksum_verified).toBe(true);
  });

  it('records `none` as the method when no upload was attempted', async () => {
    const h = harness();
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    const verdict = verifyManifest(h.manifests[0]!.signed, SECRET);
    if (!verdict.ok) throw new Error('manifest invalid');
    expect(verdict.manifest.verification.remote_verification_method).toBe('none');
    expect(verdict.manifest.verification.remote_checksum_verified).toBe(false);
  });

  it('audits the verification METHOD, not just the fact', async () => {
    const h = harness();
    await runVerifiedBackup(h.ports, resolveBackupProfile(s3Cfg));
    const verified = h.audits.find((a) => a.action === 'backup_artifact_verified');
    expect(verified?.metadata.method).toBe('provider_checksum');
  });

  it('persists an OPAQUE destination locator, never a bucket/key or URL', async () => {
    const h = harness();
    await runVerifiedBackup(h.ports, resolveBackupProfile(s3Cfg));
    expect(lastRun(h).destination_locator).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(h.runs)).not.toContain('maia-backups');
  });
});

describe('manifest', () => {
  it('is signed and verifiable, and binds the run to its provenance', async () => {
    const h = harness();
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    const verdict = verifyManifest(h.manifests[0]!.signed, SECRET);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.manifest.migration_head).toBe('102_data_lifecycle.sql');
    expect(verdict.manifest.commit).toBe('d93624b');
    expect(verdict.manifest.tombstone_watermark).not.toBeNull();
  });

  it('declares the data classes the dump does NOT cover', async () => {
    const h = harness();
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    const verdict = verifyManifest(h.manifests[0]!.signed, SECRET);
    if (!verdict.ok) throw new Error('manifest invalid');
    expect(verdict.manifest.data_classes_excluded).toContain('media.blobs');
    expect(verdict.manifest.data_classes_excluded).toContain('gateway.baileys_session');
    expect(verdict.manifest.data_classes_included).toContain('postgres.messages');
  });

  it('fails the run when the manifest cannot be signed (unverifiable evidence)', async () => {
    const h = harness({ manifestSecret: () => ({ secret: '', key_version: 1 }) });
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(res.outcome).toBe('failed');
    expect(lastRun(h).error_code).toBe('manifest_failed');
  });

  it('emits no manifest at all for a run that produced no verified artifact', async () => {
    const h = harness({ readCatalog: async () => false });
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(h.manifests).toHaveLength(0);
  });
});

describe('tombstone ledger probe (round-1 P1)', () => {
  it('FAILS the run when the ledger is unreachable — before it can be `completed`', async () => {
    const h = harness({
      tombstoneWatermark: async () => ({
        available: false,
        watermark: null,
        rows_present: false,
      }),
    });
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(cfg({ BACKUP_S3_BUCKET: 'b' })));
    expect(res.outcome).toBe('failed');
    expect(lastRun(h).error_code).toBe('tombstone_ledger_unavailable');
  });

  it('fails FAST — an unreadable ledger never reaches pg_dump', async () => {
    const dump = vi.fn();
    const h = harness({
      dump: async () => {
        dump();
      },
      tombstoneWatermark: async () => ({
        available: false,
        watermark: null,
        rows_present: false,
      }),
    });
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(dump).not.toHaveBeenCalled();
  });

  it('an EMPTY ledger still yields a watermark (a fresh install is backupable)', async () => {
    const h = harness({
      tombstoneWatermark: async (reference: Date) => ({
        available: true,
        watermark: reference,
        rows_present: false,
      }),
    });
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(res.outcome).not.toBe('failed');
    const verdict = verifyManifest(h.manifests[0]!.signed, SECRET);
    if (!verdict.ok) throw new Error('manifest invalid');
    expect(verdict.manifest.tombstone_watermark).not.toBeNull();
  });

  it('the artifact of an empty-ledger run is RESTORABLE (no watermark_missing)', async () => {
    // The end-to-end shape of the finding: backup succeeded, restore blocked.
    const h = harness({
      tombstoneWatermark: async (reference: Date) => ({
        available: true,
        watermark: reference,
        rows_present: false,
      }),
    });
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    const verdict = verifyManifest(h.manifests[0]!.signed, SECRET);
    if (!verdict.ok) throw new Error('manifest invalid');

    const plan = planReconciliation({
      watermark: new Date(verdict.manifest.tombstone_watermark!),
      ledger_available: true,
      tombstones: [],
      secret: 'reconcile-secret',
    });
    expect(plan.ok).toBe(true);
    expect(plan.blocked_reason).toBeNull();
    expect(canReleaseTraffic(plan, [])).toEqual({ release: true, reason: 'ok' });
  });

  it('stamps the run row with the watermark it recorded', async () => {
    const h = harness();
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(lastRun(h).tombstone_watermark).toBeInstanceOf(Date);
  });
});

describe('a failing audit sink never strands the run (round-1 P2)', () => {
  it('completes the backup when the START audit throws', async () => {
    const h = harness();
    h.ports.audit = vi.fn(async (action: string) => {
      if (action === 'backup_run_started') throw new Error('audit_log unreachable');
    });
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(res.outcome).toBe('completed_degraded');
    expect(h.logs.some((l) => l.event === 'backup.start_audit_failed')).toBe(true);
  });

  it('terminalizes the row when ANY step after createRun throws', async () => {
    const h = harness({
      ensureBackupDir: async () => {
        throw new Error('EACCES');
      },
    });
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(res.outcome).toBe('failed');
    expect(lastRun(h).state).toBe('failed');
  });

  it('lets the NEXT run start — the strand is gone', async () => {
    // The fake store enforces `backup_runs_single_active_uq`, so this only
    // passes if the previous run actually reached a terminal state.
    const h = harness();
    let first = true;
    h.ports.audit = vi.fn(async (action: string) => {
      if (action === 'backup_run_started' && first) {
        first = false;
        throw new Error('audit_log unreachable');
      }
    });
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    await expect(
      runVerifiedBackup(h.ports, resolveBackupProfile(cfg())),
    ).resolves.toMatchObject({ outcome: 'completed_degraded' });
  });

  it('a stranded run WOULD block the next one (the fake proves the hazard is real)', async () => {
    const h = harness();
    // Bypass terminalization to simulate the pre-fix behaviour.
    h.ports.store.updateRun = vi.fn(async () => undefined);
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    await expect(runVerifiedBackup(h.ports, resolveBackupProfile(cfg()))).rejects.toThrow(
      /non-terminal backup run already exists/,
    );
  });

  it('does not throw when the TERMINAL audit fails (the run already succeeded)', async () => {
    const h = harness();
    h.ports.audit = vi.fn(async (action: string) => {
      if (action !== 'backup_run_started') throw new Error('audit_log unreachable');
    });
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(res.outcome).toBe('completed_degraded');
    expect(h.logs.some((l) => l.event === 'backup.outcome_audit_failed')).toBe(true);
  });

  it('escalates loudly when the terminalizing write itself fails', async () => {
    const h = harness();
    h.ports.store.updateRun = vi.fn(async () => {
      throw new Error('deadlock detected');
    });
    await expect(runVerifiedBackup(h.ports, resolveBackupProfile(cfg()))).rejects.toThrow(
      'deadlock detected',
    );
    const strand = h.logs.find((l) => l.event === 'backup.run_not_terminalized');
    expect(strand).toBeDefined();
    expect(String(strand!.detail.impact)).toMatch(/subsequent runs will be refused/);
  });
});

describe('run bookkeeping', () => {
  it('opens the run row BEFORE dumping so a crash leaves a visible record', async () => {
    const order: string[] = [];
    const h = harness();
    const original = h.ports.store.createRun;
    h.ports.store.createRun = async (row) => {
      order.push('createRun');
      return original(row);
    };
    h.ports.dump = async () => {
      order.push('dump');
    };
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    expect(order).toEqual(['createRun', 'dump']);
  });

  it('carries one correlation id through the run row and every audit', async () => {
    const h = harness();
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()));
    for (const a of h.audits) expect(a.metadata.correlation_id).toBe(res.correlation_id);
  });

  it('labels the trigger so cron and CLI are distinguishable in the trail', async () => {
    const h = harness();
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg()), 'cli');
    expect(h.runs[0]!.trigger).toBe('cli');
  });

  it('records stage durations', async () => {
    const h = harness({ upload: vi.fn(async () => ({ locator: 'a'.repeat(32), remote_bytes: 1024, remote_sha256: DIGEST })) });
    await runVerifiedBackup(h.ports, resolveBackupProfile(cfg({ BACKUP_S3_BUCKET: 'b' })));
    expect(lastRun(h).dump_duration_ms).toBeGreaterThan(0);
    expect(lastRun(h).upload_duration_ms).toBeGreaterThanOrEqual(0);
  });
});
