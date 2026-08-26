import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tryGetCurrentContext, isSystemContext } from '../../src/db/tenant-context.js';

/**
 * nightly_backup + cloud_backup_rotation workers.
 *
 * Two contracts are asserted here:
 *
 * 1. TENANT SCOPE (issue #323 phase 2). Both jobs are GENUINELY GLOBAL:
 *    `pg_dump` dumps the whole DB, `pruneCloud` only touches the S3 bucket, and
 *    the only DB writes are ownerless `backup_*` rows. They run under the
 *    reserved `system` sentinel, never the legacy `default/default` literal.
 *
 * 2. SHARED, LOCKED, EVIDENCE-BASED EXECUTION (issue #520). The worker no
 *    longer owns a private copy of the dump logic: it takes the global
 *    single-flight lock and delegates to `runVerifiedBackup`, the same service
 *    `scripts/backup.ts` calls. A concurrent run reports `already_running`
 *    without starting a second `pg_dump`, and a degraded/failed outcome raises
 *    an alert instead of being audited as a plain success.
 */

const auditMock = vi.fn().mockResolvedValue(undefined);
const sendAlertMock = vi.fn().mockResolvedValue(undefined);
const isS3ConfiguredMock = vi.fn();
const runVerifiedBackupMock = vi.fn();
const runArtifactRetentionMock = vi.fn();
const withOpsLockMock = vi.fn();
const requireOpsLockMock = vi.fn();
const createBackupPortsMock = vi.fn(() => ({}) as never);
const recordRetentionRunMock = vi.fn().mockResolvedValue(undefined);
const readdirSyncMock = vi.fn(() => [] as string[]);
const listArtifactRunsMock = vi.fn().mockResolvedValue([]);
const reclaimAbandonedRunsMock = vi.fn().mockResolvedValue([]);

