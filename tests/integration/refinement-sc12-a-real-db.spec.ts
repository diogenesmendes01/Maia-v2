/**
 * SC12-A — caracterização dos writers/leitores operacionais de fato em banco EXCLUSIVO.
 *
 * ─── O que este arquivo é ────────────────────────────────────────────────────
 *
 * A fatia SC12-A NÃO altera schema, migration nem `src/`: ela caracteriza, contra
 * um Postgres REAL, o contrato que a decisão D08 precisa preservar ao introduzir
 * revisões governadas. O texto do ADR (`docs/architecture/decisions/
 * ADR-D08-proposal.md`) cita estes cenários; quem prova são as asserções abaixo,
 * lendo rows reais.
 *
 * ─── Por que banco real, e não double ───────────────────────────────────────
 *
 * `factsRepo.upsert` / `upsertCostFact` / `knowledgeRepos.create` são contratos de
 * STATEMENT, não de fachada: o que se caracteriza é o comportamento do
 * `ON CONFLICT (tenant_id, agent_id, escopo, chave)` e do INSERT simples sob a
 * unique existente. Um mock de `db` afirmaria a SQL que o teste escreveu, não a
 * que o Postgres executa com a constraint de verdade. A única fronteira dobrada
 * aqui é o provedor de embedding (rede externa, proibida em teste); o predicado
 * de recall roda no SQL contra o banco real.
 *
 * ─── Achados que o teste registra (não são "aprovações") ────────────────────
 *
 *  1. Duas somas concorrentes no mesmo fato de custo NÃO se perdem: o total
 *     global e o por pessoa acumulam exatamente os deltas das duas rodadas.
 *  2. A escrita de custo falha FECHADA sem contexto ALS, e um segundo
 *     tenant/agente não enxerga nem altera a linha do primeiro.
 *  3. O upsert operacional REPLACE o valor da chave (last-writer-wins, uma
 *     linha); não há histórico — que é exatamente o que SC12-B precisa
 *     acrescentar sem tocar nesta unique.
 *  4. A segunda proposta de fato com a MESMA chave lógica pelo KSM estoura a
 *     unique atual (23505) e a primeira row permanece com o conteúdo original:
 *     o contrato atual não comporta revisões.
 *  5. O caminho de RECALL (semântico) não devolve o agregado `cost.daily.llm.*`:
 *     o fato de custo não tem item canônico em `memory_entry` nem vetor, então o
 *     JOIN do predicado o exclui. A leitura legada de fatos
 *     (`factsRepo.listForScopes(['global'])`) CONTINUA devolvendo o agregado —
 *     exposição interna registrada para a whitelist operacional de D08, fora do
 *     caminho de recall. Zero itens de custo no recall; exposição na fatia de
 *     prompt de fatos declarada, não mascarada.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DIMENSOES_EMBEDDING = 1024;

/**
 * Double determinístico do provedor de embedding.
 *
 * A fronteira é externa (Voyage/OpenAI/Cohere) e o ambiente deste card não
 * sai para provedor real. O que o double remove é o HTTP; o que ele NÃO remove
 * é a parte que importa: `recallAuthorized` continua buscando por
 * `embedding <=> $::vector` no Postgres real, com a FK composta da 146 valendo.
 */
vi.mock('@/lib/embeddings.js', () => ({
  getEmbeddingProvider: () => ({
    name: 'voyage',
    modelId: 'sc12a-test-double',
    dimensions: 1024,
    embed: async (texts: string[]) =>
      texts.map(() => Array.from({ length: 1024 }, () => 0.01)),
  }),
}));

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const RUN_ID = randomUUID().slice(0, 8);
const TENANT_A = `sc12a-characterization-a-${RUN_ID}`;
const AGENT_A = `sc12a-agent-a-${RUN_ID}`;
const TENANT_B = `sc12a-characterization-b-${RUN_ID}`;
const AGENT_B = `sc12a-agent-b-${RUN_ID}`;
const PESSOA_A = randomUUID();
const CONVERSA_A = randomUUID();

