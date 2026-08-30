/**
 * Issue #525 — por que a meta de ≤8 NÃO foi perseguida até o fim, medido.
 *
 * ## O que este arquivo é
 *
 * As quatro idas ao banco que separam o orçamento atual (12) da meta da #525 (8)
 * só saem fundindo tabelas DIFERENTES num statement só: `agent_facts ∪
 * learned_rules`, `memory_entry ∪ behavioral_hint`, `agent_capabilities_skill ∪
 * agent_capability_gaps` e `operational_profile_versions ∪ self_state`. Isso foi
 * implementado, ficou correto (prompt byte-idêntico, escopo por tenant+agent
 * intacto, oito statements exatos) — e foi DESFEITO, porque o benchmark mostrou
 * o p95 da carga de contexto triplicando.
 *
 * Uma decisão dessas não pode viver só num corpo de PR. Este arquivo é a razão
 * dela em forma executável: se algum dia o Postgres, o schema ou o volume de
 * dados mudarem a ponto de fundir passar a compensar, ele fica VERMELHO e diz ao
 * próximo agente que o texto do doc envelheceu — em vez de deixá-lo repetir a
 * experiência às cegas.
 *
 * ## O argumento, em três medidas
 *
 *  1. **A ida ao banco é barata.** Um round-trip vazio custa uma fração do que
 *     custa a leitura mais barata do turno. "Menos round-trips" só é sinônimo de
 *     "mais rápido" quando o round-trip domina o preço, e ele não domina.
 *  2. **As leituras do turno são CONCORRENTES** (`turn-context/concurrency.ts`,
 *     seis permissões). O turno paga o MÁXIMO do conjunto, não a soma. Reduzir a
 *     CONTAGEM abaixo do teto de concorrência não encurta o caminho crítico.
 *  3. **Fundir alonga esse máximo.** Um `UNION ALL` de dois ramos custa mais
 *     para PLANEJAR que qualquer um dos dois sozinho — e é o planejamento, não a
 *     execução, que domina neste volume de dados.
 *
 * (1) e (3) são medidos aqui. (2) é estrutural e está travado em
 * `tests/integration/turn-context-pool-fairness.spec.ts`.
 *
 * ## Por que as asserções são sobre `Planning Time`, e não sobre relógio
 *
 * Relógio de parede numa máquina compartilhada com outras suítes é ruído. O
 * `Planning Time` do `EXPLAIN` é medido DENTRO do servidor, sobre a mesma
 * consulta, e a diferença que interessa aqui (planejar dois ramos contra
 * planejar um) é estrutural — não depende de quem mais está na máquina. As
 * medianas são de 25 amostras e a margem exigida é folgada; o número medido
 * quando isto foi escrito era 8×, e a asserção pede 1,5×.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = { tenant_id: 'i525-custo-t', agent_id: 'i525-custo-a' };
const AMOSTRAS = 25;

let c: pg.Client;

/** Mediana do `Planning Time` que o servidor reporta para esta consulta. */
async function planejamentoMs(sqlText: string, params: unknown[]): Promise<number> {
  const t: number[] = [];
  for (let i = 0; i < AMOSTRAS; i++) {
    const r = await c.query(
      `EXPLAIN (ANALYZE, TIMING OFF, SUMMARY ON) ${sqlText}`,
      params as never[],
    );
    const linhas = (r.rows as Array<{ 'QUERY PLAN': string }>).map((x) => x['QUERY PLAN']);
    const p = linhas.find((l) => l.startsWith('Planning Time'));
    t.push(Number(/([\d.]+) ms/.exec(p ?? '')?.[1] ?? NaN));
  }
  t.sort((a, b) => a - b);
  return t[Math.floor(AMOSTRAS / 2)]!;
}

/** Mediana do relógio de parede de uma consulta, do lado do cliente. */
async function relogioMs(sqlText: string, params: unknown[] = []): Promise<number> {
  for (let i = 0; i < 20; i++) await c.query(sqlText, params as never[]);
  const t: number[] = [];
  for (let i = 0; i < 200; i++) {
    const a = performance.now();
    await c.query(sqlText, params as never[]);
    t.push(performance.now() - a);
  }
  t.sort((x, y) => x - y);
  return t[100]!;
}

