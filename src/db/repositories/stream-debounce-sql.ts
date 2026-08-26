/**
 * Issue #628 (fatia E da #505) — a FRONTEIRA do batch de debounce, num módulo
 * PURO.
 *
 * ─── A pergunta que este arquivo responde, e por que ela é a issue inteira ─
 *
 * A issue-mãe lista, entre os riscos: *"debounce distribuído é suscetível a
 * bordas temporais mal definidas"*, e a filha exige que *"a borda escolhida
 * esteja escrita"*. Este arquivo é onde ela está escrita — em SQL, e não em
 * prosa, porque uma borda descrita num comentário e implementada em outro lugar
 * é exatamente a borda mal definida.
 *
 * ─── A BORDA, em três frases ──────────────────────────────────────────────
 *
 *  1. **O que entra no batch é decidido sob o MUTEX DA STREAM.** O mutex é a
 *     linha de `agent_stream_sequences` daquela stream — a MESMA que
 *     `allocateIngressSeq` tranca (com `INSERT … ON CONFLICT DO UPDATE`) para
 *     alocar `ingress_seq`, e que o PostgreSQL segura até o COMMIT do ingresso.
 *     Consequência: enquanto QUALQUER ingresso da stream estiver em voo, o
 *     fechamento não começa. Não existe instante em que o fechador enxergue a
 *     sequência 7 e não enxergue a 6 — a lacuna que a issue proíbe absorver
 *     silenciosamente é IMPOSSÍVEL, e não apenas improvável.
 *
 *  2. **Um ingresso que COMITA antes de o fechador pegar o mutex entra no batch
 *     atual; um que comita depois entra no PRÓXIMO.** É uma borda de
 *     SERIALIZAÇÃO, não de relógio: ela não depende de quanto tempo a
 *     transação levou, de skew entre réplicas, nem da ordem em que os
 *     `Date.now()` foram lidos. Uma borda de relógio ("mensagens até
 *     `deadline`") teria de responder "e a que chegou 1 ms depois do prazo, mas
 *     cujo COMMIT foi antes?" — e qualquer resposta a essa pergunta é
 *     arbitrária.
 *
 *  3. **O batch é um PREFIXO CONTÍGUO, nunca um conjunto esparso.** Ver
 *     `debounceBatchPrefix`. Se a sequência 5 da stream não é elegível ao
 *     debounce (é mídia, ou já é terminal), o batch fecha em 4 — 6 e 7 esperam
 *     o próximo. Absorver 6 por cima de 5 é reordenação, que é a falha nº 1 da
 *     issue-mãe produzida pela própria agregação.
 *
 * ─── Por que PURO (a mesma razão de `stream-head-sql.ts`) ─────────────────
 *
 * `turn-repos.ts` importa `../client.js`, que constrói o `pg.Pool` no import e
 * exige `DATABASE_URL`. Enquanto a regra morar lá, a única prova possível de
 * que ela existe é um teste de integração — e um teste de integração que não
 * roda (Postgres fora do ar) não prova nada. Aqui o SQL sai de função pura,
 * então `new PgDialect().sqlToQuery(...)` compila o SQL REAL sem banco, e
 * `tests/unit/runtime/stream-debounce-contract.spec.ts` falha no minuto em que
 * a borda for reescrita.
 */
import { sql, type SQL } from 'drizzle-orm';
import { agent_turns, agent_stream_sequences } from '../schema.js';
import { TERMINAL_TURN_STATUSES } from '@/runtime/turns/contract.js';

/**
 * Os terminais como LITERAIS SQL, pela MESMA razão de `stream-head-sql.ts`: o
 * PostgreSQL só prova que a cláusula da consulta implica o predicado de um
 * índice parcial quando os dois lados são `Const`. Com `$1..$4` a prova depende
 * de o planejador ter substituído os parâmetros — o que ele deixa de fazer ao
 * cachear um plano genérico, e a degradação aparece só depois da sexta execução
 * da mesma sessão.
 *
 * A guarda existe para que isso continue verdadeiro se alguém acrescentar um
 * estado ao contrato.
 */
function terminaisLiterais(): SQL {
  for (const s of TERMINAL_TURN_STATUSES) {
    if (!/^[a-z_]+$/.test(s)) {
      throw new Error(
        `stream-debounce-sql: estado '${s}' não é um identificador simples e não pode ser ` +
          'inlinado como literal SQL. Os estados vêm de src/runtime/turns/contract.ts e ' +
          'precisam continuar sendo [a-z_]+.',
      );
    }
  }
  return sql.raw(TERMINAL_TURN_STATUSES.map((s) => `'${s}'`).join(', '));
}

