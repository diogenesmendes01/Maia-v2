# Maia Invariants Checklist

> Use this before opening or reviewing any non-trivial Maia PR.

## Tenant and Agent Isolation

- [ ] Every stateful DB query is scoped by `tenant_id + agent_id` when serving tenant data.
- [ ] Redis keys, cache keys, queues, and idempotency keys include tenant/agent context where applicable.
- [ ] No dynamic runtime path silently falls back to `'default'`.
- [ ] Cross-tenant reads are explicitly impossible or explicitly tested.

## Fail-Closed Behavior

- [ ] Missing tenant context rejects instead of guessing.
- [ ] Missing agent context rejects instead of guessing.
- [ ] Unresolved channel, role, or policy rejects instead of routing to a default.
- [ ] Unknown tool, procedure, or capability fails safely.

## Backend Decides, LLM Proposes

- [ ] LLM output remains typed and schema-validated.
- [ ] Backend state and policy decide whether an action executes.
- [ ] The PR does not move authority into prompt text.
- [ ] Tool arguments are validated with Zod or the existing local contract.

## Audit and Observability

- [ ] Side effects call the standard audit path.
- [ ] Governance and policy decisions are auditable.
- [ ] New audit actions use the typed action taxonomy.
- [ ] Metrics include tenant/agent labels where applicable.
- [ ] Runtime trace remains reconstructable for the changed path.

## Deterministic Confidence

Two distinct kinds of "confidence" live in Maia; keep them separate:

- **(a) Self-model / governance confidence** (drift, capability/skill maturity, gap escalation, KSM promotion) is **computed deterministically** from evidence counts, counters, or scoring formulas. The **LLM never declares it**. This is the inviolable invariant.
- **(b) Decision-engine routing confidence** (intent classification, pending-question resolution, procedure selection) **may be proposed by the LLM**, but the backend **always gates it against a deterministic threshold** before acting — "LLM proposes, backend decides." It is never acted on as a self-asserted authority.

- [ ] Self-model / governance confidence is computed from evidence, counters, or deterministic scoring — never declared by the LLM.
- [ ] LLM-proposed routing confidence (if any) is consumed only behind a backend threshold, not trusted directly.
- [ ] Any scoring or threshold change has tests or a clear validation plan.

## Governed Identity and Learning

- [ ] Operational identity changes remain proposal/approval driven.
- [ ] Learned rules, skills, procedures, and hints go through the governed lifecycle.
- [ ] The agent does not directly mutate its own profile, role, soul, or permissions.

## Side Effects and Idempotency

- [ ] Side-effecting tools have idempotency protection.
- [ ] Retries do not double-send, double-write, or double-charge.
- [ ] Irreversible actions still use approval gates where required.

## Migrations

- [ ] New migrations are append-only.
- [ ] `_down` migration exists when a schema migration is added.
- [ ] Merged migrations are not edited.
- [ ] Data backfills include tenant/agent safety considerations.

## Review Output

Every PR should explicitly state:

- [ ] which invariants were relevant;
- [ ] which validation commands ran;
- [ ] which validation commands did not run and why;
- [ ] residual risks;
- [ ] whether docs, runbooks, or ADRs were updated.

