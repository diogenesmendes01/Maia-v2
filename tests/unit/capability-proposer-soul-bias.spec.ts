/**
 * P8b — Tests for proposeSoulBiasFromDriftAlert (deterministic branch).
 *
 * Validates: chama capabilityProposalsRepo.create com capability_type='soul_bias';
 * proposed_spec é o SoulBiasProposalSpec; falha de repo → typed reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();

vi.mock('@/db/repositories.js', () => ({
  capabilityProposalsRepo: {
    create: createMock,
  },
}));

beforeEach(() => {
  createMock.mockReset();
});

describe('proposeSoulBiasFromDriftAlert (P8b)', () => {
  it('cria capability_proposal com capability_type=soul_bias e spec correto', async () => {
    createMock.mockResolvedValueOnce({ id: 'prop-new-1' });
    const { proposeSoulBiasFromDriftAlert } = await import('@/cognition/capability-proposer.js');
    const r = await proposeSoulBiasFromDriftAlert({
      spec: {
        scope: 'tenant',
        scope_value: '*',
        principle: 'humildade_v2',
        guidance: 'reforço de humildade',
        suggested_strength: 0.75,
        suggested_activation_context: { risk_level_min: 'medium' },
        suggested_origin: 'learned_strong_evidence',
        source_drift_alert_id: 'alert-1',
      },
      motivation: 'drift alto detectado em 5 mensagens',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.proposal_id).toBe('prop-new-1');

    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0]![0] as {
      capability_type: string;
      title: string;
      proposed_spec: { principle: string; suggested_origin: string };
    };
    expect(arg.capability_type).toBe('soul_bias');
    expect(arg.title).toContain('humildade_v2');
    expect(arg.proposed_spec.principle).toBe('humildade_v2');
    expect(arg.proposed_spec.suggested_origin).toBe('learned_strong_evidence');
  });

  it('falha do repo retorna { ok:false, reason:"repo_failed" } com message', async () => {
    createMock.mockRejectedValueOnce(new Error('db down'));
    const { proposeSoulBiasFromDriftAlert } = await import('@/cognition/capability-proposer.js');
    const r = await proposeSoulBiasFromDriftAlert({
      spec: {
        scope: 'tenant',
        scope_value: '*',
        principle: 'x',
        guidance: 'g',
        suggested_strength: 0.8,
        suggested_activation_context: {},
        suggested_origin: 'human_approved',
      },
      motivation: 'm',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('repo_failed');
      expect(r.message).toContain('db down');
    }
  });
});
