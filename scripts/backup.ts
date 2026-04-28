import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@/config/env.js';

function tsName(): string {
  const d = new Date();
  return `maia-${d.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.dump`;
}

async function run() {
  mkdirSync(config.BACKUP_DIR, { recursive: true });
  const file = join(config.BACKUP_DIR, tsName());
  const res = spawnSync(
    'pg_dump',
    ['--no-owner', '-Fc', config.DATABASE_URL, '-f', file],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) {
    console.error('pg_dump failed');
    process.exit(1);
  }
  console.log(`backup written to ${file}`);

  // Local retention
  const files = readdirSync(config.BACKUP_DIR)
    .filter((f) => f.startsWith('maia-') && f.endsWith('.dump'))
    .map((f) => ({ name: f, mtime: statSync(join(config.BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const cutoff = Date.now() - config.BACKUP_RETENTION_LOCAL_DAYS * 86_400_000;
  for (const f of files) {
    if (f.mtime < cutoff) {
      rmSync(join(config.BACKUP_DIR, f.name));
      console.log(`pruned ${f.name}`);
    }
  }
  process.exit(0);
}

run();
