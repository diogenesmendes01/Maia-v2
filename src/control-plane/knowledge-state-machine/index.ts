/**
 * P10a — Knowledge State Machine barrel export.
 *
 * Single canonical import surface for consumers (tools, workers,
 * admin UI). Do NOT re-export internal helpers (`normaliseRow`, etc.).
 */

export { KnowledgeStateMachine, decideInitialStatus } from './state-machine.js';
export {
  ALLOWED_TRANSITIONS,
  assertAllowedTransition,
  IllegalTransitionError,
} from './transitions.js';
export {
  knowledgeIsVisible,
  getVisibilityTable,
  VISIBLE_STATES,
} from './visibility.js';
export { knowledgeRepos, KnowledgeConflictError } from './repos.js';
export { KnowledgeRiskScorer } from './risk-scorer.js';

export type {
  KnowledgeKind,
  KnowledgeScope,
  KnowledgeLifecycleStatus,
  KnowledgeOrigin,
  KnowledgeSensitivity,
  KnowledgeRiskLevel,
  KnowledgeDecidedBy,
  KnowledgeProposalInput,
  KnowledgeProposeResult,
  KnowledgeTransitionInput,
  KnowledgeTransitionRecord,
  KnowledgeTransitionResult,
  KnowledgeRevokeInput,
  KnowledgeRevokeResult,
  KnowledgeRow,
  KnowledgeVisibilityContext,
  KnowledgeVisibilityResult,
} from './types.js';
