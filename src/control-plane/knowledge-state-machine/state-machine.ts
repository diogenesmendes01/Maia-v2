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
   * On scorer timeout or error, fallback is pending_review (master §14
   * — fail-safe is conservative).
   */
  static async propose(
    input: KnowledgeProposalInput,
  ): Promise<KnowledgeProposeResult> {
    const fallback: KnowledgeProposeResult = {
      proposal_id: '',
      initial_status: 'pending_review',
      visible_to_llm: false,
      reason: 'fallback:scorer_timeout',
    };

    const result = await runCognitiveModule<KnowledgeProposeResult>(
      {
        name: 'knowledge-state-machine.propose',
        version: 'v1',
        triggered_by: 'sync_required',
        timeoutMs: 300,
        fallback,
      },
      async () => {
        const risk = await KnowledgeRiskScorer.score({
          trace_id: input.trace_id,
          tenant_id: input.tenant_id,
          agent_id: input.agent_id,
          kind: input.kind,
          scope: input.scope,
          content_text: input.content_text,
          confidence: input.confidence,
          origin: input.origin,
          proposer_sensitivity_hint: input.sensitivity_hint,
        });

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
          reason: `risk=${risk.level};kind=${input.kind};confidence=${input.confidence.toFixed(2)}`,
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
        });

        return {
          proposal_id,
          initial_status,
          visible_to_llm: VISIBLE_STATES.includes(initial_status),
          reason: `risk=${risk.level} | kind=${input.kind} | conf=${input.confidence.toFixed(2)}`,
        };
      },
    );

    // runCognitiveModule guarantees a non-null output when fallback is
    // provided; the type system can't see that, so assert here.
    return result.output ?? fallback;
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
   */
  static async revoke(
    args: KnowledgeRevokeInput,
  ): Promise<KnowledgeRevokeResult> {
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

    const transition: KnowledgeTransitionRecord = {
      from: current.lifecycle_status,
      to: 'revoked',
      at: new Date().toISOString(),
      reason: args.reason,
      decided_by: args.decided_by,
    };

    // Revoke wins on conflict: if another writer transitioned the row
    // first, we re-read once. If the row is now revoked, treat as
    // idempotent. Otherwise, re-attempt the revoke against the newly
    // observed status — revoke is allowed from any non-terminal state,
    // so the second try succeeds (or the row was already revoked).
    try {
      await knowledgeRepos.update(args.kind, args.proposal_id, {
        lifecycle_status: 'revoked',
        lifecycle_transitions: [...current.lifecycle_transitions, transition],
        expected_previous_status: current.lifecycle_status,
      });
    } catch (err) {
      if (err instanceof KnowledgeConflictError) {
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
        // Retry against the new observed status. Revoke is allowed from
        // every non-terminal state in ALLOWED_TRANSITIONS, so the
        // second try will succeed unless another concurrent revoke
        // beat us again — in which case the re-read above catches it.
        const retryTransition: KnowledgeTransitionRecord = {
          from: fresh.lifecycle_status,
          to: 'revoked',
          at: new Date().toISOString(),
          reason: args.reason,
          decided_by: args.decided_by,
        };
        await knowledgeRepos.update(args.kind, args.proposal_id, {
          lifecycle_status: 'revoked',
          lifecycle_transitions: [
            ...fresh.lifecycle_transitions,
            retryTransition,
          ],
          expected_previous_status: fresh.lifecycle_status,
        });
        logger.warn(
          {
            proposal_id: args.proposal_id,
            kind: args.kind,
            from: fresh.lifecycle_status,
            reason: args.reason,
            decided_by: args.decided_by,
            retried: true,
          },
          'knowledge_state_machine.revoked',
        );
        return retryTransition;
      }
      throw err;
    }

    logger.warn(
      {
        proposal_id: args.proposal_id,
        kind: args.kind,
        from: current.lifecycle_status,
        reason: args.reason,
        decided_by: args.decided_by,
      },
      'knowledge_state_machine.revoked',
    );

    return transition;
  }
}

export { IllegalTransitionError };
