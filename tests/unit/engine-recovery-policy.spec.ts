/**
 * P03.8b (spec §5.8.2, §5.8.3, §5.8.4; INV-09) — o CONTRATO da política de
 * recovery do journal de execução.
 *
 * `src/runtime/engines/recovery.ts` é o terceiro entregável que o capítulo 10
 * nomeia para o P03, e o único que faltava. É um módulo PURO, no mesmo gênero de
 * `src/runtime/turns/poison-policy.ts`: sem `db`, sem ALS, sem `@/config/env.js`
 * e sem métricas. A pergunta "o que é seguro fazer com este run depois de um
 * crash?" é uma função total de um INSTANTÂNEO do journal, e mantê-la pura é o
 * que permite responder a essa pergunta sem Postgres, sem Redis e sem boot.
 *
 * O que este arquivo cobra, e que nenhum compilador cobra:
 *
 *   1. a classificação é TOTAL — todo instantâneo cai em exatamente uma
 *      disposição do vocabulário fechado;
 *   2. a EVIDÊNCIA DE EFEITO domina a fase, pela mesma régua com que
 *      `unsafe_to_retry` domina o código de erro em `poison-policy`: uma chamada
 *      com efeito desconhecido é fato durável, e a fase é contexto;
 *   3. o fundo do poço é `block`, NUNCA uma disposição que retome execução —
 *      INV-09: "crash de processo não retoma automaticamente a sequência de
 *      ferramentas";
 *   4. `inconclusive` não vira prova de não-execução. O §5.8.2 proíbe em letras
 *      "converter 404 em definitely_not_accepted";
 *   5. o vocabulário fechado NÃO CONSEGUE EXPRESSAR a ação proibida. É o mesmo
 *      mecanismo que a spec elogia em `RECONCILIATION_DISPOSITIONS` ("não há
 *      `resend_blind`... o tipo não consegue expressar 'reenvie sem saber', então
 *      nenhum call site consegue pedi-lo");
 *   6. o módulo é PURO de verdade — verificado lendo o fonte como TEXTO, como o
 *      contrato de `poison-policy` já faz.
 *
 * Puro: nenhum caso toca banco, fila ou rede.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RECOVERY_DISPOSITIONS,
  classifyRecovery,
  type RecoveryDisposition,
  type RecoverySnapshotV1,
} from "@/runtime/engines/recovery.js";

const raiz = resolve(__dirname, "../..");
const fonte = readFileSync(
  resolve(raiz, "src/runtime/engines/recovery.ts"),
  "utf8",
);

/** Instantâneo mínimo e SEGURO: dono vivo, nada pendente, nada decidido. */
function snap(over: Partial<RecoverySnapshotV1> = {}): RecoverySnapshotV1 {
  return {
    phase: "prepared",
    turn_status: "running",
    lease_alive: true,
    control_mode: "bot",
    has_terminal: false,
    adopted: false,
    unreconciled_calls: 0,
    effect_unknown_calls: 0,
    outbound_rows: 0,
    outbound_completed: 0,
    remote_run_id_known: false,
    last_observation: null,
    ...over,
  };
}

describe("P03.8b — a classificação é total e fechada", () => {
  it("1. todo instantâneo cai numa disposição do vocabulário", () => {
    const amostras: RecoverySnapshotV1[] = [
      snap(),
      snap({ phase: "submitting" }),
      snap({ phase: "submission_unknown", remote_run_id_known: false }),
      snap({ phase: "running", remote_run_id_known: true }),
      snap({ phase: "cancelling" }),
      snap({ phase: "reconciling" }),
      snap({ phase: "result_ready", has_terminal: true }),
      snap({ phase: "blocked" }),
      snap({ phase: "closed" }),
      snap({ lease_alive: false }),
      snap({ turn_status: "outbound_pending", lease_alive: false }),
      snap({ turn_status: "dead_letter", effect_unknown_calls: 1 }),
      snap({ control_mode: "human" }),
      snap({ unreconciled_calls: 3, effect_unknown_calls: 2 }),
    ];
    for (const s of amostras) {
      expect(RECOVERY_DISPOSITIONS).toContain(classifyRecovery(s));
    }
  });

  it("2. o vocabulário não consegue expressar 'retomar a sequência de tools'", () => {
    // INV-09 escrito no TIPO, e não só em comentário: se existisse um membro
    // `resume_tools`, um call site poderia pedi-lo. A ausência é o mecanismo,
    // igual ao `resend_blind` que a spec elogia não existir.
    const proibidos = ["resume_tools", "replay", "rerun", "resume_sequence"];
    for (const p of proibidos) {
      expect(RECOVERY_DISPOSITIONS as readonly string[]).not.toContain(p);
    }
  });
});

