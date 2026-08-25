/**
 * Issue #504 (decisão do dono) — o `WHERE` REAL de uma gravação de turno.
 *
 * ─── POR QUE ESTE ARQUIVO EXISTE, E POR QUE NÃO É UM ESPELHO ────────────────
 *
 * A garantia inteira da absorção de irmão mora num predicado SQL. Um teste que
 * remonte esse predicado com o próprio harness passaria mesmo que o call site
 * de produção fosse DELETADO — é o modo mais fácil de escrever um teste que
 * não prova nada.
 *
 * Aqui não há remontagem: o teste importa `turnWriteConditions`, a MESMA
 * função que `runTransition` (`src/db/repositories/turn-repos.ts`) chama para
 * montar o `WHERE` do `UPDATE`, e compila o resultado com o dialeto real do
 * Drizzle (`PgDialect`). O SQL afirmado abaixo é, caractere por caractere, o
 * SQL que o PostgreSQL recebe em produção. Apagar a condição de lease do
 * absorvedor deixa a produção insegura E este arquivo vermelho — que é a única
 * relação que faz um teste valer alguma coisa.
 *
 * Não precisa de Postgres: `sqlToQuery` é pura. É de propósito — a prova do
 * fence não pode depender de infraestrutura que pode estar fora do ar
 * justamente quando alguém mexe nele.
 */
import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { and } from 'drizzle-orm';
import {
  absorberFenceCondition,
  turnWriteConditions,
} from '@/db/repositories/turn-fence-sql.js';

const dialect = new PgDialect();

function compile(conditions: ReturnType<typeof turnWriteConditions>) {
  const query = dialect.sqlToQuery(and(...conditions)!);
  // Normaliza o whitespace do template multi-linha para que as asserções
  // falem de SQL, não de indentação.
  return { sql: query.sql.replace(/\s+/g, ' '), params: query.params };
}

const BASE = {
  tenant_id: 'acme',
  agent_id: 'financeiro',
  turn_id: '11111111-1111-4111-8111-111111111111',
  sources: ['received', 'queued'] as const,
};

const ABSORBER = '22222222-2222-4222-8222-222222222222';
const TOKEN = '33333333-3333-4333-8333-333333333333';

