/**
 * P05 (spec §5.2, §6.9.1) — `EngineToolGateway`: o que transforma a decisão do
 * broker em execução.
 *
 * ─── A fronteira que este módulo materializa ────────────────────────────────
 *
 * `decideToolCall` (`./tool-broker.ts`) é puro e diz, no próprio docstring, o
 * que NÃO decide: lease viva, deadline, epoch de controle humano, orçamento,
 * idempotência e efeito. O `admit` dele significa "nenhuma regra ESTÁTICA
 * barra" — nunca "pode executar". Entre esse `admit` e o handler existe uma
 * releitura obrigatória do banco (§6.9.1 item 2), e é ela que este módulo faz.
 *
 * Ou seja: o broker responde sobre o CATÁLOGO, o gateway responde sobre o
 * MUNDO. Juntar os dois num módulo só teria colapsado uma decisão pura e
 * testável numa que precisa de banco — e a parte pura é justamente a que se
 * consegue provar.
 *
 * ─── Por que ele tem a forma de `invokeTool` ────────────────────────────────
 *
 * A assinatura de saída é exatamente `EngineIOV1.invokeTool`. Não é
 * coincidência: o gateway É o `invokeTool` que o motor recebe. O motor — local
 * ou remoto — nunca fala com `dispatchTool`; ele fala com esta função, que é a
 * única porta pela qual uma chamada de ferramenta atravessa para o lado da
 * Maia. Um motor que conseguisse chamar o dispatcher direto tornaria todo o
 * resto decorativo.
 *
 * ─── A segunda linha de defesa ──────────────────────────────────────────────
 *
 * `dispatchTool` tem o próprio fence de posse (#504) e ele NÃO é removido nem
 * duplicado aqui. Os dois existem porque respondem a perguntas diferentes: o
 * gateway pergunta "esta chamada foi admitida por ESTE run, nesta ordem, com
 * estes argumentos?", e o dispatcher pergunta "esta tentativa ainda é dona do
 * turno no instante do efeito?". A segunda continua sendo a última palavra.
 */
import type { EngineToolCallV1, EngineToolReplyV1, Json } from '@/runtime/engines/contracts.js';
import type { ToolAdmissionV1 } from './tool-broker.js';
import type {
  ToolCallAdmission,
  ToolClassification,
  ToolSettlement,
  FreezeIdentityResult,
  HandlerStartedResult,
} from '@/db/repositories/engine-repos.js';
import type { ToolContext, DispatchResult } from '@/tools/_dispatcher.js';
import { logger } from '@/lib/logger.js';
import { canonicalDigest } from './canonical-json.js';

/** Identidade durável do run, resolvida uma vez e usada em toda chamada. */
export type GatewayRunIdentityV1 = {
  run_id: string;
  turn_id: string;
  /** Fence da tentativa que ORIGINOU o run (§5.7.1). */
  origin_claim_token: string;
  request_id: string;
};

/**
 * Dependências injetadas.
 *
 * Elas existem pela mesma razão que em `MaiaEngine`: sem injeção, exercitar o
 * gateway exigiria banco, dispatcher e manifest reais, e o que se prova de um
 * caminho assim é quase nada. Com injeção, cada desfecho do §6.9.1 vira um
 * caso.
 */
