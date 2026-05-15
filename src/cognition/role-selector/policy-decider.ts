/**
 * P6 Task 7 — Policy Decider (DETERMINÍSTICO, sem LLM).
 *
 * Recebe a sugestão de um suggester (LLM ou determinístico) e aplica a policy
 * do canal para decidir a ação final. Critério #2 da spec P6: `decided_by`
 * JAMAIS é `llm_classifier`. Esta função é a ENFORCEMENT do invariante.
 *
 * Comportamentos suportados (enum SwitchBehavior):
 *  - LOCKED:           role fixa → sempre keep_current (policy_rule).
 *  - PREFER_HANDOFF:   sinaliza handoff em vez de trocar role (policy_rule).
 *  - FREE_WITH_TRIGGER: troca apenas com sinal strong/medium (policy_rule);
 *                      weak → keep_current (policy_default).
 *  - BY_CONTEXT:       troca automática com travas (min_confidence + osc).
 *                      Confidence < min → keep_current (policy_rule).
 *                      Osc count >= max → fallback (fallback_rule).
 *                      Caso contrário → switch (policy_rule).
 *
 * IMPORTANTE:
 *  - Sem candidate (suggester devolveu null) → keep_current (policy_default).
 *  - Candidate igual ao role atual → keep_current (policy_default).
 *  - Candidate role_id fora de available_roles → fallback (fallback_rule).
 *  - switch_behavior desconhecido → fallback (fallback_rule) defensivo.
 *
 * Critério #4 da spec: o anti-osc é aplicado apenas em BY_CONTEXT
 * (free_with_trigger não precisa pois exige trigger por turno).
 *
 * SEM IMPORTS DE LLM SDK. Acceptance gate #4 da spec roda grep nesta linha.
 */
import { DecidedBy, RoleDecisionAction, SwitchBehavior } from '@/types/enums.js';
import { logger } from '@/lib/logger.js';
import {
  shouldBlockSwitchByOscillation,
  isWithinCooldownWindow,
} from './oscillation-tracker.js';
import type { RoleSelectorInput, RoleCandidate } from './types.js';
import type { Role } from '@/db/schema.js';

type ByContextGuards = {
  min_confidence_to_switch?: number;
  cooldown_turns?: number;
  required_strength_delta?: number;
  max_switches_per_conversation?: number;
};

/**
 * [P88-M2] Validate `by_context_guards` JSONB shape on read.
 *
 * The migration default (`033`) supplies a well-formed object, but the column
 * is JSONB — any operator can write garbage via SQL/admin tooling. A raw
 * `as` cast would silently substitute defaults for malformed payloads. Instead,
 * we shape-check each key and warn loudly when a value is the wrong type or
 * the whole payload is unusable. Unknown extra keys are ignored (forward-compat
 * with future guard fields).
 */
