# P9d — Policy DSL Evaluator Runbook

## What this is

A **pure, total, ReDoS-safe** evaluator for the JSONB body stored in
`policy_rules.rule_body` (P8e). Given a `PolicyRuleBody` and an arbitrary
context object, returns a `PolicyDecision` describing whether the policy
matched, didn't match, didn't apply, or could not be soundly evaluated.

- **Lives in:** `src/governance/policy-dsl/`
- **Public surface:** `evaluate`, `validatePolicyRuleBody`, `enforce`, plus types
- **Used by (consumers):** P9b Decision Engine (Early/Mid/Late PEPs); future
  Admin UI proposal-time validation; any code that needs to test a policy
  against context.

## Hard guarantees (Architecture Lock)

| Property | Guarantee | Where |
|---|---|---|
| Pure | No I/O, no `Date.now()`, no mutation of inputs | `evaluator.ts` |
| Total | Never throws — every error is captured in `decision.errors` | All paths |
| Deterministic | Identical inputs → byte-identical decisions | Verified via property test (200 + 10k adversarial) |
| Bounded depth | `MAX_PREDICATE_DEPTH = 16` | `constants.ts` |
| Bounded field path | `MAX_FIELD_PATH_DEPTH = 16` | `constants.ts` |
| Bounded fan-out | `MAX_BRANCH_FANOUT = 64` per AND/OR | `constants.ts` |
| Bounded total nodes | `MAX_TOTAL_PREDICATE_NODES = 1024` per body | `constants.ts` |
| ReDoS safe | `safe-regex2` static check + 4096-char input cap | `regex-cache.ts` |
| LRU regex cache | `REGEX_CACHE_MAX = 256` | `regex-cache.ts` |
| Fail-closed on missing context | Equality ops → `not_applicable`; ordinal ops → `evaluation_error` | `evaluator.ts:evalLeaf` |
| Branch children fail-closed | `null`/`undefined`/non-object child → `evaluation_error` (was silently skipped) | `evaluator.ts:evalAnd`/`evalOr` |
| Effects re-validated at runtime | Matched decision with missing/unknown action → `evaluation_error` | `evaluator.ts:evaluate` |
| PEPs MUST treat `evaluation_error` as BLOCK | Enforced by `enforce()` helper + property test | `enforcement.ts`, `policy-dsl-enforcement.spec.ts` |

Changing any of these requires founder approval (master spec §0.1).

## Tri-state outcome (`PolicyOutcome`)

Every `evaluate()` returns one of four outcomes. **PEPs MUST switch on
`decision.outcome`** — checking just `decision.matched: boolean` collapses
`not_applicable` and `evaluation_error` into `false`, turning missing
context into an implicit allow.

