/**
 * Issue #408 — the Runtime Tool Filter.
 *
 * Formalizes the chain:
 *   Tool Catalog → Tool Pack → Agent Tool Grants → Skill Tool Scope
 *                → Runtime Tool Filter → Dispatcher Guard
 *
 * This module computes the LLM-VISIBLE tool set by composing, as ADDITIVE
 * filters applied BEFORE the existing dispatcher guards (never replacing them):
 *
 *   VISÍVEL = ( baseline.core ∪ granted_packs ∪ granted_tools − denied_tools )  ← the AGENT  (agent_tool_grants)
 *           ∩ ( skill.allowed_tools − skill.denied_tools )                      ← the SKILL  (SkillToolScope)
 *           ∩ ( required_actions ⊆ permissões da pessoa )                       ← the HUMAN  (getAgentToolSchemas)
 *           ∩ ( isToolEnabled / feature flag )                                  ← kill-switch (getAgentToolSchemas)
 *           ∩ ( skill permitida p/ audiência/canal/data_scope/risco )          ← #409 (NOT here — hook documented below)
 *
 * The result is the tool SCHEMA list the LLM may call, plus a provenance audit
 * (`tool_visibility_resolved`) recording WHICH packs / granted tools / denied
 * tools / skill scope produced it (criterion #408: "auditoria registra quais
 * grants/packs/skills produziram o conjunto visível").
 *
 * #409 HOOK: the audience/data_scope/risk layer narrows `scope` (the
 * SkillToolScope) and/or post-filters `result.tools` AFTER this function. The
 * pack `risk_level` (see `src/tools/packs.ts`) and the resolved AudienceContext
 * are the inputs that layer will consume. This function deliberately stops at
 * the agent ∩ skill ∩ human ∩ flag intersection.
 */
import type { ResolvedPermission } from '@/governance/permissions.js';
import { BASE_AGENT_PACKS } from './base-agent-packs.js';
import { getAgentToolSchemas } from './_registry.js';
import {
  computeAgentVisibleTools,
  type AgentToolGrant,
  type RoleToolScope,
  type SkillToolScope,
} from './grant-math.js';
import { agentToolGrantsRepo, rolesRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import {
  evaluateUsagePolicy,
  resolveEffectiveUsagePolicy,
  type UsagePolicyEvalContext,
} from '@/skills/usage-policy.js';

export interface RuntimeToolFilterInput {
  /** Per-entity resolved permissions (the HUMAN axis), as in `getToolSchemas`. */
  byEntity: Map<string, ResolvedPermission>;
  /** Optional skill scope (the SKILL axis) when a skill is selected this turn. */
  skillScope?: SkillToolScope | null;
  /**
   * Issue #409 — the #408-documented hook. When a `skillScope` is supplied for a
   * selected skill AND this audience is supplied, the filter re-checks the
   * skill's `usage_policy` against the audience. If the skill is NOT admitted,
   * its scope is DROPPED — the blocked skill contributes NO tool narrowing and,
   * more importantly, the dropped scope means the LLM never sees tools that were
   * only there because of a skill it may not use. (In the engine path a blocked
   * skill is never selected, so its scope never reaches here; this is the
   * defense-in-depth re-check at the visibility boundary.)
   */
  audience?: UsagePolicyEvalContext | null;
  /**
   * The selected skill's raw `usage_policy` JSONB (paired with `audience`). When
   * absent the conservative default is evaluated (so a policy-less skill scope
   * is only applied for internal/trusted audiences).
   */
  skillUsagePolicy?: Record<string, unknown> | null;
  /**
   * Issue #437 — the turn's ACTIVE operational role key (resolved by the
   * role-selector chain and carried on the BaseContextPacket as
   * `active_role_key`). When supplied, the role's `granted_packs`
   * (`roles.granted_packs`) narrow the visible set to its packs ∪ baseline — the
   * "active-role packs" factor of the capability-taxonomy §2 step 7 intersection
   * (`agent grant ∩ active-role packs ∩ skill scope`). Absent ⇒ no role
   * narrowing (legacy / role-agnostic turn).
   */
  activeRoleKey?: string;
  /** Audit correlation — emitted on the `tool_visibility_resolved` row. */
  audit_context?: {
    pessoa_id?: string;
    conversa_id?: string;
    mensagem_id?: string;
  };
}

export interface RuntimeToolFilterResult {
  /** Tool schemas the LLM may call ({ name, description, input_schema }). */
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  /** Tools the SKILL marks requires-confirmation (∩ visible). */
  requires_confirmation: string[];
  /** The effective agent grant used (resolved from `agent_tool_grants`). */
  grant: AgentToolGrant;
}

/**
 * Resolve the effective AGENT grant from the current (tenant, agent) ALS
 * context. Fail-closed: a missing row degrades to the in-code baseline floor
 * (`resolveGrantedToolNames` always unions `baseline.core`), never to "all
 * tools" and never to a thrown error in the hot path.
 */
export async function resolveEffectiveGrant(): Promise<AgentToolGrant> {
  // try/catch (not just `.catch`) so a SYNCHRONOUS throw (missing ALS context,
  // mis-wired repo) also degrades to the baseline floor rather than crashing
  // the turn. Always observable via the warn log.
  let row: { granted_packs: string[]; granted_tools: string[]; denied_tools: string[] } | null =
    null;
  try {
    row = await agentToolGrantsRepo.findForCurrentAgent();
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'tools.runtime_filter.grant_lookup_failed_fallback_baseline',
    );
  }
  return {
    granted_packs: row?.granted_packs ?? [...BASE_AGENT_PACKS],
    granted_tools: row?.granted_tools ?? [],
    denied_tools: row?.denied_tools ?? [],
  };
}