function parseByContextGuards(raw: unknown, policy_id: string): ByContextGuards {
  if (raw === null || typeof raw !== 'object') {
    logger.warn(
      { policy_id, raw_type: raw === null ? 'null' : typeof raw },
      'policy_decider.by_context_guards_malformed_using_defaults',
    );
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const out: ByContextGuards = {};
  const numKeys = [
    'min_confidence_to_switch',
    'cooldown_turns',
    'required_strength_delta',
    'max_switches_per_conversation',
  ] as const;
  for (const k of numKeys) {
    const v = obj[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      logger.warn(
        { policy_id, key: k, value: v },
        'policy_decider.by_context_guards_field_invalid_using_default',
      );
      continue;
    }
    out[k] = v;
  }
  return out;
}

export type PolicyDecisionResult = {
  decided_role: Role;
  action: RoleDecisionAction;
  decided_by: DecidedBy;
  reason: string;
};

function findRoleById(roles: Role[], id: string): Role | null {
  return roles.find((r) => r.id === id) ?? null;
}

export async function decidePolicy(args: {
  input: RoleSelectorInput;
  candidate: RoleCandidate | null;
}): Promise<PolicyDecisionResult> {
  const { input, candidate } = args;
  const policy = input.policy;
  const switch_behavior = policy.switch_behavior as SwitchBehavior;

  // 1. LOCKED — always keep current
  if (switch_behavior === SwitchBehavior.LOCKED) {
    return {
      decided_role: input.current_role,
      action: RoleDecisionAction.KEEP_CURRENT,
      decided_by: DecidedBy.POLICY_RULE,
      reason: 'policy locked',
    };
  }

  // No candidate or candidate equals current → keep current
  if (!candidate || candidate.role_id === input.current_role.id) {
    return {
      decided_role: input.current_role,
      action: RoleDecisionAction.KEEP_CURRENT,
      decided_by: DecidedBy.POLICY_DEFAULT,
      reason: candidate ? 'candidate equals current' : 'no candidate',
    };
  }

  // 2. PREFER_HANDOFF — sinaliza handoff em vez de switch
  if (switch_behavior === SwitchBehavior.PREFER_HANDOFF) {
    return {
      decided_role: input.current_role,
      action: RoleDecisionAction.HANDOFF,
      decided_by: DecidedBy.POLICY_RULE,
      reason: `prefer_handoff to ${candidate.role_key}`,
    };
  }

  // 3. FREE_WITH_TRIGGER — only switch on strong/medium signal
  if (switch_behavior === SwitchBehavior.FREE_WITH_TRIGGER) {
    if (candidate.strength === 'strong' || candidate.strength === 'medium') {
      const target = findRoleById(input.available_roles, candidate.role_id);
      return {
        decided_role: target ?? input.current_role,
        action: target ? RoleDecisionAction.SWITCH : RoleDecisionAction.FALLBACK,
        decided_by: target ? DecidedBy.POLICY_RULE : DecidedBy.FALLBACK_RULE,
        reason: target
          ? `free_with_trigger fired (strength=${candidate.strength})`
          : 'candidate role not in available_roles',
      };
    }
    return {
      decided_role: input.current_role,
      action: RoleDecisionAction.KEEP_CURRENT,
      decided_by: DecidedBy.POLICY_DEFAULT,
      reason: 'weak signal, no trigger',
    };
  }

  // [P88-H1] Candidate must be in the policy's allowed set (the caller
  // already filtered available_roles by allowed_role_ids; this is the
  // second-layer enforcement so a stale candidate from an out-of-band
  // suggester still gets rejected). If not, fall back rather than switch.
  const targetInAvailable = findRoleById(input.available_roles, candidate.role_id);
  if (!targetInAvailable) {
    return {
      decided_role: input.current_role,
      action: RoleDecisionAction.FALLBACK,
      decided_by: DecidedBy.FALLBACK_RULE,
      reason: 'candidate role not in available_roles (allowed_role_ids violation)',
    };
  }

  // 4. BY_CONTEXT — apply guards
  if (switch_behavior === SwitchBehavior.BY_CONTEXT) {
    // [P88-M2] Validate shape rather than blind `as` cast — warns loudly when
    // the JSONB is malformed instead of silently using defaults.
    const guards = parseByContextGuards(policy.by_context_guards, policy.id);
    const minConf = guards.min_confidence_to_switch ?? 0.7;
    const maxSwitches = guards.max_switches_per_conversation ?? 3;
    // [P88-H4] Read cooldown_turns + required_strength_delta from the JSONB
    // guard payload. Previously declared in the migration default JSON but
    // never consumed — operators configuring them expected enforcement.
    const cooldownTurns = guards.cooldown_turns ?? 0;
    const requiredStrengthDelta = guards.required_strength_delta ?? 0;

    // Base threshold: min_confidence_to_switch + required_strength_delta.
    // The delta forces the candidate to clear the minimum by an extra
    // margin, dampening switches on borderline signals.
    const effectiveMinConf = minConf + Math.max(0, requiredStrengthDelta);
    if (candidate.confidence < effectiveMinConf) {
      return {
        decided_role: input.current_role,
        action: RoleDecisionAction.KEEP_CURRENT,
        decided_by: DecidedBy.POLICY_RULE,
        reason:
          requiredStrengthDelta > 0
            ? `confidence ${candidate.confidence.toFixed(2)} < min ${minConf} + delta ${requiredStrengthDelta}`
            : `confidence ${candidate.confidence.toFixed(2)} < min ${minConf}`,
      };
    }

    // [P88-H4] Cooldown guard: at least `cooldown_turns` turns must pass
    // between switches in this conversation. Blocks if there was already
    // a switch in the last N turns. cooldown=0 disables (default).
    if (input.conversa_id && cooldownTurns > 0) {
      const inCooldown = await isWithinCooldownWindow({
        conversa_id: input.conversa_id,
        cooldown_turns: cooldownTurns,
      });
      if (inCooldown.blocked) {
        return {
          decided_role: input.current_role,
          action: RoleDecisionAction.KEEP_CURRENT,
          decided_by: DecidedBy.POLICY_RULE,
          reason: `cooldown active (switch in last ${cooldownTurns} turns)`,
        };
      }
    }

    // Oscillation guard
    if (input.conversa_id) {
      const osc = await shouldBlockSwitchByOscillation({
        conversa_id: input.conversa_id,
        max_switches: maxSwitches,
      });
      if (osc.blocked) {
        return {
          decided_role: input.current_role,
          action: RoleDecisionAction.FALLBACK,
          decided_by: DecidedBy.FALLBACK_RULE,
          reason: `max_switches_per_conversation reached (${osc.current_switches}/${maxSwitches})`,
        };
      }
    }

    return {
      decided_role: targetInAvailable,
      action: RoleDecisionAction.SWITCH,
      decided_by: DecidedBy.POLICY_RULE,
      reason: `by_context approved (conf=${candidate.confidence.toFixed(2)} >= ${effectiveMinConf.toFixed(2)})`,
    };
  }

  // Unknown switch_behavior — defensive fallback
  return {
    decided_role: input.current_role,
    action: RoleDecisionAction.FALLBACK,
    decided_by: DecidedBy.FALLBACK_RULE,
    reason: `unknown switch_behavior: ${switch_behavior}`,
  };
}
