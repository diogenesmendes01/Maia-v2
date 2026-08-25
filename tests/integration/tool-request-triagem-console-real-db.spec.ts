/**
 * #638 (fatia C da épica #471) — a TRIAGEM inteira, contra banco de verdade.
 *
 * O que este arquivo prova, em ordem:
 *
 *   1. **Escopo.** A triagem de um tenant não enxerga — nem age sobre — o
 *      pedido de outro. Dado semeado adversarialmente: pedidos IDÊNTICOS nos
 *      dois escopos.
 *   2. **Aceitar duas vezes cria UMA issue.** A decisão é da UNIQUE do banco, e
 *      o segundo aceite é auditado como duplicado em vez de sumir.
 *   3. **O console não recalcula.** O dado é QUEBRADO no banco e a rota muda
 *      junto — é assim que se prova que o número exibido vem de lá.
 *   4. **O relayer abre a issue, e um crash não abre a segunda.** A janela
 *      entre "a chamada sucedeu" e "o resultado foi gravado" é encenada.
 *   5. **O gap fecha por FATO.** Com a tool existente mas NÃO concedida, não
 *      fecha; com a tool concedida, fecha, avisa o agente e audita.
 *   6. **A ação de triagem é reversível.** Desagrupar não apaga evidência.
 *
 * Tudo passa pelos call sites de PRODUÇÃO: o router tRPC real, o worker real e
 * o proposer real da fatia A/B. O único dublê é o TRANSPORTE HTTP — a rede.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runWithTenantContext } from '@/db/tenant-context.js';
import * as repos from '@/db/repositories.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

/**
 * A integração precisa de destino e credencial. Os valores são deliberadamente
 * ÓBVIOS e de baixa entropia — eles não autenticam em nada e nunca saem deste
 * processo, porque o único transporte usado aqui é o dublê abaixo. Definidos no
 * escopo do módulo, ANTES de `moduloDeProducao` carregar `@/config/env.js` (que
 * lê `process.env` no import) e antes do primeiro `getEnv()` do console.
 */
process.env.MAIA_TOOL_REQUEST_ISSUE_REPO = 'org-fixture/repo-fixture';
process.env.MAIA_TOOL_REQUEST_GITHUB_TOKEN = 'aaaa-bbbb-cccc-dddd';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T_A = 'wt638_triagem_a';
const AG_A = 'wt638_agente_a';
const AG_A2 = 'wt638_agente_a2';
const T_B = 'wt638_triagem_b';
const AG_B = 'wt638_agente_b';

const REPO_SLUG = 'org-fixture/repo-fixture';

let pool: pg.Pool;

const proposer = moduloDeProducao(() => import('@/cognition/tool-request/proposer.js'));
const routerModulo = moduloDeProducao(() => import('@/admin-ui/trpc/routers/tool-requests.js'));
const worker = moduloDeProducao(() => import('@/workers/tool-request-triage.js'));
const corpoModulo = moduloDeProducao(() => import('@/cognition/tool-request/issue-body.js'));

/** O ctx tRPC de um dono autenticado. Mesma forma que `createTRPCContext` produz. */
function ctxDe(tenant: string, papel = 'owner') {
  return {
    session: { user: { id: 'dono-de-teste', role: papel, tenant_id: tenant } },
    userId: 'dono-de-teste',
    userRole: papel,
    tenantId: tenant,
    repos,
    assertTenant(alvo: string) {
      if (papel !== 'founder' && alvo !== tenant) throw new Error('Tenant isolation violation');
    },
    assertRole(...permitidos: string[]) {
      if (!permitidos.includes(papel)) throw new Error(`Role ${papel} não permitida`);
    },
  } as never;
}

const chamador = (tenant: string, papel = 'owner') =>
  routerModulo().toolRequestsRouter.createCaller(ctxDe(tenant, papel));

