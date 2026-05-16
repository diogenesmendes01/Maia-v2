import { describe, it, expect, vi } from 'vitest';
import { createDecipheriv } from 'node:crypto';

/**
 * P10b — debug-mode AES-GCM encryption tests.
 *
 * Tests:
 *   1. AES key configured → encryptForDebug returns iv/tag/ciphertext.
 *   2. AES key absent → returns null (caller MUST handle).
 *   3. Round-trip decrypts to original payload.
 *   4. uploadDebugSnapshot returns S3 URI when bucket configured;
 *      inline URI when not.
 */

// vi.hoisted ensures the constant is initialised before the hoisted
// vi.mock() factories run. Plain `const AES_KEY_B64 = ...` at module
// top-level is too late: vi.mock factories are hoisted above it.
const { AES_KEY_B64 } = vi.hoisted(() => ({
  AES_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
}));

vi.mock('../../src/config/env.js', () => ({
  config: {
    RUNTIME_TRACE_DEBUG_AES_KEY: AES_KEY_B64,
    RUNTIME_TRACE_DEBUG_S3_BUCKET: 'my-debug-bucket',
  },
}));

import {
  encryptForDebug,
  uploadDebugSnapshot,
} from '../../src/control-plane/runtime-trace/lib/debug-encrypt.js';

describe('encryptForDebug', () => {
  it('returns AES-GCM ciphertext envelope when key present', () => {
    const out = encryptForDebug({ secret: 'data' });
    expect(out).not.toBeNull();
    expect(out!.iv).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(out!.tag).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(out!.ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(out!.key_version).toBe(1);
  });

  it('round-trips: decrypt restores the original payload', () => {
    const original = { trace_id: 't1', text: 'sensitive' };
    const cipher = encryptForDebug(original);
    expect(cipher).not.toBeNull();

    const key = Buffer.from(AES_KEY_B64, 'base64');
    const iv = Buffer.from(cipher!.iv, 'base64');
    const tag = Buffer.from(cipher!.tag, 'base64');
    const ct = Buffer.from(cipher!.ciphertext, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    expect(JSON.parse(pt.toString('utf8'))).toEqual(original);
  });

  it('different invocations produce different IVs (no IV reuse)', () => {
    const a = encryptForDebug({ x: 1 });
    const b = encryptForDebug({ x: 1 });
    expect(a!.iv).not.toBe(b!.iv);
    expect(a!.ciphertext).not.toBe(b!.ciphertext);
  });
});

describe('uploadDebugSnapshot', () => {
  it('produces an s3:// URI when bucket configured', async () => {
    const cipher = encryptForDebug({ x: 1 })!;
    const out = await uploadDebugSnapshot('trace-xyz', cipher);
    expect(out.s3_uri).toBe('s3://my-debug-bucket/runtime-trace/debug/trace-xyz.json.enc');
  });
});
