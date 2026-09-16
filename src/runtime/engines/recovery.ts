/**
 * P03.8b (spec §5.8.2, §5.8.3, §5.8.4; INV-09) — a POLÍTICA de recovery do
 * journal de execução, num módulo PURO.
 *
 * ─── A frase que este arquivo torna executável ──────────────────────────────
 *
 * INV-09: "crash de processo não retoma automaticamente a sequência de
 * ferramentas. A Maia reconcilia e cria nova tentativa apenas quando seguro."
 *
 * O §5.8.2 responde "o que é seguro?" com uma tabela de dezessete linhas —
 * ponto de queda, ação NOVA segura, e o que fica PROIBIDO. Este módulo é essa
 * tabela como função total, e nada além disso: ele não lê banco, não decide
 * quando rodar e não executa ação nenhuma. Quem executa compõe as operações que
 * já existem no repositório do journal (`engine-repos.ts`): revogar, adotar,
 * fechar, reservar manutenção.
 *
 * ─── Por que PURO (mesma razão de `poison-policy.ts` e `claim.ts`) ──────────
 *
 * Sem acesso a dados, sem contexto de execução, sem configuração de processo e
 * sem métricas. A pergunta "o que é seguro fazer com este run?" vira uma função
 * de um INSTANTÂNEO para uma disposição — respondível sem Postgres, sem Redis e
 * sem boot. Se a política lesse o ambiente, todo teste dela passaria a medir o
 * ambiente do processo de teste em vez da regra.
 *
 * ─── O mecanismo que o vocabulário FECHADO oferece ──────────────────────────
 *
 * Não existe membro que signifique "retomar a sequência de ferramentas". A
 * ausência é o mecanismo, não um esquecimento: enquanto o tipo não conseguir
 * expressar a ação proibida, nenhum call site consegue pedi-la. É o mesmo
 * desenho que a spec elogia em `RECONCILIATION_DISPOSITIONS`, onde a ausência
 * de `resend_blind` é o que impede "reenvie sem saber".
 */
import { TERMINAL_TURN_STATUSES } from "@/runtime/turns/contract.js";
import type { EngineRunPhaseV1 } from "./contracts.js";

/**
 * As disposições SEGURAS. Cada membro nasce de uma linha do §5.8.2 ou do
 * §5.8.4 — vocabulário sem procedência é vocabulário inventado.
 *
 *  - `nothing_to_do` — o run já está `closed`. Não há journal a reconciliar, e
 *    inventar trabalho aqui reabriria o que a porta de fechamento já decidiu;
 *  - `resume_owner` — §5.8.2, linha "prepared, sem submitting": "sob origin
 *    claim vivo pode iniciar". É a ÚNICA disposição que autoriza começar algo, e
 *    exige posse viva; a linha seguinte da mesma tabela proíbe "submeter sob
 *    origin claim expirado";
 *  - `query_same_request_key` — §5.8.2, linha "depois de marcar submitting,
 *    antes/depois do HTTP, sem ID": "consultar request_key na instância pinada;
 *    nunca mudar bytes/key". Proibido: "criar outro run porque faltou remote
 *    ID";
 *  - `revoke_and_observe` — §5.8.2, linha "remote ID conhecido, processo
 *    morreu": "novo claim Maia; revogar callbacks antigos; observar/cancelar o
 *    run conhecido". Proibido: "reiniciar reasoner e executar tools em paralelo
 *    com run antigo";
 *  - `cancel_and_reconcile` — §5.8.2, linha "run ativo após perda de lease":
 *    "cancelar; reconciliar até terminal". Proibido: "tratar 'cancel
 *    solicitado' como 'não executou'";
 *  - `adopt_terminal` — §5.8.2, linha "terminal externo persistido, sem
 *    output": "novo owner valida política/calls/contexto, adota terminal e faz
 *    só saída". Proibido: "pagar outra deliberação porque worker foi
 *    reenfileirado";
 *  - `maintenance_only` — §5.8.4 item 1: turno já `outbound_pending` ou
 *    terminal proíbe start, gateway e adoção, e sobra reconciliação de
 *    metadata. Cobre também a linha "commit outbound feito, ACK local perdido",
 *    cujo desfecho é "só delivery/recovery";
 *  - `reconcile_only` — §5.8.4 item 3: "há chamada com efeito desconhecido não
 *    reconciliado: barrar nova geração e nova saída que afirme sucesso";
 *  - `block` — §5.8.2, linha "serviço externo esqueceu run; lookup
 *    inconclusivo": "preservar request key/journal, revogar capacidades;
 *    blocked após prazo". É também o FUNDO DO POÇO desta política.
 */
