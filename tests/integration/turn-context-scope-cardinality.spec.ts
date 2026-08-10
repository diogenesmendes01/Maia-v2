/**
 * Issue #525 / PR #541 review, finding 2 — the scope block must name EVERY
 * entity, at any scope size.
 *
 * ## The defect
 *
 * `entidadesRepo.byIdsWithState` folded two reads with different cardinality
 * into one statement and gave the merged result the SMALLER read's bound:
 *
 *   before #525   entidadesRepo.byIds(ids)            → no limit, ever
 *                 entityStatesRepo.byIds(ids, 500)    → LIMIT 500
 *   after  #525   byIdsWithState(ids, limit = 500)    → LIMIT 500 on the JOIN
 *
 * so from entity 501 onwards the ENTITY disappeared from the result too. The
 * renderer walks `ctx.scope.byEntity` (every grant, not just the rows it got
 * back) and falls through `ent?.nome ?? eid`, so those grants rendered a raw
 * UUID where a name belongs — inside "## Escopo desta conversa", the
 * permissions block, which `SECTION_BUDGETS` deliberately declares
 * non-truncatable. And because the JOIN orders by `entidades.id`, WHICH names
 * vanished was a function of UUID ordering: unrelated to the scope's own order,
 * unstable across inserts, and invisible to the operator.
 *
 * ## Why 501 entities on ONE profile
 *
 * A scope that big is reachable in production precisely because entities SHARE
 * permission profiles: `profilesRepo.byIds`'s own 500 cap is on distinct
 * PROFILES, so a tenant with one profile and thousands of entities sails past
 * it and lands on this one. The fixture reproduces that shape rather than an
 * artificial one.
 *
 * Skipped without TEST_DB_URL — the bug lives in SQL, so a mocked repository
 * would not have it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { runWithQueryCounter } from '@/db/query-counter.js';
import { renderTurnPrompt, type PromptContext } from '@/agent/prompt-builder.js';
import { loadTurnContext } from '@/agent/turn-context/loader.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import type { Conversa, Mensagem, Permissao, Pessoa, PermissionProfile } from '@/db/schema.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = { tenant_id: 'i541-f2-tenant', agent_id: 'i541-f2-agent' };

/** One past the old `LIMIT 500`, which is where the names started vanishing. */
const ENTITY_COUNT = 501;
/** How many of them carry an `entity_states` row. */
const WITH_STATE = 20;
const PROFILE_ID = 'i541-f2-shared-profile';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let pool: pg.Pool;
let entityIds: string[] = [];
let namesById = new Map<string, string>();

async function seed(c: pg.PoolClient): Promise<void> {
  await c.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
    T.tenant_id,
  ]);
  await c.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [T.agent_id, T.tenant_id],
  );
  await c.query(
    `INSERT INTO permission_profiles(id, tenant_id, agent_id, nome, acoes, limite_default)
     VALUES ($1, $2, $3, $1, ARRAY['registrar_transacao'], 100)
     ON CONFLICT (id) DO NOTHING`,
    [PROFILE_ID, T.tenant_id, T.agent_id],
  );

  // One statement for all 501 — the names are distinctive and index-stamped so
  // a missing one is identifiable, not just countable.
  const inserted = await c.query<{ id: string; nome: string }>(
    `INSERT INTO entidades(tenant_id, agent_id, nome, tipo)
     SELECT $1, $2, 'i541-f2-Entidade-' || lpad(g::text, 4, '0'), 'pj'
     FROM generate_series(1, $3) g
     RETURNING id, nome`,
    [T.tenant_id, T.agent_id, ENTITY_COUNT],
  );
  entityIds = inserted.rows.map((r) => r.id);
  namesById = new Map(inserted.rows.map((r) => [r.id, r.nome]));

  await c.query(
    `INSERT INTO entity_states(entidade_id, tenant_id, agent_id, saldo_consolidado)
     SELECT unnest($1::uuid[]), $2, $3, '42.00'`,
    [entityIds.slice(0, WITH_STATE), T.tenant_id, T.agent_id],
  );
}

