# P8–P11 Planning Summary

**Date:** 2026-05-15  
**Status:** P9a plan + spec committed in this PR. Other phases shipped separately via individual PRs (see Completion Summary below). **Note:** not all files listed in the References section are present in the repository — only `p9a-skill-abstraction.md` (plan) and `2026-05-15-p9a-skill-abstraction-design.md` (spec) were committed here. The handoff checklists (`P9-HANDOFF-CHECKLIST.txt`, `P10-HANDOFF-CHECKLIST.txt`) and other phase plans/specs referenced below have not been committed to this path.  
**Scope:** 16 implementation phases across 5 vertical slices (P8, P9, P10, P11)

---

## Overview

This document summarizes the design → implementation planning for all four major vertical slices (P8 Governance & Identity, P9 Cognitive & Control, P10 Observability & Knowledge, P11 Cleanup). The P9a plan and spec (committed with this PR) follow the template described here.

> **Inventory disclaimer:** The "Documentation Artifacts" section and References list below describe the *intended* full inventory of plans, specs, and checklists. Only a subset of those files are actually present in the repository. Check `docs/superpowers/plans/` and `docs/superpowers/specs/` for what has been committed. Do not treat this summary's file list as proof that a file exists.

---

## Completion Summary

| Slice | Phase | Title | Plan Lines | Status |
|-------|-------|-------|-----------|--------|
| P8 Governance & Identity | 8.5 | Admin UI v1 | 2092 | Shipped (PR #101) — plan/spec not in this path |
| | 8a | Context Packet | ~1400 | Shipped (PR #96) — plan/spec not in this path |
| | 8b | Soul Layer | ~1300 | Shipped (PR #95) — plan/spec not in this path |
| | 8c | User Layer Namespace | ~1600 | Shipped (PR #94) — plan/spec not in this path |
| | 8d | Identity Completion | ~1200 | Shipped (PR #100) — plan/spec not in this path |
| | 8e | Policy Descriptor Resolver | ~1500 | Shipped (PR #93) — plan/spec not in this path |
| P9 Cognitive & Control | 9a | Skill Abstraction | 1849 | ✓ Plan + spec committed in this PR |
| | 9b | Decision Engine | ~2200 | Shipped (PR #103) — plan/spec not in this path |
| | 9c | Risk Scoring | 2142 | Shipped (PR #97) — plan/spec not in this path |
| | 9d | Policy DSL Evaluator | ~1800 | Shipped (PR #98) — plan/spec not in this path |
| P10 Observability & Knowledge | 10a | Knowledge State Machine | ~1400 | Shipped (PR #104) — plan/spec not in this path |
| | 10b | Runtime Trace Envelope/Body | ~1200 | Shipped (PR #102) — plan/spec not in this path |
| P11 Cleanup | 11 | Cleanup (destructive) | ~900 | Not yet shipped — plan/spec not in this path |
| | | **Totals** | **~19,674 lines** | |

---

## Documentation Artifacts

### Implementation Plans
All plans follow a **consistent template** with:
- **Preconditions** — fail-fast bash verification scripts
- **File Structure** — inventory (create/modify/delete)
- **6–7 Task Phases** — TDD step-by-step per task
- **SQL Migrations** — DDL inline; up/down scripts
- **TypeScript Examples** — type definitions, Drizzle ORM schemas
- **Test Templates** — vitest unit + integration examples
- **Acceptance Gates** — bash scripts verifying done criteria
- **Operations Runbook** — alert response, manual procedures
- **Risk & Mitigation** — documented with handling strategies

**Location:** `docs/superpowers/plans/2026-05-15-p*.md` (only P9a present)

### Design Specifications
Each phase has a detailed spec covering:
- **Architecture & Constraints** — immutable locks, invariants
- **Data Structures** — ASTs, type schemas, examples
- **Algorithms** — pseudo-code, worst-case complexity
- **Integration Points** — how this phase connects to others
- **Error Codes & Handling** — exhaustive error taxonomy
- **Security Model** — threat model, mitigations

**Location:** `docs/superpowers/specs/2026-05-15-p*.md` (only P9a present)

### Handoff Checklists
Two coordination documents are referenced but **not yet committed**:
- **P9-HANDOFF-CHECKLIST.txt** — 4 phases (P8.5 + P9a–c)
- **P10-HANDOFF-CHECKLIST.txt** — 3 phases (P9d + P10a–b)

---

## Key Architectural Decisions

### P8 — Governance & Identity Foundation

**Goal:** Build isolated, auditable identity systems for Maia agents + admin governance.

1. **P8.5 Admin UI v1** — Governance screens, dual-approval workflows, audit trails
2. **P8a Context Packet** — Normalized context envelope (policy rules, tenant facts, agent skills)
3. **P8b Soul Layer** — Identity graph (agent node + relationships to skills, procedures)
4. **P8c User Layer Namespace** — Memory with lifecycle (active/archived/pending_review)
5. **P8d Identity Completion** — Drift detection (7 detector types × 4 severities)
6. **P8e Policy Descriptor Resolver** — PEP evaluator (Early/Mid/Late hook points)

**Invariants:**
- Tenant isolation (§0.1) — no cross-tenant data leaks
- Immutable policy_rules AST (Architecture Lock)
- Drift cannot escalate directly to rollback (queue for review)
- User Layer lifecycle is append-only; status changes are events

---

### P9 — Cognitive & Control Plane

**Goal:** Build skill orchestration, decision engine, risk scoring, and policy evaluation.

1. **P9a Skill Abstraction** — Skills table, SkillRunner (4 execution modes), lifecycle
2. **P9b Decision Engine** — DecisionPacket (3 PEPs: Early/Mid/Late), <400ms budget
3. **P9c Risk Scoring** — TurnRiskScorer + KnowledgeRiskScorer, no-downgrade rule
4. **P9d Policy DSL Evaluator** — Pure, total evaluator (10 operators, ReDoS guard)

**Invariants:**
- Policy evaluation is deterministic, side-effect-free
- Risk scoring never downgrades confidence (monotonic increase)
- DecisionPacket budget is <400ms (verified via tinybench)
- Skill execution is audited in `procedure_execution_events`

---

### P10 — Observability & Knowledge Management

**Goal:** Build runtime tracing and knowledge state machine for evidence-driven learning.

1. **P10a Knowledge State Machine** — 9-state FSM, auto-promoter, 4 propose_* tools
2. **P10b Runtime Trace Envelope/Body** — Dual-pattern traces, HMAC-SHA256, redaction

**Invariants:**
- Trace envelope writes synchronously (<20ms) before side_effect_level >= medium
- HMAC-SHA256 is tenant-scoped (prevents cross-tenant dictionary attacks)
- Redaction is immutable (8-field PII set hardcoded)
- TraceBody async writes have 90-second TTL before trace body orphans
- Knowledge visibility is deterministic (no LLM guessing)

---

### P11 — Cleanup & Final Optimization

**Goal:** Remove legacy code after 30+ days canary stability; validate Optimized SLO.

1. **P11 Cleanup** — Drop fast-paths, retire feature flags, remove agent_id from User Layer
2. **Load tests** — Validate Optimized SLO (target 3.75s p95)

**Precondition:**
- P0–P10 must be 100% stable on canary for ≥30 days
- No regressions in 3 consecutive production windows

---

## Dependency Graph

```
P0–P7 (Foundation)
│
├─→ P4 (Profile Body)
│   │
│   ├─→ P8.5 (Admin UI) ✓
│   ├─→ P8a (Context Packet)
│   │   └─→ P8b (Soul Layer)
│   │       └─→ P8c (User Layer Namespace)
│   │           ├─→ P8d (Identity Completion)
│   │           └─→ P8e (Policy Descriptor Resolver)
│   │               ├─→ P9d (Policy DSL Evaluator)
│   │               └─→ P10b (Runtime Trace)
│   │
│   ├─→ P9a (Skill Abstraction)
│   │   └─→ P9b (Decision Engine) ✓
│   │       └─→ P9c (Risk Scoring)
│   │           └─→ P10a (Knowledge State Machine)
│   │
│   └─→ P11 (Cleanup, after 30+ days canary)
│
└─→ (All merge to main before next batch)
```

**Parallelism Opportunities:**
- **Batch 1:** P8.5 + P9a (parallel, no deps between them)
- **Batch 2:** P8a + P9b (parallel after P8.5+P9a merged)
- **Batch 3:** P8b + P9c (parallel, dependencies ready)
- **Batch 4:** P8c (depends on P8b)
- **Batch 5:** P8d + P10a (parallel, both depend on P8c + P9c)
- **Batch 6:** P8e (no blocker)
- **Batch 7:** P9d + P10b (parallel, P8e merged)
- **Batch 8:** P11 (only after 30+ days canary stability)

---

## Execution Timeline

| Phase | Est. Duration | Status | Next |
|-------|---|---|---|
| P8.5 Admin UI | 3–4d | Shipped | — |
| P9a Skill | 3–4d | Shipped | — |
| P8a Context | 3–4d | Shipped | — |
| P9b Decision | 4–5d | Shipped | — |
| P8b Soul | 3–4d | Shipped | — |
| P9c Risk | 3–4d | Shipped | — |
| P8c User Layer | 4–5d | Shipped | — |
| P8d Identity | 3–4d | Shipped | — |
| P10a Knowledge | 3–4d | Shipped | — |
| P8e Policy | 3–4d | Shipped | — |
| P9d Policy DSL | 3–4d | Shipped | — |
| P10b Trace | 4–5d | Shipped | — |
| P11 Cleanup | TBD | Pending canary | After 30d stable |
| **Total** | **~8–10 weeks** | — | — |

---

## Quality Gates (All Must Pass)

Per plan, ALL of:

1. ✓ **Unit Tests** — npm test, coverage ≥80%
2. ✓ **Integration Tests** — npm test -- tests/integration
3. ✓ **Acceptance Gates** — bash scripts/p<phase>-acceptance-gates.sh
4. ✓ **Linting** — npm run lint && npm run format
5. ✓ **Type Checking** — npx tsc --noEmit (zero errors)
6. ✓ **Code Review** — ≥1 approval, all comments resolved
7. ✓ **CI/CD** — GitHub Actions passes, all checks green

---

## Architecture Locks

Changes to these require **founder approval**:

| Lock | Phase | What's Protected |
|------|-------|---|
| Tenant isolation | P8 | No cross-tenant data flow; audit immutable |
| Identity lifecycle | P8c | 4 layers (core/profile/episodic/backlog) |
| Drift escalation rules | P8d | 7 detectors × 4 severities → action mapping |
| Policy AST | P8e + P9d | Operator semantics, predicate schema, effect actions |
| Risk monotonicity | P9c | Confidence never downgrades |
| Knowledge visibility | P10a | Deterministic (no LLM guessing) |
| Trace schema & envelope | P10b | Side_effect_level threshold, HMAC scope, redaction fields |

---

## Handoff Status

### Files Present in This PR
- ✓ `docs/superpowers/plans/2026-05-15-p9a-skill-abstraction.md` — P9a implementation plan
- ✓ `docs/superpowers/specs/2026-05-15-p9a-skill-abstraction-design.md` — P9a design spec

### Files Referenced but Not Committed
The following files are referenced in the sections below but are **not present** in the repository at this time. Do not treat this list as evidence that they exist:
- `docs/superpowers/plans/2026-05-15-p8.5-admin-ui-v1.md`
- `docs/superpowers/plans/2026-05-15-p8a-context-packet.md`
- `docs/superpowers/plans/2026-05-15-p8b-soul-layer.md`
- `docs/superpowers/plans/2026-05-15-p8c-user-layer-namespace.md`
- `docs/superpowers/plans/2026-05-15-p8d-identity-completion.md`
- `docs/superpowers/plans/2026-05-15-p8e-policy-descriptor-resolver.md`
- `docs/superpowers/plans/2026-05-15-p9b-decision-engine.md`
- `docs/superpowers/plans/2026-05-15-p9c-risk-scoring.md`
- `docs/superpowers/plans/2026-05-15-p9d-policy-dsl-evaluator.md`
- `docs/superpowers/plans/2026-05-15-p10a-knowledge-state-machine.md`
- `docs/superpowers/plans/2026-05-15-p10b-runtime-trace.md`
- `docs/superpowers/plans/2026-05-15-p11-cleanup.md`
- `docs/superpowers/plans/P9-HANDOFF-CHECKLIST.txt`
- `docs/superpowers/plans/P10-HANDOFF-CHECKLIST.txt`
- `docs/superpowers/specs/2026-05-15-runtime-architecture-v3-final.md`
- `docs/superpowers/specs/2026-05-15-p8.5-admin-ui-v1-design.md`
- (all other phase specs except P9a)

### Next Steps
1. **Assign phases to workers** — use P9/P10 handoff checklists (once committed)
2. **Create worktrees** — per execution workflow in checklists
3. **Run precondition checks** — fail-fast before starting tasks
4. **Execute tasks** — TDD (failing test → implementation → pass)
5. **Run acceptance gates** — all must pass before PR
6. **Create PRs** — include task checklist in description
7. **Code review + merge** — return to step 2 for next phase

---

## References

### Implementation Plans (only P9a present)
- `docs/superpowers/plans/2026-05-15-p9a-skill-abstraction.md` ← **present**
- `docs/superpowers/plans/2026-05-15-p8.5-admin-ui-v1.md` ← not committed
- `docs/superpowers/plans/2026-05-15-p8a-context-packet.md` ← not committed
- `docs/superpowers/plans/2026-05-15-p8b-soul-layer.md` ← not committed
- `docs/superpowers/plans/2026-05-15-p8c-user-layer-namespace.md` ← not committed
- `docs/superpowers/plans/2026-05-15-p8d-identity-completion.md` ← not committed
- `docs/superpowers/plans/2026-05-15-p8e-policy-descriptor-resolver.md` ← not committed
- `docs/superpowers/plans/2026-05-15-p9b-decision-engine.md` ← not committed
- `docs/superpowers/plans/2026-05-15-p9c-risk-scoring.md` ← not committed
- `docs/superpowers/plans/2026-05-15-p9d-policy-dsl-evaluator.md` ← not committed
- `docs/superpowers/plans/2026-05-15-p10a-knowledge-state-machine.md` ← not committed
- `docs/superpowers/plans/2026-05-15-p10b-runtime-trace.md` ← not committed
- `docs/superpowers/plans/2026-05-15-p11-cleanup.md` ← not committed

### Design Specs (only P9a present)
- `docs/superpowers/specs/2026-05-15-runtime-architecture-v3-final.md` ← not committed
- `docs/superpowers/specs/2026-05-15-p9a-skill-abstraction-design.md` ← **present**
- [all other phase specs] ← not committed

### Handoff Checklists (not committed)
- `docs/superpowers/plans/P9-HANDOFF-CHECKLIST.txt` ← not committed
- `docs/superpowers/plans/P10-HANDOFF-CHECKLIST.txt` ← not committed

---

## Sign-Off

**Generated by:** Superpowers Planning Agent  
**Date:** 2026-05-15  
**Validation:** P9a preconditions syntactically verified; P9a task sequences confirmed; P9a dependency chains validated; P9a quality gates defined. Other phases are referenced but their artifacts are not committed here.

**Status:** P9a ready for agentic execution. Other phases: shipped separately — see individual PRs.

---
