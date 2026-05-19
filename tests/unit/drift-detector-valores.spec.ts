/**
 * P4 Task 8 (Cluster 1) — drift detector: valores (LLM-as-judge).
 *
 * Mesmo padrão de mock do tom.spec, mas o universo testado são os
 * `core_immutable.principles`. Inclui caso "sem princípios definidos →
 * retorna null sem chamar Anthropic".
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

import { valoresDetector } from '@/cognition/drift/valores.js';

function makeAnthropicReply(jsonObj: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(jsonObj) }],
  };
}

/**
 * valoresDetector reads `core_immutable.principles` directly from the profile
 * object via a legacy cast (TODO v3.1.1 migration in valores.ts). Until the
 * detector is migrated to read from profile_body.identity.priorities, the
 * fixture must expose core_immutable as a top-level field alongside the
 * canonical profile_body shape.
 */
function makeProfile(opts: { principles?: string[] } = {}) {
  const base = buildProfileVersion({
    _legacy: {
      core_immutable: {
        identity_block: 'Você é a Maia.',
        principles: opts.principles ?? [
          'Separação acima de tudo. PF é PF.',
          'Confirme antes de agir em coisas relevantes.',
          'Direta, não burocrática.',
        ],
      },
      operational_profile: { voice_descriptor: 'pt-br', thresholds: {} },
    },
  });
  // Mirror legacy top-level access that valores.ts relies on during migration.
  return Object.assign(base, {
    core_immutable: {
      identity_block: 'Você é a Maia.',
      principles: opts.principles ?? [
        'Separação acima de tudo. PF é PF.',
        'Confirme antes de agir em coisas relevantes.',
        'Direta, não burocrática.',
      ],
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

describe('valoresDetector', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
  });

  it('drift_detected=true → retorna DriftEvidence com type valores, payload com violated_principles', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
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
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
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

  it('Anthropic throws → retorna null (defensivo)', async () => {
    messagesCreateMock.mockRejectedValueOnce(new Error('network exploded'));

    const out = await valoresDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('algo')],
    });

    expect(out).toBeNull();
  });

  it('sem princípios definidos → retorna null sem chamar Anthropic', async () => {
    const out = await valoresDetector.detect({
      profile_active: makeProfile({ principles: [] }),
      recent_messages: [makeAgentMsg('algo')],
    });

    expect(out).toBeNull();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('sem mensagens do agente → retorna null sem chamar Anthropic', async () => {
    const out = await valoresDetector.detect({
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
      content: [{ type: 'text', text: 'sem json' }],
    });

    const out = await valoresDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('algo')],
    });

    expect(out).toBeNull();
  });

  it('drift_detected=true sem campos opcionais → defaults aplicados (severity medio)', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ drift_detected: true }),
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
