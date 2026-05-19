/**
 * P4 Task 8 (Cluster 1) — drift detector: tom (LLM-as-judge).
 *
 * Padrão de mock copiado de tests/unit/step-evaluator-llm-judge.spec.ts:
 * vi.mock do @anthropic-ai/sdk com um messagesCreateMock controlável.
 *
 * Cenários cobertos:
 *  - drift_detected=true → retorna DriftEvidence com type='tom', payload contém severity_hint
 *  - drift_detected=false → retorna null
 *  - Anthropic throws → retorna null (defensivo)
 *  - sem mensagens do agente → retorna null sem chamar Anthropic
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DriftRecentMessage } from '@/cognition/drift/types.js';
import { buildProfileVersion } from '../fixtures/agentProfile.js';

const messagesCreateMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn().mockImplementation(() => ({
    messages: { create: messagesCreateMock },
  }));
  return { default: Anthropic };
});

import { tomDetector } from '@/cognition/drift/tom.js';

function makeAnthropicReply(jsonObj: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(jsonObj) }],
  };
}

function makeProfile() {
  return buildProfileVersion({
    _legacy: {
      core_immutable: {
        identity_block: 'Você é a Maia, assistente financeira.',
        principles: ['Direta, não burocrática.'],
      },
      operational_profile: {
        voice_descriptor: 'Português brasileiro, coloquial-profissional. Sem emojis.',
        thresholds: {},
      },
    },
  });
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
    messagesCreateMock.mockReset();
  });

  it('drift_detected=true → retorna DriftEvidence com type tom, detected_by drift_detector_tom, payload com severity_hint', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
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
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
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

  it('Anthropic throws → retorna null (defensivo)', async () => {
    messagesCreateMock.mockRejectedValueOnce(new Error('network exploded'));

    const out = await tomDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Beleza, registrei.')],
    });

    expect(out).toBeNull();
  });

  it('sem mensagens do agente → retorna null sem chamar Anthropic', async () => {
    const out = await tomDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [
        { id: 'u1', from: 'user', text: 'oi', created_at: new Date() },
      ],
    });

    expect(out).toBeNull();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('resposta sem JSON parseável → retorna null', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'desculpe, sem json aqui' }],
    });

    const out = await tomDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Beleza.')],
    });

    expect(out).toBeNull();
  });

  it('drift_detected=true sem severity_hint/examples/reasoning → defaults aplicados', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ drift_detected: true }),
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
