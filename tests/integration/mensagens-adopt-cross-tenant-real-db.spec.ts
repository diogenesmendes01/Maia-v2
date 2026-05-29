/**
 * Issue #290 / PR #311 — CRITICAL P0: cross-tenant adoption race on REAL Postgres.
 *
 * The Codex consolidated review of PR #311 flagged `adoptToResolvedTenantCrossTenant`
 * (src/db/repositories.ts) as a P0 cross-tenant leak:
 *
 *   The Baileys gateway persists every inbound under the legacy
 *   `default/default` context, then the agent worker ADOPTS the row into the
 *   tenant the channel resolver discovered. The original UPDATE was keyed by
 *   `id` ALONE:
 *       UPDATE mensagens SET tenant_id=$t, agent_id=$a WHERE id=$1
 *   so ANY caller holding the id could rewrite the row's tenant/agent to an
 *   arbitrary triplet AT ANY TIME — including after the row had already been
 *   adopted into tenant-A. A concurrent worker that re-resolved the same row
 *   to tenant-B (stale resolver cache, mis-seeded channel, a BullMQ retry
 *   racing a fresh enqueue) would silently STEAL the row across the tenant
 *   boundary, violating the inviolable isolation contract.
 *
 * THE FIX (compare-and-swap):
 *   The UPDATE now re-asserts the row is still `default/default` in its WHERE
 *   clause and `.returning()`s the id, so the repo can report whether THIS
 *   call won the swap:
 *       UPDATE mensagens SET tenant_id=$t, agent_id=$a
 *        WHERE id=$1 AND tenant_id='default' AND agent_id='default'
 *       RETURNING id
 *   A row can therefore be adopted out of `default/default` EXACTLY ONCE.
 *
 * WHY A REAL-POSTGRES TEST (not the in-memory drizzle fake):
 *   The whole safety property lives in the SQL WHERE clause and Postgres'
 *   single-statement row-lock atomicity. An in-memory fake that models
 *   `.where(eq(id))` could trivially "pass" while the production predicate
 *   silently dropped the `tenant_id='default'` guard — exactly the regression
 *   we must catch. Only a real database proves:
 *     (a) the second adoption into a DIFFERENT tenant is rejected (rowCount 0)
 *         and the row's owner is UNCHANGED — no leak;
 *     (b) two CONCURRENT adoptions on the same default/default row cannot both
 *         win — exactly one observes rowCount 1, and the final owner is the
 *         winner's tenant, never a blend.
 *
 * ---------------------------------------------------------------------------
 * RUNTIME REQUIREMENT — DOCKER DAEMON
 *
 * This spec requires a reachable Docker daemon (same as the issue #218
 * skills-repo real-db spec). Locally that means Docker Desktop running. In CI
 * it requires a Docker-enabled job. Until that lands, run it explicitly:
 *
 *     npm run test:integration:real-db
 *
 * `SKIP_DOCKER_TESTS=1` forces skip (handy for `vitest --watch`). The suite
 * cleanly SKIPS (does not fail) when Docker is unreachable.
 * ---------------------------------------------------------------------------
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  startPostgresContainer,
  stopPostgresContainer,
  isDockerAvailable,
  type StartedPostgres,
} from './_fixtures/postgres-testcontainer.js';

// Imported LATE (inside beforeAll) because production `@/db/client.js` captures
// `DATABASE_URL` at module load — the container URI is only known after start.
type RepositoriesModule = typeof import('@/db/repositories.js');
type TenantContextModule = typeof import('@/db/tenant-context.js');
type DbClientModule = typeof import('@/db/client.js');
let repositoriesMod: RepositoriesModule;
let tenantContextMod: TenantContextModule;
let dbClientMod: DbClientModule;

let pg: StartedPostgres;
let previousDatabaseUrl: string | undefined;

const SHOULD_RUN = await isDockerAvailable();
const d = SHOULD_RUN ? describe : describe.skip;

// Distinct tenant/agent slugs so we never collide with the migration-seeded
// 'default' tenant or any sibling real-db spec.
const TENANT_A = 'tenant-A-issue-290';
const AGENT_A = 'agent-A-issue-290';
const TENANT_B = 'tenant-B-issue-290';
const AGENT_B = 'agent-B-issue-290';

// Deterministic UUIDs (the `mensagens.id` column is UUID PRIMARY KEY).
const ROW_ID = '00000000-0000-0000-0000-0000000002901';
const ROW_ID_2 = '00000000-0000-0000-0000-0000000002902';

/**
 * Insert an inbound `mensagens` row directly via raw SQL, starting in the
 * legacy `default/default` context (exactly how the Baileys gateway persists
 * it at ingress, before the worker adopts it). Only the NOT NULL columns and
 * the two scope columns are set; the rest fall back to schema defaults.
 */
