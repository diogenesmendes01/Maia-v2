# Spec — F1: Decision-Engine-driven Skill Execution

Status: **draft / proposed** · Surface: backend runtime (`maia-app`) · Risk: **HIGH** (modifies the live agent hot path + the Decision Engine's routing). Read with the investigation report in mind.

Goal: make the live agent turn actually **execute a selected skill via `runSkill`**, using the Decision Engine to select it — the "official" architecture — WITHOUT breaking normal free-form conversation.

---

## 0. The crux (read first)

Today, with `FEATURE_DECISION_ENGINE_V1` ON:
- The engine pipeline runs `SkillSelector` → `ActionDecider`.
- `action-decider.ts:94-108`: if **no skill is selected** (`!selected_skill_id`) → `action_mode='ask_clarification'` → `core.ts:850-859` sends the canned *"Pode me dar mais detalhes?"* and **skips the LLM**.
- Result: every free-form turn that doesn't map to an active skill stops answering normally. **This is the incident.**

Also: the engine path **never calls `runSkill`** — `action_mode='call_tool'` (for `category ∈ {tool_mediated, decide}`) only constrains the ReAct tool set; `action_mode='respond'` only feeds the skill in as prompt context. So "the engine uses skills" today means *metadata-shaping*, not *execution*.

**Therefore F1 = three changes, in this order of importance:**
1. **Coexistence fix** — `ActionDecider`: no-skill ⇒ `respond` (normal LLM turn), not `ask_clarification`. (Without this, the engine breaks free-form chat the moment it's on.)
2. **Execution wiring** — a real path that turns a selected skill into a `runSkill(...)` call and routes its output to the user.
3. **The plumbing** — id→descriptor mapping, input building, output→reply, and (for `tool_mediated` execution) the tool-dispatcher/`ModeContext` bridge.

---

## 1. Scope & contracts (verified)

- `DecisionPacket.routing` (`context-packet/types.ts:134-139`) exposes `selected_skill_id?` + `candidate_skill_ids` — **id only, no descriptor**. `runSkill` keys off `skill_descriptor` (`skills/types.ts:27`) → a translation is required.
- `runSkill(input: SkillExecutionInput)` (`skills/types.ts:26-49`): `{ skill_descriptor, input, conversa_id?, turno_id?, triggered_by, agent_id?, signal? }`; runs inside `runWithTenantContext`; Gate 1 = `FEATURE_SKILL_REGISTRY_V1`.
- `SkillExecutionOutput` (`skills/types.ts:73-81`): `{ ok, output?: Record<string,unknown>, reason?, message?, latency_ms, ... }` — **structured output, not user text**. The call site must turn `output` into a reply.
- `execution_mode` (how `runSkill` runs: prompt_only/procedure_adapter/tool_mediated/evaluator) is **distinct** from `category` (what the action-decider routes on: classify/extract/compose/decide/tool_mediated/diagnose/plan/evaluator). We exploit this: a skill can have `category='decide'` (→ engine emits `call_tool`) AND `execution_mode='prompt_only'` (→ `runSkill` needs no tool dispatcher). **Phase 1 uses exactly that combo to avoid the bridge.**

---

## 2. Change 1 — ActionDecider coexistence fix (the unblocker)

File: `src/runtime/decision/action-decider.ts:94-108`.

- Restructure rule 3 so **`!selected_skill_id` ⇒ `respond`** with `skill: null` context (the normal free-form turn; `buildContextRequirements` already accepts `skill: null`, see line 84). 
- Keep `ask_clarification` ONLY for a deliberately narrow case — recommend: **remove the low-intent-confidence auto-clarify for v1** (it also degrades free-form chat), or gate it behind an explicit "clarify-eligible intent" signal. Default v1: no-skill and/or low-confidence ⇒ `respond`. `ask_clarification` reserved for future explicit use.
- Net effect: the engine, when on, is **transparent** for turns with no matching skill — it behaves like today's legacy path (normal LLM/ReAct), and only diverges when a skill IS selected.
- Tests: engine ON + no active skill ⇒ `respond` (LLM answers normally), NOT `ask_clarification`. This is the regression guard against the incident.

---

## 3. Change 2 — Skill execution wiring

### 3.1 Routing: a dedicated `execute_skill` action
- Add `action_mode='execute_skill'` (new `ActionMode`) emitted by `ActionDecider` when a skill is selected AND we intend to run it via the SkillRunner (rather than merely shape the prompt).
- v1 policy: emit `execute_skill` for selected skills whose `category ∈ {tool_mediated, decide}` (the same set that today maps to `call_tool`). For other categories keep `respond` (skill as context). Carry the resolved `selected_skill_descriptor` on the packet (see 3.2).
- Rationale for a new mode (vs overloading `call_tool`): keeps "constrain the ReAct tool set" (`call_tool`) distinct from "run the SkillRunner" (`execute_skill`); avoids ambiguity in `core.ts`.

### 3.2 id→descriptor on the packet
- Extend `DecisionPacket.routing` with `selected_skill_descriptor?: string`, populated by the engine from the `SkillSelector`'s already-resolved `selected_skill` object (no extra DB hit). `core.ts` reads the descriptor directly (no id→descriptor refetch).

### 3.3 The call site (`core.ts`, in the engine result block ~803-885)
- After `runDecisionEngineForTurn`, add a branch: `if (action_mode === 'execute_skill' && routing.selected_skill_descriptor)`:
  1. Build `SkillExecutionInput`: `{ skill_descriptor, input: buildSkillInput(inbound, scope, conversa), conversa_id: c.id, turno_id, triggered_by: 'user_message', signal }`.
  2. `const result = await runSkill(input)` (already inside `runWithTenantContext`).
  3. **On `result.ok`** → route output to reply (3.4) → `markAllProcessed` → `clearDebounceState` → `return` (skip the normal LLM/ReAct turn).
  4. **On `!result.ok`** → **fall through to the normal LLM/ReAct turn** (do NOT fail-closed). Log `skill.execution_failed{reason}`. This is critical: a skill failure must degrade to a normal answer, never a dead turn.
- For `respond` / `call_tool` / `continue_workflow` → unchanged (existing behavior; `call_tool` keeps applying `blocked_tools`, and — optional Phase 2 — start honoring `allowed_tools`).

### 3.4 Output → reply (`buildSkillReply`)
- Convention: skills used on this path declare an `output_schema` with a user-facing text field — recommend `output.reply: string`. The call site sends `result.output.reply` via `sendOutbound(...)`.
- If `output.reply` is absent (structured-only skill), v1 fallback: do NOT invent text — fall through to the normal LLM turn (treat as non-terminal). (Phase 2 may feed `output` back into the LLM to phrase a reply.)

### 3.5 Input building (`buildSkillInput`)
- v1: `{ message: <aggregated inbound text>, pessoa_id, conversa_id }`. Skills validate via their `input_schema` (Gate 3; empty schema = permissive). Keep minimal; richer context is a later iteration.

---

## 4. Change 3 — the tool-dispatcher bridge (DEFERRED to Phase 2)

`tool_mediated` `execution_mode` needs `setToolDispatcher(...)` (never called in prod) AND a `ToolContext { pessoa, scope, conversa, mensagem_id }` that `ModeContext` lacks. Phase 1 avoids this entirely by using `execution_mode='prompt_only'` (or `evaluator`). Phase 2 wiring:
- Plumb the turn's `ToolContext` into `runSkill` (extend `SkillExecutionInput` with an optional `toolContext`, threaded to `ModeContext`).
- Implement + `setToolDispatcher` an adapter mapping the skill `ToolDispatcher (name,args,{signal,idempotency_key})` → `dispatchTool({tool,args,ctx})` using that `ToolContext`.
- Re-assert `allowed_tools` (already enforced inside `tool-mediated.ts`).

---

## 5. Flags, activation order, rollout

1. **Seed ≥1 `active` skill** (status MUST be `active`, not `proposed`) under tenant `default` (or the routed agent), `execution_mode='prompt_only'`, `category='decide'`, **empty `policy_descriptors`** (avoid Gate-4 fail-close), `output_schema` with `reply`.
2. **`FEATURE_SKILL_REGISTRY_V1=true`** (maia-app) — Gate 1.
3. **`FEATURE_DECISION_ENGINE_V1=true`** — only AFTER Change 1 (coexistence) is merged + deployed, and ≥1 active skill exists. Set **`FEATURE_DECISION_ENGINE_ERROR_FALLBACK='legacy'`** during rollout so engine errors degrade to the normal turn instead of "Sistema indisponível".
4. **`FEATURE_POLICY_RESOLVER_V1=true`** only before any skill declares `policy_descriptors`.
5. Kill switch: `FEATURE_DECISION_ENGINE_V1_KILL_SWITCH=true` disables the engine instantly (no redeploy).
6. **Per-tenant canary is NOT wired** in the hot path (`integration.ts:195` reads the global flag; `decision-engine-flag.ts:42-52` override repo is a TODO). So enabling the engine is **global**. Mitigate by validating on a staging instance / synthetic turns first.

---

## 6. The 3 fail-close vectors (and how this spec neutralizes them)

| Vector | Mechanism | Mitigation in this spec |
|---|---|---|
| **no-skill ⇒ ask_clarification** | `action-decider.ts:96` | Change 1 (no-skill ⇒ respond). The core fix. |
| **budget fallback** | 400ms budget; Haiku intent `callLLM` slow ⇒ `ask_clarification`/`escalate` (`decision-engine.ts:388-415`) | `ERROR_FALLBACK='legacy'` during rollout; monitor `decision_engine.budget_fallback`; consider raising the budget. With Change 1, the fallback's `ask_clarification` is also less harmful, but legacy-degrade is safest. |
| **non-UUID channel_id** | `'default'` vs `uuid` column | Already guarded (`prod-env.ts:507-513`, PR #207). Confirm the guard stays. |

---

## 7. Testing (without breaking live Maia)

- **Unit (ActionDecider):** no-skill ⇒ `respond`; selected `decide`/`tool_mediated` skill ⇒ `execute_skill` with descriptor on the packet.
- **Unit (core call site):** mock `runSkill`; `execute_skill` + ok ⇒ `sendOutbound(output.reply)` + turn ends; `!ok` ⇒ falls through to the normal turn (assert ReAct still runs).
- **Integration:** engine ON + 0 active skills ⇒ a normal question gets a normal LLM answer (the incident regression guard). engine ON + 1 active prompt_only skill whose `when_to_use` matches ⇒ `runSkill` executes + its `reply` is sent.
- **Full suite** (`npx vitest run`) must stay green (the #209 lesson).
- **Manual:** staging/synthetic turns first; flip the kill switch as the abort.

---

## 8. Delivery phases (each = its own PR)

- **Phase 0 — Coexistence:** Change 1 (ActionDecider no-skill ⇒ respond) + the regression test. Deploy. Then it's safe to turn the engine on without breaking chat. (Engine still doesn't execute skills — but stops being a footgun.)
- **Phase 1 — prompt_only execution:** `execute_skill` mode + `selected_skill_descriptor` on the packet + the `core.ts` call site + `buildSkillInput`/`buildSkillReply` + seed one `prompt_only`/`decide` active skill. Engine on (global, with legacy fallback). End-to-end: a matching message runs a skill.
- **Phase 2 — tool_mediated execution:** the dispatcher bridge (§4) + `allowed_tools` enforcement on the hot path.
- **Phase 3 (optional):** richer input/output (feed structured output back to the LLM), per-tenant canary for the engine flag, multi-channel agent scoping.

---

## 9. Risks
- Touches the live hot path of every WhatsApp message + the Decision Engine — the highest-blast-radius area in the system.
- The engine adds a Haiku `callLLM` (intent) to every turn (latency + cost) once on.
- Global engine flag (no canary) until the override repo is built.
- A wrong `ActionDecider` change re-introduces the incident — Phase 0's regression test is the guard; the kill switch is the abort.

## 10. Acceptance criteria
- [ ] Engine ON + no matching skill ⇒ normal LLM answer (no "Pode me dar mais detalhes" loop).
- [ ] A seeded `active` `prompt_only` skill executes via `runSkill` on a matching turn; its `reply` reaches the user.
- [ ] A skill failure (`!ok`) degrades to a normal turn, never a dead/"indisponível" turn.
- [ ] Kill switch instantly reverts to legacy behavior.
- [ ] Full unit suite green.

## Appendix — files
| Concern | File |
|---|---|
| ActionDecider fix + `execute_skill` | `src/runtime/decision/action-decider.ts` |
| `ActionMode` + packet `selected_skill_descriptor` | `src/runtime/context-packet/types.ts` |
| Engine populates descriptor | `src/runtime/decision/decision-engine.ts` (skill step) |
| Call site + buildSkillInput/Reply | `src/agent/core.ts` (~803-918) |
| SkillRunner (unchanged) | `src/skills/skill-runner.ts`, `src/skills/modes/*` |
| Dispatcher bridge (Phase 2) | `src/skills/modes/tool-mediated.ts` (`setToolDispatcher`), `src/tools/_dispatcher.ts` |
| Flags | `src/config/env.ts`, `src/config/feature-flags.ts`, `src/runtime/decision/integration.ts` |
