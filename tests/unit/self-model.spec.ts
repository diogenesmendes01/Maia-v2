import { describe, it, expect } from 'vitest';
import { computeConfidence } from '@/cognition/self-model.js';

describe('computeConfidence', () => {
  it('zero evidence → confidence próximo de 0', () => {
    const c = computeConfidence({
      success_count: 0,
      failure_count: 0,
      evidence_count: 0,
      days_since_last_failure: 0,
    });
    expect(c).toBe(0);
  });

  it('all success, mature, recent → confidence próximo de 1', () => {
    const c = computeConfidence({
      success_count: 50,
      failure_count: 0,
      evidence_count: 50,
      days_since_last_failure: 365, // sem falha em 1 ano
    });
    expect(c).toBeGreaterThan(0.95);
    expect(c).toBeLessThanOrEqual(1);
  });

  it('falha recente puxa confidence pra baixo', () => {
    const recent = computeConfidence({
      success_count: 50,
      failure_count: 5,
      evidence_count: 55,
      days_since_last_failure: 1, // falha ontem
    });
    const oldFailure = computeConfidence({
      success_count: 50,
      failure_count: 5,
      evidence_count: 55,
      days_since_last_failure: 90, // falha 3 meses atrás
    });
    expect(recent).toBeLessThan(oldFailure);
  });

  it('maturity factor satura em evidence_count >= N_MIN (10)', () => {
    const lowEvidence = computeConfidence({
      success_count: 3,
      failure_count: 0,
      evidence_count: 3,
      days_since_last_failure: 100,
    });
    const highEvidence = computeConfidence({
      success_count: 100,
      failure_count: 0,
      evidence_count: 100,
      days_since_last_failure: 100,
    });
    // Both 100% success rate, but maturity differs.
    expect(highEvidence).toBeGreaterThan(lowEvidence);
    // High evidence should be close to ceiling
    expect(highEvidence).toBeGreaterThan(0.9);
  });

  it('half success/half failure → confidence ~= 0.5 quando maduro e sem falha recente', () => {
    const c = computeConfidence({
      success_count: 50,
      failure_count: 50,
      evidence_count: 100,
      days_since_last_failure: 365,
    });
    expect(c).toBeGreaterThan(0.4);
    expect(c).toBeLessThan(0.6);
  });
});
