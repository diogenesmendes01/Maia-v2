/**
 * `expireDueDualApprovals()` tem DOIS disparadores em produção:
 * `src/workers/pending-expirer.ts` e `src/workflows/engine.ts`
 * (`workflow_engine_tick`). Ambos chamam a MESMA função, que cancela o
 * workflow e manda ao solicitante uma mensagem de WhatsApp.
 *
 * Até o CAS, o cancelamento era um `setStatus` incondicional. Dois ticks que
 * se cruzassem venciam o mesmo workflow, auditavam duas vezes e mandavam a
 * mensagem DUAS VEZES — e isso não exigia duas réplicas: acontecia dentro de
 * um processo só, porque são dois jobs distintos.
 *
 * Este spec é sobre o efeito EXTERNO. A asserção que importa não é o status no
 * banco (esse convergiria de qualquer jeito): é quantas mensagens saíram.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'idual-tenant';
const A = 'idual-agent';

/**
 * A fronteira de saída, falsificada para CONTAR. É o único mock: tudo mais —
 * o CAS, o relógio do banco, a leitura de pendentes — é real.
 */
const enviadas: string[] = [];
vi.mock('@/gateway/line-output.js', () => ({
  forCurrentAgentChannel: vi.fn(async () => ({
    scope: { tenant_id: T, agent_id: A, channel_id: 'c' },
    sendText: vi.fn(async (_jid: string, texto: string) => {
      enviadas.push(texto);
      return 'msg-id';
    }),
  })),
}));

let pool: pg.Pool;

