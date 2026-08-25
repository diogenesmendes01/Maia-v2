# control-plane

**Path:** `src/control-plane/`

**Purpose** — The platform's governed state surface. Holds the Knowledge State Machine (9-state lifecycle for learned knowledge), the policy engine (string-descriptor resolution + cache + per-tenant pubsub), the runtime-trace writer (dual-pattern envelope + body), the persistent skill registry, and the append-only soul layer. Everything here is owner-governed: cognition proposes; the control plane records, gates, and serves.

## Key files

### Knowledge State Machine (KSM)

| File | Role |
|---|---|
| `src/control-plane/knowledge-state-machine/state-machine.ts` | 9-state lifecycle definition |
| `src/control-plane/knowledge-state-machine/transitions.ts` | Transition methods (proposed → reviewed → accepted / rejected / revoked / superseded / archived) |
| `src/control-plane/knowledge-state-machine/risk-scorer.ts` | Generic risk scoring |
| `src/control-plane/knowledge-state-machine/knowledge-risk-scorer.ts` | Knowledge-specific pre-promotion risk score |
| `src/control-plane/knowledge-state-machine/visibility.ts` | Visibility rules for in-flight knowledge |
| `src/control-plane/knowledge-state-machine/repos.ts` | Tenant-scoped persistence |
| `src/control-plane/knowledge-state-machine/types.ts` | Shared types |

### Policy

| File | Role |
|---|---|
| `src/control-plane/policy/index.ts` | Public surface |
| `src/control-plane/policy/policy-rules-repo.ts` | Persistent policy rules |
| `src/control-plane/policy/policy-cache.ts` | In-process cache; per-tenant Redis pubsub invalidation |
| `src/control-plane/policy/policy-descriptor-resolver.ts` | String descriptor → active policy ID |
| `src/control-plane/policy/types.ts` | Shared types |

### Runtime trace (P10b)

| File | Role |
|---|---|
| `src/control-plane/runtime-trace/index.ts` | Public surface |
| `src/control-plane/runtime-trace/envelope-writer.ts` | Sync envelope per turn |
| `src/control-plane/runtime-trace/body-writer.ts` | Async body with full detail |
| `src/control-plane/runtime-trace/verify-envelope.ts` | Recomputes `envelope_hmac`/`packet_hmac`; `verified` / `invalid` / `unknown` / `rejected_version` |
| `src/control-plane/runtime-trace/lib/signature.ts` | **Versioned** canonical material for `envelope_hmac` (v1 read-only, v2 written) |
| `src/control-plane/runtime-trace/lib/redaction.ts` | PII redaction |
| `src/control-plane/runtime-trace/lib/hmac.ts` | HMAC chain envelope ↔ body |
| `src/control-plane/runtime-trace/lib/debug-encrypt.ts` | Optional debug-time encryption |

**Envelope signature versions (issue #535).** `signature_version` is a column
(migration 119). **v1** signs the migration-052 field set; **v2** signs that set
plus `root_trace_id`, `attempt` and the version itself. Production writes **only
v2** — the writer takes the version from a constant, never from its input, so a
caller cannot request a weaker signature. The verifier still reads v1, so
fixtures and environments that already hold v1 rows keep a real verdict; v1 rows
are **never** re-signed. Signing the version is what makes the two-version
verifier safe: relabelling a v2 row as v1 makes the recomputation fail, so the
column is not a downgrade lever. Full rationale in
[`concerns/governance-observability.md` §4.4a](../concerns/governance-observability.md).

### Skill registry

| File | Role |
|---|---|
| `src/control-plane/skill-registry/index.ts` | Public surface |
| `src/control-plane/skill-registry/skills-repo.ts` | Persistent skill catalog (status: proposed/active/revoked) |

### Soul layer (P8b)

| File | Role |
|---|---|
| `src/control-plane/soul/soul-biases-repo.ts` | Append-only behavioral biases |
| `src/control-plane/soul/origin-gate.ts` | Gates writes by origin (governance only) |

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — every repo here scopes by `tenant_id + agent_id`
- [Governance + observability](../concerns/governance-observability.md) — soul is append-only + origin-gated; KSM transitions audit
- [Cognitive stack](../concerns/cognitive-stack.md) — KSM, policy, soul are the persistent counterparts of cognition's outputs

## How to extend

| Need | Where |
|---|---|
| Add a new KSM state or transition | Extend `state-machine.ts`; new transition method in `transitions.ts`; add property tests in `tests/property/knowledge-state-machine.spec.ts` |
| Add a new policy operator | Extend `src/governance/policy-dsl/` (DSL); resolver and cache in this module read |
| Add a new trace field | Decide envelope vs body (durability vs detail); update `envelope-writer.ts` or `body-writer.ts`; respect redaction rules |
| Add a field to `envelope_hmac` | **Never edit v1 in place** — that invalidates every stored v1 row. Add a `signature_version=3` material in `lib/signature.ts`, bump `CURRENT_ENVELOPE_SIGNATURE_VERSION`, widen the migration-119 CHECK, and leave the older builders untouched |
| Add a new soul bias type | Extend `soul-biases-repo.ts`; ensure append-only contract; respect origin-gate |

## Public surface

| Consumed by | What |
|---|---|
| `src/cognition/` | Cognition writes proposals; control-plane persists |
| `src/runtime/decision/` | Decision engine reads policy + skill registry |
| `src/admin-ui/` | Governance console reads KSM + skill registry + soul + trace |
| `src/workers/` | Background promoters (`knowledge-state-promoter`), trace recoverers, etc. |

## Tests

| Test path | What it covers |
|---|---|
| `tests/integration/p10a-knowledge-lifecycle.spec.ts` | KSM lifecycle |
| `tests/property/knowledge-state-machine.spec.ts` | Property-based KSM invariants |
| `tests/unit/control-plane/knowledge-state-machine/` | Per-method contracts |
| `tests/integration/p10b-runtime-trace.spec.ts` (if present) | Trace envelope/body integrity |
| `tests/unit/observability/verify-envelope.spec.ts` | Per-field tampering, both signature versions, version relabelling |
| `tests/unit/observability/envelope-signature-v2.spec.ts` | Canonical-encoding ambiguity; `listAttempts()` signed-`turno_id` requirement |
| `tests/unit/runtime-trace-envelope-writer.spec.ts` | The written row is v2, against a LITERAL canonical material |
| `tests/integration/trace-explorer-attempt-grouping.spec.ts` | writer → real repo → Explorer, including a spliced foreign turn |

## In-flight changes

At last verification (2026-05-28):

- KSM per-row context wraps audit module (#255 → #280 — open)
- KSM bounded retry loop for revoke under optimistic-conflict (#256 → #279 — open)
- KSM scoping fixes for transitions/updates (#234 → #243 — merged)
- KSM fact/memory/hint scope (#254 → #267 — merged)

Verify: `gh pr list --state open --search "ksm OR knowledge-state OR policy OR soul OR trace"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
