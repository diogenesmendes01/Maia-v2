/**
 * P8d §6 — drift detector: papel (LLM-as-judge).
 *
 * Verifica se as mensagens recentes do agente aderem ao `role_descriptor`
 * declarado no `profile_body.identity`. 9º detector (alongside soul_drift
 * de P8b). Padrão idêntico ao `valores.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentOperationalProfileVersion, ProfileBody } from '@/db/schema.js';
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

import { papelDriftDetector } from '@/cognition/drift/papel.js';

function makeAnthropicReply(jsonObj: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(jsonObj) }],
  };
}

function makeProfile(opts: {
  role_descriptor?: string;
  priorities?: string[];
} = {}): AgentOperationalProfileVersion {
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
        role_descriptor: opts.role_descriptor ?? 'atendimento_financeiro_pf',
        voice: { tone: '', formality: 'medium', verbosity: 'concise' },
        cognitive_limits: {
          max_inference_depth: 3,
          max_speculation_in_response: 0.2,
          confidence_floor_for_action: 0.7,
        },
        priorities: opts.priorities ?? ['preservar_capital', 'clareza'],
        learned_voice_modifiers: [],
      },
      style: { language: 'pt-BR', rhythm: {} },
      metadata: {
        effective_from: now.toISOString(),
        created_by: 'test',
        previous_version_id: null,
      },
    } as unknown as ProfileBody,
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

describe('papelDriftDetector (§6)', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
  });

  it('drift_detected=true → retorna DriftEvidence com type papel_drift, payload completo', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
        drift_detected: true,
        severity_hint: 'alto',
        off_role_examples: ['parecer jurídico', 'ações tech'],
        observed_role_inferred: 'consultoria_juridica_e_investimentos',
        reasoning: 'Agente ofereceu parecer jurídico mas papel é atendimento financeiro PF.',
      }),
    );

    const out = await papelDriftDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [
        makeAgentMsg('Vou preparar um parecer jurídico sobre sua causa.'),
        makeAgentMsg('Recomendo investir em ações tech.'),
        makeAgentMsg('Outra mensagem fora do papel.'),
      ],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.drift_type).toBe('papel_drift');
    expect(out.detected_by).toBe('drift_detector_papel');
    expect(out.payload['severity_hint']).toBe('alto');
    expect(out.payload['declared_role']).toBe('atendimento_financeiro_pf');
    expect(out.payload['observed_role_inferred']).toBe(
      'consultoria_juridica_e_investimentos',
    );
    const offRole = out.payload['off_role_examples'];
    expect(Array.isArray(offRole)).toBe(true);
    expect(offRole).toHaveLength(2);
    expect(out.evidence_summary).toContain('jurídico');
    expect(out.evidence_summary.length).toBeLessThanOrEqual(200);
  });

  it('drift_detected=false → retorna null', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ drift_detected: false }),
    );
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Lançado: -R$ 100,00, energia, Itaú.')],
    });
    expect(out).toBeNull();
  });

  it("role_descriptor='unset' → retorna null sem chamar Anthropic", async () => {
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile({ role_descriptor: 'unset' }),
      recent_messages: [makeAgentMsg('alguma mensagem')],
    });
    expect(out).toBeNull();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it("role_descriptor vazio '' → retorna null sem chamar Anthropic", async () => {
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile({ role_descriptor: '' }),
      recent_messages: [makeAgentMsg('alguma mensagem')],
    });
    expect(out).toBeNull();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('sem mensagens do agente → retorna null sem chamar Anthropic', async () => {
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [
        { id: 'u1', from: 'user', text: 'oi', created_at: new Date() },
      ],
    });
    expect(out).toBeNull();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('Anthropic throws → retorna null (defensivo)', async () => {
    messagesCreateMock.mockRejectedValueOnce(new Error('API down'));
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('algo')],
    });
    expect(out).toBeNull();
  });

  it('JSON inválido na resposta → retorna null', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'não tem json' }],
    });
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('algo')],
    });
    expect(out).toBeNull();
  });

  it('drift_detected=true sem campos opcionais → defaults aplicados', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ drift_detected: true }),
    );
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('algo')],
    });
    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.payload['severity_hint']).toBe('medio');
    expect(out.payload['declared_role']).toBe('atendimento_financeiro_pf');
    expect(out.payload['observed_role_inferred']).toBeNull();
    expect(out.payload['off_role_examples']).toEqual([]);
    expect(out.evidence_summary).toBe('papel desviado');
  });

  it('priorities vazias → continua chamando Anthropic (drift independe)', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ drift_detected: false }),
    );
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile({ priorities: [] }),
      recent_messages: [makeAgentMsg('algo')],
    });
    expect(out).toBeNull();
    expect(messagesCreateMock).toHaveBeenCalledOnce();
  });
});
