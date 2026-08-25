/**
 * Issue #512 — lifecycle probes against REAL Postgres + Redis.
 *
 * Covers the acceptance criteria that cannot be proven with mocks:
 *   - `/health` performs NO writes (the row count of `system_health_events`
 *     is unchanged after a burst of polls);
 *   - `/livez` answers 200 with the database intentionally left out of the
 *     picture (no I/O at all);
 *   - `/startupz` and `/readyz` stay 503 until the lifecycle reaches `ready`,
 *     even though HTTP is already listening (the early-listener escape hatch
 *     in issue #512 §4 must never mean "in rotation");
 *   - `/readyz` returns 503 IMMEDIATELY when the drain starts;
 *   - the schema gate agrees with a fully migrated database.
 *
 * Issue #516 adds the schema gate itself, driven through the REAL route on the
 * REAL server: every schema condition that must keep an instance out of
 * rotation is asserted as an HTTP 503 from `GET /readyz` on `buildServer()`,
 * not from a hand-rolled Fastify app that mirrors the handler. A mirror passes
 * even when the production call site is deleted; this does not.
 *
 * The schema conditions are produced by INJECTING a read-only pool and a
 * temporary migrations directory into the gate — never by mutating
 * `schema_migrations` in the shared test database, which would corrupt every
 * other spec running against it.
 *
 * Skipped without TEST_DB_URL (mirrors the sibling integration specs).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import pg from 'pg';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '@/server.js';
import { lifecycle } from '@/runtime/lifecycle/controller.js';
import { _resetReadinessCacheForTests } from '@/runtime/lifecycle/readiness.js';
import {
  checkSchemaReadiness,
  _resetSchemaReadinessCacheForTests,
  _setSchemaReadinessDepsForTests,
} from '@/runtime/lifecycle/schema-readiness.js';
import { describeSchemaBootFailure } from '@/runtime/lifecycle/schema-boot-gate.js';
import { migrationChecksum } from '@/migrations/checksum.js';
import { LEDGER_V2_COLUMNS } from '@/migrations/ledger.js';
import type { ReadOnlyPool, ReadOnlyPoolClient } from '@/migrations/index.js';
import { _resetHealthCacheForTests } from '@/lib/healthcheck.js';
import { ensureRedisConnect } from '@/lib/redis.js';
import { LIFECYCLE_COMPONENTS } from '@/runtime/lifecycle/roles.js';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;
let app: FastifyInstance;

async function healthRowCount(): Promise<number> {
  const c = await pool.connect();
  try {
    const r = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM system_health_events');
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

/** Bring every component to `ready` the way `src/index.ts` does at boot. */
function markAllComponentsReady(): void {
  for (const c of LIFECYCLE_COMPONENTS) lifecycle.setComponent(c, 'ready');
}

