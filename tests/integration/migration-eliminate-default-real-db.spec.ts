/**
 * Issue #323 — eliminate the legacy `'default'` tenant from the runtime, proven
 * end-to-end on REAL Postgres after the full forward migration chain applies.
 *
 * The four new migrations together move the single-tenant runtime off `'default'`
 * and onto the reserved `'primary'` home:
 *   080 — seed the reserved `primary` tenant/agent.
 *   081 — rehome every runtime row from `default` → `primary` (UNION of
 *         tenant_id/agent_id name-columns + FK-to-tenants/agents columns, so it
 *         also catches `procedure_definitions.owner_agent_id` and the no-FK
 *         `outbound_messages`/`idempotency_effect_outbox`).
 *   082 — drop the `DEFAULT 'default'` column-default everywhere it existed, so a
 *         tenant-less INSERT fails NOT NULL instead of silently bucketing into
 *         `default` (closes the #282 silent fall-through).
 *   083 — delete the now-orphaned `default` tenant/agent registry rows.
 *
 * WHY A REAL-POSTGRES TEST (not the in-memory drizzle fake): the whole point is
 * the DB end-state — the dynamic rehome loop, the dropped column-default's NOT
 * NULL behaviour, and the FK-safe registry delete are all SQL/schema properties
 * that an in-memory fake cannot prove. This spec asserts the post-chain invariant
 * directly against the migrated schema.
 *
 * This spec asserts, after ALL forward migrations apply:
 *   1. REHOME COMPLETENESS — zero rows remain with tenant_id='default' OR
 *      agent_id='default' across every tenant/agent-scoped table, AND zero
 *      owner_agent_id='default' in procedure_definitions.
 *   2. FAIL-CLOSED INSERT — an INSERT omitting tenant_id on a default-bearing
 *      table (a 009 table `pessoas` AND the no-FK ledger `outbound_messages`)
 *      now raises a NOT NULL violation (the column-default is gone).
 *   3. REGISTRY — the `default` tenant/agent rows no longer exist; `primary` does.
 *
 * ---------------------------------------------------------------------------
 * RUNTIME REQUIREMENT — DOCKER DAEMON
 *
 * Requires a reachable Docker daemon (same as the sibling testcontainer specs,
 * e.g. channel-catch-all-cross-tenant-real-db). The suite cleanly SKIPS (does
 * not fail) when Docker is unreachable. `SKIP_DOCKER_TESTS=1` forces skip; run
 * explicitly with `npm run test:integration:real-db`.
 * ---------------------------------------------------------------------------
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startPostgresContainer,
  stopPostgresContainer,
  isDockerAvailable,
  type StartedPostgres,
} from './_fixtures/postgres-testcontainer.js';

// Imported LATE (inside beforeAll) — @/db/client.js captures DATABASE_URL at
// module load, and the container URI is only known after start. tenant-context
// supplies the canonical PRIMARY_* constants so the assertions can't drift from
// production.
type DbClientModule = typeof import('@/db/client.js');
type TenantContextModule = typeof import('@/db/tenant-context.js');
let dbClientMod: DbClientModule;
let tenantContextMod: TenantContextModule;

let pg: StartedPostgres;
let previousDatabaseUrl: string | undefined;

const SHOULD_RUN = await isDockerAvailable();
const d = SHOULD_RUN ? describe : describe.skip;

// The legacy literal being eliminated. Intentionally a hardcoded string (there
// is no exported constant for it any more — that is the point of #323).
const LEGACY = 'default';

d('migration: eliminate the default tenant (#323) — real DB', () => {
  beforeAll(async () => {
    pg = await startPostgresContainer();
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = pg.uri;
    dbClientMod = await import('@/db/client.js');
    tenantContextMod = await import('@/db/tenant-context.js');
  }, /* image pull on first run */ 180_000);

  afterAll(async () => {
    if (dbClientMod) await dbClientMod.shutdownDb().catch(() => undefined);
    if (pg) await stopPostgresContainer(pg);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  // -------------------------------------------------------------------------
  // 1. REHOME COMPLETENESS — no residual `default` anywhere a tenant/agent id
  //    can live. Discovers the SAME union migration 081 rehomes over, so a
  //    missed rehome column (the failure this guards) surfaces as an offender.
  // -------------------------------------------------------------------------
  it('rehome leaves ZERO residual default rows across all tenant/agent-scoped columns', async () => {
    // (a) columns named tenant_id/agent_id (catches no-FK holders like
    //     outbound_messages / idempotency_effect_outbox), UNION
    // (b) columns FK-referencing tenants(id)/agents(id) (catches the
    //     non-standard procedure_definitions.owner_agent_id). Excludes the
    //     tenants/agents registry tables themselves (their `default` rows are
    //     deleted by 083, asserted separately below).
    const { rows: cols } = await pg.pool.query<{ table_name: string; column_name: string }>(`
      SELECT DISTINCT t.table_name, t.column_name FROM (
        SELECT c.table_name, c.column_name
          FROM information_schema.columns c
         WHERE c.table_schema = 'public'
           AND c.column_name IN ('tenant_id', 'agent_id')
        UNION
        SELECT cl.relname AS table_name, att.attname AS column_name
          FROM pg_constraint con
          JOIN pg_class cl ON cl.oid = con.conrelid
          JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = 'public'
          JOIN pg_class rf ON rf.oid = con.confrelid
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
         WHERE con.contype = 'f' AND rf.relname IN ('tenants', 'agents')
      ) t
      WHERE t.table_name NOT IN ('tenants', 'agents')
      ORDER BY 1, 2
    `);
    // Sanity: discovery must find the scoped columns (a broken catalog query
    // that returns nothing would make the offender check vacuously pass).
    expect(cols.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const { table_name, column_name } of cols) {
      // Identifiers come straight from the pg catalog (real table/column names),
      // not user input; double-quote to be case/keyword safe.
      const { rows } = await pg.pool.query<{ has: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM public."${table_name}" WHERE "${column_name}" = $1
         ) AS has`,
        [LEGACY],
      );
      if (rows[0]!.has) offenders.push(`${table_name}.${column_name}`);
    }
    expect(
      offenders,
      `tables still holding '${LEGACY}' after rehome: ${offenders.join(', ')}`,
    ).toEqual([]);

    // Explicit owner_agent_id assertion (migration 018's non-standard agents-FK
    // column). The union above already covers it; this pins the exact column the
    // name-only discovery would have missed.
    const { rows: owner } = await pg.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM procedure_definitions WHERE owner_agent_id = $1`,
      [LEGACY],
    );
    expect(Number(owner[0]!.n)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 2. FAIL-CLOSED INSERT — the dropped column-default (082) turns a tenant-less
  //    INSERT into a loud NOT NULL violation instead of a silent `default`
  //    bucketing. Proven for a 009 FK-bearing table (pessoas) AND the no-FK
  //    ledger (outbound_messages) — the latter is the #282 silent fall-through
  //    that mattered most to close.
  // -------------------------------------------------------------------------
  it('the tenant_id column-default is gone on pessoas AND outbound_messages', async () => {
    const { rows } = await pg.pool.query<{ table_name: string; column_default: string | null }>(
      `SELECT table_name, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'tenant_id'
          AND table_name IN ('pessoas', 'outbound_messages')
        ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(['outbound_messages', 'pessoas']);
    for (const r of rows) {
      expect(r.column_default, `${r.table_name}.tenant_id must have NO column-default`).toBeNull();
    }
  });

  it('INSERT omitting tenant_id raises NOT NULL on a 009 table (pessoas)', async () => {
    // Provide every other NOT-NULL-without-default column (and agent_id) so the
    // ONLY null-violating column is tenant_id — the property under test.
    let err: (Error & { code?: string; column?: string }) | undefined;
    try {
      await pg.pool.query(
        `INSERT INTO pessoas (agent_id, nome, telefone_whatsapp, tipo)
         VALUES ('primary', 'nn-pessoa', '+5511900000771', 'cliente')`,
      );
    } catch (e) {
      err = e as Error & { code?: string; column?: string };
    }
    expect(err, 'tenant-less INSERT into pessoas must reject').toBeDefined();
    expect(err!.code).toBe('23502'); // not_null_violation
    // pg reports the offending column; fall back to the message for older drivers.
    expect(err!.column ?? '').toBe('tenant_id');
    expect(err!.message).toMatch(/tenant_id/);
  });

  it('INSERT omitting tenant_id raises NOT NULL on the no-FK ledger (outbound_messages)', async () => {
    let err: (Error & { code?: string; column?: string }) | undefined;
    try {
      await pg.pool.query(
        `INSERT INTO outbound_messages (agent_id, idempotency_key, conversa_id, in_reply_to, channel)
         VALUES ('primary', 'nn-key', gen_random_uuid(), gen_random_uuid(), 'text')`,
      );
    } catch (e) {
      err = e as Error & { code?: string; column?: string };
    }
    expect(err, 'tenant-less INSERT into outbound_messages must reject').toBeDefined();
    expect(err!.code).toBe('23502'); // not_null_violation
    expect(err!.column ?? '').toBe('tenant_id');
    expect(err!.message).toMatch(/tenant_id/);
  });

  // -------------------------------------------------------------------------
  // 3. REGISTRY — 083 deleted the `default` tenant/agent; 080 seeded `primary`.
  // -------------------------------------------------------------------------
  it('the default tenant/agent rows are deleted and primary exists', async () => {
    const PRIMARY = tenantContextMod.PRIMARY_TENANT_ID; // 'primary'
    const PRIMARY_AGENT = tenantContextMod.PRIMARY_AGENT_ID; // 'primary'

    const defTenant = await pg.pool.query(`SELECT 1 FROM tenants WHERE id = $1`, [LEGACY]);
    expect(defTenant.rowCount).toBe(0);
    const defAgent = await pg.pool.query(`SELECT 1 FROM agents WHERE id = $1`, [LEGACY]);
    expect(defAgent.rowCount).toBe(0);

    const primTenant = await pg.pool.query(`SELECT status FROM tenants WHERE id = $1`, [PRIMARY]);
    expect(primTenant.rowCount).toBe(1);
    const primAgent = await pg.pool.query(
      `SELECT 1 FROM agents WHERE id = $1 AND tenant_id = $2`,
      [PRIMARY_AGENT, PRIMARY],
    );
    expect(primAgent.rowCount).toBe(1);
  });
});
