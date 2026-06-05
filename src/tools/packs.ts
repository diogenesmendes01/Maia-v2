/**
 * Issue #410 — Tool Packs: the formal contract for "what capabilities a runtime
 * agent has by default", versioned and conservative.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * Maia had global tools and skills with `allowed_tools`, but NO formal
 * definition of the minimal capability floor every agent should have, nor of
 * what must NEVER be a universal default. Without it, each agent was born with
 * inconsistent tools — some unable to operate safely, some over-privileged.
 *
 * `baseline.core` is that contract: the smallest set of tools every runtime
 * agent gets so it can understand context, respond, ask for confirmation,
 * remember/audit, and escalate — but NOT execute sensitive/domain actions
 * without an explicit grant.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BOUNDARY WITH #408 (read before extending)
 * This file defines DEFINITIONS only. The runtime ENFORCEMENT is #408's scope:
 *   - the `agent_tool_grants` TABLE (seeded with `DEFAULT_AGENT_PACKS`),
 *   - the runtime tool filter (intersection of granted packs ∩ registry),
 *   - the dispatcher `tool_not_granted` guard.
 * #408 will EXTEND this file with `domain.*` packs (e.g. `domain.finance`),
 * reusing the `ToolPack` type and the `assertConservative`-style discipline.
 * Do NOT redefine `ToolPack` or `DEFAULT_AGENT_PACKS` there — import them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * INVARIANTS
 *   #5 (fail-closed): domain tools are NEVER in `baseline.core` — an agent
 *      without a domain grant cannot even see them (#408 enforces the filter).
 *   #6 (identity governed): the SKILLS half of baseline is seeded as
 *      `proposed_by='system'`, tenant-wide, `active` via an idempotent seed
 *      migration (migrations/075_*) — governed/auditable, NOT a self-approval.
 */
import { REGISTRY, type AnyTool } from './_registry.js';

/**
 * A named, versioned bundle of tool NAMES an agent may be granted. The pack
 * references tools by their registry key (`Tool.name`); it does NOT embed the
 * tool definitions, so a pack stays a thin, serialisable contract.
 *
 * #408 extends the universe of pack ids with `domain.*` packs. The id is a
 * dotted string (`<scope>.<name>`) rather than a closed enum on purpose — a
 * new domain pack is additive and must not require editing a central union.
 */
export interface ToolPack {
  /** Stable pack id, e.g. `baseline.core`, `domain.finance`. */
  id: string;
  /** Monotonic version of the pack's contents (bump when `tools` changes). */
  version: number;
  /** Human-readable purpose of the pack. */
  description: string;
  /**
   * The tool registry names this pack grants. MUST exist in `REGISTRY`
   * (asserted at module load by `assertPackToolsExist`).
   */
  tools: readonly string[];
}

/**
 * `baseline.core` — the conservative capability floor for EVERY runtime agent.
 *
 * Contents (issue #410 §"Tools básicas"):
 *   - read_turn_context   (none)          — understand the current turn
 *   - recall_memory       (read, reused)  — read authorised memory in scope
 *   - remember_safe_fact  (write)         — persist a SAFE per-pessoa fact only
 *   - request_confirmation(none)          — ask before acting (never acts)
 *   - handoff_to_owner    (communication) — INTERNAL escalation to the owner
 *   - audit_decision      (none)          — record a decision rationale
 *   - explain_limitation  (none)          — honest "I can't do that (yet)"
 *
 * Everything here is conservative: at most ONE granular `write` (scoped to the
 * caller's own pessoa) and ONE INTERNAL `communication` (escalation, not an
 * external send). NO financial/CRM/cadastro/proactive-external tool is present
 * — that is the "fora do baseline" contract, enforced by `assertConservative`.
 */
export const BASELINE_CORE_PACK: ToolPack = {
  id: 'baseline.core',
  version: 1,
  description:
    'Capacidades mínimas de todo agente runtime: entender contexto, responder, pedir confirmação, registrar memória/auditoria e escalar — sem executar ações sensíveis de domínio.',
  tools: [
    'read_turn_context',
    'recall_memory',
    'remember_safe_fact',
    'request_confirmation',
    'handoff_to_owner',
    'audit_decision',
    'explain_limitation',
  ],
} as const;

/**
 * The default packs granted to every newly-created runtime agent.
 *
 * #408 seeds the `agent_tool_grants` table with this on agent creation and
 * wires the dispatcher enforcement. The agent-creation helper
 * (`agentsRepo.createWithSeedAndAudit`) references this as the INTENDED default;
 * the actual grant persistence/enforcement is #408.
 *
 * Domain packs are NEVER added here — they are granted explicitly per agent.
 */
export const DEFAULT_AGENT_PACKS: readonly string[] = ['baseline.core'] as const;