/**
 * O MUTEX DA STREAM, trancado com `SKIP LOCKED`.
 *
 * ─── Por que a linha de `agent_stream_sequences`, e não a do turno ────────
 *
 * Porque ela já É o ponto de serialização do ingresso: `allocateIngressSeq`
 * (turn-repos.ts) faz `INSERT … ON CONFLICT DO UPDATE … RETURNING` nela para
 * alocar `ingress_seq`, e o PostgreSQL segura o lock de linha até o COMMIT da
 * transação do ingresso. Trancar a MESMA linha aqui faz o fechamento e o
 * ingresso serem mutuamente exclusivos POR CONSTRUÇÃO, sem nenhum lock novo e
 * sem nenhuma disciplina a lembrar. É de onde sai a borda nº 1 do cabeçalho.
 *
 * ─── Por que `SKIP LOCKED` AQUI e `FOR UPDATE` puro na eleição do head ────
 *
 * Esta é a distinção que mais importa neste arquivo, e errá-la produz
 * reordenação silenciosa.
 *
 * AQUI `SKIP LOCKED` é correto e é o que a issue pede: pular significa "esta
 * stream está sendo escrita agora; volto no próximo tick". Nada se perde — a
 * janela continua vencida e o varredor a reencontra —, e o fechador não fica
 * preso atrás de uma transação de ingresso lenta, nem forma convoy quando
 * várias réplicas varrem juntas. É também o que dá o *fechamento único* de
 * graça: das duas réplicas que tentem a MESMA stream ao mesmo tempo, uma pega
 * o mutex e a outra sai sem linha nenhuma.
 *
 * Na eleição do HEAD (`debounceBatchPrefix`) `SKIP LOCKED` seria um DEFEITO:
 * com `ORDER BY first_ingress_seq`, pular a linha trancada elegeria o SEGUNDO
 * turno da fila como se fosse o primeiro — e o batch fecharia por cima do head,
 * respondendo M2 antes de M1. Lá dentro já somos donos do mutex da stream,
 * então não há contenção a evitar: `FOR UPDATE` puro é seguro e é o único
 * correto.
 */
export function lockStreamForDebounce(input: {
  tenant: SQL;
  agent: SQL;
  stream_key: SQL;
}): SQL {
  return sql`
    SELECT s.stream_key
      FROM ${agent_stream_sequences} AS s
     WHERE s.tenant_id  = ${input.tenant}
       AND s.agent_id   = ${input.agent}
       AND s.stream_key = ${input.stream_key}
       FOR UPDATE SKIP LOCKED`;
}

/**
 * O CONJUNTO DE MEMBROS de uma janela ABERTA — as condições, num lugar só.
 *
 * Um turno é membro em potencial da janela desta stream quando ele:
 *
 *   * pertence à stream, no escopo (tenant, agent) — embutir tenant/agent no
 *     material canônico da `stream_key` não é escopar (ver #626);
 *   * tem posição na ordem (`first_ingress_seq IS NOT NULL`);
 *   * teve janela ABERTA no próprio ingresso (`debounce_window_opened_at`) — é
 *     o que exclui MÍDIA, que nunca passa pelo debounce;
 *   * ainda não foi fechado (`debounce_closed_at IS NULL`);
 *   * não é terminal — um turno concluído, ignorado ou absorvido não compõe
 *     rajada nenhuma.
 *
 * Existe como função porque DOIS caminhos precisam exatamente do mesmo
 * conjunto: o que ARMA a janela (recalcula o prazo de todos os membros a cada
 * ingresso novo) e o que a FECHA (`debounceBatchPrefix`). Escrever as condições
 * duas vezes é como o armador e o fechador acabam discordando sobre quem está
 * na janela — e a discordância se manifesta como um turno com prazo que ninguém
 * fecha, ou um batch que absorve um irmão que nunca foi armado.
 */
export function openDebounceWindowMembers(input: {
  tenant: SQL;
  agent: SQL;
  stream_key: SQL;
  alvo: SQL;
}): SQL {
  return sql`${input.alvo}.tenant_id  = ${input.tenant}
         AND ${input.alvo}.agent_id   = ${input.agent}
         AND ${input.alvo}.stream_key = ${input.stream_key}
         AND ${input.alvo}.first_ingress_seq IS NOT NULL
         AND ${input.alvo}.debounce_window_opened_at IS NOT NULL
         AND ${input.alvo}.debounce_closed_at IS NULL
         AND ${input.alvo}.status NOT IN (${terminaisLiterais()})`;
}

