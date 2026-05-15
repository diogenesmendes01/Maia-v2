/**
 * P8a Task 8 — SoulSliceBuilder tests.
 *
 * Coverage: strength ordering DESC, no blocking semantics, truncation, cache,
 * P8b stub returns empty.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SoulSliceBuilder,
  buildSoulSlice,
  stubSoulPort,
  type SoulBiasRecord,
  type SoulPort,
} from '@/runtime/context-assembly/slice-builders/soul-slice-builder.js';
import { InMemorySliceCache } from '@/runtime/context-packet/cache/slice-cache.js';
import { mockBase, mockDecision } from './_fixture.js';

const bias = (
  id: string,
  strength: number,
  principle = `principle-${id}`,
): SoulBiasRecord => ({
  id,
  principle,
  strength,
  origin: 'curation',
  scope: 'agent',
  scope_value: null,
  version_id: 'v1',
});

const mkPort = (biases: SoulBiasRecord[]): SoulPort => ({
  async listActiveBiases() {
    return biases;
  },
});

describe('SoulSliceBuilder', () => {
  let cache: InMemorySliceCache;
  beforeEach(() => {
    cache = new InMemorySliceCache();
  });

  it('orders biases by strength DESC', async () => {
    const port = mkPort([bias('b1', 0.3), bias('b2', 0.9), bias('b3', 0.6)]);
    const builder = new SoulSliceBuilder(port, cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_biases: 10 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.biases.map((b) => b.id)).toEqual(['b2', 'b3', 'b1']);
    expect(r.slice.biases[0]!.strength).toBe(0.9);
  });

  it('truncates to max_biases (truncated=true)', async () => {
    const port = mkPort(Array.from({ length: 10 }, (_, i) => bias(`b${i}`, 1 - i * 0.05)));
    const builder = new SoulSliceBuilder(port, cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_biases: 3 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.biases).toHaveLength(3);
    expect(r.slice.truncated).toBe(true);
  });

  it('no blocking — SoulSlice has no forbidden_actions field', async () => {
    const port = mkPort([bias('b1', 0.9)]);
    const builder = new SoulSliceBuilder(port, cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_biases: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    // shape assertion: SoulSlice = { biases, truncated } only
    expect(Object.keys(r.slice).sort()).toEqual(['biases', 'truncated']);
  });

  it('depth=none returns empty', async () => {
    const port = mkPort([bias('b1', 0.9)]);
    const builder = new SoulSliceBuilder(port, cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'none' },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.biases).toEqual([]);
  });

  it('cache hit on second call', async () => {
    const port = mkPort([bias('b1', 0.9)]);
    const builder = new SoulSliceBuilder(port, cache);
    const a = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_biases: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(a.cache_hit).toBe(false);
    const b = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_biases: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(b.cache_hit).toBe(true);
  });

  it('P8b stub port returns empty biases (placeholder)', async () => {
    const builder = new SoulSliceBuilder(stubSoulPort, cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_biases: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.biases).toEqual([]);
  });

  it('buildSoulSlice() helper returns empty SoulSlice shape', () => {
    expect(buildSoulSlice()).toEqual({ biases: [], truncated: false });
  });
});
