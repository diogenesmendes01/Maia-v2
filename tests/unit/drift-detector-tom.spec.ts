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

const { messagesCreateMock } = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn(function (this: unknown) {
    return { messages: { create: messagesCreateMock } };
  });
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

  it('Drizzle-shaped row (no direct-embed legacy, only canonical profile_body) — detector reads via resolver synthesized view', async () => {
    // Codex review #163 round 4 [high]: admin-ui-created rows have only
    // canonical profile_body.identity, no direct-embed legacy. The detector
    // must still see identity_block + voice from the synthesized resolver
    // view so it doesn't run against an empty baseline.
    messagesCreateMock.mockResolvedValue(
      makeAnthropicReply({ drift_detected: true, severity_hint: 'medio' }),
    );

    // Hand-built Drizzle-shaped row — bypasses the fixture's default legacy
    // embed so we exercise the resolver's canonical-only path.
    const now = new Date();
    const canonicalOnly = {
      id: 'prof-canonical',
      tenant_id: 'default',
      agent_id: 'default',
      version: 1,
      status: 'active' as const,
      profile_body: {
        schema_version: 'v3.1.1-2026-05-15',
        identity: {
          role_descriptor: 'Você é a Maia (canonical-only).',
          voice: { tone: 'tom canonical', formality: 'medium', verbosity: 'medium' },
          cognitive_limits: {
            max_inference_depth: 3,
            max_speculation_in_response: 0.2,
            confidence_floor_for_action: 0.7,
          },
          priorities: ['p-canonical'],
          learned_voice_modifiers: [],
        },
        style: { language: 'pt-BR', rhythm: {} },
        metadata: {
          effective_from: now.toISOString(),
          created_by: 'admin-ui',
          previous_version_id: null,
        },
      },
      proposed_by: 'admin-ui',
      proposed_reason: null,
      approved_by: 'founder-1',
      approved_at: now,
      activated_at: now,
      frozen_at: null,
      rolled_back_at: null,
      rollback_reason: null,
      created_at: now,
    } as unknown as Parameters<typeof tomDetector.detect>[0]['profile_active'];

    const out = await tomDetector.detect({
      profile_active: canonicalOnly,
      recent_messages: [makeAgentMsg('hey')],
    });
    expect(out).not.toBeNull();

    const calls = messagesCreateMock.mock.calls;
    expect(calls.length).toBe(1);
    const prompt = String(
      (calls[0]?.[0] as { messages?: Array<{ content?: string }> })?.messages?.[0]?.content ??
        '',
    );
    // identity_block synthesized from role_descriptor; voice from voice.tone.
    expect(prompt).toContain('Você é a Maia (canonical-only).');
    expect(prompt).toContain('tom canonical');
  });
});
