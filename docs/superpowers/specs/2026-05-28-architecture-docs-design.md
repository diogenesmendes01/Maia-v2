# Architecture Documentation Suite for Maia v3 — Design

**Status:** Draft v1 — pending implementation
**Date:** 2026-05-28
**Author:** Brainstormed with @diogenesmendes01
**Replaces:** `docs/specs/00–18` (deleted in [#291](https://github.com/diogenesmendes01/Maia-v2/pull/291))
**Implements:** Documentation strategy for v3 multi-agent platform optimized for AI development agents

---

## 1. Context and motivation

PR [#291](https://github.com/diogenesmendes01/Maia-v2/pull/291) removed 21 legacy v1 specs (`docs/specs/00–18`, `docs/arquitetura.md`, `docs/inventario.md`) because they described Maia as *"single-tenant AI agent / not a multi-tenant SaaS / Multi-Agent explicitly not used"* — direct contradiction to the v3 positioning (*"Plataforma multi-agente governada via WhatsApp"*).

Removing them left a documentation gap: the codebase has **24 subsystems in `src/`**, **152 migrations**, **33 workers**, **16 tRPC routers in admin-ui**, and **~23 open PRs** (most closing tenant-isolation gaps across cache keys, Redis keys, dedup, debouncer, idempotency, etc.). No single source of truth describes the system as it actually is today.

This spec defines a **new documentation suite** rebuilt from scratch:

- Based on **observed reality** in `origin/main` source code + open PRs — not previous textual artifacts.
- Optimized for **AI development agents** (Claude Code, Codex, Gemini CLI) as the primary readers.
- Complements existing `docs/runbooks/` (operational debug + rollback) — does not replace them.

---

## 2. Goals

| # | Goal | Success criterion |
|---|---|---|
| G1 | Any agent entering the project for the first time can describe the architecture after reading 2 docs (`AGENTS.md` + `ARCHITECTURE.md`) | Agent can answer "what is Maia?" with the v3 pillars |
| G2 | Agent knows where to put a new feature without asking | "Add X" → agent identifies correct subsystem + concern doc |
| G3 | Agent knows the inviolable invariants and never violates them | Tenant isolation, fail-closed governance, audit-every-decision |
| G4 | Each cross-cutting concern lives in exactly ONE place; no duplication | `tenant-isolation.md` is the only doc that defines the invariant |
| G5 | Open in-flight work is visible without reading PR list | Each doc's "In-flight changes" section lists relevant PRs |
| G6 | Docs are verifiable against code | Every code reference uses `path/file.ts:line` format |

---

## 3. Non-goals

- **Aspirational design.** Only documents what is in code on `origin/main` + boundary of open PRs. No "we plan to" content.
- **Operational runbooks.** Already exist in `docs/runbooks/` (P0–P10b, setup, migrations). Architecture docs **link** to them, do not duplicate.
- **Tutorials / "how to use Maia".** Different audience (end-users / operators), out of scope.
- **Architecture Decision Records (ADRs).** Useful but deferred — can be added later as `docs/architecture/decisions/` without touching this suite.
- **Marketing copy.** No "powerful", "robust", "cutting-edge", "blazing fast". Density over rhetoric.
- **Per-feature implementation specs.** Those continue to live in `docs/superpowers/specs/` (dated, per-feature) — this suite is **architecture-level**.

---

## 4. Audience

**Primary:** AI development agents — Claude Code, Codex, Gemini CLI, future SDK agents.

**Secondary:** Human developers entering the project (the docs work for them too, but layout decisions optimize for agent context budgets).

**Implications of agent-primary audience:**

- Docs are read in pieces, not cover-to-cover. Cross-linking matters more than narrative flow.
- High information density wins. Tables + short prose > long paragraphs.
- Code references must be greppable + clickable: `src/memory/vector.ts:120`, never "the memory module".
- One canonical place per fact (no duplication) — agent loads minimum needed context.
- Conventions in `AGENTS.md` are enforced behavior, not suggestions.

---

## 5. Structure

```
maia/
├── AGENTS.md                              # Layer 1 — Agent operating manual (auto-loaded)
├── ARCHITECTURE.md                        # Layer 1 — Mental model + invariants (read first)
└── docs/architecture/
    ├── concerns/                          # Layer 2 — Cross-cutting (5 docs, by topic)
    │   ├── tenant-isolation.md
    │   ├── cognitive-stack.md
    │   ├── action-layer.md
    │   ├── channel-policy.md
    │   └── governance-observability.md
    └── modules/                           # Layer 3 — Per-subsystem (24 docs, by src/ subdir)
        ├── admin-ui.md
        ├── agent.md
        ├── cognition.md
        ├── cognitive-graph.md
        ├── config.md
        ├── control-plane.md
        ├── db.md
        ├── gateway.md
        ├── governance.md
        ├── identity.md
        ├── import.md
        ├── lib.md
        ├── memory.md
        ├── procedures.md
        ├── runtime.md
        ├── scheduling.md
        ├── setup.md
        ├── shared.md
        ├── skills.md
        ├── tools.md
        ├── types.md
        ├── user-layer.md
        ├── workers.md
        └── workflows.md
```

**Total: 31 documents** (2 root + 5 concerns + 24 modules).

### Loading sequence (agent context budget)

| Step | When | Doc | ~Words | ~Tokens |
|---|---|---|---|---|
| 1 | Session start (auto) | `AGENTS.md` | 600–800 | ~1k |
| 2 | Start of non-trivial task | `ARCHITECTURE.md` | 1,500–2,500 | ~3k |
| 3 | Task touches a concern | `concerns/<topic>.md` | 1,500–2,500 each | ~3k each |
| 4 | Editing files in subdir | `modules/<subsystem>.md` | 400–700 each | ~800 each |
| 5 | Always | Source code | (varies) | SSoT |

**Total worst-case load for a complex task:** ~10k tokens of docs before reading code. Acceptable for tasks that justify the depth; trivial tasks skip steps 3–4.

---

## 6. Per-doc spec

### 6.1 `AGENTS.md` (root)

**Purpose** — Agent operating manual. Auto-loaded by Claude Code (CLAUDE.md fallback), Codex (AGENTS.md primary), Gemini CLI (GEMINI.md primary; if missing, falls back to AGENTS.md).

**Required sections:**

1. **Read first** — pointer to `ARCHITECTURE.md` as the next stop
2. **Instruction priority** — user CLAUDE.md/AGENTS.md > skills > default behavior (mirrors superpowers convention)
3. **Project shape** — 2 lines per layer: language, infra, conventions
4. **Where things live** — table mapping concern → doc path, subsystem → module doc path
5. **Conventions agents MUST follow** — TDD when implementing, fail-closed in security, tenant_id+agent_id on every stateful boundary, audit-every-decision, branch-before-commit, conventional commits
6. **Commands** — exact lines for: install, dev, test, typecheck, lint, build, db:migrate, integration test
7. **PR rules** — never push without asking, follow conventional commit format, end with `Co-Authored-By: Claude Opus 4.7`
8. **Out-of-scope hooks** — pointer to `docs/runbooks/` for operations, `docs/superpowers/specs/` for feature design
9. **Footer** — `Last verified: 2026-05-28 against commit <hash>`

**Target length:** 600–800 words.

### 6.2 `ARCHITECTURE.md` (root)

**Purpose** — Mental model of the system. The doc agents read after `AGENTS.md`, before touching anything.

**Required sections:**

1. **What Maia is** — multi-agent platform governed via WhatsApp; tenants → agents → skills; aprende sob aprovação
2. **The 9 pillars** — same numbered list as README, but linked to concern/module docs (no duplication of explanations)
3. **Inviolable invariants** — 4–6 bullets that NEVER bend: tenant isolation, governance before evolution, evidence over opinion, audit log, fail-closed
4. **Layered model** — diagram (Mermaid) showing: Channel → Gateway → Agent (cognitive graph) → Action layer (skills/tools/procedures) → Memory + Governance + Audit
5. **Code map** — table mapping `src/<subdir>` to one-line purpose + link to `modules/<name>.md`
6. **Concerns map** — 5 bullets pointing to `concerns/*.md`
7. **Glossary** — 15–25 key terms with one-sentence definitions: tenant, agent, channel, role, policy, skill, tool, procedure, capability, cognitive graph, knowledge state, drift, dialogical acquisition, identity layer, etc.
8. **Where the gaps are** — pointer to README's "Estado atual & gaps conhecidos" section + open issues
9. **Footer** — verification stamp

**Target length:** 1,500–2,500 words.

### 6.3 `docs/architecture/concerns/` (5 docs)

Each concern doc is the **single source of truth** for one cross-cutting invariant.

Required sections (consistent across all 5):

1. **The invariant** — 1 paragraph: what is true throughout the system
2. **Why it matters** — 1 paragraph: what breaks if violated
3. **Where it lives in code** — table of `path/file.ts:line` mapping invariant → enforcement point
4. **Patterns** — concrete patterns the codebase uses (with code refs)
5. **Anti-patterns** — what NOT to do
6. **Tests that prove it** — table of test files that exercise the invariant
7. **Known gaps** — pointers to open issues / open PRs
8. **In-flight changes** — open PRs touching this concern
9. **Footer** — verification stamp

#### 6.3.1 `concerns/tenant-isolation.md`

The most important concern. Covers:

- `tenant_id + agent_id` NOT NULL on central tables (P0)
- ALS context propagation (`runWithTenantContext`)
- Tenant-guard middleware in query paths
- Defense-in-depth: cache keys, Redis keys, idempotency, dedup, debouncer, rate-limit (the focus of ~15 open PRs)
- The `'default'` literal rejection (PR #282, #283)
- Cross-tenant tests (testcontainers, real Postgres)
- Known gaps: #229 (vector memory), #230 (procedural), working memory namespace

**Target length:** 2,000–2,500 words.

#### 6.3.2 `concerns/cognitive-stack.md`

- `src/cognition/` — reflector, classifier, self-model, capability-proposer, skill-proposer, drift, gap-escalation, procedure-selector, step-evaluator
- `src/cognitive-graph/` — orchestrator, pre/post-turn graphs, registry, latency budget, node descriptors (runWhen, timeout, fallback, model, version)
- `src/control-plane/` — knowledge state machine, policy, runtime-trace, skill-registry, soul layer
- Pipeline: trigger → candidate → classifier → typed destination (fact / rule / procedure / gap / tool request / discard)
- Self-model in 3 layers (domain / skill / gap) with deterministic confidence

**Target length:** 1,800–2,200 words.

#### 6.3.3 `concerns/action-layer.md`

- `src/skills/` — runner, slice-builder, modes (prompt_only / evaluator / tool_mediated), cache
- `src/tools/` — tool registry, Zod contracts, idempotency keys
- `src/procedures/` — engine, test runner, event-sourced state, success criteria
- `src/runtime/decision/` — decision-engine (F1 architecture), action-decider, agent-selector, channel-resolver
- F1 Phase 0 (engine coexistence) + Phase 1 (execute selected skill via runSkill) — context for current state
- Skill abstraction (P9a): tools + procedures unified as skills
- LLM proposes, backend disposes — the founding principle

**Target length:** 2,000–2,500 words.

#### 6.3.4 `concerns/channel-policy.md`

- `src/gateway/` — Baileys (WhatsApp), rate-limit, dedup, debouncer, bot-detection
- `channels` / `channel_policies` / `roles` tables
- Agent-selector + role-engine: LLM suggests, policy decides
- `MULTI_AGENT_SELECTOR_V2` flag (reserved)
- Current state: 1 channel (WhatsApp), 1 agent per channel via policy, multi-channel architecture but no other gateways implemented
- Identity resolver + voice modifier + proposal generator
- Quarantine + onboarding flow

**Target length:** 1,800–2,200 words.

#### 6.3.5 `concerns/governance-observability.md`

- `src/governance/` — rules, audit, dual-approval, idempotency, rate-limit (audit boundary)
- Audit taxonomy — action labels and where they fire
- Metrics — `maia_*_total` counters with `tenant_id+agent_id` labels (PR #275 baseline)
- Runtime trace — dual-pattern (sync envelope + async body, P10b)
- Knowledge state machine — 9-state lifecycle
- Drift detection — 7 types × 4 severities, weekly proposals
- Capability proposals — dialogical acquisition 4-level escalation
- Approvals via admin-ui (governance console)

**Target length:** 1,800–2,200 words.

### 6.4 `docs/architecture/modules/` (24 docs)

One doc per `src/<subdir>`. Fixed template:

```markdown
# <Subsystem Name>

**Path:** `src/<subdir>/`
**Purpose** — 1 paragraph (≤80 words): what role this subsystem plays.

## Key files
| File | Role |
|---|---|
| `src/<sub>/foo.ts:42` | What it does (1 line) |
| ... | ... |

## Patterns it follows
- Tenant isolation → [`concerns/tenant-isolation.md`](../concerns/tenant-isolation.md)
- (other relevant concerns)

## How to extend
"Where do I add X?" — concrete pointer (file + pattern).

## Public surface
What other modules import from this. Avoid listing all exports — only the ones intentional.

## Tests
| Test file | What it covers |
|---|---|

## In-flight changes
- [#XXX](url) — 1 line summary

## Footer
Last verified: 2026-05-28 against commit `<hash>`
```

**Target length per module:** 400–700 words.

**The 24 modules** (alphabetical, matching `src/`):

| # | Module | Highlights |
|---|---|---|
| 1 | `admin-ui` | Next.js 14 + tRPC + NextAuth; 16 routers (governance console) |
| 2 | `agent` | ReAct loop, prompt-builder, core (the "thinking" entry) |
| 3 | `cognition` | Reflector, classifier, self-model, capability/skill proposers |
| 4 | `cognitive-graph` | Orchestrator, pre/post-turn graphs, latency budget |
| 5 | `config` | Zod validation of env vars |
| 6 | `control-plane` | KSM, policy, runtime-trace, skill-registry, soul |
| 7 | `db` | Drizzle schema, repositories, migrations boundary |
| 8 | `gateway` | Baileys, rate-limit, dedup, debouncer, bot-detection |
| 9 | `governance` | Rules, audit, dual-approval, idempotency |
| 10 | `identity` | Resolver, quarantine, voice modifier, proposal generator |
| 11 | `import` | OFX/CSV importers |
| 12 | `lib` | Wrappers (Claude, Whisper, Redis, alerts, holidays) |
| 13 | `memory` | 5 layers (working/episodic/semantic/procedural/vector) |
| 14 | `procedures` | Engine, test runner, event-sourced |
| 15 | `runtime` | Decision-engine, builders, context, action-decider |
| 16 | `scheduling` | Series, occurrences, tasks, outbox, engine |
| 17 | `setup` | Bootstrap wizard (owner, entities, permissions) |
| 18 | `shared` | Cross-module types and utilities |
| 19 | `skills` | Runner, slice-builder, modes, cache |
| 20 | `tools` | Tool registry, Zod contracts |
| 21 | `types` | Global types |
| 22 | `user-layer` | Interlocutor modeling |
| 23 | `workers` | 33 workers (cron + event-driven) |
| 24 | `workflows` | Pending questions, dual-approval state machines |

---

## 7. Style conventions

### Density
- Prefer tables over prose for enumerations
- Prefer code refs over text descriptions ("see `src/memory/vector.ts:120`" > "the vector store")
- No filler adjectives: forbidden list — *powerful, robust, blazing, cutting-edge, world-class, enterprise-grade, scalable*
- Active voice ("`audit()` writes to `audit_logs`" not "audit events are written")

### Code references
- Format: `path/file.ts:line` (and sometimes `path/file.ts:start-end` for blocks)
- Always relative to repo root
- Verify line numbers at write time (line numbers drift — see verification footer)

### Diagrams
- Mermaid only (renders on GitHub)
- Use when prose-only would take >100 words to explain a flow
- Sequence diagrams for cross-module interactions
- Flowcharts for state machines / decision flows
- Skip ASCII art

### Cross-links
- Markdown links between docs: `[tenant isolation](../concerns/tenant-isolation.md)`
- Never duplicate content — link to the canonical doc
- For deep links: `[tenant ALS context](../concerns/tenant-isolation.md#als-context)`

### In-flight changes section
Each doc terminates with:

```markdown
## In-flight changes

- [#XXX](https://github.com/diogenesmendes01/Maia-v2/pull/XXX) — 1-line summary of what changes here
- [#YYY](...) — ...
```

If no open PR touches the doc: `## In-flight changes\n\n_None at last verification._`

### Verification footer
Every doc ends with:

```markdown
---
*Last verified: 2026-05-28 against commit `<short-hash>`. Code references should be re-checked when this stamp is older than 30 days.*
```

### Language
- English only across all 31 docs
- Code identifiers stay as-is (no translation of variable / type / file names)

---

## 8. Source analysis methodology

For every doc, the writing process is:

1. **Read the actual code** in relevant `src/<subdir>/` paths — using `Glob` for structure, `Read` for specifics
2. **Read recent commits** touching those files: `git log --oneline -- src/<subdir>/` (last 25)
3. **Cross-reference open PRs**: `gh pr list --search "<subdir>"` + diff inspection
4. **Read the migrations** that introduced the schema (under `migrations/`)
5. **Read the tests** that document expected behavior (under `tests/`)
6. **Identify patterns** — recurring shapes (e.g., "every Redis key uses `tenant_id+agent_id+...` prefix") — not just file listings
7. **Write** based on observed reality

**Never** consult deleted v1 specs (they don't exist anyway), the old `arquitetura.md` (also deleted), or aspirational design documents.

**Allowed sources:**
- Source code in `src/`, `migrations/`, `tests/`, `scripts/`
- Git history (commits, blame)
- Open PRs (`gh pr view`)
- Existing runbooks (`docs/runbooks/`) — for operational behavior only, not architectural assertions
- README.md (v3 positioning is canonical here)
- Existing design specs (`docs/superpowers/specs/`) — for design intent on features already implemented

---

## 9. Implementation phases (sequence)

| Phase | Deliverables | Estimated effort | Checkpoint |
|---|---|---|---|
| **P1** | `AGENTS.md` + `ARCHITECTURE.md` | 2–3h | User review before P2 |
| **P2** | 5 `concerns/*.md` (parallel batch) | 4–6h | User review before P3 |
| **P3** | 24 `modules/*.md` (parallel batches of 6) | 6–10h | User review at end |

Each phase ends with:
- Self-check: every code reference resolves to a real file:line
- Self-check: every cross-link resolves to a doc in the planned tree
- Commit + push (one commit per phase, or per logical batch within a phase)
- User review checkpoint

---

## 10. Open questions

| # | Question | Default decision |
|---|---|---|
| Q1 | Should `ARCHITECTURE.md` include a Mermaid diagram or just code/concern map tables? | Both — diagram for layered model, tables for code/concern maps |
| Q2 | How many code references per module doc — soft cap? | Soft cap ~10 key files per module; link to source for the rest |
| Q3 | Should glossary live in `ARCHITECTURE.md` or its own `docs/architecture/glossary.md`? | In `ARCHITECTURE.md` (Layer 1) so always loaded with mental model |
| Q4 | Do we add `docs/architecture/decisions/` (ADRs) now? | No — defer; mention in `ARCHITECTURE.md` as future extension |
| Q5 | How to verify code refs don't drift? | Footer date + commit hash; agent re-verifies when stamp >30 days |
| Q6 | Should `AGENTS.md` enforce TDD as a non-negotiable? | Soft — recommend, but defer to user instructions per superpowers priority |

These will be resolved during writing (P1) and noted in the docs themselves.

---

## 11. References

### Source artifacts read during this design
- `README.md` (v3 positioning — canonical)
- `docs/runbooks/p0-p10b-*.md` (operational v3 — for cross-link targets)
- `docs/superpowers/specs/*.md` (existing design specs — for feature context)
- `src/` tree (24 subdirectories) — primary truth
- Recent commits on `origin/main` (last 25)
- Open PRs (~23) via `gh pr list`

### Conventions referenced
- [superpowers/skills/brainstorming](https://github.com/anthropics/superpowers) — this design process
- AGENTS.md convention (Codex, Claude Code fallback)
- Conventional Commits (project commit style — see recent commits on main)

### Out-of-scope but related
- [`docs/runbooks/`](../../runbooks/) — operational debug + rollback (complement, not replacement)
- [`docs/superpowers/specs/`](../specs/) — per-feature design specs (this directory)
- Migrations under `migrations/` — versioned schema (the SSoT for data model)

---

## 12. Approval

**Designed:** 2026-05-28 (this document)
**Approved by:** @diogenesmendes01 (via brainstorm dialogue)
**Implementation begins:** P1 (`AGENTS.md` + `ARCHITECTURE.md`), pending user OK on this written spec

---

*This is a design spec for the documentation suite itself, not for a code change. The "implementation" is writing the 31 architecture docs.*
