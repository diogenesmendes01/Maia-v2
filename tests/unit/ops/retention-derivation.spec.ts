/**
 * Issue #536 — derived data never outlives its source.
 *
 * The owner's rule for `postgres.memory` ("herda o MENOR prazo das fontes e
 * nunca prolonga silenciosamente a vida de uma mensagem") and for
 * `postgres.conversations` ("o shell identificável não sobrevive às mensagens")
 * are the same invariant. These tests are what make it a mechanism rather than
 * a comment: the property test at the bottom says it for EVERY policy, not for
 * the handful of examples above it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import fc from 'fast-check';
import {
  RETENTION_SOURCES,
  assertDoesNotExtendSource,
  derivedClasses,
  resolveEffectiveRetention,
  retentionSourcesOf,
} from '../../../src/ops/retention/derivation.js';
import {
  DATA_CLASSES,
  UNAPPROVED_POLICY,
  getDataClass,
  parseRetentionPolicy,
} from '../../../src/ops/retention/data-classes.js';

const REPO_ROOT = join(__dirname, '../../..');

function policy(classes: Record<string, number>, approver = 'dpo@example') {
  return parseRetentionPolicy(
    JSON.stringify({
      version: 'v-test',
      approved_by: approver,
      approved_at: '2026-07-01T00:00:00.000Z',
      classes: Object.fromEntries(
        Object.entries(classes).map(([k, days]) => [k, { retention_days: days }]),
      ),
    }),
  );
}

describe('the derivation graph is well formed', () => {
  it('names only classes that exist in the inventory', () => {
    for (const [derived, sources] of Object.entries(RETENTION_SOURCES)) {
      expect(() => getDataClass(derived)).not.toThrow();
      for (const s of sources) expect(() => getDataClass(s)).not.toThrow();
    }
  });

  it('is the TRANSITIVE closure — which is what makes the single-pass clamp safe', () => {
    // `resolveEffectiveRetention` does not recurse. That is only correct while
    // every derived class lists every ANCESTOR, not just its parent.
    for (const [derived, sources] of Object.entries(RETENTION_SOURCES)) {
      for (const s of sources) {
        for (const grandparent of retentionSourcesOf(s)) {
          expect(sources, `${derived} must also list ${grandparent}`).toContain(grandparent);
        }
      }
    }
  });

  it('is acyclic (no class is its own source)', () => {
    for (const [derived, sources] of Object.entries(RETENTION_SOURCES)) {
      expect(sources).not.toContain(derived);
    }
  });

  it('leaves user-pinned memory OUT — it is not derived data', () => {
    // Clamping pinned memory to the conversation that produced it would delete
    // exactly what the user asked to keep.
    expect(derivedClasses()).not.toContain('postgres.memory.pinned');
    expect(retentionSourcesOf('postgres.memory.pinned')).toEqual([]);
  });
});

describe('the clamp only ever LOWERS', () => {
  it('takes the source period when the policy asks for a longer one', () => {
    const v = resolveEffectiveRetention('postgres.memory', policy({
      'postgres.messages': 180,
      'postgres.memory': 365,
    }));
    expect(v.declared_days).toBe(365);
    expect(v.retention_days).toBe(180);
    expect(v.clamped_by).toBe('postgres.messages');
  });

  it('leaves a SHORTER declared period alone', () => {
    const v = resolveEffectiveRetention('postgres.memory', policy({
      'postgres.messages': 180,
      'postgres.memory': 30,
    }));
    expect(v.retention_days).toBe(30);
    expect(v.clamped_by).toBeNull();
    expect(v.reason).toBe('ok');
  });

  it('takes the SMALLEST bound when several sources are bounded', () => {
    const v = resolveEffectiveRetention('postgres.memory', policy({
      'postgres.messages': 180,
      'postgres.conversations': 90,
      'postgres.memory': 365,
    }));
    expect(v.retention_days).toBe(90);
    expect(v.clamped_by).toBe('postgres.conversations');
  });

  it('inherits the source period when the class has none of its own', () => {
    // Otherwise memory would be kept forever while the message it derives from
    // expires at 180 days — the exact leak the rule exists to close.
    const v = resolveEffectiveRetention('postgres.memory', policy({ 'postgres.messages': 180 }));
    expect(v.purgeable).toBe(true);
    expect(v.retention_days).toBe(180);
    expect(v.reason).toBe('inherited_from_source');
    expect(v.declared_days).toBeNull();
  });

  it('imposes no bound from an UNBOUNDED source', () => {
    // A source kept indefinitely is not a reason to keep the derived row
    // longer; the derived class simply keeps its own (shorter) period.
    const v = resolveEffectiveRetention('postgres.memory', policy({ 'postgres.memory': 30 }));
    expect(v.retention_days).toBe(30);
    expect(v.clamped_by).toBeNull();
  });

  it('clamps the conversation shell to its messages', () => {
    const v = resolveEffectiveRetention('postgres.conversations', policy({
      'postgres.messages': 180,
      'postgres.conversations': 3650,
    }));
    expect(v.retention_days).toBe(180);
    expect(v.clamped_by).toBe('postgres.messages');
  });

  it('clamps an audio transcript to the message that carries it', () => {
    const v = resolveEffectiveRetention('postgres.messages.audio_transcript', policy({
      'postgres.messages': 180,
      'postgres.messages.audio_transcript': 3650,
    }));
    expect(v.retention_days).toBe(180);
  });
});

describe('the clamp never manufactures permission', () => {
  it('refuses to make a structurally non-purgeable class purgeable', () => {
    // Same refusal `parseRetentionPolicy` makes. Inheritance lowers a period;
    // it does not grant a right to delete the inventory withholds.
    for (const c of DATA_CLASSES.filter((k) => k.purge_mechanism === 'not_purgeable')) {
      const v = resolveEffectiveRetention(c.id, policy({ 'postgres.messages': 1 }));
      expect(v.purgeable, c.id).toBe(false);
      expect(v.reason, c.id).toBe('class_not_purgeable');
    }
  });

  it('purges nothing under the unapproved policy', () => {
    for (const c of DATA_CLASSES) {
      const v = resolveEffectiveRetention(c.id, UNAPPROVED_POLICY);
      expect(v.purgeable, c.id).toBe(false);
      expect(v.retention_days, c.id).toBeNull();
    }
  });

  it('throws on an unknown class instead of inventing a default', () => {
    expect(() => resolveEffectiveRetention('postgres.nope', UNAPPROVED_POLICY)).toThrowError(
      /not in the inventory/,
    );
  });
});

describe('assertDoesNotExtendSource', () => {
  it('throws when a period computed some other way would outlive the source', () => {
    expect(() =>
      assertDoesNotExtendSource('postgres.memory', 365, policy({ 'postgres.messages': 180 })),
    ).toThrowError(/would outlive its source/);
  });

  it('throws for an UNBOUNDED derived period over a bounded source', () => {
    // "Kept forever" is the worst way to outlive a message, not an exemption.
    expect(() =>
      assertDoesNotExtendSource('postgres.memory', null, policy({ 'postgres.messages': 180 })),
    ).toThrowError(/would outlive its source/);
  });

  it('accepts what resolveEffectiveRetention produced', () => {
    const p = policy({ 'postgres.messages': 180, 'postgres.memory': 365 });
    const v = resolveEffectiveRetention('postgres.memory', p);
    expect(() => assertDoesNotExtendSource('postgres.memory', v.retention_days, p)).not.toThrow();
  });

  it('is a no-op for a class with no sources', () => {
    expect(() =>
      assertDoesNotExtendSource('postgres.traces', 9999, policy({ 'postgres.traces': 9999 })),
    ).not.toThrow();
  });
});

describe('there is only ONE path to a retention period', () => {
  it('no module outside src/ops/retention calls the unclamped resolver', () => {
    // The clamp is only an invariant while `resolveEffectiveRetention` is the
    // single answer to "how long may this be kept". A consumer reaching for
    // `resolveRetention` directly would bypass it silently, so this walks the
    // source tree instead of trusting the docblock that says not to.
    const src = join(REPO_ROOT, 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'admin-ui') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = relative(REPO_ROOT, full).replace(/\\/g, '/');
        if (rel.startsWith('src/ops/retention/')) continue;
        if (/\bresolveRetention\b/.test(readFileSync(full, 'utf8'))) offenders.push(rel);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

describe('PROPERTY: no policy can make derived data outlive its source', () => {
  it('holds for every combination of periods', () => {
    const days = fc.integer({ min: 1, max: 4000 });
    fc.assert(
      fc.property(
        fc.record({
          messages: fc.option(days, { nil: undefined }),
          conversations: fc.option(days, { nil: undefined }),
          memory: fc.option(days, { nil: undefined }),
          transcript: fc.option(days, { nil: undefined }),
        }),
        (input) => {
          const declared: Record<string, number> = {};
          if (input.messages !== undefined) declared['postgres.messages'] = input.messages;
          if (input.conversations !== undefined) {
            declared['postgres.conversations'] = input.conversations;
          }
          if (input.memory !== undefined) declared['postgres.memory'] = input.memory;
          if (input.transcript !== undefined) {
            declared['postgres.messages.audio_transcript'] = input.transcript;
          }
          const p = policy(declared);

          for (const derived of derivedClasses()) {
            const v = resolveEffectiveRetention(derived, p);
            // The invariant, stated once: whatever the policy says, the
            // effective period never exceeds a bounded source, and the
            // assertion agrees with the resolver.
            expect(() => assertDoesNotExtendSource(derived, v.retention_days, p)).not.toThrow();
            for (const source of retentionSourcesOf(derived)) {
              const s = resolveEffectiveRetention(source, p);
              if (s.retention_days === null) continue;
              expect(v.retention_days).not.toBeNull();
              expect(v.retention_days!).toBeLessThanOrEqual(s.retention_days);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
