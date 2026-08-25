/**
 * Issue #626 (fatia C da #505) — a REGRA FIFO por stream, num módulo PURO.
 *
 * ─── Por que existe um módulo só para isto ─────────────────────────────────
 *
 * A issue é explícita: "**Uma única função de repositório** — `claimNextEligibleTurn`
 * — em vez de lógica duplicada entre worker e recovery. Duas cópias da regra de
 * elegibilidade divergem, e a divergência só aparece durante um recovery."
 *
 * O jeito de tornar isso verdadeiro não é disciplina: é não existir um segundo
 * lugar onde a regra possa ser escrita. Os TRÊS consumidores da regra —
 *
 *   1. `claimNextEligibleTurn` (o `WHERE` do claim),
 *   2. `findRecoverableTurns` (quais turnos o recovery rearma),
 *   3. `listTenantAgentPairsWithRecoverableTurns` (o dispatcher cross-tenant),
 *
 * — chamam `streamHeadOfLineNotExists()`. Nenhum deles monta predicado próprio.
 * Apagar a condição de um só deles é o defeito que a issue nomeia, e
 * `tests/unit/runtime/stream-head-of-line-sql.spec.ts` compila os três com
 * `PgDialect` e falha se qualquer um deixar de carregá-la.
 *
 * ─── Por que PURO (a mesma razão de `turn-fence-sql.ts`) ───────────────────
 *
 * `turn-repos.ts` importa `../client.js`, que constrói o `pg.Pool` no import e
 * exige `DATABASE_URL`. Enquanto a regra morar lá dentro, a única prova
 * possível de que ela existe é um teste de integração — e um teste de
 * integração que não roda (Postgres fora do ar) não prova nada. Aqui o SQL é
 * construído por função pura, então `new PgDialect().sqlToQuery(...)` compila
 * o SQL REAL sem banco.
 *
 * ─── A regra, em uma frase ────────────────────────────────────────────────
 *
 * Um turno é HEAD-OF-LINE da sua stream quando **não existe turno anterior não
 * terminal na mesma stream** — "anterior" medido por `first_ingress_seq`, a
 * fronteira que a fatia A (#624) passou a persistir.
 */
import { sql, type SQL } from 'drizzle-orm';
import { agent_turns } from '../schema.js';
import { TERMINAL_TURN_STATUSES } from '@/runtime/turns/contract.js';

/**
 * A lista de estados como LITERAIS SQL, não como parâmetros.
 *
 * Isto não é estilo — é o que faz o índice parcial ser usado. O predicado de
 * `agent_turns_stream_head_live_idx` (migration 126) é
 * `status NOT IN ('completed','ignored','superseded','dead_letter')`, e o
 * PostgreSQL só consegue PROVAR que a cláusula da consulta implica o predicado
 * do índice quando os dois lados são `Const`. Com `$1..$4` a prova depende de o
 * planejador ter substituído os parâmetros (custom plan) — o que ele faz nas
 * primeiras execuções e deixa de fazer se decidir cachear um plano genérico.
 * O resultado seria uma degradação silenciosa: o `NOT EXISTS` volta ao índice
 * largo `agent_turns_stream_head_idx` e passa a varrer o histórico inteiro de
 * uma conversa quente. Com literais a prova é textual e não depende de plano.
 *
 * Seguro por construção: os valores vêm de `TERMINAL_TURN_STATUSES`
 * (`as const` do contrato), nunca de entrada externa. A guarda abaixo existe
 * para que isso continue verdadeiro se alguém acrescentar um estado.
 */
function statusLiterals(statuses: readonly string[]): SQL {
  for (const s of statuses) {
    if (!/^[a-z_]+$/.test(s)) {
      throw new Error(
        `stream-head-sql: estado '${s}' não é um identificador simples e não pode ser ` +
          'inlinado como literal SQL. Os estados vêm de src/runtime/turns/contract.ts e ' +
          'precisam continuar sendo [a-z_]+.',
      );
    }
  }
  return sql.raw(statuses.map((s) => `'${s}'`).join(', '));
}

