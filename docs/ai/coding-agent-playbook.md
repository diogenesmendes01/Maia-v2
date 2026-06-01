# Coding Agent Playbook

> Use this when acting as an implementation agent for Maia.

## Operating Principle

Do not start by editing. Start by proving that you understand the task, the relevant code path, and the invariants at risk.

## Step 1: Read the Operating Context

Read in this order:

1. `AGENTS.md`
2. `ARCHITECTURE.md`
3. `docs/ai/agent-operating-model.md`
4. Relevant concern docs in `docs/architecture/concerns/`
5. Relevant module docs in `docs/architecture/modules/`
6. The source files you expect to edit

For small docs-only changes, read the nearest docs and `AGENTS.md`.

## Step 2: Map Before Editing

Before changing files, identify:

- entry points;
- stateful reads and writes;
- tools or procedures involved;
- tenant/agent context boundaries;
- audit behavior;
- tests already covering the area;
- nearby patterns to follow.

Use search first. Do not invent a pattern before finding the local one.

## Step 3: State the Change Hypothesis

Write down:

- what you think needs to change;
- why those files are the correct boundary;
- what is out of scope;
- which invariants might be affected;
- what validation will prove the change.

For short tasks this can live in the PR body. For larger tasks, create or reference a task spec.

## Step 4: Make a Small Coherent Change

Prefer narrow changes:

- one concern per PR;
- one behavior change per PR;
- docs and code together only when the docs explain the same behavior;
- no opportunistic refactors;
- no drive-by formatting.

If the necessary change grows beyond the task spec, stop and report the new scope.

## Step 5: Preserve Maia Invariants

Before finishing, apply `docs/ai/maia-invariants-checklist.md`.

At minimum, confirm:

- every stateful path is scoped by `tenant_id + agent_id`;
- unresolved tenant/channel/policy paths fail closed;
- LLM output remains typed and backend-validated;
- confidence is not LLM-declared;
- side effects audit through `audit()`;
- identity changes remain proposal/approval driven.

## Step 6: Validate

Run the narrowest meaningful validation first, then broader gates as needed.

Common commands:

```bash
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:leak
```

For docs-only changes, manually verify relative links and referenced files.

If a command fails because of pre-existing or environmental reasons, report the exact failure and avoid hiding it.

## Step 7: Report the Work

Every final implementation report must include:

- files changed;
- behavior changed;
- validation run;
- validation not run;
- invariant impact;
- residual risk;
- follow-up work if needed.

## Do Not

- Do not edit merged migrations.
- Do not bypass policy or audit to make a test pass.
- Do not introduce a new global default tenant/agent fallback.
- Do not add LLM self-confidence as a decision input.
- Do not change runtime behavior from a docs task.
- Do not use broad multi-agent parallelism when one scoped agent is enough.

