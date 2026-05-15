import { mensagensRepo, pendingQuestionsRepo } from '@/db/repositories.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';
import { audit } from '@/governance/audit.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import { callLLM, type LLMMessage, type ToolSchema } from '@/lib/claude.js';
import { logger } from '@/lib/logger.js';
import { dispatchTool } from '@/tools/_dispatcher.js';
import { REGISTRY } from '@/tools/_registry.js';
import { sendReaction } from '@/gateway/presence.js';
import { uuid } from '@/lib/utils.js';
import { dispatchOutput, type LatestPending, type LatestReportPdf } from './output-dispatch.js';
import { detectGap } from './gap-detector.js';
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
import { CognitiveEventType } from '@/types/enums.js';

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
};

/**
 * Runs the ReAct iteration loop. Keeps the LLM call → tool execution cycle
 * going until the model stops requesting tools (or the iteration cap is
 * reached). On end_turn (`tool_uses.length === 0`) it hands off to
 * `dispatchOutput` so the right output channel (PDF/voice/text/poll) is used.
 *
 * Returns the total tokens consumed across iterations so the caller can
 * persist it via `mensagensRepo.markProcessed`.
 */
/**
 * Codex C1 (PR #74): persist accumulated tool summaries to `mensagens.ferramentas_chamadas`
 * when no outbound assistant message gets dispatched (iteration-cap reached,
 * LLM returned empty final text, or a downstream outbound failure occurs).
 * Without this flush, side-effecting tools (writes, communications) that
 * already committed would have no persisted event, letting the NEXT turn
 * re-attempt or deny an already-completed backend action — the exact
 * failure mode this PR was meant to fix.
 *
 * The placeholder row has `direcao='out'` and `tipo='evento'` with empty
 * `conteudo`, so it never surfaces to the LLM as an assistant text turn
 * (prompt-builder ignores empty `conteudo` for the messages array) — but
 * it IS surfaced via `recentInConversation` so the events block reidrates
 * the summaries on the next turn.
 *
 * Best-effort: a persistence failure here is logged but not re-thrown.
 * The audit trail (already written by the loop) is the durable evidence;
 * losing the next-turn anchor is the soft failure mode.
 */
async function flushUnconfirmedToolSummaries(
  conversa_id: string,
  inbound_id: string,
  toolSummaries: ToolExecutionSummary[],
  reason: 'iteration_cap' | 'empty_final_text' | 'outbound_failure',
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

export async function runReActLoop(params: RunReActLoopParams): Promise<{ totalTokens: number }> {
  const { pessoa, conversa: c, inbound, jid, system, messages, tools } = params;
  let totalTokens = 0;
  const conversation: LLMMessage[] = messages;
  let latestPending: LatestPending | null = null;
  let turnHasSensitive = false;
  const sensitiveTools: string[] = [];
  let latestReportPdf: LatestReportPdf | null = null;
  // Issue #73 — structured per-tool outcomes accumulated across all loop
  // iterations. Persisted on the outbound assistant message as
  // `ferramentas_chamadas` so the NEXT turn can reidrate them in the
  // system prompt's "## Eventos confirmados pelo backend" block.
  const toolSummaries: ToolExecutionSummary[] = [];
  let outboundDispatched = false;
  let exitReason: 'normal' | 'iteration_cap' | 'empty_final_text' = 'normal';

  for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
    const res = await callLLM({
      system,
      messages: conversation,
      tools,
      max_tokens: 1024,
      pessoa_id: pessoa.id,
    });
    totalTokens += res.usage.input_tokens + res.usage.output_tokens;

    if (res.tool_uses.length === 0) {
      const text = res.content?.trim() ?? '';
      if (text) {
        await dispatchOutput({
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

        // P1 reflection trigger: INTERNAL_GAP. Inspects the final outbound
        // text for self-recognized gaps ("não sei", "preciso verificar",
        // "sem acesso a..."). Fire-and-forget — reflection MUST never
        // block the user-facing reply or the ReAct return.
        const gap = detectGap(text);
        if (gap.detected) {
          const responseText = text;
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
          if (!isError) {
            sendReaction(jid, wid, '✅');
          } else {
            const errKind = (out as { error: string }).error;
            if (errKind === 'forbidden' || errKind === 'requires_dual_approval') {
              sendReaction(jid, wid, '❌');
            }
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
      exitReason === 'iteration_cap' ? 'iteration_cap' : 'empty_final_text',
    );
  }

  return { totalTokens };
}
