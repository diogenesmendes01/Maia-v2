# AI Engineering Agent Operating Model

> Scope: engineering agents that work on Maia's codebase through Claude Code, Codex, or similar tools. This is not the Maia product/runtime agent model.

## Purpose

Maia is developed in a codebase with strong invariants around tenant isolation, governance, audit, policy, and typed execution. AI coding agents can accelerate the work only if the repository gives them durable context, narrow task boundaries, validation gates, and clear review expectations.

This operating model turns the repository into a harness for engineering agents. The goal is to reduce hidden chat context, prevent broad unsupervised edits, and make every agent-produced PR reviewable by humans and other agents.

## Documentation Authority

This document is the central operating model for engineering agents that work on Maia's codebase.

It supersedes the earlier standalone architecture-docs design draft that proposed agent-primary documentation under `docs/superpowers/specs/`. That draft was removed to avoid two competing sources for the same strategy.

Use the documentation layers this way:

- `AGENTS.md` is the short auto-loaded operating manual.
- `ARCHITECTURE.md` is the system mental model.
- `docs/architecture/concerns/` is the source of truth for cross-cutting architecture invariants.
- `docs/architecture/modules/` is the source of truth for subsystem maps.
- `docs/architecture/decisions/` records accepted architecture decisions.
- `docs/ai/` defines how Claude Code, Codex, and similar engineering agents should work.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` are only dated per-feature design and implementation artifacts.

Do not create a new strategy document if one of these layers already owns the subject. Modify, move, merge, or delete the competing document so agents have one canonical place to read.

## Design Decision

Maia uses controlled agentic development:

- repo-local context over conversation memory;
- task specs over vague prompts;
- one branch or worktree per agent task;
- small PRs over broad generated changes;
- executable validation over confidence claims;
- review agents as advisory, not automatic approval;
- architecture invariants as explicit gates.

Maia does not use free-form multi-agent coding where multiple agents edit the same working tree or debate architecture without a task owner.

## Research Basis

This model is based on recurring patterns from AI software-engineering practice:

- Anthropic's multi-agent research system shows that multi-agent work is useful for broad, parallelizable work but has high coordination and token cost.
- CAID's asynchronous software-engineering agents paper points toward manager/coordinator flows, isolated workspaces, branch integration, and executable tests.
- SWE-agent and SWE-bench show that effective coding agents need repo navigation, editing tools, environment feedback, and test loops, not prompt quality alone.
- OpenAI's Codex operating notes emphasize repo-local instructions, scoped tasks, and PR-shaped work.
- Cognition's Devin workflow emphasizes clear tasks, codebase questioning, PRs, CI, and playbooks for repeated workflows.
- Claude Code guidance emphasizes exploration before editing, planning before implementation, and subagents for investigation and review.

These references support a conservative rule: use the simplest agent workflow that can solve the task, then add parallelism only when the task is naturally separable.

## Agent Roles

| Role | Edits code? | Responsibility |
|---|---:|---|
| Explorer | No | Read the repo, map files, identify risks, and propose a path. |
| Implementer | Yes | Make a scoped change from a task spec. |
| Reviewer | No | Look for bugs, regressions, missing tests, and invariant violations. |
| Architect | Usually no | Evaluate module boundaries, ADR impact, and cross-cutting concerns. |
| QA/Test Agent | No, unless fixing test harness only | Run and interpret validation commands. |
| Docs Agent | Yes, docs only | Update docs, runbooks, and templates after behavior changes. |

One agent may play multiple roles in a small task, but the role must be explicit in the task report.

## Default Workflow

1. Start from a task spec.
2. Read `AGENTS.md`, `ARCHITECTURE.md`, relevant concern docs, and relevant module docs.
3. Map likely files before editing.
4. State assumptions, non-goals, invariants, and validation plan.
5. Work in a dedicated branch or worktree.
6. Make the smallest coherent change.
7. Run the validation gates required by the change type.
8. Report diff summary, risk, tests, and unresolved questions.
9. Open a PR as the integration boundary.

## Branch and Worktree Isolation

Parallel agent work must be isolated.

- One task owns one branch.
- Parallel tasks should use separate worktrees when they may run at the same time.
- Agents must not coordinate by editing the same working tree.
- Integration happens through PR review and merge, not by copying patches between chats.
- If two tasks need the same files, serialize them or split the task differently.

## When to Use More Than One Agent

Use one agent by default.

Use multiple agents only when at least one condition is true:

- the task has independent investigation tracks;
- review should be adversarial;
- one agent can inspect architecture while another inspects tests;
- the expected code change is blocked on broad repo discovery;
- a high-risk change benefits from separate QA or security review.

Do not use multiple implementation agents on the same module unless the work is explicitly split by file ownership and branch boundaries.

## Required Task Shape

Non-trivial agent work must use `docs/ai/task-spec-template.md`.

A task must include:

- objective;
- context;
- likely files or modules;
- non-goals;
- Maia invariants at risk;
- validation commands;
- acceptance criteria;
- expected risk;
- output expected from the agent.

## Maia-Specific Stop Conditions

An engineering agent must stop and ask for review when a change may affect:

- tenant or agent scoping;
- policy selection or enforcement;
- audit behavior;
- side-effecting tools;
- idempotency;
- migrations;
- runtime trace;
- operational identity;
- LLM confidence or scoring semantics;
- cross-channel routing.

Stopping is not failure. It is how the agent avoids silently crossing architecture boundaries.

## Validation Gates by Change Type

| Change type | Minimum validation |
|---|---|
| Docs only | Manual reference check; no broken links introduced. |
| TypeScript code | `npm run typecheck`, `npm run lint`, targeted tests when present. |
| Tenant isolation | `npm run test:leak` plus targeted unit/integration tests. |
| Tools or side effects | Unit tests for idempotency, audit, and policy behavior. |
| Migrations | Up/down migration review and relevant repository tests. |
| Admin UI | `npm run admin:typecheck` and targeted admin UI tests when present. |
| Runtime routing | Unit/integration tests around channel, policy, role, and decision engine paths. |

If a gate cannot run locally, the PR must say why and identify the next best evidence.

## Relationship to Product Agents

This model governs the agents that produce code.

It does not define:

- Maia product personas;
- runtime multi-agent routing;
- end-user agent handoff;
- production LLM orchestration.

Those belong in Maia product/runtime architecture docs.

## Outputs

Every agent-assisted PR should make the following visible:

- what context was read;
- what files changed;
- which invariants were considered;
- what validation ran;
- what validation did not run;
- residual risk;
- whether docs, runbooks, or ADRs need updates.
