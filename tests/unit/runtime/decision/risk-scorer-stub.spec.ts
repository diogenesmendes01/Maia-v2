import { describe, it, expect } from 'vitest';
import { RiskScorerStubImpl } from '@/runtime/decision/risk-scorer.ts';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';

function mkBase(overrides?: Partial<BaseContextPacket>): BaseContextPacket {
  return {
    trace_id: 't1',
    tenant_id: 'tn1',
    agent_id: 'ag1',
    channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: false },
    actor: { id: 'a1', is_authenticated: true },
    input: { content_ref: 'cref', received_at: new Date() },
    ...overrides,
  };
}

describe('P9b — RiskScorer (stub)', () => {
  it('returns low risk for authenticated actor + low-risk intent', async () => {
    const scorer = new RiskScorerStubImpl();
    const result = await scorer.score({
      intent: { label: 'greet', confidence: 0.95 },
      base: mkBase(),
    });
    expect(result.level).toBe('low');
    expect(result.requires_human_review).toBe(false);
  });

  it('returns medium risk for unauthenticated actor', async () => {
    const scorer = new RiskScorerStubImpl();
    const result = await scorer.score({
      intent: { label: 'greet', confidence: 0.95 },
      base: mkBase({ actor: { id: 'a1', is_authenticated: false } }),
    });
    expect(result.level).toBe('medium');
    expect(result.reasons).toContain('actor_not_authenticated');
  });

  it('returns medium risk for high-risk intent (transfer)', async () => {
    const scorer = new RiskScorerStubImpl();
    const result = await scorer.score({
      intent: { label: 'transfer_intent', confidence: 0.85 },
      base: mkBase(),
    });
    expect(result.level).toBe('medium');
    expect(result.reasons).toContain('high_risk_intent:transfer_intent');
    expect(result.requires_human_review).toBe(false);
  });

  it('NEVER returns high level (P9b stub does not elevate beyond medium)', async () => {
    const scorer = new RiskScorerStubImpl();
    // Worst-case fixture: unauthenticated + high-risk intent.
    const result = await scorer.score({
      intent: { label: 'delete_account', confidence: 0.9 },
      base: mkBase({ actor: { id: 'a1', is_authenticated: false } }),
    });
    expect(result.level).toBe('medium');
    expect(result.level).not.toBe('high');
  });

  it('notes medium-risk intents (balance_query) without elevating heuristic', async () => {
    const scorer = new RiskScorerStubImpl();
    const result = await scorer.score({
      intent: { label: 'balance_query', confidence: 0.85 },
      base: mkBase(),
    });
    expect(result.level).toBe('low');
    expect(result.reasons).toContain('medium_intent_noted:balance_query');
  });

  it('no-downgrade invariant: medium from unauthenticated stays medium even on low-risk intent', async () => {
    const scorer = new RiskScorerStubImpl();
    const result = await scorer.score({
      intent: { label: 'balance_query', confidence: 0.85 },
      base: mkBase({ actor: { id: 'a1', is_authenticated: false } }),
    });
    expect(result.level).toBe('medium');
    // The medium_intent_noted reason path must NOT downgrade the level
    expect(result.reasons).toContain('actor_not_authenticated');
  });

  it('no-downgrade invariant: high-risk intent + unauth stays medium (P9b cap)', async () => {
    const scorer = new RiskScorerStubImpl();
    const result = await scorer.score({
      intent: { label: 'cancel_request', confidence: 0.9 },
      base: mkBase({ actor: { id: 'a1', is_authenticated: false } }),
    });
    expect(result.level).toBe('medium');
    expect(result.reasons).toContain('actor_not_authenticated');
    expect(result.reasons).toContain('high_risk_intent:cancel_request');
  });

  it('does NOT call any LLM (stub)', async () => {
    // No way to assert directly; the stub has no LLM dep injected.
    // Behavioral assertion: completes in <5ms reliably.
    const scorer = new RiskScorerStubImpl();
    const t0 = Date.now();
    await scorer.score({
      intent: { label: 'transfer_intent', confidence: 0.9 },
      base: mkBase(),
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(50);
  });
});
