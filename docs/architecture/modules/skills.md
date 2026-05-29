# skills

**Path:** `src/skills/`

**Purpose** — The execution layer for learned, versioned capabilities. A skill is a typed unit of agent behavior — definition + execution mode + success criteria. Four modes share a uniform runner (`runSkill()`): `prompt_only` (LLM call within a known frame), `evaluator` (LLM-as-judge), `tool_mediated` (orchestrates tool calls), `procedure_adapter` (drives a procedure execution). The catalog lives in `control-plane/skill-registry/`; this module is the runtime.

## Key files

| File | Role |
|---|---|
| `src/skills/skill-runner.ts` | `runSkill()` — uniform entry across modes |
| `src/skills/skill-slice-builder.ts` | Builds the skill's runtime slice from definition |
| `src/skills/cache.ts` | Skill result caching |
| `src/skills/modes/prompt-only.ts` | Mode: LLM call, no external tools |
| `src/skills/modes/evaluator.ts` | Mode: LLM-as-judge |
| `src/skills/modes/tool-mediated.ts` | Mode: skill invokes registered tools |
| `src/skills/modes/procedure-adapter.ts` | Mode: skill drives a procedure execution |
| `src/skills/index.ts` | Public surface |
| `src/skills/types.ts` | Shared types |

## Patterns it follows

- [Action layer](../concerns/action-layer.md) — `runSkill()` is the single execution entry; the runner does not branch on mode at every step
- [Tenant isolation](../concerns/tenant-isolation.md) — skill cache scoped by tenant; tool-mediated skills fail-closed on missing context
- [Governance + observability](../concerns/governance-observability.md) — every skill invocation audits

## How to extend

| Need | Where |
|---|---|
| Add a new skill mode | New file under `src/skills/modes/<mode>.ts`; register in `skill-runner.ts` |
| Add a new skill (catalog entry) | Definition persisted via `src/control-plane/skill-registry/skills-repo.ts`; admin-ui surface in `skills` router |
| Add a cache strategy | Extend `cache.ts`; respect tenant-key contract |
| Pass AbortSignal | The runner already plumbs AbortSignal to `callLLM` for `prompt_only` + `evaluator` — use it for long operations |

## Public surface

| Consumed by | What |
|---|---|
| `src/agent/execute-skill.ts` | Invokes `runSkill()` from decision-engine output |
| `src/runtime/decision/` | Decision engine selects skill, hands off to runner |
| `src/control-plane/skill-registry/` | Persistent definitions read by runner |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/skills/` | Per-mode runner contracts |
| `tests/unit/skills/skills-repo-cross-tenant.spec.ts` | Skill catalog stays tenant-scoped |
| `tests/integration/skill-execution.spec.ts` (if present) | End-to-end execution |

## In-flight changes

At last verification (2026-05-28):

- Decision-engine F1 Phase 1 — execute selected skill via runSkill (#216 — merged)
- Skills mutations + editor in admin-ui Phase 3 (#213 — merged)
- AbortSignal plumbed from SkillRunner to callLLM (#221 — merged)
- Tool-mediated fail-closed on missing tenant context (#269 — open)
- skills-repo defer summary-column deref to query time (merged)
- skills-repo cross-tenant isolation testing (#218 → #222, #278 — merged + open)

Verify: `gh pr list --state open --search "skill OR skills-repo OR runSkill"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
