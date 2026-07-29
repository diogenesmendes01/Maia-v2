import { mensagensRepo, pendingQuestionsRepo } from '@/db/repositories.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';
import { audit } from '@/governance/audit.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import { callLLM, type LLMMessage, type ToolSchema } from '@/lib/claude.js';
import { logger } from '@/lib/logger.js';
import { dispatchTool } from '@/tools/_dispatcher.js';
import { REGISTRY } from '@/tools/_registry.js';
import { forCurrentAgentChannel } from '@/gateway/line-output.js';
import { uuid } from '@/lib/utils.js';
import { safeDispatchOutput, type LatestPending, type LatestReportPdf } from './output-dispatch.js';
import { detectGap } from './gap-detector.js';
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import { CognitiveEventType } from '@/types/enums.js';
import { buildToolSummary, type ToolExecutionSummary } from './tool-execution-summary.js';

/**
 * Codex C1 (PR #74): when the ReAct loop exits without dispatching outbound
 * (iteration cap, empty final text, or outbound failure) but tools ran,
 * persist the tool summaries via a placeholder "event-only" mensagem so
 * the next turn's prompt-builder can still surface them in the
 * "## Eventos confirmados pelo backend" block. Best-effort: if persistence
 * fails, the next turn loses its anchor — that's the soft failure mode.
 */
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
    logger.warn(
      { err: (err as Error).message, conversa_id, reason },
      'agent.tool_summaries_flush_failed',
    );
  }
}

export const MAX_REACT_ITERATIONS = 5;

export type RunReActLoopParams = {
  pessoa: Pessoa;
  conversa: Conversa;
  inbound: Mensagem;
  scope: { entidades: string[]; byEntity: Map<string, ResolvedPermission> };
  jid: string;
  system: string;
  messages: LLMMessage[];
  tools: ToolSchema[];
  /**
   * [P88-C4] Optional announcement (e.g., "switching to suporte mode")
   * prepended to the final outbound text. null when policy.announce_mode
   * says no announcement should be emitted this turn. The model never sees
   * this text — it's a system-emitted prefix attached at dispatch time.
   */
  outboundPrefix?: string | null;
};

export type ReActLoopResult = {
  totalTokens: number;
  /** Final assistant text sent to the user (empty string when no end_turn produced text). */
  outboundText: string;
  /**
   * P3b Task 9: captured tool invocations across all iterations so the
   * post-turn step-evaluator can match tool_result success criteria.
   * Each entry has the tool name and the raw dispatcher output.
   */
  toolsCalled: Array<{ name: string; result: unknown }>;
  /**
   * Issue #503 — resultado DURÁVEL do turno, para que `core.ts` decida o
   * outcome da máquina de estados em vez de assumir "a função retornou, logo o
   * turno terminou". Antes desta issue o loop encerrava com texto vazio tanto
   * numa falha do reasoner quanto numa falha pre-send do outbound, e o caller
   * marcava tudo como processado — os cenários A e B da issue.
   */
  delivery: ReActDelivery;
};

export type ReActDelivery = {
  /** true quando o outbound foi efetivamente despachado ao usuário. */
  dispatched: boolean;
  /**
   * Por que o loop terminou sem despachar (ou, quando despachou, o motivo é
   * irrelevante e vale `empty_final_text`).
   *   reasoner_failed  — timeout/erro do LLM: NADA foi produzido, retry é seguro;
   *   outbound_failure — resposta produzida, envio falhou PRE-SEND: nada chegou
   *                      ao usuário, retry é seguro;
   *   empty_final_text — o modelo terminou sem texto: turno concluído sem resposta;
   *   iteration_cap    — teto de iterações com tools executadas: NÃO reexecutar
   *                      (efeitos colaterais já ocorreram).
   */
  exitReason: ReActExitReason;
  /**
   * Enviado ao usuário, mas a persistência do outbound falhou/ficou ambígua.
   * NUNCA reenviar: o outcome correto é `reply_delivery_unknown`.
   */
  persistUnknown: boolean;
  /**
   * Alguma tool com `side_effect` `write`/`communication` foi INVOCADA neste
   * turno. Quando true, um retry pode DUPLICAR o efeito (transação criada duas
   * vezes, mensagem enviada duas vezes), então o turno não pode voltar para a
   * fila — vai para dead letter com outcome `unsafe_to_retry` e exige decisão
   * humana. Conservador por construção: marca na invocação, não no sucesso.
   */
  sideEffectsCommitted: boolean;
};

