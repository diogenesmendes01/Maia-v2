/**
 * P04.2 (spec §8.6.1 para os NOMES, §8.2.1 para os ESTADOS, §8.2.3 passo 4 para
 * a obrigação) — o CONTRATO das ações de auditoria do controle humano da
 * conversa.
 *
 * O §8.2.3 passo 4 exige gravar "comando e auditoria durável na MESMA
 * transação", via `auditTx`. Mas `auditTx` recebe `acao: AuditAction`, uma união
 * FECHADA — e varrendo os 300 membros que `AUDIT_ACTIONS` tinha ANTES desta
 * unidade (são 305 depois dela; medido em runtime, com zero duplicados, depois
 * de uma contagem minha por regex ter dito 337 porque o arquivo tem um SEGUNDO
 * array, `ACTION_KEYS`, com 32 entradas), com catorze termos (`pause`, `resume`,
 * `takeover`, `human`, `control`, `handoff`, `operator`, `bot`, `mode`,
 * `conversa`, `stream`, `block`, `lock`, …) nenhuma serve. Sem acrescentá-las,
 * `pauseConversationTx` não tem o que escrever, e a exigência da spec vira
 * intenção.
 *
 * PROCEDÊNCIA DOS NOMES — e um erro meu, registrado porque ele é o motivo de
 * metade destas asserções existirem. A primeira versão desta unidade INVENTOU
 * quatro nomes (`conversation_paused`, `conversation_pause_drained`,
 * `conversation_resumed`, `conversation_control_command_conflicted`). Só ao ler
 * o capítulo 8 na fonte, para a unidade SEGUINTE, apareceu a linha 2480 da spec
 * (§8.6.1, "NOVOS eventos de audit tipados") — o ÚNICO ponto da especificação
 * que nomeia evento de auditoria, e que já dava dez nomes. Os quatro
 * inventados foram substituídos pelos cinco normativos.
 *
 * O erro não foi só lexical. A spec separa `conversation_resume_requested` de
 * `conversation_automation_resumed`; eu tinha colapsado os dois num
 * `conversation_resumed` — depois de argumentar, para a pausa, que pedido e
 * efeito são fatos distintos. A régua que eu apliquei de um lado eu apaguei do
 * outro, e nenhum teste meu percebia. O caso 3 abaixo passou a cobrar a
 * simetria NOS DOIS SENTIDOS, e o caso 6 impede a reintrodução dos nomes
 * inventados.
 *
 * Por que CADA uma é uma linha própria, e não um `conversation_control_changed`
 * genérico com o modo no metadata: elas têm gravidade e autor diferentes, e
 * colapsá-las obrigaria todo consumidor (alerta, console, watcher) a reabrir o
 * JSON para saber o que aconteceu. A régua é a mesma que a casa já aplicou em
 * `stream_poisoned`/`stream_unblocked` e em `audit_mode_activated`/
 * `audit_mode_deactivated`.
 *
 * Puro: nenhum caso toca banco, fila ou rede.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AUDIT_ACTIONS } from "@/governance/audit-actions.js";

const raiz = resolve(__dirname, "../..");
const fonte = readFileSync(
  resolve(raiz, "src/governance/audit-actions.ts"),
  "utf8",
);

/** As cinco ações do §8.6.1 que pertencem ao controle humano da conversa. */
const ACOES_DE_CONTROLE = [
  "conversation_pause_requested",
  "conversation_control_acquired",
  "conversation_resume_requested",
  "conversation_automation_resumed",
  "conversation_control_conflict",
] as const;

/**
 * Os nomes que eu havia INVENTADO antes de achar o §8.6.1. Nenhum pode voltar:
 * o vocabulário é fechado e consumido por watcher/console, e um sinônimo
 * significaria a mesma decisão gravada sob dois rótulos.
 */
const NOMES_INVENTADOS_PROIBIDOS = [
  "conversation_paused",
  "conversation_pause_drained",
  "conversation_resumed",
  "conversation_control_command_conflicted",
] as const;

const registro = new Set<string>(AUDIT_ACTIONS);

