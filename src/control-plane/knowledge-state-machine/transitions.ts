/**
 * P10a — Knowledge State Machine allowed transitions table.
 *
 * Architecture Lock (master §0.1): mudança nesta tabela exige aprovação
 * do founder via CODEOWNERS. Property tests
 * (__tests__/no-path-revoked-to-active.property.spec.ts) garantem que
 * 'revoked' permaneça terminal e que verified/active nunca regridam.
 */

import type { KnowledgeLifecycleStatus } from './types.js';

/**
 * Canonical table of valid lifecycle transitions.
 *
 *  - 'proposed' is a transit state — rows never persist with this status;
 *    decideInitialStatus() routes immediately to either pending_review
 *    or ephemeral as part of the same propose() call.
 *  - 'revoked' is terminal absolute. No transition out is permitted.
 *  - 'verified' and 'active' enforce no-downgrade (only deprecated/revoked).
 */
export const ALLOWED_TRANSITIONS: Record<
  KnowledgeLifecycleStatus,
  KnowledgeLifecycleStatus[]
> = {
  proposed: ['pending_review', 'ephemeral'],
  pending_review: ['active', 'verified', 'revoked'],
  ephemeral: ['observed', 'deprecated', 'revoked'],
  observed: ['reinforced', 'deprecated', 'revoked'],
  reinforced: ['verified', 'deprecated', 'revoked'],
  verified: ['active', 'deprecated', 'revoked'],
  active: ['deprecated', 'revoked'],
  deprecated: ['revoked'],
  revoked: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: KnowledgeLifecycleStatus,
    public readonly to: KnowledgeLifecycleStatus,
  ) {
    super(`Illegal knowledge lifecycle transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertAllowedTransition(
  from: KnowledgeLifecycleStatus,
  to: KnowledgeLifecycleStatus,
): void {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) throw new IllegalTransitionError(from, to);
}
