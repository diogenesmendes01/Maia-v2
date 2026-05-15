import { describe, it, expect } from 'vitest';
import type { ModuleDescriptor, GraphRunResult, NodeRunResult } from '@/cognitive-graph/types.js';
import { CognitiveLayer } from '@/types/enums.js';

describe('P7 — ModuleDescriptor types', () => {
  it('aceita descriptor de sync_required sem runWhen nem parallelizable', () => {
    const d: ModuleDescriptor<string, number> = {
      name: 'reasoner',
      layer: CognitiveLayer.SYNC_REQUIRED,
      modelTier: 'reasoning',
      timeoutMs: 30000,
      version: 'v1',
      run: async (input) => input.length,
    };
    expect(d.name).toBe('reasoner');
  });

  it('aceita descriptor de sync_conditional com runWhen + parallelizable', () => {
    const d: ModuleDescriptor<string, boolean> = {
      name: 'critic',
      layer: CognitiveLayer.SYNC_CONDITIONAL,
      modelTier: 'fast',
      timeoutMs: 1500,
      version: 'v1',
      parallelizable: true,
      runWhen: (input) => input.startsWith('!'),
      fallback: false,
      run: async () => true,
    };
    expect(d.parallelizable).toBe(true);
    expect(d.runWhen?.('!cmd')).toBe(true);
    expect(d.runWhen?.('cmd')).toBe(false);
  });

  it('GraphRunResult agrega NodeRunResults por nome', () => {
    const r: GraphRunResult = {
      total_latency_ms: 100,
      nodes: {
        nodeA: { status: 'success', output: 'x', latency_ms: 50, fallback_triggered: false },
        nodeB: { status: 'skipped', output: null, latency_ms: 0, fallback_triggered: false },
      } as Record<string, NodeRunResult<unknown>>,
    };
    expect(r.nodes['nodeA']!.status).toBe('success');
  });
});
