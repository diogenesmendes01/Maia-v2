import { describe, it, expect } from 'vitest';
import { IntentResolutionSchema } from '../../src/workflows/pending-questions.js';

describe('pending questions — IntentResolution schema', () => {
  it('aceita resolução válida', () => {
    const r = IntentResolutionSchema.safeParse({
      resolves_pending: true,
      option_chosen: 'pf',
      confidence: 0.95,
    });
    expect(r.success).toBe(true);
  });
  it('aceita topic change', () => {
    const r = IntentResolutionSchema.safeParse({
      resolves_pending: false,
      confidence: 0.4,
      is_topic_change: true,
    });
    expect(r.success).toBe(true);
  });
  it('rejeita confidence fora de 0..1', () => {
    const r = IntentResolutionSchema.safeParse({
      resolves_pending: true,
      confidence: 1.5,
    });
    expect(r.success).toBe(false);
  });
});