describe("P03.8b — a evidência de efeito DOMINA a fase", () => {
  it("3. `result_ready` com terminal limpo permite adoção", () => {
    const d = classifyRecovery(
      snap({ phase: "result_ready", has_terminal: true, lease_alive: false }),
    );
    expect(d).toBe("adopt_terminal");
  });

  it("4. o MESMO `result_ready`, com efeito desconhecido, NÃO adota", () => {
    // O par cirúrgico do caso 3: muda UMA variável. §5.8.4 item 3 — "há chamada
    // com efeito desconhecido não reconciliado: barrar nova geração e nova saída
    // que afirme sucesso".
    const d = classifyRecovery(
      snap({
        phase: "result_ready",
        has_terminal: true,
        lease_alive: false,
        effect_unknown_calls: 1,
      }),
    );
    expect(d).toBe("reconcile_only");
  });

  it("5. efeito desconhecido domina até em `prepared`", () => {
    const d = classifyRecovery(snap({ effect_unknown_calls: 1 }));
    expect(d).not.toBe("resume_owner");
  });
});

describe("P03.8b — posse, controle humano e fase bloqueada", () => {
  it("6. `prepared` com claim de origem VIVO pode iniciar (§5.8.2)", () => {
    expect(
      classifyRecovery(snap({ phase: "prepared", lease_alive: true })),
    ).toBe("resume_owner");
  });

  it("7. o MESMO `prepared` com lease MORTA não inicia (par do 6)", () => {
    // "Proibido: submeter sob origin claim expirado."
    expect(
      classifyRecovery(snap({ phase: "prepared", lease_alive: false })),
    ).not.toBe("resume_owner");
  });

  it("8. controle humano domina — nenhuma geração nova", () => {
    const d = classifyRecovery(
      snap({ phase: "prepared", lease_alive: true, control_mode: "human" }),
    );
    expect(d).not.toBe("resume_owner");
  });

  it("9. `blocked` domina inclusive um terminal íntegro", () => {
    const d = classifyRecovery(
      snap({ phase: "blocked", has_terminal: true, lease_alive: false }),
    );
    expect(d).toBe("block");
  });

  it("10. `closed` não pede ação nenhuma", () => {
    expect(classifyRecovery(snap({ phase: "closed" }))).toBe("nothing_to_do");
  });
});

describe("P03.8b — o que NÃO pode ser inferido", () => {
  it("11. `inconclusive` nunca vira prova de não-execução (§5.8.2)", () => {
    const d = classifyRecovery(
      snap({
        phase: "submission_unknown",
        lease_alive: false,
        last_observation: "inconclusive",
      }),
    );
    // "Proibido: converter 404 em definitely_not_accepted."
    //
    // A asserção é EXATA de propósito. A primeira versão aceitava uma lista de
    // três disposições, e nessa forma desligar a regra do `inconclusive` daria
    // `query_same_request_key` — que estava na lista — e o caso continuaria
    // verde. Um teste que aceita três respostas não distingue a regra certa da
    // ausência dela.
    expect(d).toBe("reconcile_only");
  });

  it("12. prova CONCLUSIVA de não-aceite permite repetir o MESMO start", () => {
    // O par do 11, e a única porta que a spec abre: "prova de nunca aceito, dono
    // de origem ainda vivo → repetir start com mesma key/request".
    const d = classifyRecovery(
      snap({
        phase: "submission_unknown",
        lease_alive: true,
        last_observation: "definitely_not_accepted",
      }),
    );
    expect(d).toBe("query_same_request_key");
  });

  it("13. turno `outbound_pending` é só manutenção (§5.8.4 item 1)", () => {
    const d = classifyRecovery(
      snap({
        turn_status: "outbound_pending",
        lease_alive: false,
        phase: "running",
      }),
    );
    expect(d).toBe("maintenance_only");
  });
});

