/**
 * P4 Task 8 (Cluster 2) — drift detector: vies (regex + LLM).
 *
 * Cobertura:
 *  - regex match + Anthropic confirma → evidence com severity_hint do LLM
 *  - sem regex match → null SEM chamar Anthropic
 *  - regex match + Anthropic nega (drift_detected:false) → null
 *  - regex match + Anthropic throws → evidence com llm_error:true, severity baixo (regex floor)
 *  - regex match + Anthropic devolve resposta sem JSON parseável → evidence com llm_unparseable:true, severity baixo
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

import { viesDetector } from '@/cognition/drift/vies.js';

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
      core_immutable: { identity_block: 'Maia', principles: [] },
      operational_profile: { voice_descriptor: 'pt-br', thresholds: {} },
    },
  });
}

function makeAgentMsg(text: string, id = 'm-' + Math.random().toString(36).slice(2)): DriftRecentMessage {
  return { id, from: 'agent', text, created_at: new Date() };
}

describe('viesDetector', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
  });

  it('msg "todos os clientes preferem PIX" + Anthropic confirma → evidence com severity_hint=medio', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
        drift_detected: true,
        severity_hint: 'medio',
        confirmed: [{ pattern: 'todos os clientes', verdict: 'bias_real' }],
        reasoning: 'generalização sobre todos os clientes',
      }),
    );

    const out = await viesDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Todos os clientes preferem PIX, pode confiar.', 'm1')],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.drift_type).toBe('vies');
    expect(out.detected_by).toBe('drift_detector_vies');
    expect(out.payload['severity_hint']).toBe('medio');
    expect(out.payload['reasoning']).toBe('generalização sobre todos os clientes');
    const regexMatches = out.payload['regex_matches'] as Array<Record<string, unknown>>;
    expect(regexMatches.length).toBeGreaterThanOrEqual(1);
    expect(regexMatches[0]['message_id']).toBe('m1');
    expect(out.evidence_summary).toContain('generalização');
    expect(out.evidence_summary.length).toBeLessThanOrEqual(200);
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
  });

  it('msg sem generalização regex → null SEM chamar Anthropic', async () => {
    const out = await viesDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Esse cliente específico prefere PIX, confirmei com ele.')],
    });

    expect(out).toBeNull();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('msg com regex match MAS Anthropic devolve drift_detected:false → null', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
        drift_detected: false,
        severity_hint: 'baixo',
        confirmed: [],
        reasoning: 'apenas um padrão linguístico, sem viés',
      }),
    );

    const out = await viesDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Todos os meses fechamos no dia 20.')],
    });

    expect(out).toBeNull();
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
  });

  it('regex match + Anthropic throws → evidence com llm_error:true e severity baixo (regex floor)', async () => {
    messagesCreateMock.mockRejectedValueOnce(new Error('network exploded'));

    const out = await viesDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Todos os clientes preferem PIX.', 'm1')],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.drift_type).toBe('vies');
    expect(out.payload['llm_error']).toBe(true);
    expect(out.payload['severity_hint']).toBe('baixo');
    const regexMatches = out.payload['regex_matches'] as Array<Record<string, unknown>>;
    expect(regexMatches.length).toBeGreaterThanOrEqual(1);
    expect(out.evidence_summary).toContain('LLM falhou');
  });

  it('regex match + Anthropic responde sem JSON parseável → evidence com llm_unparseable:true, severity baixo', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'desculpe, sem json estruturado aqui' }],
    });

    const out = await viesDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Todos os clientes preferem PIX.')],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.payload['llm_unparseable']).toBe(true);
    expect(out.payload['severity_hint']).toBe('baixo');
    expect(out.evidence_summary).toContain('LLM não classificou');
  });

  it('mensagens do usuário NÃO entram na detecção (só do agente)', async () => {
    const out = await viesDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [
        { id: 'u1', from: 'user', text: 'Todos os clientes preferem PIX, né?', created_at: new Date() },
      ],
    });

    expect(out).toBeNull();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });
});
