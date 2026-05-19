/**
 * P9d Policy DSL — Caller-side enforcement (Architecture Lock).
 *
 * The evaluator is **pure data**: it tells you what happened (`matched`,
 * `not_matched`, `not_applicable`, `evaluation_error`) but does NOT decide
 * what the calling Policy Enforcement Point (PEP) should do. This module
 * holds the **canonical mapping** from `PolicyOutcome` → enforcement
 * action that every PEP MUST follow.
 *
 * # Why an explicit helper instead of "just check `matched`"
 *
 * Collapsing the tri-state outcome into a boolean is unsafe:
 *
 *   if (decision.matched) block();   // ❌ silently ignores `evaluation_error`
 *
 * `evaluation_error` means the evaluator could not produce a sound answer
 * (ordinal op vs missing field, malformed runtime body, regex compile
 * failure, invalid effect). Ignoring it lets a corrupted policy or schema
 * drift turn into an implicit allow — exactly the security boundary Codex
 * review #98 flagged. PEPs MUST fail-closed.
 *
 * # The canonical mapping
 *
 *  | Outcome             | Default PEP action          | Audit |
 *  |---------------------|------------------------------|-------|
 *  | `matched`           | apply `decision.effect`     | always |
 *  | `not_matched`       | rule did not fire (no-op)   | optional |
 *  | `not_applicable`    | rule did not fire (no-op)   | always |
 *  | `evaluation_error`  | **BLOCK** (default-safe)    | always |
 *
 * `not_applicable` is a no-op (the rule didn't fire because its context
 * wasn't present), but it MUST be audited — drifting field names that turn
 * every policy into `not_applicable` is a regression worth catching.
 *
 * `evaluation_error` MUST surface a structured `EnforcementBlock` with a
 * stable `block_reason` so callers can render a deterministic error to the
 * user and log a high-priority ops alert.
 *
 * # Architecture Lock
 *
 * The shape of `EnforcementAction`, the `enforce()` mapping, and the
 * invariant that `evaluation_error` → BLOCK are all founder-locked. A test
 * (`tests/unit/policy-dsl-enforcement.spec.ts`) statically enforces that
 * `evaluation_error` cannot legally produce an "allow" action — if a PEP
 * does this it'll be caught at PR time.
 */

import type { PolicyDecision, PolicyEffect } from './types.js';

/**
 * The decision the PEP must execute. `kind` is the load-bearing field —
 * downstream code (channel adapter, agent loop, dispatcher) MUST switch on
 * it. There is no path from `evaluation_error` to `kind === 'allow'`.
 */
export type EnforcementAction =
  | {
      /** Rule matched and the effect was a permissive action. */
      kind: 'allow';
      reason: 'matched_allow';
      effect: PolicyEffect;
    }
  | {
      /** Rule matched and the effect was deny-style (block/dual-approval). */
      kind: 'block';
      reason: 'matched_block';
      effect: PolicyEffect;
    }
  | {
      /** Rule matched and effect was advisory (warn/log). */
      kind: 'observe';
      reason: 'matched_observe';
      effect: PolicyEffect;
    }
  | {
      /** Rule did not fire (clean false or absent context). */
      kind: 'pass';
      reason: 'not_matched' | 'not_applicable';
    }
  | {
      /**
       * Evaluator could not produce a sound answer. PEP MUST BLOCK and
       * surface this in audit + ops alerting. NEVER fall through to "allow".
       */
      kind: 'block';
      reason: 'evaluation_error';
      /** Stable codes for ops triage. */
      error_codes: string[];
    };

/**
 * Map a `PolicyDecision` to its canonical `EnforcementAction`. This is the
 * single helper every PEP MUST use; PEPs that hand-roll the mapping risk
 * the silent-allow class of bugs Codex #98 flagged.
 *
 * The function is pure and total.
 */
export function enforce(decision: PolicyDecision): EnforcementAction {
  switch (decision.outcome) {
    case 'matched': {
      // We trust `effect` here because `evaluate()` already re-validated it
      // (invalid effects force `evaluation_error`, never reach this branch).
      // Defensive: if a caller hand-builds a decision with outcome=matched
      // but no effect (synthetic test fixtures, mock data), fail-closed.
      const effect = decision.effect;
      if (!effect || typeof effect !== 'object') {
        return {
          kind: 'block',
          reason: 'evaluation_error',
          error_codes: ['invalid_effect'],
        };
      }
      switch (effect.action) {
        case 'allow':
          return { kind: 'allow', reason: 'matched_allow', effect };
        case 'block':
        case 'require_dual_approval':
          return { kind: 'block', reason: 'matched_block', effect };
        case 'warn':
        case 'log':
          return { kind: 'observe', reason: 'matched_observe', effect };
        default:
          // Unreachable: validator + runtime re-check both exhaust the enum.
          // Defensive: treat unknown actions as BLOCK to fail-closed.
          return {
            kind: 'block',
            reason: 'evaluation_error',
            error_codes: ['invalid_effect'],
          };
      }
    }
    case 'not_matched':
      return { kind: 'pass', reason: 'not_matched' };
    case 'not_applicable':
      return { kind: 'pass', reason: 'not_applicable' };
    case 'evaluation_error':
      return {
        kind: 'block',
        reason: 'evaluation_error',
        error_codes: decision.errors.map((e) => e.code),
      };
    default: {
      // Unreachable: outcome is a closed union. Defensive: BLOCK.
      const _exhaustive: never = decision.outcome;
      void _exhaustive;
      return {
        kind: 'block',
        reason: 'evaluation_error',
        error_codes: ['malformed_predicate'],
      };
    }
  }
}
