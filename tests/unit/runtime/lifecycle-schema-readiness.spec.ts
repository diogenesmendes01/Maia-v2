/**
 * Issue #516 — the schema gate `/readyz` sits on.
 *
 * This suite drives `checkSchemaReadiness()` through the REAL
 * `getSchemaReadiness()` decision core (real discovery, real checksums, real
 * ledger normalisation, real blocker classification) against a fake pool and a
 * real temporary migrations directory. Nothing about the verdict is stubbed —
 * only the two things a unit test cannot have, the database and the packaged
 * artifact, are injected.
 *
 * Two distinct guarantees are locked here:
 *
 *   1. **Fail-closed classification.** Dirty state, a divergent checksum, a
 *      migration the database applied but this build does not ship, and a head
 *      that is not applied all produce `blocked`; an unreadable database and an
 *      absent ledger produce `unknown`. NONE of these was visible to the
 *      `checkSchemaVersion()` check this replaced.
 *   2. **Cost.** `getSchemaReadiness()` re-reads and hashes every packaged
 *      migration and then reads the whole ledger — ~50-100 ms on this repo. A
 *      load-balancer poll must not turn that into a load generator, so the
 *      verdict is cached for `SCHEMA_READINESS_TTL_MS` and concurrent polls are
 *      coalesced into ONE evaluation.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/db/client.js', () => ({
  // `schema-readiness.js` binds the application pool at import time. Every test
  // here injects its own pool, so this only has to exist.
  pool: { connect: vi.fn() },
}));

import {
  checkSchemaReadiness,
  describeSchemaReadiness,
  SCHEMA_READINESS_TTL_MS,
  _resetSchemaReadinessCacheForTests,
  _setSchemaReadinessDepsForTests,
} from '@/runtime/lifecycle/schema-readiness.js';
import { config } from '@/config/env.js';
import { migrationChecksum } from '@/migrations/checksum.js';
import { LEDGER_V2_COLUMNS } from '@/migrations/ledger.js';
import type { ReadOnlyPool, ReadOnlyPoolClient } from '@/migrations/index.js';

// ── the packaged artifact under test ─────────────────────────────────────────
const FILES: Record<string, string> = {
  '001_first.sql': 'CREATE TABLE a (id int);\n',
  '002_head.sql': 'CREATE TABLE b (id int);\n',
};
const HEAD = '002_head.sql';

const tempDirs: string[] = [];

async function makeMigrationsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'maia-schema-readiness-'));
  tempDirs.push(dir);
  for (const [name, sql] of Object.entries(FILES)) {
    await writeFile(join(dir, name), sql, 'utf8');
    // AGENTS.md §4 rule 6: a forward migration without its `_down` sibling is
    // an ARTIFACT problem. Those are reported but deliberately do NOT block
    // readiness, so shipping them keeps these cases about the schema only.
    await writeFile(join(dir, name.replace('.sql', '_down.sql')), 'DROP TABLE a;\n', 'utf8');
  }
  return dir;
}

function checksumOf(name: string): string {
  return migrationChecksum(FILES[name]!);
}

// ── the fake ledger ──────────────────────────────────────────────────────────
type LedgerRow = {
  id: string;
  status: string;
  checksum_sha256: string | null;
  checksum_source: string | null;
};

const V2_COLUMNS = ['id', 'applied_at', ...LEDGER_V2_COLUMNS];

interface FakeDb {
  readonly pool: ReadOnlyPool;
  /** How many times a connection was borrowed — i.e. real evaluations. */
  readonly connects: () => number;
  readonly released: () => number;
}

function fakeDb(
  rows: readonly LedgerRow[],
  options: { ledger?: 'v2' | 'absent'; connectError?: Error; delayMs?: number } = {},
): FakeDb {
  let connects = 0;
  let released = 0;
  const columns = options.ledger === 'absent' ? [] : V2_COLUMNS;
  return {
    connects: () => connects,
    released: () => released,
    pool: {
      async connect() {
        connects++;
        if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
        if (options.connectError) throw options.connectError;
        const client: ReadOnlyPoolClient = {
          query: <R,>(text: string): Promise<{ rows: R[] }> => {
            const out = text.includes('information_schema.columns')
              ? columns.map((column_name) => ({ column_name }))
              : rows.map((r) => ({
                  applied_at: '2026-01-01T00:00:00.000Z',
                  started_at: null,
                  execution_ms: 12,
                  app_version: '3.1.0',
                  runner_version: '2',
                  error_class: null,
                  repaired_at: null,
                  repair_reason: null,
                  ...r,
                }));
            return Promise.resolve({ rows: out as unknown as R[] });
          },
          release: () => {
            released++;
          },
        };
        return client;
      },
    },
  };
}

function appliedRow(name: string, overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: name,
    status: 'applied',
    checksum_sha256: checksumOf(name),
    checksum_source: 'computed',
    ...overrides,
  };
}