vi.mock('node:fs', () => ({
  readdirSync: readdirSyncMock,
  statSync: vi.fn(() => ({ size: 123, mtimeMs: Date.now() })),
  rmSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/lib/alerts.js', () => ({ sendAlert: sendAlertMock }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/db/client.js', () => ({ pool: {}, db: {} }));
vi.mock('../../src/workers/backup-s3.js', () => ({
  isS3Configured: isS3ConfiguredMock,
  deleteBackupObject: vi.fn(),
  headBackupObject: vi.fn(),
}));
vi.mock('../../src/ops/backup/retention.js', () => ({
  runArtifactRetention: runArtifactRetentionMock,
}));
vi.mock('../../src/db/repositories/ops-repos.js', () => ({
  anyActiveLegalHold: vi.fn(),
  listArtifactRuns: listArtifactRunsMock,
  reclaimAbandonedRuns: reclaimAbandonedRunsMock,
  markRunDeleted: vi.fn(),
  recordRetentionRun: recordRetentionRunMock,
}));
vi.mock('../../src/ops/backup/adapters.js', () => ({
  createBackupPorts: createBackupPortsMock,
}));
vi.mock('../../src/ops/backup/service.js', () => ({
  runVerifiedBackup: runVerifiedBackupMock,
}));
vi.mock('../../src/ops/backup/single-flight.js', () => ({
  OPS_LOCK_KEYS: { backup_run: 'maia_ops_backup_run', retention_run: 'maia_ops_retention_run' },
  withOpsLock: withOpsLockMock,
  requireOpsLock: requireOpsLockMock,
}));
vi.mock('../../src/config/env.js', () => ({
  config: {
    NODE_ENV: 'development',
    BACKUP_DIR: '/tmp/maia-backups',
    DATABASE_URL: 'postgres://localhost/maia',
    BACKUP_ENABLED: true,
    BACKUP_RETENTION_LOCAL_DAYS: 7,
    BACKUP_RETENTION_CLOUD_DAYS: 30,
    BACKUP_ENCRYPTION_MODE: 'none',
    BACKUP_DUMP_TIMEOUT_MS: 3_600_000,
    BACKUP_UPLOAD_TIMEOUT_MS: 1_800_000,
    BACKUP_RESTORE_TIMEOUT_MS: 3_600_000,
    BACKUP_MIN_ARTIFACT_BYTES: 4096,
    BACKUP_RPO_TARGET_HOURS: 24,
    BACKUP_RTO_TARGET_MINUTES: 120,
    BACKUP_RESTORE_DRILL_INTERVAL_HOURS: 168,
    RETENTION_DRY_RUN: true,
  },
}));

function lockRuns(): void {
  withOpsLockMock.mockImplementation(
    async (_key: string, _deps: unknown, fn: () => Promise<unknown>) => ({
      status: 'ran',
      result: await fn(),
    }),
  );
}

function backupResult(over: Record<string, unknown> = {}) {
  return {
    backup_id: 'b-1',
    correlation_id: 'c-1',
    outcome: 'completed',
    reason: 'ok',
    artifact_ref: 'maia-2026-07-28T03-00-00.dump',
    state: 'completed',
    ...over,
  };
}

function retentionOutcome(over: Record<string, unknown> = {}) {
  return {
    status: 'completed',
    scanned: 3,
    eligible: 1,
    deleted: 1,
    skipped_held: 0,
    unidentified: 0,
    failed: 0,
    error_code: null,
    cursor_watermark: null,
    ...over,
  };
}

beforeEach(() => {
  auditMock.mockClear();
  sendAlertMock.mockClear();
  isS3ConfiguredMock.mockReset();
  runVerifiedBackupMock.mockReset();
  runArtifactRetentionMock.mockReset();
  withOpsLockMock.mockReset();
  requireOpsLockMock.mockReset();
  recordRetentionRunMock.mockClear();
  readdirSyncMock.mockReset();
  readdirSyncMock.mockReturnValue([]);
  listArtifactRunsMock.mockReset();
  listArtifactRunsMock.mockResolvedValue([]);
  reclaimAbandonedRunsMock.mockReset();
  reclaimAbandonedRunsMock.mockResolvedValue([]);
  runVerifiedBackupMock.mockResolvedValue(backupResult());
  runArtifactRetentionMock.mockResolvedValue(retentionOutcome());
  // The retention lock is fail-closed: `requireOpsLock` runs the body or throws.
  requireOpsLockMock.mockImplementation(
    async (_key: string, _deps: unknown, fn: () => Promise<unknown>) => fn(),
  );
  lockRuns();
});

describe('nightly_backup worker', () => {
  it('delegates to the shared verified-backup service (no private dump logic)', async () => {
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();
    expect(runVerifiedBackupMock).toHaveBeenCalledTimes(1);
    expect(runVerifiedBackupMock.mock.calls[0]![2]).toBe('schedule');
  });

  it('runs under the global single-flight lock', async () => {
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();
    expect(withOpsLockMock).toHaveBeenCalledWith(
      'maia_ops_backup_run',
      expect.anything(),
      expect.any(Function),
    );
  });

  it('starts NO second dump when another runner holds the lock', async () => {
    withOpsLockMock.mockResolvedValue({ status: 'already_running' });
    const { executeBackup } = await import('../../src/workers/backup.js');
    const res = await executeBackup('cli');
    expect(res.status).toBe('already_running');
    expect(runVerifiedBackupMock).not.toHaveBeenCalled();
  });

  it('does not alert on a fully verified run', async () => {
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('alerts on a DEGRADED run (local-only is not a normal success)', async () => {
    runVerifiedBackupMock.mockResolvedValue(
      backupResult({ outcome: 'completed_degraded', reason: 'offsite_not_configured' }),
    );
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();
    expect(sendAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('DEGRADED') }),
    );
  });

  it('alerts on a FAILED run', async () => {
    runVerifiedBackupMock.mockResolvedValue(
      backupResult({ outcome: 'failed', reason: 'catalog_unreadable' }),
    );
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();
    expect(sendAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('FAILED') }),
    );
  });

  it('never puts a path, URL or credential in the alert body', async () => {
    runVerifiedBackupMock.mockResolvedValue(backupResult({ outcome: 'failed', reason: 'dump_failed' }));
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();
    const body = sendAlertMock.mock.calls[0]![0].body as string;
    expect(body).not.toMatch(/postgres:\/\//);
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).not.toContain('/tmp/maia-backups');
  });

  it('runs under the reserved system context (not default/default)', async () => {
    let observed: { tenant_id: string; agent_id: string } | null = null;
    runVerifiedBackupMock.mockImplementation(async () => {
      observed = tryGetCurrentContext();
      return backupResult();
    });
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();

    expect(observed).not.toBeNull();
    expect(isSystemContext(observed!)).toBe(true);
    expect(observed!.tenant_id).not.toBe('default');
    expect(observed!.agent_id).not.toBe('default');
  });
});

