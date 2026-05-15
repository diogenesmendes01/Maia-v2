/**
 * Integration tests for issue #73 — Maia anchoring on stale history.
 *
 *   Repro 1: scope changes mid-conversation (permission added in DB after
 *            agent already refused). Next turn's prompt must contain the
 *            scope-change sentinel so the LLM is told to discard its
 *            previous refusal.
 *
 *   Repro 2: previous turn ran tools successfully (ferramentas_chamadas
 *            persisted). User asks "agendou?". The next prompt must
 *            contain "## Eventos confirmados pelo backend" reidrated
 *            from the prior assistant message, ABOVE the regular
 *            conversation history in the system prompt.
 *
 * We don't call the real Claude API here; the test asserts on the prompt
 * that buildPrompt produces given a real DB-loaded conversa + history. The
 * LLM's actual decision is non-deterministic; the prompt is.
 *
 * Skipped without TEST_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import pg from 'pg';
import { randomInt, randomUUID } from 'node:crypto';

// Stub redis/queue/baileys at module load — same as debounce-flow spec.
vi.mock('../../src/lib/redis.js', () => ({
  redis: {},
  isRedisConnected: () => false,
  ensureRedisConnect: vi.fn(),
}));
vi.mock('../../src/gateway/queue.js', () => ({
  agentQueue: { add: vi.fn(), getJob: vi.fn() },
  startAgentWorker: vi.fn(),
  enqueueAgent: vi.fn(),
  shutdownQueue: vi.fn(),
}));
vi.mock('../../src/gateway/baileys.js', () => ({
  isBaileysConnected: () => false,
  getSocket: () => null,
  startBaileys: vi.fn(),
  shutdownBaileys: vi.fn(),
  triggerPairingCode: vi.fn(),
  isReactionStub: () => false,
  REACTION_STUB_TYPE: 67,
  MEDIA_ROOT: '/tmp/media',
  getLastDisconnectAt: () => null,
}));

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;
let pessoa_id: string;
let conversa_id: string;
let entidade_id: string;
let telefone: string;
const cleanupTracking = {
  permissoes: [] as string[],
  profiles: [] as string[],
};

async function createOwnerProfile(c: pg.PoolClient): Promise<string> {
  const profile_id = 'test-owner-' + randomInt(0, 1e9).toString(36);
  await c.query(
    `INSERT INTO permission_profiles(id, nome, acoes, limite_default)
     VALUES ($1, 'test owner', ARRAY['*']::text[], 1000)`,
    [profile_id],
  );
  cleanupTracking.profiles.push(profile_id);
  return profile_id;
}

async function grantPermission(
  c: pg.PoolClient,
  args: { pessoa_id: string; entidade_id: string; profile_id: string },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO permissoes(pessoa_id, entidade_id, papel, profile_id, status)
     VALUES ($1, $2, 'dono', $3, 'ativa')
     RETURNING id`,
    [args.pessoa_id, args.entidade_id, args.profile_id],
  );
  cleanupTracking.permissoes.push(r.rows[0]!.id);
  return r.rows[0]!.id;
}

async function insertInbound(
  c: pg.PoolClient,
  args: { conversa_id: string; conteudo: string; created_at?: Date },
): Promise<string> {
  const wid = `WAID-${randomInt(0, 1e9).toString(36)}`;
  const created = args.created_at?.toISOString() ?? null;
  const r = await c.query<{ id: string }>(
    `INSERT INTO mensagens(
       conversa_id, direcao, tipo, conteudo, metadata${created ? ', created_at' : ''}
     )
     VALUES ($1, 'in', 'texto', $2, jsonb_build_object('telefone', $3::text, 'whatsapp_id', $4::text)${
       created ? ', $5::timestamptz' : ''
     })
     RETURNING id`,
    created
      ? [args.conversa_id, args.conteudo, telefone, wid, created]
      : [args.conversa_id, args.conteudo, telefone, wid],
  );
  return r.rows[0]!.id;
}

async function insertAssistantMsg(
  c: pg.PoolClient,
  args: {
    conversa_id: string;
    conteudo: string;
    ferramentas_chamadas?: unknown[];
    created_at?: Date;
  },
): Promise<string> {
  const created = args.created_at?.toISOString() ?? new Date().toISOString();
  const r = await c.query<{ id: string }>(
    `INSERT INTO mensagens(
       conversa_id, direcao, tipo, conteudo, processada_em, ferramentas_chamadas, created_at
     )
     VALUES ($1, 'out', 'texto', $2, NOW(), $3::jsonb, $4::timestamptz)
     RETURNING id`,
    [
      args.conversa_id,
      args.conteudo,
      JSON.stringify(args.ferramentas_chamadas ?? []),
      created,
    ],
  );
  return r.rows[0]!.id;
}

d('issue #73 — anchoring fix: scope-change sentinel + persisted events block', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    cleanupTracking.permissoes = [];
    cleanupTracking.profiles = [];
    const c = await pool.connect();
    try {
      telefone = `+551199${randomInt(0, 10_000_000).toString().padStart(7, '0')}`;
      const p = await c.query<{ id: string }>(
        `INSERT INTO pessoas(nome, telefone_whatsapp, tipo, status)
         VALUES ('repro-73', $1, 'dono', 'ativa')
         RETURNING id`,
        [telefone],
      );
      pessoa_id = p.rows[0]!.id;
      const conv = await c.query<{ id: string }>(
        `INSERT INTO conversas(pessoa_id, escopo_entidades) VALUES ($1, '{}')
         RETURNING id`,
        [pessoa_id],
      );
      conversa_id = conv.rows[0]!.id;
      const ent = await c.query<{ id: string }>(
        `INSERT INTO entidades(nome, tipo, status) VALUES ('PF-repro-73', 'pf', 'ativa')
         RETURNING id`,
      );
      entidade_id = ent.rows[0]!.id;
    } finally {
      c.release();
    }
  });

  afterEach(async () => {
    const c = await pool.connect();
    try {
      await c.query('DELETE FROM mensagens WHERE conversa_id = $1', [conversa_id]);
      if (cleanupTracking.permissoes.length > 0) {
        await c.query('DELETE FROM permissoes WHERE id = ANY($1)', [cleanupTracking.permissoes]);
      }
      await c.query('DELETE FROM conversas WHERE id = $1', [conversa_id]);
      await c.query('DELETE FROM entidades WHERE id = $1', [entidade_id]);
      await c.query('DELETE FROM pessoas WHERE id = $1', [pessoa_id]);
      if (cleanupTracking.profiles.length > 0) {
        await c.query('DELETE FROM permission_profiles WHERE id = ANY($1)', [
          cleanupTracking.profiles,
        ]);
      }
    } finally {
      c.release();
    }
  });

  it('Repro 1: when permission is added between turns, the next prompt contains the scope-change sentinel', async () => {
    const c = await pool.connect();
    let profile_id: string;
    try {
      profile_id = await createOwnerProfile(c);
    } finally {
      c.release();
    }

    const { resolveScope } = await import('../../src/governance/permissions.js');
    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { conversasRepo, pessoasRepo } = await import('../../src/db/repositories.js');

    const pessoa = (await pessoasRepo.findById(pessoa_id))!;

    // Turn 1: no permissions. Maia refuses (we simulate the refusal text).
    const scope1 = await resolveScope(pessoa);
    expect(scope1.entidades).toEqual([]);

    const conversa1 = (await conversasRepo.byId(conversa_id))!;
    const inbound1Id = await (async () => {
      const cc = await pool.connect();
      try {
        return await insertInbound(cc, { conversa_id, conteudo: 'agenda 6 lembretes pra mim' });
      } finally {
        cc.release();
      }
    })();
    const inbound1 = (await (await import('../../src/db/repositories.js')).mensagensRepo.findById(inbound1Id))!;

    const built1 = await buildPrompt({ pessoa, conversa: conversa1, scope: scope1, inbound: inbound1 });
    // First turn — no prior assistant exists, no sentinel.
    expect(built1.system).not.toMatch(/Mudan[çc]a de escopo desde sua [úu]ltima resposta/i);

    // Maia "responds" with a refusal saved as assistant message + persist scope hash for turn 1.
    const { hashScope } = await import('../../src/agent/scope-hash.js');
    await conversasRepo.mergeMetadata(conversa_id, {
      last_scope_hash: hashScope(scope1),
      last_scope_hash_set_at: new Date().toISOString(),
    });
    {
      const cc = await pool.connect();
      try {
        await insertAssistantMsg(cc, {
          conversa_id,
          conteudo: 'Não consegui — o backend retornou erro de sessão.',
          ferramentas_chamadas: [],
        });
      } finally {
        cc.release();
      }
    }

    // Support grants the permission via DB while the conversation is still active.
    {
      const cc = await pool.connect();
      try {
        await grantPermission(cc, { pessoa_id, entidade_id, profile_id: profile_id! });
      } finally {
        cc.release();
      }
    }

    // Turn 2: user says "refaz". Permission is now in place.
    const scope2 = await resolveScope(pessoa);
    expect(scope2.entidades).toContain(entidade_id);

    const inbound2Id = await (async () => {
      const cc = await pool.connect();
      try {
        return await insertInbound(cc, { conversa_id, conteudo: 'refaz' });
      } finally {
        cc.release();
      }
    })();
    const inbound2 = (await (await import('../../src/db/repositories.js')).mensagensRepo.findById(inbound2Id))!;
    const conversa2 = (await conversasRepo.byId(conversa_id))!;

    const built2 = await buildPrompt({ pessoa, conversa: conversa2, scope: scope2, inbound: inbound2 });

    // The fix: this prompt must announce the scope change to the LLM.
    expect(built2.system).toMatch(/Mudan[çc]a de escopo desde sua [úu]ltima resposta/i);
    expect(built2.system).toMatch(/descarte conclus[õo]es anteriores/i);

    // And conversa metadata must still hold the merged keys (sanity for mergeMetadata).
    const c2 = (await conversasRepo.byId(conversa_id))!;
    const meta = (c2.metadata ?? {}) as Record<string, unknown>;
    expect(typeof meta.last_scope_hash).toBe('string');
    expect(typeof meta.last_scope_hash_set_at).toBe('string');
  });

  it('Repro 2: when prior assistant turn has tool summaries, next prompt surfaces them in "## Eventos confirmados pelo backend"', async () => {
    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { conversasRepo, pessoasRepo, mensagensRepo } = await import('../../src/db/repositories.js');
    const { resolveScope } = await import('../../src/governance/permissions.js');

    const pessoa = (await pessoasRepo.findById(pessoa_id))!;
    const scope = await resolveScope(pessoa);

    // Six successful schedule_reminder summaries on the prior assistant turn,
    // matching the issue's Repro 2 setup (6 one-shot reminders).
    const now = new Date();
    const occurredAt = new Date(now.getTime() - 60_000).toISOString();
    const sixSummaries = Array.from({ length: 6 }, (_, i) => ({
      tool_call_id: `tu_${i}`,
      tool_name: 'schedule_reminder',
      status: 'success' as const,
      side_effect: 'write' as const,
      result_summary: `lembrete ${i + 1} agendado para 2026-05-25`,
      result_keys: { series_id: randomUUID(), occurrence_id: randomUUID() },
      occurred_at: occurredAt,
    }));

    {
      const cc = await pool.connect();
      try {
        await insertAssistantMsg(cc, {
          conversa_id,
          conteudo: 'Pronto, agendei os 6 lembretes.',
          ferramentas_chamadas: sixSummaries,
          created_at: new Date(now.getTime() - 30_000),
        });
      } finally {
        cc.release();
      }
    }

    // The next inbound: "agendou?"
    const cc = await pool.connect();
    let inbound: import('../../src/db/schema.js').Mensagem;
    try {
      const id = await insertInbound(cc, { conversa_id, conteudo: 'agendou?' });
      inbound = (await mensagensRepo.findById(id))!;
    } finally {
      cc.release();
    }
    const conversa = (await conversasRepo.byId(conversa_id))!;

    const built = await buildPrompt({ pessoa, conversa, scope, inbound });

    // Events block present in the SYSTEM prompt with the persisted summaries.
    expect(built.system).toMatch(/## Eventos confirmados pelo backend/);
    expect(built.system).toMatch(/schedule_reminder.*success/);
    // At least one summary line surfaced (K=5 cap means 5 of 6 appear).
    expect(built.system).toContain('lembrete 1 agendado para 2026-05-25');

    // The events block must appear in `system`, NEVER as text injected into
    // the prior assistant message inside `messages`.
    const assistant = built.messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(typeof assistant!.content).toBe('string');
    expect(assistant!.content).toBe('Pronto, agendei os 6 lembretes.');
    expect(assistant!.content as string).not.toContain('Eventos confirmados pelo backend');
    expect(assistant!.content as string).not.toContain('schedule_reminder');

    // And the events block must come BEFORE the regular history blocks
    // (validating evidence hierarchy ordering at the system level).
    const idxEvents = built.system.indexOf('## Eventos confirmados pelo backend');
    const idxFatos = built.system.indexOf('## Fatos relevantes');
    expect(idxEvents).toBeGreaterThan(-1);
    expect(idxFatos).toBeGreaterThan(idxEvents);
  });

  it('Repro 2 (contradiction overlay): a stale "não consegui" assistant text gets explicitly invalidated when paired with a successful schedule_reminder', async () => {
    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { conversasRepo, pessoasRepo, mensagensRepo } = await import('../../src/db/repositories.js');
    const { resolveScope } = await import('../../src/governance/permissions.js');

    const pessoa = (await pessoasRepo.findById(pessoa_id))!;
    const scope = await resolveScope(pessoa);

    // Prior assistant message says "não consegui agendar" but the persisted
    // summary says schedule_reminder succeeded — exactly Repro 2's pattern.
    const summary = {
      tool_call_id: 'tu_only',
      tool_name: 'schedule_reminder',
      status: 'success' as const,
      side_effect: 'write' as const,
      result_summary: 'lembrete agendado',
      occurred_at: new Date(Date.now() - 60_000).toISOString(),
    };
    {
      const cc = await pool.connect();
      try {
        await insertAssistantMsg(cc, {
          conversa_id,
          conteudo: 'Não consegui agendar os 6 lembretes — backend retornou erro.',
          ferramentas_chamadas: [summary],
        });
      } finally {
        cc.release();
      }
    }

    const cc = await pool.connect();
    let inbound: import('../../src/db/schema.js').Mensagem;
    try {
      const id = await insertInbound(cc, { conversa_id, conteudo: 'agendou?' });
      inbound = (await mensagensRepo.findById(id))!;
    } finally {
      cc.release();
    }
    const conversa = (await conversasRepo.byId(conversa_id))!;

    const built = await buildPrompt({ pessoa, conversa, scope, inbound });

    // The fix: prompt explicitly invalidates the contradictory old claim.
    expect(built.system).toMatch(/Conflito detectado/i);
    expect(built.system).toMatch(/trate.*invalid|descarte|obsolet/i);
    expect(built.system).toContain('schedule_reminder');
  });
});
