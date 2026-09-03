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
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'idual-tenant';
const A = 'idual-agent';

/**
 * A fronteira de saída MUDOU, e a asserção acompanhou.
 *
 * Quando este spec nasceu, a expiração chamava `sendViaLine` e o jeito de
 * contar o efeito era falsificar `@/gateway/line-output.js`. A #506 moveu esse
 * aviso para o ledger durável: hoje `expireDueDualApprovals` chama
 * `enqueueProactiveNotice`, que grava uma row em `outbox_messages` com
 * `dedup_key = dual_approval:<id>:expired`, e o drain de agendamento entrega.
 *
 * Contar rows do ledger é melhor que contar chamadas de um dublê — é o
 * artefato de produção. Mas muda o que cada asserção prova, e isso importa:
 *
 *   - a CONTAGEM DE AVISOS passou a ter DUAS proteções: o CAS daqui e o
 *     `idx_outbox_dedup` do ledger. Ela documenta defesa em profundidade, e
 *     sozinha não distingue mais qual das duas está funcionando;
 *   - a CONTAGEM DE AUDITORIA continua protegida SÓ pelo CAS — `audit_log` não
 *     tem chave de deduplicação. É ela a asserção que fica vermelha quando o
 *     compare-and-swap sai daqui, e é por isso que ela não é decorativa.
 */

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
    await pool?.query('DELETE FROM outbox_messages WHERE tenant_id = $1', [T]);
    await pool?.query('DELETE FROM channels WHERE tenant_id = $1', [T]);
    await pool?.query('DELETE FROM audit_log WHERE tenant_id = $1', [T]);
    await pool?.query('DELETE FROM workflows WHERE tenant_id = $1', [T]);
    await pool?.query('DELETE FROM pessoas WHERE tenant_id = $1', [T]);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM outbox_messages WHERE tenant_id = $1', [T]);
    await pool.query('DELETE FROM channels WHERE tenant_id = $1', [T]);
    await pool.query('DELETE FROM audit_log WHERE tenant_id = $1', [T]);
    await pool.query('DELETE FROM workflows WHERE tenant_id = $1', [T]);
    await pool.query('DELETE FROM pessoas WHERE tenant_id = $1', [T]);
    const p = await pool.query<{ id: string }>(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo)
       VALUES ($1, $2, 'Solicitante', '+5511900000001', 'dono') RETURNING id`,
      [T, A],
    );
    pessoaId = p.rows[0]!.id;
    // UM canal ativo. `enqueueProactiveNotice` resolve o canal do agente e é
    // FAIL-CLOSED em ambiguidade — zero ou dois canais lançam `channel_ambiguous`.
    await pool.query(
      `INSERT INTO channels(tenant_id, agent_id, external_id, channel_type, active)
       VALUES ($1, $2, 'idual-canal', 'whatsapp', true)`,
      [T, A],
    );
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

  /** Quantos avisos de expiração deste workflow existem no ledger durável. */
  const avisosNoLedger = async (workflowId: string): Promise<number> => {
    const r = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM outbox_messages WHERE tenant_id = $1 AND dedup_key = $2',
      [T, `dual_approval:${workflowId}:expired`],
    );
    return Number(r.rows[0]!.n);
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

  it('dois ticks concorrentes vencem cada workflow UMA vez', async () => {
    // POR QUE QUINZE E NÃO UM.
    //
    // Com um workflow só, este caso era RACY na direção que importa: sem o CAS
    // ele ficava vermelho na primeira tentativa e VERDE na segunda, porque às
    // vezes o `listPending` do segundo tick já enxergava `cancelado` e pulava.
    // Um teste que só às vezes pega o defeito não é uma trava — e o banner da
    // suíte diz, com todas as letras, que "recuperado pela segunda tentativa"
    // não é verde.
    //
    // Com quinze, os dois ticks leem a lista inteira antes que qualquer um
    // termine de escrever: para o caso passar sem o CAS, TODOS os quinze
    // teriam de serializar na ordem exata, o que não acontece. A afirmação
    // continua sendo a mesma — cada workflow vence uma vez só.
    const ids: string[] = [];
    for (let k = 0; k < 15; k++) ids.push(await semearVencido());

    await rodarDoisTicks();

    // Defesa em profundidade no aviso: o CAS daqui MAIS o `idx_outbox_dedup`
    // do ledger. Um aviso por workflow.
    for (const id of ids) {
      const avisos = await avisosNoLedger(id);
      expect(avisos, `o solicitante teria recebido ${avisos} avisos de DA-${id.slice(0, 8)}`).toBe(1);
    }

    const st = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM workflows WHERE tenant_id = $1 AND status = 'cancelado'",
      [T],
    );
    expect(Number(st.rows[0]!.n)).toBe(15);

    // ESTA é a asserção que o CAS sozinho sustenta: `audit_log` não tem chave
    // de deduplicação, então dois ticks que ambos vencessem a mesma row
    // gravariam duas linhas. Auditoria dupla inventa dois fatos de um só.
    const au = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE tenant_id = $1 AND acao = 'dual_approval_timeout'`,
      [T],
    );
    expect(Number(au.rows[0]!.n), 'houve expiração auditada mais de uma vez').toBe(15);
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

    expect(await avisosNoLedger(w.rows[0]!.id)).toBe(0);
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
