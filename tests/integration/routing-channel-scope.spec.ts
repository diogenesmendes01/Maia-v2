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

      // Review #496 (alto 6): o primeiro inbound RESOLVIDO vincula a legada
      // ao canal (CAS em channel_id IS NULL) — ela deixa de casar as outras
      // linhas e nunca é re-vinculada.
      expect(await conversasRepo.bindChannelIfNull(legacy.id, chA1)).toBe(true);
      expect((await conversasRepo.findActive(pessoa, chA1))?.id).toBe(legacy.id);
      expect(await conversasRepo.findActive(pessoa, chA2)).toBeNull();
      // Segunda tentativa (corrida da linha 2) perde o CAS.
      expect(await conversasRepo.bindChannelIfNull(legacy.id, chA2)).toBe(false);
      expect((await conversasRepo.findActive(pessoa, chA1))?.id).toBe(legacy.id);
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

  it('messages.update: lookup cross-tenant escopado por CANAL resolve o wid colidido para o tenant certo (review #496 crítico 1)', async () => {
    const { mensagensRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');

    const base = {
      conversa_id: null,
      direcao: 'in' as const,
      tipo: 'texto' as const,
      conteudo: 'colisão cross-tenant',
      midia_url: null,
      metadata: { whatsapp_id: 'WID-XTENANT-1' },
      processada_em: null,
      ferramentas_chamadas: [],
      tokens_usados: null,
    };
    // O MESMO wid inbound em duas linhas de TENANTS diferentes (dedup por
    // canal permite — invariante 3). A row do tenant B é a mais RECENTE de
    // propósito: um lookup global (sem canal) escolheria ela para um edit
    // que chegou pela linha do tenant A — auditoria no tenant errado.
    await runWithTenantContext({ tenant_id: T, agent_id: A }, async () => {
      await mensagensRepo.createInbound({ ...base, channel_id: chA1 });
    });
    await runWithTenantContext({ tenant_id: T2, agent_id: A2 }, async () => {
      await mensagensRepo.createInbound({ ...base, channel_id: chB1 });
    });

    const viaLineA = await mensagensRepo.findByWhatsappIdCrossTenant('WID-XTENANT-1', chA1);
    expect(viaLineA?.tenant_id).toBe(T);
    expect(viaLineA?.channel_id).toBe(chA1);

    const viaLineB = await mensagensRepo.findByWhatsappIdCrossTenant('WID-XTENANT-1', chB1);
    expect(viaLineB?.tenant_id).toBe(T2);
    expect(viaLineB?.channel_id).toBe(chB1);
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

  it('rollback data-aware (review #496 alto 7): downs 091+090 aplicam com dados pós-rollout, sem perda', async () => {
    // DATABASE PRIVADO descartável. O down de 090 toma ACCESS EXCLUSIVE em
    // tabelas quentes (mensagens/conversas/outbox) — rodá-lo no DB
    // compartilhado deadlocka com o cleanup de qualquer spec em paralelo
    // (visto no CI: o `DELETE FROM tenants` de outro arquivo virou vítima
    // do deadlock detector). Num database só deste teste, os locks não
    // tocam ninguém e os downs REAIS rodam contra um schema 100% migrado.
    const { readFile, readdir } = await import('node:fs/promises');
    const { NO_TX_MARKER, splitNoTxStatements } = await import('../../scripts/migrate.ts');
    const migrationsDir = new URL('../../migrations/', import.meta.url);
    const RB_DB = 'maia_rollback_090_test';

    const adminUrl = process.env.TEST_DB_URL!;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${RB_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${RB_DB}`);
    await admin.end();

    const rbUrl = new URL(adminUrl);
    rbUrl.pathname = `/${RB_DB}`;
    const c = new pg.Client({ connectionString: rbUrl.toString() });
    await c.connect();
    try {
      // Forward completo, com as MESMAS regras do scripts/migrate.ts
      // (ordem lexicográfica; arquivos `-- maia:no-transaction` vão
      // statement a statement por causa do CONCURRENTLY).
      const files = (await readdir(migrationsDir))
        .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
        .sort();
      for (const f of files) {
        const sqlText = await readFile(new URL(f, migrationsDir), 'utf8');
        if (NO_TX_MARKER.test(sqlText)) {
          for (const stmt of splitNoTxStatements(sqlText)) await c.query(stmt);
        } else {
          await c.query(sqlText);
        }
      }

      // Dados pós-rollout: o MESMO wid em dois canais (dedup por canal) — o
      // cenário que abortava o down antigo na recriação da unique global.
      await c.query(
        `INSERT INTO tenants (id, nome) VALUES ('rb-tenant', 'rb-tenant')`,
      );
      await c.query(
        `INSERT INTO agents (id, tenant_id, nome) VALUES ('rb-agent', 'rb-tenant', 'rb-agent')`,
      );
      const mk = async (line: string, active: boolean): Promise<string> => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO channels (tenant_id, agent_id, external_id, channel_type, display_name, active)
           VALUES ('rb-tenant', 'rb-agent', $1, 'whatsapp', 'rb', $2) RETURNING id`,
          [line, active],
        );
        return r.rows[0]!.id;
      };
      const chR1 = await mk('+5511900010001', true);
      const chR2 = await mk('+5511900010002', false);
      await c.query(
        `INSERT INTO mensagens (tenant_id, agent_id, direcao, tipo, conteudo, metadata, channel_id, created_at)
         VALUES ('rb-tenant', 'rb-agent', 'in', 'texto', 'linha 1', '{"whatsapp_id":"WID-RB-1"}'::jsonb, $1, now() - interval '1 minute'),
                ('rb-tenant', 'rb-agent', 'in', 'texto', 'linha 2', '{"whatsapp_id":"WID-RB-1"}'::jsonb, $2, now())`,
        [chR1, chR2],
      );

      // Canal cujo forward de 091 normalizou (simulado via o registro de
      // backup); chR1 fica FORA do backup (sempre foi E.164).
      const rbCh = await mk('+5511900019999', false);
      await c.query(
        `INSERT INTO channels_line_normalization_091_backup (channel_id, original_external_id)
         VALUES ($1, '5511900019999')`,
        [rbCh],
      );

      const down091 = await readFile(
        new URL('091_line_ownership_down.sql', migrationsDir),
        'utf8',
      );
      const down090 = await readFile(
        new URL('090_channel_scoped_egress_down.sql', migrationsDir),
        'utf8',
      );

      // ── 091 down: restaura SÓ o que o forward mudou ──────────────────
      await c.query(down091);
      const restored = await c.query<{ external_id: string }>(
        `SELECT external_id FROM channels WHERE id = $1`,
        [rbCh],
      );
      expect(restored.rows[0]!.external_id).toBe('5511900019999');
      const untouched = await c.query<{ external_id: string }>(
        `SELECT external_id FROM channels WHERE id = $1`,
        [chR1],
      );
      expect(untouched.rows[0]!.external_id).toBe('+5511900010001'); // NÃO desnormalizado
      const backupGone = await c.query(
        `SELECT to_regclass('channels_line_normalization_091_backup') AS t`,
      );
      expect(backupGone.rows[0]!.t).toBeNull();

      // ── 090 down: unique global volta com duplicatas PARKED, sem apagar ─
      await c.query(down090);
      const idx = await c.query(`SELECT to_regclass('uniq_mensagens_whatsapp_id') AS t`);
      expect(idx.rows[0]!.t).not.toBeNull();
      const live = await c.query<{ conteudo: string }>(
        `SELECT conteudo FROM mensagens WHERE metadata->>'whatsapp_id' = 'WID-RB-1'`,
      );
      // A MAIS ANTIGA mantém a chave viva (semântica legada de dedup)…
      expect(live.rows.map((r) => r.conteudo)).toEqual(['linha 1']);
      // …e a outra fica auditável sob a chave renomeada — nenhuma row some.
      const parked = await c.query<{ conteudo: string }>(
        `SELECT conteudo FROM mensagens
          WHERE metadata->>'whatsapp_id_pre_090_rollback' = 'WID-RB-1'`,
      );
      expect(parked.rows.map((r) => r.conteudo)).toEqual(['linha 2']);
      const col = await c.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'mensagens' AND column_name = 'channel_id'`,
      );
      expect(col.rows).toHaveLength(0);
    } finally {
      await c.end().catch(() => undefined);
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup
        .query(`DROP DATABASE IF EXISTS ${RB_DB} WITH (FORCE)`)
        .catch(() => undefined);
      await cleanup.end();
    }
  }, 120_000);
});
