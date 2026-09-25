/**
 * SC01 (spec §5.2, §5.3.3, §5.4.2, §5.9.2) — `runReasonerStage`: o SEAM
 * pós-gates.
 *
 * ─── O que ele substitui ────────────────────────────────────────────────────
 *
 * O §5.2 nomeia este ponto como o "seam principal": o bloco do `core.ts` que
 * chamava `runReActLoop` direto, depois de identidade, canal, pendência,
 * procedimentos e skills já terem decidido o turno. Até aqui o `core.ts` pedia
 * "raciocine E entregue" numa única função, e o resultado vinha como um veredito
 * de entrega indistinguível de um veredito de raciocínio.
 *
 * Agora a ordem é explícita e tem quatro passos, nesta ordem e sem atalho:
 *
 *   1. monta o PEDIDO (`EngineRequestV1`) — só a parte serializável do turno;
 *   2. chama a PORTA local (`AgentEnginePortV1`) com um gateway de ferramentas
 *      que despacha pela Maia e REGISTRA o receipt de cada chamada;
 *   3. monta o resultado CONFIÁVEL com o `EngineResultAssembler`, que deriva
 *      tudo dos receipts e confronta a proposta do motor;
 *   4. entrega pelo `MaiaOutputCoordinator` — e só ele fala com a fachada de
 *      saída (`safeDispatchOutput`).
 *
 * ─── Por que o motor não entrega ────────────────────────────────────────────
 *
 * `runReasoning` (`./maia-reasoning.js`) devolve uma proposta deliberativa e
 * mais nada. Quem despacha é o passo 4, com o journal na mão. Um motor remoto
 * não teria como entregar — não tem o JID, não tem o ledger, não sabe se o
 * envio ficou incerto —, e um motor local que entrega "porque é local" seria a
 * assimetria que faz o caminho remoto nascer diferente do que roda todo dia
 * (§5.9.2).
 *
 * ─── O que continua em Maia, de propósito ───────────────────────────────────
 *
 * - **Governança por tool-use** (`audit`), **reação efêmera** e a recusa por
 *   posse: vivem no gateway de ferramentas, que é Maia (§5.2: "Dispatcher/MCP
 *   bridge, efeito e idempotência" ficam na Maia).
 * - **Reflexão de lacuna**: continua um hook Maia, disparado pelo coordenador
 *   SÓ depois de algo chegar ao usuário. A extração não a transforma em
 *   autoridade do reasoner, e a redelivery não a reexecuta.
 * - **Pós-turno** (grafo cognitivo, step-evaluator): segue no `core.ts`, fora
 *   desta função.
 * - **Desfecho do turno** (`decideTurnAction`): segue no `core.ts`, lendo a
 *   máscara de entrega que este stage devolve.
 */
import { pgErrorCode } from '@/db/client.js';
import { mensagensRepo, pendingQuestionsRepo } from '@/db/repositories.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';
import { audit } from '@/governance/audit.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import { logger } from '@/lib/logger.js';
import { uuid } from '@/lib/utils.js';
import { dispatchTool } from '@/tools/_dispatcher.js';
import { REGISTRY } from '@/tools/_registry.js';
import { forCurrentAgentChannel } from '@/gateway/line-output.js';
import { withDeclaredEgressExceptionSync } from '@/runtime/outbound/egress-guard.js';
import type { EngineToolReplyV1, EngineRequestV1, Json } from './contracts.js';
import { createMaiaEngine } from './maia-engine.js';
import { runReasoning, MAX_REACT_ITERATIONS } from './maia-reasoning.js';
import { runWithLocalEngineHost } from './local-engine-host.js';
import { assembleTurnResult, type EngineToolReceiptV1 } from './assembler.js';
import { coordinateOutput } from './coordinator.js';
import { safeDispatchOutput, type LatestPending, type LatestReportPdf } from '@/agent/output-dispatch.js';
import { detectGap } from '@/agent/gap-detector.js';
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
import { buildToolSummary, type ToolExecutionSummary } from '@/agent/tool-execution-summary.js';
import { CognitiveEventType } from '@/types/enums.js';
import {
  getTurnExecutionContext,
  TurnOwnershipLostError,
} from '@/runtime/turns/execution-context.js';
import type {
  ReActDelivery,
  ReActExitReason,
  ReActLoopResult,
  RunReActLoopParams,
} from '@/agent/react-types.js';