async function install(db: FakeDb): Promise<void> {
  _setSchemaReadinessDepsForTests({ pool: db.pool, migrationsDir: await makeMigrationsDir() });
}

beforeEach(() => {
  _resetSchemaReadinessCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  _setSchemaReadinessDepsForTests(null);
});

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe('checkSchemaReadiness — the verdict', () => {
  it('a fully applied schema with matching checksums is READY', async () => {
    await install(fakeDb([appliedRow('001_first.sql'), appliedRow(HEAD)]));
    const r = await checkSchemaReadiness();
    expect(r.state).toBe('ready');
    expect(r.ready).toBe(true);
    expect(r.applied_head).toBe(HEAD);
  });

  it('a DIRTY ledger row blocks', async () => {
    await install(
      fakeDb([appliedRow('001_first.sql'), appliedRow(HEAD, { status: 'dirty' })]),
    );
    const r = await checkSchemaReadiness();
    expect(r.state).toBe('blocked');
    expect(r.ready).toBe(false);
    expect(r.blockers.map((b) => b.kind)).toContain('dirty_migration');
  });

  it('a CHECKSUM DIVERGENCE between the packaged file and the ledger blocks', async () => {
    await install(
      fakeDb([
        appliedRow('001_first.sql'),
        appliedRow(HEAD, { checksum_sha256: 'f'.repeat(64) }),
      ]),
    );
    const r = await checkSchemaReadiness();
    expect(r.state).toBe('blocked');
    expect(r.blockers.map((b) => b.kind)).toContain('checksum_mismatch');
  });

  it('an applied migration whose FILE this build does not ship blocks', async () => {
    await install(
      fakeDb([
        appliedRow('001_first.sql'),
        appliedRow(HEAD),
        { id: '003_from_the_future.sql', status: 'applied', checksum_sha256: 'a'.repeat(64), checksum_source: 'computed' },
      ]),
    );
    const r = await checkSchemaReadiness();
    expect(r.state).toBe('blocked');
    expect(r.blockers.map((b) => b.kind)).toContain('missing_file');
  });

  it('an INCOMPATIBLE schema (applied head ≠ expected head) blocks', async () => {
    await install(fakeDb([appliedRow('001_first.sql')])); // head never applied
    const r = await checkSchemaReadiness();
    expect(r.state).toBe('blocked');
    expect(r.expected_head).toBe(HEAD);
    expect(r.applied_head).toBe('001_first.sql');
    expect(r.blockers.map((b) => b.kind)).toContain('schema_below_minimum');
  });

  it('an applied migration with NO recorded checksum blocks (unverifiable is not healthy)', async () => {
    await install(
      fakeDb([
        appliedRow('001_first.sql'),
        appliedRow(HEAD, { checksum_sha256: null, checksum_source: null }),
      ]),
    );
    const r = await checkSchemaReadiness();
    expect(r.state).toBe('blocked');
    expect(r.blockers.map((b) => b.kind)).toContain('checksum_unknown');
  });

  it('a database that cannot be reached is UNKNOWN — never ready', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    await install(fakeDb([], { connectError: err }));
    const r = await checkSchemaReadiness();
    expect(r.state).toBe('unknown');
    expect(r.ready).toBe(false);
    // CLASS only — a pg error message embeds the DSN, password included.
    expect(JSON.stringify(r)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED 127/);
  });

  it('an ABSENT ledger is UNKNOWN, not "nothing to do"', async () => {
    await install(fakeDb([], { ledger: 'absent' }));
    const r = await checkSchemaReadiness();
    expect(r.state).toBe('unknown');
    expect(r.blockers.map((b) => b.kind)).toContain('ledger_missing');
  });

  it('an unreadable migrations directory is UNKNOWN, not ready', async () => {
    _setSchemaReadinessDepsForTests({
      pool: fakeDb([]).pool,
      migrationsDir: join(tmpdir(), 'maia-does-not-exist-', String(Date.now())),
    });
    const r = await checkSchemaReadiness();
    expect(r.state).toBe('unknown');
    expect(r.ready).toBe(false);
  });

  it('releases the pooled connection on every path', async () => {
    const db = fakeDb([appliedRow('001_first.sql'), appliedRow(HEAD)]);
    await install(db);
    await checkSchemaReadiness();
    expect(db.released()).toBe(1);
  });
});