describe('a backup killed mid-run does not block the next one (#512 drain interaction)', () => {
  it('reclaims abandoned runs BEFORE taking the lock', async () => {
    const order: string[] = [];
    reclaimAbandonedRunsMock.mockImplementation(async () => {
      order.push('reclaim');
      return [];
    });
    withOpsLockMock.mockImplementation(
      async (_k: string, _d: unknown, fn: () => Promise<unknown>) => {
        order.push('lock');
        return { status: 'ran', result: await fn() };
      },
    );
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();
    expect(order).toEqual(['reclaim', 'lock']);
  });

  it('uses a cutoff of twice the dump budget — a live run is never stolen', async () => {
    // BACKUP_DUMP_TIMEOUT_MS is 3_600_000 in the mocked config.
    const BUDGET = 2 * 3_600_000;
    const before = Date.now();
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();
    const after = Date.now();
    const cutoff = reclaimAbandonedRunsMock.mock.calls[0]![0] as Date;

    // O corte é `Date.now() - BUDGET` medido DENTRO da produção, num instante
    // entre `before` e `after`. Então a única afirmação verdadeira em toda
    // corrida é que ele cai nessa janela deslocada — e é isso que fixa a regra
    // "duas vezes o orçamento" sem depender do relógio.
    //
    // A versão anterior comparava só com `before` e exigia `>= BUDGET`, o que
    // é `BUDGET - decorrido >= BUDGET`: verdadeiro apenas quando as duas
    // leituras de relógio caem no MESMO milissegundo. Passava por sorte e
    // reprovava com um milissegundo de diferença
    // (`expected 7199999 to be greater than or equal to 7200000`).
    expect(after - cutoff.getTime()).toBeGreaterThanOrEqual(BUDGET);
    expect(before - cutoff.getTime()).toBeLessThanOrEqual(BUDGET);
  });

  it('audits every reclaimed run — it is a state change on evidence', async () => {
    reclaimAbandonedRunsMock.mockResolvedValue(['run-a', 'run-b']);
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();
    const reclaimed = auditMock.mock.calls
      .map((c) => c[0])
      .filter((a) => a.metadata?.reason === 'abandoned');
    expect(reclaimed.map((a) => a.metadata.backup_id)).toEqual(['run-a', 'run-b']);
    expect(reclaimed[0]!.acao).toBe('backup_run_failed');
  });

  it('proceeds with the backup when the reclaim itself fails', async () => {
    reclaimAbandonedRunsMock.mockRejectedValue(new Error('db down'));
    const { executeBackup } = await import('../../src/workers/backup.js');
    const res = await executeBackup('schedule');
    expect(res.status).toBe('ran');
  });
});

describe('retention candidates reach the LOCAL copy of an S3 run (round-2 finding)', () => {
  const S3_REF = 'maia-2026-07-01T03-00-00-aaaaaaaaaaaa.dump';
  const FINISHED = new Date('2026-07-01T03:05:00.000Z');

  function s3Run() {
    return {
      backup_id: 'run-s3',
      artifact_ref: S3_REF,
      state: 'completed' as const,
      destination_kind: 's3' as const,
      delete_after: new Date('2026-07-31T00:00:00.000Z'),
      finished_at: FINISHED,
      has_manifest: true,
    };
  }

  it('the local pass SEES the local copy of a run whose destination is s3', async () => {
    listArtifactRunsMock.mockResolvedValue([s3Run()]);
    readdirSyncMock.mockReturnValue([S3_REF]);
    const { listRetentionCandidatesFor } = await import('../../src/workers/backup.js');
    const local = await listRetentionCandidatesFor('local');
    expect(local).toHaveLength(1);
    expect(local[0]!.backup_id).toBe('run-s3');
    expect(local[0]!.destination_kind).toBe('local');
  });

  it('applies the shorter LOCAL window to that copy, not the remote expiry', async () => {
    listArtifactRunsMock.mockResolvedValue([s3Run()]);
    readdirSyncMock.mockReturnValue([S3_REF]);
    const { listRetentionCandidatesFor } = await import('../../src/workers/backup.js');
    const [c] = await listRetentionCandidatesFor('local');
    // finished_at + BACKUP_RETENTION_LOCAL_DAYS (7 in the mocked config).
    expect(c!.delete_after).toEqual(new Date(FINISHED.getTime() + 7 * 86_400_000));
    expect(c!.delete_after).not.toEqual(s3Run().delete_after);
  });

  it('the s3 pass still sees only the remote copies, with the remote expiry', async () => {
    listArtifactRunsMock.mockResolvedValue([
      s3Run(),
      {
        backup_id: 'run-local',
        artifact_ref: 'maia-2026-07-02T03-00-00-bbbbbbbbbbbb.dump',
        state: 'completed' as const,
        destination_kind: 'local' as const,
        delete_after: null,
        finished_at: FINISHED,
        has_manifest: true,
      },
    ]);
    const { listRetentionCandidatesFor } = await import('../../src/workers/backup.js');
    const remote = await listRetentionCandidatesFor('s3');
    expect(remote.map((c) => c.backup_id)).toEqual(['run-s3']);
    expect(remote[0]!.delete_after).toEqual(s3Run().delete_after);
  });

  it('surfaces a file on disk with NO run row as unidentified, never deletable', async () => {
    listArtifactRunsMock.mockResolvedValue([]);
    readdirSyncMock.mockReturnValue(['maia-2026-01-01T00-00-00-cccccccccccc.dump']);
    const { listRetentionCandidatesFor } = await import('../../src/workers/backup.js');
    const [c] = await listRetentionCandidatesFor('local');
    expect(c!.has_manifest).toBe(false);
    expect(c!.delete_after).toBeNull();
    expect(c!.backup_id).toMatch(/^unknown:/);
  });

  it('ignores directory entries that are not valid artifact names', async () => {
    listArtifactRunsMock.mockResolvedValue([]);
    readdirSyncMock.mockReturnValue([
      '../../etc/passwd',
      'maia-x.dump.partial',
      'README',
      'maia-2026-01-01T00-00-00-cccccccccccc.dump',
    ]);
    const { listRetentionCandidatesFor } = await import('../../src/workers/backup.js');
    const local = await listRetentionCandidatesFor('local');
    expect(local.map((c) => c.artifact_ref)).toEqual([
      'maia-2026-01-01T00-00-00-cccccccccccc.dump',
    ]);
  });

  it('returns nothing when the backup directory cannot be read', async () => {
    readdirSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const { listRetentionCandidatesFor } = await import('../../src/workers/backup.js');
    expect(await listRetentionCandidatesFor('local')).toEqual([]);
  });
});

