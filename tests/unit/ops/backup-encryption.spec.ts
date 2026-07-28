import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseBackupKeyring,
  encryptFile,
  decryptFile,
  verifyDecryptable,
  artifactKeyId,
  parseHeader,
  type BackupKeyring,
} from '../../../src/ops/backup/encryption.js';
import { sha256File } from '../../../src/ops/backup/checksum.js';

/**
 * Issue #520 §5 — "chave nunca em log, audit metadata ou manifesto";
 * "falha de KMS não gera backup plaintext"; "rotação de chave"; "teste
 * periódico de decrypt".
 */

const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');
const RING = JSON.stringify({ k1: K1, k2: K2 });

let dir: string;
let n = 0;

function tmp(name: string): string {
  n += 1;
  return join(dir, `${n}-${name}`);
}

function keyring(active = 'k1'): BackupKeyring {
  return parseBackupKeyring(RING, active);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maia-enc-'));
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('parseBackupKeyring', () => {
  it('parses a well-formed keyring', () => {
    const ring = keyring();
    expect(ring.activeKeyId).toBe('k1');
    expect(ring.keys.size).toBe(2);
  });

  it('throws (never falls back to plaintext) when unconfigured', () => {
    expect(() => parseBackupKeyring(undefined, undefined)).toThrowError(
      /refusing to produce a plaintext backup/,
    );
    expect(() => parseBackupKeyring(RING, undefined)).toThrowError(
      /refusing to produce a plaintext backup/,
    );
  });

  it('rejects malformed JSON, non-object rings and wrong-length keys', () => {
    expect(() => parseBackupKeyring('{', 'k1')).toThrowError(/not valid JSON/);
    expect(() => parseBackupKeyring('[]', 'k1')).toThrowError(/must be a JSON object/);
    expect(() =>
      parseBackupKeyring(JSON.stringify({ k1: Buffer.alloc(16).toString('base64') }), 'k1'),
    ).toThrowError(/is not 32 bytes/);
  });

  it('rejects an active key id absent from the ring', () => {
    expect(() => parseBackupKeyring(RING, 'k9')).toThrowError(/not present in the keyring/);
  });

  it('never echoes key material in an error', () => {
    try {
      parseBackupKeyring(JSON.stringify({ k1: K1 }), 'k9');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain(K1);
    }
  });
});

describe('encryptFile / decryptFile', () => {
  it('round-trips a payload byte-for-byte', async () => {
    const src = tmp('a.dump');
    const enc = tmp('a.enc');
    const dec = tmp('a.out');
    const body = randomBytes(64 * 1024);
    writeFileSync(src, body);

    const res = await encryptFile(src, enc, keyring());
    expect(res.key_id).toBe('k1');
    await decryptFile(enc, dec, keyring());
    expect(readFileSync(dec).equals(body)).toBe(true);
  });

  it('produces a ciphertext that does not contain the plaintext', async () => {
    const src = tmp('b.dump');
    const enc = tmp('b.enc');
    writeFileSync(src, Buffer.from('OWNER +5511999998888 saldo 12345'));
    await encryptFile(src, enc, keyring());
    const raw = readFileSync(enc);
    expect(raw.includes(Buffer.from('5511999998888'))).toBe(false);
    expect(raw.subarray(0, 4).toString('ascii')).toBe('MBK1');
  });

  it('never writes the key material into the artifact', async () => {
    const src = tmp('c.dump');
    const enc = tmp('c.enc');
    writeFileSync(src, randomBytes(1024));
    await encryptFile(src, enc, keyring());
    const raw = readFileSync(enc);
    expect(raw.includes(Buffer.from(K1, 'base64'))).toBe(false);
  });

  it('uses a fresh data key per run (two runs differ)', async () => {
    const src = tmp('d.dump');
    writeFileSync(src, Buffer.from('identical payload'));
    const e1 = tmp('d1.enc');
    const e2 = tmp('d2.enc');
    await encryptFile(src, e1, keyring());
    await encryptFile(src, e2, keyring());
    expect((await sha256File(e1)).sha256).not.toBe((await sha256File(e2)).sha256);
  });

  it('refuses to overwrite an existing artifact', async () => {
    const src = tmp('e.dump');
    const enc = tmp('e.enc');
    writeFileSync(src, Buffer.from('x'));
    writeFileSync(enc, Buffer.from('already here'));
    await expect(encryptFile(src, enc, keyring())).rejects.toThrow();
  });
});

describe('key rotation', () => {
  it('decrypts an artifact sealed with a retired key using the same ring', async () => {
    const src = tmp('f.dump');
    const enc = tmp('f.enc');
    const dec = tmp('f.out');
    writeFileSync(src, Buffer.from('older artifact'));
    // Sealed under k1 while k1 was active…
    await encryptFile(src, enc, keyring('k1'));
    expect(await artifactKeyId(enc)).toBe('k1');
    // …and read back after rotating the ACTIVE key to k2 (k1 retained).
    await decryptFile(enc, dec, keyring('k2'));
    expect(readFileSync(dec).toString()).toBe('older artifact');
  });

  it('fails loudly when the referenced key was retired from the ring', async () => {
    const src = tmp('g.dump');
    const enc = tmp('g.enc');
    writeFileSync(src, Buffer.from('x'));
    await encryptFile(src, enc, keyring('k2'));
    const shrunk = parseBackupKeyring(JSON.stringify({ k1: K1 }), 'k1');
    await expect(decryptFile(enc, tmp('g.out'), shrunk)).rejects.toThrow(
      /not in the keyring/,
    );
  });
});

describe('tamper resistance', () => {
  it('rejects a flipped ciphertext byte and leaves no usable plaintext', async () => {
    const src = tmp('h.dump');
    const enc = tmp('h.enc');
    const dec = tmp('h.out');
    writeFileSync(src, randomBytes(4096));
    await encryptFile(src, enc, keyring());
    const raw = readFileSync(enc);
    raw[raw.length - 40] ^= 0xff;
    writeFileSync(enc, raw);
    await expect(decryptFile(enc, dec, keyring())).rejects.toThrow(
      /failed authenticated decryption/,
    );
  });

  it('rejects a swapped key id in the header (header is AAD)', async () => {
    const src = tmp('i.dump');
    const enc = tmp('i.enc');
    writeFileSync(src, randomBytes(2048));
    await encryptFile(src, enc, keyring('k1'));
    const raw = readFileSync(enc);
    // Header layout: magic(4) version(1) keyIdLen(1) keyId(2 for 'k1').
    raw.write('k2', 6, 'utf8');
    writeFileSync(enc, raw);
    await expect(decryptFile(enc, tmp('i.out'), keyring())).rejects.toThrow();
  });

  it('rejects a file that is not a Maia envelope', async () => {
    const bogus = tmp('j.bin');
    writeFileSync(bogus, Buffer.from('this is a plain pg_dump'));
    await expect(decryptFile(bogus, tmp('j.out'), keyring())).rejects.toThrow(
      /not a Maia backup envelope/,
    );
  });

  it('rejects an unsupported envelope version', () => {
    const header = Buffer.alloc(80);
    header.write('MBK1', 0, 'ascii');
    header[4] = 0x99;
    expect(() => parseHeader(header)).toThrowError(/unsupported envelope version/);
  });
});

describe('verifyDecryptable (decrypt drill)', () => {
  it('confirms a healthy artifact without materialising plaintext', async () => {
    const src = tmp('k.dump');
    const enc = tmp('k.enc');
    writeFileSync(src, randomBytes(8192));
    await encryptFile(src, enc, keyring());
    const out = await verifyDecryptable(enc, keyring());
    expect(out).toEqual({ ok: true, key_id: 'k1' });
    expect(existsSync(join(dir, 'plaintext'))).toBe(false);
  });

  it('reports (never throws) when the key is unavailable', async () => {
    const src = tmp('l.dump');
    const enc = tmp('l.enc');
    writeFileSync(src, randomBytes(512));
    await encryptFile(src, enc, keyring('k2'));
    const out = await verifyDecryptable(enc, parseBackupKeyring(JSON.stringify({ k1: K1 }), 'k1'));
    expect(out).toEqual({ ok: false, key_id: 'k2', reason: 'backup_key_unavailable' });
  });

  it('reports a corrupt artifact', async () => {
    const src = tmp('m.dump');
    const enc = tmp('m.enc');
    writeFileSync(src, randomBytes(4096));
    await encryptFile(src, enc, keyring());
    const raw = readFileSync(enc);
    raw[raw.length - 1] ^= 0xff;
    writeFileSync(enc, raw);
    const out = await verifyDecryptable(enc, keyring());
    expect(out.ok).toBe(false);
  });
});
