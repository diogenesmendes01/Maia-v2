/**
 * P10a — KnowledgeStateMachine class.
 *
 * Architecture Lock (master §0.1): the decideInitialStatus rules and
 * the propose/transition/revoke contracts are under founder approval
 * via CODEOWNERS.
 *
 * Public API (master §4.1):
 *   - KnowledgeStateMachine.propose(input)    → ephemeral | pending_review
 *   - KnowledgeStateMachine.transition(args)  → validate + append + persist
 *   - KnowledgeStateMachine.revoke(args)      → short-circuit to revoked
 *
 * All three are wrapped in runCognitiveModule (P1 invariant). The
 * propose path falls back to pending_review on scorer timeout — the
 * fail-safe is always the most conservative state.
 */

import { runCognitiveModule } from '@/cognition/runner.js';
import { logger } from '@/lib/logger.js';
import { knowledgeRepos, KnowledgeConflictError } from './repos.js';
import { KnowledgeRiskScorer } from './risk-scorer.js';
import {
  assertAllowedTransition,
  IllegalTransitionError,
} from './transitions.js';
import type {
  KnowledgeKind,
  KnowledgeLifecycleStatus,
  KnowledgeProposalInput,
  KnowledgeProposeResult,
  KnowledgeRevokeInput,
  KnowledgeRevokeResult,
  KnowledgeRiskLevel,
  KnowledgeSensitivity,
  KnowledgeTransitionInput,
  KnowledgeTransitionRecord,
  KnowledgeTransitionResult,
} from './types.js';
import { VISIBLE_STATES } from './visibility.js';

/**
 * Master §2.6 — initial-state decision rules in strict order:
 *
 *   1. kind='rule' → always pending_review (non-negotiable).
 *   2. risk='high' or 'critical' → pending_review.
 *   3. sensitivity='high' → pending_review.
 *   4. risk='medium' → pending_review.
 *   5. risk='low' AND confidence >= 0.6 AND kind ∈ {fact,memory,hint} → ephemeral.
 *   6. otherwise (low confidence, etc.) → pending_review (conservative default).
 */
export function decideInitialStatus(args: {
  kind: KnowledgeKind;
  risk_level: KnowledgeRiskLevel;
  sensitivity: KnowledgeSensitivity;
  confidence: number;
}): KnowledgeLifecycleStatus {
  if (args.kind === 'rule') return 'pending_review';
  if (args.risk_level === 'high' || args.risk_level === 'critical') {
    return 'pending_review';
  }
  if (args.sensitivity === 'high') return 'pending_review';
  if (args.risk_level === 'medium') return 'pending_review';
  if (args.risk_level === 'low' && args.confidence >= 0.6) return 'ephemeral';
  return 'pending_review';
}

export class KnowledgeStateMachine {
  /**
   * Propose new knowledge.
   *
   * Routes through KnowledgeRiskScorer + decideInitialStatus rules,
   * then persists a row with lifecycle_status ∈ {ephemeral, pending_review}
   * (NEVER 'active' through this path). The single transition record
   * appended at creation records the risk score so Admin UI can show it
   * and the audit trail explains the decision.
   *
   * Timeout policy (Codex review round-2, finding 3):
   *   - The 300ms timeout wraps ONLY the risk scorer, not the DB insert.
   *   - On scorer timeout, fall back to a conservative HIGH-RISK score
   *     (forces pending_review) and continue with the insert
   *     synchronously — so the row really exists when we return.
   *   - The DB insert is NOT wrapped in `Promise.race`; if it throws,
   *     we propagate the error and DO NOT return a synthetic empty-id
   *     success. Returning `proposal_id: ''` would let callers
   *     audit/cache a nonexistent row.
   */
  static async propose(
    input: KnowledgeProposalInput,
  ): Promise<KnowledgeProposeResult> {
    // Step 1 — score risk under a 300ms budget. On timeout/error we
    // synthesise a conservative score so decideInitialStatus routes to
    // pending_review (master §14 — fail-safe is conservative).
    const scoreResult = await runCognitiveModule(
      {
        name: 'knowledge-state-machine.propose.score',
        version: 'v1',
        triggered_by: 'sync_required',
        timeoutMs: 300,
        fallback: () => ({
          level: 'high' as const,
          sensitivity: input.sensitivity_hint ?? ('high' as const),
          reasons: ['scorer_fallback:timeout_or_error'],
          source: 'cache' as const,
        }),
      },
      async () =>
        KnowledgeRiskScorer.score({
          trace_id: input.trace_id,
          tenant_id: input.tenant_id,
          agent_id: input.agent_id,
          kind: input.kind,
          scope: input.scope,
          content_text: input.content_text,
          confidence: input.confidence,
          origin: input.origin,
          proposer_sensitivity_hint: input.sensitivity_hint,
        }),
    );

    // runCognitiveModule guarantees non-null when fallback is provided.
    const risk = scoreResult.output!;
    const fellBack = scoreResult.fallback_triggered;

    // Step 2 — decide initial status from (possibly fallback) risk.
    const initial_status = decideInitialStatus({
      kind: input.kind,
      risk_level: risk.level,
      sensitivity: risk.sensitivity,
      confidence: input.confidence,
    });

    const transition: KnowledgeTransitionRecord = {
      from: 'proposed',
      to: initial_status,
      at: new Date().toISOString(),
      reason: fellBack
        ? `scorer_fallback;kind=${input.kind};confidence=${input.confidence.toFixed(2)}`
        : `risk=${risk.level};kind=${input.kind};confidence=${input.confidence.toFixed(2)}`,
      decided_by: 'state_machine_propose',
      risk_score: {
        level: risk.level,
        sensitivity: risk.sensitivity,
        reasons: risk.reasons,
        source: risk.source,
      },
    };

    const evidence_count =
      input.origin === 'user_explicit' || input.origin === 'human_approved'
        ? 1
        : 0;

    // Step 3 — persist the row synchronously, outside the timeout race.
    // If the DB insert fails we throw — never return success with an
    // empty proposal_id (Codex finding 3).
    const proposal_id = await knowledgeRepos.create({
      tenant_id: input.tenant_id,
      agent_id: input.agent_id,
      kind: input.kind,
      key: input.key,
      scope: input.scope,
      scope_value: input.scope_value,
      content: input.content,
      content_text: input.content_text,
      confidence: input.confidence,
      lifecycle_status: initial_status,
      lifecycle_transitions: [transition],
      evidence_count,
      ttl_days: input.ttl_days,
      native: input.native,
    });

    if (!proposal_id) {
      // Defensive — knowledgeRepos.create returns `String(rows[0]?.id ?? '')`,
      // so an empty string indicates the INSERT … RETURNING returned no
      // rows. Treat as hard failure to honour finding 3.
      throw new Error('knowledge_state_machine.propose:insert_returned_empty_id');
    }

    return {
      proposal_id,
      initial_status,
      visible_to_llm: VISIBLE_STATES.includes(initial_status),
      reason: fellBack
        ? `fallback:scorer_${scoreResult.status} | kind=${input.kind} | conf=${input.confidence.toFixed(2)}`
        : `risk=${risk.level} | kind=${input.kind} | conf=${input.confidence.toFixed(2)}`,
    };
  }