/**
 * **A BORDA.** O PREFIXO CONTÍGUO de turnos da stream que compõem o batch.
 *
 * ─── O conjunto de partida ────────────────────────────────────────────────
 *
 * Turnos da stream que (a) têm janela de debounce (`debounce_window_opened_at`
 * carimbado no próprio ingresso — mídia nunca recebe, então mídia nunca é
 * membro), (b) ainda não foram fechados, e (c) não são terminais. Ordenados por
 * `first_ingress_seq`, que é a ordem canônica da #505 — nunca `created_at`, que
 * a issue-mãe proíbe como fonte primária ("timestamps não são fonte primária de
 * ordenação").
 *
 * ─── O corte de CONTIGUIDADE, e por que ele não é zelo ────────────────────
 *
 * `LAG(last_ingress_seq)` compara cada candidato com o ANTERIOR do conjunto. Se
 * `first_ingress_seq <> anterior.last_ingress_seq + 1`, existe pelo menos uma
 * sequência entre os dois que NÃO está no conjunto — isto é, um ingresso da
 * mesma conversa que não é elegível ao debounce (mídia) ou que já foi consumido
 * por outro turno. O batch PARA ali.
 *
 * Sem esse corte, "M1(texto) M2(áudio) M3(texto)" fecharia um batch {M1, M3}: a
 * resposta ao áudio sairia DEPOIS de uma resposta que já incorporou o que veio
 * depois dele. É a inversão da falha nº 1 da issue-mãe, produzida pela
 * agregação — e ela é silenciosa, porque nenhuma linha do banco ficaria
 * inconsistente.
 *
 * A issue diz a mesma coisa por outras palavras: *"lacunas não podem ser
 * absorvidas silenciosamente se houver ingresso anterior ainda elegível"*.
 *
 * ─── Por que `MIN(rn)` e não um `WHERE` linha a linha ─────────────────────
 *
 * A quebra é uma propriedade do PREFIXO, não da linha: o candidato 4 pode ser
 * contíguo com o 3 e ainda assim estar FORA do batch, porque a quebra
 * aconteceu no 2. Filtrar linha a linha (`first = lag + 1`) devolveria um
 * conjunto esparso com o mesmo defeito que o corte existe para impedir. Daí o
 * `MIN(rn)` da primeira quebra e o `rn <` sobre ele.
 *
 * O head (`rn = 1`) tem `LAG` nulo e portanto NUNCA é a quebra — ele é membro
 * do batch por construção, o que é o mesmo que dizer que o batch nunca é vazio
 * quando existe janela aberta.
 *
 * ─── Por que a CTE `travados` existe SEPARADA ─────────────────────────────
 *
 * Não é organização: o PostgreSQL RECUSA `FOR UPDATE` numa consulta que usa
 * FUNÇÃO DE JANELA (*"FOR UPDATE is not allowed with window functions"*), e
 * `ROW_NUMBER`/`LAG` são o coração do corte de contiguidade. Então o lock sai
 * numa CTE própria, sem janela, e a numeração roda sobre o conjunto já
 * trancado — mesmo statement, mesmo snapshot.
 *
 * O lock de linha cobre o que o mutex da stream NÃO cobre: uma
 * conclusão/absorção concorrente vinda do EXECUTOR de um turno desta stream,
 * que não passa por `agent_stream_sequences`. Sem ele, um membro poderia virar
 * terminal entre a leitura e o UPDATE do fechamento — e o CAS por
 * `state_version` devolveria "não fechei" sem que ninguém soubesse por quê.
 *
 * `ORDER BY t.id` na CTE de lock (e não `first_ingress_seq`) é ordem de
 * AQUISIÇÃO, pela mesma razão da CTE `ativos` de `recoverExpiredStreamClaims`:
 * duas transações que travem o mesmo conjunto na mesma ordem não fecham ciclo.
 */
