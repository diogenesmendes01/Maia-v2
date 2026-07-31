/**
 * Issue #525 — the batched turn-context statements, against a real Postgres.
 *
 * The loader collapses 13 round-trips into 4 statements built by composing the
 * per-section repository query builders into scalar `json_agg` subqueries. Two
 * things about that are only checkable with a database, and both are the kind
 * of thing that fails silently:
 *
 *  1. PARITY. The batch must return exactly what the per-section methods
 *     return, for the same tenant and the same fixtures — including the
 *     lifecycle, sensitivity, revoked and expiry filters, which live inside the
 *     embedded builders and would be trivially lost by a rewrite. Row-for-row
 *     agreement is the assertion.
 *
 *  2. REPRESENTATION. Going through JSON changes types. `numeric` comes back as
 *     a JS number unless cast (`'1234.50'` → 1234.5), which would silently
 *     rewrite the rendered prompt. The projections cast every prompt-visible
 *     numeric to `text`; here that is checked against what node-postgres hands
 *     back for the same column, which is the only definition of "unchanged"
 *     that matters.
 *
 * Plus the property the issue is actually about: ROUND-TRIPS, measured with the
 * production counter (`src/db/query-counter.ts`) rather than a mock, so the
 * number in `tests/unit/turn-context-baseline.spec.ts` is anchored to reality.
 *
 * ISOLATION is asserted too — a batched read is exactly where a lost tenant
 * predicate hides, because the caller passes ids it already "knows" and a
 * foreign row comes back looking legitimate.
 *
 * Skipped without TEST_DB_URL so unit-only lanes pass without Postgres. Repo
 * methods use the global `db` pool and cannot see uncommitted rows, so fixtures
 * are committed and removed by id in `finally`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { runWithQueryCounter } from '@/db/query-counter.js';
import { GapLevel } from '@/types/enums.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const A = { tenant_id: 'i525-tA', agent_id: 'i525-agA' };
const B = { tenant_id: 'i525-tB', agent_id: 'i525-agB' };

let pool: pg.Pool;

async function repos(): Promise<typeof import('../../src/db/repositories.js')> {
  return import('../../src/db/repositories.js');
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

type Tracker = {
  entidades: string[];
  conversas: string[];
  pessoas: string[];
  rules: string[];
  skills: string[];
  gaps: string[];
  memories: string[];
  hints: string[];
  facts: string[];
};

function newTracker(): Tracker {
  return {
    entidades: [],
    conversas: [],
    pessoas: [],
    rules: [],
    skills: [],
    gaps: [],
    memories: [],
    hints: [],
    facts: [],
  };
}

async function cleanup(c: pg.PoolClient, t: Tracker): Promise<void> {
  const del = async (table: string, ids: string[], cast = '::uuid[]'): Promise<void> => {
    if (ids.length) await c.query(`DELETE FROM ${table} WHERE id = ANY($1${cast})`, [ids]);
  };
  await del('behavioral_hint', t.hints);
  await del('memory_entry', t.memories);
  await del('agent_capability_gaps', t.gaps);
  await del('agent_capabilities_skill', t.skills);
  await del('learned_rules', t.rules);
  await del('agent_facts', t.facts);
  if (t.conversas.length)
    await c.query(`DELETE FROM mensagens WHERE conversa_id = ANY($1::uuid[])`, [t.conversas]);
  await del('conversas', t.conversas);
  await del('pessoas', t.pessoas);
  // entity_states cascades from entidades.
  await del('entidades', t.entidades);
}

/** Seeds one entity + state, a conversa with history, knowledge, memory, skills and gaps. */
async function seedWorld(
  c: pg.PoolClient,
  s: { tenant_id: string; agent_id: string },
  t: Tracker,
  tag: string,
): Promise<{ entidade_id: string; conversa_id: string; pessoa_id: string }> {
  const ent = await c.query<{ id: string }>(
    `INSERT INTO entidades(tenant_id, agent_id, nome, tipo) VALUES ($1,$2,$3,'pj') RETURNING id`,
    [s.tenant_id, s.agent_id, `${tag}-ent`],
  );
  const entidade_id = ent.rows[0]!.id;
  t.entidades.push(entidade_id);
  await c.query(
    `INSERT INTO entity_states(entidade_id, tenant_id, agent_id, saldo_consolidado, proximo_vencimento)
     VALUES ($1,$2,$3,'1234.50','2026-05-20')`,
    [entidade_id, s.tenant_id, s.agent_id],
  );

  const pes = await c.query<{ id: string }>(
    `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
     VALUES ($1,$2,$3,$4,'dono','ativa') RETURNING id`,
    [s.tenant_id, s.agent_id, `${tag}-owner`, `+55119${Math.floor(Math.random() * 1e8)}`],
  );
  const pessoa_id = pes.rows[0]!.id;
  t.pessoas.push(pessoa_id);

  const conv = await c.query<{ id: string }>(
    `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, status) VALUES ($1,$2,$3,'ativa') RETURNING id`,
    [s.tenant_id, s.agent_id, pessoa_id],
  );
  const conversa_id = conv.rows[0]!.id;
  t.conversas.push(conversa_id);

  for (const [i, texto] of [`${tag}-msg-1`, `${tag}-msg-2`].entries()) {
    await c.query(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, created_at)
       VALUES ($1,$2,$3,'in','texto',$4, now() - ($5 || ' minutes')::interval)`,
      [s.tenant_id, s.agent_id, conversa_id, texto, String(i)],
    );
  }

  const fact = await c.query<{ id: string }>(
    `INSERT INTO agent_facts(tenant_id, agent_id, escopo, chave, valor, lifecycle_status)
     VALUES ($1,$2,'global',$3,$4::jsonb,'active') RETURNING id`,
    [s.tenant_id, s.agent_id, `${tag}-chave`, JSON.stringify({ content: `${tag}-valor` })],
  );
  t.facts.push(fact.rows[0]!.id);

  const rule = await c.query<{ id: string }>(
    `INSERT INTO learned_rules(tenant_id, agent_id, tipo, contexto, acao, confianca, lifecycle_status)
     VALUES ($1,$2,'classificacao',$3,'classificar','0.90','active') RETURNING id`,
    [s.tenant_id, s.agent_id, `${tag}-contexto`],
  );
  t.rules.push(rule.rows[0]!.id);

  const mem = await c.query<{ id: string }>(
    `INSERT INTO memory_entry(tenant_id, agent_id, content, memory_type, scope_type, subject_id,
                              sensitivity, proactive_use, mention_allowed, needs_review, lifecycle_status)
     VALUES ($1,$2,$3,'preference','interlocutor',$4,'low',true,true,false,'active') RETURNING id`,
    [s.tenant_id, s.agent_id, `${tag}-memoria`, pessoa_id],
  );
  t.memories.push(mem.rows[0]!.id);

  const hint = await c.query<{ id: string }>(
    `INSERT INTO behavioral_hint(tenant_id, agent_id, scope_type, subject_id, hint_text,
                                 derived_sensitivity, lifecycle_status)
     VALUES ($1,$2,'interlocutor',$3,$4,'low','active') RETURNING id`,
    [s.tenant_id, s.agent_id, pessoa_id, `${tag}-hint`],
  );
  t.hints.push(hint.rows[0]!.id);

  const skill = await c.query<{ id: string }>(
    `INSERT INTO agent_capabilities_skill(tenant_id, agent_id, domain, skill_name, confidence)
     VALUES ($1,$2,'financeiro',$3,'0.910') RETURNING id`,
    [s.tenant_id, s.agent_id, `${tag}-skill`],
  );
  t.skills.push(skill.rows[0]!.id);

  const gap = await c.query<{ id: string }>(
    `INSERT INTO agent_capability_gaps(tenant_id, agent_id, capability_description, tipo, current_level)
     VALUES ($1,$2,$3,'tool','mentionable') RETURNING id`,
    [s.tenant_id, s.agent_id, `${tag}-gap`],
  );
  t.gaps.push(gap.rows[0]!.id);

  return { entidade_id, conversa_id, pessoa_id };
}

d('#525 batched turn-context loader — parity, isolation and cost', () => {
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

  it('returns exactly what the per-section repository methods return', async () => {
    const c = await pool.connect();
    const t = newTracker();
    try {
      const w = await seedWorld(c, A, t, 'parity');
      const r = await repos();

      await runWithTenantContext(A, async () => {
        const core = await r.turnContextRepo.loadCore({
          conversa_id: w.conversa_id,
          history_limit: 10,
          entidade_ids: [w.entidade_id],
          fact_scopes: ['global'],
          rules_tipo: 'classificacao',
        });

        // --- history -----------------------------------------------------
        const history = await r.mensagensRepo.recentInConversation(w.conversa_id, 10);
        expect(core.history.map((m) => m.conteudo)).toEqual(history.map((m) => m.conteudo));
        expect(core.history.map((m) => m.id)).toEqual(history.map((m) => m.id));
        // `created_at` must be a real Date, not the ISO string JSON produces —
        // the renderer calls `.getTime()` on it.
        expect(core.history[0]!.created_at).toBeInstanceOf(Date);
        expect(core.history[0]!.created_at!.getTime()).toBe(history[0]!.created_at!.getTime());

        // --- entities + states -------------------------------------------
        const ents = await r.entidadesRepo.byIds([w.entidade_id]);
        const states = await r.entityStatesRepo.byIds([w.entidade_id]);
        expect(core.entities.map((e) => e.nome)).toEqual(ents.map((e) => e.nome));
        // THE representation check: a numeric that lost its cast would arrive
        // as 1234.5 and the prompt would render "saldo=1234.5".
        expect(core.entity_states[0]!.saldo_consolidado).toBe(states[0]!.saldo_consolidado);
        expect(typeof core.entity_states[0]!.saldo_consolidado).toBe('string');
        expect(core.entity_states[0]!.proximo_vencimento).toEqual(states[0]!.proximo_vencimento);

        // --- facts (with the sensitivity NOT EXISTS) ----------------------
        const facts = await r.factsRepo.listMentionableForScopes(['global']);
        expect(core.facts.map((f) => f.chave).sort()).toEqual(facts.map((f) => f.chave).sort());
        expect(core.facts[0]!.valor).toEqual(facts[0]!.valor);

        // --- rules --------------------------------------------------------
        const rules = await r.rulesRepo.listActive('classificacao');
        expect(core.rules.map((x) => x.id)).toEqual(rules.map((x) => x.id));
        expect(core.rules[0]!.confianca).toBe(rules[0]!.confianca);

        // --- enrichment ---------------------------------------------------
        const enrichment = await r.turnContextRepo.loadEnrichment({
          interlocutor_id: w.pessoa_id,
          conversa_id: w.conversa_id,
          memory_limit: 30,
          hint_scopes: [
            { scope_type: 'interlocutor', subject_id: w.pessoa_id },
            { scope_type: 'agent', subject_id: null },
          ],
          procedure: { mode: 'lookup', conversa_id: w.conversa_id },
        });
        const memories = await r.memoryEntryRepo.findRelevant({
          interlocutor_id: w.pessoa_id,
          conversa_id: w.conversa_id,
          limit: 30,
        });
        const hints = await r.behavioralHintRepo.findActiveForScopes([
          { scope_type: 'interlocutor', subject_id: w.pessoa_id },
          { scope_type: 'agent', subject_id: null },
        ]);
        expect(enrichment.memories.map((m) => m.content)).toEqual(memories.map((m) => m.content));
        expect(enrichment.hints.map((x) => x.hint_text)).toEqual(hints.map((x) => x.hint_text));
        expect(enrichment.procedure).toBeNull();

        // --- self awareness ------------------------------------------------
        const sa = await r.turnContextRepo.loadSelfAwareness([
          GapLevel.MENTIONABLE,
          GapLevel.PROPOSED,
        ]);
        const skills = await r.capabilitiesSkillRepo.listAll();
        const gaps = await r.capabilityGapsRepo.listByLevels([
          GapLevel.MENTIONABLE,
          GapLevel.PROPOSED,
        ]);
        expect(sa.skills.map((s) => s.skill_name).sort()).toEqual(
          skills.map((s) => s.skill_name).sort(),
        );
        expect(sa.skills[0]!.confidence).toBe(skills[0]!.confidence);
        expect(sa.gaps.map((g) => g.capability_description).sort()).toEqual(
          gaps.map((g) => g.capability_description).sort(),
        );
      });
    } finally {
      await cleanup(c, t);
      c.release();
    }
  });

  it('never returns another tenant rows, even when handed their ids', async () => {
    const c = await pool.connect();
    const t = newTracker();
    try {
      const a = await seedWorld(c, A, t, 'iso-a');
      const b = await seedWorld(c, B, t, 'iso-b');
      const r = await repos();

      await runWithTenantContext(A, async () => {
        const core = await r.turnContextRepo.loadCore({
          // B's conversa and B's entity, asked for while A is running.
          conversa_id: b.conversa_id,
          history_limit: 10,
          entidade_ids: [b.entidade_id],
          fact_scopes: ['global'],
          rules_tipo: 'classificacao',
        });
        expect(core.history).toEqual([]);
        expect(core.entity_states).toEqual([]);
        expect(core.facts.every((f) => !f.chave.startsWith('iso-b'))).toBe(true);
        expect(core.rules.every((x) => !x.contexto.startsWith('iso-b'))).toBe(true);

        const enrichment = await r.turnContextRepo.loadEnrichment({
          interlocutor_id: b.pessoa_id,
          conversa_id: b.conversa_id,
          memory_limit: 30,
          hint_scopes: [
            { scope_type: 'interlocutor', subject_id: b.pessoa_id },
            { scope_type: 'agent', subject_id: null },
          ],
          procedure: { mode: 'lookup', conversa_id: b.conversa_id },
        });
        expect(enrichment.memories).toEqual([]);
        expect(enrichment.hints).toEqual([]);

        const sa = await r.turnContextRepo.loadSelfAwareness([GapLevel.MENTIONABLE]);
        expect(sa.skills.every((s) => !s.skill_name.startsWith('iso-b'))).toBe(true);
        expect(sa.gaps.every((g) => !g.capability_description.startsWith('iso-b'))).toBe(true);
        // …and A's own rows ARE there, so the isolation is not "returns nothing".
        expect(sa.skills.some((s) => s.skill_name === 'iso-a-skill')).toBe(true);
        void a;
      });
    } finally {
      await cleanup(c, t);
      c.release();
    }
  });

  it('costs ONE real round-trip per batched load', async () => {
    const c = await pool.connect();
    const t = newTracker();
    try {
      const w = await seedWorld(c, A, t, 'cost');
      const r = await repos();

      await runWithTenantContext(A, async () => {
        const measure = async (fn: () => Promise<unknown>): Promise<number> => {
          let n = 0;
          await runWithQueryCounter(async (counter) => {
            await fn();
            n = counter.count;
          });
          return n;
        };

        expect(await measure(() => r.turnContextRepo.loadIdentity())).toBe(1);
        expect(
          await measure(() =>
            r.turnContextRepo.loadCore({
              conversa_id: w.conversa_id,
              history_limit: 10,
              entidade_ids: [w.entidade_id],
              fact_scopes: ['global', `pessoa:${w.pessoa_id}`],
              rules_tipo: 'classificacao',
            }),
          ),
        ).toBe(1);
        expect(
          await measure(() =>
            r.turnContextRepo.loadEnrichment({
              interlocutor_id: w.pessoa_id,
              conversa_id: w.conversa_id,
              memory_limit: 30,
              hint_scopes: [
                { scope_type: 'interlocutor', subject_id: w.pessoa_id },
                { scope_type: 'agent', subject_id: null },
              ],
              procedure: { mode: 'lookup', conversa_id: w.conversa_id },
            }),
          ),
        ).toBe(1);
        expect(
          await measure(() => r.turnContextRepo.loadSelfAwareness([GapLevel.MENTIONABLE])),
        ).toBe(1);
      });
    } finally {
      await cleanup(c, t);
      c.release();
    }
  });

  /**
   * THE acceptance number, measured end to end against Postgres: the typical
   * turn with no procedure costs ≤8 real round-trips (4 prompt statements + 2
   * for `resolveScope`; the exact figure is pinned in the unit budget spec).
   */
  it('builds a whole prompt in at most 8 real round-trips', async () => {
    const c = await pool.connect();
    const t = newTracker();
    try {
      const w = await seedWorld(c, A, t, 'budget');
      const { buildPrompt } = await import('../../src/agent/prompt-builder.js');

      let count = 0;
      await runWithTenantContext(A, async () => {
        await runWithQueryCounter(async (counter) => {
          await buildPrompt({
            pessoa: { id: w.pessoa_id, nome: 'Owner', apelido: null, tipo: 'dono' } as never,
            conversa: { id: w.conversa_id, metadata: {} } as never,
            scope: { entidades: [w.entidade_id], byEntity: new Map() },
            inbound: {
              id: 'inbound-nao-persistida',
              conteudo: 'oi',
              direcao: 'in',
              tipo: 'texto',
              created_at: new Date(),
            } as never,
          });
          count = counter.count;
        });
      });

      expect(count).toBe(4);
      expect(count).toBeLessThanOrEqual(8);
    } finally {
      await cleanup(c, t);
      c.release();
    }
  });
});
