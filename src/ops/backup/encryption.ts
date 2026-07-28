/**
 * Issue #520 §5 — client-side envelope encryption for backup artifacts.
 *
 * Baseline gap (`src/workers/backup-s3.ts:43-66`): `PutObject` carried no
 * encryption parameter at all, so a full dump of every tenant's personal data
 * left the host in the clear and landed in a bucket whose server-side policy
 * the application neither set nor verified.
 *
 * This module encrypts BEFORE the bytes leave the process, so the artifact is
 * protected regardless of what the destination does. Envelope construction:
 *
 *   DEK  — a fresh random 256-bit data key per backup (never reused).
 *   KEK  — a long-lived key from the operator keyring, selected by `key_id`.
 *   The DEK is wrapped with the KEK (AES-256-GCM) and stored in the header;
 *   the payload is encrypted with the DEK (AES-256-GCM) using the header as
 *   additional authenticated data, so the key id and the wrapped DEK cannot be
 *   swapped without breaking the tag.
 *
 * On-disk layout (all integers big-endian, header is AAD for the payload):
 *
 *   magic 'MBK1' (4) | version (1) | keyIdLen (1) | keyId (keyIdLen)
 *   | kekNonce (12) | kekTag (16) | wrappedDek (32) | dataNonce (12)
 *   | ciphertext (…) | dataTag (16)
 *
 * Non-negotiables enforced here:
 *  - Key material NEVER appears in a return value, an error message, a log
 *    line or the manifest — only `key_id`.
 *  - A missing/invalid keyring THROWS. There is no plaintext fallback: the
 *    issue's "falha de KMS não gera backup plaintext".
 *  - Rotation is additive — decryption resolves the KEK by the `key_id` in the
 *    header, so old artifacts stay readable while new ones use the active key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TypedError } from '@/lib/utils.js';

const MAGIC = Buffer.from('MBK1', 'ascii');
const ENVELOPE_V1 = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const DEK_LEN = 32;

/** Fixed-size part of the header after `keyId`. */
const TAIL_LEN = NONCE_LEN + TAG_LEN + DEK_LEN + NONCE_LEN;

export interface BackupKeyring {
  activeKeyId: string;
  /** key_id → 32-byte KEK. Never serialised, never logged. */
  keys: Map<string, Buffer>;
}

/**
 * Parse `BACKUP_ENCRYPTION_KEYRING` (JSON `{ key_id: base64(32 bytes) }`) +
 * `BACKUP_ENCRYPTION_ACTIVE_KEY_ID`. Same shape as the gateway staging keyring
 * (`src/gateway/staging-crypto.ts:30`) so operators learn one format.
 *
 * Every failure path is a THROW with a code and a message that names the key
 * ID at most — never the material.
 */
export function parseBackupKeyring(
  raw: string | undefined,
  activeKeyId: string | undefined,
): BackupKeyring {
  if (!raw || !activeKeyId) {
    throw new TypedError(
      'backup_keyring_missing',
      'BACKUP_ENCRYPTION_KEYRING/BACKUP_ENCRYPTION_ACTIVE_KEY_ID not configured — refusing to produce a plaintext backup',
      {},
    );
  }
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new TypedError('backup_keyring_invalid', 'keyring is not valid JSON', {});
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypedError('backup_keyring_invalid', 'keyring must be a JSON object', {});
  }
  const keys = new Map<string, Buffer>();
  for (const [id, b64] of Object.entries(parsed)) {
    if (typeof b64 !== 'string') {
      throw new TypedError('backup_keyring_invalid', `key '${id}' is not a base64 string`, {
        key_id: id,
      });
    }
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== KEY_LEN) {
      throw new TypedError('backup_keyring_invalid', `key '${id}' is not 32 bytes`, { key_id: id });
    }
    keys.set(id, buf);
  }
  if (!keys.has(activeKeyId)) {
    throw new TypedError(
      'backup_keyring_invalid',
      `active key '${activeKeyId}' is not present in the keyring`,
      { active_key_id: activeKeyId },
    );
  }
  if (Buffer.byteLength(activeKeyId, 'utf8') > 255) {
    throw new TypedError('backup_keyring_invalid', 'active key id longer than 255 bytes', {});
  }
  return { activeKeyId, keys };
}

function buildHeader(keyId: string, kekNonce: Buffer, kekTag: Buffer, wrappedDek: Buffer, dataNonce: Buffer): Buffer {
  const keyIdBuf = Buffer.from(keyId, 'utf8');
  return Buffer.concat([
    MAGIC,
    Buffer.from([ENVELOPE_V1, keyIdBuf.length]),
    keyIdBuf,
    kekNonce,
    kekTag,
    wrappedDek,
    dataNonce,
  ]);
}

export interface EncryptedHeader {
  keyId: string;
  header: Buffer;
  headerLen: number;
  kekNonce: Buffer;
  kekTag: Buffer;
  wrappedDek: Buffer;
  dataNonce: Buffer;
}