/**
 * `run_id`/`request_key` do motor LOCAL.
 *
 * A porta os exige porque um motor remoto precisa deles para correlacionar
 * frames. O laço local não tem run durável — ele É o turno —, então usa um
 * UUID nulo em vez de fabricar identificadores que ninguém poderia procurar
 * depois. Um id inventado aqui vazaria para a proposta e pareceria referência
 * a um run que não existe.
 */
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** Sinal de composição quando o raciocínio roda fora de um turno reivindicado. */
const SINAL_SEM_TURNO = new AbortController().signal;

/**
 * Gatilho de reflexão de lacuna, disparado SÓ depois de algo chegar ao usuário.
 *
 * Saiu de dentro da fachada de saída quando ela virou o coordenador, e a regra
 * que ele carrega é a mesma de antes: fire-and-forget, nunca bloqueia a
 * resposta, e recebe o texto CRU — sem o prefixo de anúncio de role, que é
 * frase da Maia e dispararia lacuna por conta própria ([P88-C4]).
 */
function dispararReflexaoDeLacuna(
  rawText: string,
  ctx: { conversa_id: string; inbound_id: string; pessoa_id: string },
): void {
  const gap = detectGap(rawText);
  if (!gap.detected) return;
  const signal = gap.signal ?? '';
  void (async () => {
    try {
      const event = {
        type: CognitiveEventType.INTERNAL_GAP,
        conversa_id: ctx.conversa_id,
        inbound_mensagem_id: ctx.inbound_id,
        gap_description: signal,
        attempted_response: rawText,
      } as const;
      const reflected = await reflect(event, { pessoa_id: ctx.pessoa_id });
      if (!reflected || !reflected.insight) return;
      const classified = await classify(reflected.insight);
      if (!classified) return;
      await persistCandidate(classified, event);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, mensagem_id: ctx.inbound_id },
        'gap.reflection.failed',
      );
    }
  })();
}

/**
 * Codex C1 (PR #74): when the ReAct loop exits without dispatching outbound
 * (iteration cap, empty final text, or outbound failure) but tools ran,
 * persist the tool summaries via a placeholder "event-only" mensagem so
 * the next turn's prompt-builder can still surface them in the
 * "## Eventos confirmados pelo backend" block.
 *
 * Issue #577 — `tipo: 'evento'` só passou a caber no CHECK de `mensagens.tipo`
 * em `migrations/116_mensagens_tipo_evento.sql`. Antes disso TODO INSERT daqui
 * violava `mensagens_tipo_check`, o catch abaixo engolia, e o helper era código
 * morto: o rastro de ferramentas de qualquer turno sem outbound sumia do
 * histórico deixando só um `warn`.
 *
 * ─── Por que continua best-effort ──────────────────────────────────────────
 *
 * Porque falhar o turno aqui é ESTRITAMENTE PIOR, e a razão está escrita no
 * caller: em `src/agent/core.ts` ("`iteration_cap` NÃO é retryable: tools já
 * rodaram, reexecutar duplicaria efeito colateral"). Este flush só roda nos
 * caminhos SEM outbound — exatamente aqueles em que as tools já rodaram e
 * `sideEffectsCommitted` pode estar marcado. Um throw daqui subiria como erro
 * genérico, o turno viraria falha e o recovery reexecutaria o ReAct do zero:
 * trocaríamos a perda de UM anchor de prompt pela duplicação de um efeito
 * externo irreversível (um boleto emitido duas vezes).
 *
 * E o invariante de auditoria da §4 não depende desta row: o gateway já
 * escreveu um `audit()` em `audit_log` por tool-use, ANTES de chegar aqui. Esta
 * row é o anchor anti-anchoring do turno SEGUINTE, não o livro-razão.
 */
