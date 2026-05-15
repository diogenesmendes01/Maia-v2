import { describe, it, expect } from 'vitest';
import { CognitiveLayer, FeatureFlagName } from '@/types/enums.js';

describe('P7 enums', () => {
  it('CognitiveLayer tem exatamente 3 valores conforme spec §4.8', () => {
    expect(CognitiveLayer.SYNC_REQUIRED).toBe('sync_required');
    expect(CognitiveLayer.SYNC_CONDITIONAL).toBe('sync_conditional');
    expect(CognitiveLayer.ASYNC).toBe('async_event');
    expect(Object.values(CognitiveLayer).length).toBe(3);
  });

  it('FeatureFlagName.COGNITIVE_GRAPH existe', () => {
    expect(FeatureFlagName.COGNITIVE_GRAPH).toBe('cognitive_graph');
  });
});
