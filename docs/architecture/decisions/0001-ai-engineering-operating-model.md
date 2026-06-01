# ADR: AI Engineering Operating Model

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-06-01 |
| Owner | Maia maintainers |
| Related issue | #382 |
| Related PR | TBD |

## Context

Maia is increasingly developed with AI coding agents such as Claude Code and Codex. The repository already contains architecture docs and strict runtime invariants, but coding-agent workflows need their own durable operating model.

The concern is not Maia product/runtime agents. The concern is engineering agents that read, modify, review, and maintain Maia's code.

This decision centralizes Maia's engineering-agent documentation strategy in `docs/ai/` and `docs/architecture/decisions/`.

It supersedes and removes the previous standalone architecture-docs design draft that lived under `docs/superpowers/specs/`. That older draft overlapped with the new operating model, so keeping both would create competing instructions for future agents.

If those agents depend on hidden chat context, Maia risks inconsistent implementation quality, broad unreviewable diffs, missed validation, and accidental violations of tenant isolation, policy, audit, fail-closed behavior, or governed identity.

External practice points toward a controlled model:

- multi-agent workflows help with broad or parallelizable work, but add coordination and token cost;
- software-engineering agents need isolated workspaces, branch integration, tests, and feedback loops;
- repo-local instructions and playbooks are more durable than conversation memory;
- review agents are useful when they are adversarial and advisory, not automatic merge authorities.

## Decision

Maia adopts controlled agentic development for engineering work.

The repository will define task specs, agent roles, branch/worktree isolation, validation gates, review expectations, and invariant checklists for AI coding agents.

Single-agent implementation remains the default. Multiple agents are used only for separable investigation, adversarial review, architecture review, or QA/test interpretation. Integration happens through PRs.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Free-form prompting | Fast to start | Hidden context, inconsistent quality, weak repeatability. |
| Free-form multi-agent coding | Can explore broadly | High coordination cost, collision risk, hard-to-review output. |
| Controlled agentic development | Durable, reviewable, safer for Maia invariants | Requires upfront docs and discipline. |

## Consequences

Positive consequences:

- agents can start from repo-local context;
- tasks become easier to delegate and review;
- PRs can report invariant impact consistently;
- repeated workflows become playbooks;
- parallel agent work has branch/worktree boundaries.
- older overlapping strategy drafts are deleted or merged into the canonical docs instead of kept as rival context.

Negative consequences:

- more documentation must be maintained;
- some small tasks may feel slower;
- agents must stop when scope expands instead of improvising.

## Validation

This decision is working when:

- non-trivial agent tasks use task specs;
- PRs identify relevant Maia invariants;
- reviewers can reproduce the agent's reasoning from repo-local docs;
- repeated workflows become playbooks instead of chat-only knowledge;
- parallel agent work does not collide in the same working tree.

## Reversal Criteria

Revisit this decision if:

- the docs become stale and are not used by agents;
- validation gates are routinely skipped without reason;
- agent-produced PRs still require hidden context to review;
- a better executable governance mechanism replaces the docs.

## References

- Anthropic, "How we built our multi-agent research system": https://www.anthropic.com/engineering/multi-agent-research-system
- CAID, "Effective Strategies for Asynchronous Software Engineering Agents": https://arxiv.org/abs/2603.21489
- SWE-agent: https://arxiv.org/abs/2405.15793
- SWE-bench: https://arxiv.org/abs/2310.06770
- OpenAI, "How OpenAI uses Codex": https://cdn.openai.com/pdf/6a2631dc-783e-479b-b1a4-af0cfbd38630/how-openai-uses-codex.pdf
- Cognition, "How Cognition uses Devin to build Devin": https://cognition.ai/blog/how-cognition-uses-devin-to-build-devin
- Claude Code best practices: https://code.claude.com/docs/en/best-practices
- Claude Code review: https://code.claude.com/docs/en/code-review