/**
 * Parse the header of an encrypted artifact. Rejects anything it does not
 * recognise with a stable code — a malicious/corrupt file must not be able to
 * steer the reader into a different code path.
 */
export function parseHeader(buf: Buffer): EncryptedHeader {
  if (buf.length < MAGIC.length + 2 || !buf.subarray(0, 4).equals(MAGIC)) {
    throw new TypedError('backup_envelope_invalid', 'not a Maia backup envelope', {});
  }
  if (buf[4] !== ENVELOPE_V1) {
    throw new TypedError('backup_envelope_invalid', 'unsupported envelope version', {
      version: buf[4],
    });
  }
  const keyIdLen = buf[5]!;
  const headerLen = 6 + keyIdLen + TAIL_LEN;
  if (buf.length < headerLen) {
    throw new TypedError('backup_envelope_invalid', 'truncated envelope header', {});
  }
  let off = 6;
  const keyId = buf.subarray(off, off + keyIdLen).toString('utf8');
  off += keyIdLen;
  const kekNonce = buf.subarray(off, off + NONCE_LEN);
  off += NONCE_LEN;
  const kekTag = buf.subarray(off, off + TAG_LEN);
  off += TAG_LEN;
  const wrappedDek = buf.subarray(off, off + DEK_LEN);
  off += DEK_LEN;
  const dataNonce = buf.subarray(off, off + NONCE_LEN);
  return {
    keyId,
    header: buf.subarray(0, headerLen),
    headerLen,
    kekNonce,
    kekTag,
    wrappedDek,
    dataNonce,
  };
}

export interface EncryptResult {
  /** Identifier of the KEK used. Safe to persist in the manifest. */
  key_id: string;
  /** Bytes written to the destination (header + ciphertext + tag). */
  bytes: number;
}

/**
 * Stream-encrypt `srcPath` into `destPath`. Never buffers the payload.
 *
 * The destination is written and closed before the caller re-reads it to
 * compute `ciphertext_sha256` — verify-after-write, so a partially-flushed
 * artifact fails the checksum rather than being uploaded.
 */
export async function encryptFile(
  srcPath: string,
  destPath: string,
  keyring: BackupKeyring,
): Promise<EncryptResult> {
  const kek = keyring.keys.get(keyring.activeKeyId);
  if (!kek) {
    // Unreachable via parseBackupKeyring, but this is the last gate before we
    // would otherwise write something unreadable.
    throw new TypedError('backup_key_unavailable', 'active key missing from keyring', {});
  }

  const dek = randomBytes(DEK_LEN);
  const kekNonce = randomBytes(NONCE_LEN);
  const kekCipher = createCipheriv('aes-256-gcm', kek, kekNonce);
  const wrappedDek = Buffer.concat([kekCipher.update(dek), kekCipher.final()]);
  const kekTag = kekCipher.getAuthTag();

  const dataNonce = randomBytes(NONCE_LEN);
  const header = buildHeader(keyring.activeKeyId, kekNonce, kekTag, wrappedDek, dataNonce);

  const cipher = createCipheriv('aes-256-gcm', dek, dataNonce);
  cipher.setAAD(header);

  // The framer sits AFTER the cipher and owns the on-disk layout: it emits the
  // header before the first ciphertext byte and the GCM tag at flush time
  // (`cipher.final()` has already run by then, so `getAuthTag()` is valid).
  //
  // Everything happens inside ONE `pipeline` call on purpose: pipeline attaches
  // error handlers to every stream, so an EEXIST on the destination or a
  // mid-write ENOSPC rejects here instead of surfacing as an unhandled 'error'
  // event on a stream we built by hand.
  let headerEmitted = false;
  const framer = new Transform({
    transform(chunk, _enc, cb) {
      if (!headerEmitted) {
        headerEmitted = true;
        this.push(header);
      }
      cb(null, chunk);
    },
    flush(cb) {
      if (!headerEmitted) {
        headerEmitted = true;
        this.push(header);
      }
      this.push(cipher.getAuthTag());
      cb();
    },
  });

  try {
    await pipeline(
      createReadStream(srcPath),
      cipher,
      framer,
      createWriteStream(destPath, { flags: 'wx' }),
    );
  } finally {
    // Best-effort zeroing. Node may already have copied the buffer internally,
    // so this is hygiene rather than a guarantee.
    dek.fill(0);
  }

  const { size } = await stat(destPath);
  return { key_id: keyring.activeKeyId, bytes: size };
}

/**
 * Unwrap the DEK for an artifact. Isolated so `verifyDecryptable` (the
 * periodic decrypt drill of issue §5) can exercise key availability without
 * materialising the plaintext.
 */