  /**
   * Apply an explicit lifecycle transition (auto-promoter, human
   * approval, etc.). Append-only on lifecycle_transitions; validated
   * via ALLOWED_TRANSITIONS (throws IllegalTransitionError if invalid).
   *
   * Concurrency: uses optimistic locking via
   * `expected_previous_status`. If another writer transitioned the row
   * in between the read and the write (e.g. a parallel revoke), the
   * conditional UPDATE affects 0 rows and we throw
   * IllegalTransitionError describing the now-current status. The
   * caller is expected to drop the proposed transition — re-reading
   * could lead to indefinite retries against a moving target. Workers
   * (auto-promoter) treat IllegalTransitionError on parallel-promote
   * races as benign; human-driven paths surface it to the operator.
   */
  static async transition(
    args: KnowledgeTransitionInput,
  ): Promise<KnowledgeTransitionResult> {
    const current = await knowledgeRepos.findById(args.kind, args.proposal_id);
    if (!current) {
      throw new Error(
        `knowledge_not_found:${args.kind}:${args.proposal_id}`,
      );
    }

    // Validates ALLOWED_TRANSITIONS table — throws IllegalTransitionError
    // for any path that violates no-downgrade or revoked-terminal.
    assertAllowedTransition(current.lifecycle_status, args.to);

    const transition: KnowledgeTransitionRecord = {
      from: current.lifecycle_status,
      to: args.to,
      at: new Date().toISOString(),
      reason: args.reason,
      decided_by: args.decided_by,
      ...(args.evidence_id !== undefined
        ? { evidence_id: args.evidence_id }
        : {}),
    };

    try {
      await knowledgeRepos.update(args.kind, args.proposal_id, {
        lifecycle_status: args.to,
        lifecycle_transitions: [...current.lifecycle_transitions, transition],
        expected_previous_status: current.lifecycle_status,
      });
    } catch (err) {
      if (err instanceof KnowledgeConflictError) {
        // Re-read to surface what the row actually became — this lets
        // workers tell apart "already promoted by sibling" from "human
        // revoked under us" and skip vs. raise accordingly.
        const fresh = await knowledgeRepos.findById(
          args.kind,
          args.proposal_id,
        );
        const now = fresh?.lifecycle_status ?? current.lifecycle_status;
        logger.warn(
          {
            proposal_id: args.proposal_id,
            kind: args.kind,
            expected_from: current.lifecycle_status,
            observed_now: now,
            attempted_to: args.to,
            decided_by: args.decided_by,
          },
          'knowledge_state_machine.transition.conflict',
        );
        // Translate to IllegalTransitionError so existing callers
        // (auto-promoter catches IllegalTransitionError as benign) stay
        // unchanged.
        throw new IllegalTransitionError(now, args.to);
      }
      throw err;
    }

    logger.info(
      {
        proposal_id: args.proposal_id,
        kind: args.kind,
        from: current.lifecycle_status,
        to: args.to,
        reason: args.reason,
        decided_by: args.decided_by,
      },
      'knowledge_state_machine.transition',
    );

    return transition;
  }

