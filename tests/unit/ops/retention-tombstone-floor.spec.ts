/**
 * Issue #536 — the tombstone floor.
 *
 * The invariant these tests pin: a tombstone must outlive every artifact that
 * could still contain the row it says was deleted. Once it does not, restoring
 * a retained backup resurrects the data and the ledger is not there to stop it.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOMBSTONE_MIN_DAYS,
  evaluateTombstoneFloor,
  longestBackupRetentionDays,
} from '../../../src/ops/retention/tombstone-floor.js';

const evaluate = (tombstone: number | undefined, local: number, cloud: number) =>
  evaluateTombstoneFloor({
    tombstoneMinDays: tombstone,
    localBackupDays: local,
    cloudBackupDays: cloud,
  });

describe('longestBackupRetentionDays', () => {
  it('takes the longest of the two windows, whichever it is', () => {
    expect(longestBackupRetentionDays(7, 30)).toBe(30);
    expect(longestBackupRetentionDays(90, 30)).toBe(90);
  });

  it('tolerates a missing window instead of guessing zero', () => {
    expect(longestBackupRetentionDays(undefined, 30)).toBe(30);
    expect(longestBackupRetentionDays(7, undefined)).toBe(7);
    expect(longestBackupRetentionDays(undefined, undefined)).toBeUndefined();
  });
});

describe('the shipped default satisfies the invariant', () => {
  it('60 days clears the 7d local / 30d off-site pair the owner approved', () => {
    const v = evaluate(DEFAULT_TOMBSTONE_MIN_DAYS, 7, 30);
    expect(v.ok).toBe(true);
    expect(v.longest_backup_days).toBe(30);
  });
});

describe('the floor must EXCEED the longest backup window, not merely match it', () => {
  it('refuses an equal pair — both expire the same day', () => {
    // The subtle one: with equal windows an artifact restored in the hours
    // before the sweep finds a ledger that has already forgotten the deletion.
    expect(evaluate(30, 7, 30).ok).toBe(false);
  });

  it('accepts one day more', () => {
    expect(evaluate(31, 7, 30).ok).toBe(true);
  });

  it('reports the smallest floor that would work', () => {
    expect(evaluate(30, 7, 30).required_min_days).toBe(31);
  });
});

describe('raising a backup window breaks the invariant until the floor follows', () => {
  it('fires when the off-site window is raised past the floor', () => {
    // The scenario the boot rule exists for: someone raises off-site retention
    // to 90 days and nothing else changes.
    expect(evaluate(DEFAULT_TOMBSTONE_MIN_DAYS, 7, 90).ok).toBe(false);
  });

  it('fires when the LOCAL window is the long one', () => {
    // Unusual, but the invariant is about the longest window, not about S3.
    expect(evaluate(DEFAULT_TOMBSTONE_MIN_DAYS, 365, 30).ok).toBe(false);
  });

  it('clears again once the floor is raised to match', () => {
    expect(evaluate(91, 7, 90).ok).toBe(true);
  });
});

describe('unknown inputs are not a verdict', () => {
  it('stays silent when the floor is unset — the contract owns "is it set?"', () => {
    expect(evaluate(undefined, 7, 30).ok).toBe(true);
  });

  it('stays silent when neither backup window is known', () => {
    expect(
      evaluateTombstoneFloor({
        tombstoneMinDays: 1,
        localBackupDays: undefined,
        cloudBackupDays: undefined,
      }).ok,
    ).toBe(true);
  });
});
