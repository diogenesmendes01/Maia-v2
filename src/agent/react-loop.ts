import { pendingQuestionsRepo } from '@/db/repositories.js';
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
};

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
      await audit({
        acao: (isError ? 'unauthorized_access_attempt' : 'classification_suggested') as never,
        pessoa_id: pessoa.id,
        conversa_id: c.id,
        mensagem_id: inbound.id,
        metadata: { tool: tu.tool },
      });
    }
    conversation.push({ role: 'user', content: results });
  }

  return { totalTokens, outboundText, toolsCalled };
}