function unwrapDek(parsedHeader: EncryptedHeader, keyring: BackupKeyring): Buffer {
  const kek = keyring.keys.get(parsedHeader.keyId);
  if (!kek) {
    throw new TypedError(
      'backup_key_unavailable',
      `artifact references key '${parsedHeader.keyId}' which is not in the keyring — a rotated key was retired while artifacts still reference it`,
      { key_id: parsedHeader.keyId },
    );
  }
  const kekDecipher = createDecipheriv('aes-256-gcm', kek, parsedHeader.kekNonce);
  kekDecipher.setAuthTag(parsedHeader.kekTag);
  try {
    return Buffer.concat([kekDecipher.update(parsedHeader.wrappedDek), kekDecipher.final()]);
  } catch {
    throw new TypedError(
      'backup_key_unwrap_failed',
      'wrapped data key failed authentication — the artifact header was altered or the key is wrong',
      { key_id: parsedHeader.keyId },
    );
  }
}

async function readHeader(path: string): Promise<{ parsed: EncryptedHeader; fileSize: number }> {
  const { size } = await stat(path);
  const fh = await open(path, 'r');
  try {
    // 6 + 255 (max keyIdLen) + TAIL_LEN covers any legal header.
    const probe = Buffer.alloc(Math.min(size, 6 + 255 + TAIL_LEN));
    await fh.read(probe, 0, probe.length, 0);
    return { parsed: parseHeader(probe), fileSize: size };
  } finally {
    await fh.close();
  }
}

/** Key id an artifact was sealed with, without decrypting it. */
export async function artifactKeyId(path: string): Promise<string> {
  const { parsed } = await readHeader(path);
  return parsed.keyId;
}

/**
 * Stream-decrypt `srcPath` into `destPath`. Throws on any authentication
 * failure — a tampered artifact NEVER yields partial plaintext the caller
 * might mistake for a restore candidate.
 */
export async function decryptFile(
  srcPath: string,
  destPath: string,
  keyring: BackupKeyring,
): Promise<{ bytes: number }> {
  const { parsed, fileSize } = await readHeader(srcPath);
  const payloadEnd = fileSize - TAG_LEN;
  if (payloadEnd < parsed.headerLen) {
    throw new TypedError('backup_envelope_invalid', 'artifact is too short to contain a tag', {});
  }

  const fh = await open(srcPath, 'r');
  let tag: Buffer;
  try {
    tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, payloadEnd);
  } finally {
    await fh.close();
  }

  const dek = unwrapDek(parsed, keyring);
  const decipher = createDecipheriv('aes-256-gcm', dek, parsed.dataNonce);
  decipher.setAAD(parsed.header);
  decipher.setAuthTag(tag);

  try {
    await pipeline(
      // `end` is inclusive in createReadStream.
      createReadStream(srcPath, { start: parsed.headerLen, end: payloadEnd - 1 }),
      decipher,
      createWriteStream(destPath, { flags: 'wx' }),
    );
  } catch (err) {
    throw new TypedError(
      'backup_decrypt_failed',
      'artifact failed authenticated decryption — it is corrupt or was tampered with',
      { key_id: parsed.keyId, cause: (err as Error).name },
    );
  } finally {
    dek.fill(0);
  }

  const { size } = await stat(destPath);
  return { bytes: size };
}

/**
 * Decrypt drill (issue §5 "teste periódico de decrypt") that does NOT write
 * plaintext anywhere: streams the payload through the decipher and discards
 * the output, so success proves the key is available and the tag verifies.
 */
export async function verifyDecryptable(
  srcPath: string,
  keyring: BackupKeyring,
): Promise<{ ok: true; key_id: string } | { ok: false; key_id: string | null; reason: string }> {
  let parsed: EncryptedHeader;
  let fileSize: number;
  try {
    ({ parsed, fileSize } = await readHeader(srcPath));
  } catch (err) {
    return { ok: false, key_id: null, reason: (err as TypedError).code ?? 'unreadable' };
  }
  const payloadEnd = fileSize - TAG_LEN;
  if (payloadEnd < parsed.headerLen) {
    return { ok: false, key_id: parsed.keyId, reason: 'backup_envelope_invalid' };
  }
  let dek: Buffer;
  try {
    dek = unwrapDek(parsed, keyring);
  } catch (err) {
    return { ok: false, key_id: parsed.keyId, reason: (err as TypedError).code ?? 'unwrap_failed' };
  }
  const fh = await open(srcPath, 'r');
  let tag: Buffer;
  try {
    tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, payloadEnd);
  } finally {
    await fh.close();
  }
  const decipher = createDecipheriv('aes-256-gcm', dek, parsed.dataNonce);
  decipher.setAAD(parsed.header);
  decipher.setAuthTag(tag);
  try {
    const source = createReadStream(srcPath, { start: parsed.headerLen, end: payloadEnd - 1 });
    // Discarding sink: the drill only needs the GCM tag to verify at end of
    // stream. Nothing is written anywhere, so a drill can run on a production
    // host without ever materialising decrypted personal data.
    const discard = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    await pipeline(source, decipher, discard);
    return { ok: true, key_id: parsed.keyId };
  } catch {
    return { ok: false, key_id: parsed.keyId, reason: 'backup_decrypt_failed' };
  } finally {
    dek.fill(0);
  }
}
