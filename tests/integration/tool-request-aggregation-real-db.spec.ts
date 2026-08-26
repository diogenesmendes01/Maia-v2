/**
 * #637 (fatia B da épica #471) — A AGREGAÇÃO contra o banco real.
 *
 * As quatro afirmações que a issue exige, provadas onde elas podem falhar de
 * verdade (banco, escopo, FK, CHECK):
 *
 *   1. N pedidos parecidos viram UM pedido com contador — e o que NÃO acontece
 *      é uma segunda linha em `capability_proposals`;
 *   2. o limiar DISCRIMINA no caminho de produção: um pedido parecido funde, um
 *      pedido distinto-mas-de-palavras-parecidas NÃO funde;
 *   3. **isolamento entre tenants**: dois tenants com pedidos IDÊNTICOS têm
 *      contadores separados, e nenhum vê o agregado do outro;
 *   4. a fusão NÃO apaga evidência: o `proposed_spec` inteiro de cada membro
 *      fica em `original_spec`, e desfazer é `detached_at`, nunca `DELETE`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INVARIANTE ABSOLUTA, NUNCA DELTA — a armadilha do `retry: 1`
 * ─────────────────────────────────────────────────────────────────────────────
 * `vitest.config.ts` tem `retry: 1`. Uma asserção por DELTA (antes × depois)
 * sobre estado mutável fica verde na segunda tentativa, que herda a mutação
 * como linha de base, e o processo sai `falharam=0`.
 *
 * Por isso cada caso aqui usa gaps NOVOS (uuid do banco) e afirma o estado
 * ABSOLUTO do escopo que ele mesmo criou: "este agregado tem EXATAMENTE 2
 * membros ativos", "existe EXATAMENTE 1 proposta para estes 2 gaps". Uma
 * segunda tentativa recria o cenário do zero — a faxina roda no `finally` — e a
 * afirmação continua valendo ou não valendo por si só.
 *
 * NÃO É ESPELHO: chama `proposeToolRequestForGap` de produção, que é o mesmo
 * call site que o `gap-escalation-monitor` dispara.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T_A = 'wt637_agg_tenant_a';
const AG_A = 'wt637_agg_agent_a';
const T_B = 'wt637_agg_tenant_b';
const AG_B = 'wt637_agg_agent_b';

let pool: pg.Pool;

const proposer = moduloDeProducao(() => import('@/cognition/tool-request/proposer.js'));
const agregacao = moduloDeProducao(() => import('@/cognition/tool-request/aggregation.js'));

async function ensureTenantAgent(c: pg.PoolClient, tenant: string, agent: string) {
  await c.query('INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [
    tenant,
  ]);
  await c.query(
    'INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING',
    [agent, tenant],
  );
}

type Lixo = { gaps: string[] };
const novoLixo = (): Lixo => ({ gaps: [] });

/**
 * Faxina pelo GAP, que é o eixo confiável: as propostas e os agregados são
 * criados pelo código de PRODUÇÃO com ids que o teste não escolheu.
 *
 * Ordem obrigatória: membros → agregados → propostas → observações → gaps. O
 * agregado referencia a proposta representante SEM `ON DELETE CASCADE` (de
 * propósito — agrupamento não deve poder ser apagado de carona), então inverter
 * a ordem faz o DELETE das propostas falhar por FK.
 */
async function limpar(c: pg.PoolClient, l: Lixo) {
  if (l.gaps.length === 0) return;
  const g = [l.gaps];
  await c.query(
    'DELETE FROM tool_request_aggregate_members WHERE gap_id = ANY($1::uuid[])',
    g,
  );
  await c.query(
    `DELETE FROM tool_request_aggregates
      WHERE representative_gap_id = ANY($1::uuid[])`,
    g,
  );
  await c.query('DELETE FROM capability_proposals WHERE gap_id = ANY($1::uuid[])', g);
  await c.query(
    'DELETE FROM agent_capability_gap_observations WHERE gap_id = ANY($1::uuid[])',
    g,
  );
  await c.query('DELETE FROM agent_capability_gaps WHERE id = ANY($1::uuid[])', g);
}

