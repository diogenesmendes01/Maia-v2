# Spec 00 — Overview & Conventions

**Status:** Foundation • **Phase:** All • **Last reviewed:** 2026-04-28

This document is the entry point for all Maia specifications. Read this first.

---

## 1. Project mission

Maia is a **single-tenant** AI agent that manages personal finances and small-business cash flow exclusively through WhatsApp. The single human owner (Mendes) has 1 personal entity (PF) and up to 8 legal entities (PJ). Several other people interact with Maia (spouse, accountants, employees) but **all data ultimately belongs to the owner**.

This is **not** a multi-tenant SaaS. There is exactly one owner. Architectural simplicity follows from this constraint.

---

## 2. Founding principle — *LLM Proposes, Backend Disposes*

This principle precedes the nine pattern pillars. It is the contract that makes every other guarantee credible.

> The LLM (Claude or any fallback) is strictly an **interpretation layer**. Every decision with side effects is taken by the **backend**, against persistent state, typed validation, and constitutional rules.

Operational consequence:

```
1. LLM emits an INTENT (typed, Zod-validated structured output).
2. Backend validates the intent against state (permissions, limits, mode).
3. Backend executes the action — or denies it.
4. LLM only formats the natural-language response back to the user
   from the result the backend produced.
```

The LLM never:

- writes to the database directly
- decides whether an action is allowed
- chooses between users, entities, or accounts that the user did not explicitly select
- promotes itself to higher confidence than the backend permits

Every spec in this folder includes a **LLM Boundaries** section that makes this explicit for that domain.

This principle is also what makes the system **auditable** in a financial context: "the model decided" is never a defensible audit trail; "the rule in `governance/rules.ts:42` was applied to typed payload `X`" is.

---

## 3. Agent design pattern stack

Maia is best described as:

> **Stateful ReAct + Plan-and-Execute Agent with Constitutional Governance and Reflexion**

| # | Pattern | Where it lives | Purpose |
|---|---------|----------------|---------|
| 1 | **ReAct** (atomic turns) | `agent/core.ts` | One-tool, fast turns (~80% of messages) |
| 2 | **Plan-and-Execute** (multi-step) | `workflows/` | Tasks that span multiple tools, parties, or days |
| 3 | **Tool Use / Function Calling** | `tools/_registry.ts` | The agent's only path to side effects |
| 4 | **Reflexion** | `agent/reflection.ts` + nightly worker | Learns from corrections, workflow outcomes, and aggregate patterns |
| 5 | **Memory-augmented agent (5 layers)** | `memory/` | Working, episodic, semantic, procedural, vector |
| 6 | **Hierarchical Task Decomposition + Per-Entity States** | `workflows/` + `entity_states` table | Multi-step tasks with persistent operational state per entity |
| 7 | **Theory of Mind / Interlocutor Modeling** | `pessoas.modelo_mental` | Tone, scope, and limits adapt per speaker |
| 8 | **Constitutional AI / Rule-Based Governance** | `governance/rules.ts` | Hard limits the LLM cannot bypass |
| 9 | **Persistent Identity / Self-State** | `self_state` table | Stable identity despite stateless LLM |
| 10 | **Proactive / Triggered Agent** | `workers/` (cron + event-driven) | Acts without being prompted |

Patterns explicitly **not** used and why:

| Pattern | Why not |
|---------|---------|
| Multi-Agent / Crew | Adds latency and complexity without measurable benefit at this scale |
| Tree of Thoughts / MCTS | Decisions are linear, not search-based |
| Actor-Critic (separate critic LLM) | Reflexion + Constitutional cover this without 2x LLM cost |
| Plain RAG | Replaced by structured 5-layer memory |

---

## 4. Spec format

Every spec in `docs/specs/` follows this skeleton:

```
1. Status / Phase / Last reviewed
2. Purpose (one paragraph)
3. Goals
4. Non-goals
5. Architecture / Design
6. LLM Boundaries (what the LLM does and does not do here)
7. Schemas & Contracts (Zod / SQL / TypeScript)
8. Behavior & Rules
9. Error cases & Failure modes
10. Acceptance criteria
11. Open questions (if any)
12. References (other specs)
```

Specs are **dense** by design. They are the single source of truth for implementers and reviewers. When a spec disagrees with code, the spec is wrong — open a PR to update it.

---

## 5. Phases

| Phase | Scope | Specs in scope |
|-------|-------|----------------|
| **0** | Inventory (parallel, no code) | None |
| **1** | MVP — agent + 5 tools + basic memory | 00–09, 16, 17 |
| **2** | Multimedia + active spouse | 10, plus updates to 06, 08 |
| **3** | Ecosystem — accountants & employees | Updates to 03, 09, 12 |
| **4** | OFX import + proactive briefings | 12, 13 |
| **5** | Analytical intelligence + dashboard | 15, plus expansions |

A spec is **frozen** for a phase only when the phase is shipped. Until then, it is editable as a living document.

---

## 6. Non-negotiable principles

These cannot be violated by any spec, code, or prompt.

1. **Strict separation between entities.** Every query and tool call carries `entidade_id`. Cross-entity access requires explicit consolidation logic, never implicit joins.
2. **Explicit permissions.** No interlocutor sees data outside their authorized scope, ever. There is no "default open" anywhere.
3. **Audit everything.** Every action with effect writes to `audit_log` with actor, target, diff, and timestamp.
4. **Confirm before acting on relevant operations.** Limits per person; dual approval (4-eyes) for critical actions; never autonomous on real money movement.
5. **Learn from corrections.** Every user correction must produce a probationary `learned_rule`.
6. **LLM proposes, backend disposes.** See §2.
7. **Single-tenant explicit.** No tenant abstraction. Adding one later requires explicit migration and review.
8. **Brazilian-first.** Currency, dates, holidays, tax rules follow Brazilian standards. International support is out of scope.

---

## 7. Glossary

| Term | Definition |
|------|------------|
| **Owner** | The single human who owns the deployment. Type `dono` in `pessoas`. |
| **Co-owner** | Trusted second human (spouse). Type `co_dono`. |
| **Entity** (`entidade`) | A financial entity: PF (personal) or one of the PJs (legal entities). |
| **Person** (`pessoa`) | Any human who interacts with Maia via WhatsApp. |
| **Permission** | A `(pessoa_id, entidade_id, profile)` triple granting capabilities. |
| **Profile** | A predefined, closed set of `acoes_permitidas`. The LLM picks a profile, never composes free actions. |
| **Intent** | A structured, typed proposal emitted by the LLM, validated by Zod before backend execution. |
| **4-eyes / Dual Approval** | A workflow requiring two distinct `dono`/`co_dono` confirmations. |
| **Audit mode** | Sticky 24h dry-run mode where Maia previews every side-effect tool call. |
| **Probationary rule** | A `learned_rule` that is applied with explicit transparency until promoted. |
| **DLQ** | Dead Letter Queue — table `dead_letter_jobs` for jobs that exhausted retries. |
| **Quarantine** | First-message-from-new-pessoa state requiring owner confirmation. |

---

## 8. References

- [`README.md`](../../README.md) — runtime overview and setup
- [`docs/arquitetura.md`](../arquitetura.md) — high-level architecture (legacy doc, superseded by these specs)
- [`migrations/001_initial.sql`](../../migrations/001_initial.sql) — current schema (will be extended per spec 02)
- [`src/identity/maia-prompt.md`](../../src/identity/maia-prompt.md) — Maia's living system prompt