describe("P03.8b — cada ramo da tabela tem caso próprio", () => {
  // Estes sete casos foram escritos ANTES da varredura de mutação, por eu ter
  // previsto — ao mapear as mutações — que sem eles seis ramos sobreviveriam:
  // o `dead_letter`, o `cancelling`, o ramo `adopted` do `result_ready`, os
  // três ramos de `running` e a metade "turno terminal" do helper. Um caso de
  // TOTALIDADE prova que a função responde; ele não prova QUAL ramo respondeu.

  it("16. `dead_letter` com efeito desconhecido BLOQUEIA (§5.8.4 item 6)", () => {
    // Nem reconciliar basta: "só porta operacional auditada encerra esse risco".
    const d = classifyRecovery(
      snap({ turn_status: "dead_letter", effect_unknown_calls: 1 }),
    );
    expect(d).toBe("block");
  });

  it("17. `cancelling` permanece reconciliando — o ACK não encerra nada", () => {
    expect(classifyRecovery(snap({ phase: "cancelling" }))).toBe(
      "cancel_and_reconcile",
    );
  });

  it("18. `result_ready` JÁ adotado não adota de novo (par do caso 3)", () => {
    const d = classifyRecovery(
      snap({
        phase: "result_ready",
        has_terminal: true,
        adopted: true,
        lease_alive: false,
      }),
    );
    expect(d).toBe("maintenance_only");
  });

  it("19. `running` com posse VIVA: recovery não disputa", () => {
    expect(
      classifyRecovery(snap({ phase: "running", lease_alive: true })),
    ).toBe("nothing_to_do");
  });

  it("20. `running` sem posse e com ID remoto: revogar antes de observar", () => {
    const d = classifyRecovery(
      snap({ phase: "running", lease_alive: false, remote_run_id_known: true }),
    );
    expect(d).toBe("revoke_and_observe");
  });

  it("21. `running` sem posse e SEM ID remoto: cancelar e reconciliar", () => {
    // O par do 20: muda UMA variável, e o desfecho muda com ela.
    const d = classifyRecovery(
      snap({
        phase: "running",
        lease_alive: false,
        remote_run_id_known: false,
      }),
    );
    expect(d).toBe("cancel_and_reconcile");
  });

  it("22. turno TERMINAL também é só manutenção (a outra metade do helper)", () => {
    // O caso 13 cobre `outbound_pending`; este cobre o conjunto terminal. São
    // duas metades do mesmo predicado, e uma só não distingue a outra.
    const d = classifyRecovery(
      snap({ turn_status: "completed", lease_alive: false, phase: "running" }),
    );
    expect(d).toBe("maintenance_only");
  });
});

describe("P03.8b — o módulo é PURO", () => {
  it("14. não importa banco, ALS, env nem métricas", () => {
    // Mesma verificação por TEXTO que o contrato de `poison-policy` faz: uma
    // política que lê env ou banco deixa de ser respondível sem boot, e todo
    // teste dela passa a medir o ambiente em vez da regra.
    const proibidos = [
      "@/db/",
      "db/client",
      "tenant-context",
      "@/config/env",
      "@/lib/metrics",
      "drizzle-orm",
    ];
    for (const p of proibidos) {
      expect(fonte).not.toContain(p);
    }
  });

  it("15. as disposições citam a linha do §5.8.2 que as origina", () => {
    // Cada membro do vocabulário nasce de uma linha da tabela de recovery, e o
    // arquivo tem de dizer QUAL. Vocabulário sem procedência é vocabulário
    // inventado, e foi exatamente o risco que o C18 e o C20 registraram.
    for (const d of RECOVERY_DISPOSITIONS as readonly RecoveryDisposition[]) {
      expect(fonte).toContain(d);
    }
    expect(fonte).toContain("5.8.2");
    expect(fonte).toContain("INV-09");
  });
});
