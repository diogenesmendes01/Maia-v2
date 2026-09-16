/**
 * P04.3a (spec §8.2.3 passo 3, §5.6.3) — o SQL que tranca `conversation_controls`,
 * com UM só dono.
 *
 * ─── Por que existe um módulo só para isto ─────────────────────────────────
 *
 * `conversation_controls` é o **PRIMEIRO degrau** da ordem global de locks. O
 * §5.6.3 a fixa para o journal (`conversation_controls → agent_turns →
 * engine_runs → engine_tool_calls`) e o §8.2.3 passo 3 a estende para o controle
 * humano (`controle → exclusão/ordenação existente da stream → turnos →
 * efeito/outbox`), com a cláusula que dá origem a este arquivo: **"não
 * introduzir dois ordenamentos incompatíveis"**.
 *
 * Até aqui o trancamento era uma função privada de `engine-repos.ts`, com 16
 * call sites. O `pauseConversationTx` do §8.2.3 precisa trancar a MESMA linha, e
 * havia três saídas:
 *
 *   1. copiar o SQL para o repositório de controle — duas cópias divergem, e a
 *      divergência de uma ordem de lock só aparece sob concorrência, em
 *      produção, como deadlock;
 *   2. importar de `engine-repos.ts` — inverteria a dependência. Controle é o
 *      degrau ANTERIOR; o journal é quem o consome, não o contrário;
 *   3. extrair para um módulo compartilhado — o que a casa já fez duas vezes,
 *      por esta mesma razão: `turn-fence-sql.ts` (#504) e `stream-head-sql.ts`
 *      (#626).
 *
 * ─── Por que CONSTRUTOR de SQL, e não uma função que executa ───────────────
 *
 * Pelo mesmo motivo que os dois precedentes: `engine-repos.ts` e `turn-repos.ts`
 * importam `../client.js`, que constrói o `pg.Pool` no import e exige
 * `DATABASE_URL`. Enquanto o SQL morar lá dentro, a única prova possível de que
 * o lock existe é um teste de integração — e um teste de integração que não roda
 * (Postgres fora do ar, ou justamente indisponível quando alguém mexe no lock)
 * não prova nada.
 *
 * Aqui os construtores são puros: `new PgDialect().sqlToQuery(...)` compila o
 * SQL REAL sem banco nenhum, e `tests/unit/db/conversation-control-sql.spec.ts`
 * afirma sobre o SQL que o PostgreSQL de fato recebe. A regra que torna isso
 * honesto é a mesma de `turn-fence-sql.ts`: **nenhum chamador monta o SELECT por
 * conta própria** — todos chamam estes construtores. Se alguém apagar o
 * `FOR UPDATE` daqui, a produção fica insegura E o teste fica vermelho, que é a
 * única relação que faz um teste valer alguma coisa.
 *
 * Este módulo NÃO executa, NÃO abre transação e NÃO lê o escopo do ALS. Quem
 * chama passa `tenant_id`/`agent_id` já resolvidos e roda o SQL no seu próprio
 * executor — deliberadamente, para que ele continue puro e testável sem boot.
 */
import { sql, type SQL } from 'drizzle-orm';
import { conversation_controls, engine_runs } from '../schema.js';

/**
 * A linha devolvida pelos dois construtores. Eles selecionam EXATAMENTE as
 * mesmas colunas de propósito: o consumidor tipa uma linha só, e se as duas
 * formas divergissem, um dos caminhos quebraria em runtime com o tipo
 * satisfeito — o pior dos dois mundos.
 *
 * `control_epoch` sai como TEXTO porque a coluna é `bigint`: materializar como
 * `number` perderia precisão acima de 2^53, e o contrato do §8.3.2 serializa
 * epoch como decimal em string exatamente por isso.
 */
export type ConversationControlLockRow = {
  id: string;
  mode: string;
  control_epoch: string;
};

/** As três colunas do contrato acima, num só lugar. */
const COLUNAS = sql`c.id, c.mode, c.control_epoch::text AS control_epoch`;

/**
 * Tranca o controle POR ID — a forma usada quando o run ainda não existe
 * (`pinEngineAndPrepareRun`) e a que o `pauseConversationTx` do §8.2.3 usa,
 * porque um comando de operador não tem run nenhum a que se referir.
 */
export function lockControlByIdSql(input: {
  tenant_id: string;
  agent_id: string;
  control_id: string;
}): SQL {
  return sql`
    SELECT ${COLUNAS}
      FROM ${conversation_controls} c
     WHERE c.tenant_id = ${input.tenant_id} AND c.agent_id = ${input.agent_id}
       AND c.id = ${input.control_id}
     FOR UPDATE`;
}

/**
 * Tranca o controle PELO RUN — a forma do SQL do §5.6.4, usada por todas as
 * operações do journal que já têm um run em mãos.
 *
 * **`FOR UPDATE OF c` é a cláusula que mais importa neste arquivo.** Num join,
 * um `FOR UPDATE` sem `OF` tranca TODAS as tabelas da consulta: o controle *e*
 * `engine_runs`. Isso adicionaria uma aresta de lock sobre o run ANTES do
 * controle — e o §5.6.3 fixa a ordem inversa (controle → turno → run). Seriam
 * os "dois ordenamentos incompatíveis" que o §8.2.3 passo 3 proíbe, com o
 * deadlock aparecendo só sob concorrência real. O caso 5 do spec prende isso.
 *
 * O join carrega o escopo COMPLETO (`tenant_id` e `agent_id`, não só
 * `control_id`): dois escopos com o mesmo uuid cruzariam tenants se o
 * pertencimento não fosse predicado.
 */
export function lockControlByRunSql(input: {
  tenant_id: string;
  agent_id: string;
  run_id: string;
}): SQL {
  return sql`
    SELECT ${COLUNAS}
      FROM ${conversation_controls} c
      JOIN ${engine_runs} r
        ON r.tenant_id = c.tenant_id AND r.agent_id = c.agent_id AND r.control_id = c.id
     WHERE r.tenant_id = ${input.tenant_id} AND r.agent_id = ${input.agent_id}
       AND r.id = ${input.run_id}
     FOR UPDATE OF c`;
}
