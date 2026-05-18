import { describe, it, expect, vi } from 'vitest';

// Redaction uses logger.debug for unknown-field telemetry; mock it so
// tests don't depend on a real logger transport.
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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

  // ============================================================
  // Codex review #102 — issue 5 (strict allowlist).
  // ============================================================
  it('drops unknown top-level fields (e.g. caller-added free text)', () => {
    const packet: ExecutionContextPacketStub = {
      trace_id: 't1',
      tenant_id: 'a',
      agent_id: 'b',
      // Things a careless caller might dump at top level:
      raw_message: 'pagar boleto da Maria 11999998888',
      sender_phone: '+5511999998888',
      tool_call_args: { cpf: '12345678900', email: 'maria@example.com' },
    };
    const out = redactPacket(packet, 'standard');
    expect(out.packet).not.toBeNull();
    const p = out.packet!;
    // Unknown keys dropped.
    expect(p.raw_message).toBeUndefined();
    expect(p.sender_phone).toBeUndefined();
    expect(p.tool_call_args).toBeUndefined();
    // Counter present.
    expect(p._redaction_dropped_unknown_count).toBe(3);
    expect(out.bytes_redacted).toBeGreaterThan(0);
  });

  it('drops unknown request.* fields too (allowlist within request)', () => {
    const packet: ExecutionContextPacketStub = {
      trace_id: 't1',
      tenant_id: 'a',
      agent_id: 'b',
      request: {
        direction: 'inbound',
        // Free-text injected as a non-standard key:
        custom_payload: 'CPF 123.456.789-00 conta 12345-6',
      } as Record<string, unknown>,
    };
    const out = redactPacket(packet, 'standard');
    const req = out.packet!.request as Record<string, unknown>;
    expect(req.direction).toBe('inbound');
    expect(req.custom_payload).toBeUndefined();
    expect(req._other_dropped).toBe(1);
  });

  // PII regex property test (Codex review #102 — issue 5).
  describe('PII regex property test (standard output contains no PII matches)', () => {
    const PII_REGEXES = [
      // CPF (Brazilian taxpayer ID), with or without punctuation.
      /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/,
      // CNPJ (Brazilian company ID).
      /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/,
      // Email.
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
      // BR phone (with country code, with or without spaces).
      /\+?55\s?\(?\d{2}\)?\s?\d{4,5}-?\d{4}\b/,
    ];

    function generatePiiPayload(seed: number): ExecutionContextPacketStub {
      const cpfs = [
        '123.456.789-00',
        '98765432100',
        '111.222.333-44',
        '555.666.777-88',
        '00099988877',
      ];
      const cnpjs = ['12.345.678/0001-99', '99887766000155'];
      const emails = ['maria@example.com', 'joao.silva@empresa.com.br', 'admin@test.io'];
      const phones = ['+5511999998888', '+55 21 98765-4321', '55119988877766'];
      const i = seed % cpfs.length;
      const j = seed % cnpjs.length;
      const k = seed % emails.length;
      const m = seed % phones.length;
      return {
        trace_id: `trace-${seed}`,
        tenant_id: 'tenant-prop',
        agent_id: 'agent-prop',
        request: {
          direction: 'inbound',
          text: `Pagar boleto CPF ${cpfs[i]} CNPJ ${cnpjs[j]} contato ${emails[k]} ${phones[m]}`,
          phone: phones[m]!,
          sender_name: 'Maria Silva',
          media_refs: [`s3://b/doc-${cpfs[i]}.pdf`],
          transcription: `transcricao com email ${emails[k]} e telefone ${phones[m]}`,
        } as Record<string, unknown>,
        soul: { biases: { paciencia: 'alta' }, raw_cpf: cpfs[i]! },
        user_layer: { profile: { cpf: cpfs[i]!, email: emails[k]!, phone: phones[m]! } },
        // Hostile callers dumping PII at top level — must be dropped:
        raw_input: `cpf ${cpfs[i]} email ${emails[k]}`,
        debug_dump: { cpf: cpfs[i], cnpj: cnpjs[j], phone: phones[m] },
      };
    }

    it('redactPacket(packet, standard) output contains NO PII regex matches across 50 random payloads', () => {
      for (let i = 0; i < 50; i++) {
        const packet = generatePiiPayload(i * 13 + 7);
        const out = redactPacket(packet, 'standard');
        const serialised = JSON.stringify(out.packet);
        for (const re of PII_REGEXES) {
          expect(serialised, `seed=${i}: PII matched ${re.source}`).not.toMatch(re);
        }
      }
    });

    it('the SAME payloads contain PII when serialised raw (control: regex set is meaningful)', () => {
      for (let i = 0; i < 5; i++) {
        const packet = generatePiiPayload(i * 13 + 7);
        const raw = JSON.stringify(packet);
        let matched = 0;
        for (const re of PII_REGEXES) if (re.test(raw)) matched += 1;
        // At least one regex MUST fire on the raw input — otherwise the
        // property test above is vacuous.
        expect(matched).toBeGreaterThan(0);
      }
    });

    it('decision_packet (with redacted_ prefix) MUST already be redacted by upstream — passes through verbatim', () => {
      // decision_packet is in the DECISION_TOP_LEVEL allowlist, which means
      // the caller (P9b PEP) is responsible for redacting before handing
      // to runtime-trace. We test the audit: if a caller drops PII into
      // decision_packet, runtime-trace DOES NOT silently strip it — the
      // caller's redaction is the contract. This documents the boundary.
      const out = redactPacket(
        {
          trace_id: 't',
          tenant_id: 'a',
          agent_id: 'b',
          decision_packet: { redacted_reason: 'boundary_violation' }, // safe — already redacted
        },
        'standard',
      );
      expect((out.packet!.decision_packet as Record<string, unknown>).redacted_reason).toBe(
        'boundary_violation',
      );
    });
  });
});
