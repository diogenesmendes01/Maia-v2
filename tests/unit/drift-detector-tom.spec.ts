/**
 * P4 Task 8 (Cluster 1) — drift detector: tom (LLM-as-judge).
 *
 * [P86-C4] Detector agora roteia via `callLLM` (provider-agnostic) em vez
 * de instanciar Anthropic direto. Mock atualizado para interceptar `callLLM`
 * — cobertura de provider/Anthropic/OpenRouter via uma única superfície.
 * Erros de provider PROPAGAM (throw) ao orchestrator; o teste antigo
 * "Anthropic throws → retorna null" foi atualizado para "callLLM throws →
 * propaga ao runner" (responsabilidade do orchestrator, não do detector).
 *
 * Cenários cobertos:
 *  - drift_detected=true → retorna DriftEvidence com type='tom', payload contém severity_hint
 *  - drift_detected=false → retorna null
 *  - callLLM throws → erro propaga (não mais swallow silencioso)
 *  - sem mensagens do agente → retorna null sem chamar callLLM
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentOperationalProfileVersion } from '@/db/schema.js';
import type { DriftRecentMessage } from '@/cognition/drift/types.js';

const { callLLMMock } = vi.hoisted(() => ({ callLLMMock: vi.fn() }));

vi.mock('@/lib/claude.js', () => ({
  callLLM: callLLMMock,
}));

import { tomDetector } from '@/cognition/drift/tom.js';

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
    core_immutable: {
      identity_block: 'Você é a Maia, assistente financeira.',
      principles: ['Direta, não burocrática.'],
    } as unknown,
    operational_profile: {
      voice_descriptor: 'Português brasileiro, coloquial-profissional. Sem emojis.',
      thresholds: {},
    } as unknown,
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

describe('tomDetector', () => {
  beforeEach(() => {
    callLLMMock.mockReset();
  });

  it('drift_detected=true → retorna DriftEvidence com type tom, detected_by drift_detector_tom, payload com severity_hint', async () => {
    callLLMMock.mockResolvedValueOnce(
      makeLLMReply({
        drift_detected: true,
        severity_hint: 'medio',
        examples: ['msg X'],
        reasoning: 'tom mudou para excessivamente formal',
      }),
    );

    const out = await tomDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Prezado senhor, gostaria de informar...')],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.drift_type).toBe('tom');
    expect(out.detected_by).toBe('drift_detector_tom');
    expect(out.payload['severity_hint']).toBe('medio');
    expect(out.payload['examples']).toEqual(['msg X']);
    expect(out.payload['reasoning']).toBe('tom mudou para excessivamente formal');
    expect(out.evidence_summary).toContain('tom mudou');
    expect(out.evidence_summary.length).toBeLessThanOrEqual(200);
  });

  it('drift_detected=false → retorna null', async () => {
    callLLMMock.mockResolvedValueOnce(
      makeLLMReply({
        drift_detected: false,
        severity_hint: 'baixo',
        examples: [],
        reasoning: 'tom consistente',
      }),
    );

    const out = await tomDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Beleza, registrei aqui.')],
    });

    expect(out).toBeNull();
  });

  // [P86-C4] callLLM failure now propagates instead of being swallowed as
  // "no drift". The orchestrator's runCognitiveModule catches and audits
  // the error as `status:'error'`. Visibility of provider failures is the
  // explicit fix.
  it('callLLM throws → erro PROPAGA (não mais swallow silencioso)', async () => {
    callLLMMock.mockRejectedValueOnce(new Error('network exploded'));

    await expect(
      tomDetector.detect({
        profile_active: makeProfile(),
        recent_messages: [makeAgentMsg('Beleza, registrei.')],
      }),
    ).rejects.toThrow('network exploded');
  });

  it('sem mensagens do agente → retorna null sem chamar callLLM', async () => {
    const out = await tomDetector.detect({
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
      content: 'desculpe, sem json aqui',
      tool_uses: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'mock-model',
    });

    const out = await tomDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Beleza.')],
    });

    expect(out).toBeNull();
  });

  it('drift_detected=true sem severity_hint/examples/reasoning → defaults aplicados', async () => {
    callLLMMock.mockResolvedValueOnce(
      makeLLMReply({ drift_detected: true }),
    );

    const out = await tomDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Beleza.')],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.payload['severity_hint']).toBe('baixo');
    expect(out.payload['examples']).toEqual([]);
    expect(out.payload['reasoning']).toBe('');
    expect(out.evidence_summary).toBe('drift de tom detectado');
  });
});
