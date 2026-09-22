/**
 * P02 (spec §5.2, §5.9.2) — `MaiaOutputCoordinator`: quem ENTREGA.
 *
 * ─── Por que a entrega sai do laço de raciocínio ────────────────────────────
 *
 * Até aqui a fachada de saída morava no fim de `runReActLoop`. Isso funcionava
 * enquanto só existia um motor, e deixa de funcionar no instante em que o
 * raciocínio pode acontecer noutro processo: um motor remoto não entrega nada,
 * não conhece o JID, não tem o ledger e não pode decidir se o envio ficou
 * incerto. A entrega é da Maia em qualquer topologia — então ela sai do laço e
 * vira este módulo, que serve aos dois motores sem saber qual rodou.
 *
 * ─── O que ele conserva de propósito ────────────────────────────────────────
 *
 * A precedência PDF → voz → poll → texto, o quote, o view-once, o canal/JID e
 * os hooks de mídia continuam dentro de `safeDispatchOutput` (§5.9.2.3). Este
 * módulo NÃO reimplementa entrega: ele prepara, chama a fachada existente e lê
 * o estado durável depois. Trocar `safeDispatchOutput` por `deliverOutbound` e
 * declarar equivalência é exatamente o que o §5.9.2.4 proíbe, porque migraria
 * só o caminho inline e deixaria o de recovery para trás.
 *
 * ─── Uma correção que vem junto ─────────────────────────────────────────────
 *
 * `DispatchOutputCtx.toolSummaries` é opcional e o laço atual NÃO o passa
 * (`react-loop.ts`, chamada da fachada). O efeito é silencioso e real: quando o
 * turno entrega texto, os sumários das ferramentas não vão para
 * `ferramentas_chamadas` da mensagem outbound, e o prompt-builder do turno
 * SEGUINTE não reidrata o bloco "## Eventos confirmados pelo backend". Só o
 * caminho sem resposta (`flushUnconfirmedToolSummaries`) os persistia. Este
 * coordenador passa `toolSummaries` sempre — §5.9.2.3 pede isso nominalmente.
 */
import { logger } from '@/lib/logger.js';
import { safeDispatchOutput, type DispatchOutcome } from '@/agent/output-dispatch.js';
import type { ReActDelivery, ReActExitReason } from '@/agent/react-loop.js';
import type { Conversa, Mensagem, Pessoa } from '@/db/schema.js';
import {
  divergenceBlocksDelivery,
  divergenceToAuditPayload,
  type AssembledTurnResultV1,
} from './assembler.js';
import type { EngineStopV1 } from './contracts.js';

/** Contexto de entrega que é EXCLUSIVAMENTE da Maia (§5.3.3). */
export type OutputHostContextV1 = {
  pessoa: Pessoa;
  conversa: Conversa;
  inbound: Mensagem;
  /** JID em que o inbound chegou — preserva a thread, inclusive `@lid`. */
  jid: string;
};

/**
 * T22 (§6.9.1) — o fence de egresso do run, na forma de uma ESCOLHA.
 *
 * `no_run` não é "sem fence por enquanto": é a afirmação de que este caller
 * não tem run durável cujas capacidades possam ser revogadas, e por isso não
 * há o que reler. O motor local é o único caso hoje. Quem tem run passa
 * `check`, e a função relê `capabilities_revoked_at` no instante do envio.
 */
export type EgressFenceV1 =
  | { kind: 'no_run'; because: 'local_engine_has_no_durable_run' }
  | { kind: 'check'; isAuthorized: () => Promise<boolean> };

/**
 * Dependências injetadas. Existem para que o coordenador seja exercitável sem
 * banco, sem provider e sem dublar módulo — a mesma razão de `MaiaEngine`
 * receber o laço de raciocínio em vez de importá-lo.
 */
