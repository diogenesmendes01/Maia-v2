# Baseline Skills v2

> The canonical reference for the **BASELINE_CORE_PACK v2** skill set — skill-to-tool coverage matrix, execution mode rationale, privacy handling, and migration pointer. Supersedes the informal notes in migration 075's header comments. When this doc disagrees with the source schema or code, the source wins (see [`AGENTS.md`](../../../AGENTS.md) §0).

## 1. Background

Migration 075 seeded eight baseline skills — the minimal operational set that every runtime agent carries regardless of domain — all as `prompt_only`. Since then, three new tools were added to `BASELINE_CORE_PACK` (defined in `src/tools/grant-math.ts`, re-exported with load-time drift guards via `src/tools/packs.ts`):

- `risk_signal_classify` — deterministic two-stage turn-risk scorer ([#433](https://github.com/diogenesmendes01/Maia-v2/issues/433))
- `conversation_summary_compose` — shared structured-summary wrapper ([#433](https://github.com/diogenesmendes01/Maia-v2/issues/433))
- `conversation_state_update` — atomic jsonb state merge on `conversasRepo` ([#433](https://github.com/diogenesmendes01/Maia-v2/issues/433))

With all ten tools available in the pack, migration 080 ([#448](https://github.com/diogenesmendes01/Maia-v2/issues/448)):

1. Upgrades five existing baseline skills from `prompt_only` v1 to `tool_mediated` v2, so the runtime actually invokes the tools they declare.
2. Adds three new `tool_mediated` skills (at v1) that cover the three new tools.

The three skills that stayed `prompt_only` remain unchanged at v1; the rationale is in §3.

## 2. BASELINE_CORE_PACK v2 — complete tool inventory

All ten tools below are exclusively available to baseline skills. Domain packs may not alias or re-export them; domain tools are granted separately.

| Tool | side_effect | operation_type | Notes |
|---|---|---|---|
| `read_turn_context` | none | read | `mensagensRepo.recentInConversation`, ALS-scoped to the caller's conversa. |
| `recall_memory` | read | read | Reads authorised memory within scope; never cross-tenant. |
| `remember_safe_fact` | write | create | Scope FORCED to `pessoa:<self>`; gated by `save_safe_fact`. One of two allowlisted baseline writes. |
| `request_confirmation` | none | read | Pure speech act — displays a confirmation request, never executes the action itself. |
| `handoff_to_owner` | communication | communicate | INTERNAL escalation signal to the owner. No external send, no handoff store. Only allowlisted baseline communication. |
| `audit_decision` | none | read | Thin wrapper over `audit()` with a FIXED action label. Auto-called via `audit_action` in the dispatcher. |
| `explain_limitation` | none | read | Pure speech act; performs no escalation itself. |
| `risk_signal_classify` | none | parse_only | Wraps the shared two-stage scorer via `classifyTurnRisk` (`src/shared/risk/turn-risk-adapter.ts`). LLM may only elevate the deterministic level, never lower it. |
| `conversation_summary_compose` | none | parse_only | Wraps `summarizeTranscript` (`src/shared/summary/summarize-transcript.ts`) — the same helper the `conversation-summarizer` worker calls. Read-only; does not close the conversation. |
| `conversation_state_update` | write | update_meta | Thin wrapper over `conversasRepo.mergeMetadata` (atomic jsonb merge, ALS-scoped). Rejects a divergent `conversation_id`; refuses reserved gate keys (pending/clarification/confirmation, scope hash). Second allowlisted baseline write. |

## 3. Skill-to-tool coverage matrix

Eleven baseline skills total: eight original (5 upgraded to v2, 3 unchanged at v1) + 3 new at v1. All are seeded under `agent_id IS NULL` (tenant-wide) with `proposed_by='system'` and `approved_by='system'`.

| Skill | v | Mode | Category | Allowed tools |
|---|---|---|---|---|
| `safe_conversation` | 2 | `tool_mediated` | compose | `read_turn_context`, `recall_memory`, `risk_signal_classify` |
| `ask_clarification` | 1 | `prompt_only` | compose | `read_turn_context` |
| `request_confirmation` | 1 | `prompt_only` | decide | `request_confirmation` |
| `handoff_to_owner` | 2 | `tool_mediated` | decide | `handoff_to_owner`, `audit_decision`, `conversation_summary_compose` |
| `remember_safe_fact` | 2 | `tool_mediated` | compose | `remember_safe_fact`, `audit_decision` |
| `retrieve_context` | 2 | `tool_mediated` | compose | `read_turn_context`, `recall_memory` |
| `explain_limitation` | 1 | `prompt_only` | compose | `explain_limitation` |
| `audit_decision` | 2 | `tool_mediated` | decide | `audit_decision` |
| `escalate_on_risk` | 1 | `tool_mediated` | decide | `risk_signal_classify`, `handoff_to_owner`, `audit_decision` |
| `summarization` | 1 | `tool_mediated` | compose | `conversation_summary_compose` |
| `manage_conversation_state` | 1 | `tool_mediated` | decide | `conversation_state_update` |

**Tool coverage:** all 10 `BASELINE_CORE_PACK` tools appear at least once. `audit_decision` is the most reused — it pairs with every write or escalation skill.

## 4. Execution mode rationale

### 4.1 Why a skill is `tool_mediated`

`tool_mediated` means the runtime wires explicit tool calls so that:

- **Auditability is enforced at the framework level.** The dispatcher sees each tool call as a typed event; no skill can silently skip an audit step.
- **Observability.** The runtime can log which tool produced which piece of context (deterministic attribution, invariant #4).
- **Deterministic risk scoring.** `risk_signal_classify` returns a deterministic level from the shared scorer — not an LLM guess. Wiring it as a tool call rather than embedding the logic in a prompt keeps that guarantee intact.
- **Write governance.** `remember_safe_fact` and `conversation_state_update` carry `side_effect: write` and must pass through the dispatcher's constitutional check and idempotency gate. A `prompt_only` skill cannot provide that guarantee; a `tool_mediated` call does.

Per-skill rationale for the five conversions:

| Skill | Why upgraded to v2 `tool_mediated` |
|---|---|
| `safe_conversation` | Adds `risk_signal_classify` so every turn gets a deterministic risk score, not just escalation turns. Adds `read_turn_context` + `recall_memory` for auditable context attribution. |
| `retrieve_context` | Makes context reads structurally explicit so the runtime can log which source returned what — critical for the audit trail (invariant #4). |
| `handoff_to_owner` | Composes a structured summary before escalating (`conversation_summary_compose`) so the owner receives typed context, not a raw text dump. `audit_decision` records the escalation rationale. |
| `remember_safe_fact` | Pairs the write with an `audit_decision` call so every memory write is traceable. A `prompt_only` skill cannot enforce that pairing. |
| `audit_decision` | Enforces that the `audit_decision` tool is always called (the runtime guarantees the tool is invoked, not assumed by a prompt instruction). |

### 4.2 Why three skills stay `prompt_only`

| Skill | Rationale |
|---|---|
| `ask_clarification` | Composes a clarification question from the already-present turn input. No runtime context mutation, no memory write — the output is a natural-language question. Introducing tool wiring would add latency with no governance benefit. |
| `request_confirmation` | The `request_confirmation` tool is itself a pure speech act (no side effects). The skill is purely compositional — it shapes the request message. The tool is listed in `allowed_tools` so the LLM can call it, but there is nothing to enforce at the framework level. |
| `explain_limitation` | Pure language composition from already-known context; no runtime writes, no state mutations, no risk scoring needed. The `explain_limitation` tool is listed so the LLM can invoke it explicitly, but `prompt_only` is sufficient. |

> **Rule of thumb:** a skill is `prompt_only` when the output is a pure speech act (no side effects, no memory writes, no governance check needed) and all context required is already present in the prompt. When any of those conditions fails — a write, a deterministic computation, or a required audit pairing — use `tool_mediated`.

## 5. Privacy handling — why `respect_privacy` is not a separate skill

`respect_privacy` was considered as a dedicated baseline skill. It was not seeded because privacy is a cross-cutting concern, not an isolated flow. Three existing skills already cover it by composition:

| Privacy concern | Covered by | Mechanism |
|---|---|---|
| Reads are context-scoped and never cross-tenant | `safe_conversation`, `retrieve_context` | `read_turn_context` and `recall_memory` are ALS-scoped; the tools reject requests outside the caller's conversa/tenant. |
| Out-of-scope requests are refused honestly | `explain_limitation` | Pure speech act; explicitly framed as an honest "I can't do that (yet)". |
| Privacy-relevant decisions are traceable | `audit_decision`, `remember_safe_fact` (v2), `handoff_to_owner` (v2) | Every write or escalation decision pairs with `audit_decision`. |
| High-risk turns (e.g., sensitive data request) trigger escalation | `safe_conversation` → `escalate_on_risk` | `risk_signal_classify` runs on every `safe_conversation` turn; if risk is HIGH or CRITICAL, `escalate_on_risk` routes to `handoff_to_owner`. |

Adding a `respect_privacy` skill on top of these would duplicate enforcement paths, fragment the skill selector's responsibility, and create a false sense that privacy is handled in one place rather than by structural composition. The correct governance axis for data sensitivity remains `SkillUsagePolicy.data_scope` ([#409](https://github.com/diogenesmendes01/Maia-v2/issues/409)) and `constitutionalCheck` (`src/governance/rules.ts:14`).

## 6. Migration and related issues

**Forward migration:** `migrations/080_baseline_skills_v2.sql`

- Step 1: DEPRECATEs v1 `prompt_only` rows for the 5 converted skills (satisfies the one-active invariant `idx_skills_one_active_uq` before the INSERT).
- Step 2: INSERTs v2 `tool_mediated` rows for the 5 converted skills and v1 `tool_mediated` rows for the 3 new skills.
- Step 3: Backfills a permissive `usage_policy` for all 8 new/upgraded rows (mirrors migration 077's backfill; idempotent via `usage_policy IS NULL` guard).
- Fully idempotent: the UPDATE is guarded by `AND status = 'active'`; the INSERT uses `ON CONFLICT DO NOTHING` on `idx_skills_version_uq`. The one-active constraint `idx_skills_one_active_uq` is a **partial** unique index (`WHERE status = 'active'`), so deprecated v1 rows coexist safely alongside active v2 rows.

**Rollback migration:** `migrations/080_baseline_skills_v2_down.sql` — deletes v2/new-v1 rows first, then re-activates the v1 `prompt_only` rows. Applied manually via `psql -f` per `docs/runbooks/migrations.md`.

**Related issues:**

- [#433](https://github.com/diogenesmendes01/Maia-v2/issues/433) — added `risk_signal_classify`, `conversation_summary_compose`, `conversation_state_update` to `BASELINE_CORE_PACK`
- [#448](https://github.com/diogenesmendes01/Maia-v2/issues/448) — migration 080: baseline skills v2 (this doc's tracking issue)
- [#410](https://github.com/diogenesmendes01/Maia-v2/issues/410) — original baseline contract; §4.1 of [`capability-taxonomy.md`](capability-taxonomy.md) is the upstream of this doc
- [#409](https://github.com/diogenesmendes01/Maia-v2/issues/409) — `SkillUsagePolicy` fields, the data-scope governance axis referenced in §5

**See also:** [`capability-taxonomy.md`](capability-taxonomy.md) §4.1 for the tool-capability audit that established the 10-tool pack; [`action-layer.md`](action-layer.md) §5 for the dispatcher's execution guarantee that makes `tool_mediated` enforcement meaningful.

---

| | |
|---|---|
| Last verified | 2026-06-08 |
| Against `main` HEAD | `30733a7b` |
| Re-verify when | Older than 30 days; OR migration 080 is rolled back; OR #433 / #448 / #409 changes the tool pack or usage policy; OR `src/tools/grant-math.ts` (`BASELINE_CORE_PACK`) is modified; OR a new baseline skill is proposed. |