export const RECOVERY_DISPOSITIONS = [
  "nothing_to_do",
  "resume_owner",
  "query_same_request_key",
  "revoke_and_observe",
  "cancel_and_reconcile",
  "adopt_terminal",
  "maintenance_only",
  "reconcile_only",
  "block",
] as const;

export type RecoveryDisposition = (typeof RECOVERY_DISPOSITIONS)[number];

/**
 * O que a consulta de recovery observou sobre o start, quando observou.
 *
 * `inconclusive` e `definitely_not_accepted` são fatos DIFERENTES e o §5.8.2
 * proíbe confundi-los: "converter 404 em definitely_not_accepted" está na
 * coluna dos proibidos. `null` é "não perguntei", que também não é prova.
 */
export type StartProofV1 = "definitely_not_accepted" | "inconclusive" | null;

/**
 * O INSTANTÂNEO do journal que basta para decidir. Contagens, e não linhas: a
 * política não precisa do conteúdo de nenhuma chamada, e não recebê-lo é o que
 * a mantém utilizável num varredor cross-tenant sem vazar dado de tenant.
 */
export interface RecoverySnapshotV1 {
  phase: EngineRunPhaseV1;
  /** `agent_turns.status` — o dono do turno, não a fase do run (§5.7.2). */
  turn_status: string;
  /** Lease do turno ainda viva no relógio do banco. */
  lease_alive: boolean;
  /** `conversation_controls.mode`. Qualquer coisa fora de `bot` é humano. */
  control_mode: string;
  has_terminal: boolean;
  adopted: boolean;
  /** Chamadas que não chegaram a estado conciliado. */
  unreconciled_calls: number;
  /** Chamadas em `effect_unknown` — o subconjunto PERIGOSO das acima. */
  effect_unknown_calls: number;
  outbound_rows: number;
  outbound_completed: number;
  remote_run_id_known: boolean;
  last_observation: StartProofV1;
}

const TURNOS_TERMINAIS = new Set<string>(TERMINAL_TURN_STATUSES);

/** Turno que já não aceita nova execução: comprometido ou terminal (§5.8.4). */
function turnoNaoReivindicavel(s: RecoverySnapshotV1): boolean {
  return (
    s.turn_status === "outbound_pending" || TURNOS_TERMINAIS.has(s.turn_status)
  );
}

/**
 * Decide a ação SEGURA para um run depois de uma queda. Função TOTAL.
 *
 * ─── Por que a EVIDÊNCIA DE EFEITO domina a fase ────────────────────────────
 *
 * Pela mesma régua com que `unsafe_to_retry` domina o código de erro em
 * `poison-policy`: uma chamada em `effect_unknown` é fato DURÁVEL — a
 * plataforma registrou que algo pode ter acontecido no mundo — enquanto a fase
 * é contexto. Deixar a fase decidir primeiro faria um `result_ready` bonito
 * autorizar adoção por cima de um efeito que ninguém conciliou, que é
 * exatamente o que o §5.8.4 item 3 proíbe.
 *
 * ─── Por que o fundo do poço é `block` ──────────────────────────────────────
 *
 * Porque o INV-09 não admite retomada automática. Um instantâneo que a tabela
 * não previu é o caso em que MENOS se sabe, e a única resposta honesta é parar
 * para um humano olhar. Um default permissivo aqui transformaria uma omissão da
 * tabela em autorização para agir.
 */
