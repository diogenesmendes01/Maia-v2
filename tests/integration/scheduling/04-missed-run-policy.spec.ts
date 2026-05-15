/**
 * Spec 18 §13 — Acceptance test for Requirement 4.
 *
 * Simulates 5 days of downtime with three overdue occurrences for the
 * same series. Each `missed_run_policy` value must produce the documented
 * audit + fire pattern.
 */

import { describe, it, expect } from 'vitest';
import { decideMissedRun } from '../../../src/scheduling/policies.js';

const occs = [
  { id: 'o1', series_id: 's1', scheduled_for: new Date('2026-05-06T12:00:00Z') },
  { id: 'o2', series_id: 's1', scheduled_for: new Date('2026-05-07T12:00:00Z') },
  { id: 'o3', series_id: 's1', scheduled_for: new Date('2026-05-08T12:00:00Z') },
];

describe('Requirement 4 — missed_run_policy after multi-day downtime', () => {
  it('fire_all: every overdue occurrence fires (chronological)', () => {
    const decisions = occs.map((o) => decideMissedRun(o, occs, 'fire_all'));
    expect(decisions.every((d) => d.kind === 'fire')).toBe(true);
  });

  it('fire_latest_only: only the newest fires; older two are aged_skipped', () => {
    const decisions = occs.map((o) => decideMissedRun(o, occs, 'fire_latest_only'));
    expect(decisions[0]!.kind).toBe('skip_and_audit');
    expect(decisions[1]!.kind).toBe('skip_and_audit');
    expect(decisions[2]!.kind).toBe('fire');
  });

  it('skip_all: every overdue is aged_skipped, none fires', () => {
    const decisions = occs.map((o) => decideMissedRun(o, occs, 'skip_all'));
    expect(decisions.every((d) => d.kind === 'skip_and_audit')).toBe(true);
  });

  it('escalate_to_owner: every overdue triggers an owner alert', () => {
    const decisions = occs.map((o) => decideMissedRun(o, occs, 'escalate_to_owner'));
    expect(decisions.every((d) => d.kind === 'escalate_owner')).toBe(true);
  });

  it('single-overdue case: fire_latest_only fires the only one', () => {
    const single = [{ id: 'o-only', series_id: 's1', scheduled_for: new Date() }];
    const decision = decideMissedRun(single[0]!, single, 'fire_latest_only');
    expect(decision.kind).toBe('fire');
  });
});
