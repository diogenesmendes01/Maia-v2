import { describe, it, expect, vi } from 'vitest';
import { createDecipheriv } from 'node:crypto';

/**
 * P10b — debug-mode AES-GCM encryption tests.
 *
 * Tests:
 *   1. AES key configured → encryptForDebug returns iv/tag/ciphertext.
 *   2. AES key absent → returns null (caller MUST handle).
 *   3. Round-trip decrypts to original payload.
 *   4. uploadDebugSnapshot with no bucket → storage='inline' + raw ciphertext
 *      (Codex review #102 issue 3 — no silent-drop of debug bodies).
 *   5. uploadDebugSnapshot with bucket → performs real S3 PutObject and
 *      returns storage='s3'. Throws on upload failure (no fake success).
 */

const { AES_KEY_B64, s3SendMock, s3DestroyMock } = vi.hoisted(() => ({
  AES_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
  s3SendMock: vi.fn(),
  s3DestroyMock: vi.fn(),
}));

vi.mock('../../src/config/env.js', () => ({
  config: {
    RUNTIME_TRACE_DEBUG_AES_KEY: AES_KEY_B64,
    RUNTIME_TRACE_DEBUG_S3_BUCKET: undefined,
    BACKUP_S3_REGION: 'us-east-1',
    BACKUP_S3_ENDPOINT: undefined,
    BACKUP_S3_ACCESS_KEY: undefined,
    BACKUP_S3_SECRET_KEY: undefined,
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = s3SendMock;
    destroy = s3DestroyMock;
  },
  PutObjectCommand: class {
    constructor(public opts: Record<string, unknown>) {}
  },
}));

import {
  encryptForDebug,
  uploadDebugSnapshot,
} from '../../src/control-plane/runtime-trace/lib/debug-encrypt.js';
import { config } from '../../src/config/env.js';

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

describe('uploadDebugSnapshot — inline path (no bucket)', () => {
  it('returns storage=inline with raw ciphertext when bucket unset', async () => {
    (config as { RUNTIME_TRACE_DEBUG_S3_BUCKET?: string }).RUNTIME_TRACE_DEBUG_S3_BUCKET =
      undefined;
    const cipher = encryptForDebug({ x: 1 })!;
    const out = await uploadDebugSnapshot('trace-xyz', cipher);
    expect(out.storage).toBe('inline');
    expect(out.s3_uri).toBeNull();
    expect(out.inline).toBe(cipher.ciphertext);
  });
});

describe('uploadDebugSnapshot — S3 path (bucket configured)', () => {
  it('performs PutObject and returns storage=s3 with bucket URI', async () => {
    (config as { RUNTIME_TRACE_DEBUG_S3_BUCKET?: string }).RUNTIME_TRACE_DEBUG_S3_BUCKET =
      'my-debug-bucket';
    s3SendMock.mockReset();
    s3DestroyMock.mockReset();
    s3SendMock.mockResolvedValue({});

    const cipher = encryptForDebug({ x: 1 })!;
    const out = await uploadDebugSnapshot('trace-xyz', cipher);
    expect(s3SendMock).toHaveBeenCalledTimes(1);
    expect(out.storage).toBe('s3');
    expect(out.s3_uri).toBe('s3://my-debug-bucket/runtime-trace/debug/trace-xyz.json.enc');
    expect(out.inline).toBeNull();
    expect(s3DestroyMock).toHaveBeenCalledTimes(1);
  });

  it('throws on S3 upload failure — caller must NOT mark body persisted', async () => {
    (config as { RUNTIME_TRACE_DEBUG_S3_BUCKET?: string }).RUNTIME_TRACE_DEBUG_S3_BUCKET =
      'my-debug-bucket';
    s3SendMock.mockReset();
    s3SendMock.mockRejectedValueOnce(new Error('S3 503 ServiceUnavailable'));
    const cipher = encryptForDebug({ x: 1 })!;
    await expect(uploadDebugSnapshot('trace-fail', cipher)).rejects.toThrow(
      /ServiceUnavailable/,
    );
  });
});
