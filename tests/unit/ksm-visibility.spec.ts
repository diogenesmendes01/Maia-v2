/**
 * P10a — knowledgeIsVisible() predicate (master §7 + §11.1.3 + §11.3.2).
 *
 * Covers:
 *   - per-state visibility/weight/label triple
 *   - weight ordering (ephemeral < observed < reinforced < verified < active)
 *   - context_mode='strict' hides ephemeral additionally
 *   - pending_review/proposed/deprecated/revoked never visible regardless
 *     of context (property)
 */

import { describe, expect, it } from 'vitest';
import {
  knowledgeIsVisible,
  getVisibilityTable,
  VISIBLE_STATES,
} from '@/control-plane/knowledge-state-machine/visibility.js';
import type { KnowledgeLifecycleStatus } from '@/control-plane/knowledge-state-machine/types.js';

const VISIBLE: KnowledgeLifecycleStatus[] = [
  'ephemeral',
  'observed',
  'reinforced',
  'verified',
  'active',
];
const INVISIBLE: KnowledgeLifecycleStatus[] = [
  'proposed',
  'pending_review',
  'deprecated',
  'revoked',
];

describe('P10a knowledgeIsVisible — per-state visibility', () => {
  it('returns visible=true with non-zero weight + label for each visible state (normal mode)', () => {
    for (const state of VISIBLE) {
      const result = knowledgeIsVisible({ lifecycle_status: state });
      expect(result.visible).toBe(true);
      expect(result.weight).toBeGreaterThan(0);
      expect(result.label).not.toBeNull();
    }
  });

  it('returns visible=false with weight=0 and null label for each invisible state', () => {
    for (const state of INVISIBLE) {
      const result = knowledgeIsVisible({ lifecycle_status: state });
      expect(result.visible).toBe(false);
      expect(result.weight).toBe(0);
      expect(result.label).toBeNull();
    }
  });

  it('weight order: ephemeral < observed < reinforced < verified < active', () => {
    const ephemeral = knowledgeIsVisible({ lifecycle_status: 'ephemeral' });
    const observed = knowledgeIsVisible({ lifecycle_status: 'observed' });
    const reinforced = knowledgeIsVisible({ lifecycle_status: 'reinforced' });
    const verified = knowledgeIsVisible({ lifecycle_status: 'verified' });
    const active = knowledgeIsVisible({ lifecycle_status: 'active' });
    expect(ephemeral.weight).toBeLessThan(observed.weight);
    expect(observed.weight).toBeLessThan(reinforced.weight);
    expect(reinforced.weight).toBeLessThan(verified.weight);
    expect(verified.weight).toBeLessThan(active.weight);
  });

  it('matches master §7.2 verbatim weights', () => {
    expect(knowledgeIsVisible({ lifecycle_status: 'ephemeral' }).weight).toBe(0.3);
    expect(knowledgeIsVisible({ lifecycle_status: 'observed' }).weight).toBe(0.5);
    expect(knowledgeIsVisible({ lifecycle_status: 'reinforced' }).weight).toBe(0.7);
    expect(knowledgeIsVisible({ lifecycle_status: 'verified' }).weight).toBe(0.9);
    expect(knowledgeIsVisible({ lifecycle_status: 'active' }).weight).toBe(1.0);
  });

  it('matches master §7.2 verbatim labels', () => {
    expect(knowledgeIsVisible({ lifecycle_status: 'ephemeral' }).label).toBe(
      '[novo, baixa confiança]',
    );
    expect(knowledgeIsVisible({ lifecycle_status: 'observed' }).label).toBe(
      '[observado]',
    );
    expect(knowledgeIsVisible({ lifecycle_status: 'reinforced' }).label).toBe(
      '[reforçado]',
    );
    expect(knowledgeIsVisible({ lifecycle_status: 'verified' }).label).toBe(
      '[verificado]',
    );
    expect(knowledgeIsVisible({ lifecycle_status: 'active' }).label).toBe('[ativo]');
  });
});

describe('P10a knowledgeIsVisible — strict mode', () => {
  it('strict mode hides ephemeral', () => {
    const result = knowledgeIsVisible(
      { lifecycle_status: 'ephemeral' },
      { context_mode: 'strict' },
    );
    expect(result.visible).toBe(false);
    expect(result.weight).toBe(0);
    expect(result.label).toBeNull();
  });

  it('strict mode keeps other visible states visible', () => {
    for (const state of ['observed', 'reinforced', 'verified', 'active'] as const) {
      const result = knowledgeIsVisible(
        { lifecycle_status: state },
        { context_mode: 'strict' },
      );
      expect(result.visible).toBe(true);
    }
  });

  it('strict mode does not unmask invisible states', () => {
    for (const state of INVISIBLE) {
      const result = knowledgeIsVisible(
        { lifecycle_status: state },
        { context_mode: 'strict' },
      );
      expect(result.visible).toBe(false);
    }
  });
});

describe('P10a property: pending_review/proposed/deprecated/revoked never visible', () => {
  it('pending_review never visible regardless of context_mode', () => {
    for (const mode of ['normal', 'strict', 'debug', undefined] as const) {
      const result = knowledgeIsVisible(
        { lifecycle_status: 'pending_review' },
        mode ? { context_mode: mode } : undefined,
      );
      expect(result.visible).toBe(false);
      expect(result.label).toBeNull();
    }
  });

  it('proposed (transit state) never visible regardless of context_mode', () => {
    for (const mode of ['normal', 'strict', 'debug', undefined] as const) {
      const result = knowledgeIsVisible(
        { lifecycle_status: 'proposed' },
        mode ? { context_mode: mode } : undefined,
      );
      expect(result.visible).toBe(false);
    }
  });

  it('deprecated never visible regardless of context_mode', () => {
    for (const mode of ['normal', 'strict', 'debug', undefined] as const) {
      const result = knowledgeIsVisible(
        { lifecycle_status: 'deprecated' },
        mode ? { context_mode: mode } : undefined,
      );
      expect(result.visible).toBe(false);
    }
  });

  it('revoked (antimemory) never visible regardless of context_mode', () => {
    for (const mode of ['normal', 'strict', 'debug', undefined] as const) {
      const result = knowledgeIsVisible(
        { lifecycle_status: 'revoked' },
        mode ? { context_mode: mode } : undefined,
      );
      expect(result.visible).toBe(false);
    }
  });
});

describe('P10a getVisibilityTable / VISIBLE_STATES', () => {
  it('returns a shallow copy (deleting top-level keys does not affect canonical)', () => {
    const table = getVisibilityTable();
    delete (table as Record<string, unknown>)['ephemeral'];
    // Re-read via the predicate should still be true.
    expect(knowledgeIsVisible({ lifecycle_status: 'ephemeral' }).visible).toBe(true);
  });

  it('exposes all 9 states in the table', () => {
    const table = getVisibilityTable();
    expect(Object.keys(table).sort()).toEqual(
      [
        'active',
        'deprecated',
        'ephemeral',
        'observed',
        'pending_review',
        'proposed',
        'reinforced',
        'revoked',
        'verified',
      ].sort(),
    );
  });

  it('VISIBLE_STATES contains exactly the 5 LLM-visible states', () => {
    expect([...VISIBLE_STATES].sort()).toEqual(
      ['active', 'ephemeral', 'observed', 'reinforced', 'verified'].sort(),
    );
  });
});
