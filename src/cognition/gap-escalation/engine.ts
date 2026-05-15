/**
 * P5 Task 6 — Gap escalation engine (DETERMINÍSTICO, sem LLM).
 *
 * Implementa a cadeia: silent -> dashboard -> mentionable -> proposed.
 * Cada transição depende EXCLUSIVAMENTE de thresholds numéricos da regra
 * (frequency_score, severity_score, distinct_contexts_count, cooldown). O
 * proposer só dispara DEPOIS que esse engine eleva ao nível PROPOSED; antes
 * disso a Maia não pode propor spec formal.
 *
 * Invariante grepável (acceptance gate #4 da Task 12): este arquivo NÃO pode
 * importar nenhum SDK de modelo de linguagem. Pure TypeScript: zero async,
 * zero I/O, zero rede.
 *
 * Mapeamento de transições (todos comparados com `>=`, salvo cooldown que é `<`):
 *  - SILENT      -> DASHBOARD     se freq >= dashboard_freq_threshold
 *  - DASHBOARD   -> MENTIONABLE   se sev  >= mentionable_severity_threshold
 *  - MENTIONABLE -> PROPOSED      se TODOS:
 *      (freq + sev) >= proposed_combined_threshold
 *      distinct_contexts_count >= proposed_min_distinct_contexts
 *      (days_since_last_proposed_in_tenant é null  OU
 *       days_since_last_proposed_in_tenant >= cooldown_days_proposed_to_proposed)
 *  - PROPOSED    -> PROPOSED      terminal para este engine; quem cuida do
 *                                  ciclo posterior (delivered/rejeitado) é o
 *                                  fluxo de propostas (capability_proposals).
 *
 * `reason` é sempre uma string curta auditável (registrável em logs).
 */
import { GapLevel } from '@/types/enums.js';
import type { EscalationInput, EscalationDecision } from './types.js';

export function decideEscalation(input: EscalationInput): EscalationDecision {
  const current = input.gap.current_level as GapLevel;
  const rules = input.rules;
  const freq = input.gap.frequency_score;
  const sev = input.gap.severity_score;

  if (current === GapLevel.SILENT) {
    if (freq >= rules.dashboard_freq_threshold) {
      return {
        current_level: current,
        new_level: GapLevel.DASHBOARD,
        changed: true,
        reason: `freq ${freq} >= ${rules.dashboard_freq_threshold}`,
      };
    }
    return {
      current_level: current,
      new_level: current,
      changed: false,
      reason: `freq ${freq} < ${rules.dashboard_freq_threshold}`,
    };
  }

  if (current === GapLevel.DASHBOARD) {
    if (sev >= rules.mentionable_severity_threshold) {
      return {
        current_level: current,
        new_level: GapLevel.MENTIONABLE,
        changed: true,
        reason: `severity ${sev} >= ${rules.mentionable_severity_threshold}`,
      };
    }
    return {
      current_level: current,
      new_level: current,
      changed: false,
      reason: `severity ${sev} < ${rules.mentionable_severity_threshold}`,
    };
  }

  if (current === GapLevel.MENTIONABLE) {
    const combined = freq + sev;
    if (combined < rules.proposed_combined_threshold) {
      return {
        current_level: current,
        new_level: current,
        changed: false,
        reason: `combined ${combined} < ${rules.proposed_combined_threshold}`,
      };
    }
    if (input.distinct_contexts_count < rules.proposed_min_distinct_contexts) {
      return {
        current_level: current,
        new_level: current,
        changed: false,
        reason: `distinct_contexts ${input.distinct_contexts_count} < ${rules.proposed_min_distinct_contexts}`,
      };
    }
    if (
      input.days_since_last_proposed_in_tenant !== null &&
      input.days_since_last_proposed_in_tenant < rules.cooldown_days_proposed_to_proposed
    ) {
      return {
        current_level: current,
        new_level: current,
        changed: false,
        reason: `cooldown ${input.days_since_last_proposed_in_tenant}d < ${rules.cooldown_days_proposed_to_proposed}d`,
      };
    }
    return {
      current_level: current,
      new_level: GapLevel.PROPOSED,
      changed: true,
      reason: `all conditions met (combined=${combined}, contexts=${input.distinct_contexts_count})`,
    };
  }

  // proposed = terminal para este engine (proposer dispara, owner decide)
  return {
    current_level: current,
    new_level: current,
    changed: false,
    reason: 'already_at_proposed_terminal_for_this_engine',
  };
}