d('issue #512 — lifecycle probes (real deps)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await ensureRedisConnect();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(() => {
    lifecycle._resetForTests();
    _resetReadinessCacheForTests();
    _resetHealthCacheForTests();
    _resetSchemaReadinessCacheForTests();
  });

  it('/health writes NO rows, however hard it is polled', async () => {
    const before = await healthRowCount();
    for (let i = 0; i < 8; i++) {
      _resetHealthCacheForTests(); // defeat the cache so every poll really probes
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect([200]).toContain(res.statusCode);
    }
    // Give any (bug-introduced) fire-and-forget INSERT a chance to land.
    await new Promise((r) => setTimeout(r, 300));
    expect(await healthRowCount()).toBe(before);
  });

  it('/health never returns raw driver text', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.body;
    expect(body).not.toMatch(/"details"/);
    expect(body).not.toMatch(/password|ECONNREFUSED|postgres:\/\//i);
  });

  it('/livez is 200 while the lifecycle is still `starting` (no dependency)', async () => {
    const res = await app.inject({ method: 'GET', url: '/livez' });
    expect(res.statusCode).toBe(200);
    expect(res.json().live).toBe(true);
    expect(res.json().state).toBe('starting');
  });

  it('/startupz and /readyz are 503 while starting, even though HTTP listens', async () => {
    expect((await app.inject({ method: 'GET', url: '/startupz' })).statusCode).toBe(503);
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().reason).toMatch(/starting/i);
  });

  it('/readyz turns 200 once the lifecycle is ready and the real probes pass', async () => {
    markAllComponentsReady();
    lifecycle.transitionTo('ready');
    // The Redis memory snapshot needs one successful collect before the #297
    // gate stops failing closed; poll briefly rather than sleeping blindly.
    let status = 0;
    for (let i = 0; i < 40; i++) {
      _resetReadinessCacheForTests();
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      status = res.statusCode;
      if (status === 200) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(status).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/startupz' })).statusCode).toBe(200);
  }, 20_000);

  it('/readyz drops to 503 IMMEDIATELY when the drain starts', async () => {
    markAllComponentsReady();
    lifecycle.transitionTo('ready');
    // No cache reset here on purpose: the state check must bypass the cache.
    lifecycle.transitionTo('draining', 'SIGTERM');
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().reason).toMatch(/draining/i);
    // …and the startup probe stays positive so a slow drain is not killed.
    expect((await app.inject({ method: 'GET', url: '/startupz' })).statusCode).toBe(200);
  });

  it('the schema gate agrees with a fully migrated database', async () => {
    const r = await checkSchemaReadiness();
    expect(r.state).toBe('ready');
    expect(r.applied_head).toBe(r.expected_head);
    // …e o MESMO veredito é o gate de BOOT desde a #516 (ADR 0004): num banco
    // migrado ele não produz recusa nenhuma, então `src/index.ts` segue.
    expect(describeSchemaBootFailure(r)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Issue #516 — the schema gate, driven through the REAL `/readyz` route.
// ────────────────────────────────────────────────────────────────────────────

const FILES: Record<string, string> = {
  '001_first.sql': 'CREATE TABLE a (id int);\n',
  '002_head.sql': 'CREATE TABLE b (id int);\n',
};
const HEAD = '002_head.sql';
const V2_COLUMNS = ['id', 'applied_at', ...LEDGER_V2_COLUMNS];

type LedgerRow = {
  id: string;
  status: string;
  checksum_sha256: string | null;
  checksum_source: string | null;
};

function appliedRow(name: string, overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: name,
    status: 'applied',
    checksum_sha256: migrationChecksum(FILES[name] ?? ''),
    checksum_source: 'computed',
    ...overrides,
  };
}

/** A read-only pool that serves a crafted ledger. NOT the shared test DB. */
function ledgerPool(
  rows: readonly LedgerRow[],
  options: { connectError?: Error } = {},
): ReadOnlyPool {
  return {
    async connect() {
      if (options.connectError) throw options.connectError;
      const client: ReadOnlyPoolClient = {
        query: <R,>(text: string): Promise<{ rows: R[] }> => {
          const out = text.includes('information_schema.columns')
            ? V2_COLUMNS.map((column_name) => ({ column_name }))
            : rows.map((r) => ({
                applied_at: '2026-01-01T00:00:00.000Z',
                started_at: null,
                execution_ms: 1,
                app_version: null,
                runner_version: null,
                error_class: null,
                repaired_at: null,
                repair_reason: null,
                ...r,
              }));
          return Promise.resolve({ rows: out as unknown as R[] });
        },
        release: () => undefined,
      };
      return client;
    },
  };
}

d('issue #516 — /readyz gates on the canonical schema verdict (real route)', () => {
  let schemaApp: FastifyInstance;
  let migrationsDir: string;

  beforeAll(async () => {
    await ensureRedisConnect();
    schemaApp = await buildServer();
    await schemaApp.ready();
    migrationsDir = await mkdtemp(join(tmpdir(), 'maia-readyz-schema-'));
    for (const [name, sql] of Object.entries(FILES)) {
      await writeFile(join(migrationsDir, name), sql, 'utf8');
      await writeFile(join(migrationsDir, name.replace('.sql', '_down.sql')), 'DROP TABLE a;\n', 'utf8');
    }
  });

  afterAll(async () => {
    await schemaApp?.close();
    if (migrationsDir) await rm(migrationsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    lifecycle._resetForTests();
    _resetHealthCacheForTests();
    _resetReadinessCacheForTests();
    _resetSchemaReadinessCacheForTests();
  });

  afterEach(() => {
    _setSchemaReadinessDepsForTests(null);
    _resetReadinessCacheForTests();
  });

  /** Everything else healthy, so a 503 can only come from the schema gate. */
  async function readyzWith(pool: ReadOnlyPool): Promise<{ status: number; body: string }> {
    _setSchemaReadinessDepsForTests({ pool, migrationsDir });
    for (const c of LIFECYCLE_COMPONENTS) lifecycle.setComponent(c, 'ready');
    lifecycle.transitionTo('ready');
    // The #297 Redis-memory gate needs one successful collect before it stops
    // failing closed; poll until it is ok, so the only component that can still
    // be holding readiness down is the schema one.
    const memoryPending = (res: { json: () => unknown }): boolean => {
      const body = res.json() as { checks?: { component: string; status: string }[] };
      return (body.checks ?? []).some((c) => c.component === 'redis_memory' && c.status !== 'ok');
    };
    let res = await schemaApp.inject({ method: 'GET', url: '/readyz' });
    for (let i = 0; i < 40 && memoryPending(res); i++) {
      await new Promise((r) => setTimeout(r, 250));
      _resetReadinessCacheForTests();
      res = await schemaApp.inject({ method: 'GET', url: '/readyz' });
    }
    return { status: res.statusCode, body: res.body };
  }

  it('a fully applied, checksum-verified schema is 200', async () => {
    const r = await readyzWith(ledgerPool([appliedRow('001_first.sql'), appliedRow(HEAD)]));
    expect(r.status).toBe(200);
  }, 20_000);

  it('a DIRTY ledger row answers 503', async () => {
    const r = await readyzWith(
      ledgerPool([appliedRow('001_first.sql'), appliedRow(HEAD, { status: 'dirty' })]),
    );
    expect(r.status).toBe(503);
    expect(r.body).toMatch(/schema=down/);
    expect(r.body).toMatch(/dirty_migration/);
  }, 20_000);

  it('a CHECKSUM DIVERGENCE answers 503', async () => {
    const r = await readyzWith(
      ledgerPool([
        appliedRow('001_first.sql'),
        appliedRow(HEAD, { checksum_sha256: 'f'.repeat(64) }),
      ]),
    );
    expect(r.status).toBe(503);
    expect(r.body).toMatch(/checksum_mismatch/);
  }, 20_000);

  it('a migration FILE this build does not ship answers 503', async () => {
    const r = await readyzWith(
      ledgerPool([
        appliedRow('001_first.sql'),
        appliedRow(HEAD),
        {
          id: '003_from_the_future.sql',
          status: 'applied',
          checksum_sha256: 'a'.repeat(64),
          checksum_source: 'computed',
        },
      ]),
    );
    expect(r.status).toBe(503);
    expect(r.body).toMatch(/missing_file/);
  }, 20_000);

  it('an INCOMPATIBLE schema (applied head ≠ expected head) answers 503', async () => {
    const r = await readyzWith(ledgerPool([appliedRow('001_first.sql')]));
    expect(r.status).toBe(503);
    expect(r.body).toMatch(/schema_below_minimum/);
  }, 20_000);

  it('an UNAVAILABLE database answers 503 — `unknown` is NOT 200', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const r = await readyzWith(ledgerPool([], { connectError: err }));
    expect(r.status).toBe(503);
    expect(r.body).toMatch(/schema=unknown/);
    // The public body carries the error CLASS only — a pg message embeds the
    // DSN, password included.
    expect(r.body).not.toMatch(/127\.0\.0\.1/);
    expect(r.body).not.toMatch(/password/i);
  }, 20_000);
});
