/**
 * Issue #410 + #408 — Tool Pack DEFINITIONS and the pure grant MATH.
 *
 * This module is intentionally REGISTRY-FREE: it imports nothing from
 * `_registry.ts`, so importing it has NO module-load side effects (no gateway
 * chain, no registry-validation assertions). The dispatcher and the runtime
 * filter import the grant math from HERE; the registry-validated surface
 * (`packs.ts`) re-exports everything and additionally runs the load-time
 * `assertPackToolsExist` / `assertConservative` / `assertDomainPackToolsKnown`
 * drift guards against the live `REGISTRY`.
 *
 * WHY THE SPLIT (issue #408): `_dispatcher.ts` needs `resolveGrantedToolNames`
 * for its `tool_not_granted` guard. If it imported `packs.ts` (which validates
 * against `REGISTRY` at load), every dispatcher unit test that mocks
 * `_registry.js` with a minimal registry would crash on the baseline assertion.
 * Keeping the pure math here decouples enforcement from registry validation.
 *
 * Pack vs grant:
 *   - A `ToolPack` is a PRODUCT definition (code) — `baseline.core` + `domain.*`.
 *   - An `AgentToolGrant` is per-agent DATA (the `agent_tool_grants` table).
 * The visible set is the intersection (see `computeAgentVisibleTools` + the
 * Runtime Tool Filter in `runtime-filter.ts`).
 */

/**
 * Risk classification of a pack's contents (issue #408). `baseline.core` is
 * `low`; finance is `high`; CRM/scheduling are `medium`. #409 will use this to
 * gate visibility by audience/data_scope (a high-risk pack hidden from a
 * low-trust audience even when granted) — for #408 it is informative metadata
 * recorded in the provenance audit.
 */
export type ToolPackRiskLevel = 'low' | 'medium' | 'high';

/**
 * A named, versioned bundle of tool NAMES an agent may be granted. The pack
 * references tools by their registry key (`Tool.name`); it does NOT embed the
 * tool definitions, so a pack stays a thin, serialisable contract.
 *
 * #408 extends the universe of pack ids with `domain.*` packs. The id is a
 * dotted string (`<scope>.<name>`) rather than a closed enum on purpose — a
 * new domain pack is additive and must not require editing a central union.
 *
 * #408 also enriches the contract with `name` / `domain` / `risk_level` /
 * `default_for_agent_type` (issue #408 §ToolPack). They are OPTIONAL so the
 * #410 `BASELINE_CORE_PACK` literal stays valid unchanged (do-not-redefine);
 * the `domain.*` packs set them. A pack is PRODUCT definition (code), never
 * per-tenant data — so it lives here, not in a table.
 */
