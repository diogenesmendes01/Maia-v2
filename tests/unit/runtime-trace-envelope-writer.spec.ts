import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * P10b — envelope writer tests (sync hot path).
 *
 * Tests:
 *   1. Returns envelope-written shape with HMAC + key version.
 *   2. HMAC is over canonical payload (insertion order doesn't matter).
 *   3. Throws when DB insert fails (caller MUST abort side effect).
 *   4. Different tenants get different HMACs for the same payload.
 *   5. Latency tracked (sync_latency_ms populated).
 */
const { dbInsertMock } = vi.hoisted(() => ({
  dbInsertMock: vi.fn(),
}));

// Mock drizzle db.insert(...).values(...) chain.
vi.mock('../../src/db/client.js', () => ({
  db: { insert: () => ({ values: dbInsertMock }) },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { writeEnvelope } from '../../src/control-plane/runtime-trace/envelope-writer.js';
import { verifyHmac, _resetHmacCacheForTests } from '../../src/control-plane/runtime-trace/lib/hmac.js';
import type { TraceEnvelopeInput } from '../../src/control-plane/runtime-trace/types.js';

const baseInput: TraceEnvelopeInput = {
  trace_id: '11111111-1111-1111-1111-111111111111',
  tenant_id: 'tenant-a',
  agent_id: 'agent-1',
  conversa_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  turno_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  decision: {
    decision: 'allow',
    side_effect_level: 'medium',
    policy_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  },
};

describe('writeEnvelope', () => {
  beforeEach(() => {
    dbInsertMock.mockReset();
    dbInsertMock.mockResolvedValue(undefined);
    _resetHmacCacheForTests();
  });

  it('writes the envelope and returns the HMAC + version', async () => {
    const out = await writeEnvelope(baseInput);
    expect(dbInsertMock).toHaveBeenCalledTimes(1);
    expect(out.trace_id).toBe(baseInput.trace_id);
    expect(out.decision).toBe('allow');
    expect(out.side_effect_level).toBe('medium');
    expect(out.envelope_hmac).toMatch(/^[A-Za-z0-9+/=]+$/); // base64
    expect(out.hmac_key_version).toBeGreaterThan(0);
    expect(out.sync_latency_ms).toBeGreaterThanOrEqual(0);
    expect(out.redaction_class).toBe('standard');
  });

  it('HMAC verifies against the canonical envelope payload', async () => {
    const out = await writeEnvelope(baseInput);
    const payload = {
      trace_id: baseInput.trace_id,
      tenant_id: baseInput.tenant_id,
      agent_id: baseInput.agent_id,
      conversa_id: baseInput.conversa_id,
      turno_id: baseInput.turno_id,
      policy_id: baseInput.decision.policy_id,
      decision: baseInput.decision.decision,
      side_effect_level: baseInput.decision.side_effect_level,
      redaction_class: 'standard',
      hmac_key_version: out.hmac_key_version,
    };
    expect(verifyHmac(baseInput.tenant_id, out.hmac_key_version, payload, out.envelope_hmac)).toBe(true);
  });

  it('tampered side_effect_level fails HMAC verify', async () => {
    const out = await writeEnvelope(baseInput);
    const tampered = {
      trace_id: baseInput.trace_id,
      tenant_id: baseInput.tenant_id,
      agent_id: baseInput.agent_id,
      conversa_id: baseInput.conversa_id,
      turno_id: baseInput.turno_id,
      policy_id: baseInput.decision.policy_id,
      decision: baseInput.decision.decision,
      side_effect_level: 'low', // ← tampered down from 'medium'
      redaction_class: 'standard',
      hmac_key_version: out.hmac_key_version,
    };
    expect(
      verifyHmac(baseInput.tenant_id, out.hmac_key_version, tampered, out.envelope_hmac),
    ).toBe(false);
  });

  it('throws when DB insert fails — caller MUST abort the side effect', async () => {
    dbInsertMock.mockRejectedValue(new Error('connection refused'));
    await expect(writeEnvelope(baseInput)).rejects.toThrow('connection refused');
  });

  it('different tenants get different HMACs for the same trace payload', async () => {
    const a = await writeEnvelope({ ...baseInput, tenant_id: 'tenant-a' });
    const b = await writeEnvelope({ ...baseInput, tenant_id: 'tenant-b' });
    expect(a.envelope_hmac).not.toBe(b.envelope_hmac);
  });

  it('honors redaction_class override on input', async () => {
    const out = await writeEnvelope({ ...baseInput, redaction_class: 'debug' });
    expect(out.redaction_class).toBe('debug');
  });

  it('stamps body_status=pending on the insert (for recoverer)', async () => {
    await writeEnvelope(baseInput);
    const row = dbInsertMock.mock.calls[0]![0];
    expect(row.body_status).toBe('pending');
    expect(row.envelope_hmac).toBeDefined();
  });
});