async function mkGap(
  c: pg.PoolClient,
  args: {
    tenant: string;
    agent: string;
    descricao: string;
    args_tentados?: Record<string, unknown>;
    ocorrencias?: number;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO agent_capability_gaps
       (tenant_id, agent_id, capability_description, tipo, contexto,
        frequency_score, severity_score, current_level)
     VALUES ($1, $2, $3, 'tool', 'atendimento', 6, 5, 'proposed') RETURNING id`,
    [args.tenant, args.agent, args.descricao],
  );
  const gapId = r.rows[0]!.id;
  for (let i = 0; i < (args.ocorrencias ?? 1); i += 1) {
    await c.query(
      `INSERT INTO agent_capability_gap_observations
         (tenant_id, agent_id, gap_id, intent, attempted_args)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        args.tenant,
        args.agent,
        gapId,
        args.descricao,
        JSON.stringify(args.args_tentados ?? {}),
      ],
    );
  }
  return gapId;
}

/** Roda o call site de PRODUÇÃO sobre um gap, no escopo dado. */
async function pedir(c: pg.PoolClient, tenant: string, agent: string, gapId: string) {
  const gap = (await c.query('SELECT * FROM agent_capability_gaps WHERE id = $1', [gapId]))
    .rows[0];
  return runWithTenantContext({ tenant_id: tenant, agent_id: agent }, () =>
    proposer().proposeToolRequestForGap({ gap: gap as never }),
  );
}

async function contarPropostas(c: pg.PoolClient, gaps: string[]): Promise<number> {
  const r = await c.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM capability_proposals WHERE gap_id = ANY($1::uuid[])',
    [gaps],
  );
  return r.rows[0]!.n;
}