function classifyFlushFailure(err: unknown): {
  failure_kind: 'permanent' | 'transient';
  pg_code: string | undefined;
  pg_constraint: string | undefined;
} {
  const pg_code = pgErrorCode(err);
  // 22xxx data exception, 23xxx integrity constraint violation — nenhuma delas
  // muda de resultado na próxima tentativa: é esquema ou código, não infra.
  const permanent =
    typeof pg_code === 'string' && (pg_code.startsWith('22') || pg_code.startsWith('23'));
  let constraint: unknown;
  for (let cur: unknown = err, depth = 0; cur != null && depth < 8; depth++) {
    const c = (cur as { constraint?: unknown }).constraint;
    if (typeof c === 'string' && c.length > 0) {
      constraint = c;
      break;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return {
    failure_kind: permanent ? 'permanent' : 'transient',
    pg_code,
    pg_constraint: typeof constraint === 'string' ? constraint : undefined,
  };
}

async function flushUnconfirmedToolSummaries(
  conversa_id: string,
  inbound_id: string,
  toolSummaries: ToolExecutionSummary[],
  reason: ReActExitReason,
): Promise<void> {
  if (toolSummaries.length === 0) return;
  try {
    await mensagensRepo.create({
      conversa_id,
      direcao: 'out',
      tipo: 'evento',
      conteudo: '',
      midia_url: null,
      metadata: {
        in_reply_to: inbound_id,
        event_only: true,
        flush_reason: reason,
      },
      processada_em: new Date(),
      ferramentas_chamadas: toolSummaries,
      tokens_usados: null,
    });
    logger.info(
      { conversa_id, inbound_id, count: toolSummaries.length, reason },
      'agent.tool_summaries_flushed_no_outbound',
    );
  } catch (err) {
    const { failure_kind, pg_code, pg_constraint } = classifyFlushFailure(err);
    // `err` do Drizzle traz a query e os PARÂMETROS inteiros na mensagem — ou
    // seja, o conteúdo das ferramentas — então nunca o repassamos cru.
    const fields = {
      conversa_id,
      inbound_id,
      reason,
      count: toolSummaries.length,
      failure_kind,
      pg_code: pg_code ?? null,
      pg_constraint: pg_constraint ?? null,
      err: (err as Error).name,
    };
    if (failure_kind === 'permanent') {
      logger.error(fields, 'agent.tool_summaries_flush_rejected');
    } else {
      logger.warn(fields, 'agent.tool_summaries_flush_failed');
    }
  }
}

/**
 * O GATEWAY DE FERRAMENTAS deste turno — Maia, e não engine.
 *
 * Ele é o único caminho pelo qual o raciocínio toca o mundo: recebe
 * `EngineToolCallV1`, despacha pelo dispatcher da casa e devolve
 * `EngineToolReplyV1`. Como efeito colateral legítimo, acumula os RECEIPTS —
 * que são a fonte do assembler (§5.3.4: o motor afirma, a Maia prova).
 *
 * Mora aqui, e não em `./reasoner-stage.js` como função solta, porque o que ele
 * precisa é do contexto do turno (pessoa, conversa, inbound, escopo) e do
 * estado acumulado do turno (último pending, último PDF, efeito irreversível) —
 * e amarrar os dois num objeto é o que impede o call site de esquecer um.
 *
 * ─── O que ele preserva do laço antigo, linha a linha ───────────────────────
 *
 * 1. **Recusa por POSSE encerra a tentativa** (issue #504). O dispatcher recusa
 *    devolvendo `{ error: 'turn_ownership_lost' }` (contrato daquela fronteira:
 *    um throw seria lido como quebra de plataforma). Traduzimos para
 *    `TurnOwnershipLostError` ANTES de qualquer gravação — sem isto, a recusa
 *    virava erro comum de tool, o laço auditava a chamada e o flush do fim
 *    gravava uma row de um turno que já não era nosso.
 * 2. **Efeito irreversível é marcado na INVOCAÇÃO**, não no sucesso (issue
 *    #503): um `isError` do dispatcher não prova que nada foi aplicado.
 * 3. **`pending` e `report_pdf` entram como DELTA** da chamada. Gravar o
 *    acumulado faria toda chamada posterior reafirmar o pending de outra.
 * 4. **Reação efêmera** (`✅`/`❌`) só para tools de efeito, best-effort, pela
 *    exceção de egresso inventariada `agent.react_loop_tool_reaction`.
 */
function criarGatewayDeFerramentas(input: {
  pessoa: Pessoa;
  conversa: Conversa;
  inbound: Mensagem;
  scope: RunReActLoopParams['scope'];
  jid: string;
  receipts: EngineToolReceiptV1[];
  toolSummaries: ToolExecutionSummary[];
  toolsCalled: Array<{ name: string; result: unknown }>;
  estado: {
    sideEffectsCommitted: boolean;
    latestPending: LatestPending | null;
    latestReportPdf: LatestReportPdf | null;
  };
}) {
  const { pessoa, conversa: c, inbound, jid, receipts, toolSummaries, toolsCalled, estado } = input;

  return async function invokeTool(call: {
    call_id: string;
    ordinal: number;
    name: string;
    args: Json;
  }): Promise<EngineToolReplyV1> {
    // Superpowers I4 (PR #74): capture the dispatch START timestamp so the
    // summary's `occurred_at` reflects when the side effect was requested,
    // not when it completed.
    const dispatched_at = Date.now();
    const out = await dispatchTool({
      tool: call.name,
      args: call.args,
      ctx: {
        pessoa,
        scope: input.scope,
        conversa: c,
        mensagem_id: inbound.id,
        request_id: uuid(),
      },
    });
    const isError = typeof out === 'object' && out !== null && 'error' in out;

    /**
     * Issue #504 §Fencing — a RECUSA POR POSSE ENCERRA A TENTATIVA.
     * Antes de `sideEffectsCommitted`, de `toolsCalled`, do `audit()` e do
     * receipt: cada um deles é estado ou gravação desta tentativa, e nenhum lhe
     * pertence mais. O `catch` dedicado do `core.ts` sai sem concluir, sem retry
     * e sem carimbar `processada_em`.
     */
    if (isError && (out as { error: unknown }).error === 'turn_ownership_lost') {
      throw new TurnOwnershipLostError(
        'react_tool_refused',
        getTurnExecutionContext()?.turn_id ?? null,
      );
    }

    const spec = REGISTRY[call.name];
    if (spec?.side_effect === 'write' || spec?.side_effect === 'communication') {
      estado.sideEffectsCommitted = true;
    }

    // P3b Task 9: capture every tool invocation for the post-turn
    // step-evaluator (tool_result success criteria).
    toolsCalled.push({ name: call.name, result: out });

    // Estado ANTES desta chamada, para o receipt registrar o DELTA dela.
    const pendingAntes = estado.latestPending;
    const pdfAntes = estado.latestReportPdf;

    // B0: capture the freshly-created pending id, with re-validation against
    // the dispatcher's 5-min idempotency cache.
    if (
      call.name === 'ask_pending_question' &&
      typeof out === 'object' &&
      out !== null &&
      'pending_question_id' in out &&
      typeof (out as { pending_question_id: string }).pending_question_id === 'string'
    ) {
      const candidate = out as {
        pending_question_id: string;
        opcoes_validas: Array<{ key: string; label: string }>;
      };
      // Re-validate that the candidate is still 'aberta'. Defends against
      // dispatcher-cache returning a stale id from a prior retry within the
      // 5-min idempotency bucket.
      const stillActive = await pendingQuestionsRepo.findActiveSnapshot(c.id).catch(() => null);
      if (stillActive && stillActive.id === candidate.pending_question_id) {
        estado.latestPending = {
          id: candidate.pending_question_id,
          opcoes_validas: candidate.opcoes_validas,
        };
      } else {
        logger.warn(
          { tool: call.name, candidate: candidate.pending_question_id, conversa_id: c.id },
          'agent.stale_pending_id_dropped',
        );
      }
    }

    // B3b: capture PDF report result for outbound document send.
    if (
      call.name === 'generate_report' &&
      !isError &&
      typeof out === 'object' &&
      out !== null &&
      'path' in out &&
      'fileName' in out &&
      'mimetype' in out &&
      'tipo' in out
    ) {
      const r = out as {
        path: string;
        fileName: string;
        mimetype: string;
        tipo: 'extrato' | 'comparativo';
      };
      estado.latestReportPdf = {
        path: r.path,
        fileName: r.fileName,
        mimetype: r.mimetype,
        tipo: r.tipo,
      };
    }

    // Sub-A: silent ack via reaction on side-effect tool outcomes.
    const isSideEffect =
      spec && (spec.side_effect === 'write' || spec.side_effect === 'communication');
    if (isSideEffect) {
      const wid = (inbound.metadata as Record<string, unknown> | null)?.['whatsapp_id'];
      if (typeof wid === 'string') {
        // Fase 0 (spec roteamento v4 §1.6): reação (efêmera) sai pela
        // fronteira LineOutput do canal da conversa. Best-effort — falha de
        // resolução só suprime a reação, nunca o turno.
        const emoji: '✅' | '❌' | null = !isError
          ? '✅'
          : ['forbidden', 'requires_dual_approval'].includes((out as { error: string }).error)
            ? '❌'
            : null;
        if (emoji) {
          // #634 — exceção INVENTARIADA (`agent.react_loop_tool_reaction`):
          // sinal EFÊMERO sobre a mensagem de ENTRADA. A primitiva do Baileys
          // devolve `void`, então um artefato durável para ela nasceria em
          // `delivery_unknown` e alimentaria a reconciliação humana de #633
          // com ruído. Ver `send-paths.ts`.
          await forCurrentAgentChannel(c.channel_id)
            .then((line) =>
              withDeclaredEgressExceptionSync('agent.react_loop_tool_reaction', () =>
                line.sendReaction(jid, wid, emoji),
              ),
            )
            .catch((err) =>
              logger.debug({ err: (err as Error).message }, 'react_loop.reaction_line_unresolved'),
            );
        }
      }
    }

    // Issue #73 — accumulate a structured summary for next-turn persistence.
    const summary = buildToolSummary({
      tool_call_id: call.call_id,
      tool_name: call.name,
      side_effect: spec?.side_effect ?? 'none',
      args: call.args,
      result: out,
      status: isError ? 'error' : 'success',
      dispatched_at,
    });
    toolSummaries.push(summary);

    /**
     * O RECEIPT (§5.9.2.1). Um por chamada DESPACHADA, na ordem em que
     * despachamos. É o que o `EngineResultAssembler` lê para montar o resultado
     * do turno, e a razão de ele existir aqui em vez de ser derivado depois: o
     * que prova a chamada é o dispatcher ter rodado, não o laço ter lembrado.
     */
    receipts.push({
      call_id: call.call_id,
      ordinal: call.ordinal,
      tool_name: call.name,
      result: out,
      status: isError ? 'error' : 'success',
      side_effect: spec?.side_effect ?? null,
      sensitive: spec?.sensitive === true,
      summary,
      pending: estado.latestPending !== pendingAntes ? estado.latestPending : null,
      report_pdf: estado.latestReportPdf !== pdfAntes ? estado.latestReportPdf : null,
    });

    await audit({
      acao: (isError ? 'unauthorized_access_attempt' : 'classification_suggested') as never,
      pessoa_id: pessoa.id,
      conversa_id: c.id,
      mensagem_id: inbound.id,
      metadata: { tool: call.name },
    });

    return { kind: 'result', call_id: call.call_id, result: out as Json, is_error: isError };
  };
}

/**
 * O SEAM. Roda o raciocínio atrás da porta, monta o resultado confiável e
 * entrega pelo coordenador — devolvendo a MESMA `ReActLoopResult` que o laço
 * devolvia antes da extração.
 *
 * A máscara de compatibilidade (`ReActDelivery`) é construída AQUI, depois do
 * coordenador (§5.4.2: "o adapter local de compatibilidade pode construir
 * `ReActDelivery` apenas depois do coordenador de saída"). O motor nunca recebe
 * essa função, e é isso que torna a igualdade entre os dois caminhos uma
 * propriedade estrutural em vez de uma coincidência.
 */
export async function runReasonerStage(params: RunReActLoopParams): Promise<ReActLoopResult> {
  const { pessoa, conversa: c, inbound, jid } = params;

  const receipts: EngineToolReceiptV1[] = [];
  const toolSummaries: ToolExecutionSummary[] = [];
  const toolsCalled: Array<{ name: string; result: unknown }> = [];
  const estado = {
    sideEffectsCommitted: false,
    latestPending: null as LatestPending | null,
    latestReportPdf: null as LatestReportPdf | null,
  };

  const run_id = getTurnExecutionContext()?.turn_id ?? ZERO_UUID;
  /**
   * Limites do motor LOCAL — congelados pela caracterização (§5.1.1):
   * 5 iterações, 1024 tokens de saída por chamada. O teto de custo é `0`
   * porque o motor local não tem orçamento próprio: quem cobra é o gateway de
   * LLM da casa, e um número inventado aqui viraria uma reserva que ninguém
   * liquida.
   */
  const request: EngineRequestV1 = {
    version: 1,
    run_id,
    request_key: ZERO_UUID,
    task: 'reasoner',
    isolation: 'one_run_no_shared_memory',
    context: {
      system: params.system,
      messages: params.messages,
      tools: params.tools,
    },
    limits: {
      max_iterations: MAX_REACT_ITERATIONS,
      max_output_tokens_per_call: 1024,
      max_tool_calls: Math.max(1, params.tools.length * MAX_REACT_ITERATIONS),
      deadline_at: new Date(Date.now() + 30_000).toISOString(),
      max_cost_microusd: '0',
    },
  };

  const gateway = criarGatewayDeFerramentas({
    pessoa,
    conversa: c,
    inbound,
    scope: params.scope,
    jid,
    receipts,
    toolSummaries,
    toolsCalled,
    estado,
  });

  /**
   * UMA instância da porta por execução.
   *
   * O motor local não tem run durável: ele não sobrevive ao processo e nada de
   * fora pode observá-lo depois (`egress: no_run`,
   * `local_engine_has_no_durable_run` — o coordenador já declara isso). Manter
   * um registro em MEMÓRIA por turno, num singleton de processo, faria a
   * segunda tentativa do MESMO turno colidir com o registro da primeira
   * (`request_key_payload_conflict`, §5.6.1) — e a colisão é do mapa, não do
   * turno. Instância por execução mantém a semântica anterior: cada tentativa
   * raciocina do zero.
   */
  const motor = createMaiaEngine({ runReasoning });

  const iniciado = await runWithLocalEngineHost(
    { conversa_id: c.id, turno_id: inbound.id, pessoa_id: pessoa.id },
    () =>
      motor.start(request, {
        signal: getTurnExecutionContext()?.signal ?? SINAL_SEM_TURNO,
        invokeTool: gateway,
      }),
  );

  const observacao = await motor.observe(
    {
      run_id,
      request_key: ZERO_UUID,
      remote_instance_id: motor.pin.adapter_revision,
      remote_run_id: iniciado.kind === 'accepted' ? iniciado.remote_run_id : null,
    },
    SINAL_SEM_TURNO,
  );

  /**
   * O motor local é SÍNCRONO do ponto de vista do caller: `start` só devolve
   * depois de raciocinar, então a observação é terminal — exceto quando a porta
   * recusou o pedido ou a execução sumiu do registro. Nenhum desses casos tem
   * proposta a apresentar, e inventar uma "resposta" ali seria a pior saída
   * possível; `failed/protocol_error` é o desfecho honesto ("este caminho não
   * soube executar isto"), e é o mesmo vocabulário da recusa de pin.
   */
  const proposal =
    observacao.kind === 'terminal'
      ? observacao.proposal
      : {
          version: 1 as const,
          run_id,
          request_key: ZERO_UUID,
          stop: { kind: 'failed' as const, code: 'protocol_error' as const },
          iterations: 0,
          observed_tool_call_ids: [],
          usage: {
            input_tokens: null,
            output_tokens: null,
            cost_microusd: null,
            source: 'unavailable' as const,
          },
        };

  const assembled = assembleTurnResult({
    proposal,
    receipts,
    outboundPrefix: params.outboundPrefix ?? null,
  });

  const coordenado = await coordinateOutput({ pessoa, conversa: c, inbound, jid }, assembled, {
    dispatch: safeDispatchOutput,
    flushUnconfirmedToolSummaries,
    /**
     * C24 — o produtor de `engine_result_fenced`. Neste caminho a divergência é
     * estruturalmente `none` (a lista afirmada pelo motor é derivada do MESMO
     * gateway que grava os receipts), então a linha não chega a ser escrita
     * hoje. Injetar assim mesmo é deliberado: a ação deixa de ser uma entrada
     * do catálogo sem chamador nenhum, e no dia em que o assembler enxergar
     * divergência por aqui — motor remoto, receipt perdido — a trilha já existe.
     */
    audit: (input) => audit(input),
    /**
     * T22 — a declaração, não a omissão. O motor local não tem run durável: não
     * há `engine_runs.id`, não há grant de capacidades e não há
     * `capabilities_revoked_at` para reler. Um fence aqui não protegeria nada e
     * mentiria sobre existir revogação possível.
     */
    egress: { kind: 'no_run', because: 'local_engine_has_no_durable_run' },
    onDelivered: (rawText) =>
      dispararReflexaoDeLacuna(rawText, {
        conversa_id: c.id,
        inbound_id: inbound.id,
        pessoa_id: pessoa.id,
      }),
  });

  const delivery: ReActDelivery = {
    ...coordenado.delivery,
    // O efeito irreversível é rastreado na INVOCAÇÃO pelo gateway, que é mais
    // conservador que derivá-lo do receipt: ele marca mesmo quando o receipt
    // não chegou a ser construído.
    sideEffectsCommitted: estado.sideEffectsCommitted,
  };

  return {
    // `outboundText` continua sendo o texto MONTADO (com prefixo de role), e
    // não o do coordenador: ele é lido por quem só quer saber o que o modelo
    // produziu, inclusive quando o envio falhou.
    totalTokens: assembled.usage.output_tokens ?? 0,
    outboundText: assembled.candidate?.text ?? '',
    toolsCalled,
    delivery,
  };
}