/**
 * Tool names that are FORBIDDEN from `baseline.core` — the "fora do baseline"
 * contract (issue #410 §"Fora do baseline"). Listed explicitly so the guard is
 * readable and so adding one of these to the pack fails loudly at module load.
 * (The broader rule — no `write`/`communication` without specific policy — is
 * also enforced structurally by `assertConservative` below.)
 */
const FORBIDDEN_IN_BASELINE: ReadonlySet<string> = new Set([
  // finanças / transação / pagamento
  'register_transaction',
  'cancel_transaction',
  'query_balance',
  'list_transactions',
  'classify_transaction',
  'compare_entities',
  'generate_report',
  'start_recurring_payment',
  // CRM com mutação / alteração de cadastro
  'identify_entity',
  // envio proativo externo
  'send_proactive_message',
  'start_recurring_outreach',
  // workflows com efeito real
  'start_workflow',
  // agenda com efeito real
  'schedule_reminder',
  'cancel_reminder',
  'register_custom_holiday',
]);

/**
 * Side effects a baseline tool may declare. The baseline floor permits:
 *   - 'none' / 'read'      — always safe.
 *   - 'write'              — ONLY the granular, self-scoped `remember_safe_fact`.
 *   - 'communication'      — ONLY the INTERNAL `handoff_to_owner` escalation.
 * Any OTHER write/communication tool is a domain capability and must be granted
 * via a domain pack (#408), never the baseline.
 */
const BASELINE_WRITE_ALLOWLIST: ReadonlySet<string> = new Set(['remember_safe_fact']);
const BASELINE_COMMUNICATION_ALLOWLIST: ReadonlySet<string> = new Set(['handoff_to_owner']);

/**
 * Fail loud at module load if any pack references a tool that isn't in the
 * registry — a pack that grants a non-existent tool is a silent capability gap.
 */
function assertPackToolsExist(pack: ToolPack): void {
  for (const name of pack.tools) {
    if (!(name in REGISTRY)) {
      throw new Error(
        `tool_pack_unknown_tool: pack '${pack.id}' references tool '${name}' not present in REGISTRY`,
      );
    }
  }
}

/**
 * Fail loud at module load if `baseline.core` ever contains a domain/sensitive
 * tool. This is the executable form of the "fora do baseline" contract: the
 * baseline may NOT include finanças/cobrança/transferência/pagamento/cadastro/
 * CRM-mutação/envio-proativo/workflows-com-efeito-real, nor ANY `write`/
 * `communication` tool outside the two explicitly-allowlisted baseline writes.
 */
function assertConservative(pack: ToolPack): void {
  for (const name of pack.tools) {
    if (FORBIDDEN_IN_BASELINE.has(name)) {
      throw new Error(
        `baseline_contains_forbidden_tool: '${name}' is a domain/sensitive tool and must not be in baseline.core`,
      );
    }
    const tool = REGISTRY[name] as AnyTool | undefined;
    if (!tool) continue; // existence already asserted by assertPackToolsExist.
    if (tool.side_effect === 'write' && !BASELINE_WRITE_ALLOWLIST.has(name)) {
      throw new Error(
        `baseline_unexpected_write_tool: '${name}' has side_effect=write but is not an allowlisted baseline write`,
      );
    }
    if (
      tool.side_effect === 'communication' &&
      !BASELINE_COMMUNICATION_ALLOWLIST.has(name)
    ) {
      throw new Error(
        `baseline_unexpected_communication_tool: '${name}' has side_effect=communication but is not an allowlisted baseline escalation`,
      );
    }
  }
}

// Module-load self-checks: the baseline contract is verified on import, so a
// drift (adding a forbidden/sensitive tool, or a typo'd tool name) fails the
// process — and the test suite — immediately, not at runtime in production.
assertPackToolsExist(BASELINE_CORE_PACK);
assertConservative(BASELINE_CORE_PACK);

/**
 * All packs defined in #410. #408 will add `domain.*` packs to this registry.
 * Keyed by pack id for O(1) lookup by the (future) grant filter.
 */
export const TOOL_PACKS: Readonly<Record<string, ToolPack>> = {
  [BASELINE_CORE_PACK.id]: BASELINE_CORE_PACK,
} as const;

/**
 * Resolve a set of pack ids to the union of tool names they grant. Unknown pack
 * ids are skipped (fail-closed: an unknown pack grants nothing rather than
 * throwing in the hot path). #408's runtime filter intersects this with the
 * per-agent registry view.
 */
export function resolvePackTools(packIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of packIds) {
    const pack = TOOL_PACKS[id];
    if (!pack) continue;
    for (const name of pack.tools) out.add(name);
  }
  return [...out];
}
