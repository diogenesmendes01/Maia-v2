# Spec — F1: Decision-Engine-driven Skill Execution (v2)

Status: **draft / proposed** · v2 incorporates the Codex review of v1 (#214). Surface: backend runtime (`maia-app`). Risk: **HIGH** (live agent hot path + Decision Engine routing).

Goal: make the live agent turn **execute a selected skill via `runSkill`**, using the Decision Engine to select it, WITHOUT (a) breaking free-form chat, (b) hijacking unrelated turns, (c) executing the wrong skill, (d) double-acting on side effects, or (e) regressing outbound safety.

---

## 0. The crux — F1 is SIX design requirements, not one

The Codex review of v1 confirmed F1 is bigger than "wire a call site." All of these must hold:

1. **Coexistence** — `ActionDecider`: no skill selected ⇒ `respond` (normal LLM), NOT `ask_clarification`. (Else the engine breaks free-form chat = the incident.)
2. **Selector intent-matching** — the prod `SkillSelector` must actually match the message to a skill (`when_to_use` + threshold). Today it ranks ALL active skills by category/priority and returns one regardless of intent — so with any active skill, EVERY turn gets a `selected_skill_id` and the coexistence fix doesn't protect chat (a skill IS selected — the wrong one). **This is a hard prerequisite.**
3. **Immutable identity** — carry `selected_skill_id` + `version` + routed `agent_id` (not just descriptor) end-to-end, and assert the active row still matches before executing. (Else an activate/rollback race or routed-agent mismatch executes a *different* skill than the engine evaluated.)
4. **Execution-mode gating** — Phase 1 executes ONLY `execution_mode ∈ {prompt_only, evaluator}` (terminal, no side effects). Gate by `execution_mode`, NOT `category` (they're independent — a `decide`-category skill can be `tool_mediated`/`procedure_adapter` and start state). Fall-through to ReAct is allowed ONLY for pre-side-effect failures.
5. **Output safety** — route skill replies through `dispatchOutput` (view-once for sensitive, audit, pending-question, media handling), NEVER raw `sendOutbound`.
6. **Terminal-path invariants** — the skill-terminal branch must `conversasRepo.touch(c.id)` + `markAllProcessed` + `clearDebounceState`, like every other terminal path.

---

## 1. Contracts (verified + corrected)

- `DecisionPacket.routing` (`context-packet/types.ts:134-139`): `selected_skill_id?` + `candidate_skill_ids` — **id only**.
- The DE `Skill` type (`runtime/decision/types.ts`) + its prod adapter (`prod-env.ts`) keep only the DB `id` and **discard `skill_descriptor`/`version`** → v1's "carry the descriptor from `selected_skill`, no DB hit" is **impossible as written** (Codex P2). Fix: extend the DE `Skill` type + adapter mapping to include `skill_descriptor`, `version`, `agent_id`; thread them onto `DecisionPacket.routing` (`selected_skill_id`, `selected_skill_descriptor`, `selected_skill_version`).
- `runSkill(input: SkillExecutionInput)` (`skills/types.ts:26-49`) resolves the active skill **by descriptor under the current-context agent** → race risk (Codex HIGH-1). Fix: the call site (or a new `runSkillPinned`) must verify the freshly-resolved active row's `id` + `version` equal the packet's pinned values BEFORE execution; mismatch ⇒ treat as `skill_not_found` (safe fall-through), never execute a divergent row.
- `SkillExecutionOutput` (`skills/types.ts:73-81`): `{ ok, output?, reason?, message?, ... }` — structured, no sensitivity/dispatch metadata. The reply path must adapt it to `dispatchOutput`'s contract (see §4.4).
- `execution_mode` (prompt_only/procedure_adapter/tool_mediated/evaluator) is distinct from `category`. Phase 1 gates on `execution_mode`.

---

## 2. Change 1 — ActionDecider coexistence (the unblocker)

`src/runtime/decision/action-decider.ts:94-108`: restructure so **`!selected_skill_id` ⇒ `respond`** (`skill: null` context; `buildContextRequirements` accepts null). Remove the low-intent-confidence auto-`ask_clarification` for v1 (it also degrades free-form). `ask_clarification` reserved for explicit future use. Test: engine ON + no selected skill ⇒ `respond` (LLM answers), not `ask_clarification`.

---

## 3. Change 2 — SkillSelector intent matching (HARD PREREQUISITE, Codex P1)

`src/runtime/decision/skill-selector.ts` + the prod adapter currently rank active skills by category/priority with **no intent/`when_to_use` evaluation**. Fix: a skill is selected ONLY when the message matches its `when_to_use` above a confidence threshold (deterministic match and/or a cheap classifier). When nothing matches ⇒ no `selected_skill_id` ⇒ Change 1 makes it a normal `respond`.

**Until this lands, Phase 1 MUST be isolated to a synthetic/canary tenant** — enabling the engine with an active skill in a real tenant would route every turn into that skill. This is the single most dangerous rollout footgun.

---

## 4. Change 3 — Skill execution wiring (corrected)

### 4.1 Routing — `execute_skill`, gated by execution_mode
- New `action_mode='execute_skill'`, emitted by `ActionDecider` ONLY when a skill is selected (post-match, §3) AND `skill.execution_mode ∈ {prompt_only, evaluator}`. Other execution_modes ⇒ `respond` (skill as context; not executed in Phase 1). Carry `selected_skill_id` + `selected_skill_version` + `selected_skill_descriptor` on the packet.

### 4.2 Call site (`src/agent/core.ts`, engine result block ~803-885)
On `action_mode==='execute_skill'`:
1. **Assert identity**: re-resolve active by descriptor (under routed agent); if its `id`/`version` ≠ packet's pinned values ⇒ skip execution, fall through to normal turn (log `skill.identity_mismatch`).
2. `runSkill({ skill_descriptor, input: buildSkillInput(...), conversa_id, turno_id, triggered_by:'user_message', agent_id: routedAgent, signal })`.
3. **On `result.ok`** ⇒ `dispatchOutput(buildSkillReply(result), ...)` (§4.4) ⇒ `conversasRepo.touch(c.id)` ⇒ `markAllProcessed` ⇒ `clearDebounceState` ⇒ `return`.
4. **On `!result.ok`** ⇒ fall through to the normal LLM/ReAct turn ONLY when `reason ∈ {flag_off, skill_not_found, unresolved_policy, policy_blocked, hard_limit_block, invalid_input, invalid_output, agent_scope_violation}` (all pre-output, and — for prompt_only/evaluator — pre-side-effect). For any other/ambiguous reason, send a safe generic reply rather than risk a double-action. (prompt_only/evaluator have no side effects, so this is safe by construction; the restriction matters once Phase 2 adds side-effecting modes.)

### 4.3 Input (`buildSkillInput`)
v1: `{ message: <aggregated inbound text>, pessoa_id, conversa_id }`; validated by the skill's `input_schema` (Gate 3).

### 4.4 Output via `dispatchOutput` (Codex HIGH-3)
- `buildSkillReply(result)` maps `result.output` to `dispatchOutput`'s input. Convention: `output.reply: string` is the user text. Crucially, route through `dispatchOutput` (NOT `sendOutbound`) so view-once/sensitive handling, outbound audit, pending-question metadata and media paths are preserved.
- Sensitivity: a skill flagged sensitive (or producing balance-like output) must carry that through so `dispatchOutput` applies view-once. If `output.reply` is absent ⇒ do NOT fabricate text; fall through to the normal turn.

---

## 5. Change 4 — tool-dispatcher bridge (Phase 2 — tool_mediated)
Deferred. `tool_mediated` needs `setToolDispatcher` (never wired) + a `ToolContext{pessoa,scope,conversa,mensagem_id}` threaded into `ModeContext`, plus a `side_effects_started`/terminality contract so failures can't double-act. Phase 1 excludes it via §4.1's execution_mode gate.

---

## 6. Flags + activation order
1. Land **Change 1 (coexistence)** + **Change 2 (selector matching)** first. Until both ship, do NOT enable the engine with active skills in a real tenant.
2. Seed ≥1 `active` skill: `execution_mode='prompt_only'`, a real `when_to_use`, empty `policy_descriptors`, `output_schema` with `reply`. (Initially in a **canary tenant**.)
3. `FEATURE_SKILL_REGISTRY_V1=true`.
4. `FEATURE_DECISION_ENGINE_V1=true` + `FEATURE_DECISION_ENGINE_ERROR_FALLBACK='legacy'` (engine errors degrade to normal turn).
5. `FEATURE_POLICY_RESOLVER_V1=true` only before any skill declares `policy_descriptors`.
6. Kill switch `FEATURE_DECISION_ENGINE_V1_KILL_SWITCH=true` = instant abort. NOTE: engine flag is **global** (per-tenant canary not wired, `integration.ts:195`) — rely on synthetic-tenant validation + the kill switch.

---

## 7. Fail-close / safety vectors
| Vector | Mitigation |
|---|---|
| no-skill ⇒ ask_clarification | Change 1 |
| **selector hijacks every turn** | Change 2 (intent match) + canary isolation |
| **wrong-skill race** | §1/§4.2 immutable id+version assert |
| **side-effect double-action** | §4.1 execution_mode gate + §4.2 safe-fallthrough reasons |
| **sensitive leak / missing audit** | §4.4 dispatchOutput |
| budget fallback ⇒ ask_clarification | `ERROR_FALLBACK='legacy'`; monitor `decision_engine.budget_fallback` |
| non-UUID channel_id | already guarded (`prod-env.ts:507-513`) |

---

## 8. Testing
- ActionDecider: no-skill ⇒ respond; matched prompt_only/evaluator skill ⇒ execute_skill w/ id+version+descriptor on packet; side-effecting execution_mode ⇒ NOT execute_skill.
- SkillSelector: non-matching message ⇒ no selection; matching ⇒ selection. (Regression against hijack.)
- Call site: identity mismatch ⇒ fall through (no execution); ok ⇒ dispatchOutput + touch + return; !ok pre-side-effect ⇒ fall through.
- Output: sensitive skill output ⇒ view-once applied via dispatchOutput; outbound audit present.
- Full `npx vitest run` green (the #209 lesson).
- Manual: synthetic tenant first; kill switch as abort.

---

## 9. Phases
- **Phase 0 — Safe-to-enable:** Change 1 (coexistence) + Change 2 (selector intent matching) + regression tests. After this, the engine can be on without breaking or hijacking chat (still no skill execution).
- **Phase 1 — prompt_only/evaluator execution:** Change 3 (execute_skill gated by execution_mode + immutable identity + dispatchOutput + touch) + seed a matching prompt_only skill in a canary tenant. End-to-end: a matching message runs a skill safely.
- **Phase 2 — tool_mediated:** the dispatcher bridge + side-effect/terminality contract.

---

## 10. Risks
Highest blast radius in the system (every WhatsApp turn + the engine). Adds a Haiku intent `callLLM`/turn once on. Global engine flag (no per-tenant canary). A wrong ActionDecider/selector change re-introduces the incident or hijacks chat — Phase 0 tests + kill switch are the guards.

## 11. Acceptance criteria
- [ ] Engine ON + non-matching message ⇒ normal LLM answer (no clarification loop, no skill hijack).
- [ ] A matched `active` prompt_only skill executes via `runSkill`; reply delivered through `dispatchOutput` (audit + sensitivity preserved); conversa touched.
- [ ] Activate/rollback race cannot execute a divergent skill (id+version assert).
- [ ] No side-effecting execution_mode runs in Phase 1.
- [ ] Skill failure degrades to a normal turn (no dead/"indisponível"/duplicate-action turn).
- [ ] Kill switch reverts instantly. Full unit suite green.

## Appendix — files
| Concern | File |
|---|---|
| Coexistence + execute_skill + execution_mode gate | `src/runtime/decision/action-decider.ts` |
| Selector intent matching | `src/runtime/decision/skill-selector.ts` (+ prod adapter `prod-env.ts`) |
| DE `Skill` type carries id+version+descriptor | `src/runtime/decision/types.ts` + `prod-env.ts` adapter |
| `ActionMode` + packet pinned identity | `src/runtime/context-packet/types.ts` |
| Call site + identity assert + buildSkillInput/Reply + dispatchOutput + touch | `src/agent/core.ts` (~803-918) |
| Output pipeline (reuse) | `dispatchOutput` (agent/react-loop.ts / output dispatch) |
| SkillRunner (unchanged) | `src/skills/skill-runner.ts`, `src/skills/modes/*` |
| Dispatcher bridge (Phase 2) | `src/skills/modes/tool-mediated.ts`, `src/tools/_dispatcher.ts` |
| Flags | `src/config/env.ts`, `feature-flags.ts`, `runtime/decision/integration.ts` |
