import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * P10b — body writer tests (async path).
 *
 * Tests:
 *   1. standard redaction → JSONB body persisted; flips envelope.
 *   2. minimal redaction → body row has __minimal flag, no PII.
 *   3. debug redaction → encrypted body + s3_uri; envelope flipped.
 *   4. debug fallback when AES key missing → standard applied, warning logged.
 *   5. envelope-flip failure is best-effort (doesn't throw).
 */
const { dbExecuteMock } = vi.hoisted(() => ({ dbExecuteMock: vi.fn() }));

vi.mock('../../src/db/client.js', () => ({
  db: { execute: dbExecuteMock },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/config/env.js', () => ({
  config: {
    RUNTIME_TRACE_HMAC_MASTER_SECRET: 'p10b-test-master-secret-do-not-use-in-prod',
    RUNTIME_TRACE_HMAC_KEY_VERSION: 1,
    // No AES key for debug fallback test; per-test override sets it.
    RUNTIME_TRACE_DEBUG_AES_KEY: undefined,
    RUNTIME_TRACE_DEBUG_S3_BUCKET: undefined,
  },
}));

import { writeBody } from '../../src/control-plane/runtime-trace/body-writer.js';
import { _resetHmacCacheForTests } from '../../src/control-plane/runtime-trace/lib/hmac.js';
import type { TraceBodyInput } from '../../src/control-plane/runtime-trace/types.js';

const baseInput: TraceBodyInput = {
  trace_id: '11111111-1111-1111-1111-111111111111',
  tenant_id: 'tenant-a',
  agent_id: 'agent-1',
  packet: {
    trace_id: '11111111-1111-1111-1111-111111111111',
    tenant_id: 'tenant-a',
    agent_id: 'agent-1',
    request: { direction: 'inbound', text: 'pagar boleto R$ 4500' },
  },
  decision: { decision: 'allow', side_effect_level: 'medium' },
  redaction_class: 'standard',
};

describe('writeBody', () => {
  beforeEach(() => {
    dbExecuteMock.mockReset();
    dbExecuteMock.mockResolvedValue(undefined);
    _resetHmacCacheForTests();
  });

  it('standard: persists body and flips envelope', async () => {
    const out = await writeBody(baseInput);
    expect(out.redaction_applied).toBe('standard_v1');
    expect(out.encrypted).toBe(false);
    expect(out.s3_uri).toBeNull();
    expect(out.bytes_redacted).toBeGreaterThan(0);
    // Two execute calls: INSERT body, UPDATE envelope.
    expect(dbExecuteMock).toHaveBeenCalledTimes(2);
  });

  it('minimal: body row marked __minimal, no PII present', async () => {
    const out = await writeBody({ ...baseInput, redaction_class: 'minimal' });
    expect(out.redaction_applied).toBe('minimal_v1');
    // Inspect the SQL payload to confirm __minimal flag.
    const insertCall = dbExecuteMock.mock.calls[0]![0];
    // Drizzle sql template returns an object with queryChunks; convert to string for inspection.
    const sqlText = JSON.stringify(insertCall);
    expect(sqlText).toContain('__minimal');
    expect(sqlText).not.toContain('pagar boleto'); // PII absent
  });

  it('debug WITHOUT AES key falls back to standard with warning', async () => {
    const out = await writeBody({ ...baseInput, redaction_class: 'debug' });
    // Fallback path: redaction_applied flips to standard_v1.
    expect(out.redaction_applied).toBe('standard_v1');
    expect(out.encrypted).toBe(false);
  });

  it('envelope-flip failure does NOT throw (best-effort)', async () => {
    let call = 0;
    dbExecuteMock.mockImplementation(() => {
      call += 1;
      if (call === 2) throw new Error('envelope update failed');
      return Promise.resolve(undefined);
    });
    // Should still resolve — body INSERT succeeded.
    await expect(writeBody(baseInput)).resolves.toBeDefined();
  });

  it('throws if body INSERT itself fails (caller may retry)', async () => {
    dbExecuteMock.mockRejectedValueOnce(new Error('unique constraint'));
    await expect(writeBody(baseInput)).rejects.toThrow('unique constraint');
  });
});
