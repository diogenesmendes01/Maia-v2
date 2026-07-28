/**
 * Issue #511 — batch repository reads for the turn-context hot path.
 *
 * The batch methods introduced here replace per-row loops that ran inside the
 * turn, so two things need proving against a real Postgres:
 *
 *  1. ISOLATION. A batched `WHERE id IN (…)` is exactly the shape where a
 *     forgotten tenant predicate leaks quietly — the caller passes ids it
 *     already "knows", so a foreign row comes back looking legitimate. Each
 *     method is asked for another tenant's ids and must return nothing.
 *     `behavioral_hint.subject_id` is free-form text, so that suite uses the
 *     SAME subject id under both tenants — the overlapping-id case the issue
 *     asks for, which id-uniqueness makes impossible for the other two tables.
 *
 *  2. CONSTANT COST. The query count for 1, 10 and 100 entity states must be
 *     identical. This is measured with the production counter
 *     (`src/db/query-counter.ts`), not a mock, so it counts real round-trips.
 *
 * Skipped without TEST_DB_URL so unit-only lanes pass without Postgres.
 * Repo methods use the global `db` pool and therefore cannot see uncommitted
 * rows, so fixtures are committed and removed by id in `finally`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { runWithQueryCounter } from '@/db/query-counter.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const A = { tenant_id: 'i511-tA', agent_id: 'i511-agA' };
const B = { tenant_id: 'i511-tB', agent_id: 'i511-agB' };

let pool: pg.Pool;

async function loadRepos(): Promise<typeof import('../../src/db/repositories.js')> {
  return await import('../../src/db/repositories.js');
}

async function ensureTenantAgent(c: pg.PoolClient, tenant: string, agent: string): Promise<void> {
  await c.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
    tenant,
  ]);
  await c.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [agent, tenant],
  );
}

/** Entity + its `entity_states` row (the FK makes the entity mandatory). */
async function mkEntityWithState(
  c: pg.PoolClient,
  scope: { tenant_id: string; agent_id: string },
  saldo: string,
): Promise<string> {
  const ent = await c.query<{ id: string }>(
    `INSERT INTO entidades(tenant_id, agent_id, nome, tipo)
     VALUES ($1, $2, $3, 'pj') RETURNING id`,
    [scope.tenant_id, scope.agent_id, `i511-${Math.random().toString(36).slice(2, 10)}`],
  );
  const id = ent.rows[0]!.id;
  await c.query(
    `INSERT INTO entity_states(entidade_id, tenant_id, agent_id, saldo_consolidado)
     VALUES ($1, $2, $3, $4)`,
    [id, scope.tenant_id, scope.agent_id, saldo],
  );
  return id;
}

async function mkProfile(
  c: pg.PoolClient,
  scope: { tenant_id: string; agent_id: string },
  id: string,
): Promise<string> {
  await c.query(
    `INSERT INTO permission_profiles(id, tenant_id, agent_id, nome, acoes, limite_default)
     VALUES ($1, $2, $3, $1, ARRAY['registrar_transacao'], 100)`,
    [id, scope.tenant_id, scope.agent_id],
  );
  return id;
}

