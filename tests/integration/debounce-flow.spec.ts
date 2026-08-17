/**
 * Integration spec for the message-debounce flow against a live Postgres.
 *
 * The unit suite exercises the aggregator and the debouncer in isolation
 * (`tests/unit/debouncer.spec.ts`, `tests/unit/agent-aggregate.spec.ts`),
 * but every repo call there is mocked. The bug repaired in PR #48
 * (commit 1d7fd63) hinged on `conversa_id IS NULL` semantics inside the
 * JSONB `metadata->>'telefone'` query — exactly the kind of mismatch
 * that mocks silently mask.
 *
 * This spec runs the JSONB lookup, the bulk conversa-id update, and the
 * mark-processed sequence against a real database so a regression in any
 * of those three paths fails CI. Stubs the queue/baileys chain at module
 * load (those don't need a live Redis for the aggregator path) so we can
 * import the production `_internal.aggregateUnprocessedTexts` directly
 * instead of reimplementing its logic in the test.
 *
 * Skipped without TEST_DB_URL so unit-only CI lanes keep passing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';
import { randomInt } from 'node:crypto';

// `aggregateUnprocessedTexts` short-circuits when FEATURE_MESSAGE_DEBOUNCE
// is off, and config/env.ts parses the env at module load via zod — so a
// `process.env.FEATURE_MESSAGE_DEBOUNCE = 'true'` inside `it()` lands too
// late. `vi.hoisted` runs before ANY import in the file, even hoisted ESM
// imports, so the config module reads the truthy value the first time it
// loads.
vi.hoisted(() => {
  process.env.FEATURE_MESSAGE_DEBOUNCE = 'true';
});

// Stub the queue/baileys/redis chain so importing src/agent/core.js
// (for `_internal.aggregateUnprocessedTexts`) doesn't try to open a
// BullMQ Queue or a Baileys socket. The DB layer is real.
vi.mock('../../src/lib/redis.js', () => ({
  redis: {},
  isRedisConnected: () => false,
  ensureRedisConnect: vi.fn(),
  // #309: the debouncer's catch path consults these. Redis is "down" here so
  // the disconnect guard fires first; the no-ops keep behaviour unchanged.
  isRedisOomError: () => false,
  recordRedisOomDegraded: () => {},
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

// P0 adicionou `getCurrentTenant()` em listUnprocessedByTelefone e
// derivados. issue #323 eliminou o tenant legacy 'default' (083 apaga as rows;
// 082 derruba o column-default 'default'), então os fixtures abaixo gravam
// tenant_id/agent_id 'primary' EXPLICITAMENTE nos raw inserts (omiti-los agora
// viola NOT NULL) e wrappamos as chamadas de repo no contexto 'primary'.
import { runWithTenantContext } from '@/db/tenant-context.js';
const withPrimaryTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: 'primary', agent_id: 'primary' }, fn);

let pool: pg.Pool;
let pessoa_id: string;
let conversa_id: string;
let telefone: string;

async function insertInbound(
  client: pg.PoolClient,
  args: {
    conversa_id: string | null;
    telefone: string;
    conteudo: string;
    created_at?: Date;
    whatsapp_id?: string;
  },
): Promise<string> {
  const wid = args.whatsapp_id ?? `WAID-${randomInt(0, 1e9).toString(36)}`;
  const created = args.created_at?.toISOString() ?? null;
  const r = await client.query<{ id: string }>(
    `INSERT INTO mensagens(
       tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata${created ? ', created_at' : ''}
     )
     VALUES ('primary', 'primary', $1, 'in', 'texto', $2, jsonb_build_object('telefone', $3::text, 'whatsapp_id', $4::text)${
       created ? ', $5::timestamptz' : ''
     })
     RETURNING id`,
    created
      ? [args.conversa_id, args.conteudo, args.telefone, wid, created]
      : [args.conversa_id, args.conteudo, args.telefone, wid],
  );
  return r.rows[0]!.id;
}

// #545: `repositories.js` custa 1.92–2.47s a frio e `agent/core.js` 6.38–6.60s,
// contra 13–25ms de trabalho real por caso. Pago no `it()`, um estouro deixava o
// corpo órfão rodando: o `finally { cleanup() }` da tentativa morta apagava as
// linhas DO RETRY, e o vermelho virava
// `markProcessed matched 0 rows` — nada a ver com a causa.
const repos = moduloDeProducao(() => import('../../src/db/repositories.js'));
const core = moduloDeProducao(() => import('../../src/agent/core.js'));

d('debounce-flow — JSONB + aggregation + idempotency against live Postgres', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Each test gets a fresh pessoa/conversa pair so concurrent runs don't
    // collide on the unique telefone constraint or leak state.
    const c = await pool.connect();
    try {
      telefone = `+551199${randomInt(0, 10_000_000).toString().padStart(7, '0')}`;
      const p = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ('primary', 'primary', 'debounce-fixture', $1, 'funcionario', 'ativa')
         RETURNING id`,
        [telefone],
      );
      pessoa_id = p.rows[0]!.id;
      const conv = await c.query<{ id: string }>(
        `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, escopo_entidades) VALUES ('primary', 'primary', $1, '{}')
         RETURNING id`,
        [pessoa_id],
      );
      conversa_id = conv.rows[0]!.id;
    } finally {
      c.release();
    }
  });

  /**
   * Cleanup is per-test rather than via tx wrapper because the repo methods
   * we exercise use the production `db` pool directly — wrapping in a
   * caller-controlled tx would not hold them. Best to delete rows
   * post-condition.
   */
  async function cleanup(): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query('DELETE FROM mensagens WHERE conversa_id = $1 OR conversa_id IS NULL AND metadata->>\'telefone\' = $2', [conversa_id, telefone]);
      await c.query('DELETE FROM conversas WHERE id = $1', [conversa_id]);
      await c.query('DELETE FROM pessoas WHERE id = $1', [pessoa_id]);
    } finally {
      c.release();
    }
  }

  it('listUnprocessedByTelefone returns conversa_id-NULL siblings via JSONB lookup', async () => {
    const c = await pool.connect();
    try {
      const t0 = new Date(Date.now() - 3000);
      const t1 = new Date(Date.now() - 2000);
      const t2 = new Date(Date.now() - 1000);
      const id1 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'Oi,', created_at: t0 });
      const id2 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'como vai', created_at: t1 });
      const id3 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'a finança?', created_at: t2 });

      const { mensagensRepo } = repos();
      const rows = await withPrimaryTenant(() =>
        mensagensRepo.listUnprocessedByTelefone(telefone, { excludeId: id3 }),
      );
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
      expect(ids).not.toContain(id3); // excluded
      // All three are unprocessed and conversa_id IS NULL — the bug-prone shape.
      for (const r of rows) {
        expect(r.processada_em).toBeNull();
        expect(r.conversa_id).toBeNull();
      }
      // Chronological order.
      const ts = rows.map((r) => r.created_at?.getTime() ?? 0);
      const sorted = [...ts].sort((a, b) => a - b);
      expect(ts).toEqual(sorted);
    } finally {
      await cleanup();
      c.release();
    }
  });

  it('setConversaIdMany attaches NULL siblings to a conversa atomically', async () => {
    const c = await pool.connect();
    try {
      const t0 = new Date(Date.now() - 3000);
      const t1 = new Date(Date.now() - 2000);
      const id1 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'a', created_at: t0 });
      const id2 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'b', created_at: t1 });

      const { mensagensRepo } = repos();
      await withPrimaryTenant(() => mensagensRepo.setConversaIdMany([id1, id2], conversa_id));

      const r = await c.query<{ id: string; conversa_id: string | null }>(
        `SELECT id, conversa_id FROM mensagens WHERE id = ANY($1)`,
        [[id1, id2]],
      );
      for (const row of r.rows) {
        expect(row.conversa_id).toBe(conversa_id);
      }
    } finally {
      await cleanup();
      c.release();
    }
  });

  it('markProcessed flips processada_em on the target only, leaving siblings unchanged', async () => {
    const c = await pool.connect();
    try {
      const id1 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'a' });
      const id2 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'b' });

      const { mensagensRepo } = repos();
      await withPrimaryTenant(() => mensagensRepo.markProcessed(id1, 42));

      const target = await c.query<{ processada_em: Date | null; tokens_usados: number | null }>(
        `SELECT processada_em, tokens_usados FROM mensagens WHERE id = $1`,
        [id1],
      );
      expect(target.rows[0]!.processada_em).not.toBeNull();
      expect(target.rows[0]!.tokens_usados).toBe(42);

      const sibling = await c.query<{ processada_em: Date | null }>(
        `SELECT processada_em FROM mensagens WHERE id = $1`,
        [id2],
      );
      expect(sibling.rows[0]!.processada_em).toBeNull();
    } finally {
      await cleanup();
      c.release();
    }
  });

  it('aggregateUnprocessedTexts (production fn) merges chronologically and respects an already-processed sibling', async () => {
    // FEATURE_MESSAGE_DEBOUNCE is set via vi.hoisted at the top of the
    // file so config.FEATURE_MESSAGE_DEBOUNCE reads true. Setting it
    // here too is redundant but documents the dependency.
    const c = await pool.connect();
    try {
      const t0 = new Date(Date.now() - 3000);
      const t1 = new Date(Date.now() - 2000);
      const t2 = new Date(Date.now() - 1000);
      const id1 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'Oi,', created_at: t0 });
      const id2 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'como vai', created_at: t1 });
      const id3 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'a finança?', created_at: t2 });

      const { mensagensRepo } = repos();
      const target = await withPrimaryTenant(() => mensagensRepo.findById(id3));
      expect(target).not.toBeNull();

      // Import the real aggregator (queue/baileys are stubbed at module
      // top so this load chain doesn't open a Redis socket). This is the
      // exact function the agent worker calls in production — the spec
      // catches regressions in feature flag, conversa guard, separator,
      // and merged_ids that a re-implementation would not.
      const { _internal } = core();
      const out = await withPrimaryTenant(() => _internal.aggregateUnprocessedTexts(target!));
      expect(out.text).toBe('Oi,\ncomo vai\na finança?');
      expect(out.merged_ids).toEqual(expect.arrayContaining([id1, id2]));
      expect(out.merged_ids).not.toContain(id3); // target is excluded

      // Process id2 to simulate a partial run; the next aggregator call
      // should drop it from the merge.
      await withPrimaryTenant(() => mensagensRepo.markProcessed(id2, 0));
      const after = await withPrimaryTenant(() => _internal.aggregateUnprocessedTexts(target!));
      expect(after.text).toBe('Oi,\na finança?');
      expect(after.merged_ids).toEqual([id1]);
    } finally {
      await cleanup();
      c.release();
    }
  });

  it('re-running markProcessed does NOT cause the recovery worker to reprocess (queries skip the row)', async () => {
    const c = await pool.connect();
    try {
      const id1 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'a' });
      const id2 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'b' });
      const id3 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'c' });

      const { mensagensRepo } = repos();
      await withPrimaryTenant(async () => {
        await mensagensRepo.setConversaIdMany([id1, id2], conversa_id);
        await mensagensRepo.markProcessed(id1, 10);
        await mensagensRepo.markProcessed(id2, 0);
        await mensagensRepo.markProcessed(id3, 20);
      });

      // The "idempotency" we care about is: even if a recovery worker
      // hits an already-processed row again, the row stays excluded from
      // the unprocessed-query so the agent never runs twice. The
      // implementation overwrites processada_em + tokens_usados on every
      // call (not strictly idempotent at the row level), but that's
      // acceptable because the safety property is on the QUERY, not the
      // row. Assert both: the row is still excluded, and tokens_usados
      // does get overwritten (so the test reflects real behaviour).
      await withPrimaryTenant(() => mensagensRepo.markProcessed(id1, 999));

      const r = await c.query<{ id: string; processada_em: Date | null; tokens_usados: number | null; conversa_id: string | null }>(
        `SELECT id, processada_em, tokens_usados, conversa_id FROM mensagens WHERE id = ANY($1)`,
        [[id1, id2, id3]],
      );
      for (const row of r.rows) {
        expect(row.processada_em).not.toBeNull();
      }
      const byId = new Map(r.rows.map((row) => [row.id, row]));
      expect(byId.get(id1)!.conversa_id).toBe(conversa_id);
      expect(byId.get(id2)!.conversa_id).toBe(conversa_id);
      // Documented behaviour: the second call overwrites tokens_usados.
      // If we ever want strict idempotency, the markProcessed signature
      // needs a guard. For now the safety property is purely query-side.
      expect(byId.get(id1)!.tokens_usados).toBe(999);

      // The query-side safety: an unprocessed-only fetch must NOT return
      // any of the three rows.
      const stillUnprocessed = await withPrimaryTenant(() =>
        mensagensRepo.listUnprocessedByTelefone(telefone),
      );
      expect(stillUnprocessed.find((m) => m.id === id1)).toBeUndefined();
      expect(stillUnprocessed.find((m) => m.id === id2)).toBeUndefined();
      expect(stillUnprocessed.find((m) => m.id === id3)).toBeUndefined();
    } finally {
      await cleanup();
      c.release();
    }
  });
});