/**
 * Cut the rendered "## Escopo desta conversa" section out of the system prompt.
 *
 * `lastIndexOf`, not `indexOf`: the heading is also QUOTED earlier, inside the
 * evidence-hierarchy preamble ("3. Bloco \"## Escopo desta conversa\" …"), and
 * slicing from the first hit would measure the preamble instead of the block.
 */
function scopeBlockOf(system: string): string {
  const start = system.lastIndexOf('## Escopo desta conversa');
  expect(start).toBeGreaterThan(-1);
  const end = system.indexOf('## Estado atual', start);
  expect(end).toBeGreaterThan(start);
  return system.slice(start, end);
}

function mkCtx(ids: string[]): PromptContext {
  const byEntity = new Map<string, ResolvedPermission>();
  for (const id of ids) {
    byEntity.set(id, {
      permissao: { id: `perm-${id}`, entidade_id: id } as unknown as Permissao,
      profile: {
        id: PROFILE_ID,
        nome: PROFILE_ID,
        acoes: ['*'],
        limite_default: '100',
      } as unknown as PermissionProfile,
      effective_limits: { valor_max: 100 },
    });
  }
  return {
    pessoa: {
      id: 'i541-f2-pessoa',
      nome: 'Owner',
      tipo: 'dono',
      status: 'ativa',
      metadata: {},
    } as unknown as Pessoa,
    conversa: { id: '00000000-0000-4000-8000-0000000000f2', metadata: {} } as unknown as Conversa,
    scope: { entidades: ids, byEntity },
    inbound: {
      id: 'i541-f2-msg',
      direcao: 'in',
      tipo: 'texto',
      conteudo: 'oi',
      ferramentas_chamadas: [],
      created_at: new Date('2026-05-11T15:00:00Z'),
    } as unknown as Mensagem,
    // The loader must not go looking for a procedure — this spec is about the
    // scope block, and skipping that read keeps the fixture minimal.
    activeExecution: null,
  };
}

