/**
 * P4 Task 8 (Cluster 3) — drift detector: linguagem (LLM-as-judge).
 *
 * Cobertura:
 *  - drift_detected=true + severity_hint='medio' → evidence com severity_hint='medio'
 *  - drift_detected=true + offensive:true → severity_hint='critico' (offensive override)
 *  - drift_detected=false → null
 *  - sem mensagens do agente → null sem chamar Anthropic
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentOperationalProfileVersion } from '@/db/schema.js';
import type { DriftRecentMessage } from '@/cognition/drift/types.js';

// [P86-C4] detector via callLLM (provider-agnostic).
const { callLLMMock } = vi.hoisted(() => ({ callLLMMock: vi.fn() }));

vi.mock('@/lib/claude.js', () => ({
  callLLM: callLLMMock,
}));

import { linguagemDetector } from '@/cognition/drift/linguagem.js';

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

function makeProfile(): AgentOperationalProfileVersion {
  const now = new Date();
  return {
    id: 'prof-1',
    tenant_id: 'default',
    agent_id: 'default',
    version: 1,
    status: 'active',
    profile_body: {
      schema_version: 'v3.1.1-2026-05-15',
      identity: {
        role_descriptor: 'Maia',
        voice: {
          tone: 'coloquial-profissional. Sem emojis.',
          formality: 'medium',
          verbosity: 'medium',
        },
        cognitive_limits: {
          max_inference_depth: 3,
          max_speculation_in_response: 0.2,
          confidence_floor_for_action: 0.7,
        },
        priorities: [],
        learned_voice_modifiers: [],
      },
      style: {
        language: 'Português brasileiro, coloquial-profissional. Sem emojis.',
        rhythm: {},
      },
      metadata: {
        effective_from: now.toISOString(),
        created_by: 'system_seed',
        previous_version_id: null,
      },
    } as unknown,
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
  return { id, from: 'agent', text, created_at: new Date() };
}

describe('linguagemDetector', () => {
  beforeEach(() => {
    callLLMMock.mockReset();
  });

  it('drift_detected=true + severity_hint=medio → evidence com severity_hint=medio', async () => {
    callLLMMock.mockResolvedValueOnce(
      makeLLMReply({
        drift_detected: true,
        severity_hint: 'medio',
        offensive: false,
        examples: ['mano', 'véi'],
        reasoning: 'vocabulário muito informal para o registro esperado',
      }),
    );

    const out = await linguagemDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('E aí mano, beleza véi?', 'm1')],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.drift_type).toBe('linguagem');
    expect(out.detected_by).toBe('drift_detector_linguagem');
    expect(out.payload['severity_hint']).toBe('medio');
    expect(out.payload['offensive']).toBe(false);
    expect(out.payload['examples']).toEqual(['mano', 'véi']);
    expect(out.payload['reasoning']).toBe('vocabulário muito informal para o registro esperado');
    expect(out.evidence_summary).toContain('vocabulário');
    expect(out.evidence_summary.length).toBeLessThanOrEqual(200);
  });

  it('drift_detected=true + offensive:true → severity_hint=critico (offensive override mesmo se hint=baixo)', async () => {
    callLLMMock.mockResolvedValueOnce(
      makeLLMReply({
        drift_detected: true,
        severity_hint: 'baixo',
        offensive: true,
        examples: ['xingamento_redacted'],
        reasoning: 'linguagem ofensiva detectada',
      }),
    );

    const out = await linguagemDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('mensagem ofensiva exemplo', 'm1')],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.payload['severity_hint']).toBe('critico');
    expect(out.payload['offensive']).toBe(true);
  });

  it('drift_detected=false → null', async () => {
    callLLMMock.mockResolvedValueOnce(
      makeLLMReply({
        drift_detected: false,
        severity_hint: 'baixo',
        offensive: false,
        examples: [],
        reasoning: 'vocabulário consistente com o descritor',
      }),
    );

    const out = await linguagemDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Beleza, registrei aqui.')],
    });

    expect(out).toBeNull();
  });

  it('sem mensagens do agente → null sem chamar Anthropic', async () => {
    const out = await linguagemDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [
        { id: 'u1', from: 'user', text: 'oi', created_at: new Date() },
      ],
    });

    expect(out).toBeNull();
    expect(callLLMMock).not.toHaveBeenCalled();
  });

  // [P86-C4] callLLM error propagates instead of swallow.
  it('callLLM throws → erro PROPAGA (não mais swallow)', async () => {
    callLLMMock.mockRejectedValueOnce(new Error('network exploded'));

    await expect(
      linguagemDetector.detect({
        profile_active: makeProfile(),
        recent_messages: [makeAgentMsg('Beleza.')],
      }),
    ).rejects.toThrow('network exploded');
  });

  it('resposta sem JSON parseável → null', async () => {
    callLLMMock.mockResolvedValueOnce({
      content: 'sem json aqui',
      tool_uses: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'mock-model',
    });

    const out = await linguagemDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Beleza.')],
    });

    expect(out).toBeNull();
  });

  it('drift_detected=true sem severity_hint nem offensive → defaults aplicados (severity=baixo)', async () => {
    callLLMMock.mockResolvedValueOnce(
      makeLLMReply({ drift_detected: true }),
    );

    const out = await linguagemDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Beleza.')],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.payload['severity_hint']).toBe('baixo');
    expect(out.payload['offensive']).toBe(false);
    expect(out.payload['examples']).toEqual([]);
    expect(out.payload['reasoning']).toBe('');
    expect(out.evidence_summary).toBe('drift de linguagem');
  });
});
