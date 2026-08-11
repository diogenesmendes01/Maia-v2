/**
 * Cifra do staging de inbound não-roteado (spec roteamento Draft v4 §1.4).
 *
 * Envelope AES-256-GCM VERSIONADO — GCM exige nonce único por operação e
 * autentica via tag (review v3: "ciphertext + key_id" sozinhos não são
 * implementáveis com segurança):
 *
 *   [ v:1B = 0x01 ][ keyIdLen:1B ][ keyId:utf8 ][ nonce:12B ][ tag:16B ][ ciphertext ]
 *
 * Keyring: MAIA_STAGING_KEYRING = JSON { key_id: base64(32 bytes) };
 * MAIA_STAGING_ACTIVE_KEY_ID aponta a chave de CIFRA. Decifra resolve pela
 * key_id do envelope — rotação = nova chave no keyring + trocar a ativa; a
 * anterior PERMANECE no keyring enquanto existir row pendente que a
 * referencie (regra operacional verificada pelo sweeper — spec §1.4).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config/env.js';
import { TypedError } from '../lib/utils.js';

const ENVELOPE_V1 = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export interface StagingKeyring {
  activeKeyId: string;
  keys: Map<string, Buffer>;
}

export function parseKeyring(
  raw: string | undefined = config.MAIA_STAGING_KEYRING,
  activeKeyId: string | undefined = config.MAIA_STAGING_ACTIVE_KEY_ID,
): StagingKeyring {
  if (!raw || !activeKeyId) {
    throw new TypedError(
      'staging_keyring_missing',
      'MAIA_STAGING_KEYRING/MAIA_STAGING_ACTIVE_KEY_ID not configured — strict routing must stay off',
      {},
    );
  }
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new TypedError('staging_keyring_invalid', 'keyring is not valid JSON', {});
  }
  const keys = new Map<string, Buffer>();
  for (const [id, b64] of Object.entries(parsed)) {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== KEY_LEN) {
      throw new TypedError('staging_keyring_invalid', `key '${id}' is not 32 bytes`, {
        key_id: id,
      });
    }
    keys.set(id, buf);
  }
  if (!keys.has(activeKeyId)) {
    throw new TypedError(
      'staging_keyring_invalid',
      `active key '${activeKeyId}' not present in keyring`,
      { active_key_id: activeKeyId },
    );
  }
  return { activeKeyId, keys };
}

export function sealEnvelope(plaintext: Buffer, keyring: StagingKeyring): Buffer {
  const key = keyring.keys.get(keyring.activeKeyId)!;
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const keyIdBuf = Buffer.from(keyring.activeKeyId, 'utf8');
  if (keyIdBuf.length > 255) {
    throw new TypedError('staging_keyring_invalid', 'key_id longer than 255 bytes', {});
  }
  return Buffer.concat([
    Buffer.from([ENVELOPE_V1, keyIdBuf.length]),
    keyIdBuf,
    nonce,
    tag,
    ciphertext,
  ]);
}

export function envelopeKeyId(envelope: Buffer): string {
  if (envelope.length < 2 || envelope[0] !== ENVELOPE_V1) {
    throw new TypedError('staging_envelope_invalid', 'unknown envelope version', {});
  }
  const keyIdLen = envelope[1]!;
  return envelope.subarray(2, 2 + keyIdLen).toString('utf8');
}

export function openEnvelope(envelope: Buffer, keyring: StagingKeyring): Buffer {
  if (envelope.length < 2 || envelope[0] !== ENVELOPE_V1) {
    throw new TypedError('staging_envelope_invalid', 'unknown envelope version', {});
  }
  const keyIdLen = envelope[1]!;
  let off = 2;
  const keyId = envelope.subarray(off, off + keyIdLen).toString('utf8');
  off += keyIdLen;
  const nonce = envelope.subarray(off, off + NONCE_LEN);
  off += NONCE_LEN;
  const tag = envelope.subarray(off, off + TAG_LEN);
  off += TAG_LEN;
  const ciphertext = envelope.subarray(off);
  const key = keyring.keys.get(keyId);
  if (!key) {
    throw new TypedError(
      'staging_key_unavailable',
      `envelope references key '${keyId}' not present in keyring — a rotated key was removed while rows still reference it`,
      { key_id: keyId },
    );
  }
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
