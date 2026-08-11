import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  verifyRemoteArtifact,
  base64ToHex,
  hexToBase64,
  type RemoteHead,
  type RemoteVerifyDeps,
} from '../../../src/ops/backup/remote-verify.js';

/**
 * Issue #520 §4 — round-1 review finding (P1): the "remote checksum" was the
 * uploader's own user metadata read back, so a corrupted stored object still
 * verified.
 *
 * THE FAKE IS ADVERSARIAL BY CONSTRUCTION. `bucket()` models a provider whose
 * stored BYTES and whose user METADATA are independent: `corrupt()` rots the
 * bytes and deliberately leaves the metadata stamp untouched — exactly the
 * scenario the old implementation could not detect. Every test below runs
 * against that store.
 */

const GOOD = Buffer.from('a verified maia backup artifact');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface FakeObject {
  bytes: Buffer;
  /** What the uploader CLAIMED, stored beside the object and never re-derived. */
  metadataSha256Hex: string | null;
  /** Whether this provider computes checksums over what it stored. */
  supportsProviderChecksum: boolean;
}

function bucket(initial: Partial<FakeObject> = {}) {
  const obj: FakeObject = {
    bytes: GOOD,
    metadataSha256Hex: sha(GOOD),
    supportsProviderChecksum: true,
    ...initial,
  };
  const store = new Map<string, FakeObject>([['k', obj]]);

  const deps: RemoteVerifyDeps & { downloads: number; heads: number } = {
    heads: 0,
    downloads: 0,
    allowFullDownload: true,
    head: vi.fn(async (key: string): Promise<RemoteHead | null> => {
      deps.heads += 1;
      const o = store.get(key);
      if (!o) return null;
      return {
        bytes: o.bytes.length,
        // Derived from the STORED BYTES — this is what makes it evidence.
        providerSha256Base64: o.supportsProviderChecksum
          ? hexToBase64(sha(o.bytes))
          : null,
        // Independent of the bytes — this is what made the old check a lie.
        metadataSha256Hex: o.metadataSha256Hex,
      };
    }),
    downloadAndDigest: vi.fn(async (key: string) => {
      deps.downloads += 1;
      const o = store.get(key);
      if (!o) return null;
      return { sha256: sha(o.bytes), bytes: o.bytes.length };
    }),
  };

  return {
    deps,
    /** Rot the stored bytes and LEAVE the metadata stamp intact. */
    corrupt(replacement: Buffer) {
      const o = store.get('k')!;
      o.bytes = replacement;
      // metadataSha256Hex deliberately NOT updated.
    },
    drop() {
      store.delete('k');
    },
    expected: { sha256: sha(GOOD), bytes: GOOD.length },
  };
}

describe('base64 ↔ hex helpers', () => {
  it('round-trips a SHA-256', () => {
    const hex = sha(GOOD);
    expect(base64ToHex(hexToBase64(hex))).toBe(hex);
  });

  it('rejects a value that is not exactly 32 bytes (a truncated digest)', () => {
    expect(base64ToHex(Buffer.alloc(16).toString('base64'))).toBeNull();
    expect(base64ToHex(Buffer.alloc(33).toString('base64'))).toBeNull();
  });

  it('rejects malformed and empty input instead of guessing', () => {
    expect(base64ToHex('not base64!!')).toBeNull();
    expect(base64ToHex('')).toBeNull();
  });
});

describe('the finding: user metadata is never evidence', () => {
  it('FAILS a corrupted object whose user metadata still matches', async () => {
    const b = bucket();
    // Same length, different bytes — size checks cannot catch this either.
    b.corrupt(Buffer.from('A CORRUPTED maia backup artifact'.slice(0, GOOD.length)));
    const v = await verifyRemoteArtifact(b.deps, 'k', b.expected);
    expect(v.verified).toBe(false);
    expect(v.reason).toBe('checksum_mismatch');
  });

  it('FAILS even when the provider offers no checksum and downloads are barred', async () => {
    const b = bucket({ supportsProviderChecksum: false });
    b.deps.allowFullDownload = false;
    // Same length, so the size check cannot rescue us — only reading the bytes
    // back could, and policy forbids it.
    b.corrupt(Buffer.from('A CORRUPTED maia backup artifact'.slice(0, GOOD.length)));
    const v = await verifyRemoteArtifact(b.deps, 'k', b.expected);
    expect(v.verified).toBe(false);
    // Explicitly "we could not verify", not a silent pass.
    expect(v.reason).toBe('no_provider_checksum');
    expect(v.method).toBe('none');
  });

  it('never consults the metadata stamp — a WRONG stamp on a GOOD object still verifies', async () => {
    const b = bucket({ metadataSha256Hex: 'f'.repeat(64) });
    const v = await verifyRemoteArtifact(b.deps, 'k', b.expected);
    expect(v).toEqual({ verified: true, method: 'provider_checksum', reason: 'ok' });
  });
});