type Coluna = { column_name: string; t: string };

async function colunas(tabela: string): Promise<Coluna[]> {
  const r = await c.query<Coluna>(
    `SELECT ic.column_name, format_type(a.atttypid, a.atttypmod) AS t
     FROM information_schema.columns ic
     JOIN pg_attribute a ON a.attrelid = ic.table_name::regclass AND a.attname = ic.column_name
     WHERE ic.table_name = $1 ORDER BY ic.ordinal_position`,
    [tabela],
  );
  return r.rows;
}

/**
 * A MESMA forma que a implementação descartada usava: colunas reais de um lado,
 * `NULL::<tipo declarado>` do outro, `row_number()` por ramo e `ORDER BY` de
 * fora. O padding tipado não é enfeite — é o que preserva `numeric` como string
 * e `timestamptz` como `Date`, sem o qual o prompt mudaria de bytes.
 */
function uniaoDe(
  tabA: string,
  colsA: Coluna[],
  ondeA: string,
  tabB: string,
  colsB: Coluna[],
  ondeB: string,
): string {
  const selA = colsA.map((x, i) => `"${tabA}"."${x.column_name}" AS "r0c${i}"`).join(', ');
  const selB = colsB.map((x, i) => `"${tabB}"."${x.column_name}" AS "r1c${i}"`).join(', ');
  const padA = colsA.map((x, i) => `NULL::${x.t} AS "r0c${i}"`).join(', ');
  const padB = colsB.map((x, i) => `NULL::${x.t} AS "r1c${i}"`).join(', ');
  return (
    `SELECT 0 AS "__r", row_number() OVER () AS "__n", ${selA}, ${padB} ` +
    `FROM (SELECT * FROM "${tabA}" WHERE ${ondeA}) AS "${tabA}" ` +
    `UNION ALL ` +
    `SELECT 1 AS "__r", row_number() OVER () AS "__n", ${padA}, ${selB} ` +
    `FROM (SELECT * FROM "${tabB}" WHERE ${ondeB}) AS "${tabB}" ` +
    `ORDER BY "__r", "__n"`
  );
}

const P = [T.tenant_id, T.agent_id];

