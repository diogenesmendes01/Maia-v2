/**
 * P04.3a (spec §8.2.3 passo 3) — o SQL de trancamento de `conversation_controls`,
 * num módulo PURO e com UM só dono.
 *
 * ─── Por que este arquivo existe ───────────────────────────────────────────
 *
 * O §8.2.3 passo 3 manda aplicar uma ordem global de locks
 * (**controle → exclusão/ordenação existente da stream → turnos → efeito/outbox**)
 * e diz em letras: "não introduzir dois ordenamentos incompatíveis".
 *
 * Hoje o trancamento do controle é uma função PRIVADA de
 * `src/db/repositories/engine-repos.ts` (`lockControl`), com 16 call sites. O
 * `pauseConversationTx` do §8.2.3 precisa trancar a MESMA linha, e tem três
 * saídas: copiar o SQL (duas cópias divergem, e a divergência só aparece sob
 * concorrência), importar do repositório do journal (inverteria a dependência —
 * controle é o PRIMEIRO degrau da ordem, e o journal é quem o consome), ou
 * extrair para um módulo compartilhado. A terceira é a que a casa já usa duas
 * vezes, por esta razão exata: `turn-fence-sql.ts` (#504) e `stream-head-sql.ts`
 * (#626) existem porque `turn-repos.ts` importa `../client.js`, que constrói o
 * `pg.Pool` no import — enquanto o predicado morasse lá dentro, a única prova
 * possível seria um teste de integração, e um teste de integração que não roda
 * não prova nada.
 *
 * ─── E por que este teste NÃO é um espelho ─────────────────────────────────
 *
 * Ele importa os MESMOS construtores que a produção chama e os compila com o
 * dialeto real do Drizzle. O SQL afirmado abaixo é, caractere por caractere, o
 * que o PostgreSQL recebe. Um teste que remontasse o SQL com o próprio harness
 * passaria mesmo que o call site de produção fosse deletado — é a forma mais
 * fácil de escrever um teste que não prova nada, e o cabeçalho de
 * `turn-fence-sql.spec.ts` já nomeia essa armadilha.
 *
 * `sqlToQuery` é puro: não precisa de Postgres. É de propósito — a prova do
 * lock não pode depender de infraestrutura que pode estar fora do ar justamente
 * quando alguém mexe nele.
 */
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql as raw } from "drizzle-orm";
import {
  heldBacklogForCancellationSql,
  lockControlByIdSql,
  lockControlByRunSql,
  turnWithoutPendingEffectSql,
} from "@/db/repositories/conversation-control-sql.js";

const dialect = new PgDialect();

/** Normaliza o whitespace para as asserções falarem de SQL, não de indentação. */
function compilar(fragmento: ReturnType<typeof lockControlByIdSql>) {
  const q = dialect.sqlToQuery(fragmento);
  return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
}

const ESCOPO = { tenant_id: "acme", agent_id: "financeiro" };
const CONTROL_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

describe("P04.3a — trancamento do controle POR ID", () => {
  const q = () => compilar(lockControlByIdSql({ ...ESCOPO, control_id: CONTROL_ID }));

  it("1. tranca a linha: sem `FOR UPDATE` não há exclusão nenhuma", () => {
    // Sem esta cláusula o `SELECT` é um retrato, não um lock. Duas transações
    // leriam o mesmo `control_epoch` e as duas escreveriam por cima — que é o
    // ABA que o §8.2.2 manda impedir com epoch.
    expect(q().sql).toContain("FOR UPDATE");
  });

  it("2. o escopo entra como PARÂMETRO, nos dois eixos", () => {
    const { sql, params } = q();
    expect(sql).toContain("tenant_id");
    expect(sql).toContain("agent_id");
    // Escopo interpolado como literal seria injeção e impediria o plano cacheado.
    expect(params).toContain("acme");
    expect(params).toContain("financeiro");
    expect(params).toContain(CONTROL_ID);
  });

  it("3. o epoch sai como TEXTO, não como número", () => {
    // `control_epoch` é bigint. Materializar como number perderia precisão
    // acima de 2^53, e o contrato do §8.3.2 serializa epoch como decimal em
    // string justamente por isso.
    expect(q().sql).toContain("::text");
  });
});