d('#637 — N pedidos parecidos viram UM pedido com contador', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await ensureTenantAgent(c, T_A, AG_A);
      await ensureTenantAgent(c, T_B, AG_B);
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  it('três pedidos parecidos → 1 proposta, contador 3, ocorrências somadas', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      // Mesmo pedido, três redações. Todas acima do limiar: ordem trocada,
      // moldura de queixa, palavra vazia a mais.
      const g1 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'emitir guia de recolhimento municipal',
        ocorrencias: 2,
      });
      const g2 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'guia de recolhimento municipal, emitir',
        ocorrencias: 3,
      });
      const g3 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'não consigo emitir a guia de recolhimento municipal',
        ocorrencias: 4,
      });
      lixo.gaps.push(g1, g2, g3);

      const r1 = await pedir(c, T_A, AG_A, g1);
      const r2 = await pedir(c, T_A, AG_A, g2);
      const r3 = await pedir(c, T_A, AG_A, g3);

      expect(r1.ok && r1.resultado).toBe('criado');
      expect(r2.ok && r2.resultado).toBe('agregado');
      expect(r3.ok && r3.resultado).toBe('agregado');
      if (!r1.ok || !r2.ok || !r3.ok) return;

      // O NÚCLEO DA ISSUE: três pedidos, UMA linha de proposta.
      expect(await contarPropostas(c, lixo.gaps)).toBe(1);
      expect(r2.proposal_id).toBe(r1.proposal_id);
      expect(r3.proposal_id).toBe(r1.proposal_id);
      expect(r2.aggregate_id).toBe(r1.aggregate_id);

      const agg = (
        await c.query(
          `SELECT member_count, total_occurrences, contract_state, tenant_id, agent_id
             FROM tool_request_aggregates WHERE id = $1`,
          [r1.aggregate_id],
        )
      ).rows[0] as {
        member_count: number;
        total_occurrences: number;
        contract_state: string;
        tenant_id: string;
        agent_id: string;
      };
      // Invariante ABSOLUTA: 3 membros, 9 ocorrências (2+3+4). Não um delta.
      expect(agg.member_count).toBe(3);
      expect(agg.total_occurrences).toBe(9);
      expect(agg.contract_state).toBe('consistent');
      expect(agg.tenant_id).toBe(T_A);
      expect(agg.agent_id).toBe(AG_A);
      // E a similaridade de cada fusão ficou GRAVADA: agrupamento sem o número
      // que o justificou é fato sem prova.
      expect(Number(r2.similaridade)).toBeGreaterThanOrEqual(0.85);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('rodar o mesmo gap duas vezes NÃO conta duas vezes (idempotência no dado)', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const g1 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'consultar protocolo de atendimento no portal do cliente',
      });
      lixo.gaps.push(g1);
      const primeira = await pedir(c, T_A, AG_A, g1);
      const segunda = await pedir(c, T_A, AG_A, g1);
      expect(primeira.ok && primeira.resultado).toBe('criado');
      expect(segunda.ok && segunda.resultado).toBe('ja_membro');
      expect(await contarPropostas(c, lixo.gaps)).toBe(1);
      if (!primeira.ok) return;
      const n = await c.query<{ n: number }>(
        `SELECT member_count AS n FROM tool_request_aggregates WHERE id = $1`,
        [primeira.aggregate_id],
      );
      expect(n.rows[0]!.n).toBe(1);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('funde com similaridade ESTRITAMENTE entre o limiar e 1 — a faixa é real', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      // Sem este caso, todas as fusões deste arquivo teriam score 1,0 e alguém
      // poderia concluir — com razão — que a agregação só faz casamento exato.
      // Aqui os conjuntos de token DIFEREM (um token a mais de um lado) e a
      // fusão acontece mesmo assim: 2·6/(6+7) = 0,923.
      const g1 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'exportar relatorio mensal consolidado de comissoes por vendedor ativo',
      });
      const g2 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'exportar relatorio mensal consolidado de comissoes por vendedor',
      });
      lixo.gaps.push(g1, g2);
      const r1 = await pedir(c, T_A, AG_A, g1);
      const r2 = await pedir(c, T_A, AG_A, g2);
      expect(r2.ok && r2.resultado).toBe('agregado');
      if (!r1.ok || !r2.ok) return;
      expect(Number(r2.similaridade)).toBeGreaterThan(0.85);
      expect(Number(r2.similaridade)).toBeLessThan(1);
      expect(await contarPropostas(c, lixo.gaps)).toBe(1);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('NÃO funde logo ABAIXO do limiar — a fronteira morde no caminho real', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      // 5 tokens em comum, 6 de cada lado: 2·5/12 = 0,833 — logo abaixo de 0,85,
      // que é exatamente onde o par negativo real que fixou o limiar
      // (`save_fact` × `save_rule`, 0,833) cai. Se este par fundisse, o limiar
      // não estaria valendo.
      const g1 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'conciliar extrato bancario mensal do contrato principal',
      });
      const g2 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'conciliar extrato bancario mensal do contrato secundario',
      });
      lixo.gaps.push(g1, g2);
      const r1 = await pedir(c, T_A, AG_A, g1);
      const r2 = await pedir(c, T_A, AG_A, g2);
      expect(r1.ok && r1.resultado).toBe('criado');
      expect(r2.ok && r2.resultado).toBe('criado');
      expect(await contarPropostas(c, lixo.gaps)).toBe(2);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('pedido DISTINTO com palavras parecidas NÃO funde — o limiar discrimina aqui também', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const g1 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'emitir guia de recolhimento municipal do imovel',
      });
      // Uma palavra troca a ferramenta. Se este par fundisse, o contador de um
      // pedido passaria a incluir demanda de outro — o erro caro.
      const g2 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'emitir guia de recolhimento estadual do imovel',
      });
      lixo.gaps.push(g1, g2);

      const r1 = await pedir(c, T_A, AG_A, g1);
      const r2 = await pedir(c, T_A, AG_A, g2);
      expect(r1.ok && r1.resultado).toBe('criado');
      expect(r2.ok && r2.resultado).toBe('criado');
      // DOIS pedidos, DUAS propostas, DOIS agregados de 1.
      expect(await contarPropostas(c, lixo.gaps)).toBe(2);
      if (!r1.ok || !r2.ok) return;
      expect(r1.aggregate_id).not.toBe(r2.aggregate_id);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });
});

