import type { KnowledgeLifecycleStatus } from '../types.js';
import { inArray, type SQL, type SQLWrapper, type Column } from 'drizzle-orm';

/**
 * Knowledge State Machine (KSM) — states that ARE visible in agent context.
 *
 * Master spec §8 keeps 9 states; only 5 may be exposed to the LLM:
 * - `proposed` / `pending_review` — awaiting decision; never seen as truth.
 * - `deprecated` / `revoked`      — superseded or removed; not contextable.
 * - `ephemeral` / `observed` / `reinforced` / `verified` / `active` — visible.
 *
 * The DEFAULT for new rows is `'active'`, which is in the visible set.
 * P10a will add auto-evolution (active → reinforced → verified) using
 * `evidence_count`; P8c only wires the visibility gate.
 */
export const VISIBLE_LIFECYCLE_STATES: ReadonlyArray<KnowledgeLifecycleStatus> = [
  'ephemeral',
  'observed',
  'reinforced',
  'verified',
  'active',
];

/**
 * SQL predicate: lifecycle_status is in the visible set.
 * Use in WHERE clause when querying knowledge tables (memory_entry,
 * agent_facts, learned_rules, behavioral_hint).
 */
export function isVisibleLifecycle(column: Column | SQLWrapper): SQL {
  return inArray(column, VISIBLE_LIFECYCLE_STATES as readonly KnowledgeLifecycleStatus[]);
}

/**
 * Runtime check: is this status visible in context?
 */
export function isVisible(status: KnowledgeLifecycleStatus): boolean {
  return (VISIBLE_LIFECYCLE_STATES as readonly string[]).includes(status);
}
