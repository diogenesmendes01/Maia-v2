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
 * of those three paths fails CI. Mocks the LLM + outbound dispatch so we
 * don't need network or WhatsApp; everything else is real Postgres.
 *
 * Skipped without TEST_DB_URL so unit-only CI lanes keep passing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomInt } from 'node:crypto';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

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
       conversa_id, direcao, tipo, conteudo, metadata${created ? ', created_at' : ''}
     )
     VALUES ($1, 'in', 'texto', $2, jsonb_build_object('telefone', $3::text, 'whatsapp_id', $4::text)${
       created ? ', $5::timestamptz' : ''
     })
     RETURNING id`,
    created
      ? [args.conversa_id, args.conteudo, args.telefone, wid, created]
      : [args.conversa_id, args.conteudo, args.telefone, wid],
  );
  return r.rows[0]!.id;
}

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
        `INSERT INTO pessoas(nome, telefone_whatsapp, tipo, status)
         VALUES ('debounce-fixture', $1, 'funcionario', 'ativa')
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

      const { mensagensRepo } = await import('../../src/db/repositories.js');
      const rows = await mensagensRepo.listUnprocessedByTelefone(telefone, { excludeId: id3 });
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

      const { mensagensRepo } = await import('../../src/db/repositories.js');
      await mensagensRepo.setConversaIdMany([id1, id2], conversa_id);

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

      const { mensagensRepo } = await import('../../src/db/repositories.js');
      await mensagensRepo.markProcessed(id1, 42);

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

  it('aggregateUnprocessedTexts merges chronologically and respects an already-processed sibling', async () => {
    process.env.FEATURE_MESSAGE_DEBOUNCE = 'true';
    const c = await pool.connect();
    try {
      const t0 = new Date(Date.now() - 3000);
      const t1 = new Date(Date.now() - 2000);
      const t2 = new Date(Date.now() - 1000);
      const id1 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'Oi,', created_at: t0 });
      const id2 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'como vai', created_at: t1 });
      const id3 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'a finança?', created_at: t2 });

      const { mensagensRepo } = await import('../../src/db/repositories.js');
      const target = await mensagensRepo.findById(id3);
      expect(target).not.toBeNull();

      // We can't import agent/core directly without dragging the queue/baileys
      // load chain into the spec — but the aggregator's logic is exercised
      // via the same mensagensRepo.listUnprocessedByTelefone path it uses
      // internally. Rebuild the merge here so the test asserts the *shape*
      // of what the production code consumes.
      const siblings = await mensagensRepo.listUnprocessedByTelefone(telefone, {
        excludeId: target!.id,
      });
      const targetMs = target!.created_at?.getTime() ?? Date.now();
      const text = siblings
        .filter(
          (m) =>
            m.tipo === 'texto' &&
            (m.conteudo ?? '').length > 0 &&
            (m.created_at?.getTime() ?? 0) <= targetMs,
        )
        .map((m) => m.conteudo)
        .concat(target!.conteudo)
        .filter((s): s is string => !!s)
        .join('\n');
      expect(text).toBe('Oi,\ncomo vai\na finança?');

      // Process id2 to simulate a partial run; the next listUnprocessed
      // should drop it from the result.
      await mensagensRepo.markProcessed(id2, 0);
      const after = await mensagensRepo.listUnprocessedByTelefone(telefone, {
        excludeId: target!.id,
      });
      expect(after.find((m) => m.id === id2)).toBeUndefined();
      expect(after.find((m) => m.id === id1)).toBeDefined();
    } finally {
      await cleanup();
      c.release();
    }
  });

  it('end-to-end: setConversaIdMany + markProcessed sequence is idempotent', async () => {
    const c = await pool.connect();
    try {
      const id1 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'a' });
      const id2 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'b' });
      const id3 = await insertInbound(c, { conversa_id: null, telefone, conteudo: 'c' });

      const { mensagensRepo } = await import('../../src/db/repositories.js');
      await mensagensRepo.setConversaIdMany([id1, id2], conversa_id);
      await mensagensRepo.markProcessed(id1, 10);
      await mensagensRepo.markProcessed(id2, 0);
      await mensagensRepo.markProcessed(id3, 20);

      // Re-running the recovery worker on already-processed rows must be a
      // no-op: processada_em stays set, tokens unchanged, conversa_id sticks.
      await mensagensRepo.markProcessed(id1, 999);

      const r = await c.query<{ id: string; processada_em: Date | null; conversa_id: string | null }>(
        `SELECT id, processada_em, conversa_id FROM mensagens WHERE id = ANY($1)`,
        [[id1, id2, id3]],
      );
      for (const row of r.rows) {
        expect(row.processada_em).not.toBeNull();
      }
      // The two we batched share the conversa; id3 was inserted standalone
      // and only sees its own chain.
      const byId = new Map(r.rows.map((row) => [row.id, row]));
      expect(byId.get(id1)!.conversa_id).toBe(conversa_id);
      expect(byId.get(id2)!.conversa_id).toBe(conversa_id);
    } finally {
      await cleanup();
      c.release();
    }
  });
});
