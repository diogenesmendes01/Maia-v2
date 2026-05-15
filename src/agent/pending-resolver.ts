import { logger } from '@/lib/logger.js';
import { withTx } from '@/db/client.js';
import { pendingQuestionsRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { dispatchTool } from '@/tools/_dispatcher.js';
import { resolveScope } from '@/governance/permissions.js';
import { uuid } from '@/lib/utils.js';
import type { Pessoa, Conversa } from '@/db/schema.js';

export type ResolveSource = 'gate' | 'reaction' | 'poll_vote';

const SOURCE_TO_AUDIT: Record<ResolveSource, string> = {
  gate: 'pending_resolved_by_gate',
  reaction: 'pending_resolved_by_reaction',
  poll_vote: 'pending_resolved_by_poll',
};

export type ResolveAndDispatchInput = {
  pessoa: Pessoa;
  conversa: Conversa;
  mensagem_id: string;
  expected_pending_id: string;
  option_chosen: string;
  confidence: number;
  source: ResolveSource;
};

export type ResolveAndDispatchOutput =
  | { resolved: true; action_tool?: string }
  | { resolved: false; race_lost: true };

export async function resolveAndDispatch(
  input: ResolveAndDispatchInput,
): Promise<ResolveAndDispatchOutput> {
  type Captured =
    | { action: { tool?: string; args?: Record<string, unknown> } }
    | { race_lost: true };

  const captured: Captured = await withTx(async (tx): Promise<Captured> => {
    const locked = await pendingQuestionsRepo.findActiveForUpdate(tx, input.conversa.id);
    if (!locked || locked.id !== input.expected_pending_id) {
      await audit({
        acao: 'pending_race_lost',
        pessoa_id: input.pessoa.id,
        conversa_id: input.conversa.id,
        mensagem_id: input.mensagem_id,
        metadata: {
          pending_question_id: input.expected_pending_id,
          source: input.source,
          observed_id: locked?.id ?? null,
        },
      });
      return { race_lost: true };
    }
    await pendingQuestionsRepo.resolveTx(tx, locked.id, {
      option_chosen: input.option_chosen,
      confidence: input.confidence,
      source: input.source,
    });
    await audit({
      acao: SOURCE_TO_AUDIT[input.source] as never,
      pessoa_id: input.pessoa.id,
      conversa_id: input.conversa.id,
      mensagem_id: input.mensagem_id,
      alvo_id: locked.id,
      metadata: { option_chosen: input.option_chosen, confidence: input.confidence },
    });
    return {
      action: (locked.acao_proposta ?? {}) as { tool?: string; args?: Record<string, unknown> },
    };
  });

  if ('race_lost' in captured) return { resolved: false, race_lost: true };

  const action = captured.action;

  // Blocker 1 — Scheduling-aware routing. When the pending_question came
  // from a scheduling occurrence, the chosen option (sim/nao/adiar) must
  // route through `resolvePaymentOccurrence`, which dispatches
  // `register_transaction` ONLY on 'sim'. The previous code path
  // dispatched `acao_proposta.tool` for any option, which meant 'nao' /
  // 'adiar' could still register a transaction.
  const schedulingKind = (action as Record<string, unknown>)['scheduling_kind'];
  if (schedulingKind === 'payment_due') {
    const occurrence_id = (action as Record<string, unknown>)['occurrence_id'] as
      | string
      | undefined;
    const payload = (action as Record<string, unknown>)['payload'] as
      | { tool: string; args: Record<string, unknown> }
      | undefined;
    if (occurrence_id) {
      try {
        const { resolvePaymentOccurrence } = await import('@/scheduling/engine.js');
        const decision = (input.option_chosen as 'sim' | 'nao' | 'adiar') ?? 'nao';
        const result = await resolvePaymentOccurrence(occurrence_id, decision, payload ?? null, {
          pessoa: input.pessoa,
          conversa: input.conversa,
          mensagem_id: input.mensagem_id,
        });
        await audit({
          acao: 'pending_action_dispatched',
          pessoa_id: input.pessoa.id,
          conversa_id: input.conversa.id,
          mensagem_id: input.mensagem_id,
          occurrence_id,
          metadata: {
            scheduling_kind: 'payment_due',
            decision,
            dispatched_tool: result.dispatched_tool,
            source: input.source,
          },
        });
        return { resolved: true, action_tool: result.dispatched_tool ?? undefined };
      } catch (err) {
        logger.error(
          { err: (err as Error).message, occurrence_id, source: input.source },
          'pending_resolver.payment_due_failed',
        );
        return { resolved: true };
      }
    }
  }

  if (schedulingKind === 'outreach_disambiguation') {
    try {
      const { applyDisambiguationDecision } = await import('@/scheduling/disambiguation.js');
      const acao = action as {
        candidates?: Array<{ key: string; occurrence_id: string }>;
        inbound_mensagem_id?: string;
        response_text?: string;
      };
      if (acao.candidates && acao.inbound_mensagem_id !== undefined && acao.response_text !== undefined) {
        const result = await applyDisambiguationDecision({
          pending_question_id: input.expected_pending_id,
          chosen_key: input.option_chosen,
          acao_proposta: {
            candidates: acao.candidates,
            inbound_mensagem_id: acao.inbound_mensagem_id,
            response_text: acao.response_text,
          },
        });
        await audit({
          acao: 'pending_action_dispatched',
          pessoa_id: input.pessoa.id,
          conversa_id: input.conversa.id,
          mensagem_id: input.mensagem_id,
          occurrence_id: result.routed_to,
          metadata: { scheduling_kind: 'outreach_disambiguation', source: input.source },
        });
      }
      return { resolved: true };
    } catch (err) {
      logger.error(
        { err: (err as Error).message, source: input.source },
        'pending_resolver.disambiguation_failed',
      );
      return { resolved: true };
    }
  }

  if (!action.tool) return { resolved: true };

  try {
    const scope = await resolveScope(input.pessoa);
    await dispatchTool({
      tool: action.tool,
      args: { ...(action.args ?? {}), _pending_choice: input.option_chosen },
      ctx: {
        pessoa: input.pessoa,
        scope,
        conversa: input.conversa,
        mensagem_id: input.mensagem_id,
        request_id: uuid(),
      },
    });
    await audit({
      acao: 'pending_action_dispatched',
      pessoa_id: input.pessoa.id,
      conversa_id: input.conversa.id,
      mensagem_id: input.mensagem_id,
      metadata: {
        tool: action.tool,
        pending_question_id: input.expected_pending_id,
        source: input.source,
      },
    });
    return { resolved: true, action_tool: action.tool };
  } catch (err) {
    logger.error(
      { err: (err as Error).message, tool: action.tool, source: input.source },
      'pending_resolver.dispatch_failed',
    );
    return { resolved: true, action_tool: action.tool };
  }
}
