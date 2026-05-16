/**
 * P10b — Runtime Trace integration test.
 *
 * Mocks the DB layer (no Postgres needed) and exercises the full path:
 *   trace() → writeEnvelope (sync) → enqueueBody → runTraceBodyWriter →
 *   writeBody → envelope flip.
 *
 * Scenarios (6):
 *   1. End-to-end happy path under standard redaction.
 *   2. Debug redaction takes the encrypt+upload branch.
 *   3. Minimal redaction omits body PII entirely.
 *   4. Cross-tenant HMACs differ for identical payloads (invariant 8).
 *   5. Envelope write failure → trace() throws → side effect MUST not run.
 *   6. Feature flag OFF → no-op envelope, no DB writes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbInsertValuesMock, dbExecuteMock, isEnabledMock } = vi.hoisted(() => ({
  dbInsertValuesMock: vi.fn(),
  dbExecuteMock: vi.fn(),
  isEnabledMock: vi.fn(),
}));

vi.mock('@/db/client.js', () => ({
  db: {
    insert: () => ({ values: dbInsertValuesMock }),
    execute: dbExecuteMock,
  },
}));
vi.mock('@/config/feature-flags.js', () => ({
  featureFlags: { isEnabled: isEnabledMock },
}));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/config/env.js', () => ({
  config: {
    RUNTIME_TRACE_HMAC_MASTER_SECRET: 'p10b-integration-test-master-secret-do-not-use-in-prod',
    RUNTIME_TRACE_HMAC_KEY_VERSION: 1,
    RUNTIME_TRACE_DEBUG_AES_KEY: Buffer.alloc(32, 9).toString('base64'),
    RUNTIME_TRACE_DEBUG_S3_BUCKET: 'integ-debug-bucket',
    RUNTIME_TRACE_BODY_ORPHAN_SEC: 300,
  },
}));

import { trace } from '@/control-plane/runtime-trace/index.js';
import { runTraceBodyWriter, _peekQueueSize } from '@/workers/trace-body-writer.js';
import { _resetHmacCacheForTests, verifyHmac } from '@/control-plane/runtime-trace/lib/hmac.js';

const basePacket = (text: string) => ({
  trace_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  tenant_id: 'tenant-a',
  agent_id: 'agent-1',
  request: { direction: 'inbound' as const, text },
  soul: { biases: { paciencia: 'alta' } },
  user_layer: { nome: 'Mariana' },
});

const baseInput = (overrides: Partial<{ redaction_class: 'standard' | 'debug' | 'minimal' }> = {}) => ({
  trace_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  tenant_id: 'tenant-a',
  agent_id: 'agent-1',
  conversa_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  turno_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  packet: basePacket('pagar R$ 4500 boleto'),
  decision: {
    decision: 'allow' as const,
    side_effect_level: 'medium' as const,
    policy_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  },
  redaction_class: overrides.redaction_class ?? 'standard',
});

describe('P10b runtime trace — integration (6 scenarios)', () => {
  beforeEach(async () => {
    dbInsertValuesMock.mockReset();
    dbExecuteMock.mockReset();
    dbInsertValuesMock.mockResolvedValue(undefined);
    dbExecuteMock.mockResolvedValue(undefined);
    isEnabledMock.mockReset();
    isEnabledMock.mockReturnValue(true);
    _resetHmacCacheForTests();
    // Drain any residue from previous tests.
    await runTraceBodyWriter();
  });

  it('1. happy path: standard redaction — envelope + body, envelope flipped', async () => {
    const env = await trace(baseInput());
    expect(env.envelope_hmac.length).toBeGreaterThan(0);
    expect(env.decision).toBe('allow');
    expect(env.side_effect_level).toBe('medium');
    expect(dbInsertValuesMock).toHaveBeenCalledTimes(1);
    // Sync envelope written; body still in-queue until worker tick.
    expect(_peekQueueSize()).toBe(1);

    await runTraceBodyWriter();
    expect(_peekQueueSize()).toBe(0);
    // 2 db.execute() calls expected from body writer: INSERT body, UPDATE envelope.
    expect(dbExecuteMock).toHaveBeenCalledTimes(2);

    // Verify body INSERT does NOT contain raw PII ("pagar R$ 4500 boleto"
    // text should be stripped to text_redacted=true).
    const bodyInsertSql = JSON.stringify(dbExecuteMock.mock.calls[0]![0]);
    expect(bodyInsertSql).not.toContain('pagar R$ 4500 boleto');
    expect(bodyInsertSql).toContain('text_redacted');
  });

  it('2. debug redaction takes encrypted/S3 branch', async () => {
    const env = await trace(baseInput({ redaction_class: 'debug' }));
    expect(env.redaction_class).toBe('debug');
    await runTraceBodyWriter();
    expect(dbExecuteMock).toHaveBeenCalledTimes(2);
    const bodySql = JSON.stringify(dbExecuteMock.mock.calls[0]![0]);
    expect(bodySql).toContain('__encrypted');
    expect(bodySql).toContain('s3://integ-debug-bucket/runtime-trace/debug/');
    // Plaintext PII MUST NOT be in the SQL.
    expect(bodySql).not.toContain('pagar R$ 4500 boleto');
  });

  it('3. minimal redaction omits body PII entirely', async () => {
    await trace(baseInput({ redaction_class: 'minimal' }));
    await runTraceBodyWriter();
    const bodySql = JSON.stringify(dbExecuteMock.mock.calls[0]![0]);
    expect(bodySql).toContain('__minimal');
    expect(bodySql).not.toContain('pagar R$ 4500');
    expect(bodySql).not.toContain('Mariana');
  });

  it('4. cross-tenant HMACs differ for identical payloads (invariant 8)', async () => {
    const aEnv = await trace({ ...baseInput(), tenant_id: 'tenant-alpha' });
    const bEnv = await trace({ ...baseInput(), tenant_id: 'tenant-beta' });
    expect(aEnv.envelope_hmac).not.toBe(bEnv.envelope_hmac);
    // Verify tenant-alpha's HMAC does NOT validate under tenant-beta's key.
    const payload = {
      trace_id: aEnv.trace_id,
      tenant_id: 'tenant-alpha',
      agent_id: 'agent-1',
      conversa_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      turno_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      policy_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      decision: 'allow',
      side_effect_level: 'medium',
      redaction_class: 'standard',
      hmac_key_version: aEnv.hmac_key_version,
    };
    expect(verifyHmac('tenant-alpha', aEnv.hmac_key_version, payload, aEnv.envelope_hmac)).toBe(true);
    expect(verifyHmac('tenant-beta', aEnv.hmac_key_version, payload, aEnv.envelope_hmac)).toBe(false);
  });

  it('5. envelope write failure → trace() throws → invariant 12 holds', async () => {
    dbInsertValuesMock.mockRejectedValue(new Error('connection refused'));
    let sideEffectRan = false;
    try {
      await trace(baseInput());
      // The "side effect" caller would do this AFTER trace() returns.
      sideEffectRan = true;
    } catch {
      // Expected.
    }
    expect(sideEffectRan).toBe(false);
    // Queue is empty because trace() threw before enqueueBody.
    expect(_peekQueueSize()).toBe(0);
  });

  it('6. flag OFF: no-op envelope, no DB writes', async () => {
    isEnabledMock.mockReturnValue(false);
    const env = await trace(baseInput());
    expect(env.envelope_hmac).toBe('');
    expect(dbInsertValuesMock).not.toHaveBeenCalled();
    expect(dbExecuteMock).not.toHaveBeenCalled();
    expect(_peekQueueSize()).toBe(0);
  });
});
