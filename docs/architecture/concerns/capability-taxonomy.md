# Capability Taxonomy

> The canonical vocabulary for how an agent's behavior is composed at runtime: **baseline · channel behavior · role · skill · tool · tool pack · tool grant · policy · dispatcher guard**. This is the single source for the effective-turn composition that [#415](https://github.com/diogenesmendes01/Maia-v2/issues/415) and [#416](https://github.com/diogenesmendes01/Maia-v2/issues/416) reference. Some layers exist in code today; others are **new design axes** and are marked as such. When a statement here disagrees with the source, the source wins (see [`AGENTS.md`](../../../AGENTS.md) §0).

## 1. The nine layers

A runtime turn is not one thing the agent "is". It is a **composition** of nine layers, each with a narrow job. Confusing two layers (e.g., putting a confirmation rule inside a skill, or letting a role own tools) is the root of most design mistakes this taxonomy exists to prevent.

| # | Layer | What it is (one line) | Where it lives today | Status |
|---|---|---|---|---|
| 1 | **Agent baseline** | The minimal capability set every runtime agent has, regardless of domain (respond safely, ask, request confirmation, escalate, remember a safe fact, retrieve context, audit). | `agents` `src/db/schema.ts:907` — no baseline column today | **NEW** ([#410](https://github.com/diogenesmendes01/Maia-v2/issues/410)) |
| 2 | **Channel behavior** | Per-channel formatting and interaction rules (e.g., WhatsApp message style, attachments). | `src/gateway/` + `channel_policies` `src/db/schema.ts:1722` | exists |
| 3 | **Role** | The operational "hat" the agent wears for a channel/turn. Injects `prompt_addendum`; carries nothing executable. | `roles` `src/db/schema.ts:1697` (`prompt_addendum:1706`); selection chain `src/cognition/role-selector/` | role exists; role→skill / role→pack **NEW** |
| 4 | **Skill** | A reusable operational flow/contract: `goal`, `when_to_use`, `procedure`, `allowed_tools`. | `skills` `src/db/schema.ts:2189`; selector `src/runtime/decision/skill-selector.ts` | exists; usage-policy fields **NEW** ([#409](https://github.com/diogenesmendes01/Maia-v2/issues/409)) |
| 5 | **Tool** | An invocable technical action with Zod schemas, `required_actions`, `side_effect`, and an idempotency contract. | `Tool` type `src/tools/_registry.ts:55`; `REGISTRY` `:149` | exists |
| 6 | **Tool pack** | A named grouping of tools by domain, for grant and filtering. | — | **NEW** ([#408](https://github.com/diogenesmendes01/Maia-v2/issues/408)) |
| 7 | **Tool grant** | Which packs/tools a given agent (and, later, role) receives or is denied. | — (closest today: `ToolPermissionSliceBuilder` `src/runtime/context-assembly/slice-builders/tool-slice-builder.ts:44`, which filters `decision.tool_permissions.allowed_tools`) | **NEW** ([#408](https://github.com/diogenesmendes01/Maia-v2/issues/408)) |
| 8 | **Policy** | Decides whether a capability may execute, requires confirmation, is blocked, or must escalate. | `constitutionalCheck` `src/governance/rules.ts:14`; policy DSL `src/governance/policy-dsl/`; descriptors `src/control-plane/policy/` | exists; `SkillUsagePolicy` + write/risk policy **NEW** ([#409](https://github.com/diogenesmendes01/Maia-v2/issues/409)/[#416](https://github.com/diogenesmendes01/Maia-v2/issues/416)) |
| 9 | **Dispatcher guard** | The final server-side authority. Re-validates everything before any tool executes — even if a tool was wrongly made visible. | `dispatchTool` `src/tools/_dispatcher.ts:47` | exists |

Three distinctions worth stating explicitly, because they are easy to get wrong:

- **Not every capability is a skill.** A safe reply, a request for clarification, or a request for confirmation can be **baseline** or **channel** behavior. Reaching for a new skill where baseline already answers is duplication.
- **Role ≠ skill ≠ tool.** A role is a *hat* (prompt context + which grants apply). A skill is a *flow* (when_to_use + procedure + tool scope). A tool is a *technical action*. A role does not contain skills or tools in code today; see §5.
- **Skill ≠ policy.** A skill declares *what it does and which tools it needs*. Whether that may run, for whom, and whether confirmation is required, is a **policy** decision (§3, §6).

## 2. The effective-turn composition (canonical)

This is the **single canonical pipeline**. Other docs and issues (notably [#415](https://github.com/diogenesmendes01/Maia-v2/issues/415) §2 and [#416](https://github.com/diogenesmendes01/Maia-v2/issues/416) §4) should point here rather than restating it. Each step is tagged `[current]` (lives in code), `[partial]` (exists but mid-migration), or `[new #NNN]` (a design axis introduced by the named issue).

```txt
1. Channel resolve (tenant, agent, channel)            [current]  → src/gateway/channel-resolver.ts:54 (resolveChannel)
2. AudienceContext (sender identity for THIS agent)    [new #407] → audience_type, trust_level (no schema yet)
3. Active role (LLM suggests, policy decides)          [current]  → src/cognition/role-selector/ ; roles.prompt_addendum
4. Prompt = baseline + channel behavior + role         [partial]  → buildPrompt (src/agent/prompt-builder.ts:586)
                                                                    / buildPromptFromPacket (src/runtime/prompt/build-prompt-from-packet.ts:30,
                                                                      behind FEATURE_CONTEXT_PACKET_V1); baseline composition is new #410
5. Skill candidates = selector(intent) ∩ applicable_to_role
                                                        [selector current / applicable_to_role new #415]
                                                                   → src/runtime/decision/skill-selector.ts (strict > match)
6. SkillUsagePolicy filters candidates                 [new #409] → by audience / channel / data_scope / risk
7. visible_tools =
        agent grants                                   [new #408]
      ∩ active role allowed packs                       [new #415/#416]
      ∩ selected skill allowed_tools                    [current]  → skills.allowed_tools (schema:2208)
      ∩ human permission                                [current]  → getToolSchemas (_registry.ts:281); tool-slice-builder.ts:44
      ∩ audience / usage policy                          [new #409]
      ∩ write / risk policy                              [new #416]
      ∩ feature flag                                    [current]  → Tool.feature_flag (_registry.ts)
8. Dispatcher guard (final, server-side)               [current]  → src/tools/_dispatcher.ts:47
        re-validates feature flag (:62), constitutionalCheck (:96)
        — incl. the dual-approval requirement, surfaced as requires_dual_approval (:116) —
        canAct permission (:122), idempotency, audit

= effective behavior + visible/executable tools for the turn
```

The intersections in step 7 are the point: a tool is visible **only** if it survives *every* filter. Adding a filter can only ever *remove* tools, never add them. The dispatcher guard (step 8) then assumes nothing about step 7 and re-checks from scratch — visibility is a convenience for the LLM, not an authorization.

## 3. Source of truth: who decides what

Each decision has exactly one owning layer. The common failure mode is a lower layer (a skill, a role, the LLM) quietly taking a decision that belongs to a higher one.

| Decision | Owned by | **Never** owned by |
|---|---|---|
| Which agent answers | `channel_policy` / `agent-selector` (`src/runtime/decision/agent-selector.ts`) | the LLM, the gateway |
| Which role is active | role-selector chain — LLM suggests, **policy decides** (`src/cognition/role-selector/policy-decider.ts`) | the agent's prompt, the LLM |
| Which skill matches the intent | `skill-selector` + `skill-match` (strict `>` threshold) | — |
| Whether a skill is allowed for *this* audience/channel | `SkillUsagePolicy` (**new** [#409](https://github.com/diogenesmendes01/Maia-v2/issues/409)) | the skill body |
| Which tools are visible to the LLM | grants ∩ packs ∩ skill scope ∩ permission ∩ policy ∩ flag (step 7) | coincidental wiring/imports |
| Whether a write executes / needs confirmation / blocks / escalates | policy ([#409](https://github.com/diogenesmendes01/Maia-v2/issues/409)/[#416](https://github.com/diogenesmendes01/Maia-v2/issues/416)) **composed with** `constitutionalCheck` (which encodes dual-approval) + the dispatcher guard | the skill, the role, the LLM |
| Final execution authority | **dispatcher guard** (`src/tools/_dispatcher.ts`) | the LLM |

> **The load-bearing rule:** a skill never decides confirmation or write authorization. It declares *intent and scope*; **policy + the dispatcher decide execution.** This is why skills must not hardcode `requires_confirmation`-style branches (see §6, §7).

## 4. Universal vs domain — what can (and can never) be baseline

The baseline ([#410](https://github.com/diogenesmendes01/Maia-v2/issues/410)) is deliberately conservative: enough to understand context, answer, ask, confirm, remember safely, audit, and escalate — and nothing with real-world side effects.

**Can be baseline (`baseline.core`):**

- read turn context;
- read authorized memory; write a *safe* memory fact when policy permits;
- read in-scope conversation history;
- write an audit record;
- request confirmation / approval (as a *mechanism*, not a hardcoded skill rule);
- hand off / escalate to owner / human;
- produce a safe textual response with no external action.

**Can never be baseline** — must arrive through a domain pack + an explicit grant + a policy:

- moving money, charging, transfers, payments;
- mutating registration / CRM / ERP records;
- proactive external sends;
- executing workflows with real effect;
- sensitive internal data or internal reports;
- another customer's data;
- **any tool whose `side_effect` is `'write'` or `'communication'`** (`src/tools/_registry.ts:61`) without a specific governing policy.

Two corollaries:

- **Baseline is universal — do not duplicate it per role.** A role lists only what it *adds* on top of baseline. A role that re-declares `safe_conversation` or `request_confirmation` is a smell.
- **Domain capability is opt-in.** An agent with no domain pack granted sees only baseline tools. A finance pack, a sales pack, or the boleto packs of [#416](https://github.com/diogenesmendes01/Maia-v2/issues/416) are granted explicitly, never inherited by default.

### 4.1 Baseline skill → tool coverage matrix ([#410](https://github.com/diogenesmendes01/Maia-v2/issues/410) → [#433](https://github.com/diogenesmendes01/Maia-v2/issues/433))

Every baseline capability the #410 contract promises maps to a tool in `BASELINE_CORE_PACK` (`src/tools/grant-math.ts`). A live audit at #433 found **~70% already shipped** under different names; #433 filled only the **3 genuine gaps** (rows marked **gap → wrap**). "Grant" = reuse the existing tool as-is; "Wrap" = a thin tool over an existing shared engine/repo (never a second engine). All 10 tools are auto-audited by the dispatcher from their `audit_action` — no tool hand-rolls `audit()`.

| Baseline capability (#410) | Tool | side_effect / operation_type | Grant vs wrap | Notes |
|---|---|---|---|---|
| Understand the current turn | `read_turn_context` | none / read | **grant** (existed) | `mensagensRepo.recentInConversation`, ALS-scoped to the caller's conversa. |
| Read authorized memory in scope | `recall_memory` | read / read | **grant** (existed) | Reused; not re-added to the registry. |
| Persist a SAFE per-pessoa fact | `remember_safe_fact` | write / create | **grant** (existed) | Scope FORCED to `pessoa:<self>`; gated by `save_safe_fact`. One of the two allowlisted baseline writes. |
| Ask before acting (never acts) | `request_confirmation` | none / read | **grant** (existed) | Pure speech act. The *persisted* gate is `ask_pending_question` (a domain tool) — not conflated. |
| Escalate to the owner (internal) | `handoff_to_owner` | communication / communicate | **grant** (existed) | INTERNAL escalation signal; the only allowlisted baseline communication. No external send, no handoff store. |
| Record a decision rationale | `audit_decision` | none / read | **grant** (existed) | Thin wrapper over `audit()` with a FIXED action label. |
| Honest "I can't do that (yet)" | `explain_limitation` | none / read | **grant** (existed) | Pure speech act; performs no escalation itself. |
| Assess the risk of the turn | `risk_signal_classify` | none / parse_only | **gap → wrap** | Wraps the shared two-stage scorer via `classifyTurnRisk` (`src/shared/risk/turn-risk-adapter.ts`). No second risk enum; the level is the deterministic scorer's (LLM may only elevate). Adapter is shared with [#431](https://github.com/diogenesmendes01/Maia-v2/issues/431) `case_risk_classify`. |
| Summarize the conversation | `conversation_summary_compose` | none / parse_only | **gap → wrap** | Wraps the extracted `summarizeTranscript` (`src/shared/summary/summarize-transcript.ts`), the SAME helper the `conversation-summarizer` worker now calls (no duplicated prompt). Read-only — does not close the conversation. Shared with #431. |
| Update lightweight conversation state | `conversation_state_update` | write / update_meta | **gap → wrap** | Thin tool over `conversasRepo.mergeMetadata` (atomic, ALS-scoped jsonb merge). Self-scoped to `ctx.conversa.id`; rejects a divergent `conversation_id`; refuses reserved gate keys (pending/clarification/confirmation, scope hash) — those route through `ask_pending_question`. The second allowlisted baseline write. |

Tools deliberately **NOT** built (the audit's other findings): no second confirmation store (`request_confirmation` speech act + `ask_pending_question` persisted gate already cover it), no handoff record store (overlaps `operational_ticket_create` in [#432](https://github.com/diogenesmendes01/Maia-v2/issues/432)), no new memory writer (the `propose_*` KSM family + `remember_safe_fact` cover safe writes).

## 5. New axes vs current behavior

Several relationships this taxonomy describes **do not exist in the schema or code yet**. Treat them as design axes, not as infrastructure you can call today. Each is independently verifiable with a grep against `src/db/schema.ts`.

| Concept | In code today? | Introduced by | How to verify absence |
|---|---|---|---|
| Per-agent `AudienceContext` (`audience_type`, `trust_level`, contact identity) | No | [#407](https://github.com/diogenesmendes01/Maia-v2/issues/407) | `grep -nE "audience_type\|agent_audience\|contact_identity" src/db/schema.ts` → none |
| `baseline.core` as a contract applied to every agent | No | [#410](https://github.com/diogenesmendes01/Maia-v2/issues/410) | `agents` table (`schema.ts:907`) has no baseline column |
| Tool packs | No | [#408](https://github.com/diogenesmendes01/Maia-v2/issues/408) | `grep -n "tool_packs" src/db/schema.ts` → none |
| Agent tool grants | No (only an informal runtime filter) | [#408](https://github.com/diogenesmendes01/Maia-v2/issues/408) | `grep -n "agent_tool_grants" src/db/schema.ts` → none; closest is `tool-slice-builder.ts:44` |
| Role → skill (`applicable_to_role`) | No | [#415](https://github.com/diogenesmendes01/Maia-v2/issues/415) | `grep -n "applicable_to_role" src/db/schema.ts` → none; `roles` has no skill column |
| Role → tool pack | No | [#415](https://github.com/diogenesmendes01/Maia-v2/issues/415)/[#416](https://github.com/diogenesmendes01/Maia-v2/issues/416) | `roles` table (`schema.ts:1697`) has no pack column |
| `SkillUsagePolicy` fields (`allowed_audience`, `data_scope`, `exposure_policy`, `requires_auth_level`, …) | No | [#409](https://github.com/diogenesmendes01/Maia-v2/issues/409) | `grep -nE "allowed_audience\|data_scope\|exposure_policy" src/db/schema.ts` → none |

> **Stated plainly:** roles today carry only `prompt_addendum`. They **do not own, grant, or filter** skills or tools. `role → skill` and `role → tool-pack` are new implementation axes, not current runtime behavior. Any issue that builds on them must add the schema/runtime for the axis it needs — it cannot assume it already exists.

## 6. Compose, don't bypass

The platform already has a write-governance spine. New write and risk policies **compose with it**; they never replace it and never open a parallel path.

| Existing guard | Where | What it does |
|---|---|---|
| `constitutionalCheck` | `src/governance/rules.ts:14` (called at `_dispatcher.ts:96`) | The dispatcher's non-negotiable rules over typed intents — scope, cross-entity, limits, **and dual-approval requirements** (e.g. `rules.ts:35`, `:68`). When it requires dual approval and `dual_approval_granted` is absent, the dispatcher short-circuits with `requires_dual_approval` (`_dispatcher.ts:116`). |
| `requiresDualApproval` | `src/governance/dual-approval.ts:38` | A separate predicate cataloguing critical actions that need a second approver (high-value `register_transaction`, account/permission changes, proactive sends). **The dispatcher does not call it** — its dual-approval gate is `constitutionalCheck` (above); the approval state machine lives under `src/workflows/dual-approval.ts`. |
| Dispatcher guard | `dispatchTool` `src/tools/_dispatcher.ts:47` | Final re-validation: feature flag (`:62`) → constitutional, incl. dual-approval (`:96`) → `canAct` (`:122`) → idempotency → audit. |

Rules for anything that writes:

- A write/risk policy ([#416](https://github.com/diogenesmendes01/Maia-v2/issues/416)'s `confirm_before_write_policy`, `human_confirmation_policy`, etc.) **decides** (allow / confirm / block / escalate) and then **delegates execution through the dispatcher**. It does not execute writes itself.
- **Confirmation is a policy decision surfaced to the user and enforced by the dispatcher** — never an `if (needsConfirmation)` inside a skill.
- The write tools [#416](https://github.com/diogenesmendes01/Maia-v2/issues/416) will add (`boleto_cancel`, `company_campaign_remove`, `refund_create`) **do not exist in the registry yet**. When added, each must be marked `side_effect: 'write'` and pass through the guard like the write tools that exist today (`register_transaction`, `cancel_transaction`, `start_recurring_payment`, …). The guard is the safety net even if step 7 wrongly exposes one.
- **Document/receipt validation reuses the existing parsers.** Build `receipt_validate` on `parse_receipt` (`src/tools/parse-receipt.ts`, registered `_registry.ts:157`) and `parse_image` (`src/tools/parse-image.ts`, `_registry.ts:158`). Do not introduce new OCR/vision tools that duplicate them.

## 7. Anti-patterns

| Pattern | Why it's wrong |
|---|---|
| A role with an embedded confirmation `if` | Confirmation is a policy decision ([#409](https://github.com/diogenesmendes01/Maia-v2/issues/409)/[#416](https://github.com/diogenesmendes01/Maia-v2/issues/416)) enforced by the dispatcher. A role only adds `prompt_addendum` + grants. |
| A skill that hardcodes write authorization or an audience allow-list in its body | Authorization is policy (§3, §6); audience gating is `SkillUsagePolicy`, evaluated *before* tools are shown. |
| A tool registered outside `_registry.ts` | The registry is the single callable surface; off-registry tools are invisible to permission and audit (see [`action-layer.md`](action-layer.md) §5). |
| A write path parallel to `constitutionalCheck` / dual-approval | Every write composes with the existing guard. A side path is an un-audited, un-gated hole. |
| A new OCR/vision tool instead of reusing `parse_receipt` / `parse_image` | Duplicates capability and audit surface. Reuse the registered parsers. |
| A tool "exposed" only by wiring/import, with no real grant | Visibility must come from a grant ∩ policy decision (step 7), not from coincidental wiring ([#408](https://github.com/diogenesmendes01/Maia-v2/issues/408)). |
| Duplicating baseline skills inside a role | Baseline is universal ([#410](https://github.com/diogenesmendes01/Maia-v2/issues/410)); a role lists only what it adds. |
| Treating role selection as the LLM's job | The LLM *suggests*; policy *decides* (see [`channel-policy.md`](channel-policy.md) §4.3). |

## 8. Relationship to existing concerns

This concern stitches three existing ones together; read them for the layers that already exist in code.

- [`action-layer.md`](action-layer.md) — skills, tools, the decision engine, the dispatcher, idempotency, and the three PEPs. The packs/grants/usage-policy axes are **new filters** feeding the same runtime tool filter and the same dispatcher guard described there.
- [`channel-policy.md`](channel-policy.md) — channel resolution, the role-selector chain, and policy descriptors. The **role** and **policy** layers (#2, #3, #8) are defined there; this doc adds the role→skill/pack axis and the `SkillUsagePolicy` gate (both new).
- [`governance-observability.md`](governance-observability.md) — audit, dual-approval, `constitutionalCheck`, and the policy DSL. "Compose, don't bypass" (§6) is the bridge: new write/risk policies reuse this machinery rather than duplicating it.

**Related issues:** [#407](https://github.com/diogenesmendes01/Maia-v2/issues/407) (AudienceContext) · [#408](https://github.com/diogenesmendes01/Maia-v2/issues/408) (tool packs + grants) · [#409](https://github.com/diogenesmendes01/Maia-v2/issues/409) (SkillUsagePolicy) · [#410](https://github.com/diogenesmendes01/Maia-v2/issues/410) (baseline) · [#415](https://github.com/diogenesmendes01/Maia-v2/issues/415) (boleto role + skills) · [#416](https://github.com/diogenesmendes01/Maia-v2/issues/416) (boleto tools + packs + policies).

---

| | |
|---|---|
| Last verified | 2026-06-03 |
| Against `main` HEAD | `f35dd33` |
| Re-verify when | Older than 30 days; OR any of #407 / #408 / #409 / #410 / #415 / #416 lands (each flips a "new axis" row in §5 to "current"); OR `_dispatcher.ts` changes its guard order; OR the `roles` / `skills` schema gains audience / pack / grant columns; OR the prompt builders in `src/agent/prompt-builder.ts` + `src/runtime/prompt/` consolidate. |
