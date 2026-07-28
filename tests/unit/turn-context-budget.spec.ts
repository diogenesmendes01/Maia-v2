import { describe, it, expect, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  applyBudget,
  utf8Bytes,
  estimateTokens,
  truncateUtf8,
  TRUNCATION_MARKER,
} from '../../src/agent/turn-context/budget.js';
import { SECTION_BUDGETS } from '../../src/agent/turn-context/types.js';
import { renderPrometheus, _resetForTests } from '../../src/lib/metrics.js';

/**
 * Issue #511 — section budgets.
 *
 * The caps themselves are not new (`facts.slice(0, 20)` and friends). What is
 * new is that they are BOUNDED BY BYTES as well as by count, and that every
 * dropped item is counted. The tests below pin both halves, plus the property
 * that makes the whole rollout plan work: truncation is deterministic, so the
 * same snapshot renders the same prompt on every replica.
 */
describe('#511 section budgets', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('keeps everything when the section fits', () => {
    const items = ['a', 'b', 'c'];
    const out = applyBudget('facts', items, { max_items: 10, max_bytes: 1000 }, utf8Bytes, truncateUtf8);
    expect(out.items).toEqual(items);
    expect(out.dropped).toBe(0);
    expect(out.clipped).toBe(0);
    expect(out.reason).toBeNull();
  });

  it('cuts to max_items and reports how many were lost', () => {
    const items = Array.from({ length: 50 }, (_, i) => `item-${i}`);
    const out = applyBudget('facts', items, { max_items: 20, max_bytes: 1_000_000 }, utf8Bytes, truncateUtf8);
    expect(out.items).toHaveLength(20);
    expect(out.dropped).toBe(30);
    expect(out.reason).toBe('max_items');
  });

  it('cuts on bytes even when the item count is legal', () => {
    // 5 items, well under a 100-item cap, but 5 KB against a 2 KB ceiling.
    const items = Array.from({ length: 5 }, () => 'x'.repeat(1000));
    const out = applyBudget('facts', items, { max_items: 100, max_bytes: 2000 }, utf8Bytes, truncateUtf8);
    expect(out.items).toHaveLength(2);
    expect(out.dropped).toBe(3);
    expect(out.reason).toBe('max_bytes');
    expect(out.bytes).toBe(2000);
  });

  /**
   * Round-1 review, P1: the ceiling used to be advisory. An oversized FIRST
   * item was kept whole, so `dropped=0`, `reason=null`, no metric — and one
   * tenant-controlled TEXT column could still produce an unbounded prompt.
   */
  it('CLIPS a single oversized item to the ceiling instead of passing it through', () => {
    const out = applyBudget(
      'facts',
      ['y'.repeat(50_000)],
      { max_items: 20, max_bytes: 100 },
      utf8Bytes,
      truncateUtf8,
    );
    // Present (an empty section would read as "there was nothing to say")…
    expect(out.items).toHaveLength(1);
    // …but actually bounded.
    expect(out.bytes).toBeLessThanOrEqual(100);
    expect(utf8Bytes(out.items[0]!)).toBeLessThanOrEqual(100);
    // …and visibly cut, both to the reader and to the dashboard.
    expect(out.items[0]).toContain(TRUNCATION_MARKER);
    expect(out.clipped).toBe(1);
    expect(out.reason).toBe('max_bytes');
  });

  it('meters the clipped item under max_bytes', async () => {
    applyBudget('rules', ['z'.repeat(9999)], { max_items: 5, max_bytes: 200 }, utf8Bytes, truncateUtf8);
    const exposition = await renderPrometheus();
    expect(exposition).toContain(
      'maia_turn_context_truncated_total{reason="max_bytes",section="rules"} 1',
    );
  });

  it('attributes each loss to the limit that caused it', async () => {
    // 30 items → 20 dropped by count; of the 10 survivors the first alone
    // blows the byte ceiling → 1 clipped + 9 dropped by bytes.
    const items = Array.from({ length: 30 }, () => 'q'.repeat(500));
    const out = applyBudget('facts', items, { max_items: 10, max_bytes: 100 }, utf8Bytes, truncateUtf8);
    expect(out.dropped).toBe(20 + 9);
    expect(out.clipped).toBe(1);

    const exposition = await renderPrometheus();
    // Two separate label sets — an operator tuning a budget needs to know
    // which knob to turn, not a single collapsed number.
    expect(exposition).toContain(
      'maia_turn_context_truncated_total{reason="max_items",section="facts"} 20',
    );
    expect(exposition).toContain(
      'maia_turn_context_truncated_total{reason="max_bytes",section="facts"} 10',
    );
  });

  it('clips on a codepoint boundary, never mid-sequence', () => {
    // Cutting a UTF-8 buffer at an arbitrary offset would emit U+FFFD, making
    // the prompt bytes depend on where the cut landed.
    const s = 'ação'.repeat(100);
    for (const limit of [3, 5, 7, 11, 64]) {
      const cut = truncateUtf8(s, limit);
      expect(cut).not.toContain('�');
      expect(utf8Bytes(cut)).toBeLessThanOrEqual(limit);
    }
  });

  it('always takes a PREFIX, so the result is byte-stable across replicas', () => {
    const items = ['aaa', 'b'.repeat(5000), 'ccc', 'ddd'];
    const budget = { max_items: 10, max_bytes: 4000 };
    const first = applyBudget('facts', items, budget, utf8Bytes, truncateUtf8);
    const second = applyBudget('facts', items, budget, utf8Bytes, truncateUtf8);
    // It stops at the oversized item instead of skipping it and picking up
    // 'ccc' — skipping would make the output depend on item sizes in a way that
    // is impossible to reason about when diffing two replicas' prompts.
    expect(first.items).toEqual(['aaa']);
    expect(second.items).toEqual(first.items);
  });

  it('meters dropped items and section size', async () => {
    const items = Array.from({ length: 30 }, (_, i) => `f-${i}`);
    applyBudget('facts', items, { max_items: 10, max_bytes: 1_000_000 }, utf8Bytes, truncateUtf8);

    const exposition = await renderPrometheus();
    // The counter tracks ITEMS DROPPED, not truncation events: one event losing
    // 20 facts is a different incident from 20 events losing one each.
    expect(exposition).toContain(
      'maia_turn_context_truncated_total{reason="max_items",section="facts"} 20',
    );
    expect(exposition).toMatch(/maia_turn_context_bytes\{section="facts"\} \d+/);
    expect(exposition).toMatch(/maia_turn_context_tokens_estimated\{section="facts"\} \d+/);
  });

  it('does not meter a truncation when nothing was dropped', async () => {
    applyBudget('rules', ['a'], { max_items: 10, max_bytes: 1000 }, utf8Bytes, truncateUtf8);
    const exposition = await renderPrometheus();
    expect(exposition).not.toContain('maia_turn_context_truncated_total{reason="max_items",section="rules"}');
  });

  it('measures multi-byte characters in bytes, not code units', () => {
    // A prompt full of accented Portuguese must not overshoot its ceiling
    // because the budget counted UTF-16 lengths.
    expect(utf8Bytes('ação')).toBe(6);
    expect('ação'.length).toBe(4);
  });

  it('estimates tokens at roughly four characters each', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(400)).toBe(100);
    expect(estimateTokens(401)).toBe(101);
  });

  it('exposes a budget for every section the prompt truncates', () => {
    for (const section of [
      'history',
      'facts',
      'rules',
      'memories',
      'hints',
      'capabilities',
      'gaps',
      'entity_states',
    ]) {
      const budget = SECTION_BUDGETS[section as keyof typeof SECTION_BUDGETS];
      expect(budget.max_items).toBeGreaterThan(0);
      expect(budget.max_bytes).toBeGreaterThan(0);
    }
  });

  /**
   * Round-1 review, P1: `history` and `entity_states` declared budgets that
   * nothing enforced. A declared-but-unenforced budget is worse than no budget
   * — it reads like a guarantee. Every declared section must be wired.
   *
   * NOTE: this is the WEAK guard. It only proves a section name reaches
   * `applyBudget` somewhere — it passed in round 1 while `capabilities`
   * measured `skill_name` and let `capability_description` through unbounded.
   * The real guard is `turn-context-section-bounds.spec.ts`, which renders a
   * prompt from pathological inputs and asserts each section's actual size.
   */
  it('every declared budget is actually applied by the prompt builder', async () => {
    const src = await readFile(
      new URL('../../src/agent/prompt-builder.ts', import.meta.url),
      'utf8',
    );
    for (const section of Object.keys(SECTION_BUDGETS)) {
      expect(
        src.includes(`'${section}',`),
        `SECTION_BUDGETS.${section} is declared but never passed to applyBudget`,
      ).toBe(true);
    }
  });

  it('has NO budget for policy or permission blocks', () => {
    // Silently dropping a security rule would be a governance failure wearing a
    // performance costume (issue §6). Those blocks must never be truncatable.
    for (const forbidden of ['scope', 'permissions', 'policy', 'boundaries']) {
      expect(Object.keys(SECTION_BUDGETS)).not.toContain(forbidden);
    }
  });
});
