import { describe, it, expect, vi } from 'vitest';
import {
  runVerifiedBackup,
  artifactName,
  type BackupPorts,
  type UploadOutcome,
} from '../../../src/ops/backup/service.js';
import { resolveBackupProfile, type BackupConfigInput } from '../../../src/ops/backup/profile.js';
import { verifyManifest } from '../../../src/ops/backup/manifest.js';
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
}

function harness(over: Partial<BackupPorts> = {}): Harness {
  const runs: Record<string, unknown>[] = [];
  const manifests: { runId: string; signed: unknown }[] = [];
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const logs: { event: string; detail: Record<string, unknown> }[] = [];
  const removed: string[] = [];
  const promoted: { from: string; to: string }[] = [];
  let clock = new Date('2026-07-28T03:00:00.000Z').getTime();

  const ports: BackupPorts = {
    now: () => new Date((clock += 1000)),
    newId: () => '11111111-2222-4333-8444-555555555555',
    resolvePath: (name) => `/backups/${name}`,
    ensureBackupDir: async () => undefined,
    dump: async () => undefined,
    readCatalog: async () => true,
    digest: async (p) =>
      p.endsWith('.enc.partial')
        ? { sha256: ENC_DIGEST, bytes: 2048 }
        : { sha256: DIGEST, bytes: 1024 },
    encrypt: async () => ({ key_id: 'k1' }),
    promote: async (from, to) => {
      promoted.push({ from, to });
    },
    remove: async (p) => {
      removed.push(p);
    },
    upload: async (): Promise<UploadOutcome> => ({
      locator: 'f'.repeat(32),
      remote_bytes: 1024,
      remote_sha256: DIGEST,
    }),
    verifyRemote: async () => true,
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
    tombstoneWatermark: async () => new Date('2026-07-28T02:59:00.000Z'),
    manifestSecret: () => ({ secret: SECRET, key_version: 1 }),
    store: {
      createRun: async (row) => {
        runs.push({ ...row });
      },
      updateRun: async (id, patch) => {
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
  return { ports, runs, manifests, audits, logs, removed, promoted };
}

function lastRun(h: Harness): Record<string, unknown> {
  return h.runs[h.runs.length - 1]!;
}

describe('artifactName', () => {
  it('is a deterministic timestamp with no host or tenant in it', () => {
    expect(artifactName(new Date('2026-07-28T03:00:00.000Z'))).toBe('maia-2026-07-28T03-00-00.dump');
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
    expect(meta.artifact_ref).toMatch(/^maia-2026-07-28T03-00-\d\d\.dump$/);
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
    const h = harness({ verifyRemote: async () => false });
    const res = await runVerifiedBackup(h.ports, resolveBackupProfile(prodCfg));
    expect(res.outcome).toBe('failed');
    expect(lastRun(h).remote_verified).toBe(false);
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
    expect(verdict.manifest.tombstone_watermark).toBe('2026-07-28T02:59:00.000Z');
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
