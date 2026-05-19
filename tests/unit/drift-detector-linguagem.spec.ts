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

const { messagesCreateMock } = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn(function (this: unknown) {
    return { messages: { create: messagesCreateMock } };
  });
  return { default: Anthropic };
});

import { linguagemDetector } from '@/cognition/drift/linguagem.js';

function makeAnthropicReply(jsonObj: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(jsonObj) }],
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
    core_immutable: { identity_block: 'Maia', principles: [] } as unknown,
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
  return { id, from: 'agent', text, created_at: new Date() };
}

describe('linguagemDetector', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
  });

  it('drift_detected=true + severity_hint=medio → evidence com severity_hint=medio', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
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
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
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
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
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
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('Anthropic throws → null (defensivo)', async () => {
    messagesCreateMock.mockRejectedValueOnce(new Error('network exploded'));

    const out = await linguagemDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Beleza.')],
    });

    expect(out).toBeNull();
  });

  it('resposta sem JSON parseável → null', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'sem json aqui' }],
    });

    const out = await linguagemDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Beleza.')],
    });

    expect(out).toBeNull();
  });

  it('drift_detected=true sem severity_hint nem offensive → defaults aplicados (severity=baixo)', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ drift_detected: true }),
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
