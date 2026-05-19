/**
 * P8a Task 8 — SoulSliceBuilder tests.
 *
 * Coverage: strength ordering DESC, no blocking semantics, truncation, cache,
 * stub port returns empty.
 *
 * Updated for P8b shape: SoulSlice carries `active_biases` / `rendered_block`
 * / `total_active` / `truncated_to` / `cache_key` / `resolved_at` instead of
 * the legacy P8a stub `{ biases, truncated }`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SoulSliceBuilder,
  buildSoulSlice,
  stubSoulPort,
  type SoulPort,
} from '@/runtime/context-assembly/slice-builders/soul-slice-builder.js';
import { InMemorySliceCache } from '@/runtime/context-packet/cache/slice-cache.js';
import type { SoulBias } from '@/db/schema.js';
import { mockBase, mockDecision } from './_fixture.js';

function bias(
  id: string,
  strength: number,
  principle = `principle-${id}`,
): SoulBias {
  return {
    id,
    tenant_id: 'tenant1',
    agent_id: 'agent1',
    scope: 'tenant',
    scope_value: '*',
    principle,
    guidance: `guidance-${id}`,
    origin: 'founder_explicit',
    strength: strength.toFixed(3),
    activation_context: {},
    status: 'active',
    version: 1,
    previous_version_id: null,
    proposed_by: 'test',
    proposed_reason: null,
    approved_by: 'admin',
    approved_at: new Date(),
    activated_at: new Date(),
    frozen_at: null,
    rolled_back_at: null,
    rollback_reason: null,
    deprecated_at: null,
    deprecated_reason: null,
    proposal_id: null,
    source_drift_alert_id: null,
    created_at: new Date(),
  } as SoulBias;
}

const mkPort = (biases: SoulBias[]): SoulPort => ({
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
    expect(r.slice.active_biases.map((b) => b.id)).toEqual(['b2', 'b3', 'b1']);
    expect(r.slice.active_biases[0]!.strength).toBe(0.9);
  });

  it('truncates to max_biases (total_active > truncated_to)', async () => {
    const port = mkPort(
      Array.from({ length: 10 }, (_, i) => bias(`b${i}`, 1 - i * 0.05)),
    );
    const builder = new SoulSliceBuilder(port, cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_biases: 3 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.active_biases).toHaveLength(3);
    expect(r.slice.total_active).toBe(10);
    expect(r.slice.truncated_to).toBe(3);
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
    // shape assertion: SoulSlice has no forbidden_actions / blocked_tools.
    expect(Object.keys(r.slice).sort()).toEqual(
      [
        'active_biases',
        'cache_key',
        'rendered_block',
        'resolved_at',
        'total_active',
        'truncated_to',
      ].sort(),
    );
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
    expect(r.slice.active_biases).toEqual([]);
    expect(r.slice.rendered_block).toBeNull();
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

  it('stub port returns empty biases', async () => {
    const builder = new SoulSliceBuilder(stubSoulPort, cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_biases: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.active_biases).toEqual([]);
  });

  it('buildSoulSlice() function returns empty SoulSlice when depth=none', async () => {
    // The function-based API used by P8b tests; depth=none short-circuits
    // without calling the repo.
    const slice = await buildSoulSlice({
      tenant_id: 't',
      agent_id: 'a',
      depth: 'none',
      max_biases: 5,
    });
    expect(slice.active_biases).toEqual([]);
    expect(slice.rendered_block).toBeNull();
    expect(slice.total_active).toBe(0);
    expect(slice.truncated_to).toBe(0);
  });
});