export type ReActExitReason =
  | 'reasoner_failed'
  | 'outbound_failure'
  | 'empty_final_text'
  | 'iteration_cap';

/**
 * Runs the ReAct iteration loop. Keeps the LLM call → tool execution cycle
 * going until the model stops requesting tools (or the iteration cap is
 * reached). On end_turn (`tool_uses.length === 0`) it hands off to
 * `dispatchOutput` so the right output channel (PDF/voice/text/poll) is used.
 *
 * Returns the total tokens consumed across iterations so the caller can
 * persist it via `mensagensRepo.markProcessed`, plus the final outbound
 * text and the list of tools invoked — both used by the post-turn
 * procedure step-evaluator wired in `core.ts`.
 */
export async function runReActLoop(params: RunReActLoopParams): Promise<ReActLoopResult> {
  const { pessoa, conversa: c, inbound, jid, system, messages, tools } = params;
  let totalTokens = 0;
  const conversation: LLMMessage[] = messages;
  let latestPending: LatestPending | null = null;
  let turnHasSensitive = false;
  const sensitiveTools: string[] = [];
  let latestReportPdf: LatestReportPdf | null = null;
  let outboundText = '';
  const toolsCalled: Array<{ name: string; result: unknown }> = [];
  // Issue #73 — accumulator of structured per-tool summaries used both for
  // anti-anchoring (next-turn events block) and as the audit trail. Persisted
  // in `mensagens.ferramentas_chamadas` of the dispatched outbound, or via
  // `flushUnconfirmedToolSummaries` when no outbound was dispatched.
  const toolSummaries: ToolExecutionSummary[] = [];
  // Codex C1 (PR #74): tracks whether any iteration successfully ran the
  // outbound dispatch path. `false` at exit + non-empty toolSummaries triggers
  // the placeholder flush so the next turn's anchor isn't lost.
  let outboundDispatched = false;
  // Reason recorded when we exit the loop without dispatching outbound.
  // Defaults to empty_final_text (the model returned no end_turn text);
  // overridden to 'iteration_cap' when we hit MAX_REACT_ITERATIONS.
  let exitReason: ReActExitReason = 'empty_final_text';
  // Issue #503 — dispatch entregue mas persistência ambígua: o usuário TEM a
  // resposta, então nunca reenviar; o outcome é `reply_delivery_unknown`.
  let persistUnknown = false;
  // Issue #503 — alguma tool com efeito externo irreversível chegou a rodar?
  // Enquanto false, um retry é seguro; a partir de true, não é.
  let sideEffectsCommitted = false;

  for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
    const reasonerResult = await runCognitiveModule(
      {
        name: 'reasoner',
        version: 'v1',
        triggered_by: 'sync_required',
        timeoutMs: 30000,
        conversa_id: c.id,
        turno_id: inbound.id,
      },
      () =>
        callLLM({
          system,
          messages: conversation,
          tools,
          max_tokens: 1024,
          pessoa_id: pessoa.id,
        }),
    );
    const res = reasonerResult.output;
    if (!res) {
      // Reasoner falhou (timeout/erro) — encerra loop com resposta vazia.
      // Não joga exception nem trava o worker; turn termina sem reply útil.
      logger.warn(
        { conversa_id: c.id, mensagem_id: inbound.id, status: reasonerResult.status },
        'react_loop.reasoner_failed',
      );
      // #503 cenário A: o turno NÃO está concluído — nada foi produzido nem
      // entregue. O caller agenda retry em vez de marcar `completed`.
      exitReason = 'reasoner_failed';
      break;
    }
    totalTokens += res.usage.input_tokens + res.usage.output_tokens;

    if (res.tool_uses.length === 0) {
      const rawText = res.content?.trim() ?? '';
      // [P88-C4] Prepend the role-switch announcement (if any) to the
      // final outbound. Only attaches when the model actually produced
      // text — an empty turn stays empty (no orphan announcement bubble).
      const prefix = params.outboundPrefix;
      const text =
        rawText && typeof prefix === 'string' && prefix.length > 0
          ? `${prefix}\n\n${rawText}`
          : rawText;
      outboundText = text;
      if (text) {
        // Centralised, never-throwing dispatch (Codex #216 HIGH-1). We are the
        // terminal ReAct turn, so there's no further fallback: on a not_sent
        // (pre-send / disconnected) outcome NOTHING reached the user — record an
        // outbound_failure exit (tool summaries still flush below) instead of
        // silently marking the turn delivered.
        const outcome = await safeDispatchOutput({
          pessoa,
          conversa: c,
          inbound,
          jid,
          text,
          latestPending,
          latestReportPdf,
          turnHasSensitive,
          sensitiveTools,
        });
        if (outcome.status === 'not_sent') {
          logger.warn(
            { conversa_id: c.id, mensagem_id: inbound.id, err: outcome.error },
            'react_loop.outbound_not_delivered',
          );
          exitReason = 'outbound_failure';
          break;
        }
        if (outcome.status === 'sent_no_persist') {
          // Sent but persist failed (or ambiguous) — user has it; do NOT re-send.
          logger.error(
            { conversa_id: c.id, mensagem_id: inbound.id, err: outcome.error, ops_alert: true },
            'react_loop.dispatch_inconsistency',
          );
          persistUnknown = true;
        }
        outboundDispatched = true;

        // P1 reflection trigger: INTERNAL_GAP. Inspects the final outbound
        // text for self-recognized gaps ("não sei", "preciso verificar",
        // "sem acesso a..."). Fire-and-forget — reflection MUST never
        // block the user-facing reply or the ReAct return.
        // [P88-C4] Use rawText (without role announcement prefix) so the
        // announcement string can't trigger spurious gap detection.
        const gap = detectGap(rawText);
        if (gap.detected) {
          const responseText = rawText;
          const signal = gap.signal ?? '';
          void (async () => {
            try {
              const event = {
                type: CognitiveEventType.INTERNAL_GAP,
                conversa_id: c.id,
                inbound_mensagem_id: inbound.id,
                gap_description: signal,
                attempted_response: responseText,
              } as const;
              const reflected = await reflect(event, { pessoa_id: pessoa.id });
              if (!reflected || !reflected.insight) return;
              const classified = await classify(reflected.insight);
              if (!classified) return;
              await persistCandidate(classified, event);
            } catch (err) {
              logger.warn(
                { err: (err as Error).message, mensagem_id: inbound.id },
                'gap.reflection.failed',
              );
            }
          })();
        }
      }
      break;
    }

    // Append assistant turn with tool uses
    conversation.push({
      role: 'assistant',
      content: res.tool_uses.map((tu) => ({
        type: 'tool_use' as const,
        id: tu.id,
        name: tu.tool,
        input: tu.args,
      })),
    });

    // Execute tools and add results
    const results = [];
    for (const tu of res.tool_uses) {
      // Superpowers I4 (PR #74): capture the dispatch START timestamp so the
      // summary's `occurred_at` reflects when the side effect was requested,
      // not when it completed. Matters for long-running tools whose
      // completion straddles the events-block 24h window boundary.
      const dispatched_at = Date.now();
      const out = await dispatchTool({
        tool: tu.tool,
        args: tu.args,
        ctx: {
          pessoa,
          scope: params.scope,
          conversa: c,
          mensagem_id: inbound.id,
          request_id: uuid(),
        },
      });
      const isError = typeof out === 'object' && out !== null && 'error' in out;

      // Issue #503 — RASTREIO DE EFEITO IRREVERSÍVEL. Uma tool `write` ou
      // `communication` pode ter alterado estado externo (transação criada,
      // mensagem enviada). Se o turno falhar DEPOIS disso, reexecutar o ReAct
      // duplicaria o efeito, então o turno não pode ser `retryable`.
      //
      // Deliberadamente conservador: marcamos na INVOCAÇÃO, não no sucesso. Um
      // `isError` do dispatcher não prova que nada foi aplicado (pode ter
      // falhado depois do commit externo), e o custo de errar para o lado
      // seguro é uma intervenção manual; para o outro lado é cobrar o cliente
      // duas vezes.
      const spec = REGISTRY[tu.tool];
      if (spec?.side_effect === 'write' || spec?.side_effect === 'communication') {
        sideEffectsCommitted = true;
      }

      // P3b Task 9: capture every tool invocation for the post-turn
      // step-evaluator (tool_result success criteria).
      toolsCalled.push({ name: tu.tool, result: out });

      // B0: capture the freshly-created pending id, with re-validation against
      // the dispatcher's 5-min idempotency cache.
      if (
        tu.tool === 'ask_pending_question' &&
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
        const stillActive = await pendingQuestionsRepo
          .findActiveSnapshot(c.id)
          .catch(() => null);
        if (stillActive && stillActive.id === candidate.pending_question_id) {
          latestPending = {
            id: candidate.pending_question_id,
            opcoes_validas: candidate.opcoes_validas,
          };
        } else {
          logger.warn(
            { tool: tu.tool, candidate: candidate.pending_question_id, conversa_id: c.id },
            'agent.stale_pending_id_dropped',
          );
        }
      }

      // Sub-A: silent ack via reaction on side-effect tool outcomes.
      const tool = REGISTRY[tu.tool];
      // B3a: track sensitive tools dispatched in this turn. The dedup guard
      // (`!sensitiveTools.includes`) keeps the audit's `sensitive_tools`
      // list as a unique set even when the LLM dispatches the same tool
      // multiple times (e.g., balance for two entidade_ids).
      if (tool?.sensitive && !sensitiveTools.includes(tu.tool)) {
        turnHasSensitive = true;
        sensitiveTools.push(tu.tool);
      }

      // B3b: capture PDF report result for outbound document send.
      if (
        tu.tool === 'generate_report' &&
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
        latestReportPdf = {
          path: r.path,
          fileName: r.fileName,
          mimetype: r.mimetype,
          tipo: r.tipo,
        };
      }
      const isSideEffect =
        tool && (tool.side_effect === 'write' || tool.side_effect === 'communication');
      if (isSideEffect) {
        const wid = (inbound.metadata as Record<string, unknown> | null)?.['whatsapp_id'];
        if (typeof wid === 'string') {
          // Fase 0 (spec roteamento v4 §1.6): reação (efêmera) sai pela
          // fronteira LineOutput do canal da conversa. Best-effort — falha de
          // resolução só suprime a reação, nunca o turno.
          const emoji: '✅' | '❌' | null = !isError
            ? '✅'
            : ['forbidden', 'requires_dual_approval'].includes(
                  (out as { error: string }).error,
                )
              ? '❌'
              : null;
          if (emoji) {
            await forCurrentAgentChannel(c.channel_id)
              .then((line) => line.sendReaction(jid, wid, emoji))
              .catch((err) =>
                logger.debug(
                  { err: (err as Error).message },
                  'react_loop.reaction_line_unresolved',
                ),
              );
          }
        }
      }

      results.push({
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        content: JSON.stringify(out),
        is_error: isError,
      });

      // Issue #73 — accumulate a structured summary for next-turn persistence.
      // Side-effect 'none' tools (parse_only) still get summarized to keep
      // the audit trail intact; the prompt-builder events-block filters by
      // priority later.
      toolSummaries.push(
        buildToolSummary({
          tool_call_id: tu.id,
          tool_name: tu.tool,
          side_effect: tool?.side_effect ?? 'none',
          args: tu.args,
          result: out,
          status: isError ? 'error' : 'success',
          dispatched_at,
        }),
      );

      await audit({
        acao: (isError ? 'unauthorized_access_attempt' : 'classification_suggested') as never,
        pessoa_id: pessoa.id,
        conversa_id: c.id,
        mensagem_id: inbound.id,
        metadata: { tool: tu.tool },
      });
    }
    conversation.push({ role: 'user', content: results });
    // If we completed the final iteration with tool_uses, we'll exit the
    // for-loop without dispatching outbound. Mark for the flush path.
    if (i === MAX_REACT_ITERATIONS - 1) {
      exitReason = 'iteration_cap';
    }
  }

  // Codex C1 (PR #74): when no outbound was dispatched but tools ran, persist
  // their summaries via a placeholder event row so the next turn's
  // prompt-builder still surfaces them in the "## Eventos confirmados pelo
  // backend" block. Covers iteration-cap and empty-final-text paths.
  if (!outboundDispatched && toolSummaries.length > 0) {
    await flushUnconfirmedToolSummaries(
      c.id,
      inbound.id,
      toolSummaries,
      exitReason,
    );
  }

  return {
    totalTokens,
    outboundText,
    toolsCalled,
    delivery: { dispatched: outboundDispatched, exitReason, persistUnknown, sideEffectsCommitted },
  };
}