describe("P04.2 — as ações de controle humano existem no vocabulário", () => {
  it("1. as cinco ações do §8.6.1 estão registradas", () => {
    for (const acao of ACOES_DE_CONTROLE) {
      expect(registro.has(acao), `ação "${acao}" ausente`).toBe(true);
    }
  });

  it("2. não colidem com o PEDIDO de handoff, que já existia", () => {
    // `owner_handoff_requested` é "precisa de humano". Nenhuma das cinco pode
    // ser apelido dela: o §8.2.1 separa o pedido da tomada, e a UI tem de
    // distinguir "precisa de humano" de "humano no controle".
    expect(registro.has("owner_handoff_requested")).toBe(true);
    for (const acao of ACOES_DE_CONTROLE) {
      expect(acao).not.toBe("owner_handoff_requested");
    }
  });

  it("3. pedido e efeito são ações distintas — nos DOIS sentidos", () => {
    // Este é o caso que teria pego o erro descrito no cabeçalho.
    //
    // PAUSA: `bot → pausing` é comando de OPERADOR e incrementa epoch;
    // `pausing → human` é o RECONCILIADOR confirmando que não há I/O
    // autorizado em aberto, e NÃO incrementa epoch de novo. O §8.2.3 diz em
    // letras que `pause` retorna "barreira estabelecida, drenagem pendente".
    //
    // RETOMADA: pelo §8.3.2 o resume "recusa enquanto houver efeitos/entregas
    // não conciliados". Logo existe um estado real em que o operador PEDIU e a
    // automação ainda NÃO voltou. Uma ação só apagaria esse estado — o mesmo
    // defeito que a separação do lado da pausa evita.
    const pares: ReadonlyArray<readonly [string, string]> = [
      ["conversation_pause_requested", "conversation_control_acquired"],
      ["conversation_resume_requested", "conversation_automation_resumed"],
    ];
    for (const [pedido, efeito] of pares) {
      expect(registro.has(pedido), `pedido "${pedido}" ausente`).toBe(true);
      expect(registro.has(efeito), `efeito "${efeito}" ausente`).toBe(true);
      expect(pedido).not.toBe(efeito);
    }
  });

  it("4. o vocabulário documenta a PROCEDÊNCIA de cada ação", () => {
    // Mesma régua que apliquei em `recovery.ts`: vocabulário sem procedência é
    // vocabulário inventado — literalmente, como o cabeçalho deste arquivo
    // registra. O fonte tem de citar a seção que ORIGINA os nomes (§8.6.1) e a
    // que define os estados que eles registram (§8.2.1).
    expect(fonte).toContain("8.6.1");
    expect(fonte).toContain("8.2.1");
    for (const acao of ACOES_DE_CONTROLE) {
      expect(fonte).toContain(acao);
    }
  });

  it("5. nenhuma ação de controle da conversa promete conteúdo no nome", () => {
    // A convenção da casa nas ações de stream é explícita: a row não carrega
    // `stream_key`, texto, prompt, telefone nem JID. Um nome como
    // `conversation_paused_with_reason_text` convidaria o contrário.
    //
    // Este caso varre o VOCABULÁRIO REAL, não a constante local acima. A
    // primeira versão iterava `ACOES_DE_CONTROLE` — os literais escritos neste
    // próprio arquivo — e a varredura por mutação provou que ela era VACUOSA:
    // renomear a ação no fonte para `..._message_text` matava os casos 1 e 3 e
    // deixava este PASSANDO, porque ele nunca olhava para o fonte. Uma
    // asserção que nenhuma mudança de código consegue derrubar é declaração de
    // intenção, não guarda de regressão.
    const doVocabulario = AUDIT_ACTIONS.filter(
      (a) =>
        a.startsWith("conversation_pause") ||
        a.startsWith("conversation_resum") ||
        a.startsWith("conversation_control") ||
        a.startsWith("conversation_automation"),
    );
    // Sem este piso, um filtro que deixasse de casar tornaria o laço abaixo
    // vacuoso de novo — o mesmo defeito, por outra porta.
    expect(doVocabulario.length).toBeGreaterThanOrEqual(
      ACOES_DE_CONTROLE.length,
    );
    for (const acao of doVocabulario) {
      expect(acao).not.toMatch(/text|body|conteudo|message|telefone|jid/i);
    }
  });

  it("6. os nomes inventados na primeira versão não voltam", () => {
    // Guarda de regressão contra o meu próprio erro. O vocabulário é fechado e
    // consumido por watcher e console; um sinônimo faria a MESMA decisão ser
    // gravada sob dois rótulos, e a pergunta "quantas conversas foram
    // pausadas?" passaria a ter duas respostas certas e diferentes.
    for (const proibido of NOMES_INVENTADOS_PROIBIDOS) {
      expect(
        registro.has(proibido),
        `"${proibido}" foi inventado antes de o §8.6.1 ser lido; use o nome normativo`,
      ).toBe(false);
    }
  });
});