export function debounceBatchPrefix(input: {
  tenant: SQL;
  agent: SQL;
  stream_key: SQL;
}): SQL {
  return sql`
    WITH travados AS MATERIALIZED (
      SELECT t.id
        FROM ${agent_turns} AS t
       WHERE ${openDebounceWindowMembers({ ...input, alvo: sql`t` })}
       ORDER BY t.id
         FOR UPDATE OF t
    ),
    candidatos AS MATERIALIZED (
      SELECT t.id,
             t.status,
             t.representative_message_id,
             t.conversa_id,
             t.first_ingress_seq,
             t.last_ingress_seq,
             t.state_version,
             t.debounce_deadline_at,
             ROW_NUMBER() OVER (ORDER BY t.first_ingress_seq) AS rn,
             LAG(t.last_ingress_seq) OVER (ORDER BY t.first_ingress_seq) AS anterior_last
        FROM ${agent_turns} AS t
        JOIN travados ON travados.id = t.id
       WHERE ${openDebounceWindowMembers({ ...input, alvo: sql`t` })}
    ),
    quebra AS (
      SELECT MIN(c.rn) AS rn
        FROM candidatos c
       WHERE c.anterior_last IS NOT NULL
         AND c.first_ingress_seq <> c.anterior_last + 1
    )
    SELECT c.id, c.status, c.representative_message_id, c.conversa_id,
           c.first_ingress_seq, c.last_ingress_seq, c.state_version,
           c.debounce_deadline_at, c.rn
      FROM candidatos c
     WHERE c.rn < COALESCE((SELECT q.rn FROM quebra q), 9223372036854775807)
     ORDER BY c.first_ingress_seq`;
}

/**
 * A janela do turno-cabeça está VENCIDA?
 *
 * O predicado é `debounce_deadline_at <= now()` avaliado NO BANCO, e essa é a
 * exigência literal da issue (*"timeout calculado com relógio persistente, não
 * com timer do processo"*). Um `Date.now()` de réplica compararia o prazo
 * gravado por OUTRA réplica com o relógio DESTA — e o skew entre elas decidiria
 * o fechamento. É o mesmo raciocínio de `lease_expires_at > now()` no fence do
 * claim (#504): existe um relógio só, e ele é o do PostgreSQL.
 *
 * `debounce_deadline_at` vive apenas no turno-CABEÇA (os demais membros do
 * batch carregam só `debounce_window_opened_at`), então esta condição é sobre a
 * mesma linha que `debounceBatchPrefix` devolve como `rn = 1`.
 */
export function debounceWindowDue(alvo: SQL): SQL {
  return sql`(${alvo}.debounce_deadline_at IS NOT NULL AND ${alvo}.debounce_deadline_at <= now())`;
}

/**
 * O PRAZO, recalculado: `LEAST(agora + janela, abertura + teto)`.
 *
 * Duas metades, e as duas são exigência da issue:
 *
 *  - `now() + delay` é o RESET: cada mensagem nova adia o fechamento, que é o
 *    debounce fazendo o que ele existe para fazer (agrupar a digitação
 *    picotada);
 *  - `abertura + max_hold` é o TETO: um usuário que digita sem parar não adia a
 *    resposta para sempre. O teto é ancorado em `debounce_window_opened_at`, um
 *    dado PERSISTIDO, e não no `first_enqueued_at` que o Redis guardava — é o
 *    que faz o teto sobreviver ao reinício do processo que abriu a janela.
 *
 * `LEAST` porque o TETO vence: passado `abertura + max_hold`, o prazo fica no
 * passado e o próximo tick do varredor fecha, por mais que o usuário continue
 * digitando. Note que o resultado pode ser MENOR que o prazo anterior — é o
 * comportamento certo (o teto aproxima o fechamento), e o oposto do que um
 * `GREATEST` faria.
 *
 * Diferença de comportamento em relação ao debouncer em memória, e ela é
 * DELIBERADA: lá, ultrapassar o teto devolvia `max_hold_passthrough` e deixava
 * o job antigo disparar no horário original, de modo que a mensagem nova só
 * seria varrida na rodada seguinte. Aqui o teto simplesmente FECHA o batch
 * agora, com a mensagem nova dentro — não há passagem por fora, e a issue pede
 * exatamente isso ("ou entram no batch atual, ou no próximo — mas a regra é
 * explícita").
 *
 * Os dois intervalos entram como `make_interval(secs => …)` com o valor
 * PARAMETRIZADO. Interpolar milissegundos direto no texto do SQL faria de uma
 * variável de configuração um pedaço de sintaxe.
 */
export function debounceDeadlineExpression(input: {
  opened_at: SQL;
  delay_ms: number;
  max_hold_ms: number;
}): SQL {
  return sql`LEAST(
      now() + make_interval(secs => ${input.delay_ms / 1000}::double precision),
      ${input.opened_at} + make_interval(secs => ${input.max_hold_ms / 1000}::double precision)
    )`;
}
