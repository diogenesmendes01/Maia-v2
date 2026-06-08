/**
 * [🔴 CRITICAL — PR #417 review] cross-`channel_type` isolation leak in
 * `channelsRepo.findPrimaryCatchAllChannel`, proven on REAL Postgres.
 *
 * The consolidated review flagged the single-tenant catch-all discriminator as
 * a cross-tenant leak: the "is this deployment multi-tenant?" probe was scoped
 * to the inbound's `channel_type`, so a real tenant whose ACTIVE channel was a
 * DIFFERENT type (e.g. telegram) was invisible to a whatsapp inbound →
 * `multi_tenant` stayed false → the resolver handed `primary/primary` to a
 * deployment that HAS a real tenant. That collapses distinct tenants onto the
 * shared `maia:ratelimit:primary:primary:*` bucket — the exact cross-tenant
 * leak issue #268 closed. (issue #323: the single-tenant home is now `primary`,
 * re-homed from the legacy `default/default` by migration 081.)
 *
 * THE FIX (src/db/repositories.ts):
 *   1. GLOBAL discriminator (NO channel_type filter): any ACTIVE channel with
 *      tenant_id != 'primary' ⇒ { multi_tenant: true } (fail-closed).
 *   2. ONLY IF none exists: fetch the active primary/primary catch-all scoped by
 *      channel_type.
 *   Both reads run inside ONE `withTx` transaction (TOCTOU mitigation).
 *
 * WHY A REAL-POSTGRES TEST (not only the in-memory drizzle fake):
 *   The whole safety property lives in the SQL predicate of the discriminator
 *   probe — specifically that it OMITS the `channel_type` filter. An in-memory
 *   fake can "pass" while the production SQL silently keeps the channel_type
 *   predicate (the regression). Only a real database proves the global probe
 *   sees a cross-`channel_type` tenant. The control-flow / decision logic is
 *   additionally unit-tested in
 *   `tests/unit/gateway/channel-resolver-discriminator.spec.ts`.
 *
 * ---------------------------------------------------------------------------
 * RUNTIME REQUIREMENT — DOCKER DAEMON
 *
 * Requires a reachable Docker daemon (same as the issue #290 adoption real-db
 * spec). The suite cleanly SKIPS (does not fail) when Docker is unreachable.
 * Run explicitly with: `npm run test:integration:real-db`.
 * `SKIP_DOCKER_TESTS=1` forces skip.
 * ---------------------------------------------------------------------------
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  startPostgresContainer,
  stopPostgresContainer,
  isDockerAvailable,
  type StartedPostgres,
} from './_fixtures/postgres-testcontainer.js';

// Imported LATE (inside beforeAll) — @/db/client.js captures DATABASE_URL at
// module load, and the container URI is only known after start.
type RepositoriesModule = typeof import('@/db/repositories.js');
type DbClientModule = typeof import('@/db/client.js');
let repositoriesMod: RepositoriesModule;
let dbClientMod: DbClientModule;

let pg: StartedPostgres;
let previousDatabaseUrl: string | undefined;

const SHOULD_RUN = await isDockerAvailable();
const d = SHOULD_RUN ? describe : describe.skip;

// A real tenant, distinct from the migration-seeded 'primary' and any sibling
// real-db spec's slugs.
const REAL_TENANT = 'tenant-417-catchall';
const REAL_AGENT = 'agent-417-catchall';

/** Seed the tenants/agents FK parents for the real tenant (channels FK them). */
async function seedRealTenantParents(): Promise<void> {
  await pg.pool.query(
    `INSERT INTO tenants (id, nome, status) VALUES ($1, $2, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [REAL_TENANT, 'Tenant 417 catch-all real-db test'],
  );
  await pg.pool.query(
    `INSERT INTO agents (id, tenant_id, nome, status) VALUES ($1, $2, $3, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [REAL_AGENT, REAL_TENANT, 'Agent 417 catch-all real-db test'],
  );
}

/** Insert a channel row for the real tenant via raw SQL. */
async function insertRealTenantChannel(args: {
  channel_type: string;
  external_id: string;
  active: boolean;
}): Promise<void> {
  await pg.pool.query(
    `INSERT INTO channels (tenant_id, agent_id, external_id, channel_type, display_name, active)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      REAL_TENANT,
      REAL_AGENT,
      args.external_id,
      args.channel_type,
      `real ${args.channel_type}`,
      args.active,
    ],
  );
}

/** Remove only the real tenant's channels (keep the migration-seeded primary). */
async function clearRealTenantChannels(): Promise<void> {
  await pg.pool.query('DELETE FROM channels WHERE tenant_id = $1', [REAL_TENANT]);
}

d('channelsRepo.findPrimaryCatchAllChannel — cross-channel_type isolation on REAL Postgres (PR #417 🔴 CRITICAL)', () => {
  beforeAll(async () => {
    pg = await startPostgresContainer();
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = pg.uri;
    repositoriesMod = await import('@/db/repositories.js');
    dbClientMod = await import('@/db/client.js');
    await seedRealTenantParents();
  }, /* image pull on first run */ 180_000);

  afterAll(async () => {
    if (dbClientMod) await dbClientMod.shutdownDb().catch(() => undefined);
    if (pg) await stopPostgresContainer(pg);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  beforeEach(async () => {
    await clearRealTenantChannels();
  });

  it('baseline (only the migration-seeded primary/primary whatsapp channel) → single-tenant, returns the catch-all', async () => {
    const out = await repositoriesMod.channelsRepo.findPrimaryCatchAllChannel({
      channel_type: 'whatsapp',
    });
    expect(out.multi_tenant).toBe(false);
    expect(out.channel).not.toBeNull();
    expect(out.channel!.tenant_id).toBe('primary');
    expect(out.channel!.agent_id).toBe('primary');
    // external_id is unchanged by the rehome (081 only re-points tenant/agent);
    // the seeded catch-all keeps its inert placeholder id from migration 035.
    expect(out.channel!.external_id).toBe('default-channel');
  });

  // ── THE CRITICAL REGRESSION (cross-channel_type) ───────────────────────────
  it('🔴 CRITICAL: a real tenant with an ACTIVE *telegram* channel makes a *whatsapp* probe fail-closed (multi_tenant:true)', async () => {
    await insertRealTenantChannel({
      channel_type: 'telegram',
      external_id: 'tg-real-417',
      active: true,
    });

    const out = await repositoriesMod.channelsRepo.findPrimaryCatchAllChannel({
      channel_type: 'whatsapp', // DIFFERENT type than the real tenant's channel
    });

    // Against the OLD `WHERE channel_type = 'whatsapp'` discriminator this
    // returned { multi_tenant:false, channel:<default> } (the LEAK). The GLOBAL
    // probe (no channel_type filter) sees the telegram tenant → fail-closed.
    expect(out.multi_tenant).toBe(true);
    expect(out.channel).toBeNull();
  });

  it('a real tenant with an ACTIVE whatsapp channel makes a whatsapp probe fail-closed (same-type, multi_tenant:true)', async () => {
    await insertRealTenantChannel({
      channel_type: 'whatsapp',
      external_id: '+5511777770417',
      active: true,
    });

    const out = await repositoriesMod.channelsRepo.findPrimaryCatchAllChannel({
      channel_type: 'whatsapp',
    });
    expect(out.multi_tenant).toBe(true);
    expect(out.channel).toBeNull();
  });

  it('a real tenant whose only channel is INACTIVE (telegram) does NOT trip the discriminator → single-tenant, returns catch-all', async () => {
    await insertRealTenantChannel({
      channel_type: 'telegram',
      external_id: 'tg-inactive-417',
      active: false, // offboarded tenant — must not strand the single-tenant bot
    });

    const out = await repositoriesMod.channelsRepo.findPrimaryCatchAllChannel({
      channel_type: 'whatsapp',
    });
    expect(out.multi_tenant).toBe(false);
    expect(out.channel).not.toBeNull();
    expect(out.channel!.tenant_id).toBe('primary');
  });

  it('catch-all is channel_type-scoped: a telegram probe with no telegram default returns no channel (seed missing), still single-tenant', async () => {
    // Only the whatsapp default exists (migration 035 seeds whatsapp only); a
    // telegram inbound finds no telegram catch-all but is still single-tenant.
    const out = await repositoriesMod.channelsRepo.findPrimaryCatchAllChannel({
      channel_type: 'telegram',
    });
    expect(out.multi_tenant).toBe(false);
    expect(out.channel).toBeNull();
  });
});