/** Modelo da tabela de preços embutida: não passa por OpenRouter (sem rede). */
const MODELO = 'claude-haiku-4-5-20251001';
const CUSTO_POR_1K = { input: 0.08, output: 0.4 };

const DIA = new Date().toISOString().slice(0, 10);
const CHAVE_GLOBAL = `cost.daily.llm.${DIA}`;
const CHAVE_PESSOA = `cost.daily.llm.${DIA}.${PESSOA_A}`;

const ctxA = { tenant_id: TENANT_A, agent_id: AGENT_A };
const ctxB = { tenant_id: TENANT_B, agent_id: AGENT_B };

type ValorCusto = {
  tokens_input?: number;
  tokens_output?: number;
  usd_cents?: number;
  provider?: string;
  last_model?: string;
};

let pool: pg.Pool;

/** Deltas exatos em centavos: a ordem das duas chamadas concorrentes não muda o total. */
const DELTAS = [
  { tokens_input: 1000, tokens_output: 500 },
  { tokens_input: 3000, tokens_output: 1000 },
];

function centavos(delta: { tokens_input: number; tokens_output: number }): number {
  return (
    (delta.tokens_input / 1000) * CUSTO_POR_1K.input +
    (delta.tokens_output / 1000) * CUSTO_POR_1K.output
  );
}

const TOTAL_TOKENS_INPUT = DELTAS.reduce((a, x) => a + x.tokens_input, 0) * 2;
const TOTAL_TOKENS_OUTPUT = DELTAS.reduce((a, x) => a + x.tokens_output, 0) * 2;
const TOTAL_CENTAVOS = Math.round(DELTAS.reduce((a, x) => a + centavos(x), 0) * 2 * 100) / 100;