describe("P04.3a — trancamento do controle PELO RUN", () => {
  const q = () => compilar(lockControlByRunSql({ ...ESCOPO, run_id: RUN_ID }));

  it("4. junta `engine_runs` pelo escopo COMPLETO, não só pelo id", () => {
    // Um join só por `control_id` cruzaria tenants se dois escopos tivessem o
    // mesmo uuid. O escopo é predicado, não decoração.
    //
    // ⚠️ A primeira versão deste caso fazia `toMatch(/tenant_id[\s\S]*agent_id/)`
    // e era uma checagem de PRESENÇA, não de estrutura: a varredura por mutação
    // provou que ela sobrevivia tanto a tirar `agent_id` do `WHERE` quanto a
    // reduzir o join a `ON r.control_id = c.id` — nos dois casos as palavras
    // continuavam no SQL noutro ponto e o regex casava. Mesmo defeito do caso
    // vacuoso que a unidade anterior (U-P04.2) me obrigou a corrigir, cometido
    // de novo. As duas asserções abaixo o substituem, e cada uma mata uma das
    // duas mutações.
    const { sql, params } = q();
    expect(sql).toContain("conversation_controls");
    expect(sql).toContain("engine_runs");

    // (a) MATA "tirar o escopo do WHERE": sem `agent_id` interpolado, o valor
    // desaparece dos parâmetros. Afirmar sobre PARÂMETRO é mais forte do que
    // sobre texto, porque só o que é interpolado vira parâmetro.
    expect(params).toContain("acme");
    expect(params).toContain("financeiro");
    expect(params).toContain(RUN_ID);

    // (b) MATA "join só por control_id": o escopo tem de aparecer DUAS vezes em
    // cada eixo — uma no `ON` (pertencimento do run ao controle) e outra no
    // `WHERE` (o escopo corrente). Reduzir o join derruba a contagem para 1.
    const ocorrencias = (agulha: string) => sql.split(agulha).length - 1;
    expect(ocorrencias("tenant_id")).toBeGreaterThanOrEqual(2);
    expect(ocorrencias("agent_id")).toBeGreaterThanOrEqual(2);
  });

  it("5. tranca SÓ o controle — `FOR UPDATE OF c`, nunca `FOR UPDATE` pelado", () => {
    // ESTA é a garantia substantiva do arquivo. Num join, `FOR UPDATE` sem
    // `OF` tranca TODAS as tabelas da consulta: o controle E `engine_runs`.
    // Isso adicionaria uma aresta de lock sobre o run ANTES do controle, que é
    // exatamente o "segundo ordenamento incompatível" que o §8.2.3 passo 3
    // proíbe — e o §5.6.3 já fixou a ordem inversa (controle → turno → run).
    // O deadlock resultante só apareceria sob concorrência real.
    const { sql } = q();
    expect(sql).toContain("FOR UPDATE OF");
    expect(sql).not.toMatch(/FOR UPDATE\s*$/);
  });
});

describe("P04.3a — os dois construtores concordam no que produzem", () => {
  it("6. ambos selecionam as MESMAS três colunas", () => {
    // O consumidor tipa uma linha só (`ConversationControlLockRow`). Se as duas
    // formas devolvessem colunas diferentes, um dos caminhos quebraria em
    // runtime com o tipo satisfeito — o pior dos dois mundos.
    const a = compilar(lockControlByIdSql({ ...ESCOPO, control_id: CONTROL_ID })).sql;
    const b = compilar(lockControlByRunSql({ ...ESCOPO, run_id: RUN_ID })).sql;
    for (const coluna of ["id", "mode", "control_epoch"]) {
      expect(a).toContain(coluna);
      expect(b).toContain(coluna);
    }
  });

  it("7. nenhum dos dois vaza `SELECT *`", () => {
    // `SELECT *` sob `FOR UPDATE` traria colunas que ninguém leu e tornaria o
    // contrato da linha implícito; a casa materializa colunas nomeadas.
    expect(compilar(lockControlByIdSql({ ...ESCOPO, control_id: CONTROL_ID })).sql)
      .not.toContain("*");
    expect(compilar(lockControlByRunSql({ ...ESCOPO, run_id: RUN_ID })).sql)
      .not.toContain("*");
  });
});

