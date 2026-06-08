/**
 * B0 concurrency proof: two parallel checkPendingFirst against the same
 * pending must dispatch the action exactly once. Skipped without TEST_DB_URL.
 *
 * Uses setClassifierForTesting to inject a deterministic resolver — no
 * Haiku round-trip, so the test is self-contained and doesn't need
 * ANTHROPIC_API_KEY in CI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;

d('pending-gate concurrency', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('dispatches action exactly once under parallel resolves', async () => {
    const c = await pool.connect();
    try {
      const pessoa = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo)
         VALUES ('primary', 'primary', 'test-b0', '+5511900000099', 'funcionario') RETURNING id`,
      );
      const conv = await c.query<{ id: string }>(
        `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, escopo_entidades) VALUES ('primary', 'primary', $1, '{}') RETURNING id`,
        [pessoa.rows[0]!.id],
      );
      await c.query(
        `INSERT INTO pending_questions(tenant_id, agent_id, conversa_id, pessoa_id, tipo, pergunta, opcoes_validas, acao_proposta, expira_em, status, metadata)
         VALUES ('primary', 'primary', $1, $2, 'gate', 'Confirma?', $3::jsonb, $4::jsonb, now() + interval '10 min', 'aberta', '{}'::jsonb)`,
        [
          conv.rows[0]!.id,
          pessoa.rows[0]!.id,
          JSON.stringify([{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }]),
          JSON.stringify({ tool: 'register_transaction', args: { valor: 50 } }),
        ],
      );

      process.env.FEATURE_PENDING_GATE = 'true';
      const { checkPendingFirst, setClassifierForTesting } = await import(
        '../../src/agent/pending-gate.js'
      );
      const { runWithTenantContext } = await import('../../src/db/tenant-context.js');
      setClassifierForTesting(async () => ({
        resolves_pending: true,
        option_chosen: 'sim',
        confidence: 0.95,
      }));

      const inbound = { id: 'm-test', conteudo: 'sim' };
      const conversa = { id: conv.rows[0]!.id };
      const persona = { id: pessoa.rows[0]!.id };

      // #355 H2 (flip-readiness): the resolve/cancel mutations under
      // checkPendingFirst are now tenant-scoped (they read tenant_id/agent_id
      // from ALS), so this gate path — like its production callers (baileys →
      // runWithTenantContext) — must run inside a tenant context. The seeded
      // pending_question is stamped 'primary'/'primary' above (issue #323 retired
      // the legacy 'default'), so wrap with the matching pair.
      const PRIMARY_CTX = { tenant_id: 'primary', agent_id: 'primary' };
      const [a, b] = await Promise.all([
        runWithTenantContext(PRIMARY_CTX, () =>
          checkPendingFirst({ pessoa: persona as never, conversa: conversa as never, inbound: inbound as never }),
        ),
        runWithTenantContext(PRIMARY_CTX, () =>
          checkPendingFirst({ pessoa: persona as never, conversa: conversa as never, inbound: inbound as never }),
        ),
      ]);

      const resolvedCount = [a, b].filter((x) => x.kind === 'resolved').length;
      expect(resolvedCount).toBe(1);

      const final = await c.query<{ status: string }>(
        `SELECT status FROM pending_questions WHERE conversa_id = $1`,
        [conv.rows[0]!.id],
      );
      expect(final.rows[0]!.status).toBe('respondida');

      // Cleanup
      await c.query('DELETE FROM pending_questions WHERE conversa_id = $1', [conv.rows[0]!.id]);
      await c.query('DELETE FROM conversas WHERE id = $1', [conv.rows[0]!.id]);
      await c.query('DELETE FROM pessoas WHERE id = $1', [pessoa.rows[0]!.id]);
      setClassifierForTesting(null);
    } finally {
      c.release();
    }
  });
});
