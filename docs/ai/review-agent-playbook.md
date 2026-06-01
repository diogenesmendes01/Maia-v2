# Review Agent Playbook

> Use this when acting as an adversarial review agent for Maia.

## Review Stance

Prioritize bugs, regressions, security risks, invariant violations, and missing tests. Style and wording are secondary unless they change behavior or maintainability.

Review agents are advisory. They do not approve, reject, or merge PRs on their own.

## Step 1: Understand the Claimed Scope

Read:

1. the issue or task spec;
2. the PR description;
3. the diff;
4. `AGENTS.md`;
5. relevant architecture concern docs.

Identify the claimed non-goals. A good review checks both what changed and what should not have changed.

## Step 2: Classify Risk

Mark the PR as one or more:

- docs only;
- UI/admin;
- tool or side effect;
- tenant/agent state;
- policy/routing;
- migration/schema;
- LLM prompt or scoring;
- worker/queue;
- observability/audit.

The risk class determines how hard the review should be.

## Step 3: Check Maia Invariants

Use `docs/ai/maia-invariants-checklist.md`.

For each relevant invariant, ask:

- did the PR preserve the existing boundary?
- did tests prove the boundary?
- did the PR add a bypass?
- did the PR create hidden reliance on `'default'`?
- did the PR add state without tenant/agent labels?

## Step 4: Inspect Tests and Validation

Check whether validation matches the risk:

- docs-only: links and references checked;
- TypeScript: typecheck and lint;
- tenant paths: leak tests or targeted tenant tests;
- tools: idempotency and audit tests;
- policy/routing: policy and fail-closed tests;
- migrations: up/down review and repository tests.

Missing tests are findings when the changed behavior is risky or shared.

## Step 5: Report Findings

Findings should lead.

Use this format:

```markdown
## Findings

- Severity: High
  File: `path/file.ts:123`
  Issue: ...
  Impact: ...
  Recommendation: ...

## Open Questions

- ...

## Residual Risk

- ...
```

If there are no findings, say that clearly and list any test gaps or residual risks.

## Severity Guide

| Severity | Meaning |
|---|---|
| Critical | Data leak, cross-tenant breach, ungoverned irreversible side effect, production outage risk. |
| High | Likely regression, missing policy/audit gate, incorrect migration, untested shared behavior. |
| Medium | Edge case, incomplete validation, maintainability risk in active path. |
| Low | Minor clarity, docs mismatch, naming, small local cleanup. |

## Do Not

- Do not rewrite the PR.
- Do not focus on style before correctness.
- Do not request broad refactors unrelated to the task.
- Do not approve a risky PR based only on the author's confidence.
- Do not treat another agent's review as proof.