| Outcome | Meaning | PEP action |
|---|---|---|
| `matched` | Predicate true + effect valid + no errors | Apply `decision.effect` |
| `not_matched` | Predicate false; all fields present | No-op (rule didn't fire) |
| `not_applicable` | Equality/membership/string op hit missing field; author intent has no defined answer | No-op + audit (drift detector) |
| `evaluation_error` | Ordinal op vs missing field, malformed body, regex compile failure, invalid effect | **BLOCK** (default-safe) + ops alert |

### Why `not_applicable` exists

Consider `role not_in ['banned']`. If `role` is missing from context,
naively returning `!deepEqual(undefined, 'banned')` returns `true` and the
exclusion rule "matches" — silently allowing the request. Codex review #98
flagged this as a critical security boundary. The fix: equality-family ops
against missing fields return `not_applicable` (the rule had no answer);
ordinal ops return `evaluation_error: missing_field` (cannot coerce
`undefined` to a number).

### Use the canonical `enforce()` helper

```ts
import { evaluate, enforce } from '@/governance/policy-dsl';

const decision = evaluate(rule.rule_body, ctx);
const action = enforce(decision);   // ← canonical mapping

switch (action.kind) {
  case 'allow':   return passThrough();
  case 'block':   return blockWithReason(action.reason);
  case 'observe': return logAndContinue(action.effect);
  case 'pass':    return ruleDidNotFire();
}
```

`enforce()` is the ONLY place that maps `PolicyOutcome` → action. PEPs
that hand-roll the mapping risk the silent-allow class of bugs.

## Operators (10)

| Op | Behaviour | Type-mismatch handling |
|---|---|---|
| `eq` | Strict deep-equal | `false` (no coercion) |
| `neq` | Inverse of `eq` | `false` |
| `in` | Membership in array literal | `false` if `value` not array |
| `not_in` | Inverse of `in` | `false` if `value` not array |
| `gt` / `gte` / `lt` / `lte` | Numeric compare | `false` for non-numeric or NaN |
| `contains` | substring (string×string) or membership (array×any) | `false` for other combos |
| `matches` | RegExp test (cache-backed, ReDoS-validated) | `false` if input not string |

## Effects (5)

`allow`, `block`, `require_dual_approval`, `warn`, `log`.

The evaluator returns the effect as **data**; the consumer enforces it.
This separation keeps the evaluator trivially auditable.

## Validator vs evaluator

- **`validatePolicyRuleBody(body, options?)`** runs at proposal time
  (Admin UI / API / repo). It accumulates ALL errors and uses 15 stable
  codes (`PolicyValidationErrorCode`).
- **`evaluate`** runs at request time on the hot path. It short-circuits on
  the first structural fault and uses 10 stable codes
  (`PolicyEvaluationErrorCode`). It NEVER throws.

The two enums are intentionally distinct: validation errors are a UX
surface (author needs the full picture); evaluation errors are an ops
surface (need to trace which rule went inert and why).

### Optional field-path allowlist

P9b's Decision Engine knows which fields its Early/Mid/Late
`EvaluationContext` shapes will expose. It can pass that set to the
validator at proposal time so a rule targeting an unknown field is
rejected immediately:

```ts
import { validatePolicyRuleBody } from '@/governance/policy-dsl';

const result = validatePolicyRuleBody(body, {
  allowedFieldPaths: new Set([
    'channel', 'user.role', 'risk_score', 'message', // ... etc
  ]),
});
// → if (!result.ok) errors contain 'unknown_field_path' for any path not in the set
```

The allowlist is **opt-in**. Default behaviour is permissive (shape checks
only) so the public surface stays stable for tests and ad-hoc validation.
P9b is the canonical caller that passes the strict set.

## How to debug an "inert" decision in production

A `decision.matched === false` with non-empty `decision.errors` means:

1. The rule body is structurally invalid (validator should have caught it
   at proposal time — file a bug if it slipped through).
2. The field path is too deep / the regex pattern is unsafe / the input
   is too long. Remediate in the rule itself.

Sample triage:

```ts
import { evaluate } from '@/governance/policy-dsl';
const decision = evaluate(rule.rule_body, ctx);
if (!decision.matched && decision.errors.length > 0) {
  console.error('policy went inert', {
    rule_id: rule.id,
    codes: decision.errors.map((e) => e.code),
    paths: decision.errors.map((e) => e.path),
  });
}
```

## Performance budget

The benchmark (`tests/benchmark/policy-dsl.bench.spec.ts`) measures three
workloads. Local runs MUST clear:

| Workload | Target p99 | Notes |
|---|---|---|
| `simple_leaf` | < 1 ms | typical PEP single-rule eval |
| `realistic_mixed` | < 1 ms | typical 3-clause rule with one regex |
| `deep_match` | < 1 ms | depth-12 AND with regex tail |

Recent local results (Node 20+, Windows 10): < 6 µs p99 for all three —
~150x under the budget.

## What this does NOT do

- **Does not enforce effects.** That is the consumer's job (P9b Decision
  Engine maps `effect.action` → block/warn/escalate).
- **Does not load `policy_rules` rows.** That is P8e's
  `PolicyDescriptorResolver`.
- **Does not maintain a history of evaluations.** That is P10b Trace.
- **Does not support arbitrary user-defined operators.** Adding one
  requires Architecture Lock change.

## Operations

### Cache stats

`getRegexCacheStats()` returns `{hits, misses, compiled, evicted, size}`.
Tap this in a debug endpoint or log if you suspect cache thrashing.

### Reset cache (test only)

`resetRegexCache()` clears the cache and zeros stats. Used by tests; do
not call from production.

### Adding a new operator

1. Update `PolicyOperator` in `types.ts`.
2. Add to `ALLOWED_OPERATORS` in `constants.ts`.
3. Add a case in `applyOperator` (`evaluator.ts`) — must be total.
4. Add validator behaviour in `validateLeaf` (`validator.ts`) if op-specific
   shape constraints apply.
5. Update unit tests + property tests.
6. Get founder sign-off (Architecture Lock change).

### Adding a new effect action

1. Update `PolicyEffectAction` in `types.ts`.
2. Add to `ALLOWED_EFFECT_ACTIONS` in `constants.ts`.
3. Update validator tests.
4. Update consumer (P9b) to handle the new action.
5. Architecture Lock change — founder approval required.
