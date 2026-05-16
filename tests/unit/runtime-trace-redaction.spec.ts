import { describe, it, expect } from 'vitest';
import { redactPacket } from '../../src/control-plane/runtime-trace/lib/redaction.js';
import type { ExecutionContextPacketStub } from '../../src/control-plane/runtime-trace/types.js';

/**
 * P10b — Redaction policy tests.
 *
 * Invariants:
 *   - redaction_class='standard' strips PII (text, media_refs, phone, etc.)
 *     but preserves structural keys (trace_id, decision, policy_id).
 *   - redaction_class='minimal' returns null body.
 *   - redaction_class='debug' returns packet as-is (caller encrypts).
 *   - bytes_redacted is non-zero when fields were dropped.
 */
describe('redactPacket', () => {
  const basePacket: ExecutionContextPacketStub = {
    trace_id: 't1',
    tenant_id: 'tenant-a',
    agent_id: 'agent-1',
    conversa_id: 'c1',
    turno_id: 'turn-1',
    request: {
      direction: 'inbound',
      text: 'Pagar boleto R$ 4500 da Maria 11999998888',
      media_refs: ['s3://bucket/boleto.pdf'],
      transcription: 'audio said the same',
    } as Record<string, unknown>,
    soul: { trust_level: 0.8, biases: { paciencia: 'alta' } },
    user_layer: { profile: { nome: 'Mariana', telefone: '+5511...' } },
    decision_meta: { risk_score: 0.4 },
  };

  it('standard strips PII fields but preserves structural keys', () => {
    const out = redactPacket(basePacket, 'standard');
    expect(out.packet).not.toBeNull();
    const p = out.packet!;
    expect(p.trace_id).toBe('t1');
    expect(p.tenant_id).toBe('tenant-a');
    expect(p.agent_id).toBe('agent-1');
    expect(p.conversa_id).toBe('c1');
    expect(p.turno_id).toBe('turn-1');
    expect(out.redaction_applied).toBe('standard_v1');

    // Request kept but PII fields blanked.
    const req = p.request as Record<string, unknown>;
    expect(req.direction).toBe('inbound');
    expect(req.text).toBeUndefined();
    expect(req.text_redacted).toBe(true);
    expect(req.media_refs).toBeUndefined();
    expect(req.media_refs_redacted).toBe(true);
    expect(req.transcription).toBeUndefined();
    expect(req.transcription_redacted).toBe(true);

    // Slices summarized (not verbatim).
    const soul = p.soul as Record<string, unknown>;
    expect(soul.__redacted).toBe(true);
    expect(typeof soul.sha256).toBe('string');
    expect((soul.sha256 as string).length).toBe(64);

    expect(out.bytes_redacted).toBeGreaterThan(0);
  });

  it('minimal returns null body (envelope is the proof)', () => {
    const out = redactPacket(basePacket, 'minimal');
    expect(out.packet).toBeNull();
    expect(out.redaction_applied).toBe('minimal_v1');
    expect(out.bytes_redacted).toBeGreaterThan(0);
  });

  it('debug returns packet as-is (caller MUST encrypt downstream)', () => {
    const out = redactPacket(basePacket, 'debug');
    expect(out.packet).toBeDefined();
    expect(out.redaction_applied).toBe('debug_encrypted_v1');
    // No bytes redacted because debug bypasses the stripper.
    expect(out.bytes_redacted).toBe(0);
    // Original PII still present (caller's job to encrypt!).
    expect(out.packet).toEqual(basePacket);
  });

  it('decision-related top-level keys (non-PII) pass through standard', () => {
    const out = redactPacket(basePacket, 'standard');
    const p = out.packet!;
    expect(p.decision_meta).toEqual({ risk_score: 0.4 });
  });

  it('handles missing optional slices gracefully', () => {
    const out = redactPacket(
      { trace_id: 't1', tenant_id: 'a', agent_id: 'b' },
      'standard',
    );
    expect(out.packet).not.toBeNull();
    expect(out.packet!.soul).toBeUndefined();
    expect(out.packet!.user_layer).toBeUndefined();
    expect(out.bytes_redacted).toBe(0);
  });
});