d('#541 finding 2 — the scope block names every entity, past 500', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    const c = await pool.connect();
    try {
      await seed(c);
    } finally {
      c.release();
    }
  }, 120_000);

  afterAll(async () => {
    if (!pool) return;
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM entity_states WHERE tenant_id = $1`, [T.tenant_id]);
      await c.query(`DELETE FROM entidades WHERE tenant_id = $1`, [T.tenant_id]);
      await c.query(`DELETE FROM permission_profiles WHERE tenant_id = $1`, [T.tenant_id]);
      await c.query(`DELETE FROM agents WHERE tenant_id = $1`, [T.tenant_id]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [T.tenant_id]);
    } finally {
      c.release();
      await pool.end();
    }
  }, 120_000);

  it('returns ALL 501 entities from one statement — the entity side has no cap', async () => {
    const { entidadesRepo } = await import('@/db/repositories.js');
    const rows = await runWithTenantContext(T, () =>
      runWithQueryCounter(async (counter) => {
        const r = await entidadesRepo.byIdsWithState(entityIds);
        // Still ONE round-trip. The fix must not buy correctness with an extra
        // read — `TURN_ROUND_TRIP_BUDGET` is an executable ceiling.
        expect(counter.count).toBe(1);
        return r;
      }),
    );

    expect(rows).toHaveLength(ENTITY_COUNT);
    expect(new Set(rows.map((r) => r.entidade.id))).toEqual(new Set(entityIds));
    // Every row carries a real name, so nothing downstream can fall through to
    // an id.
    for (const r of rows) expect(r.entidade.nome).toBe(namesById.get(r.entidade.id));
  }, 60_000);

  it('still caps the STATE projection, which is what the old read capped', async () => {
    // The two halves have different cardinality on purpose: entities are
    // unbounded (as `byIds` always was), states keep the bound
    // `entityStatesRepo.byIds(ids, limit)` had. An entity past the state cap
    // comes back with `state: null` — the same shape an entity that genuinely
    // has no state row has, which is exactly what the renderer already handles.
    const { entidadesRepo } = await import('@/db/repositories.js');
    const rows = await runWithTenantContext(T, () =>
      entidadesRepo.byIdsWithState(entityIds, 5),
    );

    expect(rows).toHaveLength(ENTITY_COUNT);
    expect(rows.filter((r) => r.state !== null)).toHaveLength(5);
    // And at the real default, all 20 states are there — the cap is not
    // silently biting on an ordinary scope.
    const full = await runWithTenantContext(T, () => entidadesRepo.byIdsWithState(entityIds));
    expect(full.filter((r) => r.state !== null)).toHaveLength(WITH_STATE);
  }, 60_000);

  it('renders every name in the scope block, and leaks NO uuid into the prompt', async () => {
    const ctx = mkCtx(entityIds);
    const snapshot = await runWithTenantContext(T, () =>
      loadTurnContext({
        pessoa_id: ctx.pessoa.id,
        conversa_id: ctx.conversa.id,
        entidade_ids: ctx.scope.entidades,
        activeExecution: null,
      }),
    );
    const { system } = renderTurnPrompt(ctx, snapshot);

    const scopeBlock = scopeBlockOf(system);

    // 1. No id leaked. This is the headline symptom of the defect: before the
    //    fix the tail of the scope block read `<uuid>: profile=…` for every
    //    grant past row 500, because the renderer's `ent?.nome ?? eid` had
    //    nothing to look up. Asserted FIRST so the failure message shows the
    //    leak itself rather than a count.
    const leaked = UUID_RE.exec(scopeBlock);
    expect(leaked?.[0] ?? null).toBeNull();

    // 2. Every name is there. Asserted per-name rather than by counting lines,
    //    so a failure says WHICH entity lost its name.
    const missing = entityIds.filter((id) => !scopeBlock.includes(namesById.get(id)!));
    expect(missing).toEqual([]);

    // 3. One line per grant — the block is not truncated at either end.
    const grantLines = scopeBlock
      .split('\n')
      .filter((l) => l.trim().startsWith('- i541-f2-Entidade-'));
    expect(grantLines).toHaveLength(ENTITY_COUNT);
  }, 60_000);

  it('the surviving names do not depend on uuid ordering', async () => {
    // The old cap selected rows by `ORDER BY entidades.id LIMIT 500`, so which
    // names disappeared was decided by UUID ordering — unrelated to the scope's
    // order and different on every reseed. Rendering the SAME scope in reverse
    // order must now produce the same set of names, only reordered.
    const forward = renderTurnPrompt(
      mkCtx(entityIds),
      await runWithTenantContext(T, () =>
        loadTurnContext({
          pessoa_id: 'i541-f2-pessoa',
          conversa_id: '00000000-0000-4000-8000-0000000000f2',
          entidade_ids: entityIds,
          activeExecution: null,
        }),
      ),
    ).system;

    const reversedIds = [...entityIds].reverse();
    const reversed = renderTurnPrompt(
      mkCtx(reversedIds),
      await runWithTenantContext(T, () =>
        loadTurnContext({
          pessoa_id: 'i541-f2-pessoa',
          conversa_id: '00000000-0000-4000-8000-0000000000f2',
          entidade_ids: reversedIds,
          activeExecution: null,
        }),
      ),
    ).system;

    const names = (s: string): string[] =>
      [...scopeBlockOf(s).matchAll(/i541-f2-Entidade-\d{4}/g)].map((m) => m[0]).sort();

    expect(names(forward)).toEqual(names(reversed));
    expect(names(forward)).toHaveLength(ENTITY_COUNT);
  }, 60_000);
});