d('SC12-A — caracterização dos writers operacionais em DB exclusivo', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    for (const [tenant, agent] of [
      [TENANT_A, AGENT_A],
      [TENANT_B, AGENT_B],
    ]) {
      await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
        tenant,
      ]);
      await pool.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1)
         ON CONFLICT (id) DO NOTHING`,
        [agent, tenant],
      );
    }
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM agent_memories WHERE tenant_id = $1`, [TENANT_A]);
    await pool.query(`DELETE FROM memory_entry WHERE tenant_id = $1`, [TENANT_A]);
    await pool.query(`DELETE FROM agent_facts WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
    await pool.query(`DELETE FROM agents WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
    await pool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]);
    await pool.end();
  });

  it('AC03-a — duas somas concorrentes acumulam global e pessoa sem perder update', async () => {
    const { recordLLMCost, readDailyLLMUsd, readDailyLLMUsdByPessoa } = await import(
      '@/lib/cost-ledger.js'
    );
    const { factsRepo } = await import('@/db/repositories.js');
    const { runWithTenantContext } = await import('@/db/tenant-context.js');

    // Duas rodadas de duas chamadas CONCORRENTES sobre a MESMA chave. É o
    // cenário que o read-modify-write em JS perdia (issue #508): cada rodada
    // disputa a linha travada pelo próprio ON CONFLICT.
    for (let rodada = 0; rodada < 2; rodada++) {
      await runWithTenantContext(ctxA, async () => {
        await Promise.all(
          DELTAS.map((delta) =>
            recordLLMCost({ provider: 'anthropic', model: MODELO, pessoa_id: PESSOA_A, ...delta }),
          ),
        );
      });
    }

    const global = await runWithTenantContext(ctxA, () => factsRepo.getByKey('global', CHAVE_GLOBAL));
    const pessoa = await runWithTenantContext(ctxA, () => factsRepo.getByKey('pessoa', CHAVE_PESSOA));

    expect(global, 'fato global do dia não existe — a soma concorrente se perdeu').not.toBeNull();
    expect(pessoa, 'fato por pessoa do dia não existe — a soma concorrente se perdeu').not.toBeNull();

    const valorGlobal = global!.valor as ValorCusto;
    const valorPessoa = pessoa!.valor as ValorCusto;

    expect(valorGlobal.tokens_input).toBe(TOTAL_TOKENS_INPUT);
    expect(valorGlobal.tokens_output).toBe(TOTAL_TOKENS_OUTPUT);
    expect(Number(valorGlobal.usd_cents)).toBe(TOTAL_CENTAVOS);
    expect(valorPessoa.tokens_input).toBe(TOTAL_TOKENS_INPUT);
    expect(valorPessoa.tokens_output).toBe(TOTAL_TOKENS_OUTPUT);
    expect(Number(valorPessoa.usd_cents)).toBe(TOTAL_CENTAVOS);

    // Leitura pelos readers operacionais (contrato cents→USD do ledger).
    const usdGlobal = await runWithTenantContext(ctxA, () => readDailyLLMUsd(DIA));
    const usdPessoa = await runWithTenantContext(ctxA, () => readDailyLLMUsdByPessoa(PESSOA_A, DIA));
    expect(usdGlobal).toBeCloseTo(TOTAL_CENTAVOS / 100, 10);
    expect(usdPessoa).toBeCloseTo(TOTAL_CENTAVOS / 100, 10);

    // Readback das rows reais: exatamente global + pessoa, nada de linha extra.
    const rows = await pool.query<{ escopo: string; valor: ValorCusto }>(
      `SELECT escopo, valor FROM agent_facts
        WHERE tenant_id = $1 AND agent_id = $2 AND chave LIKE $3
        ORDER BY escopo`,
      [TENANT_A, AGENT_A, 'cost.daily.llm.%'],
    );
    expect(rows.rows.map((r) => r.escopo)).toEqual(['global', 'pessoa']);
    expect(Number(rows.rows[0]!.valor.usd_cents) + Number(rows.rows[1]!.valor.usd_cents)).toBe(
      TOTAL_CENTAVOS * 2,
    );
  });

  it('AC03-b — outro tenant/agente não lê nem altera a linha, e sem ALS a escrita falha fechada', async () => {
    const { recordLLMCost, readDailyLLMUsd } = await import('@/lib/cost-ledger.js');
    const { factsRepo } = await import('@/db/repositories.js');
    const { runWithTenantContext, MissingTenantContextError } = await import(
      '@/db/tenant-context.js'
    );

    // B não enxerga o fato de A pelo mesmo (escopo, chave).
    const deB = await runWithTenantContext(ctxB, () => factsRepo.getByKey('global', CHAVE_GLOBAL));
    expect(deB).toBeNull();
    expect(await runWithTenantContext(ctxB, () => readDailyLLMUsd(DIA))).toBe(0);

    // Sem contexto ALS o leitor estoura (falha fechada), em vez de varrer tudo.
    await expect(factsRepo.getByKey('global', CHAVE_GLOBAL)).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );

    // E a escrita sem contexto não inventa tenant: nenhuma row nova.
    const antes = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM agent_facts WHERE chave LIKE 'cost.daily.llm.%' AND tenant_id IN ($1, $2)`,
      [TENANT_A, TENANT_B],
    );
    await recordLLMCost({ provider: 'anthropic', model: MODELO, tokens_input: 1000, tokens_output: 1000 });
    const depois = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM agent_facts WHERE chave LIKE 'cost.daily.llm.%' AND tenant_id IN ($1, $2)`,
      [TENANT_A, TENANT_B],
    );
    expect(depois.rows[0]!.total).toBe(antes.rows[0]!.total);

    // B escreve por conta própria e não colide com A (chave igual, escopo igual).
    await runWithTenantContext(ctxB, () =>
      recordLLMCost({ provider: 'anthropic', model: MODELO, tokens_input: 1000, tokens_output: 0 }),
    );
    const deBGlobal = await runWithTenantContext(ctxB, () => factsRepo.getByKey('global', CHAVE_GLOBAL));
    const deAGlobal = await runWithTenantContext(ctxA, () => factsRepo.getByKey('global', CHAVE_GLOBAL));
    expect(Number((deBGlobal!.valor as ValorCusto).tokens_input)).toBe(1000);
    expect(Number((deAGlobal!.valor as ValorCusto).tokens_input)).toBe(TOTAL_TOKENS_INPUT);
  });

  it('AC03-c — getByKey é escopado por (tenant, agente, escopo, chave) e o upsert operacional REPLACE', async () => {
    const { factsRepo } = await import('@/db/repositories.js');
    const { runWithTenantContext } = await import('@/db/tenant-context.js');

    const chave = `caracterizacao.sc12a.${RUN_ID}`;
    const primeiro = await runWithTenantContext(ctxA, () =>
      factsRepo.upsert({ escopo: 'pessoa', chave, valor: { marca: 'v1' }, fonte: 'aprendido' }),
    );
    const segundo = await runWithTenantContext(ctxA, () =>
      factsRepo.upsert({ escopo: 'pessoa', chave, valor: { marca: 'v2' }, fonte: 'aprendido' }),
    );

    // Mesma row, mesmo id: o contrato operacional é REPLACE, não versionamento.
    expect(segundo.id).toBe(primeiro.id);
    const lido = await runWithTenantContext(ctxA, () => factsRepo.getByKey('pessoa', chave));
    expect((lido!.valor as { marca: string }).marca).toBe('v2');

    const contagem = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM agent_facts
        WHERE tenant_id = $1 AND agent_id = $2 AND escopo = 'pessoa' AND chave = $3`,
      [TENANT_A, AGENT_A, chave],
    );
    expect(contagem.rows[0]!.total).toBe('1');

    // Outro escopo é outra identidade; outro tenant não alcança a row.
    expect(await runWithTenantContext(ctxA, () => factsRepo.getByKey('global', chave))).toBeNull();
    expect(await runWithTenantContext(ctxB, () => factsRepo.getByKey('pessoa', chave))).toBeNull();
  });

  it('AC03-d — segunda revisão pelo KSM colide com a unique atual e o original permanece', async () => {
    const { knowledgeRepos } = await import('@/control-plane/knowledge-state-machine/repos.js');

    const chave = `pessoa:${PESSOA_A}`;
    const criar = (marca: string) =>
      knowledgeRepos.create({
        tenant_id: TENANT_A,
        agent_id: AGENT_A,
        kind: 'fact',
        key: chave,
        scope: 'user',
        scope_value: PESSOA_A,
        content: { marca },
        content_text: `marca ${marca}`,
        confidence: 0.8,
        lifecycle_status: 'pending_review',
        lifecycle_transitions: [],
        evidence_count: 1,
        native: { fact_escopo: chave, fact_chave: `perfil.${RUN_ID}` },
      });

    const primeiraId = await criar('revisao-1');
    expect(primeiraId).toMatch(/^[0-9a-f-]{36}$/);

    // A segunda proposta da MESMA chave lógica não tem onde caber: o INSERT
    // simples bate na unique (tenant_id, agent_id, escopo, chave). O driver
    // entrega o erro do Postgres embrulhado pelo drizzle (`cause`), então a
    // asserção olha o código e a CONSTRAINT reais, não só a mensagem.
    await expect(criar('revisao-2')).rejects.toMatchObject({
      cause: {
        code: '23505',
        constraint: 'agent_facts_tenant_agent_escopo_chave_key',
      },
    });

    const rows = await pool.query<{ id: string; valor: { marca: string }; escopo: string }>(
      `SELECT id, valor, escopo FROM agent_facts
        WHERE tenant_id = $1 AND agent_id = $2 AND escopo = $3 AND chave = $4`,
      [TENANT_A, AGENT_A, chave, `perfil.${RUN_ID}`],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.id).toBe(primeiraId);
    expect(rows.rows[0]!.valor.marca).toBe('revisao-1');

    // A unique real que sustenta o conflito, lida do catálogo do banco.
    const constraint = await pool.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'agent_facts_tenant_agent_escopo_chave_key'`,
    );
    expect(constraint.rowCount).toBe(1);
    expect(constraint.rows[0]!.def).toContain('tenant_id');
    expect(constraint.rows[0]!.def).toContain('chave');
  });

  it('AC03-e — zero exposição de cost.daily.llm no recall, e a exposição da leitura legada de fatos declarada', async () => {
    const { recallAuthorized } = await import('@/memory/recall-authorized.js');
    const { factsRepo } = await import('@/db/repositories.js');
    const { runWithTenantContext } = await import('@/db/tenant-context.js');

    // Item canônico privado do titular, elegível: é o controle positivo — sem
    // ele, "zero itens de custo" poderia ser só "zero itens".
    const entrada = await pool.query<{ id: string }>(
      `INSERT INTO memory_entry(tenant_id, agent_id, content, memory_type, scope_type, subject_id,
                                sensitivity, proactive_use, mention_allowed, needs_review, lifecycle_status)
       VALUES ($1, $2, $3, 'preference', 'interlocutor', $4, 'low', true, true, false, 'active')
       RETURNING id`,
      [TENANT_A, AGENT_A, 'saldo preferencial do cliente caracterizado', PESSOA_A],
    );
    const memoriaId = entrada.rows[0]!.id;
    await pool.query(
      `INSERT INTO agent_memories(tenant_id, agent_id, conteudo, embedding, tipo, escopo,
                                  memory_entry_id, content_digest)
       VALUES ($1, $2, $3, $4::vector, 'fato', 'pessoa', $5, 'sc12a')`,
      [
        TENANT_A,
        AGENT_A,
        'saldo preferencial do cliente caracterizado',
        `[${Array.from({ length: DIMENSOES_EMBEDDING }, () => 0.01).join(',')}]`,
        memoriaId,
      ],
    );

    const itens = await runWithTenantContext(ctxA, () =>
      recallAuthorized({ principal: { pessoa_id: PESSOA_A, conversa_id: CONVERSA_A }, query: 'saldo' }),
    );

    expect(itens.map((i) => i.memory_entry_id)).toContain(memoriaId);

    // O agregado de custo existe no banco...
    const custos = await pool.query<{ id: string; chave: string }>(
      `SELECT id, chave FROM agent_facts
        WHERE tenant_id = $1 AND agent_id = $2 AND chave LIKE 'cost.daily.llm.%'`,
      [TENANT_A, AGENT_A],
    );
    expect(custos.rowCount).toBeGreaterThan(0);

    // ...e NÃO é projetado pelo recall: nenhum id de custo, nenhum conteúdo de custo.
    const idsDeCusto = new Set(custos.rows.map((r) => r.id));
    for (const item of itens) {
      expect(idsDeCusto.has(item.memory_entry_id)).toBe(false);
      expect(item.content).not.toContain('cost.daily.llm');
    }

    // Motivo estrutural, lido do banco: fato operacional não tem item canônico
    // nem vetor, então o JOIN do predicado (migration 146) o deixa fora.
    const semVinculo = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM agent_facts af
         LEFT JOIN memory_entry me
           ON me.tenant_id = af.tenant_id AND me.agent_id = af.agent_id
          AND (me.content = (af.valor->>'content') OR me.content = (af.chave || ': ' || af.valor::text))
        WHERE af.tenant_id = $1 AND af.agent_id = $2 AND af.chave LIKE 'cost.daily.llm.%'
          AND me.id IS NULL`,
      [TENANT_A, AGENT_A],
    );
    expect(semVinculo.rows[0]!.total).toBe(String(custos.rowCount));

    // EXPOSIÇÃO DECLARADA (fora do recall): a leitura legada de fatos para o
    // prompt devolve o agregado operacional, porque escopo='global' está entre
    // os escopos pedidos e o ciclo de vida é 'active'.
    const paraPrompt = await runWithTenantContext(ctxA, () =>
      factsRepo.listForScopes(['global', `pessoa:${PESSOA_A}`]),
    );
    const chavesParaPrompt = paraPrompt.map((f) => f.chave);
    expect(chavesParaPrompt).toContain(CHAVE_GLOBAL);
  });
});