/**
 * Os estados que fazem um turno ANTERIOR bloquear a stream: todos os NÃO
 * terminais.
 *
 * É o complemento exato de `TERMINAL_TURN_STATUSES`, e não uma segunda lista:
 * escrever `('received','queued',…)` aqui criaria a divergência que o próximo
 * estado novo do contrato revelaria — em produção, e só durante um recovery.
 * Por isso a expressão é `NOT IN (terminais)`.
 *
 * `outbound_pending` bloqueia, e é uma decisão que merece ser contestada: a
 * fatia B deixou-o FORA da OCUPAÇÃO da stream (`STREAM_OCCUPYING_STATUSES`),
 * porque um turno esperando o outbox não disputa posse com ninguém. Ordenação
 * é outra pergunta. Responder M2 antes de a resposta de M1 ter saído é
 * exatamente a inversão que a #505 existe para impedir, então para o
 * head-of-line ele bloqueia — e o motivo de recusa é `stream_blocked`, não
 * `not_head`, porque nenhum claim move um turno dali: quem o move é o delivery
 * worker (#506).
 */
export const STREAM_FIFO_TERMINAL_STATUSES = TERMINAL_TURN_STATUSES;

/**
 * O núcleo: as condições que identificam um turno ANTERIOR não terminal da
 * MESMA stream do alvo.
 *
 * Escrita para casar TEXTUALMENTE com o predicado de
 * `agent_turns_stream_head_live_idx` (`stream_key IS NOT NULL AND status NOT IN
 * (...)`) — ver `statusLiterals`.
 *
 * `escopo.tenant`/`escopo.agent` são FRAGMENTOS, e não strings, porque os três
 * consumidores escopam de formas diferentes: o claim e o recovery têm o par do
 * ALS como parâmetro; o dispatcher cross-tenant correlaciona com as colunas da
 * própria linha. Um `string` obrigaria o dispatcher a montar o predicado à
 * mão — a segunda cópia que este módulo existe para impedir.
 */
function anterioresNaoTerminais(input: { tenant: SQL; agent: SQL; alvo: SQL }): SQL {
  return sql`anterior.tenant_id = ${input.tenant}
         AND anterior.agent_id  = ${input.agent}
         AND anterior.stream_key IS NOT NULL
         AND anterior.status NOT IN (${statusLiterals(STREAM_FIFO_TERMINAL_STATUSES)})
         AND anterior.stream_key        = ${input.alvo}.stream_key
         AND anterior.first_ingress_seq < ${input.alvo}.first_ingress_seq`;
}

/**
 * **A REGRA.** `TRUE` quando o alvo é o head-of-line da sua stream.
 *
 * ─── Os dois escapes, e por que não são fail-open ─────────────────────────
 *
 * `stream_key IS NULL` e `first_ingress_seq IS NULL` devolvem `TRUE` — isto é,
 * o turno é claimável como antes desta fatia. Não é uma brecha: é a única
 * resposta possível. Um turno sem identidade de stream **não pertence a fila
 * nenhuma**, e portanto não existe "anterior" a respeitar. Recusá-lo tornaria
 * INCLAIMÁVEL todo turno anterior ao protocolo (`migration 120`: "NULL = turno
 * anterior ao protocolo, sem backfill") e todo turno gravado com
 * `FEATURE_TURN_STREAM_KEY=false` — uma parada total do ingresso, provocada
 * pela própria proteção.
 *
 * Onde o fail-closed de verdade acontece é ANTES, no ingresso: desde a fatia A
 * (#624) uma mensagem cuja stream não pode ser derivada com segurança é
 * RECUSADA e auditada (`requireStreamIdentity`), nunca agrupada numa stream
 * genérica. Quem chega aqui com `stream_key` nula é histórico, não entrada
 * nova.
 *
 * `first_ingress_seq IS NULL` com `stream_key` preenchida é a mesma situação
 * pela outra ponta: sem sequência não há ordem a impor, e inventar uma
 * (`created_at`, por exemplo) seria usar timestamp como fonte primária de
 * ordenação — o que a issue-mãe proíbe explicitamente.
 */