describe('backup_retention worker', () => {
  it('runs the manifest-driven executor and audits a conclusive outcome', async () => {
    isS3ConfiguredMock.mockReturnValue(true);
    const { runBackupRetention } = await import('../../src/workers/backup.js');
    await runBackupRetention();

    // Both destinations.
    expect(runArtifactRetentionMock).toHaveBeenCalledTimes(2);
    expect(runArtifactRetentionMock.mock.calls.map((c) => c[1])).toEqual(['local', 's3']);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'retention_run_completed',
        metadata: expect.objectContaining({ deleted: 1, skipped_held: 0 }),
      }),
    );
  });

  it('audits FAILED — never completed — for a partial pass', async () => {
    // The exact half of the finding about the evidence lying.
    isS3ConfiguredMock.mockReturnValue(false);
    runArtifactRetentionMock.mockResolvedValue(
      retentionOutcome({ status: 'partial', deleted: 1, failed: 2, error_code: 'delete_failed' }),
    );
    const { runBackupRetention } = await import('../../src/workers/backup.js');
    await runBackupRetention();

    const actions = auditMock.mock.calls.map((c) => c[0].acao);
    expect(actions).toContain('retention_run_failed');
    expect(actions).not.toContain('retention_run_completed');
  });

  it('alerts on a non-conclusive pass', async () => {
    isS3ConfiguredMock.mockReturnValue(false);
    runArtifactRetentionMock.mockResolvedValue(
      retentionOutcome({ status: 'failed', deleted: 0, failed: 1 }),
    );
    const { runBackupRetention } = await import('../../src/workers/backup.js');
    await runBackupRetention();
    expect(sendAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('FAILED') }),
    );
  });

  it('takes the retention lock FAIL-CLOSED (a lost race is not "nothing to do")', async () => {
    isS3ConfiguredMock.mockReturnValue(false);
    requireOpsLockMock.mockRejectedValue(new Error('ops_lock_unavailable'));
    const { runBackupRetention } = await import('../../src/workers/backup.js');
    await expect(runBackupRetention()).rejects.toThrow('ops_lock_unavailable');
    expect(runArtifactRetentionMock).not.toHaveBeenCalled();
  });

  it('skips the S3 pass when no destination is configured', async () => {
    isS3ConfiguredMock.mockReturnValue(false);
    const { runBackupRetention } = await import('../../src/workers/backup.js');
    await runBackupRetention();
    expect(runArtifactRetentionMock).toHaveBeenCalledTimes(1);
    expect(runArtifactRetentionMock.mock.calls[0]![1]).toBe('local');
  });

  it('persists the pass in retention_runs, including a partial one', async () => {
    isS3ConfiguredMock.mockReturnValue(false);
    runArtifactRetentionMock.mockResolvedValue(retentionOutcome({ status: 'partial', failed: 1 }));
    const { runBackupRetention } = await import('../../src/workers/backup.js');
    await runBackupRetention();
    expect(recordRetentionRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'partial', data_class: 'backup.artifact' }),
    );
  });

  it('runs under the reserved system context (not default/default)', async () => {
    isS3ConfiguredMock.mockReturnValue(false);
    let observed: { tenant_id: string; agent_id: string } | null = null;
    runArtifactRetentionMock.mockImplementation(async () => {
      observed = tryGetCurrentContext();
      return retentionOutcome();
    });
    const { runBackupRetention } = await import('../../src/workers/backup.js');
    await runBackupRetention();

    expect(observed).not.toBeNull();
    expect(isSystemContext(observed!)).toBe(true);
    expect(observed!.tenant_id).not.toBe('default');
    expect(observed!.agent_id).not.toBe('default');
  });
});
