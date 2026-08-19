import { CognitiveLayer } from '@/types/enums.js';
import type { ModuleDescriptor, GraphContext } from './types.js';
import { selectProcedure, type SelectorDecision } from '@/cognition/procedure-selector.js';
import { selectRole } from '@/cognition/role-selector/engine.js';
import type { Role, ChannelPolicy } from '@/db/schema.js';

export type PreturnContext = GraphContext & {
  conversa_id: string;
  turno_id: string;
  inbound_text: string;
  current_execution: { id: string; definition_id: string; status: string } | null;
  /** Quando undefined (ou o node role-selector não foi montado), o role-selector
   *  é omitido. Ver buildPreturnNodes. */
  role_inputs?: {
    current_role: Role;
    available_roles: Role[];
    policy: ChannelPolicy;
    channel_id: string;
  };
};

/**
 * Constrói a lista de nodes pre-turn. Determinísticos (identity, rate-limit,
 * scope, pending-gate) ficam fora do grafo — continuam no fluxo procedural
 * do `agent/core.ts`. O grafo cobre apenas os módulos cognitivos LLM-backed
 * que já passam por `runCognitiveModule` no path legacy.
 */
export function buildPreturnNodes(args: { multi_channel_on: boolean }): ModuleDescriptor<PreturnContext, unknown>[] {
  const nodes: ModuleDescriptor<PreturnContext, unknown>[] = [];

  // Node: procedure-selector
  nodes.push({
    name: 'procedure-selector',
    layer: CognitiveLayer.SYNC_CONDITIONAL,
    modelTier: 'fast',
    timeoutMs: 5000,
    version: 'v1',
    parallelizable: true,
    fallback: null,
    // Issue #507 (achado 2) — `signal` é o sinal COMPOSTO do node (cancelamento
    // do turno + timeout de 5 s). Ele desce até o `callLLM` de CADA candidato
    // dentro de `selectProcedure`, que é um laço: sem isto, perder a lease no
    // meio do laço ainda pagava todas as chamadas restantes.
    run: async (ctx, signal) => {
      const r: SelectorDecision = await selectProcedure({
        conversa_id: ctx.conversa_id,
        current_message: ctx.inbound_text,
        current_execution: ctx.current_execution,
        signal,
      });
      return r;
    },
  });

  // Node: role-selector. `multi_channel_on` decide se o node é montado; o
  // `runWhen` abaixo então só dispara quando há `role_inputs` (channel + policy
  // resolvidos). Os callers em produção passam sempre `true` (MULTI_CHANNEL
  // removido / sempre on após #411); o parâmetro permanece para construção do
  // grafo e cobertura de testes.
  if (args.multi_channel_on) {
    nodes.push({
      name: 'role-selector',
      layer: CognitiveLayer.SYNC_CONDITIONAL,
      modelTier: 'fast',
      timeoutMs: 3000,
      version: 'v1',
      parallelizable: true,
      runWhen: (ctx) => ctx.role_inputs !== undefined,
      fallback: null,
      run: async (ctx, signal) => {
        if (!ctx.role_inputs) return null;
        return await selectRole({
          inbound_text: ctx.inbound_text,
          current_role: ctx.role_inputs.current_role,
          available_roles: ctx.role_inputs.available_roles,
          policy: ctx.role_inputs.policy,
          conversa_id: ctx.conversa_id,
          channel_id: ctx.role_inputs.channel_id,
          turno_id: ctx.turno_id,
          // Issue #507 (achado 2) — desce ao `callLLM` do llm-suggester E ao
          // guard que impede a gravação em `role_selector_decisions` depois de
          // a posse cair.
          signal,
        });
      },
    });
  }

  return nodes;
}