async function insertDefaultDefaultRow(id: string, whatsappId: string): Promise<void> {
  await pg.pool.query(
    `
    INSERT INTO mensagens (id, tenant_id, agent_id, direcao, tipo, conteudo, metadata)
    VALUES ($1::uuid, 'default', 'default', 'in', 'texto', 'oi maia', $2::jsonb)
    `,
    [id, JSON.stringify({ whatsapp_id: whatsappId, telefone: '+5511999990001' })],
  );
}

/** Read the current (tenant_id, agent_id) of a row straight from the table. */
async function ownerOf(id: string): Promise<{ tenant_id: string; agent_id: string } | null> {
  const res = await pg.pool.query<{ tenant_id: string; agent_id: string }>(
    'SELECT tenant_id, agent_id FROM mensagens WHERE id = $1::uuid',
    [id],
  );
  return res.rows[0] ?? null;
}

d('mensagensRepo.adoptToResolvedTenantCrossTenant — cross-tenant adoption race (issue #290 / PR #311 P0)', () => {
  beforeAll(async () => {
    pg = await startPostgresContainer();
    previousDatabaseUrl = process.env.DATABASE_URL;
    // Set DATABASE_URL to the container URI BEFORE importing anything that
    // pulls in @/db/client.js (the pool captures the URL at module load).
    process.env.DATABASE_URL = pg.uri;
    repositoriesMod = await import('@/db/repositories.js');
    tenantContextMod = await import('@/db/tenant-context.js');
    dbClientMod = await import('@/db/client.js');
  }, /* image pull on first run */ 180_000);

  afterAll(async () => {
    if (dbClientMod) await dbClientMod.shutdownDb().catch(() => undefined);
    if (pg) await stopPostgresContainer(pg);
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  beforeEach(async () => {
    // Clear any rows from a prior test (both ids + both tenant slugs + the
    // default rows we seed).
    await pg.pool.query(
      `DELETE FROM mensagens WHERE id IN ($1::uuid, $2::uuid)`,
      [ROW_ID, ROW_ID_2],
    );
  });

  // Adoption legitimately runs WITHOUT an ALS context (it IS the entry point
  // discovering the tenant). We still wrap a couple of assertions in an
  // explicit context to prove the bypass is not accidentally tenant-scoped.
  const adopt = (id: string, tenant_id: string, agent_id: string) =>
    repositoriesMod.mensagensRepo.adoptToResolvedTenantCrossTenant({
      id,
      tenant_id,
      agent_id,
    });

  // -------------------------------------------------------------------------
  // 1. Happy path — a default/default row is adopted into tenant-A exactly once.
  // -------------------------------------------------------------------------
  it('adopts a default/default row into tenant-A (returns true; row now owned by tenant-A)', async () => {
    await insertDefaultDefaultRow(ROW_ID, 'WAID-A-1');

    const won = await adopt(ROW_ID, TENANT_A, AGENT_A);
    expect(won).toBe(true);

    expect(await ownerOf(ROW_ID)).toEqual({ tenant_id: TENANT_A, agent_id: AGENT_A });
  });

  // -------------------------------------------------------------------------
  // 2. THE P0: a row already adopted by tenant-A is NOT re-adoptable by tenant-B.
  // -------------------------------------------------------------------------
  it('rejects re-adoption into tenant-B once owned by tenant-A (returns false; owner UNCHANGED — no leak)', async () => {
    await insertDefaultDefaultRow(ROW_ID, 'WAID-A-2');

    // tenant-A wins the (only) swap out of default/default.
    expect(await adopt(ROW_ID, TENANT_A, AGENT_A)).toBe(true);

    // tenant-B now tries to steal the SAME row. Pre-fix (WHERE id only) this
    // UPDATE matched and silently re-homed the row to tenant-B. Post-fix the
    // WHERE no longer matches (row is tenant-A, not default/default), so the
    // swap MISSES.
    const stolen = await adopt(ROW_ID, TENANT_B, AGENT_B);
    expect(stolen).toBe(false);

    // The load-bearing assertion: the row STILL belongs to tenant-A. A
    // regression that dropped the default/default guard would surface here as
    // tenant-B ownership.
    expect(await ownerOf(ROW_ID)).toEqual({ tenant_id: TENANT_A, agent_id: AGENT_A });
  });

  // -------------------------------------------------------------------------
  // 3. Idempotency — re-adopting into the SAME tenant after the row moved is a
  //    rowCount=0 no-op (compare-and-swap miss), NOT a silent success.
  // -------------------------------------------------------------------------
  it('re-adopting into the same tenant after the row moved returns false (idempotent no-op, owner unchanged)', async () => {
    await insertDefaultDefaultRow(ROW_ID, 'WAID-A-3');

    expect(await adopt(ROW_ID, TENANT_A, AGENT_A)).toBe(true);
    // BullMQ retry: same target tenant. Row is no longer default/default → miss.
    expect(await adopt(ROW_ID, TENANT_A, AGENT_A)).toBe(false);
    // Owner is still tenant-A — the caller in agent/core.ts treats this false
    // as "already owned by me" via findOwnerByIdCrossTenant and proceeds.
    expect(await ownerOf(ROW_ID)).toEqual({ tenant_id: TENANT_A, agent_id: AGENT_A });
  });

  // -------------------------------------------------------------------------
  // 4. CONCURRENCY — two adoptions race on the same default/default row.
  //    Exactly one wins; the final owner is the winner's tenant, never a blend.
  // -------------------------------------------------------------------------
  it('concurrent adoption by tenant-A and tenant-B: exactly one wins, the row never leaks to the loser', async () => {
    await insertDefaultDefaultRow(ROW_ID, 'WAID-RACE-1');

    // Fire both adoptions concurrently against the SAME row. Postgres serialises
    // the two UPDATEs via the row lock; the compare-and-swap guarantees only the
    // first to acquire the lock matches default/default.
    const [aWon, bWon] = await Promise.all([
      adopt(ROW_ID, TENANT_A, AGENT_A),
      adopt(ROW_ID, TENANT_B, AGENT_B),
    ]);

    // Exactly one winner — never both, never neither.
    expect([aWon, bWon].filter(Boolean)).toHaveLength(1);

    const owner = await ownerOf(ROW_ID);
    expect(owner).not.toBeNull();
    if (aWon) {
      expect(owner).toEqual({ tenant_id: TENANT_A, agent_id: AGENT_A });
    } else {
      expect(owner).toEqual({ tenant_id: TENANT_B, agent_id: AGENT_B });
    }
    // Whichever lost, the owner is a SINGLE coherent tenant triplet — there is
    // no interleaving that leaves the row half-owned or owned by the loser.
    expect(owner).not.toEqual({ tenant_id: 'default', agent_id: 'default' });
  });

  it('many concurrent adoptions (5 distinct tenants) on one row: exactly one wins; others all miss', async () => {
    await insertDefaultDefaultRow(ROW_ID, 'WAID-RACE-N');

    const contenders = [
      { t: 'tenant-c1-290', a: 'agent-c1' },
      { t: 'tenant-c2-290', a: 'agent-c2' },
      { t: 'tenant-c3-290', a: 'agent-c3' },
      { t: 'tenant-c4-290', a: 'agent-c4' },
      { t: 'tenant-c5-290', a: 'agent-c5' },
    ];
    const results = await Promise.all(contenders.map((c) => adopt(ROW_ID, c.t, c.a)));

    // Precisely one true across all contenders.
    expect(results.filter(Boolean)).toHaveLength(1);

    const winnerIdx = results.findIndex(Boolean);
    const winner = contenders[winnerIdx]!;
    expect(await ownerOf(ROW_ID)).toEqual({ tenant_id: winner.t, agent_id: winner.a });

    // Cleanup the bespoke tenant slugs this test used.
    await pg.pool.query(`DELETE FROM mensagens WHERE id = $1::uuid`, [ROW_ID]);
  });

  // -------------------------------------------------------------------------
  // 5. findOwnerByIdCrossTenant — returns the true owner regardless of ALS.
  //    This is the helper the caller uses to decide whether a lost swap was an
  //    idempotent retry (we own it) or a cross-tenant conflict (someone else
  //    owns it). It MUST ignore the ambient tenant context.
  // -------------------------------------------------------------------------
  it('findOwnerByIdCrossTenant returns the real owner even when called under a DIFFERENT tenant context', async () => {
    await insertDefaultDefaultRow(ROW_ID_2, 'WAID-OWNER-1');
    expect(await adopt(ROW_ID_2, TENANT_A, AGENT_A)).toBe(true);

    // Call the owner lookup while the ALS says tenant-B. A tenant-scoped read
    // would return null here; the cross-tenant helper must still see tenant-A.
    const owner = await tenantContextMod.runWithTenantContext(
      { tenant_id: TENANT_B, agent_id: AGENT_B },
      () => repositoriesMod.mensagensRepo.findOwnerByIdCrossTenant(ROW_ID_2),
    );
    expect(owner).toEqual({ tenant_id: TENANT_A, agent_id: AGENT_A });
  });

  it('findOwnerByIdCrossTenant returns null for a non-existent id', async () => {
    const owner = await repositoriesMod.mensagensRepo.findOwnerByIdCrossTenant(
      '00000000-0000-0000-0000-0000000009999',
    );
    expect(owner).toBeNull();
  });
});