export function streamHeadOfLineNotExists(input: {
  tenant: SQL;
  agent: SQL;
  alvo: SQL;
}): SQL {
  return sql`(
        ${input.alvo}.stream_key IS NULL
     OR ${input.alvo}.first_ingress_seq IS NULL
     OR NOT EXISTS (
          SELECT 1
            FROM ${agent_turns} AS anterior
           WHERE ${anterioresNaoTerminais(input)}
        )
  )`;
}

/**
 * O CANÁRIO de `maia_stream_fifo_violation_total`: quantos turnos anteriores
 * não terminais existem na stream do alvo.
 *
 * Mesmo núcleo da regra, consumido como CONTAGEM em vez de `NOT EXISTS`. É uma
 * PÓS-CONDIÇÃO: roda no `RETURNING` do claim que já venceu, e o valor esperado
 * é sempre `0`.
 *
 * ─── O que ele protege, e o que ele NÃO protege ───────────────────────────
 *
 * PROTEGE contra a regra não ter sido APLICADA: alguém remove
 * `streamHeadOfLineNotExists(...)` do `WHERE` do claim, ou a aplica à linha
 * errada, ou o índice e o código discordam. Nesses casos o claim passa e o
 * canário acusa — que é exatamente o cenário que a issue manda deixar sempre
 * em zero e tratar como critério de ABORTAR o rollout.
 *
 * NÃO PROTEGE contra alguém editar `anterioresNaoTerminais` — os dois usam o
 * mesmo núcleo, de propósito. A alternativa (uma segunda cópia do predicado,
 * "independente") reintroduziria a divergência que esta fatia existe para
 * eliminar, e uma cópia que ninguém compara é pior que nenhuma. O que cobre
 * esse caso é o teste, não a métrica.
 */
export function earlierLiveTurnCount(input: { tenant: SQL; agent: SQL; alvo: SQL }): SQL {
  return sql`(
    SELECT count(*)::int
      FROM ${agent_turns} AS anterior
     WHERE ${anterioresNaoTerminais(input)}
  )`;
}

/**
 * O turno anterior não terminal MAIS ANTIGO da stream do alvo — o que está
 * bloqueando.
 *
 * Só o caminho de FRACASSO do claim usa isto, e o motivo é diagnóstico: sem
 * ele, `not_head` diria "esta conversa está com fila" e nada mais, e as duas
 * causas com remediações opostas — "o anterior vai avançar sozinho" e "o
 * anterior está preso no outbox e nenhum claim o move" — seriam o mesmo
 * evento. Devolve `id` e `status`; nunca `stream_key`, que a issue-mãe
 * restringe a log protegido.
 *
 * O alvo entra como JOIN (`agent_turns AS alvo`) em vez de valores lidos antes:
 * ler `stream_key`/`first_ingress_seq` numa consulta e compará-los na seguinte
 * abriria a janela em que o turno muda entre as duas, e a explicação do
 * fracasso passaria a descrever um estado que já não existe.
 */
export function earlierLiveTurnProbe(input: {
  tenant: SQL;
  agent: SQL;
  turn_id: string;
}): SQL {
  const alvo = sql`alvo`;
  return sql`
    SELECT anterior.id, anterior.status
      FROM ${agent_turns} AS alvo
      JOIN ${agent_turns} AS anterior
        ON ${anterioresNaoTerminais({ tenant: input.tenant, agent: input.agent, alvo })}
     WHERE alvo.tenant_id = ${input.tenant}
       AND alvo.agent_id  = ${input.agent}
       AND alvo.id        = ${input.turn_id}
     ORDER BY anterior.first_ingress_seq
     LIMIT 1`;
}