async function semear(c: pg.PoolClient, tenant: string, agent: string) {
  await c.query('INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [
    tenant,
  ]);
  await c.query(
    'INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING',
    [agent, tenant],
  );
  await c.query(
    `INSERT INTO agent_tool_grants (tenant_id, agent_id, granted_packs, granted_tools, denied_tools)
     VALUES ($1, $2, ARRAY['baseline.core'], ARRAY[]::text[], ARRAY[]::text[])
     ON CONFLICT (tenant_id, agent_id) DO UPDATE
       SET granted_packs = ARRAY['baseline.core'],
           granted_tools = ARRAY[]::text[],
           denied_tools  = ARRAY[]::text[]`,
    [tenant, agent],
  );
}

type Lixo = { gaps: string[] };
const novoLixo = (): Lixo => ({ gaps: [] });

/**
 * Faxina pelo GAP. Ordem obrigatória: avisos → issues → membros → agregados →
 * propostas → observações → gaps. O agregado referencia a proposta
 * representante SEM cascade, e `tool_request_issues` referencia o agregado —
 * inverter a ordem faz o DELETE falhar por FK e deixa resíduo que a rodada
 * seguinte leria como resultado.
 */
async function limpar(c: pg.PoolClient, l: Lixo) {
  if (l.gaps.length === 0) return;
  const g = [l.gaps];
  await c.query('DELETE FROM tool_request_notifications WHERE gap_id = ANY($1::uuid[])', g);
  await c.query(
    `DELETE FROM tool_request_issues
      WHERE aggregate_id IN (
        SELECT aggregate_id FROM tool_request_aggregate_members WHERE gap_id = ANY($1::uuid[])
      )`,
    g,
  );
  await c.query('DELETE FROM tool_request_aggregate_members WHERE gap_id = ANY($1::uuid[])', g);
  await c.query(
    'DELETE FROM tool_request_aggregates WHERE representative_gap_id = ANY($1::uuid[])',
    g,
  );
  await c.query('DELETE FROM capability_proposals WHERE gap_id = ANY($1::uuid[])', g);
  await c.query(
    'DELETE FROM agent_capability_gap_observations WHERE gap_id = ANY($1::uuid[])',
    g,
  );
  await c.query('DELETE FROM agent_capability_gaps WHERE id = ANY($1::uuid[])', g);
}

/** Cria o gap + observações e roda o proposer REAL, devolvendo o agregado. */
async function pedidoReal(
  c: pg.PoolClient,
  args: { tenant: string; agent: string; descricao: string; lixo: Lixo },
): Promise<{ gapId: string; aggregateId: string }> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO agent_capability_gaps
       (tenant_id, agent_id, capability_description, tipo, contexto,
        frequency_score, severity_score, current_level)
     VALUES ($1, $2, $3, 'tool', 'atendimento', 6, 5, 'proposed') RETURNING id`,
    [args.tenant, args.agent, args.descricao],
  );
  const gapId = r.rows[0]!.id;
  args.lixo.gaps.push(gapId);
  await c.query(
    `INSERT INTO agent_capability_gap_observations
       (tenant_id, agent_id, gap_id, intent, attempted_args)
     VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
    [args.tenant, args.agent, gapId, args.descricao],
  );
  const gap = (await c.query('SELECT * FROM agent_capability_gaps WHERE id = $1', [gapId]))
    .rows[0];
  const resultado = await runWithTenantContext(
    { tenant_id: args.tenant, agent_id: args.agent },
    () => proposer().proposeToolRequestForGap({ gap: gap as never }),
  );
  if (!resultado.ok || !resultado.aggregate_id) {
    throw new Error(`o proposer não criou agregado: ${JSON.stringify(resultado)}`);
  }
  return { gapId, aggregateId: resultado.aggregate_id };
}

/** Transporte falso: registra chamadas e devolve respostas roteirizadas. */
function transporteFalso(por: (url: string, method: string) => { status: number; corpo: string }) {
  const chamadas: Array<{ url: string; method: string; body?: string }> = [];
  const transporte = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => {
    chamadas.push({ url, method: init.method, body: init.body });
    const r = por(url, init.method);
    return { status: r.status, ok: r.status < 300, text: async () => r.corpo };
  };
  return { transporte, chamadas };
}

