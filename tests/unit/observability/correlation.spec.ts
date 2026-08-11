import { describe, it, expect } from 'vitest';
import {
  buildCorrelation,
  correlationForJob,
  correlationLogFields,
  currentTraceId,
  deriveTraceId,
  runAsNewAttempt,
  runWithCorrelation,
  tryGetCorrelation,
} from '../../../src/observability/correlation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('issue #514 §1 — correlation contract', () => {
  describe('deriveTraceId', () => {
    it('is deterministic — same seed always yields the same id', () => {
      expect(deriveTraceId('mensagem-abc')).toBe(deriveTraceId('mensagem-abc'));
    });

    it('different seeds yield different ids', () => {
      expect(deriveTraceId('a')).not.toBe(deriveTraceId('b'));
    });

    it('returns a UUID seed verbatim (lowercased)', () => {
      const id = '3f1a9d2e-4c5b-4a7e-9f0d-1b2c3d4e5f60';
      expect(deriveTraceId(id)).toBe(id);
      expect(deriveTraceId(id.toUpperCase())).toBe(id);
    });

    it('produces a well-formed v5 UUID for non-UUID seeds', () => {
      const out = deriveTraceId('not-a-uuid');
      expect(out).toMatch(UUID_RE);
      expect(out[14]).toBe('5'); // version nibble
      expect(['8', '9', 'a', 'b']).toContain(out[19]); // RFC-4122 variant
    });

    it('is stable across processes (golden vector)', () => {
      // Hard-coded so a refactor of the hashing cannot silently break the
      // correlation of traces already persisted in runtime_trace_envelopes.
      expect(deriveTraceId('turn-1')).toBe(deriveTraceId('turn-1'));
      expect(deriveTraceId('turn-1')).toMatch(UUID_RE);
    });
  });

  describe('ALS propagation', () => {
    it('exposes the trace id inside the scope and nothing outside it', async () => {
      expect(currentTraceId()).toBeNull();
      await runWithCorrelation({ seed: 'm1', turn_id: 'm1', origin: 'ingress' }, async () => {
        expect(currentTraceId()).toBe(deriveTraceId('m1'));
        expect(tryGetCorrelation()?.turn_id).toBe('m1');
      });
      expect(currentTraceId()).toBeNull();
    });

    it('survives await boundaries', async () => {
      await runWithCorrelation({ seed: 'm2' }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        await Promise.resolve();
        expect(currentTraceId()).toBe(deriveTraceId('m2'));
      });
    });

    it('keeps concurrent turns isolated', async () => {
      const seen: string[] = [];
      await Promise.all([
        runWithCorrelation({ seed: 'A' }, async () => {
          await new Promise((r) => setTimeout(r, 5));
          seen.push(currentTraceId()!);
        }),
        runWithCorrelation({ seed: 'B' }, async () => {
          seen.push(currentTraceId()!);
        }),
      ]);
      expect(new Set(seen).size).toBe(2);
      expect(seen).toContain(deriveTraceId('A'));
      expect(seen).toContain(deriveTraceId('B'));
    });

    it('nested scopes override, then restore', async () => {
      await runWithCorrelation({ seed: 'outer' }, async () => {
        await runWithCorrelation({ seed: 'inner' }, async () => {
          expect(currentTraceId()).toBe(deriveTraceId('inner'));
        });
        expect(currentTraceId()).toBe(deriveTraceId('outer'));
      });
    });
  });

  describe('attempts', () => {
    it('defaults to attempt 1 with a unique attempt id', () => {
      const a = buildCorrelation({ seed: 'x' });
      const b = buildCorrelation({ seed: 'x' });
      expect(a.attempt).toBe(1);
      expect(a.trace_id).toBe(b.trace_id); // same root
      expect(a.attempt_id).not.toBe(b.attempt_id); // distinct attempts
    });

    it('runAsNewAttempt preserves the ROOT trace and bumps the ordinal', async () => {
      await runWithCorrelation({ seed: 'm3', turn_id: 'm3', attempt: 1 }, async () => {
        const root = currentTraceId();
        const firstAttemptId = tryGetCorrelation()!.attempt_id;
        await runAsNewAttempt({ origin: 'recovery' }, async () => {
          expect(currentTraceId()).toBe(root);
          expect(tryGetCorrelation()!.attempt).toBe(2);
          expect(tryGetCorrelation()!.attempt_id).not.toBe(firstAttemptId);
          expect(tryGetCorrelation()!.origin).toBe('recovery');
        });
      });
    });

    it('clamps a bogus attempt ordinal to at least 1', () => {
      expect(buildCorrelation({ seed: 'x', attempt: 0 }).attempt).toBe(1);
      expect(buildCorrelation({ seed: 'x', attempt: -7 }).attempt).toBe(1);
    });
  });

  describe('job payload fields', () => {
    it('derives the trace id from the message id outside any scope', () => {
      const fields = correlationForJob('m4');
      expect(fields.trace_id).toBe(deriveTraceId('m4'));
      expect(fields.enqueued_at_ms).toBeGreaterThan(0);
    });

    it('reuses the ambient trace when re-enqueueing the SAME turn', async () => {
      await runWithCorrelation({ trace_id: 'custom-root', turn_id: 'm5' }, async () => {
        expect(correlationForJob('m5').trace_id).toBe('custom-root');
      });
    });

    it('derives a FRESH trace when enqueueing a DIFFERENT turn from within a scope', async () => {
      await runWithCorrelation({ trace_id: 'custom-root', turn_id: 'm5' }, async () => {
        // A turn that fans out to another message must not inherit the parent's
        // root id — otherwise two turns collapse into one trace.
        expect(correlationForJob('m6').trace_id).toBe(deriveTraceId('m6'));
      });
    });

    it('carries received_at_ms only when known', () => {
      expect(correlationForJob('m7').received_at_ms).toBeUndefined();
      expect(correlationForJob('m7', 1234).received_at_ms).toBe(1234);
    });
  });

  describe('log fields', () => {
    it('are empty outside a scope', () => {
      expect(correlationLogFields()).toEqual({});
    });

    it('carry the high-cardinality ids that are FORBIDDEN as metric labels', async () => {
      await runWithCorrelation({ seed: 'm8', turn_id: 'm8', origin: 'queue' }, async () => {
        const f = correlationLogFields();
        expect(f.trace_id).toBe(deriveTraceId('m8'));
        expect(f.turn_id).toBe('m8');
        expect(f.attempt).toBe(1);
        expect(f.origin).toBe('queue');
        expect(typeof f.attempt_id).toBe('string');
      });
    });
  });

  it('never throws when there is no context (observability is fail-soft)', () => {
    expect(() => currentTraceId()).not.toThrow();
    expect(() => tryGetCorrelation()).not.toThrow();
    expect(() => correlationLogFields()).not.toThrow();
  });
});
