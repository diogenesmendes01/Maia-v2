import { describe, it, expect } from 'vitest';
import { buildPreturnNodes } from '@/cognitive-graph/preturn-graph.js';
import { CognitiveLayer } from '@/types/enums.js';

describe('P7 — preturn-graph composition', () => {
  it('inclui procedure-selector e role-selector como sync_conditional + parallelizable', () => {
    const nodes = buildPreturnNodes({ multi_channel_on: true });
    const names = nodes.map((n) => n.name).sort();
    expect(names).toContain('procedure-selector');
    expect(names).toContain('role-selector');
    nodes.forEach((n) => {
      expect(n.layer).toBe(CognitiveLayer.SYNC_CONDITIONAL);
      expect(n.parallelizable).toBe(true);
    });
  });

  it('omite role-selector quando flag multi_channel_on=false (gate de compat P6)', () => {
    const nodes = buildPreturnNodes({ multi_channel_on: false });
    expect(nodes.map((n) => n.name)).not.toContain('role-selector');
    expect(nodes.map((n) => n.name)).toContain('procedure-selector');
  });
});
