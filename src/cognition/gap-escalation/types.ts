/**
 * P5 Task 6 — Gap escalation engine types.
 *
 * O engine de escalada de lacunas é DETERMINÍSTICO (spec §9 P5 critério #2):
 * "Gap atinge nível PROPOSED só por critério determinístico (freq + sev +
 * contexto), nunca por LLM."
 *
 * Esses tipos descrevem entrada e saída da decisão; o engine vive em
 * `engine.ts` e NÃO importa Anthropic/OpenAI ou qualquer SDK de LLM.
 *
 * `DEFAULT_RULES` espelha os defaults da coluna em `gap_escalation_rules`
 * (schema P5) e é usado quando o tenant não customizou thresholds.
 */
import type { GapLevel } from '@/types/enums.js';
import type { AgentCapabilityGap, GapEscalationRule } from '@/db/schema.js';

export type EscalationInput = {
  gap: AgentCapabilityGap;
  rules: GapEscalationRule;
  distinct_contexts_count: number;
  days_since_last_proposed_in_tenant: number | null;
};

export type EscalationDecision = {
  current_level: GapLevel;
  new_level: GapLevel;
  changed: boolean;
  reason: string;
};

export const DEFAULT_RULES: Pick<
  GapEscalationRule,
  | 'dashboard_freq_threshold'
  | 'mentionable_severity_threshold'
  | 'proposed_combined_threshold'
  | 'proposed_min_distinct_contexts'
  | 'cooldown_days_proposed_to_proposed'
> = {
  dashboard_freq_threshold: 3,
  mentionable_severity_threshold: 5,
  proposed_combined_threshold: 8,
  proposed_min_distinct_contexts: 2,
  cooldown_days_proposed_to_proposed: 14,
};