/**
 * Issue #437 — resolve the ACTIVE role's tool-pack scope (`roles.granted_packs`).
 * Reads the role for (tenant, agent, role_key) via `rolesRepo.getByKey` (scoped
 * to the ALS tenant+agent — NEVER cross-tenant). Fail-SAFE: an empty key, a
 * missing role, or a lookup error yields `null` (NO role restriction) rather than
 * blocking the turn. This is fail-CLOSED in the sense that matters — the role
 * axis can only NARROW, never authorize, so failing to narrow never grants
 * anything new; the agent grant + dispatcher `tool_not_granted` guard remain the
 * hard server-side floor. Logged for observability.
 */
export async function resolveActiveRoleScope(
  activeRoleKey?: string,
): Promise<RoleToolScope | null> {
  if (!activeRoleKey) return null;
  try {
    const role = await rolesRepo.getByKey(activeRoleKey);
    if (!role) return null;
    return { role_key: role.role_key, granted_packs: role.granted_packs ?? [] };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, active_role_key: activeRoleKey },
      'tools.runtime_filter.role_lookup_failed_no_role_restriction',
    );
    return null;
  }
}

/**
 * Compute the LLM-visible tool schemas for the current turn and audit the
 * provenance. See the module header for the full intersection.
 */
export async function computeRuntimeVisibleTools(
  input: RuntimeToolFilterInput,
): Promise<RuntimeToolFilterResult> {
  const grant = await resolveEffectiveGrant();
  // Issue #437 — the ACTIVE-role pack axis. Loaded once per turn; fail-safe to
  // null (no role narrowing) so the role axis can only ever REMOVE tools.
  const roleScope = await resolveActiveRoleScope(input.activeRoleKey);

  // Issue #409 hook: when a skill scope is present AND an audience is supplied,
  // re-check the skill's usage_policy. A skill NOT admitted for this audience
  // contributes NO scope (dropped) — its tools never reach the LLM via a skill
  // the audience may not use. Fail-closed: a malformed policy drops the scope.
  let effectiveSkillScope = input.skillScope ?? null;
  let skillBlockedReason: string | null = null;
  if (effectiveSkillScope && input.audience) {
    const resolved = resolveEffectiveUsagePolicy(input.skillUsagePolicy ?? null);
    if (!resolved.ok) {
      skillBlockedReason = `malformed_usage_policy: ${resolved.error}`;
      effectiveSkillScope = null;
    } else {
      const decision = evaluateUsagePolicy(resolved.policy, input.audience);
      if (!decision.allowed) {
        skillBlockedReason = `${decision.reason}: ${decision.detail}`;
        effectiveSkillScope = null;
      }
    }
  }

  const composed = computeAgentVisibleTools(grant, effectiveSkillScope, roleScope);

  // Apply the HUMAN-permission + feature-flag filters over the agent ∩ skill
  // visible set (the registry projection).
  const tools = getAgentToolSchemas(composed.visible, input.byEntity);
  const finalNames = new Set(tools.map((t) => t.name));
  const requires_confirmation = composed.requires_confirmation.filter((n) =>
    finalNames.has(n),
  );

  // Provenance audit (invariant #4 + criterion #408). Best-effort: a failed
  // audit never blocks the turn, but it is logged. try/catch (not `.catch`) so
  // it is robust to both a rejection and a synchronous throw.
  try {
    await audit({
      acao: 'tool_visibility_resolved',
      pessoa_id: input.audit_context?.pessoa_id ?? null,
      conversa_id: input.audit_context?.conversa_id ?? null,
      mensagem_id: input.audit_context?.mensagem_id ?? null,
      metadata: {
        visible_count: tools.length,
        visible_tools: [...finalNames],
        ...composed.provenance,
        requires_confirmation,
        // Issue #409 — record when a skill scope was DROPPED because the skill's
        // usage_policy did not admit the audience (defense-in-depth at the
        // visibility boundary). null when no skill scope was dropped.
        skill_scope_dropped_reason: skillBlockedReason,
      },
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'tools.runtime_filter.visibility_audit_failed',
    );
  }

  return { tools, requires_confirmation, grant };
}
