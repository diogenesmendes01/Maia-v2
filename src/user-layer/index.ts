// ────────────────────────────────────────────────────────────
// P8c: User Layer Namespace — Public Facade Exports
// ────────────────────────────────────────────────────────────

// Type definitions
export type { UserDepth, KnowledgeDepth, KnowledgeLifecycleStatus, UserSlice, KnowledgeSlice } from './types.js';

// Resolvers (facade over 5 tables)
export { memoryResolver } from './resolvers/memory-resolver.js';
export { factsResolver } from './resolvers/facts-resolver.js';
export { rulesResolver } from './resolvers/rules-resolver.js';
export { hintsResolver } from './resolvers/hints-resolver.js';
export { interlocutorResolver } from './resolvers/interlocutor-resolver.js';

// Slice builders (orchestrate resolvers)
export {
  buildUserSlice,
  type BuildUserSliceOutput,
} from './user-slice-builder.js';
export {
  buildKnowledgeSlice,
  type BuildKnowledgeSliceOutput,
} from './knowledge-slice-builder.js';

// Internal utilities (for testing / advanced usage)
export { isVisibleLifecycle, isVisible } from './internal/visibility.js';
export { getUserMaxItems, getKnowledgeMaxes } from './internal/depth-mapping.js';
export { buildUserSliceCacheKey, buildKnowledgeSliceCacheKey } from './internal/cache-keys.js';