  /**
   * Short-circuit revoke from any state → 'revoked'. Revoked is a
   * terminal absolute. Calling revoke on an already-revoked row is
   * an idempotent no-op (returns a synthetic record marking the
   * existing state).
   *
   * Concurrency (issue #256 — revalidation of PR #243):
   *   Under 3+ concurrent actors mutating the same row, the previous
   *   single-shot retry could lose the race: writer A revokes, writer B
   *   transitions back to active, writer C (our revoke) re-reads
   *   `active`, then writer A revokes again before C's retry lands —
   *   C's retry sees `revoked` again and throws KnowledgeConflictError
   *   to the caller, breaking the idempotency contract.
   *
   *   Fix: bounded retry loop. Up to MAX_REVOKE_RETRIES attempts; on
   *   each conflict we re-read the row, short-circuit if it's already
   *   `revoked`, otherwise try again against the freshly observed
   *   status. Small exponential backoff (10ms, 30ms) absorbs the
   *   contention window without unbounded waits. If MAX_REVOKE_RETRIES
   *   is exhausted (continuous concurrent mutation), the final
   *   KnowledgeConflictError surfaces to the caller — at that point the
   *   row is being mutated so aggressively that the caller needs to
   *   decide whether to give up or wrap in its own retry.
   *
   *   Audit-emit semantics: we log ONCE at the end of the call (after
   *   success or after the early-exit idempotent branch). No
   *   double-emit on retry; the `attempts` field records how many tries
   *   it took to land.
   */
  static async revoke(
    args: KnowledgeRevokeInput,
  ): Promise<KnowledgeRevokeResult> {
    const MAX_REVOKE_RETRIES = 3;

    const current = await knowledgeRepos.findById(args.kind, args.proposal_id);
    if (!current) {
      throw new Error(
        `knowledge_not_found:${args.kind}:${args.proposal_id}`,
      );
    }

    if (current.lifecycle_status === 'revoked') {
      return {
        from: 'revoked',
        to: 'revoked',
        at: current.updated_at.toISOString(),
        reason: 'already_revoked',
        decided_by: 'idempotent',
      };
    }

    let observed = current;
    let lastConflict: KnowledgeConflictError | undefined;

    for (let attempt = 0; attempt < MAX_REVOKE_RETRIES; attempt++) {
      const transition: KnowledgeTransitionRecord = {
        from: observed.lifecycle_status,
        to: 'revoked',
        at: new Date().toISOString(),
        reason: args.reason,
        decided_by: args.decided_by,
      };

      try {
        await knowledgeRepos.update(args.kind, args.proposal_id, {
          lifecycle_status: 'revoked',
          lifecycle_transitions: [
            ...observed.lifecycle_transitions,
            transition,
          ],
          expected_previous_status: observed.lifecycle_status,
        });
        logger.warn(
          {
            proposal_id: args.proposal_id,
            kind: args.kind,
            from: observed.lifecycle_status,
            reason: args.reason,
            decided_by: args.decided_by,
            attempts: attempt + 1,
          },
          'knowledge_state_machine.revoked',
        );
        return transition;
      } catch (err) {
        if (!(err instanceof KnowledgeConflictError)) throw err;
        lastConflict = err;

        // Re-read to see what the row actually became.
        const fresh = await knowledgeRepos.findById(
          args.kind,
          args.proposal_id,
        );
        if (!fresh) {
          throw new Error(
            `knowledge_not_found:${args.kind}:${args.proposal_id}`,
            { cause: err },
          );
        }
        if (fresh.lifecycle_status === 'revoked') {
          // Concurrent revoke landed first — idempotent no-op.
          return {
            from: 'revoked',
            to: 'revoked',
            at: fresh.updated_at.toISOString(),
            reason: 'already_revoked_concurrent',
            decided_by: 'idempotent',
          };
        }
        observed = fresh;

        // Small exponential backoff between attempts (10ms, 30ms) to
        // absorb the contention window. No sleep after the last attempt
        // (we'll throw lastConflict).
        if (attempt < MAX_REVOKE_RETRIES - 1) {
          const delayMs = 10 * Math.pow(3, attempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    // MAX_REVOKE_RETRIES exhausted under continuous concurrent mutation.
    // Surface the last conflict so the caller can decide (e.g.
    // incident-response operators may want to retry manually; workers
    // typically skip and move on).
    logger.warn(
      {
        proposal_id: args.proposal_id,
        kind: args.kind,
        reason: args.reason,
        decided_by: args.decided_by,
        attempts: MAX_REVOKE_RETRIES,
      },
      'knowledge_state_machine.revoke_exhausted_retries',
    );
    throw lastConflict ?? new Error('knowledge_state_machine.revoke:unreachable');
  }
}

export { IllegalTransitionError };