d('expiração de dual approval — o efeito externo acontece UMA vez', () => {
  let pessoaId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query('INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [
      T,
    ]);
    await pool.query(
      'INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING',
      [A, T],
    );
  });

  afterAll(async () => {
    await pool?.query('DELETE FROM audit_log WHERE tenant_id = $1', [T]);
    await pool?.query('DELETE FROM workflows WHERE tenant_id = $1', [T]);
    await pool?.query('DELETE FROM pessoas WHERE tenant_id = $1', [T]);
    await pool?.end();
  });

  beforeEach(async () => {
    enviadas.length = 0;
    await pool.query('DELETE FROM audit_log WHERE tenant_id = $1', [T]);
    await pool.query('DELETE FROM workflows WHERE tenant_id = $1', [T]);
    await pool.query('DELETE FROM pessoas WHERE tenant_id = $1', [T]);
    const p = await pool.query<{ id: string }>(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo)
       VALUES ($1, $2, 'Solicitante', '+5511900000001', 'dono') RETURNING id`,
      [T, A],
    );
    pessoaId = p.rows[0]!.id;
  });

  /**
   * Um dual approval JÁ VENCIDO — o prazo é do banco, não do processo.
   *
   * O status é `aguardando_terceiro` porque é ESSE o estado em que
   * `requestDualApproval` deixa a solicitação enquanto falta a segunda
   * assinatura. Semear `'pendente'` aqui teria sido semear um estado que
   * produção nunca produz — e foi exatamente o que deixou passar um CAS
   * restrito a `'pendente'`, que desligaria a expiração de todo dual approval
   * de verdade.
   */
  const semearVencido = async (status = 'aguardando_terceiro'): Promise<string> => {
    const w = await pool.query<{ id: string }>(
      `INSERT INTO workflows(tenant_id, agent_id, tipo, status, contexto, proxima_acao_em)
       VALUES ($1, $2, 'dual_approval', $4, $3, now() - interval '1 hour')
       RETURNING id`,
      [T, A, JSON.stringify({ requester_pessoa_id: pessoaId }), status],
    );
    return w.rows[0]!.id;
  };

  const rodarDoisTicks = async (): Promise<void> => {
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');
    const { expireDueDualApprovals } = await import('../../src/workflows/dual-approval.js');
    const escopo = { tenant_id: T, agent_id: A };
    // Os dois jobs de produção, disparados juntos. Quem serializa é o CAS.
    await Promise.all([
      runWithTenantContext(escopo, () => expireDueDualApprovals()),
      runWithTenantContext(escopo, () => expireDueDualApprovals()),
    ]);
  };

  it('dois ticks concorrentes cancelam UMA vez e avisam o solicitante UMA vez', async () => {
    const id = await semearVencido();

    await rodarDoisTicks();

    // A asserção que importa: o usuário recebeu UMA mensagem, não duas.
    expect(
      enviadas.length,
      `o solicitante recebeu ${enviadas.length} mensagens de expiração`,
    ).toBe(1);

    const st = await pool.query<{ status: string }>(
      'SELECT status FROM workflows WHERE id = $1',
      [id],
    );
    expect(st.rows[0]!.status).toBe('cancelado');

    // E a trilha também é única — auditoria dupla inventa dois fatos de um só.
    const au = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE tenant_id = $1 AND acao = 'dual_approval_timeout' AND alvo_id = $2`,
      [T, id],
    );
    expect(Number(au.rows[0]!.n), 'a expiração foi auditada mais de uma vez').toBe(1);
  });

  it('CONTROLE: um workflow que AINDA NÃO venceu não é cancelado nem avisado', async () => {
    // Sem este caso, um `expireIfDue` que nunca cancelasse nada passaria no
    // teste acima — zero mensagens não é o que se está afirmando.
    const w = await pool.query<{ id: string }>(
      `INSERT INTO workflows(tenant_id, agent_id, tipo, status, contexto, proxima_acao_em)
       VALUES ($1, $2, 'dual_approval', 'aguardando_terceiro', $3, now() + interval '1 hour')
       RETURNING id`,
      [T, A, JSON.stringify({ requester_pessoa_id: pessoaId })],
    );

    await rodarDoisTicks();

    expect(enviadas.length).toBe(0);
    const st = await pool.query<{ status: string }>(
      'SELECT status FROM workflows WHERE id = $1',
      [w.rows[0]!.id],
    );
    expect(st.rows[0]!.status, 'um workflow no prazo foi cancelado').toBe('aguardando_terceiro');
  });

  it('o CAS tem DUAS condições, e cada uma sozinha já recusa', async () => {
    // Este caso fala com `expireIfDue` direto, e não pelo laço. Motivo: o
    // filtro barato em JavaScript nunca deixa uma row FUTURA chegar ao SQL, de
    // modo que pelo laço a cláusula `proxima_acao_em <= now()` do CAS jamais
    // seria exercida — ficaria vácua, e apagá-la não quebraria teste nenhum.
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');
    const { workflowsRepo } = await import('../../src/db/repositories.js');
    const escopo = { tenant_id: T, agent_id: A };

    // (a) `status IN (abertos)` — segunda chamada na MESMA row perde.
    const vencido = await semearVencido();
    const primeira = await runWithTenantContext(escopo, () =>
      workflowsRepo.expireIfDue(vencido),
    );
    const segunda = await runWithTenantContext(escopo, () =>
      workflowsRepo.expireIfDue(vencido),
    );
    expect(primeira, 'a primeira chamada devia ter vencido a row').toBe(true);
    expect(segunda, 'a segunda chamada cancelou de novo o que já estava cancelado').toBe(false);

    // (b) `proxima_acao_em <= now()` — o relógio é o do BANCO. Uma row no
    //     prazo é recusada mesmo entrando direto no CAS.
    const futuro = await pool.query<{ id: string }>(
      `INSERT INTO workflows(tenant_id, agent_id, tipo, status, contexto, proxima_acao_em)
       VALUES ($1, $2, 'dual_approval', 'aguardando_terceiro', $3, now() + interval '1 hour')
       RETURNING id`,
      [T, A, JSON.stringify({ requester_pessoa_id: pessoaId })],
    );
    const noPrazo = await runWithTenantContext(escopo, () =>
      workflowsRepo.expireIfDue(futuro.rows[0]!.id),
    );
    expect(noPrazo, 'o CAS venceu um workflow que ainda estava no prazo').toBe(false);

    const st = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM workflows WHERE tenant_id = $1 ORDER BY proxima_acao_em',
      [T],
    );
    expect(st.rows.map((r) => r.status)).toEqual(['cancelado', 'aguardando_terceiro']);
  });

  it('o CAS vence TODO status aberto — restringi-lo a um só desligaria a expiração', async () => {
    // A regressão que este caso trava: escrever o CAS como `status =
    // 'pendente'` deixa a suíte verde num seed feito à mão e, em produção,
    // nunca vence nada, porque dual approval real espera em
    // `aguardando_terceiro`. O conjunto aqui é o mesmo `WORKFLOW_OPEN_STATUSES`
    // que `listPending` usa para trazer a row até o laço.
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');
    const { workflowsRepo, WORKFLOW_OPEN_STATUSES } = await import(
      '../../src/db/repositories.js'
    );
    const escopo = { tenant_id: T, agent_id: A };

    for (const status of WORKFLOW_OPEN_STATUSES) {
      const id = await semearVencido(status);
      const venceu = await runWithTenantContext(escopo, () => workflowsRepo.expireIfDue(id));
      expect(venceu, `um workflow vencido em '${status}' não foi cancelado`).toBe(true);
    }
  });
});