// ─── P04.5b.2a — a SELEÇÃO do backlog a cancelar, e a evidência POR TURNO ────
//
// O §8.2.5 fixa o mapeamento: "turnos `received/queued/retryable` retidos pelo
// controle, **sem execução/efeito pendente** e **anteriores ou iguais ao
// watermark**, terminam em `ignored` + `operator_cancelled`".
//
// São três conjunções, e cada uma tem caso próprio abaixo. A terceira é a que
// mais engana: a prova de drenagem que já existe (`reconcilePauseTx`) é escopada
// por CONTROLE — ela responde "esta CONVERSA tem algo em voo?", não "este TURNO
// tem efeito pendente?". Reusá-la aqui conflataria as duas perguntas, e é por
// isso que existe um construtor novo em vez de uma chamada à consulta antiga.

const WATERMARK = "42";

describe("P04.5b.2a — seleção do backlog retido", () => {
  const q = () =>
    compilar(
      heldBacklogForCancellationSql({
        ...ESCOPO,
        control_id: CONTROL_ID,
        watermark: WATERMARK,
      }),
    );

  it("8. tranca em ordem DETERMINÍSTICA: `ORDER BY` + `FOR UPDATE OF t`", () => {
    // O §8.2.3 passo 3 manda "turnos em ordem determinística" dentro da ordem
    // global de locks. O precedente da casa é `recoverExpiredStreamClaims`, que
    // documenta por quê: sem `ORDER BY` two transações que toquem a mesma stream
    // adquirem conjuntos em ordens diferentes e podem fechar ciclo.
    //
    // `FOR UPDATE OF t` e não `FOR UPDATE` pelado pela MESMA razão do caso 5:
    // a consulta junta `conversation_controls`, e um lock pelado trancaria o
    // controle de novo por um segundo caminho — o "ordenamento incompatível".
    const { sql } = q();
    expect(sql).toContain("ORDER BY");
    expect(sql).toContain("FOR UPDATE OF");
    expect(sql).not.toMatch(/FOR UPDATE\s*$/);
  });

  it("9. os três estados de origem entram como LITERAIS, e `running` fica de FORA", () => {
    // Literais, e não parâmetros, pela razão que `stream-head-sql.ts` documenta:
    // o planejador só prova que a cláusula implica o predicado de um índice
    // parcial quando os dois lados são `Const`.
    //
    // E `running` FORA é a metade que importa: ele tem aresta AUTOMÁTICA para
    // `ignored`, então um conjunto montado por `sourceStatusesFor('ignored',
    // {manual:true})` o traria junto — e cancelar administrativamente um turno
    // EM EXECUÇÃO é o oposto do "sem execução/efeito pendente" da spec. O caso
    // do contrato (P04.5b.1) prende a origem da pegadinha; este prende a
    // consequência no SQL que de fato roda.
    const { sql } = q();
    for (const estado of ["'received'", "'queued'", "'retryable'"]) {
      expect(sql).toContain(estado);
    }
    for (const proibido of ["'running'", "'claimed'", "'outbound_pending'"]) {
      expect(sql).not.toContain(proibido);
    }
  });

  it("10. a stream vem do CONTROLE, e o escopo entra como PARÂMETRO nos dois eixos", () => {
    // O caller passa `control_id`, nunca `stream_key`: deixar a stream vir de
    // fora permitiria cancelar o backlog de uma conversa com o comando de outra.
    // Afirmo sobre PARÂMETRO, e não sobre texto, pela lição do caso 4 — presença
    // de palavra sobrevive a mutação, parâmetro interpolado não.
    const { sql, params } = q();
    expect(params).toContain("acme");
    expect(params).toContain("financeiro");
    expect(params).toContain(CONTROL_ID);
    expect(params).not.toContain("stream_key");
    expect(sql).toContain("conversation_controls");
  });

  it("11. o watermark é `<=` e EXIGE sequência: turno sem ingresso fica de fora", () => {
    // `future_only` compara ingressos. Um turno sem sequência (caminho de
    // compatibilidade, C50) não é "anterior" nem "posterior" ao watermark — e
    // `NULL <= 42` é NULL, que já o excluiria. A guarda explícita existe para
    // que a exclusão seja uma DECISÃO legível, e não um efeito colateral da
    // semântica de NULL que alguém "simplifica" depois.
    const { sql, params } = q();
    expect(sql).toMatch(/last_ingress_seq\s*<=/);
    expect(sql).toMatch(/last_ingress_seq IS NOT NULL/);
    expect(params).toContain(WATERMARK);
    // E nunca `<`: o watermark é o último ingresso RETIDO, então ele próprio
    // entra no descarte. `<` deixaria exatamente uma mensagem para trás.
    expect(sql).not.toMatch(/last_ingress_seq\s*<[^=]/);
  });

  it("12. projeção MÍNIMA: só o que o CAS precisa, e nunca a `stream_key`", () => {
    // `state_version` vem junto porque a transição é compare-and-swap por turno;
    // lê-la numa segunda consulta abriria a janela em que o turno muda entre as
    // duas. `stream_key` é restrita a log protegido pela issue-mãe da #505 —
    // ela aparece no JOIN, mas não pode SAIR da consulta.
    const { sql } = q();
    const projecao = sql.slice(0, sql.toLowerCase().indexOf(" from "));
    expect(projecao).toContain("id");
    expect(projecao).toContain("state_version");
    expect(projecao).not.toContain("stream_key");
    expect(sql).not.toContain("*");
  });
});

