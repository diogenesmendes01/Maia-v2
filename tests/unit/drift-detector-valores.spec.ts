/**
 * P4 Task 8 (Cluster 1) — drift detector: valores (LLM-as-judge).
 *
 * Mesmo padrão de mock do tom.spec, mas o universo testado são os
 * `core_immutable.principles`. Inclui caso "sem princípios definidos →
 * retorna null sem chamar Anthropic".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentOperationalProfileVersion } from '@/db/schema.js';
import type { DriftRecentMessage } from '@/cognition/drift/types.js';

// [P86-C4] detector via callLLM (provider-agnostic).
const { callLLMMock } = vi.hoisted(() => ({ callLLMMock: vi.fn() }));

vi.mock('@/lib/claude.js', () => ({
  callLLM: callLLMMock,
}));

import { valoresDetector } from '@/cognition/drift/valores.js';

function makeLLMReply(jsonObj: Record<string, unknown>): {
  content: string;
  tool_uses: unknown[];
  stop_reason: 'end_turn';
  usage: { input_tokens: number; output_tokens: number };
  model: string;
} {
  return {
    content: JSON.stringify(jsonObj),
    tool_uses: [],
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    model: 'mock-model',
  };
}

function makeProfile(opts: { principles?: string[] } = {}): AgentOperationalProfileVersion {
  const now = new Date();
  return {
    id: 'prof-1',
    tenant_id: 'default',
    agent_id: 'default',
    version: 1,
    status: 'active',
    core_immutable: {
      identity_block: 'Você é a Maia.',
      principles: opts.principles ?? [
        'Separação acima de tudo. PF é PF.',
        'Confirme antes de agir em coisas relevantes.',
        'Direta, não burocrática.',
      ],
    } as unknown,
    operational_profile: { voice_descriptor: 'pt-br', thresholds: {} } as unknown,
    episodic_temp: {} as unknown,
    growth_backlog: [] as unknown,
    proposed_by: 'system_seed',
    proposed_reason: null,
    approved_by: 'system_seed',
    approved_at: now,
    activated_at: now,
    frozen_at: null,
    rolled_back_at: null,
    rollback_reason: null,
    created_at: now,
  } as unknown as AgentOperationalProfileVersion;
}

function makeAgentMsg(text: string, id = 'm-' + Math.random().toString(36).slice(2)): DriftRecentMessage {
  return {
    id,
    from: 'agent',
    text,
    created_at: new Date(),
  };
}

describe('valoresDetector', () => {
  beforeEach(() => {
    callLLMMock.mockReset();
  });

  it('drift_detected=true → retorna DriftEvidence com type valores, payload com violated_principles', async () => {
    callLLMMock.mockResolvedValueOnce(
      makeLLMReply({
        drift_detected: true,
        severity_hint: 'alto',
        violated_principles: [0],
        examples: ['msg misturando PF e PJ'],
        reasoning: 'agente sugeriu misturar contas PF e PJ',
      }),
    );

    const out = await valoresDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Pode lançar isso na conta PF mesmo sendo da empresa.')],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.drift_type).toBe('valores');
    expect(out.detected_by).toBe('drift_detector_valores');
    expect(out.payload['severity_hint']).toBe('alto');
    expect(out.payload['violated_principles']).toEqual([0]);
    expect(out.payload['examples']).toEqual(['msg misturando PF e PJ']);
    expect(out.payload['reasoning']).toBe('agente sugeriu misturar contas PF e PJ');
    expect(out.evidence_summary).toContain('misturar contas');
    expect(out.evidence_summary.length).toBeLessThanOrEqual(200);
  });

  it('drift_detected=false → retorna null', async () => {
    callLLMMock.mockResolvedValueOnce(
      makeLLMReply({
        drift_detected: false,
        severity_hint: 'baixo',
        violated_principles: [],
        examples: [],
        reasoning: 'consistente com princípios',
      }),
    );

    const out = await valoresDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Vou registrar na entidade PJ correta.')],
    });

    expect(out).toBeNull();
  });

  // [P86-C4] callLLM error propagates instead of swallow.
  it('callLLM throws → erro PROPAGA (não mais swallow)', async () => {
    callLLMMock.mockRejectedValueOnce(new Error('network exploded'));

    await expect(
      valoresDetector.detect({
        profile_active: makeProfile(),
        recent_messages: [makeAgentMsg('algo')],
      }),
    ).rejects.toThrow('network exploded');
  });

  it('sem princípios definidos → retorna null sem chamar Anthropic', async () => {
    const out = await valoresDetector.detect({
      profile_active: makeProfile({ principles: [] }),
      recent_messages: [makeAgentMsg('algo')],
    });

    expect(out).toBeNull();
    expect(callLLMMock).not.toHaveBeenCalled();
  });

  it('sem mensagens do agente → retorna null sem chamar Anthropic', async () => {
    const out = await valoresDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [
        { id: 'u1', from: 'user', text: 'oi', created_at: new Date() },
      ],
    });

    expect(out).toBeNull();
    expect(callLLMMock).not.toHaveBeenCalled();
  });

  it('resposta sem JSON parseável → retorna null', async () => {
    callLLMMock.mockResolvedValueOnce({
      content: 'sem json',
      tool_uses: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'mock-model',
    });

    const out = await valoresDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('algo')],
    });

    expect(out).toBeNull();
  });

  it('drift_detected=true sem campos opcionais → defaults aplicados (severity medio)', async () => {
    callLLMMock.mockResolvedValueOnce(
      makeLLMReply({ drift_detected: true }),
    );

    const out = await valoresDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('algo')],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.payload['severity_hint']).toBe('medio');
    expect(out.payload['violated_principles']).toEqual([]);
    expect(out.payload['examples']).toEqual([]);
    expect(out.payload['reasoning']).toBe('');
    expect(out.evidence_summary).toBe('drift de valores detectado');
  });
});
