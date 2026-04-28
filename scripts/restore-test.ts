import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';

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

async function run() {
  const file = newestBackup();
  if (!file) {
    console.error('no backups found');
    process.exit(1);
  }
  const drillDb = `${config.POSTGRES_DB}_restore_drill_${Date.now()}`;
  console.log(`restoring ${file} into ${drillDb}`);

  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${drillDb}"`);
  await admin.end();

  const drillUrl = (() => {
    const u = new URL(config.DATABASE_URL);
    u.pathname = '/' + drillDb;
    return u.toString();
  })();

  const r = spawnSync('pg_restore', ['--no-owner', '-d', drillUrl, file], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('pg_restore failed');
    await audit({ acao: 'restore_test_failed', metadata: { file, drillDb } });
    process.exit(1);
  }

  // Sanity probe
  const probe = new pg.Client({ connectionString: drillUrl });
  await probe.connect();
  const res = await probe.query<{ count: string }>('SELECT count(*)::text AS count FROM transacoes');
  await probe.end();
  console.log(`sanity probe: transacoes count = ${res.rows[0]?.count}`);

  // Drop drill DB
  const admin2 = new pg.Client({ connectionString: adminUrl() });
  await admin2.connect();
  await admin2.query(`DROP DATABASE "${drillDb}"`);
  await admin2.end();

  await audit({ acao: 'restore_test_passed', metadata: { file } });
  console.log('restore drill ok');
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
