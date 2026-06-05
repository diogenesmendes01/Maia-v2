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
import { getAgentToolSchemas } from './_registry.js';
import {
  computeAgentVisibleTools,
  type AgentToolGrant,
  type SkillToolScope,
} from './grant-math.js';
import { agentToolGrantsRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';

export interface RuntimeToolFilterInput {
  /** Per-entity resolved permissions (the HUMAN axis), as in `getToolSchemas`. */
  byEntity: Map<string, ResolvedPermission>;
  /** Optional skill scope (the SKILL axis) when a skill is selected this turn. */
  skillScope?: SkillToolScope | null;
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
    granted_packs: row?.granted_packs ?? ['baseline.core'],
    granted_tools: row?.granted_tools ?? [],
    denied_tools: row?.denied_tools ?? [],
  };
}

/**
 * Compute the LLM-visible tool schemas for the current turn and audit the
 * provenance. See the module header for the full intersection.
 */
export async function computeRuntimeVisibleTools(
  input: RuntimeToolFilterInput,
): Promise<RuntimeToolFilterResult> {
  const grant = await resolveEffectiveGrant();
  const composed = computeAgentVisibleTools(grant, input.skillScope ?? null);

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