describe('provider-computed checksum', () => {
  it('verifies a healthy object and names the method', async () => {
    const b = bucket();
    expect(await verifyRemoteArtifact(b.deps, 'k', b.expected)).toEqual({
      verified: true,
      method: 'provider_checksum',
      reason: 'ok',
    });
  });

  it('does not spend egress on a download when the provider attests', async () => {
    const b = bucket();
    await verifyRemoteArtifact(b.deps, 'k', b.expected);
    expect(b.deps.downloads).toBe(0);
  });

  it('fails a provider digest that is structurally invalid', async () => {
    const b = bucket();
    b.deps.head = vi.fn(async () => ({
      bytes: GOOD.length,
      providerSha256Base64: 'AAAA',
      metadataSha256Hex: sha(GOOD),
    }));
    const v = await verifyRemoteArtifact(b.deps, 'k', b.expected);
    expect(v).toEqual({
      verified: false,
      method: 'provider_checksum',
      reason: 'checksum_mismatch',
    });
  });
});

describe('full-download fallback (provider without checksums)', () => {
  it('recomputes over the stored bytes and verifies', async () => {
    const b = bucket({ supportsProviderChecksum: false });
    const v = await verifyRemoteArtifact(b.deps, 'k', b.expected);
    expect(v).toEqual({ verified: true, method: 'full_download', reason: 'ok' });
    expect(b.deps.downloads).toBe(1);
  });

  it('catches corruption the metadata stamp hides', async () => {
    const b = bucket({ supportsProviderChecksum: false });
    b.corrupt(Buffer.from('A CORRUPTED maia backup artifact'.slice(0, GOOD.length)));
    const v = await verifyRemoteArtifact(b.deps, 'k', b.expected);
    expect(v).toEqual({ verified: false, method: 'full_download', reason: 'checksum_mismatch' });
  });

  it('reports a failed download instead of assuming success', async () => {
    const b = bucket({ supportsProviderChecksum: false });
    b.deps.downloadAndDigest = vi.fn(async () => {
      throw new Error('connection reset');
    });
    expect(await verifyRemoteArtifact(b.deps, 'k', b.expected)).toEqual({
      verified: false,
      method: 'full_download',
      reason: 'download_failed',
    });
  });
});

describe('structural checks', () => {
  it('reports a missing object', async () => {
    const b = bucket();
    b.drop();
    expect(await verifyRemoteArtifact(b.deps, 'k', b.expected)).toEqual({
      verified: false,
      method: 'none',
      reason: 'object_missing',
    });
  });

  it('reports a HEAD that throws as a missing object (never as verified)', async () => {
    const b = bucket();
    b.deps.head = vi.fn(async () => {
      throw new Error('403');
    });
    expect((await verifyRemoteArtifact(b.deps, 'k', b.expected)).verified).toBe(false);
  });

  it('fails on a size disagreement before spending a download', async () => {
    const b = bucket({ supportsProviderChecksum: false });
    b.corrupt(Buffer.from('short'));
    const v = await verifyRemoteArtifact(b.deps, 'k', b.expected);
    expect(v).toEqual({ verified: false, method: 'none', reason: 'size_mismatch' });
    expect(b.deps.downloads).toBe(0);
  });

  it('still verifies when the provider reports no size but does attest a digest', async () => {
    const b = bucket();
    const inner = b.deps.head;
    b.deps.head = vi.fn(async (k: string) => {
      const h = await inner(k);
      return h ? { ...h, bytes: null } : null;
    });
    expect((await verifyRemoteArtifact(b.deps, 'k', b.expected)).verified).toBe(true);
  });
});