export type ToolGatewayDepsV1 = {
  /** A decisão ESTÁTICA. Pura; ver `decideToolCall`. */
  decide: (call: EngineToolCallV1) => ToolAdmissionV1;
  /** Releitura do banco: lease, deadline, controle, ordem, idempotência. */
  admit: (input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    request_id: string;
    call: { call_id: string; ordinal: number; iteration: number | null; name: string; args: Json };
  }) => Promise<ToolCallAdmission>;
  /** Congela a classificação de efeito antes do handler (§5.7.4). */
  markDispatching: (input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    call_id: string;
    expected_row_version: number;
    classification: ToolClassification;
  }) => Promise<
    { ok: true; dispatch_token: string; row_version: number } | { ok: false; reason: string }
  >;
  /** Congela a identidade de idempotência (§5.6.3). */
  freezeToolIdentity: (input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    call_id: string;
    idempotency_key: string;
    idempotency_payload_hash: string;
    normalized_args: Json;
  }) => Promise<FreezeIdentityResult>;
  /** Marca que o handler começou a rodar (§5.6.4). */
  markToolHandlerStarted: (input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    call_id: string;
    expected_row_version: number;
    dispatch_token: string;
    reservation_token: string;
    approval_claim_token?: string | null;
  }) => Promise<HandlerStartedResult>;
  /** Liquida a chamada com o desfecho observado (§5.7.4). */
  settle: (input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    call_id: string;
    expected_row_version: number;
    dispatch_token: string;
    outcome: ToolSettlement;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** O dispatcher da casa. Mantém o PRÓPRIO fence de posse. */
  dispatch: (input: { tool: string; args: unknown; ctx: ToolContext }) => Promise<DispatchResult>;
  /** Item 4 do §6.9.1: contexto derivado do BINDING, não do frame. */
  buildToolContext: (call: EngineToolCallV1) => Promise<ToolContext>;
  /** Classificação da tool no registry da casa. */
  classify: (toolName: string) => ToolClassification | null;
  /**
   * Quanto o motor espera antes de reperguntar por uma chamada que ainda não
   * tem desfecho. Ver a nota sobre `defer` mais abaixo.
   */
  retryAfterMs?: number;
};

const RETRY_PADRAO_MS = 30_000;

/** Resultado do dispatcher que representa erro do handler, não do transporte. */
function ehErroDeHandler(r: DispatchResult): boolean {
  return typeof r === 'object' && r !== null && 'error' in r;
}

/**
 * Traduz o conflito da admissão para o vocabulário FECHADO do wire.
 *
 * O wire tem seis códigos e o banco tem mais motivos que isso. A tradução
 * agrupa de propósito: um motor não precisa distinguir "a lease morreu" de "o
 * epoch de controle mudou" — nos dois casos ele não está autorizado a agir, e
 * detalhar a diferença contaria ao lado não autorizado o estado interno do
 * turno. O detalhe fica no log, do lado de cá.
 */
function recusaDoWire(
  admissao: Extract<ToolCallAdmission, { ok: false }>,
): Extract<EngineToolReplyV1, { kind: 'refused' }>['code'] {
  return admissao.reason === 'payload_conflict' ? 'payload_conflict' : 'run_not_authorized';
}

/**
 * `row_version` de uma chamada recém-admitida.
 *
 * A coluna nasce `DEFAULT 0` na 140 (`engine_tool_calls`), e o congelamento da
 * classificação é a PRIMEIRA escrita depois da admissão. Nomear o valor em vez
 * de chumbar um `0` no call site é o que liga essa expectativa à migration:
 * quem mudar o default encontra a constante, não um literal solto no meio de
 * um objeto.
 */
const ROW_VERSION_DA_ADMISSAO = 0;