export type OutputCoordinatorDepsV1 = {
  dispatch: (ctx: Parameters<typeof safeDispatchOutput>[0]) => Promise<DispatchOutcome>;
  /** Persiste sumários quando NADA foi entregue (§5.9.2.8). */
  flushUnconfirmedToolSummaries: (
    conversa_id: string,
    inbound_id: string,
    summaries: AssembledTurnResultV1['toolSummaries'],
    reason: ReActExitReason,
  ) => Promise<void>;
  /**
   * T22 — o fence de egresso, DECLARADO em vez de omitido.
   *
   * Este campo era `isEgressAuthorized?: () => Promise<boolean>`, e o opcional
   * era o problema: a ausência do fence e o esquecimento do fence tinham
   * exatamente a mesma forma no código. O caller local está certo em não ter
   * um — não existe run durável nem grant para revogar —, mas o caller remoto
   * que esquecesse de ligá-lo compilaria igual, e o sintoma seria uma resposta
   * saindo depois de um operador revogar as capacidades. Exatamente o que o
   * T22 existe para impedir.
   *
   * Com a união discriminada, "não há fence" passa a ser uma AFIRMAÇÃO que
   * alguém escreveu e o revisor lê. O compilador cobra a escolha.
   */
  egress: EgressFenceV1;
  /**
   * C24 — a trilha durável do resultado barrado (`engine_result_fenced`).
   *
   * Obrigatória pelo mesmo motivo: ação de governança sem produtor é ação que
   * não existe. `@/governance/audit.js` resolve tenant e agent pelo ALS, e a
   * injeção continua existindo para que o módulo seja exercitável sem contexto.
   */
  audit: (input: {
    acao: 'engine_result_fenced';
    alvo_id: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
  /** Lacuna interna: fire-and-forget, NUNCA bloqueia a resposta (§5.9.2.9). */
  onDelivered?: (rawText: string) => void;
};

export type OutputCoordinationResultV1 = {
  delivery: ReActDelivery;
  /** Texto que foi (ou seria) entregue. Vazio quando não houve candidato. */
  outboundText: string;
};

/**
 * Traduz o desfecho DELIBERATIVO em motivo de saída, antes de qualquer
 * tentativa de envio. `outbound_failure` não aparece aqui de propósito: ele só
 * pode ser decidido DEPOIS de tentar entregar, e inventá-lo antes seria afirmar
 * uma falha de envio que ninguém observou.
 */
function motivoInicial(stop: EngineStopV1): ReActExitReason {
  switch (stop.kind) {
    case 'reply':
      return 'empty_final_text';
    case 'no_reply':
      return stop.reason;
    case 'failed':
      // `deadline_exceeded` e `protocol_error` são falhas do raciocínio tanto
      // quanto um timeout do provider: nada foi produzido para o usuário.
      return 'reasoner_failed';
    case 'cancelled':
      // Cancelamento não é falha do reasoner, mas também não produziu texto.
      // `empty_final_text` conclui o turno sem marcar retry — e retry de um
      // turno cancelado por perda de posse é exatamente o que não se quer.
      return 'empty_final_text';
  }
}

/**
 * Entrega o resultado do turno e devolve o veredito DURÁVEL.
 *
 * Não abre transação (§5.9.2.4): cada commit/claim/finalização usa seu
 * repositório curto e o provider corre fora. Envolver isto num `withTx`
 * seguraria uma transação aberta durante uma chamada de rede.
 */
export async function coordinateOutput(
  host: OutputHostContextV1,
  assembled: AssembledTurnResultV1,
  deps: OutputCoordinatorDepsV1,
): Promise<OutputCoordinationResultV1> {
  const { pessoa, conversa, inbound, jid } = host;
  let exitReason = motivoInicial(assembled.stop);
  let dispatched = false;
  let persistUnknown = false;

  const candidato = assembled.candidate;

  /**
   * Fence de alegação (§5.3.4). O motor afirmou ter chamado ferramentas que
   * não têm receipt: a Maia não despachou aquilo. Responder ao usuário em cima
   * de uma dessas alegações é entregar texto construído sobre efeito que não
   * existe — então o turno não entrega, e o operador vê pela auditoria.
   *
   * Isto vem ANTES do envio de propósito. Depois do envio não há desfazer.
   */
  if (divergenceBlocksDelivery(assembled.divergence)) {
    logger.error(
      {
        conversa_id: conversa.id,
        mensagem_id: inbound.id,
        divergence: divergenceToAuditPayload(assembled.divergence),
        ops_alert: true,
      },
      'engine.coordinator.claim_divergence_blocked_delivery',
    );
    // [P2] Preservar divergência explicitamente até decideTurnAction.
    // O motivo 'claim_divergence_blocked' não é retryable (não está em
    // RETRYABLE_EXITS de turn-outcome.ts), mas se sideEffectsCommitted=true,
    // indicará dead_letter/unsafe_to_retry — bloqueio de reconciliação, não
    // turno vazio. Sem este motivo explícito, uma divergência com efeito fica
    // indistinguível de um turno que simplesmente não produziu resposta.
    exitReason = 'claim_divergence_blocked';

    /**
     * C24 — a linha durável do resultado barrado.
     *
     * O `logger.error` acima é diagnóstico e some na rotação. Um resultado que
     * a Maia se recusou a entregar é decisão de governança, e decisão de
     * governança precisa de linha que sobreviva — é ela que alguém lê para
     * reconciliar o run depois.
     *
     * O payload leva IDS de chamada e nada mais: nenhum argumento, resultado
     * ou texto entra, pela mesma razão de sempre.
     */
    /**
     * A trilha não pode VIRAR o fence. Se a escrita da auditoria falhar, o
     * erro subiria por `coordinateOutput` e o turno terminaria como falha
     * genérica — o que `decideTurnAction` classificaria como RETRY. Um turno
     * bloqueado por divergência que volta para a fila é exatamente o oposto do
     * desfecho: ele precisa de dead letter e de gente. Então a falha da trilha
     * é gritada e absorvida, e o bloqueio segue sendo o que este caminho
     * devolve.
     */
    try {
      await deps.audit({
        acao: 'engine_result_fenced',
        alvo_id: inbound.id,
        metadata: {
          conversa_id: conversa.id,
          divergence: divergenceToAuditPayload(assembled.divergence),
          side_effects_committed: assembled.sideEffectsCommitted,
        },
      });
    } catch (err) {
      logger.error(
        { conversa_id: conversa.id, mensagem_id: inbound.id, err, ops_alert: true },
        'engine.coordinator.result_fenced_audit_failed',
      );
    }

    if (assembled.toolSummaries.length > 0) {
      await deps.flushUnconfirmedToolSummaries(
        conversa.id,
        inbound.id,
        assembled.toolSummaries,
        exitReason,
      );
    }
    return {
      outboundText: '',
      delivery: {
        dispatched: false,
        exitReason,
        persistUnknown: false,
        sideEffectsCommitted: assembled.sideEffectsCommitted,
      },
    };
  }

  if (assembled.missingOrdinals.length > 0) {
    // Não bloqueia: lacuna de ordinal é receipt perdido, não alegação falsa. O
    // efeito pode ter acontecido, e é por isso que fica auditado em vez de
    // silenciado.
    logger.warn(
      {
        conversa_id: conversa.id,
        mensagem_id: inbound.id,
        missing_ordinals: assembled.missingOrdinals,
        ops_alert: true,
      },
      'engine.coordinator.tool_receipt_gap',
    );
  }

  /**
   * T22 (§6.9.1) — O FENCE DE EGRESSO, DEPOIS DA REVOGAÇÃO DE GRANT.
   *
   * `markToolHandlerStarted` já relê `capabilities_revoked_at` antes de
   * liberar um handler, então o lado das FERRAMENTAS está coberto. O que
   * faltava era a saída final: um run cujas capacidades foram revogadas —
   * por operador ou por recovery — ainda conseguia entregar a resposta que
   * tinha produzido antes da revogação.
   *
   * A janela é real e não é estreita: o texto é produzido no fim da
   * deliberação e o envio acontece depois, e é exatamente nesse intervalo que
   * um operador aperta o botão. Revogar as capacidades e ver a resposta sair
   * assim mesmo é a forma de falha que o T22 nomeia — "e saída final".
   *
   * A releitura acontece AQUI, imediatamente antes do despacho, e não no
   * começo da coordenação: qualquer trabalho entre a leitura e o envio
   * reabriria a janela que ela existe para fechar.
   */
  if (candidato !== null && candidato.text.length > 0 && deps.egress.kind === 'check') {
    const autorizado = await deps.egress.isAuthorized();
    if (!autorizado) {
      logger.warn(
        { conversa_id: conversa.id, mensagem_id: inbound.id },
        'engine.coordinator.egress_blocked_capabilities_revoked',
      );
      if (assembled.toolSummaries.length > 0) {
        await deps.flushUnconfirmedToolSummaries(
          conversa.id,
          inbound.id,
          assembled.toolSummaries,
          'egress_revoked',
        );
      }
      return {
        outboundText: '',
        delivery: {
          dispatched: false,
          exitReason: 'egress_revoked',
          persistUnknown: false,
          sideEffectsCommitted: assembled.sideEffectsCommitted,
        },
      };
    }
  }

  if (candidato !== null && candidato.text.length > 0) {
    const outcome = await deps.dispatch({
      pessoa,
      conversa,
      inbound,
      jid,
      text: candidato.text,
      latestPending: assembled.latestPending,
      latestReportPdf: assembled.latestReportPdf,
      turnHasSensitive: assembled.turnHasSensitive,
      sensitiveTools: assembled.sensitiveTools,
      // A correção descrita no cabeçalho: o laço atual omite este campo.
      toolSummaries: assembled.toolSummaries,
    });

    if (outcome.status === 'not_sent') {
      /**
       * U-P04.7a — a tomada humana chega aqui como MOTIVO TIPADO.
       *
       * Esta classificação morava no laço, dentro do bloco de envio inline que
       * este coordenador substituiu. Ela veio junto na integração, e não podia
       * ficar para trás: sem ela, `not_sent` por controle humano vira
       * `outbound_failure`, que `decideTurnAction` classifica como RETRY — a
       * automação reenfileirando um turno para insistir no canal de onde um
       * atendente acabou de tirá-la. `human_control_blocked` está fora de
       * `RETRYABLE_EXITS` justamente por isso.
       *
       * O motivo é lido de `DispatchOutcome.rejection`, campo tipado, em vez
       * de a decisão de retry ter de procurar substring na mensagem de erro.
       */
      const porControleHumano = outcome.rejection === 'human_control';
      logger.warn(
        {
          conversa_id: conversa.id,
          mensagem_id: inbound.id,
          err: outcome.error,
          rejection: outcome.rejection ?? null,
        },
        porControleHumano
          ? 'engine.coordinator.outbound_blocked_human_control'
          : 'engine.coordinator.outbound_not_delivered',
      );
      exitReason = porControleHumano ? 'human_control_blocked' : 'outbound_failure';
    } else {
      if (outcome.status === 'sent_no_persist') {
        // Chegou ao usuário e a persistência ficou ambígua. NUNCA reenviar.
        logger.error(
          {
            conversa_id: conversa.id,
            mensagem_id: inbound.id,
            err: outcome.error,
            ops_alert: true,
          },
          'engine.coordinator.dispatch_inconsistency',
        );
        persistUnknown = true;
      }
      dispatched = true;
      // Lacuna interna só depois de algo CHEGAR ao usuário — nunca depois de
      // uma falha pre-send. Texto cru, sem o prefixo de role, para o anúncio
      // da Maia não disparar lacuna por frase nossa.
      //
      // [P2] Proteger throws síncronos E rejeições assíncronas da hook. O contrato
      // declara "fire-and-forget, NUNCA bloqueia a resposta" (§5.9.2.9), então o
      // `dispatch` já confirmou a entrega e `dispatched = true`. Uma falha auxiliar
      // não pode apagar esse veredito que o caller precisa preservar.
      void Promise.resolve()
        .then(() => deps.onDelivered?.(candidato.rawText))
        .catch((err) => {
          logger.warn(
            {
              conversa_id: conversa.id,
              mensagem_id: inbound.id,
              err,
            },
            'engine.coordinator.onDelivered_hook_failed',
          );
        });
    }
  }

  // Sem entrega e com ferramentas executadas: os sumários viram linha de evento
  // para o prompt-builder do próximo turno (§5.9.2.8). Com entrega, eles já
  // foram na mensagem outbound.
  if (!dispatched && assembled.toolSummaries.length > 0) {
    await deps.flushUnconfirmedToolSummaries(
      conversa.id,
      inbound.id,
      assembled.toolSummaries,
      exitReason,
    );
  }

  return {
    outboundText: candidato?.text ?? '',
    delivery: {
      dispatched,
      exitReason,
      persistUnknown,
      sideEffectsCommitted: assembled.sideEffectsCommitted,
    },
  };
}
