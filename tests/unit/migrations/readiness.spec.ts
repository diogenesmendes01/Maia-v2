/**
 * Issue #516 §6 — the read-only readiness API that `maia doctor` (#517) and
 * `/readyz` consume.
 *
 * The contract under test is as much about what it must NOT do as what it
 * returns: no writes, no lock, no throwing, and no `ready: true` on an
 * unestablished state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMigrationStatus, getSchemaReadiness } from '@/migrations/readiness.js';
import { migrationChecksum } from '@/migrations/checksum.js';
import { FakeDb } from './_fake-db.js';

const A = 'CREATE TABLE a (id TEXT);\n';
const B = 'CREATE TABLE b (id TEXT);\n';

let dir: string;

async function write(name: string, contents: string): Promise<void> {
  await writeFile(join(dir, name), contents, 'utf8');
  await writeFile(join(dir, name.replace(/\.sql$/, '_down.sql')), '-- down\n', 'utf8');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'maia-readiness-'));
  await write('001_a.sql', A);
  await write('002_b.sql', B);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(db: FakeDb) {
  return { pool: db, migrationsDir: dir } as unknown as Parameters<typeof getSchemaReadiness>[0];
}

const applied = [
  { id: '001_a.sql', status: 'applied' as const, checksum_sha256: migrationChecksum(A), checksum_source: 'computed' as const },
  { id: '002_b.sql', status: 'applied' as const, checksum_sha256: migrationChecksum(B), checksum_source: 'computed' as const },
];

describe('getSchemaReadiness — read-only guarantees', () => {
  it('takes NO advisory lock and issues NO writes', async () => {
    const db = new FakeDb({ rows: applied });
    await getSchemaReadiness(deps(db));
    const writes = db.queries.filter((q) =>
      /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|SET|BEGIN|COMMIT)/i.test(q),
    );
    expect(writes).toEqual([]);
    expect(db.queries.some((q) => q.includes('advisory'))).toBe(false);
    // And it hands the pooled client back.
    expect(db.releases).toBe(1);
  });

  it('does NOT backfill checksums — a probe must not mutate its own evidence', async () => {
    const db = new FakeDb({ rows: [{ id: '001_a.sql', status: 'applied' }] });
    const readiness = await getSchemaReadiness(deps(db));
    expect(db.ledger.get('001_a.sql')!.checksum_sha256).toBeNull();
    expect(readiness.blockers.map((b) => b.kind)).toContain('checksum_unknown');
  });

  it('reports ready on a fully applied, verified schema', async () => {
    const readiness = await getSchemaReadiness(deps(new FakeDb({ rows: applied })));
    expect(readiness.ready).toBe(true);
    expect(readiness.state).toBe('ready');
    expect(readiness.expected_head).toBe('002_b.sql');
    expect(readiness.applied_head).toBe('002_b.sql');
    expect(readiness.status?.counts.applied).toBe(2);
  });

  it('blocks a database behind this build', async () => {
    const readiness = await getSchemaReadiness(deps(new FakeDb({ rows: [applied[0]!] })));
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((b) => b.kind)).toContain('schema_below_minimum');
  });

  it('treats an in-flight `running` row as blocking, not as crash debris', async () => {
    const db = new FakeDb({ rows: [applied[0]!, { id: '002_b.sql', status: 'running' }] });
    const readiness = await getSchemaReadiness(deps(db));
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((b) => b.kind)).toContain('running_migration');
    // A read-only probe must NOT promote it to dirty — only the lock holder can.
    expect(db.ledger.get('002_b.sql')!.status).toBe('running');
  });

  it('never throws: a dead database becomes state=unknown, ready=false', async () => {
    const readiness = await getSchemaReadiness(deps(new FakeDb({ connectFails: true })));
    expect(readiness.ready).toBe(false);
    expect(readiness.state).toBe('unknown');
    expect(readiness.status).toBeNull();
    expect(readiness.blockers[0]!.kind).toBe('ledger_unavailable');
  });

  it('honours an explicit compatibility manifest (expand/contract)', async () => {
    const readiness = await getSchemaReadiness({
      ...deps(new FakeDb({ rows: [applied[0]!] })),
      manifest: {
        schema_manifest_version: 1,
        expected_head: '002_b.sql',
        min_supported_migration: '001_a.sql',
        max_supported_migration: null,
      },
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.pending_count).toBe(1);
  });

  it('leaks no connection string even when the driver error carries one', async () => {
    const db = new FakeDb({ connectFails: true });
    const readiness = await getSchemaReadiness(deps(db));
    expect(JSON.stringify(readiness)).not.toMatch(/postgres:\/\//);
  });
});

describe('getMigrationStatus', () => {
  it('returns the full per-migration detail a consumer would otherwise re-derive', async () => {
    const status = await getMigrationStatus(deps(new FakeDb({ rows: [applied[0]!] })));
    expect(status.entries.map((e) => [e.id, e.state])).toEqual([
      ['001_a.sql', 'applied'],
      ['002_b.sql', 'pending'],
    ]);
    expect(status.pending).toEqual(['002_b.sql']);
    expect(status.ledger_present).toBe(true);
    expect(status.ledger_version).toBe(2);
  });
});
