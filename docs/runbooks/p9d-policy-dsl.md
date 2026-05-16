# P9d — Policy DSL Evaluator Runbook

## What this is

A **pure, total, ReDoS-safe** evaluator for the JSONB body stored in
`policy_rules.rule_body` (P8e). Given a `PolicyRuleBody` and an arbitrary
context object, returns a `PolicyDecision` describing whether the policy
matched and what effect the consumer (P9b Decision Engine) must apply.

- **Lives in:** `src/governance/policy-dsl/`
- **Public surface:** `evaluate`, `validatePolicyRuleBody`, plus types
- **Used by (consumers):** P9b Decision Engine (Early/Mid/Late PEPs); future
  Admin UI proposal-time validation; any code that needs to test a policy
  against context.

## Hard guarantees (Architecture Lock)

| Property | Guarantee | Where |
|---|---|---|
| Pure | No I/O, no `Date.now()`, no mutation of inputs | `evaluator.ts` |
| Total | Never throws — every error is captured in `decision.errors` | All paths |
| Deterministic | Identical inputs → byte-identical decisions | Verified via property test |
| Bounded depth | `MAX_PREDICATE_DEPTH = 16` | `constants.ts` |
| Bounded field path | `MAX_FIELD_PATH_DEPTH = 16` | `constants.ts` |
| ReDoS safe | `safe-regex2` static check + 4096-char input cap | `regex-cache.ts` |
| LRU regex cache | `REGEX_CACHE_MAX = 256` | `regex-cache.ts` |

Changing any of these requires founder approval (master spec §0.1).

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

- **`validatePolicyRuleBody`** runs at proposal time (Admin UI / API / repo).
  It accumulates ALL errors and uses 14 stable codes
  (`PolicyValidationErrorCode`).
- **`evaluate`** runs at request time on the hot path. It short-circuits on
  the first structural fault and uses 7 stable codes
  (`PolicyEvaluationErrorCode`). It NEVER throws.

The two enums are intentionally distinct: validation errors are a UX
surface (author needs the full picture); evaluation errors are an ops
surface (need to trace which rule went inert and why).

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
