# AI Coding Task Spec Template

> Copy this into issues, PR plans, or agent prompts before delegating non-trivial Maia work to Claude Code, Codex, or another coding agent.

## Objective

State the concrete outcome.

Example:

> Add tenant-scoped audit coverage for financial mutation X without changing user-facing behavior.

## Background

Explain why this matters and link the issue, ADR, or architecture doc.

- Issue:
- Related PRs:
- Relevant docs:

## Agent Role

Choose one:

- Explorer
- Implementer
- Reviewer
- Architect
- QA/Test Agent
- Docs Agent

## Expected Scope

Likely files or modules:

- `src/...`
- `tests/...`
- `docs/...`

Out of scope:

- ...

## Maia Invariants at Risk

Check all that apply:

- [ ] Tenant/agent isolation
- [ ] Fail-closed behavior
- [ ] Backend decides, LLM proposes
- [ ] Audit every side effect or policy decision
- [ ] Deterministic confidence
- [ ] Governed operational identity
- [ ] Append-only migrations
- [ ] Idempotency for side effects
- [ ] Runtime trace integrity
- [ ] Policy-controlled channel/role/agent routing

## Required Reading

- [ ] `AGENTS.md`
- [ ] `ARCHITECTURE.md`
- [ ] `docs/ai/agent-operating-model.md`
- [ ] Relevant concern doc:
- [ ] Relevant module doc:
- [ ] Existing tests:

## Implementation Notes

Describe preferred local patterns, constraints, or known traps.

- ...

## Validation Commands

Run what applies:

```bash
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:leak
```

If any command is intentionally skipped, explain why.

## Acceptance Criteria

- [ ] ...
- [ ] ...
- [ ] PR reports validation and residual risk.

## Expected Output

The agent should return:

- summary of files changed;
- validation results;
- invariant impact;
- residual risks;
- follow-up recommendations.