describe('#504 — fence de ABSORÇÃO: a autoridade é do absorvedor', () => {
  const absorption = () =>
    compile(
      turnWriteConditions({
        ...BASE,
        expected_version: 7,
        fence: { kind: 'absorber', absorber_turn_id: ABSORBER, claim_token: TOKEN },
      }),
    );

  /**
   * SONDA 1 — remover a verificação de LEASE do absorvedor.
   *
   * Sem `lease_expires_at > now()`, um worker cuja lease venceu e que ainda não
   * foi sucedido continua portando um `claim_token` que CASA com a linha: ele
   * absorveria turnos sem ter posse, apagando trabalho do sucessor. Só o token
   * nunca foi suficiente.
   */
  it('exige a LEASE VIVA do absorvedor, pelo relógio do PostgreSQL', () => {
    const { sql } = absorption();
    expect(sql).toContain('absorvedor.lease_expires_at > now()');
    // `now()` e não um parâmetro: elegibilidade por lease compara instantes
    // entre máquinas, e um `Date.now()` do processo reintroduz o clock skew que
    // o fence existe para eliminar.
    expect(sql).not.toMatch(/absorvedor\.lease_expires_at\s*>\s*\$\d+/);
  });

  it('exige o TOKEN VIGENTE do absorvedor, com cast explícito para uuid', () => {
    const { sql, params } = absorption();
    expect(sql).toContain('absorvedor.claim_token = $');
    expect(sql).toMatch(/absorvedor\.claim_token = \$\d+::uuid/);
    expect(params).toContain(TOKEN);
  });

  it('o absorvedor precisa estar em estado GRAVÁVEL e no MESMO escopo', () => {
    const { sql, params } = absorption();
    expect(sql).toContain('absorvedor.tenant_id = $');
    expect(sql).toContain('absorvedor.agent_id = $');
    expect(sql).toMatch(/absorvedor\.id = \$\d+::uuid/);
    expect(sql).toContain('absorvedor.status IN (');
    for (const status of ['claimed', 'running', 'outbound_pending']) {
      expect(params).toContain(status);
    }
    // Um turno terminal não absorve ninguém.
    expect(params).not.toContain('completed');
  });

  /**
   * SONDA 2 — voltar a exigir claim DO IRMÃO.
   *
   * O turno absorvido normalmente NUNCA foi reivindicado: quem foi
   * reivindicado é o executor da rajada. `claim_token IS NULL` é o estado
   * NORMAL dele, então qualquer condição sobre `agent_turns.claim_token` na
   * linha que muda torna a absorção legítima impossível no caso comum.
   *
   * A asserção é de CONTAGEM, não de ausência textual: o único `claim_token`
   * do predicado tem de ser o do absorvedor, dentro do EXISTS. Se alguém
   * acrescentar o fence do irmão, a contagem vira 2 e este caso fica vermelho.
   */
  it('NÃO impõe nenhuma condição de claim sobre o irmão absorvido', () => {
    const { sql } = absorption();
    const ocorrencias = sql.match(/claim_token/g) ?? [];
    expect(ocorrencias).toHaveLength(1);
    expect(sql).toContain('absorvedor.claim_token');
    expect(sql).not.toMatch(/"agent_turns"\."claim_token"/);
    // E a linha do irmão também não pode ganhar exigência de lease própria.
    expect(sql).not.toMatch(/"agent_turns"\."lease_expires_at"/);
  });

  /**
   * SONDA 3 — remover o CAS do irmão.
   *
   * O fence do absorvedor responde "posso absorver?"; o compare-and-swap na
   * linha do irmão responde "este irmão ainda está como eu li?". Sem ele, duas
   * absorções concorrentes que leram o mesmo estado podem ambas se declarar
   * vencedoras, e a rajada do debounce produz dois turnos executáveis
   * disputando as mesmas mensagens.
   */
  it('faz COMPARE-AND-SWAP na linha do irmão: estado E versão', () => {
    const { sql, params } = absorption();
    expect(sql).toContain('"agent_turns"."state_version" = $');
    expect(params).toContain(7);
    expect(sql).toContain('"agent_turns"."status" in ($');
    expect(params).toContain('received');
    expect(params).toContain('queued');
  });

  it('o escopo tenant+agent está no WHERE da linha que muda', () => {
    const { sql, params } = absorption();
    expect(sql).toContain('"agent_turns"."tenant_id" = $');
    expect(sql).toContain('"agent_turns"."agent_id" = $');
    expect(params).toContain('acme');
    expect(params).toContain('financeiro');
  });
});

describe('#504 — fence PRÓPRIO (auto-supersessão e demais transições)', () => {
  const self = () =>
    compile(
      turnWriteConditions({
        ...BASE,
        expected_version: 4,
        fence: { kind: 'self', claim_token: TOKEN },
      }),
    );

  it('exige o token da PRÓPRIA linha E a lease viva — as duas', () => {
    const { sql, params } = self();
    expect(sql).toContain('"agent_turns"."claim_token" = $');
    expect(sql).toContain('"agent_turns"."lease_expires_at" > now()');
    expect(params).toContain(TOKEN);
  });

  it('não usa EXISTS: a autoridade é a própria linha', () => {
    expect(self().sql).not.toContain('EXISTS');
  });
});

describe('#504 — sem fence: o regime de #503 (`FEATURE_TURN_CLAIM` OFF)', () => {
  it('nenhuma condição de posse, mas o CAS e o escopo continuam', () => {
    const { sql } = compile(
      turnWriteConditions({ ...BASE, expected_version: 1, fence: { kind: 'none' } }),
    );
    expect(sql).not.toContain('claim_token');
    expect(sql).not.toContain('lease_expires_at');
    expect(sql).not.toContain('EXISTS');
    expect(sql).toContain('"agent_turns"."state_version" = $');
    expect(sql).toContain('"agent_turns"."tenant_id" = $');
  });
});

describe('#504 — `absorberFenceCondition` é uma condição EXISTS fechada', () => {
  it('não vaza para fora do subselect', () => {
    const { sql } = compile([
      absorberFenceCondition({
        tenant_id: 'acme',
        agent_id: 'financeiro',
        absorber_turn_id: ABSORBER,
        claim_token: TOKEN,
      }),
    ]);
    expect(sql.startsWith('EXISTS (')).toBe(true);
    expect(sql.trimEnd().endsWith(')')).toBe(true);
  });
});
