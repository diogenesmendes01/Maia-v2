import { describe, it, expect } from 'vitest';
import { buildPostturnNodes } from '@/cognitive-graph/postturn-graph.js';
import { CognitiveLayer } from '@/types/enums.js';

describe('P7 — postturn-graph composition', () => {
  it('inclui step-evaluator-trigger + correction-reflection + success-reflection todos ASYNC', () => {
    const nodes = buildPostturnNodes();
    const names = nodes.map((n) => n.name).sort();
    expect(names).toEqual(['correction-reflection', 'step-evaluator-trigger', 'success-reflection']);
    nodes.forEach((n) => expect(n.layer).toBe(CognitiveLayer.ASYNC));
  });

  it('cada node tem runWhen para gated execution (evita rodar quando não há trigger)', () => {
    const nodes = buildPostturnNodes();
    nodes.forEach((n) => expect(typeof n.runWhen).toBe('function'));
  });
});