export function classifyRecovery(s: RecoverySnapshotV1): RecoveryDisposition {
  // 1. Já fechado: a decisão foi tomada por uma porta com prova própria.
  if (s.phase === "closed") return "nothing_to_do";

  // 2. `blocked` domina até um terminal íntegro: só porta operacional auditada
  //    encerra esse risco (§5.8.4 item 6).
  if (s.phase === "blocked") return "block";

  // 3. `dead_letter` com efeito desconhecido CONTINUA bloqueado (§5.8.4 item 6).
  //    Vem antes da regra geral de efeito porque aqui nem reconciliar basta.
  if (s.effect_unknown_calls > 0 && s.turn_status === "dead_letter")
    return "block";

  // 4. Efeito desconhecido barra nova geração e qualquer saída que afirme
  //    sucesso (§5.8.4 item 3). Domina a fase — ver o cabeçalho.
  if (s.effect_unknown_calls > 0) return "reconcile_only";

  // 5. Controle humano: nova geração está fora de questão enquanto a conversa
  //    não for do bot. Sobra metadata.
  if (s.control_mode !== "bot") return "maintenance_only";

  // 6. Turno já comprometido ou terminal: start, gateway e adoção proibidos
  //    (§5.8.4 item 1). Quem finaliza `outbound_pending` é o delivery.
  if (turnoNaoReivindicavel(s)) return "maintenance_only";

  // 7. Cancelamento em curso permanece até observar terminal — o ACK não
  //    encerra nada (§5.7.2, "não fechar com base só no ACK").
  if (s.phase === "cancelling" || s.phase === "reconciling") {
    return "cancel_and_reconcile";
  }

  // 8. Terminal persistido sem saída: adotar em vez de deliberar de novo.
  if (s.phase === "result_ready") {
    return s.has_terminal && !s.adopted ? "adopt_terminal" : "maintenance_only";
  }

  // 9. Preparado e não submetido: só o dono VIVO pode iniciar.
  if (s.phase === "prepared") {
    return s.lease_alive ? "resume_owner" : "maintenance_only";
  }

  // 10. Submetido sem ID: consultar pela MESMA `request_key`, nunca criar outro
  //     run. `inconclusive` não é prova de não-execução, então não reabre start.
  if (s.phase === "submitting" || s.phase === "submission_unknown") {
    if (s.last_observation === "inconclusive") return "reconcile_only";
    return "query_same_request_key";
  }

  // 11. Em execução: se a posse está viva, o dono resolve e recovery não
  //     disputa. Sem posse, revogar callbacks antigos antes de observar.
  if (s.phase === "running") {
    if (s.lease_alive) return "nothing_to_do";
    return s.remote_run_id_known
      ? "revoke_and_observe"
      : "cancel_and_reconcile";
  }

  // 12. EXAUSTIVIDADE, e não um default.
  //
  // As onze regras acima cobrem todos os membros de `EngineRunPhaseV1`, e o
  // `never` faz o COMPILADOR provar isso: um membro novo na união quebra a
  // build exatamente aqui, em vez de cair silenciosamente num ramo genérico.
  // É o idioma que `deriveProviderIdempotencyKey` já usa nesta casa.
  //
  // Lançar, e não devolver `block`, por duas razões. A primeira é honestidade:
  // um instantâneo que a tabela não previu não é um estado seguro conhecido, é
  // um defeito de programação — devolver uma disposição faria uma OMISSÃO da
  // tabela parecer uma decisão, que é a mesma falha que o INV-09 existe para
  // impedir do outro lado. A segunda foi a varredura de mutação que descobriu:
  // enquanto o fundo devolvia `block`, ele MASCARAVA a regra 2 (que devolve
  // `block` pelo motivo certo), e desligá-la não quebrava teste nenhum. Um
  // ramo que ninguém consegue observar é um ramo que o próximo refactor apaga.
  const _never: never = s.phase;
  void _never;
  throw new TypeError(
    `recovery: fase sem regra declarada (${String(s.phase)}) — ver §5.8.2`,
  );
}
