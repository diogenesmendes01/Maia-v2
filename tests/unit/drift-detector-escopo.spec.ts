/**
 * P4 Task 8 (Cluster 3) — drift detector: escopo (LLM-driven).
 *
 * Cobertura:
 *  - LLM extrai promessa cuja capability_required ESTÁ active → null
 *  - LLM extrai promessa cuja capability_required NÃO existe entre as active → evidence
 *  - sem mensagens do agente → null sem chamar Anthropic
 *  - Anthropic throws → null (defensivo)
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

import { escopoDetector } from '@/cognition/drift/escopo.js';

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
  return { id, from: 'agent', text, created_at: new Date() };
}

describe('escopoDetector', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
  });

  it('LLM extrai promessa "envio_pix" e capability "envio_pix" está active → null (promessa cumprível)', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
        promises: [
          { message_id: 'm1', promise: 'vou te enviar pix', capability_required: 'envio_pix' },
        ],
        reasoning: 'agente prometeu envio de pix',
      }),
    );

    const out = await escopoDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Pode deixar, vou te enviar pix agora.', 'm1')],
      capabilities: [
        { name: 'envio_pix', status: 'active' },
        { name: 'agendamento_reuniao', status: 'inactive' },
      ],
    });

    expect(out).toBeNull();
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
  });

  it('LLM extrai promessa "envio_invoice" mas nenhuma capability com esse nome existe → evidence com unfulfillable_promises', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
        promises: [
          {
            message_id: 'm1',
            promise: 'vou te emitir uma nota fiscal',
            capability_required: 'envio_invoice',
          },
        ],
        reasoning: 'agente prometeu emitir invoice',
      }),
    );

    const out = await escopoDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Claro, vou te emitir uma nota fiscal já.', 'm1')],
      capabilities: [{ name: 'envio_pix', status: 'active' }],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.drift_type).toBe('escopo');
    expect(out.detected_by).toBe('drift_detector_escopo');
    const unfulfillable = out.payload['unfulfillable_promises'] as Array<Record<string, unknown>>;
    expect(unfulfillable).toHaveLength(1);
    expect(unfulfillable[0]['capability_required']).toBe('envio_invoice');
    expect(out.payload['severity_hint']).toBe('alto');
    expect(out.evidence_summary).toContain('1 promessas sem capability ativa');
    expect(out.evidence_summary.length).toBeLessThanOrEqual(200);
  });

  it('sem mensagens do agente → null sem chamar Anthropic', async () => {
    const out = await escopoDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [
        { id: 'u1', from: 'user', text: 'oi', created_at: new Date() },
      ],
      capabilities: [{ name: 'envio_pix', status: 'active' }],
    });

    expect(out).toBeNull();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('Anthropic throws → null (defensivo)', async () => {
    messagesCreateMock.mockRejectedValueOnce(new Error('network exploded'));

    const out = await escopoDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Vou te enviar agora.')],
      capabilities: [{ name: 'envio_pix', status: 'active' }],
    });

    expect(out).toBeNull();
  });

  it('capability com mesmo nome mas status="inactive" → tratada como ausente (drift)', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
        promises: [
          { message_id: 'm1', promise: 'agendamento', capability_required: 'agendamento_reuniao' },
        ],
        reasoning: 'agente prometeu agendar reunião',
      }),
    );

    const out = await escopoDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Vou agendar a reunião pra você.', 'm1')],
      capabilities: [{ name: 'agendamento_reuniao', status: 'inactive' }],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    const unfulfillable = out.payload['unfulfillable_promises'] as Array<Record<string, unknown>>;
    expect(unfulfillable).toHaveLength(1);
  });

  it('3 promessas sem capability → severity_hint=critico', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
        promises: [
          { message_id: 'm1', promise: 'p1', capability_required: 'cap_x' },
          { message_id: 'm1', promise: 'p2', capability_required: 'cap_y' },
          { message_id: 'm1', promise: 'p3', capability_required: 'cap_z' },
        ],
      }),
    );

    const out = await escopoDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Vou fazer x, y e z.', 'm1')],
      capabilities: [{ name: 'cap_w', status: 'active' }],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.payload['severity_hint']).toBe('critico');
  });
});