describe("P04.5b.2a — evidência de efeito POR TURNO", () => {
  const alvo = { tenant: raw`${"acme"}`, agent: raw`${"financeiro"}`, alvo: raw`t` };
  const p = () => compilar(turnWithoutPendingEffectSql(alvo));

  it("13. é `NOT EXISTS` sobre run ABERTO, call NÃO liquidada e evidência `unknown`", () => {
    // As três fontes que a reconciliação já usa (C42), aqui reancoradas ao
    // TURNO. O journal de efeitos que o §8.2.3 pressupõe não existe; esta é a
    // composição que dá para provar hoje, e ela é declarada como composição.
    const { sql } = p();
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("engine_runs");
    expect(sql).toContain("engine_tool_calls");
    expect(sql).toMatch(/phase <> 'closed'/);
    expect(sql).toMatch(/effect_evidence = 'unknown'/);
  });

  it("14. o predicado é ancorado no TURNO, não no controle", () => {
    // ESTA é a distinção que justifica o construtor existir. A consulta de
    // drenagem da reconciliação filtra por `r.control_id`, respondendo sobre a
    // CONVERSA inteira; se este predicado fizesse o mesmo, um único run aberto
    // em qualquer turno da conversa impediria o cancelamento de TODO o backlog —
    // e, pior, um backlog sem efeito nenhum seria preservado por causa de um
    // turno alheio. A âncora é `turn_id`, e `control_id` não aparece.
    const { sql } = p();
    expect(sql).toMatch(/turn_id\s*=\s*t\.id/);
    expect(sql).not.toContain("control_id");
  });

  it("15. a seleção USA o predicado — uma definição, não duas", () => {
    // A regra da casa, repetida em `turn-fence-sql.ts` e `stream-head-sql.ts`:
    // duas cópias do mesmo predicado divergem, e a divergência só aparece no
    // caminho que ninguém exercita. Se a seleção montasse a evidência à mão, a
    // correção de uma delas deixaria a outra para trás.
    const selecao = compilar(
      heldBacklogForCancellationSql({
        ...ESCOPO,
        control_id: CONTROL_ID,
        watermark: WATERMARK,
      }),
    ).sql;
    const predicado = p().sql;
    // O núcleo do predicado tem de aparecer LITERALMENTE dentro da seleção.
    const nucleo = predicado.slice(predicado.indexOf("NOT EXISTS"));
    expect(selecao).toContain(nucleo.slice(0, 60));
  });
});