export function createEngineToolGateway(
  identity: GatewayRunIdentityV1,
  deps: ToolGatewayDepsV1,
): (call: EngineToolCallV1) => Promise<EngineToolReplyV1> {
  const retryAfterMs = deps.retryAfterMs ?? RETRY_PADRAO_MS;

  return async function invokeTool(call: EngineToolCallV1): Promise<EngineToolReplyV1> {
    const base = {
      run_id: identity.run_id,
      turn_id: identity.turn_id,
      origin_claim_token: identity.origin_claim_token,
    };

    // ── (1) DECISÃO ESTÁTICA ────────────────────────────────────────────
    const estatica = deps.decide(call);

    if (estatica.kind === 'refuse') {
      logger.warn(
        { run_id: identity.run_id, call_id: call.call_id, reason: estatica.reason },
        'engine.tool_gateway.refused_static',
      );
      return { kind: 'refused', call_id: call.call_id, code: estatica.wire };
    }

    if (estatica.kind === 'defer') {
      /**
       * `approval_required` NÃO tem código no wire (C33 / C-P05-2 — decisão em
       * aberto do dono). Os seis códigos de `refused` não incluem aprovação, e
       * usar um deles diria ao motor algo falso: `tool_not_allowed` afirmaria
       * que a ferramenta não é dele, quando o fato é que ela é e está esperando
       * um humano.
       *
       * Então o wire recebe `in_progress`, que é a única coisa VERDADEIRA que
       * ele sabe expressar: ainda não há desfecho. O estado real —
       * `approval_required` — fica durável no journal, onde o console o lê.
       *
       * Isto é um paliativo declarado, não a solução. Enquanto durar, um
       * motor que espere aprovação fica repolando em `retryAfterMs`. Fechar
       * isso exige abrir o protocolo congelado, que é a PR de Fase 0.
       */
      logger.info(
        { run_id: identity.run_id, call_id: call.call_id, tool: call.name },
        'engine.tool_gateway.deferred_pending_approval',
      );
      return { kind: 'in_progress', call_id: call.call_id, retry_after_ms: retryAfterMs };
    }

    // ── (2) RELEITURA DO BANCO (§6.9.1 item 2) ──────────────────────────
    const admissao = await deps.admit({
      ...base,
      request_id: identity.request_id,
      call: {
        call_id: call.call_id,
        ordinal: call.ordinal,
        iteration: call.iteration,
        name: call.name,
        args: call.args,
      },
    });

    if (!admissao.ok) {
      logger.warn(
        { run_id: identity.run_id, call_id: call.call_id, reason: admissao.reason },
        'engine.tool_gateway.refused_durable',
      );
      return { kind: 'refused', call_id: call.call_id, code: recusaDoWire(admissao) };
    }

    // Redelivery com o vencedor ainda em voo: journalado, não liberado. NÃO
    // roda o handler de novo — é exatamente a duplicação que o journal existe
    // para impedir.
    if (admissao.kind === 'in_progress') {
      return { kind: 'in_progress', call_id: call.call_id, retry_after_ms: retryAfterMs };
    }

    // Já conciliada: devolve o que está PERSISTIDO. O resultado vem do banco,
    // nunca de reexecutar — mesmo que reexecutar fosse barato, o efeito não é.
    if (admissao.kind === 'receipt') {
      return {
        kind: 'result',
        call_id: call.call_id,
        result: admissao.result,
        is_error: admissao.state === 'denied' || admissao.state === 'effect_unknown',
      };
    }

    // ── (3) CLASSIFICAÇÃO CONGELADA ANTES DO HANDLER ────────────────────
    //
    // `effect_class: null` NUNCA autoriza handler (§4.1). Uma tool que o
    // registry não classifica é uma tool cujo efeito ninguém sabe descrever, e
    // liberar isso é liberar o desconhecido.
    const classificacao = deps.classify(call.name);
    if (classificacao === null || classificacao.effect_class === null) {
      logger.error(
        { run_id: identity.run_id, call_id: call.call_id, tool: call.name, ops_alert: true },
        'engine.tool_gateway.unclassified_tool_refused',
      );
      return { kind: 'refused', call_id: call.call_id, code: 'tool_not_allowed' };
    }

    const congelou = await deps.markDispatching({
      ...base,
      call_id: admissao.call_id,
      expected_row_version: ROW_VERSION_DA_ADMISSAO,
      classification: classificacao,
    });
    if (!congelou.ok) {
      logger.warn(
        { run_id: identity.run_id, call_id: call.call_id, reason: congelou.reason },
        'engine.tool_gateway.dispatch_freeze_refused',
      );
      return { kind: 'refused', call_id: call.call_id, code: 'run_not_authorized' };
    }

    // ── (3a) IDENTIDADE DE IDEMPOTÊNCIA CONGELADA (§5.6.3) ──────────────
    // Antes de marcar que o handler começou, é preciso congelar a identidade
    // de idempotência. Isso garante que a chamada é determinística.
    const congelada = await deps.freezeToolIdentity({
      ...base,
      call_id: admissao.call_id,
      idempotency_key: call.call_id,
      idempotency_payload_hash: canonicalDigest(call.args),
      normalized_args: call.args,
    });

    if (!congelada.ok) {
      logger.warn(
        { run_id: identity.run_id, call_id: call.call_id, reason: congelada.reason },
        'engine.tool_gateway.freeze_identity_refused',
      );
      return { kind: 'refused', call_id: call.call_id, code: 'run_not_authorized' };
    }

    // ── (3b) MARCADOR DO HANDLER (§5.6.4) ───────────────────────────────
    // Depois de congelar a identidade, marca que o handler vai começar.
    // Isso separa "não começou" de "pode ter começado". A row_version
    // é incrementada neste passo; precisamos dessa versão nova para o settle.
    const marcou = await deps.markToolHandlerStarted({
      ...base,
      call_id: admissao.call_id,
      expected_row_version: congelou.row_version,
      dispatch_token: congelou.dispatch_token,
      reservation_token: `res-${call.call_id}`,
    });

    if (!marcou.ok) {
      logger.warn(
        { run_id: identity.run_id, call_id: call.call_id, reason: marcou.reason },
        'engine.tool_gateway.handler_started_refused',
      );
      return { kind: 'refused', call_id: call.call_id, code: 'run_not_authorized' };
    }

    // ── (4) O HANDLER ───────────────────────────────────────────────────
    const ctx = await deps.buildToolContext(call);
    let resultado: DispatchResult;
    try {
      resultado = await deps.dispatch({ tool: call.name, args: call.args, ctx });
    } catch (err) {
      /**
       * O handler lançou. NÃO é `denied`: uma exceção depois de o dispatcher
       * ter começado não prova que nada aconteceu — a tool pode ter emitido o
       * boleto e falhado ao gravar o retorno. `effect_unknown` é o único
       * desfecho honesto, e é o que impede um retry de duplicar efeito.
       */
      logger.error(
        {
          run_id: identity.run_id,
          call_id: call.call_id,
          tool: call.name,
          err: (err as Error).message,
          ops_alert: true,
        },
        'engine.tool_gateway.handler_threw_effect_unknown',
      );
      await deps.settle({
        ...base,
        call_id: admissao.call_id,
        expected_row_version: marcou.row_version,
        dispatch_token: congelou.dispatch_token,
        outcome: { kind: 'effect_unknown', result: null },
      });
      return { kind: 'refused', call_id: call.call_id, code: 'effect_unknown' };
    }

    // ── (5) LIQUIDAÇÃO ──────────────────────────────────────────────────
    const erro = ehErroDeHandler(resultado);
    const outcome: ToolSettlement = erro
      ? { kind: 'denied', result: resultado as Json }
      : { kind: 'completed', result: resultado as Json, receipt: null };

    const liquidou = await deps.settle({
      ...base,
      call_id: admissao.call_id,
      expected_row_version: marcou.row_version,
      dispatch_token: congelou.dispatch_token,
      outcome,
    });

    if (!liquidou.ok) {
      /**
       * O handler RODOU e a liquidação falhou. O efeito existe no mundo e o
       * journal não o registrou — a definição de incerteza. Devolver o
       * resultado aqui faria o motor seguir em cima de um efeito que a Maia não
       * consegue provar depois de um crash.
       */
      logger.error(
        {
          run_id: identity.run_id,
          call_id: call.call_id,
          reason: liquidou.reason,
          ops_alert: true,
        },
        'engine.tool_gateway.settle_failed_after_effect',
      );
      return { kind: 'refused', call_id: call.call_id, code: 'effect_unknown' };
    }

    return {
      kind: 'result',
      call_id: call.call_id,
      result: resultado as Json,
      is_error: erro,
    };
  };
}