export interface ToolPack {
  /** Stable pack id, e.g. `baseline.core`, `domain.finance`. */
  id: string;
  /** Short human-readable name (issue #408). Defaults to `id` when absent. */
  name?: string;
  /** Domain the pack belongs to, e.g. `core`, `finance` (issue #408). */
  domain?: string;
  /** Monotonic version of the pack's contents (bump when `tools` changes). */
  version: number;
  /** Human-readable purpose of the pack. */
  description: string;
  /**
   * Risk classification (issue #408). Absent ⇒ treated as `low`. Recorded in
   * the `tool_visibility_resolved` provenance audit; #409 gates on it.
   */
  risk_level?: ToolPackRiskLevel;
  /**
   * Agent types this pack is a sensible default for (issue #408). PURELY
   * advisory metadata for the admin UI / onboarding — it does NOT auto-grant
   * (grants are explicit, persisted in `agent_tool_grants`). Domain packs are
   * NEVER auto-added to `DEFAULT_AGENT_PACKS`.
   */
  default_for_agent_type?: readonly string[];
  /**
   * The tool registry names this pack grants. MUST exist in `REGISTRY`
   * (asserted at module load by `assertPackToolsExist`, in `packs.ts`).
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
 * #408 seeds the `agent_tool_grants` table with this on agent creation
 * (`agentsRepo.createWithSeedAndAudit`) and wires the dispatcher enforcement.
 * Domain packs are NEVER added here — they are granted explicitly per agent.
 */
export const DEFAULT_AGENT_PACKS: readonly string[] = ['baseline.core'] as const;

// ───────────────────────────────────────────────────────────────────────────
// Issue #408 — DOMAIN packs.
//
// A domain pack is the set of tools an agent needs to operate in one business
// vertical. Unlike `baseline.core`, a domain pack MAY contain financial / CRM /
// proactive-external / scheduling tools — that is the whole point: an agent
// only sees those tools when its `agent_tool_grants` row grants the pack
// (invariant #5, fail-closed). The runtime filter (`computeAgentVisibleTools`)
// intersects the granted union with the human-permission view and the skill
// scope; the dispatcher `tool_not_granted` guard revalidates server-side.
//
// Domain packs reference tools by their registry NAME. Some of those tools are
// feature-flag gated and absent from `REGISTRY` when their flag is off
// (`generate_report`, `schedule_reminder`, …). `packs.ts` validates domain-pack
// tool names against the COMPLETE catalog (incl. flag-gated tools), so a pack
// listing a currently-disabled tool does not crash module load — a disabled
// tool is simply invisible at runtime (`isToolEnabled` filters it).
// ───────────────────────────────────────────────────────────────────────────

/**
 * `domain.finance` — the PF+PJ finance vertical (Maia's first vertical).
 * `high` risk: it moves money / cancels transactions. Each tool still passes
 * the existing human-permission gate (`required_actions ⊆ allowed`) AND the
 * dispatcher's `canAct`/constitutional guards — the grant only makes the tools
 * VISIBLE to an agent that installed the pack.
 */
export const DOMAIN_FINANCE_PACK: ToolPack = {
  id: 'domain.finance',
  name: 'Finanças',
  domain: 'finance',
  version: 1,
  risk_level: 'high',
  default_for_agent_type: ['financeiro'],
  description:
    'Capacidades financeiras (PF+PJ): registrar/cancelar/classificar transações, consultar saldo, listar e comparar, relatórios e pagamentos recorrentes. Tools sensíveis — só visíveis ao agente que recebeu o grant.',
  tools: [
    'register_transaction',
    'cancel_transaction',
    'query_balance',
    'list_transactions',
    'classify_transaction',
    'compare_entities',
    'generate_report',
    'start_recurring_payment',
    'identify_entity',
  ],
} as const;

/**
 * `domain.sales` — outbound/CRM. `medium` risk: proactive external messaging +
 * recurring outreach. The proactive-send tools are kept out of `baseline.core`
 * ("fora do baseline") and gated behind this explicit grant.
 */
export const DOMAIN_SALES_PACK: ToolPack = {
  id: 'domain.sales',
  name: 'Vendas / CRM',
  domain: 'sales',
  version: 1,
  risk_level: 'medium',
  default_for_agent_type: ['vendas', 'comercial'],
  description:
    'Capacidades de prospecção/CRM: identificar interlocutor, enviar mensagem proativa e configurar outreach recorrente. Envio externo é sensível — só com grant explícito.',
  tools: ['identify_entity', 'send_proactive_message', 'start_recurring_outreach'],
} as const;

/**
 * `domain.support` — atendimento. `low` risk: read-oriented context + pending-
 * question orchestration + internal workflow start. No money movement, no
 * external proactive send.
 */
export const DOMAIN_SUPPORT_PACK: ToolPack = {
  id: 'domain.support',
  name: 'Atendimento',
  domain: 'support',
  version: 1,
  risk_level: 'low',
  default_for_agent_type: ['suporte', 'atendimento'],
  description:
    'Capacidades de atendimento: identificar interlocutor, listar pendências, perguntar e iniciar workflows internos para resolver solicitações.',
  tools: ['identify_entity', 'list_pending', 'ask_pending_question', 'start_workflow'],
} as const;

/**
 * `domain.calendar` — agenda/feriados. `medium` risk: read-only calendar tools
 * are safe, but the pack also grants the write tools (schedule/cancel reminder,
 * register custom holiday) that create real series/effects.
 */
export const DOMAIN_CALENDAR_PACK: ToolPack = {
  id: 'domain.calendar',
  name: 'Agenda',
  domain: 'calendar',
  version: 1,
  risk_level: 'medium',
  default_for_agent_type: ['operacoes', 'agenda'],
  description:
    'Capacidades de agenda: consultas de dias úteis/feriados (read-only) e gestão de lembretes/feriados customizados (write, com efeito real).',
  tools: [
    'calendar_is_business_day',
    'calendar_next_holiday',
    'calendar_list_holidays',
    'calendar_business_days_between',
    'calendar_add_business_days',
    'schedule_reminder',
    'cancel_reminder',
    'register_custom_holiday',
  ],
} as const;

/**
 * `domain.operations` — operação genérica. `medium` risk: combines workflow
 * orchestration + scheduling for agents that run internal procedures on a
 * cadence (NOT external outreach, which is `domain.sales`).
 */
export const DOMAIN_OPERATIONS_PACK: ToolPack = {
  id: 'domain.operations',
  name: 'Operações',
  domain: 'operations',
  version: 1,
  risk_level: 'medium',
  default_for_agent_type: ['operacoes'],
  description:
    'Capacidades operacionais: iniciar workflows internos e agendar lembretes/recorrências para processos internos.',
  tools: ['start_workflow', 'schedule_reminder', 'cancel_reminder', 'list_pending'],
} as const;

/** The `domain.*` packs introduced by #408 (validated in `packs.ts`). */
export const DOMAIN_PACKS: readonly ToolPack[] = [
  DOMAIN_FINANCE_PACK,
  DOMAIN_SALES_PACK,
  DOMAIN_SUPPORT_PACK,
  DOMAIN_CALENDAR_PACK,
  DOMAIN_OPERATIONS_PACK,
] as const;

/**
 * All packs: the #410 `baseline.core` floor + the #408 `domain.*` packs.
 * Keyed by pack id for O(1) lookup by the grant filter.
 */
export const TOOL_PACKS: Readonly<Record<string, ToolPack>> = {
  [BASELINE_CORE_PACK.id]: BASELINE_CORE_PACK,
  ...Object.fromEntries(DOMAIN_PACKS.map((p) => [p.id, p])),
} as const;

/**
 * Resolve a set of pack ids to the union of tool names they grant. Unknown pack
 * ids are skipped (fail-closed: an unknown pack grants nothing rather than
 * throwing in the hot path). The runtime filter intersects this with the
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

// ───────────────────────────────────────────────────────────────────────────
// Issue #408 — the AGENT half of the visibility intersection.
//
//   VISÍVEL = ( baseline.core ∪ granted_packs ∪ granted_tools − denied_tools )  ← the AGENT (this file)
//           ∩ ( skill.allowed_tools − skill.denied_tools )                      ← the SKILL  (SkillToolScope)
//           ∩ ( required_actions ⊆ permissões da pessoa )                       ← the HUMAN  (getAgentToolSchemas)
//           ∩ ( isToolEnabled / feature flag )                                  ← kill-switch (getAgentToolSchemas)
//           ∩ ( skill permitida p/ audiência/canal/data_scope/risco )          ← #409 (NOT here)
//
// This module owns the first two filters (agent grant + skill scope). The
// human-permission + feature-flag filters are applied in `getAgentToolSchemas`
// (`_registry.ts`); the audience/data_scope/risk filter is #409's and hooks in
// AFTER this set is computed. The dispatcher revalidates the agent-grant filter
// server-side (`tool_not_granted` guard) so a tool the LLM should never see
// still cannot execute (invariant #5, fail-closed).
// ───────────────────────────────────────────────────────────────────────────

/**
 * The effective AGENT tool grant — the runtime projection of one
 * `agent_tool_grants` row (issue #408). `denied_tools` is HARD: a denied tool
 * is removed from the visible set AND refused by the dispatcher, even if it is
 * also in a granted pack/tool.
 *
 * `baseline.core` is ALWAYS unioned in (every agent has the floor) regardless
 * of whether the persisted row lists it — so a malformed/empty grant still
 * yields the conservative baseline rather than zero tools.
 */
export interface AgentToolGrant {
  granted_packs: readonly string[];
  granted_tools: readonly string[];
  denied_tools: readonly string[];
}

/**
 * `SkillToolScope` (issue #408) — extends `skill.allowed_tools` with
 * `denied_tools` and `requires_confirmation_for`. It NARROWS the agent-visible
 * set when a skill is selected: the LLM only sees tools the skill allows.
 *
 *   - `allowed_tools`: when non-empty, the visible set is intersected with it
 *     (an empty/absent list means "the skill does not restrict tools" — the
 *     agent grant alone decides, matching the pre-#408 behaviour).
 *   - `denied_tools`: HARD removal (same semantics as the agent grant's deny).
 *   - `requires_confirmation_for`: tools that stay visible but must be
 *     confirmed before execution — carried through to the decision packet's
 *     `requires_confirmation`, NOT a visibility filter.
 */
export interface SkillToolScope {
  skill_id?: string;
  allowed_tools?: readonly string[];
  denied_tools?: readonly string[];
  requires_confirmation_for?: readonly string[];
}

/**
 * Resolve the AGENT-granted tool set: `baseline.core ∪ packs ∪ tools − denied`.
 * `denied_tools` wins over everything (HARD). `baseline.core` is always
 * included. Unknown packs contribute nothing (`resolvePackTools` skips them).
 * The result is NOT yet filtered by human permission / feature flag / skill —
 * those layers are applied by `getAgentToolSchemas` and `computeAgentVisibleTools`.
 */
export function resolveGrantedToolNames(grant: AgentToolGrant): Set<string> {
  const granted = new Set<string>();
  // Always include the baseline floor.
  for (const name of BASELINE_CORE_PACK.tools) granted.add(name);
  for (const name of resolvePackTools(grant.granted_packs)) granted.add(name);
  for (const name of grant.granted_tools) granted.add(name);
  // HARD deny removes regardless of source.
  for (const name of grant.denied_tools) granted.delete(name);
  return granted;
}

/**
 * Compose the AGENT grant with the SKILL scope (issue #408). This is the part
 * of the Runtime Tool Filter that lives in the tools module; the human-
 * permission + feature-flag intersection is applied separately by
 * `getAgentToolSchemas`.
 *
 * Returns BOTH the visible set and a `provenance` record so the caller can
 * audit WHY each layer shaped the set (`tool_visibility_resolved`, criterion
 * #408 "auditoria registra quais grants/packs/skills produziram o conjunto").
 */
export interface AgentVisibleToolsResult {
  /** Tool names the agent may see, after grant ∩ skill scope. */
  visible: string[];
  /**
   * Tools the SKILL marks as needing confirmation (∩ visible). Carried to the
   * decision packet's `requires_confirmation`; NOT removed from `visible`.
   */
  requires_confirmation: string[];
  /** Provenance for the audit trail. */
  provenance: {
    granted_packs: string[];
    granted_tools: string[];
    denied_by_grant: string[];
    skill_id: string | null;
    skill_allowed_tools: string[];
    denied_by_skill: string[];
    /** Tools dropped purely because a skill `allowed_tools` narrowed the set. */
    dropped_by_skill_allowlist: string[];
  };
}

export function computeAgentVisibleTools(
  grant: AgentToolGrant,
  skillScope?: SkillToolScope | null,
): AgentVisibleToolsResult {
  const grantedSet = resolveGrantedToolNames(grant);

  const skillAllowed = skillScope?.allowed_tools ?? [];
  const skillDenied = new Set(skillScope?.denied_tools ?? []);
  const skillConfirm = skillScope?.requires_confirmation_for ?? [];

  const droppedByAllowlist: string[] = [];
  const visible: string[] = [];
  for (const name of grantedSet) {
    // Skill HARD deny — never visible.
    if (skillDenied.has(name)) continue;
    // Skill allowlist (when present) narrows the set.
    if (skillAllowed.length > 0 && !skillAllowed.includes(name)) {
      droppedByAllowlist.push(name);
      continue;
    }
    visible.push(name);
  }

  const visibleSet = new Set(visible);
  const requires_confirmation = skillConfirm.filter((n) => visibleSet.has(n));

  return {
    visible,
    requires_confirmation,
    provenance: {
      granted_packs: [...grant.granted_packs],
      granted_tools: [...grant.granted_tools],
      denied_by_grant: [...grant.denied_tools],
      skill_id: skillScope?.skill_id ?? null,
      skill_allowed_tools: [...skillAllowed],
      denied_by_skill: [...(skillScope?.denied_tools ?? [])],
      dropped_by_skill_allowlist: droppedByAllowlist,
    },
  };
}

/**
 * The grant every newly-created agent receives: ONLY `baseline.core`, no domain
 * tools, no denies. Mirrors `DEFAULT_AGENT_PACKS`; consumed by the repo when it
 * seeds the default `agent_tool_grants` row at agent creation.
 */
export function defaultAgentGrant(): AgentToolGrant {
  return { granted_packs: [...DEFAULT_AGENT_PACKS], granted_tools: [], denied_tools: [] };
}

/**
 * Project a skill row/summary into a `SkillToolScope` (issue #408). The DB
 * `skills` table stores `allowed_tools` as a column; the OPTIONAL #408
 * extensions (`denied_tools` / `requires_confirmation_for`) live in the
 * extensible `runtime_hints` JSONB bag, so no migration is needed — a skill that
 * declares them in `runtime_hints` gets the narrowed scope, others behave
 * exactly as before. The runtime `Skill` type (`src/runtime/decision/types.ts`)
 * surfaces `blocked_tools` / `requires_confirmation_tools`; this reader accepts
 * BOTH shapes so the same helper works in the decision layer and the executor.
 */
export function resolveSkillToolScope(skill: {
  id?: string;
  skill_descriptor?: string;
  allowed_tools?: readonly string[] | unknown;
  blocked_tools?: readonly string[] | unknown;
  requires_confirmation_tools?: readonly string[] | unknown;
  runtime_hints?: Record<string, unknown> | unknown;
}): SkillToolScope {
  const hints =
    typeof skill.runtime_hints === 'object' && skill.runtime_hints !== null
      ? (skill.runtime_hints as Record<string, unknown>)
      : {};
  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  return {
    skill_id: skill.id ?? skill.skill_descriptor,
    allowed_tools: asStrings(skill.allowed_tools),
    // `denied_tools`: prefer the runtime `blocked_tools` field; fall back to the
    // `runtime_hints.denied_tools` JSONB extension.
    denied_tools: [
      ...asStrings(skill.blocked_tools),
      ...asStrings(hints['denied_tools']),
    ],
    // `requires_confirmation_for`: prefer the runtime field; fall back to the
    // `runtime_hints.requires_confirmation_for` JSONB extension.
    requires_confirmation_for: [
      ...asStrings(skill.requires_confirmation_tools),
      ...asStrings(hints['requires_confirmation_for']),
    ],
  };
}
