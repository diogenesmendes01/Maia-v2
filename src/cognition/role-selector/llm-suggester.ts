/**
 * P6 Task 6 — LLM Suggester (Haiku 4.5).
 *
 * Sugere o role mais apropriado dado o role atual e o texto do usuário, dentro
 * dos `available_roles` da policy. Critério #1 da spec: LLM apenas SUGERE
 * (`suggested_by = LLM_CLASSIFIER`). A decisão fica com a policy (Task 7),
 * cujo `decided_by` NUNCA é 'llm_classifier' (CHECK no DB).
 *
 * Wrapper:
 *  - runCognitiveModule timeout=3s (sync_conditional), fallback=null, audit on.
 *  - Anthropic throw / timeout / JSON malformado → null silencioso (sem spam
 *    em cognitive_module_log; runner já registra status='error').
 *  - role_key fora de available_roles → null (proteção contra alucinação).
 *
 * Strength derivado de confidence (single source of truth):
 *  - >= 0.8 STRONG
 *  - >= 0.5 MEDIUM
 *  - <  0.5 WEAK
 */
import { callLLM } from '@/lib/claude.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import { SuggestedBy, RoleSelectorStrength } from '@/types/enums.js';
import type { RoleSuggester, RoleCandidate, RoleSelectorInput } from './types.js';

function strengthFromConfidence(c: number): RoleSelectorStrength {
  if (c >= 0.8) return RoleSelectorStrength.STRONG;
  if (c >= 0.5) return RoleSelectorStrength.MEDIUM;
  return RoleSelectorStrength.WEAK;
}

export const llmSuggester: RoleSuggester = {
  async suggest(input: RoleSelectorInput): Promise<RoleCandidate | null> {
    const result = await runCognitiveModule<RoleCandidate | null>(
      {
        name: 'role_selector_llm',
        timeoutMs: 3000,
        triggered_by: 'sync_conditional',
        fallback: null,
      },
      async () => {
        const rolesBlock = input.available_roles
          .map(
            (r) =>
              `- ${r.role_key}: ${r.display_name}${r.description ? ' (' + r.description + ')' : ''}`,
          )
          .join('\n');
        const system = [
          'Você é um classificador de papel operacional. Dado o role atual e a mensagem do usuário,',
          'sugira qual papel é mais apropriado entre os disponíveis. Devolva JSON {role_key, confidence (0-1), reason}.',
        ].join('\n');
        const user = [
          `ROLE ATUAL: ${input.current_role.role_key} (${input.current_role.display_name})`,
          `ROLES DISPONÍVEIS:\n${rolesBlock}`,
          `MENSAGEM:\n${input.inbound_text}`,
          'Devolva JSON estrito.',
        ].join('\n\n');
        // Issue #508: modelo resolvido pelo backend (tier `fast` do workload
        // `role_selector`), não mais fixado no call site.
        const completion = await callLLM({
          workload: 'role_selector',
          max_tokens: 200,
          system,
          messages: [{ role: 'user', content: user }],
        });
        const text = completion.content ?? '';
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return null;
        let parsed: { role_key?: string; confidence?: number; reason?: string };
        try {
          parsed = JSON.parse(match[0]) as {
            role_key?: string;
            confidence?: number;
            reason?: string;
          };
        } catch {
          // malformed JSON → clean null (don't spam cognitive_module_log with errors)
          return null;
        }
        const role = input.available_roles.find((r) => r.role_key === parsed.role_key);
        if (!role || typeof parsed.confidence !== 'number') return null;
        const confidence = Math.max(0, Math.min(1, parsed.confidence));
        return {
          role_id: role.id,
          role_key: role.role_key,
          confidence,
          strength: strengthFromConfidence(confidence),
          suggested_by: SuggestedBy.LLM_CLASSIFIER,
          reason: parsed.reason ?? '',
        };
      },
    );
    return result.output;
  },
};