describe('checkSchemaReadiness — cost control', () => {
  it('serves repeated polls from ONE evaluation inside the TTL', async () => {
    const db = fakeDb([appliedRow('001_first.sql'), appliedRow(HEAD)]);
    await install(db);
    for (let i = 0; i < 20; i++) await checkSchemaReadiness();
    // Without the cache this is 20 ledger reads + 20 full re-hashes of the
    // packaged artifact, per replica, at the load balancer's poll rate.
    expect(db.connects()).toBe(1);
  });

  it('COALESCES concurrent polls into one evaluation (a slow DB must not pile up)', async () => {
    const db = fakeDb([appliedRow('001_first.sql'), appliedRow(HEAD)], { delayMs: 30 });
    await install(db);
    const all = await Promise.all(Array.from({ length: 10 }, () => checkSchemaReadiness()));
    expect(db.connects()).toBe(1);
    expect(all.every((r) => r.state === 'ready')).toBe(true);
  });

  it('caches the NEGATIVE verdict too — a DB outage must not become a probe storm', async () => {
    const db = fakeDb([], { connectError: new Error('down') });
    await install(db);
    for (let i = 0; i < 10; i++) expect((await checkSchemaReadiness()).state).toBe('unknown');
    expect(db.connects()).toBe(1);
  });

  it('re-evaluates once the TTL expires — the gate is never pinned to a stale verdict', async () => {
    const db = fakeDb([appliedRow('001_first.sql'), appliedRow(HEAD)]);
    await install(db);
    const t0 = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    await checkSchemaReadiness();
    expect(db.connects()).toBe(1);

    vi.setSystemTime(t0 + SCHEMA_READINESS_TTL_MS - 1);
    await checkSchemaReadiness();
    expect(db.connects()).toBe(1);

    vi.setSystemTime(t0 + SCHEMA_READINESS_TTL_MS + 1);
    await checkSchemaReadiness();
    expect(db.connects()).toBe(2);
  });

  it('the TTL is short enough to drain traffic inside a load balancer decision window', () => {
    // A stale POSITIVE is the dangerous direction: the schema became
    // incompatible and this instance keeps answering 200 for up to one TTL.
    // The bound has to stay well under the time a load balancer itself needs to
    // declare a target unhealthy (2-3 failures at a 5-10s interval).
    expect(SCHEMA_READINESS_TTL_MS).toBeGreaterThan(0);
    expect(SCHEMA_READINESS_TTL_MS).toBeLessThanOrEqual(15_000);
  });

  // One TTL is not the end-to-end bound, and saying "up to 10 s" out loud while
  // the real number is 12 s is the kind of thing that gets discovered during an
  // incident. `/readyz` sits behind a SECOND cache: `evaluateComponents()` in
  // `readiness.ts` memoizes the whole component set for `READINESS_CACHE_MS`. A
  // composite entry filled one millisecond before this module's TTL expires
  // keeps serving that verdict until the composite entry itself expires.
  //
  // These two cases exist so the doc cannot rot: change either constant and the
  // arithmetic here reports the new number instead of the comment lying.
  describe('the COMPOSITE staleness bound, not just this module TTL', () => {
    it('is the sum of both caches — the two layers add, they do not overlap', () => {
      const composite = SCHEMA_READINESS_TTL_MS + config.READINESS_CACHE_MS;

      // Worst case, spelled out rather than asserted as a magic number: the
      // verdict is computed at t=0 and is reusable until t=TTL; the composite
      // cache is filled at t=TTL-1 and is reusable for READINESS_CACHE_MS more.
      expect(composite).toBe(SCHEMA_READINESS_TTL_MS + config.READINESS_CACHE_MS);
      expect(composite).toBeGreaterThan(SCHEMA_READINESS_TTL_MS);

      // At the shipped defaults (10 s + 2 s) this is 12 s. Pinned so that
      // raising the default of either one is a decision someone makes on
      // purpose, in this file, and not a side effect noticed later.
      expect(composite).toBe(12_000);
    });

    it('stays inside the load balancer decision window even summed', () => {
      // The whole argument for the TTL is "the cache is never the thing that
      // decides how fast traffic drains". That argument has to survive the
      // composite bound, not just this module's slice of it.
      expect(SCHEMA_READINESS_TTL_MS + config.READINESS_CACHE_MS).toBeLessThanOrEqual(15_000);
    });
  });
});

describe('describeSchemaReadiness — what reaches the public probe body', () => {
  it('names the blocker kinds and the reason', async () => {
    await install(
      fakeDb([appliedRow('001_first.sql'), appliedRow(HEAD, { status: 'dirty' })]),
    );
    const detail = describeSchemaReadiness(await checkSchemaReadiness());
    expect(detail).toMatch(/^blocked \(dirty_migration\): /);
    expect(detail).toContain(HEAD);
  });

  it('is bounded — a database with many blockers cannot blow up the probe body', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: `9${String(i).padStart(2, '0')}_ghost.sql`,
      status: 'applied',
      checksum_sha256: 'a'.repeat(64),
      checksum_source: 'computed',
    }));
    await install(fakeDb([appliedRow('001_first.sql'), appliedRow(HEAD), ...rows]));
    const detail = describeSchemaReadiness(await checkSchemaReadiness());
    expect(detail.length).toBeLessThanOrEqual(400);
  });
});
