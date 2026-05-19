/**
 * P10a — ALLOWED_TRANSITIONS table + assertion (master §11.1.2).
 *
 * These tests are pure and import the canonical table directly. Any
 * change to the table is a Knowledge-lifecycle Architecture Lock
 * (master §0.1) — these tests act as the property-level fence.
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  assertAllowedTransition,
  IllegalTransitionError,
} from '@/control-plane/knowledge-state-machine/transitions.js';
import type { KnowledgeLifecycleStatus } from '@/control-plane/knowledge-state-machine/types.js';

describe('P10a ALLOWED_TRANSITIONS table', () => {
  it('has all 9 lifecycle states as keys', () => {
    const states: KnowledgeLifecycleStatus[] = [
      'proposed',
      'pending_review',
      'ephemeral',
      'observed',
      'reinforced',
      'verified',
      'active',
      'deprecated',
      'revoked',
    ];
    for (const state of states) {
      expect(state in ALLOWED_TRANSITIONS).toBe(true);
    }
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual(states.sort());
  });

  it('proposed only transitions to pending_review or ephemeral', () => {
    expect(ALLOWED_TRANSITIONS.proposed).toEqual(['pending_review', 'ephemeral']);
  });

  it('pending_review transitions to active/verified/revoked', () => {
    expect(ALLOWED_TRANSITIONS.pending_review).toEqual([
      'active',
      'verified',
      'revoked',
    ]);
  });

  it('ephemeral transitions to observed/deprecated/revoked', () => {
    expect(ALLOWED_TRANSITIONS.ephemeral).toEqual([
      'observed',
      'deprecated',
      'revoked',
    ]);
  });

  it('observed transitions to reinforced/deprecated/revoked', () => {
    expect(ALLOWED_TRANSITIONS.observed).toEqual([
      'reinforced',
      'deprecated',
      'revoked',
    ]);
  });

  it('reinforced transitions to verified/deprecated/revoked', () => {
    expect(ALLOWED_TRANSITIONS.reinforced).toEqual([
      'verified',
      'deprecated',
      'revoked',
    ]);
  });

  it('verified transitions only to active/deprecated/revoked (no-downgrade)', () => {
    expect(ALLOWED_TRANSITIONS.verified).toEqual([
      'active',
      'deprecated',
      'revoked',
    ]);
    expect(ALLOWED_TRANSITIONS.verified).not.toContain('reinforced');
    expect(ALLOWED_TRANSITIONS.verified).not.toContain('observed');
    expect(ALLOWED_TRANSITIONS.verified).not.toContain('ephemeral');
  });

  it('active transitions only to deprecated/revoked (no-downgrade)', () => {
    expect(ALLOWED_TRANSITIONS.active).toEqual(['deprecated', 'revoked']);
    expect(ALLOWED_TRANSITIONS.active).not.toContain('verified');
    expect(ALLOWED_TRANSITIONS.active).not.toContain('reinforced');
    expect(ALLOWED_TRANSITIONS.active).not.toContain('observed');
    expect(ALLOWED_TRANSITIONS.active).not.toContain('ephemeral');
  });

  it('deprecated transitions only to revoked', () => {
    expect(ALLOWED_TRANSITIONS.deprecated).toEqual(['revoked']);
  });

  it('revoked is terminal (empty transitions)', () => {
    expect(ALLOWED_TRANSITIONS.revoked).toEqual([]);
  });
});

describe('P10a assertAllowedTransition', () => {
  it('accepts every documented transition', () => {
    expect(() => assertAllowedTransition('proposed', 'ephemeral')).not.toThrow();
    expect(() => assertAllowedTransition('proposed', 'pending_review')).not.toThrow();
    expect(() => assertAllowedTransition('pending_review', 'active')).not.toThrow();
    expect(() => assertAllowedTransition('pending_review', 'verified')).not.toThrow();
    expect(() => assertAllowedTransition('pending_review', 'revoked')).not.toThrow();
    expect(() => assertAllowedTransition('ephemeral', 'observed')).not.toThrow();
    expect(() => assertAllowedTransition('observed', 'reinforced')).not.toThrow();
    expect(() => assertAllowedTransition('reinforced', 'verified')).not.toThrow();
    expect(() => assertAllowedTransition('verified', 'active')).not.toThrow();
    expect(() => assertAllowedTransition('verified', 'deprecated')).not.toThrow();
    expect(() => assertAllowedTransition('active', 'deprecated')).not.toThrow();
    expect(() => assertAllowedTransition('active', 'revoked')).not.toThrow();
    expect(() => assertAllowedTransition('deprecated', 'revoked')).not.toThrow();
  });

  it('rejects no-downgrade attempts from verified', () => {
    expect(() => assertAllowedTransition('verified', 'reinforced')).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertAllowedTransition('verified', 'observed')).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertAllowedTransition('verified', 'ephemeral')).toThrow(
      IllegalTransitionError,
    );
  });

  it('rejects no-downgrade attempts from active', () => {
    expect(() => assertAllowedTransition('active', 'verified')).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertAllowedTransition('active', 'reinforced')).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertAllowedTransition('active', 'observed')).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertAllowedTransition('active', 'ephemeral')).toThrow(
      IllegalTransitionError,
    );
  });

  it('rejects ephemeral skipping levels', () => {
    expect(() => assertAllowedTransition('ephemeral', 'verified')).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertAllowedTransition('ephemeral', 'active')).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertAllowedTransition('ephemeral', 'reinforced')).toThrow(
      IllegalTransitionError,
    );
  });

  it('rejects deprecated → anything except revoked', () => {
    expect(() => assertAllowedTransition('deprecated', 'active')).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertAllowedTransition('deprecated', 'verified')).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertAllowedTransition('deprecated', 'ephemeral')).toThrow(
      IllegalTransitionError,
    );
  });

  it('rejects every transition out of revoked', () => {
    expect(() => assertAllowedTransition('revoked', 'active')).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertAllowedTransition('revoked', 'deprecated')).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertAllowedTransition('revoked', 'ephemeral')).toThrow(
      IllegalTransitionError,
    );
  });

  it('carries from/to on IllegalTransitionError for audit', () => {
    try {
      assertAllowedTransition('proposed', 'active');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError);
      const e = err as IllegalTransitionError;
      expect(e.from).toBe('proposed');
      expect(e.to).toBe('active');
      expect(e.message).toContain('proposed');
      expect(e.message).toContain('active');
    }
  });
});

describe('P10a property: graph invariants (BFS-exhaustive)', () => {
  function bfsReachable(
    start: KnowledgeLifecycleStatus,
  ): Set<KnowledgeLifecycleStatus> {
    const reached = new Set<KnowledgeLifecycleStatus>([start]);
    const queue: KnowledgeLifecycleStatus[] = [start];
    while (queue.length) {
      const node = queue.shift()!;
      for (const next of ALLOWED_TRANSITIONS[node]) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    return reached;
  }

  it('revoked is terminal — BFS from revoked reaches {revoked} only', () => {
    expect(bfsReachable('revoked')).toEqual(new Set(['revoked']));
  });

  it('no path from revoked → any visible state', () => {
    const visibleStates: KnowledgeLifecycleStatus[] = [
      'ephemeral',
      'observed',
      'reinforced',
      'verified',
      'active',
    ];
    const reachable = bfsReachable('revoked');
    for (const visible of visibleStates) {
      expect(reachable.has(visible)).toBe(false);
    }
  });

  it('no path from verified → reinforced/observed/ephemeral', () => {
    const reachable = bfsReachable('verified');
    expect(reachable.has('reinforced')).toBe(false);
    expect(reachable.has('observed')).toBe(false);
    expect(reachable.has('ephemeral')).toBe(false);
    expect(reachable.has('pending_review')).toBe(false);
    // verified is allowed to reach active, deprecated, revoked
    expect(reachable.has('active')).toBe(true);
    expect(reachable.has('deprecated')).toBe(true);
    expect(reachable.has('revoked')).toBe(true);
  });

  it('no path from active → reinforced/observed/ephemeral/verified', () => {
    const reachable = bfsReachable('active');
    expect(reachable.has('reinforced')).toBe(false);
    expect(reachable.has('observed')).toBe(false);
    expect(reachable.has('ephemeral')).toBe(false);
    expect(reachable.has('verified')).toBe(false);
    // active is allowed to reach deprecated, revoked
    expect(reachable.has('deprecated')).toBe(true);
    expect(reachable.has('revoked')).toBe(true);
  });

  it('no path from deprecated → any non-revoked state', () => {
    const reachable = bfsReachable('deprecated');
    expect(reachable).toEqual(new Set(['deprecated', 'revoked']));
  });

  it('from proposed every state is reachable except via downgrade', () => {
    const reachable = bfsReachable('proposed');
    // proposed should be able to reach all 9 states through legal paths
    expect(reachable.has('pending_review')).toBe(true);
    expect(reachable.has('ephemeral')).toBe(true);
    expect(reachable.has('observed')).toBe(true);
    expect(reachable.has('reinforced')).toBe(true);
    expect(reachable.has('verified')).toBe(true);
    expect(reachable.has('active')).toBe(true);
    expect(reachable.has('deprecated')).toBe(true);
    expect(reachable.has('revoked')).toBe(true);
  });
});
