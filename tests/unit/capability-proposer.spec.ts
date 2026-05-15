/**
 * P5 Task 7 — capability-proposer.
 *
 * Sonnet-based proposer wrapped em runCognitiveModule (timeout 15s + fallback null
 * + audit). Único módulo LLM do P5; gated por feature flag
 * `DIALOGICAL_ACQUISITION` para evitar spend sem governança.
 *
 * Cenários cobertos:
 *  1. happy path → ok + proposal_id + draft
 *  2. LLM devolve JSON sem campos obrigatórios → parse_failed
 *  3. Anthropic throws → runCognitiveModule fallback=null → parse_failed
 *  4. LLM devolve texto sem JSON parseável → parse_failed
 *  5. Repo throws → repo_failed (com message)
 *  6. Feature flag OFF → llm_unavailable com message=flag_off, sem chamar Anthropic
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { anthropicCreateMock, createProposalMock } = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(),
  createProposalMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn().mockImplementation(() => ({
    messages: { create: anthropicCreateMock },
  }));
  return { default: Anthropic };
});

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    capabilityProposalsRepo: { create: createProposalMock },
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => {}),
      recentByModule: vi.fn(async () => []),
    },
  };
});

import { proposeCapabilityForGap } from '@/cognition/capability-proposer.js';
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';

beforeEach(() => {
  anthropicCreateMock.mockReset();
  createProposalMock.mockReset();
  featureFlags.override(FeatureFlagName.DIALOGICAL_ACQUISITION, true);
});

afterEach(() => {
  featureFlags.reset();
});

function makeFakeGap() {
  return {
    id: 'gap-1',
    tenant_id: 'default',
    agent_id: 'default',
    capability_description: 'test gap',
    tipo: 'tool',
    contexto: 'cliente perguntou rastreamento',
    frequency_score: 5,
    severity_score: 4,
    current_level: 'proposed',
    source_candidate_id: null,
    last_observed: new Date(),
    last_level_change_at: new Date(),
    created_at: new Date(),
  } as never;
}

function happyJson(): string {
  return JSON.stringify({
    capability_type: 'tool',
    title: 'Rastreador de Pedidos',
    description: 'Tool para consultar status de pedido por ID',
    proposed_spec: { inputs: ['order_id'], outputs: ['status'] },
    motivation: 'Pergunta recorrente sem capability disponível',
    expected_impact: 'Resolve 5+ casos/semana',
    test_scenarios: [
      { name: 'feliz', given: 'pedido existe', when: 'consulta', then: 'retorna status' },
    ],
  });
}

describe('proposeCapabilityForGap', () => {
  it('happy path: retorna ok com draft e proposal_id', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: happyJson() }],
    });
    createProposalMock.mockResolvedValueOnce({ id: 'prop-1' });

    const r = await proposeCapabilityForGap({ gap: makeFakeGap() });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.proposal_id).toBe('prop-1');
      expect(r.draft.title).toBe('Rastreador de Pedidos');
      expect(r.draft.capability_type).toBe('tool');
      expect(r.draft.test_scenarios.length).toBe(1);
    }
    expect(createProposalMock).toHaveBeenCalledTimes(1);
    const createArgs = createProposalMock.mock.calls[0]?.[0] as {
      gap_id: string;
      capability_type: string;
      title: string;
    };
    expect(createArgs.gap_id).toBe('gap-1');
    expect(createArgs.capability_type).toBe('tool');
  });

  it('JSON sem campos obrigatórios → parse_failed', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"capability_type":"tool"}' }],
    });

    const r = await proposeCapabilityForGap({ gap: makeFakeGap() });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('parse_failed');
    expect(createProposalMock).not.toHaveBeenCalled();
  });

  it('Anthropic throws → runCognitiveModule fallback=null → parse_failed', async () => {
    anthropicCreateMock.mockRejectedValueOnce(new Error('boom'));

    const r = await proposeCapabilityForGap({ gap: makeFakeGap() });

    expect(r.ok).toBe(false);
    // Throw → status='error', output=null (fallback) → parse_failed
    if (!r.ok) expect(r.reason).toBe('parse_failed');
    expect(createProposalMock).not.toHaveBeenCalled();
  });

  it('LLM devolve texto sem JSON parseável → parse_failed', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'desculpe, sem json aqui' }],
    });

    const r = await proposeCapabilityForGap({ gap: makeFakeGap() });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('parse_failed');
    expect(createProposalMock).not.toHaveBeenCalled();
  });

  it('repo lança erro → repo_failed com message', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: happyJson() }],
    });
    createProposalMock.mockRejectedValueOnce(new Error('db down'));

    const r = await proposeCapabilityForGap({ gap: makeFakeGap() });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('repo_failed');
      expect(r.message).toContain('db down');
    }
  });

  it('feature flag OFF → llm_unavailable com message=flag_off, sem chamar Anthropic', async () => {
    featureFlags.override(FeatureFlagName.DIALOGICAL_ACQUISITION, false);

    const r = await proposeCapabilityForGap({ gap: makeFakeGap() });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('llm_unavailable');
      expect(r.message).toBe('flag_off');
    }
    expect(anthropicCreateMock).not.toHaveBeenCalled();
    expect(createProposalMock).not.toHaveBeenCalled();
  });

  it('inclui evidências recentes no user prompt quando fornecidas (limita a 5)', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: happyJson() }],
    });
    createProposalMock.mockResolvedValueOnce({ id: 'prop-2' });

    const evidence = Array.from({ length: 7 }, (_, i) => ({
      context: `evidência ${i + 1}`,
      created_at: new Date(),
    }));

    await proposeCapabilityForGap({ gap: makeFakeGap(), recent_evidence: evidence });

    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    const callArgs = anthropicCreateMock.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    const userPrompt = callArgs.messages[0]!.content;
    expect(userPrompt).toContain('EVIDÊNCIAS RECENTES');
    expect(userPrompt).toContain('evidência 1');
    expect(userPrompt).toContain('evidência 5');
    // 6 e 7 não devem entrar (slice(0,5))
    expect(userPrompt).not.toContain('evidência 6');
    expect(userPrompt).not.toContain('evidência 7');
  });
});
