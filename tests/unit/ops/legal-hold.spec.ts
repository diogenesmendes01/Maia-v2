import { describe, it, expect } from 'vitest';
import {
  evaluateHold,
  assertPurgeAllowed,
  holdRaceLockKey,
  requiresReevaluationAfterRelease,
  type HoldRecord,
  type HoldQuery,
} from '../../../src/ops/retention/legal-hold.js';

/**
 * Issue #520 §11 — "hold ativo bloqueia purge aplicável"; "corrida hold versus
 * purge possui lock/ordenação determinística"; "release não dispara deleção
 * imediata sem reavaliação".
 */

const NOW = new Date('2026-07-28T12:00:00.000Z');

function hold(over: Partial<HoldRecord> = {}): HoldRecord {
  return {
    id: 'hold-1',
    tenant_id: 'acme',
    agent_id: 'acme-main',
    data_class: 'postgres.messages',
    subject_ref: null,
    status: 'active',
    effective_from: new Date('2026-07-01T00:00:00.000Z'),
    effective_until: null,
    reason_code: 'litigation',
    ...over,
  };
}

function query(over: Partial<HoldQuery> = {}): HoldQuery {
  return {
    tenant_id: 'acme',
    agent_id: 'acme-main',
    data_class: 'postgres.messages',
    subject_ref: null,
    at: NOW,
    ...over,
  };
}

describe('scope guard — fail closed', () => {
  it.each(['', '  ', ' acme '])('rejects a malformed tenant_id (%p)', (bad) => {
    expect(() => evaluateHold([], query({ tenant_id: bad }))).toThrowError(
      /requires a non-empty, trimmed tenant_id/,
    );
  });

  it('rejects the legacy `default` sentinel outright', () => {
    expect(() => evaluateHold([], query({ tenant_id: 'default' }))).toThrowError(
      /refuses the legacy `default` sentinel/,
    );
    expect(() => evaluateHold([], query({ agent_id: 'default' }))).toThrowError(
      /refuses the legacy `default` sentinel/,
    );
  });

  it('rejects an invalid instant', () => {
    expect(() => evaluateHold([], query({ at: new Date('nope') }))).toThrowError(
      /requires a valid instant/,
    );
  });
});

describe('an active hold blocks the applicable purge', () => {
  it('matches an open-ended class hold', () => {
    const v = evaluateHold([hold()], query());
    expect(v.held).toBe(true);
    expect(v.hold_ids).toEqual(['hold-1']);
    expect(v.reason_codes).toEqual(['litigation']);
  });

  it('matches a wildcard hold across every class', () => {
    expect(
      evaluateHold([hold({ data_class: '*' })], query({ data_class: 'media.blobs' })).held,
    ).toBe(true);
  });

  it('does not match a different class', () => {
    expect(evaluateHold([hold()], query({ data_class: 'media.blobs' })).held).toBe(false);
  });

  it('does not match a released hold', () => {
    expect(evaluateHold([hold({ status: 'released' })], query()).held).toBe(false);
  });

  it('does not match before it takes effect', () => {
    expect(
      evaluateHold([hold({ effective_from: new Date('2026-08-01T00:00:00.000Z') })], query()).held,
    ).toBe(false);
  });

  it('does not match after it expires', () => {
    expect(
      evaluateHold([hold({ effective_until: new Date('2026-07-10T00:00:00.000Z') })], query()).held,
    ).toBe(false);
  });

  it('still matches on the exact instant it starts', () => {
    expect(evaluateHold([hold({ effective_from: NOW })], query()).held).toBe(true);
  });

  it('stops matching on the exact instant it ends (half-open interval)', () => {
    expect(evaluateHold([hold({ effective_until: NOW })], query()).held).toBe(false);
  });
});

describe('subject scoping', () => {
  it('a subject-scoped hold blocks a purge of that subject', () => {
    expect(
      evaluateHold([hold({ subject_ref: 'subj-a' })], query({ subject_ref: 'subj-a' })).held,
    ).toBe(true);
  });

  it('a subject-scoped hold does not block a purge of a different subject', () => {
    expect(
      evaluateHold([hold({ subject_ref: 'subj-a' })], query({ subject_ref: 'subj-b' })).held,
    ).toBe(false);
  });

  it('a subject-scoped hold DOES block a class-wide purge (it would sweep the subject away)', () => {
    expect(
      evaluateHold([hold({ subject_ref: 'subj-a' })], query({ subject_ref: null })).held,
    ).toBe(true);
  });

  it('a broad hold blocks a purge of any subject', () => {
    expect(evaluateHold([hold({ subject_ref: null })], query({ subject_ref: 'subj-z' })).held).toBe(
      true,
    );
  });
});

describe('cross-tenant isolation', () => {
  it("another tenant's hold never applies", () => {
    expect(evaluateHold([hold({ tenant_id: 'other' })], query()).held).toBe(false);
  });

  it("another agent's hold never applies", () => {
    expect(evaluateHold([hold({ agent_id: 'other-agent' })], query()).held).toBe(false);
  });

  it("another tenant's hold is never counted as protecting this one", () => {
    const v = evaluateHold([hold({ id: 'foreign', tenant_id: 'other' }), hold()], query());
    expect(v.hold_ids).toEqual(['hold-1']);
  });
});

describe('determinism', () => {
  it('returns sorted, de-duplicated ids and reason codes', () => {
    const holds = [
      hold({ id: 'z', reason_code: 'litigation' }),
      hold({ id: 'a', reason_code: 'audit' }),
      hold({ id: 'm', reason_code: 'litigation' }),
    ];
    const v = evaluateHold(holds, query());
    expect(v.hold_ids).toEqual(['a', 'm', 'z']);
    expect(v.reason_codes).toEqual(['audit', 'litigation']);
  });

  it('produces the same verdict regardless of input order', () => {
    const a = [hold({ id: 'x' }), hold({ id: 'y' })];
    expect(evaluateHold(a, query())).toEqual(evaluateHold([...a].reverse(), query()));
  });

  it('derives a stable lock key for the hold-vs-purge race', () => {
    expect(holdRaceLockKey('acme', 'acme-main', 'postgres.messages')).toBe(
      'maia_ops_hold:acme:acme-main:postgres.messages',
    );
  });
});

describe('assertPurgeAllowed', () => {
  it('throws when a hold applies, so a boolean cannot be ignored', () => {
    expect(() => assertPurgeAllowed([hold()], query())).toThrowError(
      /purge blocked by 1 active legal hold/,
    );
  });

  it('passes when nothing applies', () => {
    expect(() => assertPurgeAllowed([], query())).not.toThrow();
  });

  it('never leaks the case reference or a free-text reason', () => {
    try {
      assertPurgeAllowed([hold({ reason_code: 'litigation' })], query());
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/case/i);
    }
  });
});

describe('release requires re-evaluation', () => {
  it('flags a released hold as needing re-evaluation before any deletion', () => {
    expect(requiresReevaluationAfterRelease(hold({ status: 'released' }))).toBe(true);
    expect(requiresReevaluationAfterRelease(hold())).toBe(false);
  });
});
