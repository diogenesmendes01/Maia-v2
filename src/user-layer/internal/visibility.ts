import type { KnowledgeLifecycleStatus } from '../types.js';
import { inArray, sql, type SQL } from 'drizzle-orm';

export const VISIBLE_LIFECYCLE_STATES: ReadonlyArray<KnowledgeLifecycleStatus> = [
  'ephemeral',
  'observed',
  'reinforced',
  'verified',
  'active',
];

/**
 * SQL predicate: lifecycle_status is in the visible set.
 * Use in WHERE clause when querying knowledge tables.
 */
export function isVisibleLifecycle<T extends { lifecycle_status: any }>(
  column: T['lifecycle_status'],
): SQL {
  return inArray(column, VISIBLE_LIFECYCLE_STATES);
}

/**
 * Runtime check: is this status visible in context?
 */
export function isVisible(status: KnowledgeLifecycleStatus): boolean {
  return VISIBLE_LIFECYCLE_STATES.includes(status);
}