async function mkHint(
  c: pg.PoolClient,
  scope: { tenant_id: string; agent_id: string },
  args: {
    scope_type: string;
    subject_id: string | null;
    hint_text: string;
    lifecycle_status?: string;
    revoked?: boolean;
    expires_at?: string | null;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO behavioral_hint
       (tenant_id, agent_id, scope_type, subject_id, hint_text, derived_sensitivity,
        lifecycle_status, revoked_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'low', $6, $7, $8) RETURNING id`,
    [
      scope.tenant_id,
      scope.agent_id,
      args.scope_type,
      args.subject_id,
      args.hint_text,
      args.lifecycle_status ?? 'active',
      args.revoked ? new Date().toISOString() : null,
      args.expires_at ?? null,
    ],
  );
  return r.rows[0]!.id;
}

async function cleanup(
  c: pg.PoolClient,
  t: { hints: string[]; profiles: string[]; entidades: string[] },
): Promise<void> {
  if (t.hints.length)
    await c.query(`DELETE FROM behavioral_hint WHERE id = ANY($1::uuid[])`, [t.hints]);
  if (t.profiles.length)
    await c.query(`DELETE FROM permission_profiles WHERE id = ANY($1)`, [t.profiles]);
  // entity_states cascades from entidades.
  if (t.entidades.length)
    await c.query(`DELETE FROM entidades WHERE id = ANY($1::uuid[])`, [t.entidades]);
}

function newTracker(): { hints: string[]; profiles: string[]; entidades: string[] } {
  return { hints: [], profiles: [], entidades: [] };
}

d('#511 batch repos — isolation and constant cost', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await ensureTenantAgent(c, A.tenant_id, A.agent_id);
      await ensureTenantAgent(c, B.tenant_id, B.agent_id);
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  describe('entityStatesRepo.byIds', () => {
    it('never returns another tenant/agent row, even when handed its ids', async () => {
      const c = await pool.connect();
      const tk = newTracker();
      try {
        const mine = await mkEntityWithState(c, A, '111.00');
        tk.entidades.push(mine);
        const theirs = await mkEntityWithState(c, B, '999.00');
        tk.entidades.push(theirs);

        const { entityStatesRepo } = await loadRepos();
        const rows = await runWithTenantContext(A, () =>
          entityStatesRepo.byIds([mine, theirs]),
        );

        expect(rows.map((r) => r.entidade_id)).toEqual([mine]);
        expect(rows[0]!.saldo_consolidado).toBe('111.00');
      } finally {
        await cleanup(c, tk);
        c.release();
      }
    });

    it('returns the same rows the per-id method would, and skips missing ids', async () => {
      const c = await pool.connect();
      const tk = newTracker();
      try {
        const withState = await mkEntityWithState(c, A, '10.00');
        tk.entidades.push(withState);
        // An entity with NO state row — `byId` returns null for it, so `byIds`
        // must simply omit it rather than emit a placeholder.
        const noState = await c.query<{ id: string }>(
          `INSERT INTO entidades(tenant_id, agent_id, nome, tipo)
           VALUES ($1, $2, 'i511-nostate', 'pj') RETURNING id`,
          [A.tenant_id, A.agent_id],
        );
        tk.entidades.push(noState.rows[0]!.id);

        const { entityStatesRepo } = await loadRepos();
        const [batch, single] = await runWithTenantContext(A, async () => [
          await entityStatesRepo.byIds([withState, noState.rows[0]!.id]),
          await entityStatesRepo.byId(withState),
        ]);

        expect(batch).toHaveLength(1);
        expect(batch[0]!.entidade_id).toBe(single!.entidade_id);
        expect(batch[0]!.saldo_consolidado).toBe(single!.saldo_consolidado);
      } finally {
        await cleanup(c, tk);
        c.release();
      }
    });

    it('costs ONE query for 1, 10 and 100 entities', async () => {
      const c = await pool.connect();
      const tk = newTracker();
      try {
        for (let i = 0; i < 100; i++) {
          tk.entidades.push(await mkEntityWithState(c, A, `${i}.00`));
        }
        const { entityStatesRepo } = await loadRepos();

        const counts: number[] = [];
        for (const n of [1, 10, 100]) {
          const ids = tk.entidades.slice(0, n);
          await runWithTenantContext(A, () =>
            runWithQueryCounter(async (counter) => {
              const rows = await entityStatesRepo.byIds(ids);
              expect(rows).toHaveLength(n);
              counts.push(counter.count);
            }),
          );
        }
        // The property that matters: cost does not grow with scope size.
        expect(counts).toEqual([1, 1, 1]);
      } finally {
        await cleanup(c, tk);
        c.release();
      }
    }, 60_000);
  });

  describe('profilesRepo.byIds', () => {
    it('never returns another tenant/agent profile', async () => {
      const c = await pool.connect();
      const tk = newTracker();
      try {
        tk.profiles.push(await mkProfile(c, A, 'i511-profile-a'));
        tk.profiles.push(await mkProfile(c, B, 'i511-profile-b'));

        const { profilesRepo } = await loadRepos();
        const rows = await runWithTenantContext(A, () =>
          profilesRepo.byIds(['i511-profile-a', 'i511-profile-b']),
        );

        expect(rows.map((r) => r.id)).toEqual(['i511-profile-a']);
      } finally {
        await cleanup(c, tk);
        c.release();
      }
    });

    it('resolveScope no longer resolves a foreign profile into a grant', async () => {
      const c = await pool.connect();
      const tk = newTracker();
      try {
        // Tenant B owns the profile; tenant A holds a permission pointing at it.
        // Pre-#511 the per-id lookup was unscoped, so A inherited B's action
        // list and spend limit. The batched read must drop the permission.
        tk.profiles.push(await mkProfile(c, B, 'i511-foreign-profile'));
        const ent = await mkEntityWithState(c, A, '1.00');
        tk.entidades.push(ent);
        const pes = await c.query<{ id: string }>(
          `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
           VALUES ($1, $2, 'i511-p', $3, 'operador', 'ativa') RETURNING id`,
          [A.tenant_id, A.agent_id, `+5511${Math.floor(Math.random() * 1e9)}`],
        );
        const pessoa_id = pes.rows[0]!.id;
        await c.query(
          `INSERT INTO permissoes(tenant_id, agent_id, pessoa_id, entidade_id, papel, profile_id, status)
           VALUES ($1, $2, $3, $4, 'operador', 'i511-foreign-profile', 'ativa')`,
          [A.tenant_id, A.agent_id, pessoa_id, ent],
        );

        try {
          const { resolveScope } = await import('../../src/governance/permissions.js');
          const scope = await runWithTenantContext(A, () =>
            resolveScope({ id: pessoa_id, status: 'ativa' } as never),
          );
          expect(scope.entidades).toEqual([]);
          expect(scope.byEntity.size).toBe(0);
        } finally {
          await c.query(`DELETE FROM permissoes WHERE pessoa_id = $1`, [pessoa_id]);
          await c.query(`DELETE FROM pessoas WHERE id = $1`, [pessoa_id]);
        }
      } finally {
        await cleanup(c, tk);
        c.release();
      }
    });
  });

  describe('behavioralHintRepo.findActiveForScopes', () => {
    it('isolates tenants that share the SAME subject_id', async () => {
      const c = await pool.connect();
      const tk = newTracker();
      const subject = `i511-subject-${Math.random().toString(36).slice(2, 10)}`;
      try {
        tk.hints.push(
          await mkHint(c, A, {
            scope_type: 'interlocutor',
            subject_id: subject,
            hint_text: 'hint-of-A',
          }),
        );
        tk.hints.push(
          await mkHint(c, B, {
            scope_type: 'interlocutor',
            subject_id: subject,
            hint_text: 'hint-of-B',
          }),
        );

        const { behavioralHintRepo } = await loadRepos();
        const rows = await runWithTenantContext(A, () =>
          behavioralHintRepo.findActiveForScopes([
            { scope_type: 'interlocutor', subject_id: subject },
          ]),
        );

        expect(rows.map((r) => r.hint_text)).toEqual(['hint-of-A']);
      } finally {
        await cleanup(c, tk);
        c.release();
      }
    });

    it('matches the per-scope loop in ONE query, without duplicates', async () => {
      const c = await pool.connect();
      const tk = newTracker();
      const subject = `i511-subj-${Math.random().toString(36).slice(2, 10)}`;
      const conversa = `i511-conv-${Math.random().toString(36).slice(2, 10)}`;
      try {
        tk.hints.push(
          await mkHint(c, A, {
            scope_type: 'interlocutor',
            subject_id: subject,
            hint_text: 'h-interlocutor',
          }),
        );
        tk.hints.push(
          await mkHint(c, A, {
            scope_type: 'conversation',
            subject_id: conversa,
            hint_text: 'h-conversation',
          }),
        );
        tk.hints.push(
          await mkHint(c, A, { scope_type: 'agent', subject_id: null, hint_text: 'h-agent' }),
        );

        const { behavioralHintRepo } = await loadRepos();
        const scopes = [
          { scope_type: 'interlocutor', subject_id: subject },
          { scope_type: 'conversation', subject_id: conversa },
          { scope_type: 'agent', subject_id: null },
          // Duplicated on purpose: the loop would have queried twice and
          // appended the hint twice into the prompt.
          { scope_type: 'agent', subject_id: null },
        ];

        const { loopTexts, batchTexts, batchQueries } = await runWithTenantContext(A, async () => {
          const loop: string[] = [];
          for (const s of scopes) {
            const got = await behavioralHintRepo.findActiveForScope(s);
            loop.push(...got.map((r) => r.hint_text));
          }
          let queries = 0;
          const batch = await runWithQueryCounter(async (counter) => {
            const rows = await behavioralHintRepo.findActiveForScopes(scopes);
            queries = counter.count;
            return rows.map((r) => r.hint_text);
          });
          return { loopTexts: loop, batchTexts: batch, batchQueries: queries };
        });

        expect(batchQueries).toBe(1);
        expect(new Set(batchTexts)).toEqual(new Set(loopTexts));
        // The loop double-counted the duplicated agent scope; the batch does not.
        expect(batchTexts.filter((t) => t === 'h-agent')).toHaveLength(1);
        expect(loopTexts.filter((t) => t === 'h-agent')).toHaveLength(2);
      } finally {
        await cleanup(c, tk);
        c.release();
      }
    });

    it('preserves the revoked / lifecycle / expiry filters', async () => {
      const c = await pool.connect();
      const tk = newTracker();
      const subject = `i511-filt-${Math.random().toString(36).slice(2, 10)}`;
      const past = new Date(Date.now() - 60_000).toISOString();
      try {
        tk.hints.push(
          await mkHint(c, A, {
            scope_type: 'interlocutor',
            subject_id: subject,
            hint_text: 'visible',
          }),
        );
        tk.hints.push(
          await mkHint(c, A, {
            scope_type: 'interlocutor',
            subject_id: subject,
            hint_text: 'revoked',
            revoked: true,
          }),
        );
        tk.hints.push(
          await mkHint(c, A, {
            scope_type: 'interlocutor',
            subject_id: subject,
            hint_text: 'pending',
            lifecycle_status: 'pending_review',
          }),
        );
        tk.hints.push(
          await mkHint(c, A, {
            scope_type: 'interlocutor',
            subject_id: subject,
            hint_text: 'expired',
            expires_at: past,
          }),
        );

        const { behavioralHintRepo } = await loadRepos();
        const rows = await runWithTenantContext(A, () =>
          behavioralHintRepo.findActiveForScopes([
            { scope_type: 'interlocutor', subject_id: subject },
          ]),
        );

        // A pending_review hint reaching the prompt would let an unapproved
        // hint steer behaviour — the exact regression the batch must not open.
        expect(rows.map((r) => r.hint_text)).toEqual(['visible']);
      } finally {
        await cleanup(c, tk);
        c.release();
      }
    });

    it('returns [] for an empty scope list WITHOUT querying (never matches all hints)', async () => {
      const c = await pool.connect();
      const tk = newTracker();
      try {
        tk.hints.push(
          await mkHint(c, A, { scope_type: 'agent', subject_id: null, hint_text: 'should-not-leak' }),
        );

        const { behavioralHintRepo } = await loadRepos();
        const { rows, queries } = await runWithTenantContext(A, () =>
          runWithQueryCounter(async (counter) => {
            const got = await behavioralHintRepo.findActiveForScopes([]);
            return { rows: got, queries: counter.count };
          }),
        );

        expect(rows).toEqual([]);
        expect(queries).toBe(0);
      } finally {
        await cleanup(c, tk);
        c.release();
      }
    });
  });
});
