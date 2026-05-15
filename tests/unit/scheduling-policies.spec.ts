import { describe, it, expect } from 'vitest';
import { decideMissedRun, isOverdue } from '../../src/scheduling/policies.js';

const mkOcc = (id: string, iso: string) => ({
  id,
  series_id: 's1',
  scheduled_for: new Date(iso),
});

describe('decideMissedRun — Requirement 4', () => {
  const olderToNewer = [
    mkOcc('o1', '2026-01-10T12:00:00Z'),
    mkOcc('o2', '2026-02-10T12:00:00Z'),
    mkOcc('o3', '2026-03-10T12:00:00Z'),
  ];

  it('fire_all: every overdue fires', () => {
    for (const occ of olderToNewer) {
      expect(decideMissedRun(occ, olderToNewer, 'fire_all')).toEqual({ kind: 'fire' });
    }
  });

  it('skip_all: every overdue is audit+skip', () => {
    for (const occ of olderToNewer) {
      expect(decideMissedRun(occ, olderToNewer, 'skip_all')).toEqual({ kind: 'skip_and_audit' });
    }
  });

  it('escalate_to_owner: every overdue is escalate', () => {
    for (const occ of olderToNewer) {
      expect(decideMissedRun(occ, olderToNewer, 'escalate_to_owner')).toEqual({
        kind: 'escalate_owner',
      });
    }
  });

  it('fire_latest_only: only the most recent overdue fires; older are skip+audit', () => {
    const decisions = olderToNewer.map((o) => decideMissedRun(o, olderToNewer, 'fire_latest_only'));
    expect(decisions[0]).toEqual({ kind: 'skip_and_audit' });
    expect(decisions[1]).toEqual({ kind: 'skip_and_audit' });
    expect(decisions[2]).toEqual({ kind: 'fire' });
  });

  it('isOverdue: bounded by staleness threshold', () => {
    const now = new Date('2026-05-11T12:00:00Z');
    expect(isOverdue(new Date('2026-05-11T11:30:00Z'), 24, now)).toBe(false);
    expect(isOverdue(new Date('2026-05-10T11:00:00Z'), 24, now)).toBe(true);
  });
});
