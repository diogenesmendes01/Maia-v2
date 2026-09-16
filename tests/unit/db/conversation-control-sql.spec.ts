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
import {
  lockControlByIdSql,
  lockControlByRunSql,
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