d('#525 — fundir duas leituras do turno custa mais do que economiza', () => {
  beforeAll(async () => {
    c = new pg.Client({ connectionString: process.env.TEST_DB_URL });
    await c.connect();
    await c.query(`INSERT INTO tenants(id,nome) VALUES ($1,$1) ON CONFLICT DO NOTHING`, [
      T.tenant_id,
    ]);
    await c.query(
      `INSERT INTO agents(id,tenant_id,nome) VALUES ($1,$2,$1) ON CONFLICT DO NOTHING`,
      [T.agent_id, T.tenant_id],
    );
    // Massa pequena de propósito: é o volume do turno típico, e é justamente
    // nesse volume que o PLANEJAMENTO domina a execução.
    for (let i = 0; i < 5; i++) {
      await c.query(
        `INSERT INTO agent_facts(tenant_id,agent_id,escopo,chave,valor,lifecycle_status)
         VALUES ($1,$2,'global',$3,'{"n":1}'::jsonb,'active')
         ON CONFLICT DO NOTHING`,
        [...P, `i525-custo-f${i}`],
      );
      await c.query(
        `INSERT INTO learned_rules(tenant_id,agent_id,tipo,contexto,acao,confianca,lifecycle_status)
         VALUES ($1,$2,'classificacao',$3,'acao','0.80','active')`,
        [...P, `i525-custo-r${i}`],
      );
    }
  }, 60_000);

  afterAll(async () => {
    for (const tabela of ['agent_facts', 'learned_rules']) {
      await c.query(`DELETE FROM ${tabela} WHERE tenant_id=$1 AND agent_id=$2`, P);
    }
    await c.end();
  });

  it('a ida ao banco é a menor parte do preço de uma leitura', async () => {
    const vazio = await relogioMs(`SELECT 1`);
    const leitura = await relogioMs(
      `SELECT * FROM "agent_facts" WHERE "tenant_id" = $1 AND "agent_id" = $2`,
      P,
    );
    // Um round-trip vazio contra a leitura mais barata do turno. Medido quando
    // isto foi escrito: 0,15 ms contra 0,44 ms. A asserção só pede que a ida
    // vazia não domine — se um dia dominar, "menos round-trips" volta a ser
    // sinônimo de "mais rápido" e o argumento deste arquivo cai.
    expect(vazio).toBeLessThan(leitura);
    console.log(
      `[#525] round-trip vazio p50=${vazio.toFixed(3)}ms · leitura mais barata p50=${leitura.toFixed(3)}ms`,
    );
  });

  it('o UNION ALL dos dois ramos planeja mais caro que qualquer um deles sozinho', async () => {
    const cf = await colunas('agent_facts');
    const cr = await colunas('learned_rules');
    const ondeF = `"agent_facts"."tenant_id" = $1 AND "agent_facts"."agent_id" = $2`;
    const ondeR = `"learned_rules"."tenant_id" = $1 AND "learned_rules"."agent_id" = $2`;

    const soFatos = await planejamentoMs(`SELECT * FROM "agent_facts" WHERE ${ondeF}`, P);
    const soRegras = await planejamentoMs(`SELECT * FROM "learned_rules" WHERE ${ondeR}`, P);
    const fundido = await planejamentoMs(
      uniaoDe('agent_facts', cf, ondeF, 'learned_rules', cr, ondeR),
      P,
    );

    console.log(
      `[#525] planejamento: fatos=${soFatos.toFixed(3)}ms regras=${soRegras.toFixed(3)}ms ` +
        `fundido=${fundido.toFixed(3)}ms (${(fundido / Math.max(soFatos, soRegras)).toFixed(1)}× o pior ramo)`,
    );

    // O que decide a latência do turno: as duas leituras separadas saem
    // CONCORRENTES, então o turno paga `max(fatos, regras)`. A leitura fundida
    // substitui esse máximo por si mesma — e ela é mais cara. Trocar duas idas
    // concorrentes por uma ida mais lenta é alongar o caminho crítico enquanto
    // se melhora um número que ninguém sente.
    expect(fundido).toBeGreaterThan(Math.max(soFatos, soRegras) * 1.5);
  });

  it('e o `EXPLAIN` mostra que é PLANEJAMENTO, não execução', async () => {
    const cf = await colunas('agent_facts');
    const cr = await colunas('learned_rules');
    const ondeF = `"agent_facts"."tenant_id" = $1 AND "agent_facts"."agent_id" = $2`;
    const ondeR = `"learned_rules"."tenant_id" = $1 AND "learned_rules"."agent_id" = $2`;
    const r = await c.query(
      `EXPLAIN (ANALYZE, TIMING OFF, SUMMARY ON) ${uniaoDe('agent_facts', cf, ondeF, 'learned_rules', cr, ondeR)}`,
      P,
    );
    const linhas = (r.rows as Array<{ 'QUERY PLAN': string }>).map((x) => x['QUERY PLAN']);
    const plan = Number(
      /([\d.]+) ms/.exec(linhas.find((l) => l.startsWith('Planning Time')) ?? '')?.[1] ?? NaN,
    );
    const exec = Number(
      /([\d.]+) ms/.exec(linhas.find((l) => l.startsWith('Execution Time')) ?? '')?.[1] ?? NaN,
    );
    console.log(`[#525] fundido: planejamento=${plan.toFixed(3)}ms execução=${exec.toFixed(3)}ms`);
    // É por isso que "menos linhas lidas" não salva a fusão: as linhas não são
    // o custo. Se um dia a execução passar a dominar, o cálculo muda e esta
    // asserção avisa.
    expect(plan).toBeGreaterThan(exec);
  });
});
