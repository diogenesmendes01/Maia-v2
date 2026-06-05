/**
 * Issue #410 + #408 — Tool Packs: the registry-VALIDATED surface.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * Maia had global tools and skills with `allowed_tools`, but NO formal
 * definition of the minimal capability floor every agent should have, nor of
 * what must NEVER be a universal default. `baseline.core` (#410) is that floor;
 * the `domain.*` packs (#408) are the per-vertical capability bundles.
 *
 * The pack DEFINITIONS + the pure grant MATH live in `./grant-math.ts` (which
 * is REGISTRY-FREE so the dispatcher can import the math without triggering
 * registry-validation side effects in unit tests). THIS module re-exports that
 * surface AND adds the load-time drift guards that validate every pack against
 * the live `REGISTRY` / tool catalog:
 *   - `assertPackToolsExist`      — baseline tools must be in `REGISTRY`.
 *   - `assertConservative`        — baseline must stay "fora do baseline"-safe.
 *   - `assertDomainPackToolsKnown`— domain tools must be KNOWN to the platform
 *                                   (tolerating feature-flag-gated tools that
 *                                   are merely disabled right now).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * INVARIANTS
 *   #5 (fail-closed): domain tools are NEVER in `baseline.core` — an agent
 *      without a domain grant cannot even see them (the runtime filter +
 *      dispatcher `tool_not_granted` guard enforce it).
 *   #6 (identity governed): the SKILLS half of baseline is seeded as
 *      `proposed_by='system'`, tenant-wide, `active` via an idempotent seed
 *      migration (migrations/075_*) — governed/auditable, NOT a self-approval.
 */
import { REGISTRY, buildToolCatalog, type AnyTool } from './_registry.js';
import {
  BASELINE_CORE_PACK,
  DOMAIN_PACKS,
  type ToolPack,
} from './grant-math.js';

// Re-export the full definitions + grant-math surface so existing importers
// (`@/tools/packs.js`) keep working unchanged.
export {
  BASELINE_CORE_PACK,
  DEFAULT_AGENT_PACKS,
  DOMAIN_FINANCE_PACK,
  DOMAIN_SALES_PACK,
  DOMAIN_SUPPORT_PACK,
  DOMAIN_CALENDAR_PACK,
  DOMAIN_OPERATIONS_PACK,
  // Issue #416 — boleto proposal vertical packs (grantable to #415's role).
  BOLETO_PROPOSAL_READ_PACK,
  BOLETO_PROPOSAL_WRITE_PACK,
  REFUND_INTAKE_PACK,
  REFUND_FOLLOWUP_PACK,
  DOCUMENT_ANALYSIS_PACK,
  RISK_ESCALATION_PACK,
  BOLETO_PROPOSAL_PACKS,
  DOMAIN_PACKS,
  TOOL_PACKS,
  resolvePackTools,
  resolveGrantedToolNames,
  computeAgentVisibleTools,
  defaultAgentGrant,
  resolveSkillToolScope,
} from './grant-math.js';
export type {
  ToolPack,
  ToolPackRiskLevel,
  AgentToolGrant,
  SkillToolScope,
  AgentVisibleToolsResult,
} from './grant-math.js';

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
 * Fail loud at module load if a pack references a tool that isn't in the
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

/**
 * The full set of tool names known to the platform, INCLUDING feature-flag-
 * gated tools that are currently absent from `REGISTRY` (the catalog re-adds
 * them). Domain packs are validated against this so listing a disabled tool is
 * not a module-load crash. Computed once at load.
 */
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(
  buildToolCatalog().map((e) => e.tool.name),
);

/**
 * Fail loud at module load if a DOMAIN pack references a tool name that is not
 * known to the platform AT ALL (typo / removed tool) — a silent capability gap.
 * Unlike `assertPackToolsExist` (which requires presence in the live
 * `REGISTRY`), this tolerates feature-flag-gated tools that are merely disabled
 * right now.
 */
function assertDomainPackToolsKnown(pack: ToolPack): void {
  for (const name of pack.tools) {
    if (!KNOWN_TOOL_NAMES.has(name)) {
      throw new Error(
        `tool_pack_unknown_tool: pack '${pack.id}' references tool '${name}' not known to the platform`,
      );
    }
  }
}

// Module-load self-checks: the pack contracts are verified on import, so a
// drift (adding a forbidden/sensitive tool to baseline, or a typo'd tool name
// in any pack) fails the process — and the test suite — immediately, not at
// runtime in production.
assertPackToolsExist(BASELINE_CORE_PACK);
assertConservative(BASELINE_CORE_PACK);
for (const pack of DOMAIN_PACKS) assertDomainPackToolsKnown(pack);