async function contarAuditoria(c: pg.PoolClient, acao: string, alvo: string): Promise<number> {
  const r = await c.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM audit_log WHERE acao = $1 AND alvo_id = $2',
    [acao, alvo],
  );
  return r.rows[0]!.n;
}

d('#638 — triagem no console: escopo, idempotência e leitura do backend', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await semear(c, T_A, AG_A);
      // Segundo agente NO MESMO tenant: sem ele, o eixo `agent_id` do escopo
      // ficaria não testado — dois tenants diferentes têm agentes diferentes, e
      // o filtro por agente sozinho já os separaria (ver o comentário na sonda).
      await semear(c, T_A, AG_A2);
      await semear(c, T_B, AG_B);
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  it('SONDA 1 — a triagem de um tenant NÃO enxerga nem toca o pedido do outro', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      // Dado adversarial: a MESMA descrição nos dois escopos. Se o escopo
      // vazasse, os dois pedidos apareceriam nas duas listas.
      const descricao = 'emitir guia de recolhimento no portal municipal';
      const a = await pedidoReal(c, { tenant: T_A, agent: AG_A, descricao, lixo });
      const b = await pedidoReal(c, { tenant: T_B, agent: AG_B, descricao, lixo });
      expect(a.aggregateId).not.toBe(b.aggregateId);

      // O MESMO pedido num SEGUNDO AGENTE do MESMO tenant. Este é o par que
      // testa o eixo `agent_id`: entre T_A e T_B os agentes também diferem, e
      // por isso um filtro que só olhasse `agent_id` continuaria separando os
      // dois — a asserção cruzada abaixo é a que morde de verdade.
      const a2 = await pedidoReal(c, { tenant: T_A, agent: AG_A2, descricao, lixo });
      expect(a2.aggregateId).not.toBe(a.aggregateId);

      const listaA = await chamador(T_A).list({ tenantId: T_A, agentId: AG_A });
      const listaA2 = await chamador(T_A).list({ tenantId: T_A, agentId: AG_A2 });
      const listaB = await chamador(T_B).list({ tenantId: T_B, agentId: AG_B });

      expect(listaA.items.map((i) => i.aggregate_id)).toContain(a.aggregateId);
      expect(listaA.items.map((i) => i.aggregate_id)).not.toContain(b.aggregateId);
      expect(listaA.items.map((i) => i.aggregate_id)).not.toContain(a2.aggregateId);
      expect(listaA2.items.map((i) => i.aggregate_id)).toContain(a2.aggregateId);
      expect(listaA2.items.map((i) => i.aggregate_id)).not.toContain(a.aggregateId);
      expect(listaB.items.map((i) => i.aggregate_id)).toContain(b.aggregateId);
      expect(listaB.items.map((i) => i.aggregate_id)).not.toContain(a.aggregateId);

      // E o id vazado do outro escopo não colhe linha: `id` NUNCA é fronteira
      // de isolamento (#367/#368). Aceitar o pedido de A "de dentro" de B é
      // NOT_FOUND, não um aceite silencioso no escopo errado.
      await expect(
        chamador(T_B).aceitar({ tenantId: T_B, agentId: AG_B, aggregateId: a.aggregateId }),
      ).rejects.toThrow(/n[ãa]o encontrado|agregado_nao_encontrado/i);

      const n = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM tool_request_issues WHERE aggregate_id = $1',
        [a.aggregateId],
      );
      expect(n.rows[0]!.n, 'o aceite cruzado criou linha no escopo alheio').toBe(0);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('SONDA 2 — aceitar DUAS vezes o mesmo pedido cria UMA issue', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const { aggregateId } = await pedidoReal(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'conciliar extrato bancario com lancamentos do mes',
        lixo,
      });

      const primeiro = await chamador(T_A).aceitar({
        tenantId: T_A,
        agentId: AG_A,
        aggregateId,
      });
      const segundo = await chamador(T_A).aceitar({
        tenantId: T_A,
        agentId: AG_A,
        aggregateId,
      });

      expect(primeiro.resultado).toBe('aceito');
      expect(segundo.resultado).toBe('ja_aceito');

      // INVARIANTE ABSOLUTA, não delta: existe EXATAMENTE uma linha para este
      // agregado. Uma asserção por diferença (antes×depois) ficaria verde na
      // segunda tentativa do vitest, que herdaria a linha da primeira.
      const linhas = await c.query<{ n: number; status: string }>(
        `SELECT count(*)::int AS n, min(status) AS status
           FROM tool_request_issues WHERE aggregate_id = $1`,
        [aggregateId],
      );
      expect(linhas.rows[0]!.n).toBe(1);
      expect(linhas.rows[0]!.status).toBe('pending');

      // O segundo clique é AUDITADO como duplicado — um aceite sem efeito não
      // pode ser indistinguível de um aceite que nunca chegou.
      const id = (
        await c.query<{ id: string }>(
          'SELECT id FROM tool_request_issues WHERE aggregate_id = $1',
          [aggregateId],
        )
      ).rows[0]!.id;
      expect(await contarAuditoria(c, 'tool_request_accepted', id)).toBe(1);
      expect(await contarAuditoria(c, 'tool_request_accept_duplicado', id)).toBe(1);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('SONDA 3 — o console NÃO recalcula: quebrar o dado no banco muda a rota', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const { aggregateId } = await pedidoReal(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'gerar demonstrativo de impostos retidos por fornecedor',
        lixo,
      });

      const antes = (await chamador(T_A).list({ tenantId: T_A, agentId: AG_A })).items.find(
        (i) => i.aggregate_id === aggregateId,
      )!;
      expect(antes.member_count).toBe(1);
      expect(antes.contract_state).toBe('single');

      // A QUEBRA: números que NENHUM cálculo do front produziria a partir de um
      // agregado de um membro. Se a rota recalculasse, ela discordaria daqui.
      await c.query(
        `UPDATE tool_request_aggregates
            SET member_count = 42, total_occurrences = 777,
                contract_state = 'divergent', merged_contract_draft = NULL,
                contract_conflicts = '[{"campo":"plantado"}]'::jsonb
          WHERE id = $1`,
        [aggregateId],
      );

      const depois = (await chamador(T_A).list({ tenantId: T_A, agentId: AG_A })).items.find(
        (i) => i.aggregate_id === aggregateId,
      )!;
      expect(depois.member_count).toBe(42);
      expect(depois.total_occurrences).toBe(777);
      expect(depois.contract_state).toBe('divergent');
      expect(depois.merged_contract_draft).toBeNull();
      expect(JSON.stringify(depois.contract_conflicts)).toContain('plantado');
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('o CORPO da issue é gravado no aceite e carrega o marcador determinístico', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const { aggregateId } = await pedidoReal(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'baixar arquivo de retorno do banco e conciliar',
        lixo,
      });
      await chamador(T_A).aceitar({ tenantId: T_A, agentId: AG_A, aggregateId });

      const linha = (
        await c.query<{ body: string; title: string; idempotency_key: string }>(
          'SELECT body, title, idempotency_key FROM tool_request_issues WHERE aggregate_id = $1',
          [aggregateId],
        )
      ).rows[0]!;

      const { chaveDeIdempotencia, corpoTemMarcador } = corpoModulo();
      expect(linha.idempotency_key).toBe(
        chaveDeIdempotencia({ tenant_id: T_A, agent_id: AG_A, aggregate_id: aggregateId }),
      );
      expect(corpoTemMarcador(linha.body, linha.idempotency_key)).toBe(true);
      expect(linha.body).toContain('o agente especifica; humano implementa e instala');
      // E o escopo NÃO aparece em texto claro — a issue pode ser pública.
      expect(linha.body).not.toContain(T_A);
      expect(linha.body).not.toContain(AG_A);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('SONDA 4 — o relayer abre a issue, e um CRASH não abre a segunda', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const { aggregateId } = await pedidoReal(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'protocolar peticao no sistema do tribunal estadual',
        lixo,
      });
      await chamador(T_A).aceitar({ tenantId: T_A, agentId: AG_A, aggregateId });
      const linhaId = (
        await c.query<{ id: string; idempotency_key: string; body: string }>(
          'SELECT id, idempotency_key, body FROM tool_request_issues WHERE aggregate_id = $1',
          [aggregateId],
        )
      ).rows[0]!;

      // Primeira passada: a busca não acha nada, a criação sucede.
      const primeira = transporteFalso((_url, method) =>
        method === 'GET'
          ? { status: 200, corpo: '[]' }
          : { status: 201, corpo: JSON.stringify({ number: 4242, html_url: 'https://ex/4242' }) },
      );
      await worker().runToolRequestIssueRelayer({ transporte: primeira.transporte });

      const criada = (
        await c.query<{ status: string; issue_number: number; adopted: boolean }>(
          'SELECT status, issue_number, adopted FROM tool_request_issues WHERE id = $1',
          [linhaId.id],
        )
      ).rows[0]!;
      expect(criada.status).toBe('created');
      expect(criada.issue_number).toBe(4242);
      expect(criada.adopted).toBe(false);
      expect(await contarAuditoria(c, 'tool_request_issue_created', linhaId.id)).toBe(1);

      // A JANELA DE CRASH, encenada: a chamada sucedeu lá fora, mas o processo
      // morreu antes de gravar. A linha volta a `pending` e a issue EXISTE.
      await c.query(
        `UPDATE tool_request_issues
            SET status = 'pending', issue_number = NULL, issue_url = NULL, adopted = false
          WHERE id = $1`,
        [linhaId.id],
      );

      const segunda = transporteFalso((_url, method) =>
        method === 'GET'
          ? {
              status: 200,
              corpo: JSON.stringify([
                { number: 4242, html_url: 'https://ex/4242', body: linhaId.body },
              ]),
            }
          : { status: 201, corpo: JSON.stringify({ number: 9999, html_url: 'https://ex/9999' }) },
      );
      await worker().runToolRequestIssueRelayer({ transporte: segunda.transporte });

      // NENHUM POST: a issue foi RECONHECIDA pelo marcador, não recriada.
      expect(segunda.chamadas.filter((x) => x.method === 'POST')).toHaveLength(0);
      const readotada = (
        await c.query<{ status: string; issue_number: number; adopted: boolean }>(
          'SELECT status, issue_number, adopted FROM tool_request_issues WHERE id = $1',
          [linhaId.id],
        )
      ).rows[0]!;
      expect(readotada.status).toBe('created');
      expect(readotada.issue_number).toBe(4242);
      expect(readotada.adopted).toBe(true);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('uma falha TERMINAL do GitHub vira `failed` auditado; recuperável volta para a fila', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const { aggregateId } = await pedidoReal(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'assinar documento digitalmente com certificado do escritorio',
        lixo,
      });
      await chamador(T_A).aceitar({ tenantId: T_A, agentId: AG_A, aggregateId });
      const linhaId = (
        await c.query<{ id: string }>(
          'SELECT id FROM tool_request_issues WHERE aggregate_id = $1',
          [aggregateId],
        )
      ).rows[0]!.id;

      // 503: recuperável. A linha continua `pending`, com a tentativa contada.
      const instavel = transporteFalso(() => ({ status: 503, corpo: 'indisponivel' }));
      await worker().runToolRequestIssueRelayer({ transporte: instavel.transporte });
      const aindaNaFila = (
        await c.query<{ status: string; attempts: number; last_error: string }>(
          'SELECT status, attempts, last_error FROM tool_request_issues WHERE id = $1',
          [linhaId],
        )
      ).rows[0]!;
      expect(aindaNaFila.status).toBe('pending');
      expect(aindaNaFila.attempts).toBe(1);
      expect(aindaNaFila.last_error).toContain('503');
      expect(await contarAuditoria(c, 'tool_request_issue_failed', linhaId)).toBe(0);

      // 404: terminal. Retentar não muda o desfecho, então a linha sai da fila.
      const inexistente = transporteFalso(() => ({ status: 404, corpo: '{"message":"Not Found"}' }));
      await worker().runToolRequestIssueRelayer({ transporte: inexistente.transporte });
      const terminal = (
        await c.query<{ status: string; issue_number: number | null }>(
          'SELECT status, issue_number FROM tool_request_issues WHERE id = $1',
          [linhaId],
        )
      ).rows[0]!;
      expect(terminal.status).toBe('failed');
      expect(terminal.issue_number).toBeNull();
      expect(await contarAuditoria(c, 'tool_request_issue_failed', linhaId)).toBe(1);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('SONDA 5 — o gap fecha pelo estado REAL: existe no código E está concedida', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      // COMO ESTE CENÁRIO É MONTADO, e por que ele não pode ser montado de
      // outro jeito.
      //
      // O fechamento acontece quando a ferramenta PEDIDA passa a existir. No
      // repositório committado não há — nem pode haver — uma tool com o nome de
      // um pedido ainda não implementado: a fatia A recusa gerar pedido quando
      // a tool já existe (`tool_ja_existe`), e inventar uma tool no registro
      // seria exatamente o que o guardrail proíbe. (A primeira versão deste
      // caso usava uma descrição contendo `query balance` e ficou VERMELHA no
      // proposer, com `tool_ja_existe` — foi assim que a limitação apareceu.)
      //
      // A montagem honesta: o pedido nasce normal, e simula-se o dev tendo
      // implementado a ferramenta COM O NOME QUE A ISSUE SUGERIU — gravando um
      // nome de tool REAL em `nomes_propostos`. `query_balance` existe no
      // registro e NÃO está em `baseline.core`, que é o par exato que separa
      // "existe no código" de "está disponível para este agente".
      const { gapId, aggregateId } = await pedidoReal(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'emitir demonstrativo consolidado da carteira do cliente',
        lixo,
      });
      await c.query(
        `UPDATE tool_request_aggregates
            SET nomes_propostos = '["query_balance"]'::jsonb WHERE id = $1`,
        [aggregateId],
      );

      // Metade 1: a tool existe no código, mas o agente NÃO a tem. Não fecha.
      await worker().runToolRequestClosureMonitor();
      const aberto = (
        await c.query<{ resolved_at: Date | null }>(
          'SELECT resolved_at FROM agent_capability_gaps WHERE id = $1',
          [gapId],
        )
      ).rows[0]!;
      expect(
        aberto.resolved_at,
        'fechou sem a tool estar concedida — "existe no repositório" não é "disponível para este agente"',
      ).toBeNull();

      // Metade 2: um humano concede a tool (o caminho normal). Agora fecha.
      await c.query(
        `UPDATE agent_tool_grants SET granted_tools = ARRAY['query_balance']
          WHERE tenant_id = $1 AND agent_id = $2`,
        [T_A, AG_A],
      );
      await worker().runToolRequestClosureMonitor();

      const fechado = (
        await c.query<{
          resolved_at: Date | null;
          resolved_reason: string | null;
          resolved_tool_name: string | null;
          current_level: string;
        }>(
          `SELECT resolved_at, resolved_reason, resolved_tool_name, current_level
             FROM agent_capability_gaps WHERE id = $1`,
          [gapId],
        )
      ).rows[0]!;
      expect(fechado.resolved_at).not.toBeNull();
      expect(fechado.resolved_tool_name).toBe('query_balance');
      expect(fechado.resolved_reason).toContain('concedida');
      // O NÍVEL não é tocado: a história da escalada é a evidência do pedido.
      expect(fechado.current_level).toBe('proposed');

      // O AVISO ao agente existe como linha, e foi auditado.
      const aviso = (
        await c.query<{ id: string; tool_name: string; aggregate_id: string | null }>(
          'SELECT id, tool_name, aggregate_id FROM tool_request_notifications WHERE gap_id = $1',
          [gapId],
        )
      ).rows;
      expect(aviso).toHaveLength(1);
      expect(aviso[0]!.tool_name).toBe('query_balance');
      // O aviso aponta para o AGREGADO que originou o pedido — é o que liga o
      // laço inteiro (pedido → issue → tool → gap fechado → agente avisado).
      expect(aviso[0]!.aggregate_id).toBe(aggregateId);
      expect(await contarAuditoria(c, 'tool_request_gap_closed', gapId)).toBe(1);
      expect(await contarAuditoria(c, 'tool_request_agent_notified', aviso[0]!.id)).toBe(1);

      // IDEMPOTÊNCIA sob cron: a terceira passada não reavisa nem reaudita.
      await worker().runToolRequestClosureMonitor();
      const depois = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM tool_request_notifications WHERE gap_id = $1',
        [gapId],
      );
      expect(depois.rows[0]!.n).toBe(1);
      expect(await contarAuditoria(c, 'tool_request_gap_closed', gapId)).toBe(1);

      // E o gap fechado sai da leitura de gaps ABERTOS do turno.
      const abertos = await runWithTenantContext({ tenant_id: T_A, agent_id: AG_A }, () =>
        repos.capabilityGapsRepo.listByLevels(['proposed' as never]),
      );
      expect(abertos.map((g) => g.id)).not.toContain(gapId);

      // Mas continua na leitura do TURNO, como capacidade recém-adquirida.
      const doTurno = await runWithTenantContext({ tenant_id: T_A, agent_id: AG_A }, () =>
        repos.capabilityGapsRepo.listParaOTurno(['proposed' as never], 7),
      );
      expect(doTurno.map((g) => g.id)).toContain(gapId);
    } finally {
      await c.query(
        `UPDATE agent_tool_grants SET granted_tools = ARRAY[]::text[]
          WHERE tenant_id = $1 AND agent_id = $2`,
        [T_A, AG_A],
      );
      await limpar(c, lixo);
      c.release();
    }
  });

  it('SONDA 6 — desagrupar é reversível e NÃO apaga a evidência do pedido', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const base = 'emitir certidao negativa de debitos municipais';
      const primeiro = await pedidoReal(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: base,
        lixo,
      });
      // Mesma redação ⇒ funde (limiar 0,85 sobre tokens idênticos).
      const segundo = await pedidoReal(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: base,
        lixo,
      });
      expect(segundo.aggregateId).toBe(primeiro.aggregateId);

      const detalhe = await chamador(T_A).detail({
        tenantId: T_A,
        agentId: AG_A,
        aggregateId: primeiro.aggregateId,
      });
      expect(detalhe.membros).toHaveLength(2);
      const naoRepresentante = detalhe.membros.find((m) => !m.is_representative)!;

      const r = await chamador(T_A).desagrupar({
        tenantId: T_A,
        agentId: AG_A,
        memberId: naoRepresentante.member_id,
        motivo: 'pedidos diferentes apesar da redacao parecida',
      });
      expect(r.member_count).toBe(1);

      // A EVIDÊNCIA continua: a linha existe, com `detached_at`, motivo, autor
      // e o `original_spec` inteiro. `DELETE` teria apagado o pedido, não o
      // agrupamento.
      const membro = (
        await c.query<{
          detached_at: Date | null;
          detached_reason: string | null;
          detached_by: string | null;
          original_spec: unknown;
        }>(
          `SELECT detached_at, detached_reason, detached_by, original_spec
             FROM tool_request_aggregate_members WHERE id = $1`,
          [naoRepresentante.member_id],
        )
      ).rows[0]!;
      expect(membro.detached_at).not.toBeNull();
      expect(membro.detached_reason).toContain('redacao parecida');
      expect(membro.detached_by).toBe('dono-de-teste');
      expect(JSON.stringify(membro.original_spec)).toContain('draft_proposal_not_in_force');

      // E o desagrupamento é auditado.
      expect(
        await contarAuditoria(c, 'tool_request_aggregate_detached', naoRepresentante.member_id),
      ).toBe(1);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('um papel sem permissão NÃO aceita nem desagrupa', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const { aggregateId } = await pedidoReal(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'agendar visita tecnica no sistema da concessionaria',
        lixo,
      });
      await expect(
        chamador(T_A, 'analyst').aceitar({ tenantId: T_A, agentId: AG_A, aggregateId }),
      ).rejects.toThrow(/n[ãa]o permitida/i);
      const n = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM tool_request_issues WHERE aggregate_id = $1',
        [aggregateId],
      );
      expect(n.rows[0]!.n).toBe(0);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });
});
