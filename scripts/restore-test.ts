import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';
import { downloadBackup } from '@/lib/s3-backup.js';

function newestBackup(): string | null {
  const files = readdirSync(config.BACKUP_DIR)
    .filter((f) => f.startsWith('maia-') && f.endsWith('.dump'))
    .map((f) => ({ name: f, mtime: statSync(join(config.BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] ? join(config.BACKUP_DIR, files[0].name) : null;
}

function adminUrl(): string {
  // strip database name to connect to template1 / postgres for createdb
  const u = new URL(config.DATABASE_URL);
  u.pathname = '/postgres';
  return u.toString();
}

function parseFromS3Flag(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--from-s3='));
  if (!arg) return null;
  return arg.slice('--from-s3='.length) || null;
}

async function resolveBackupSource(): Promise<{ file: string; cleanup: () => void }> {
  const s3Key = parseFromS3Flag();
  if (s3Key) {
    if (!config.BACKUP_S3_BUCKET) {
      throw new Error('--from-s3 requires BACKUP_S3_BUCKET to be configured');
    }
    const tmpDir = mkdtempSync(join(tmpdir(), 'maia-restore-'));
    const tmpFile = join(tmpDir, 'downloaded.dump');
    console.log(`downloading s3://${config.BACKUP_S3_BUCKET}/${s3Key} -> ${tmpFile}`);
    await downloadBackup(s3Key, tmpFile);
    return {
      file: tmpFile,
      cleanup: () => {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      },
    };
  }

  const local = newestBackup();
  if (!local) {
    throw new Error('no backups found');
  }
  return { file: local, cleanup: () => {} };
}

async function dropDrillDb(drillDb: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${drillDb}"`);
  } finally {
    await admin.end();
  }
}

async function run() {
  const { file, cleanup } = await resolveBackupSource();
  const drillDb = `${config.POSTGRES_DB}_restore_drill_${Date.now()}`;
  console.log(`restoring ${file} into ${drillDb}`);

  let drillCreated = false;
  let restoreFailed = false;
  try {
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${drillDb}"`);
    await admin.end();
    drillCreated = true;

    const drillUrl = (() => {
      const u = new URL(config.DATABASE_URL);
      u.pathname = '/' + drillDb;
      return u.toString();
    })();

    const r = spawnSync('pg_restore', ['--no-owner', '-d', drillUrl, file], { stdio: 'inherit' });
    if (r.status !== 0) {
      restoreFailed = true;
      console.error('pg_restore failed');
      await audit({ acao: 'restore_test_failed', metadata: { file, drillDb } });
      throw new Error('pg_restore failed');
    }

    // Sanity probe
    const probe = new pg.Client({ connectionString: drillUrl });
    await probe.connect();
    const res = await probe.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM transacoes',
    );
    await probe.end();
    console.log(`sanity probe: transacoes count = ${res.rows[0]?.count}`);

    await audit({ acao: 'restore_test_passed', metadata: { file } });
    console.log('restore drill ok');
  } finally {
    if (drillCreated) {
      try {
        await dropDrillDb(drillDb);
      } catch (err) {
        // Best-effort: the drill DB will be re-created next run with a new
        // timestamp, so a stale one is recoverable. Do not mask the original
        // error (if any) by throwing here.
        const message = (err as Error).message;
        if (restoreFailed) {
          console.error(`drill DB drop failed (post pg_restore failure): ${message}`);
        } else {
          console.error(`drill DB drop failed: ${message}`);
        }
      }
    }
    cleanup();
  }
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
