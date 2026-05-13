import { CognitiveLayer, CognitiveEventType } from '@/types/enums.js';
import type { ModuleDescriptor, GraphContext } from './types.js';
import { evaluateCurrentStep } from '@/cognition/step-evaluator.js';
import * as procedureEngine from '@/procedures/engine.js';
import { procedureExecutionsRepo, procedureDefinitionsRepo } from '@/db/repositories.js';
import { reflectOnCorrection, detectCorrection, findPreviousAssistantMessage } from '@/agent/reflection.js';
import { detectSuccess } from '@/agent/success-detector.js';
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
import { recordSuccess } from '@/cognition/capability-tracker.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';

/**
 * Contexto do grafo pós-resposta. Carrega o turn já materializado:
 * a inbound do usuário, a resposta outbound (texto + tools chamadas) e
 * uma referência opcional à execução de procedure ativa pra rodar o
 * step-evaluator.
 */
export type PostturnContext = GraphContext & {
  conversa_id: string;
  turno_id: string;
  pessoa: Pessoa;
  conversa: Conversa;
  inbound: Mensagem;
  /** Texto outbound da resposta (do react-loop). */
  response_text: string;
  /** Tools chamadas no turn (para step-evaluator tool_result). */
  tools_called: Array<{ name: string; result: unknown }>;
  /** Execução de procedure ativa (pode estar null). */
  active_execution_id: string | null;
};

/**
 * Constrói a lista de nodes pós-resposta. Todos ASYNC (fire-and-forget)
 * mantendo a semântica atual do `agent/core.ts` por não-regressão: o
 * step-evaluator continua não bloqueando o ack do turn — o trigger de
 * avanço/conclusão da execution roda fora do happy-path crítico.
 *
 * Cada node tem `runWhen` para evitar trabalho desnecessário quando não
 * há trigger (execução inexistente, mensagem que não parece correção,
 * mensagem que não parece sucesso).
 */
export function buildPostturnNodes(): ModuleDescriptor<PostturnContext, unknown>[] {
  return [
    {
      name: 'step-evaluator-trigger',
      layer: CognitiveLayer.ASYNC,
      modelTier: 'deterministic',
      timeoutMs: 10000,
      version: 'v1',
      runWhen: (ctx) => ctx.active_execution_id !== null,
      run: async (ctx) => {
        const exec = await procedureExecutionsRepo.findById(ctx.active_execution_id!);
        if (!exec || exec.status !== 'in_progress') return null;
        const def = await procedureDefinitionsRepo.findById(exec.definition_id);
        if (!def) return null;
        const evalResult = await evaluateCurrentStep({
          execution: exec,
          definition: def,
          response_context: {
            response_text: ctx.response_text,
            tools_called: ctx.tools_called,
            user_message: ctx.inbound.conteudo ?? '',
          },
        });
        if (!evalResult.step_completed) return evalResult;
        if (evalResult.next_step_id) {
          await procedureEngine.advanceStep({
            execution_id: exec.id,
            next_step_id: evalResult.next_step_id,
            completed_step_id: exec.current_step_id!,
          });
        } else {
          await procedureEngine.completeExecution({ execution_id: exec.id, outcome: 'success' });
        }
        return evalResult;
      },
    },
    {
      name: 'correction-reflection',
      layer: CognitiveLayer.ASYNC,
      modelTier: 'reasoning',
      timeoutMs: 15000,
      version: 'v1',
      runWhen: (ctx) => ctx.inbound.conteudo !== null && detectCorrection(ctx.inbound.conteudo),
      run: async (ctx) => {
        const prev = await findPreviousAssistantMessage(ctx.conversa.id, ctx.inbound.id);
        if (!prev) return null;
        await reflectOnCorrection({
          pessoa: ctx.pessoa,
          conversa: ctx.conversa,
          inbound: ctx.inbound,
          previousAssistant: prev,
        });
        return 'ok';
      },
    },
    {
      name: 'success-reflection',
      layer: CognitiveLayer.ASYNC,
      modelTier: 'reasoning',
      timeoutMs: 15000,
      version: 'v1',
      runWhen: (ctx) => ctx.inbound.conteudo !== null && detectSuccess(ctx.inbound.conteudo),
      run: async (ctx) => {
        const signal = ctx.inbound.conteudo!;
        const event = {
          type: CognitiveEventType.SUCCESS_EXPLICIT,
          conversa_id: ctx.conversa.id,
          inbound_mensagem_id: ctx.inbound.id,
          signal,
          context_summary: '',
        } as const;
        const reflected = await reflect(event, { pessoa_id: ctx.pessoa.id });
        if (!reflected || !reflected.insight) return null;
        const classified = await classify(reflected.insight);
        if (!classified) return null;
        await persistCandidate(classified, event);
        await recordSuccess({ domain: 'general' });
        return 'ok';
      },
    },
  ];
}
