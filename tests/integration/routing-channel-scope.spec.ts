/**
 * Spec roteamento v4 §5 (integração, fase 0) — invariantes de escopo por
 * canal no DB real:
 *
 *   - FK COMPOSTA rejeita canal estrangeiro: uma row de conversas/mensagens/
 *     outbox nunca aponta para canal de outro tenant/agente (constraint 090);
 *   - IDENTIDADE da conversa inclui o canal: a MESMA pessoa em duas linhas
 *     são DUAS conversas; row legada (channel NULL) casa qualquer canal até
 *     encerrar;
 *   - DEDUP por canal: o mesmo whatsapp_id em duas linhas persiste DUAS
 *     vezes (nunca descartado por colisão cross-linha — invariante 3);
 *     retry na MESMA linha persiste UMA;
 *   - CHECK do outbox: row whatsapp enviável exige canal.
 *
 * Skipped without TEST_DB_URL (matches sibling integration specs).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'routing-scope-tenant';
const A = 'routing-scope-agent';
const T2 = 'routing-scope-tenant-b';
const A2 = 'routing-scope-agent-b';

let pool: pg.Pool;
let chA1: string; // canal do agente A, linha 1
let chA2: string; // canal do agente A, linha 2
let chB1: string; // canal do tenant B (estrangeiro)

async function q<R extends pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>> {
  const c = await pool.connect();
  try {
    return await c.query<R>(text, params);
  } finally {
    c.release();
  }
}

if (SHOULD_RUN) {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    for (const [t, a] of [
      [T, A],
      [T2, A2],
    ] as const) {
      await q(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [t]);
      await q(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
        [a, t],
      );
    }
    const mk = async (t: string, a: string, line: string): Promise<string> => {
      const r = await q<{ id: string }>(
        `INSERT INTO channels (tenant_id, agent_id, external_id, channel_type, display_name, active)
         VALUES ($1, $2, $3, 'whatsapp', 'itest', true)
         ON CONFLICT (tenant_id, channel_type, external_id) DO UPDATE SET active = true
         RETURNING id`,
        [t, a, line],
      );
      return r.rows[0]!.id;
    };
    chA1 = await mk(T, A, '+5511900010001');
    chA2 = await mk(T, A, '+5511900010002');
    chB1 = await mk(T2, A2, '+5511900010003');
  });

  afterAll(async () => {
    for (const t of [T, T2]) {
      await q(`DELETE FROM mensagens WHERE tenant_id = $1`, [t]);
      await q(`DELETE FROM outbox_messages WHERE tenant_id = $1`, [t]);
      await q(`DELETE FROM conversas WHERE tenant_id = $1`, [t]);
      await q(`DELETE FROM pessoas WHERE tenant_id = $1`, [t]);
      await q(`DELETE FROM channels WHERE tenant_id = $1`, [t]);
      await q(`DELETE FROM agents WHERE tenant_id = $1`, [t]);
      await q(`DELETE FROM tenants WHERE id = $1`, [t]);
    }
    await pool.end();
  });

  beforeEach(async () => {
    for (const t of [T, T2]) {
      await q(`DELETE FROM mensagens WHERE tenant_id = $1`, [t]);
      await q(`DELETE FROM outbox_messages WHERE tenant_id = $1`, [t]);
      await q(`DELETE FROM conversas WHERE tenant_id = $1`, [t]);
      await q(`DELETE FROM pessoas WHERE tenant_id = $1`, [t]);
    }
  });
}

async function seedPessoa(): Promise<string> {
  const r = await q<{ id: string }>(
    `INSERT INTO pessoas (tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
     VALUES ($1, $2, 'Pessoa Teste', '+5511977770001', 'cliente', 'ativa')
     RETURNING id`,
    [T, A],
  );
  return r.rows[0]!.id;
}

d('fase 0 — escopo por canal no DB (constraints 090)', () => {
  it('FK composta: conversa apontando canal de OUTRO tenant é rejeitada (23503)', async () => {
    const pessoa = await seedPessoa();
    await expect(
      q(
        `INSERT INTO conversas (tenant_id, agent_id, pessoa_id, status, escopo_entidades, channel_id)
         VALUES ($1, $2, $3, 'ativa', '{}'::uuid[], $4)`,
        [T, A, pessoa, chB1],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('identidade da conversa inclui o canal: mesma pessoa em duas linhas ⇒ DUAS conversas; legada casa qualquer canal', async () => {
    const { conversasRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');
    const pessoa = await seedPessoa();

    await runWithTenantContext({ tenant_id: T, agent_id: A }, async () => {
      const c1 = await conversasRepo.create({
        pessoa_id: pessoa,
        escopo_entidades: [],
        channel_id: chA1,
      });
      // Na linha 2 a conversa da linha 1 NÃO casa ⇒ o resolver criaria outra.
      const foundOnLine2 = await conversasRepo.findActive(pessoa, chA2);
      expect(foundOnLine2).toBeNull();
      const c2 = await conversasRepo.create({
        pessoa_id: pessoa,
        escopo_entidades: [],
        channel_id: chA2,
      });
      expect(c2.id).not.toBe(c1.id);

      // Cada linha reencontra a SUA conversa.
      expect((await conversasRepo.findActive(pessoa, chA1))?.id).toBe(c1.id);
      expect((await conversasRepo.findActive(pessoa, chA2))?.id).toBe(c2.id);
    });

    // Janela de transição: row LEGADA (channel NULL) casa qualquer canal —
    // preferência pelo match exato quando ambos existem.
    await q(`DELETE FROM conversas WHERE tenant_id = $1`, [T]);
    await runWithTenantContext({ tenant_id: T, agent_id: A }, async () => {
      const legacy = await conversasRepo.create({
        pessoa_id: pessoa,
        escopo_entidades: [],
        channel_id: null,
      });
      expect((await conversasRepo.findActive(pessoa, chA1))?.id).toBe(legacy.id);
      expect((await conversasRepo.findActive(pessoa, chA2))?.id).toBe(legacy.id);
    });
  });

  it('dedup por canal: mesmo whatsapp_id em duas linhas persiste AMBAS; retry na mesma linha ⇒ UMA (invariante 3)', async () => {
    const { mensagensRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');
    await seedPessoa();

    await runWithTenantContext({ tenant_id: T, agent_id: A }, async () => {
      const base = {
        conversa_id: null,
        direcao: 'in' as const,
        tipo: 'texto' as const,
        conteudo: 'oi',
        midia_url: null,
        metadata: { whatsapp_id: 'WID-COLIDE-1' },
        processada_em: null,
        ferramentas_chamadas: [],
        tokens_usados: null,
      };
      const l1 = await mensagensRepo.createInbound({ ...base, channel_id: chA1 });
      expect(l1.duplicate).toBe(false);

      // MESMO whatsapp_id chegando pela OUTRA linha: persiste (nunca descarta).
      const l2 = await mensagensRepo.createInbound({ ...base, channel_id: chA2 });
      expect(l2.duplicate).toBe(false);
      expect(l2.row.id).not.toBe(l1.row.id);

      // Retry na MESMA linha: dedup.
      const retry = await mensagensRepo.createInbound({ ...base, channel_id: chA1 });
      expect(retry.duplicate).toBe(true);
      expect(retry.row.id).toBe(l1.row.id);
    });
  });

  it('CHECK do outbox: row whatsapp enviável sem canal é rejeitada (23514); email_alert passa', async () => {
    await expect(
      q(
        `INSERT INTO outbox_messages (tenant_id, agent_id, kind, payload, status)
         VALUES ($1, $2, 'whatsapp_text', '{}'::jsonb, 'pending')`,
        [T, A],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // Kind sem linha (email) não exige canal.
    const ok = await q<{ id: string }>(
      `INSERT INTO outbox_messages (tenant_id, agent_id, kind, payload, status)
       VALUES ($1, $2, 'email_alert', '{}'::jsonb, 'pending')
       RETURNING id`,
      [T, A],
    );
    expect(ok.rows).toHaveLength(1);
  });
});
