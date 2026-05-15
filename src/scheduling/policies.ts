/**
 * Spec 18 §6 — missed_run_policy application.
 *
 * Called by the engine when claiming overdue occurrences (scheduled_for <
 * now() - staleness_threshold_hours). Returns a decision:
 *   - 'fire' — proceed normally (the engine acts on the occurrence)
 *   - 'skip_and_audit' — mark aged_out, write audit
 *   - 'escalate_owner' — mark aged_out, enqueue an alert to the owner
 *
 * For `fire_latest_only`, the engine must call this once per series to
 * decide which one of the overdue occurrences in a series gets to fire
 * (the latest scheduled_for) — the rest are skipped.
 */

import type { MissedRunPolicy, OccurrenceStatus } from './types.js';
import type { Occurrence } from '@/db/schema.js';

export type MissedRunDecision =
  | { kind: 'fire' }
  | { kind: 'skip_and_audit' }
  | { kind: 'escalate_owner' };

/**
 * Decide what to do with a SINGLE overdue occurrence, given the policy
 * AND the list of all overdue occurrences in the same series (so
 * `fire_latest_only` knows which is "latest").
 */
export function decideMissedRun(
  occurrence: Pick<Occurrence, 'id' | 'scheduled_for' | 'series_id'>,
  overdueSiblings: ReadonlyArray<Pick<Occurrence, 'id' | 'scheduled_for'>>,
  policy: MissedRunPolicy,
): MissedRunDecision {
  switch (policy) {
    case 'fire_all':
      return { kind: 'fire' };
    case 'skip_all':
      return { kind: 'skip_and_audit' };
    case 'escalate_to_owner':
      return { kind: 'escalate_owner' };
    case 'fire_latest_only': {
      const latest = overdueSiblings.reduce(
        (acc, cur) => (cur.scheduled_for.getTime() > acc.scheduled_for.getTime() ? cur : acc),
        overdueSiblings[0]!,
      );
      return occurrence.id === latest.id ? { kind: 'fire' } : { kind: 'skip_and_audit' };
    }
  }
}

export function isOverdue(scheduled_for: Date, staleness_hours: number, now: Date = new Date()): boolean {
  return now.getTime() - scheduled_for.getTime() > staleness_hours * 3600_000;
}

export type AgedOutStatus = Extract<OccurrenceStatus, 'aged_out'>;
export const AGED_OUT: AgedOutStatus = 'aged_out';