d('#637 — LEAK: a demanda de um cliente não entra no contador de outro', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await ensureTenantAgent(c, T_A, AG_A);
      await ensureTenantAgent(c, T_B, AG_B);
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  it('pedidos IDÊNTICOS em dois tenants produzem dois agregados de 1, não um de 2', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      // Semeado adversarialmente: texto BYTE A BYTE igual. Se o escopo vazasse
      // em qualquer ponto (busca de candidato, leitura de membros, contador), o
      // segundo pedido fundiria no primeiro — e o sintoma seria só um número
      // maior, que é a forma mais difícil de notar um vazamento.
      const DESCRICAO = 'emitir segunda via de fatura consolidada do contrato';
      const gA = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: DESCRICAO,
        ocorrencias: 5,
      });
      const gB = await mkGap(c, {
        tenant: T_B,
        agent: AG_B,
        descricao: DESCRICAO,
        ocorrencias: 7,
      });
      lixo.gaps.push(gA, gB);

      const rA = await pedir(c, T_A, AG_A, gA);
      const rB = await pedir(c, T_B, AG_B, gB);

      expect(rA.ok && rA.resultado).toBe('criado');
      expect(rB.ok && rB.resultado).toBe('criado');
      if (!rA.ok || !rB.ok) return;
      expect(rA.aggregate_id).not.toBe(rB.aggregate_id);

      // ABSOLUTO: cada escopo tem o SEU agregado, com o SEU contador e as SUAS
      // ocorrências. Nada de "o de A não cresceu" (delta), que o retry salvaria.
      const linhas = (
        await c.query(
          `SELECT tenant_id, agent_id, member_count, total_occurrences
             FROM tool_request_aggregates
            WHERE id = ANY($1::uuid[]) ORDER BY tenant_id`,
          [[rA.aggregate_id, rB.aggregate_id]],
        )
      ).rows;
      expect(linhas).toEqual([
        { tenant_id: T_A, agent_id: AG_A, member_count: 1, total_occurrences: 5 },
        { tenant_id: T_B, agent_id: AG_B, member_count: 1, total_occurrences: 7 },
      ]);

      // E nenhum membro atravessou a fronteira: todo membro de cada agregado
      // está no escopo do seu agregado.
      const cruzados = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM tool_request_aggregate_members m
           JOIN tool_request_aggregates a ON a.id = m.aggregate_id
          WHERE (m.tenant_id <> a.tenant_id OR m.agent_id <> a.agent_id)`,
      );
      expect(cruzados.rows[0]!.n).toBe(0);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('o repositório não enxerga o agregado do outro tenant nem com o id na mão', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const gA = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'conciliar extrato bancario do periodo com os lancamentos',
      });
      lixo.gaps.push(gA);
      const rA = await pedir(c, T_A, AG_A, gA);
      expect(rA.ok).toBe(true);
      if (!rA.ok || !rA.aggregate_id) return;

      // `id` NUNCA é fronteira de isolamento (#367/#368): com o id de A na mão,
      // dentro do escopo de B, a leitura devolve NADA.
      const { toolRequestAggregatesRepo } = await import('@/db/repositories.js');
      const visto = await runWithTenantContext({ tenant_id: T_B, agent_id: AG_B }, () =>
        toolRequestAggregatesRepo.findById(rA.aggregate_id!),
      );
      expect(visto).toBeNull();

      // E a varredura de candidatos de B não traz o agregado de A.
      const candidatos = await runWithTenantContext({ tenant_id: T_B, agent_id: AG_B }, () =>
        toolRequestAggregatesRepo.candidatosParaFusao(1),
      );
      expect(candidatos.map((a) => a.id)).not.toContain(rA.aggregate_id);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });
});

d('#637 — a fusão não apaga a evidência, e é reversível', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await ensureTenantAgent(c, T_A, AG_A);
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  it('o membro fundido guarda o SPEC INTEIRO — intenção, situações, frequência, rascunho', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const g1 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'exportar relatorio consolidado de comissoes por vendedor',
        args_tentados: { periodo: '2026-08' },
        ocorrencias: 2,
      });
      const g2 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'relatorio consolidado de comissoes por vendedor, exportar',
        args_tentados: { periodo: '2026-09' },
        ocorrencias: 3,
      });
      lixo.gaps.push(g1, g2);

      await pedir(c, T_A, AG_A, g1);
      const r2 = await pedir(c, T_A, AG_A, g2);
      expect(r2.ok && r2.resultado).toBe('agregado');
      if (!r2.ok) return;

      const m = (
        await c.query(
          `SELECT gap_id, proposal_id, is_representative, original_spec, occurrences,
                  similaridade, metrica, limiar, assinatura_version
             FROM tool_request_aggregate_members WHERE id = $1`,
          [r2.member_id],
        )
      ).rows[0] as Record<string, unknown>;

      // O pedido fundido NÃO virou proposta — e é por isso que preservar o spec
      // aqui é a diferença entre agrupar e apagar.
      expect(m.proposal_id).toBeNull();
      expect(m.is_representative).toBe(false);
      expect(m.gap_id).toBe(g2);
      expect(Number(m.occurrences)).toBe(3);

      const spec = m.original_spec as Record<string, unknown>;
      expect(spec.gap_id).toBe(g2);
      expect(spec.intent).toBe('relatorio consolidado de comissoes por vendedor, exportar');
      expect((spec.situations as unknown[]).length).toBe(3);
      expect((spec.frequency as { occurrences: number }).occurrences).toBe(3);
      const rascunho = spec.contract_draft as { inputs: Array<{ name: string }> };
      expect(rascunho.inputs.map((i) => i.name)).toEqual(['periodo']);
      // A marcação de rascunho da fatia A sobreviveu à agregação — o CHECK
      // `tool_request_aggregate_members_draft_marking` também a exige.
      expect(spec.contract_status).toBe('draft_proposal_not_in_force');

      // E o gap original e suas observações continuam lá, intocados.
      const gapAinda = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM agent_capability_gaps WHERE id = $1',
        [g2],
      );
      expect(gapAinda.rows[0]!.n).toBe(1);
      const obs = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM agent_capability_gap_observations WHERE gap_id = $1',
        [g2],
      );
      expect(obs.rows[0]!.n).toBe(3);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('destacar tira do contador SEM apagar a linha, e o motivo fica registrado', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const g1 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'cadastrar apolice de seguro patrimonial da filial',
        ocorrencias: 2,
      });
      const g2 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'apolice de seguro patrimonial da filial, cadastrar',
        ocorrencias: 5,
      });
      lixo.gaps.push(g1, g2);
      const r1 = await pedir(c, T_A, AG_A, g1);
      const r2 = await pedir(c, T_A, AG_A, g2);
      expect(r2.ok && r2.resultado).toBe('agregado');
      if (!r1.ok || !r2.ok || !r2.member_id) return;

      const d1 = await runWithTenantContext({ tenant_id: T_A, agent_id: AG_A }, () =>
        agregacao().destacarDoAgregado({
          member_id: r2.member_id!,
          reason: 'a triagem decidiu que sao ferramentas diferentes',
          by: 'dono',
        }),
      );
      expect(d1.ok).toBe(true);

      // ABSOLUTO depois do destaque: contador 1, ocorrências 2 (só as do
      // representante), estado do contrato de volta a `single`.
      const agg = (
        await c.query(
          `SELECT member_count, total_occurrences, contract_state
             FROM tool_request_aggregates WHERE id = $1`,
          [r1.aggregate_id],
        )
      ).rows[0] as { member_count: number; total_occurrences: number; contract_state: string };
      expect(agg.member_count).toBe(1);
      expect(agg.total_occurrences).toBe(2);
      expect(agg.contract_state).toBe('single');

      // A LINHA CONTINUA. Destacar não apaga: o `original_spec` do pedido que
      // saiu ainda está lá, com o motivo e o autor do destaque.
      const m = (
        await c.query(
          `SELECT detached_at, detached_reason, detached_by, original_spec
             FROM tool_request_aggregate_members WHERE id = $1`,
          [r2.member_id],
        )
      ).rows[0] as Record<string, unknown>;
      expect(m.detached_at).not.toBeNull();
      expect(m.detached_reason).toBe('a triagem decidiu que sao ferramentas diferentes');
      expect(m.detached_by).toBe('dono');
      expect((m.original_spec as { intent: string }).intent).toBe(
        'apolice de seguro patrimonial da filial, cadastrar',
      );
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('o worker NÃO desfaz o destaque na rodada seguinte', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const g1 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'renegociar parcelamento tributario do contribuinte',
      });
      const g2 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'parcelamento tributario do contribuinte, renegociar',
      });
      lixo.gaps.push(g1, g2);
      const r1 = await pedir(c, T_A, AG_A, g1);
      const r2 = await pedir(c, T_A, AG_A, g2);
      if (!r1.ok || !r2.ok || !r2.member_id) return;
      await runWithTenantContext({ tenant_id: T_A, agent_id: AG_A }, () =>
        agregacao().destacarDoAgregado({ member_id: r2.member_id!, reason: 'nao e o mesmo' }),
      );

      // A próxima passada do cron sobre o MESMO gap. Sem a exclusão dos
      // agregados de onde ele já foi destacado, ele voltaria — e "reversível"
      // duraria até o próximo cron.
      const r3 = await pedir(c, T_A, AG_A, g2);
      expect(r3.ok && r3.resultado).toBe('criado');
      if (!r3.ok) return;
      expect(r3.aggregate_id).not.toBe(r1.aggregate_id);
      // Agora são DOIS pedidos separados, que é o que o humano decidiu.
      expect(await contarPropostas(c, lixo.gaps)).toBe(2);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('o representante NÃO pode ser destacado — o agregado ficaria órfão', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const g1 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'importar planilha de posicao de estoque do fornecedor',
      });
      lixo.gaps.push(g1);
      const r1 = await pedir(c, T_A, AG_A, g1);
      if (!r1.ok || !r1.member_id) return;
      const res = await runWithTenantContext({ tenant_id: T_A, agent_id: AG_A }, () =>
        agregacao().destacarDoAgregado({ member_id: r1.member_id!, reason: 'tentativa' }),
      );
      expect(res).toEqual({ ok: false, reason: 'e_representante' });
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });
});

d('#637 — contratos INCOMPATÍVEIS no caminho real: divergente, sem spec inventada', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await ensureTenantAgent(c, T_A, AG_A);
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  it('dois pedidos que fundem mas discordam do TIPO de um campo → `divergent`, sem rascunho', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      // Mesmo pedido pela assinatura; `competencia` string num, inteiro no
      // outro. É o caso que a issue nomeia: fundir os dois contratos produziria
      // uma spec que não descreve nenhum dos dois.
      const g1 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'transmitir declaracao acessoria mensal ao fisco',
        args_tentados: { competencia: '2026-08' },
      });
      const g2 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'declaracao acessoria mensal ao fisco, transmitir',
        args_tentados: { competencia: 202608 },
      });
      lixo.gaps.push(g1, g2);

      const r1 = await pedir(c, T_A, AG_A, g1);
      const r2 = await pedir(c, T_A, AG_A, g2);
      expect(r2.ok && r2.resultado).toBe('agregado');
      if (!r1.ok || !r2.ok) return;

      const agg = (
        await c.query(
          `SELECT member_count, contract_state, merged_contract_draft, contract_conflicts
             FROM tool_request_aggregates WHERE id = $1`,
          [r1.aggregate_id],
        )
      ).rows[0] as {
        member_count: number;
        contract_state: string;
        merged_contract_draft: unknown;
        contract_conflicts: Array<{ campo: string; lado: string; zods: string[] }>;
      };

      // O CONTADOR continua contando — a demanda é real.
      expect(agg.member_count).toBe(2);
      // O CONTRATO fica indefinido, e não há spec fundida. O CHECK
      // `tool_request_aggregates_divergent_has_no_draft` torna impossível
      // gravar `divergent` com um rascunho pendurado.
      expect(agg.contract_state).toBe('divergent');
      expect(agg.merged_contract_draft).toBeNull();
      // E o conflito é NOMEADO, não "os contratos divergem" e ponto.
      expect(agg.contract_conflicts).toHaveLength(1);
      expect(agg.contract_conflicts[0]!.campo).toBe('competencia');
      expect(agg.contract_conflicts[0]!.lado).toBe('input');
      expect(agg.contract_conflicts[0]!.zods.sort()).toEqual([
        'z.number().int()',
        'z.string()',
      ]);

      // OS DOIS rascunhos originais continuam legíveis, lado a lado.
      const membros = (
        await c.query(
          `SELECT original_spec FROM tool_request_aggregate_members
            WHERE aggregate_id = $1 AND detached_at IS NULL ORDER BY joined_at`,
          [r1.aggregate_id],
        )
      ).rows.map(
        (r) =>
          (r as { original_spec: { contract_draft: { inputs: Array<{ zod: string }> } } })
            .original_spec.contract_draft.inputs[0]!.zod,
      );
      expect(membros).toEqual(['z.string()', 'z.number().int()']);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('o banco RECUSA rascunho fundido SEM o marcador — inclusive a chave AUSENTE', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const g1 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'protocolar recurso administrativo junto ao orgao regulador',
      });
      lixo.gaps.push(g1);
      const r1 = await pedir(c, T_A, AG_A, g1);
      if (!r1.ok) return;

      // A CHAVE AUSENTE é o caso que quase escapou: `->>` de chave ausente dá
      // NULL, `NULL LIKE '…'` dá NULL, e um CHECK que dá NULL ACEITA a linha —
      // a mesma armadilha que a 125 documenta. A primeira redação deste CHECK
      // (com `IS NOT DISTINCT FROM FALSE`) tinha a polaridade invertida e
      // deixava passar; foi pego por sonda de psql, não por leitura.
      await expect(
        c.query(
          `UPDATE tool_request_aggregates
              SET merged_contract_draft = '{"proposed_tool_name":"x"}'::jsonb
            WHERE id = $1`,
          [r1.aggregate_id],
        ),
      ).rejects.toThrow(/tool_request_aggregates_draft_marking/);

      // E texto sem o marcador também é recusado.
      await expect(
        c.query(
          `UPDATE tool_request_aggregates
              SET merged_contract_draft = '{"zod_source":"const x = z.object({});"}'::jsonb
            WHERE id = $1`,
          [r1.aggregate_id],
        ),
      ).rejects.toThrow(/tool_request_aggregates_draft_marking/);

      // O que a produção grava PASSA — senão o CHECK estaria certo e inútil.
      const marcado = (
        await c.query<{ zod_source: string }>(
          `SELECT merged_contract_draft->>'zod_source' AS zod_source
             FROM tool_request_aggregates WHERE id = $1`,
          [r1.aggregate_id],
        )
      ).rows[0]!;
      expect(marcado.zod_source.startsWith('// PROPOSTA — NÃO É CONTRATO VIGENTE.')).toBe(
        true,
      );
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });

  it('o banco RECUSA gravar `divergent` com rascunho pendurado (defesa não-contornável)', async () => {
    const c = await pool.connect();
    const lixo = novoLixo();
    try {
      const g1 = await mkGap(c, {
        tenant: T_A,
        agent: AG_A,
        descricao: 'homologar nota de servico junto a prefeitura da capital',
      });
      lixo.gaps.push(g1);
      const r1 = await pedir(c, T_A, AG_A, g1);
      if (!r1.ok) return;
      // Vindo de um `psql`, sem passar por Zod nenhum: a política de fusão tem
      // metade no banco, exatamente como a marcação de rascunho da 125.
      await expect(
        c.query(
          `UPDATE tool_request_aggregates SET contract_state = 'divergent' WHERE id = $1`,
          [r1.aggregate_id],
        ),
      ).rejects.toThrow(/tool_request_aggregates_divergent_has_no_draft/);
    } finally {
      await limpar(c, lixo);
      c.release();
    }
  });
});
