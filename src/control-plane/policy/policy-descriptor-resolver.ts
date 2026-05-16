/**
 * P9a stub — PolicyDescriptorResolver (PEP/PDP em P8e PR #93).
 *
 * Esta é uma implementação minimalista enquanto P8e não está mergeado.
 * Quando P8e for integrado, substituir o conteúdo deste arquivo pela
 * implementação real (mesma forma de `resolveDescriptors`).
 *
 * Comportamento atual:
 *  - Sempre retorna `{ resolved: [], unresolved: [] }` se não há descriptors
 *  - Para cada descriptor passado, retorna unresolved (sem decidir effect),
 *    com motivo `p8e_resolver_not_yet_merged` — assim o SkillRunner sabe
 *    que descriptors existem mas não pode aplicá-los; default é allow.
 *
 * TODO(P8e merge): substituir por `import { policyDescriptorResolver } from
 * './policy-descriptor-resolver-impl.js'`.
 */
import type { PolicyResolutionResult } from '@/skills/types.js';

export interface ResolveDescriptorsArgs {
  tenant_id: string;
  descriptors: string[];
  scope?: {
    skill_category?: string;
    [key: string]: unknown;
  };
}

export interface PolicyDescriptorResolver {
  resolveDescriptors(args: ResolveDescriptorsArgs): Promise<PolicyResolutionResult>;
}

export const policyDescriptorResolver: PolicyDescriptorResolver = {
  async resolveDescriptors(args): Promise<PolicyResolutionResult> {
    if (!args.descriptors || args.descriptors.length === 0) {
      return { resolved: [], unresolved: [] };
    }
    return {
      resolved: [],
      unresolved: args.descriptors.map((d) => ({
        descriptor: d,
        reason: 'p8e_resolver_not_yet_merged',
      })),
    };
  },
};
