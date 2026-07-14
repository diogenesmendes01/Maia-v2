/**
 * Envelope AES-256-GCM versionado do staging (spec roteamento Draft v4
 * §1.4/§5): roundtrip, rotação por keyring (decifra pela key_id do envelope,
 * cifra sempre com a ativa), recusa de chave ausente e autenticação (tamper
 * ⇒ throw). O keyring é passado explicitamente — o config só provê defaults.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';

vi.mock('../../src/config/env.js', () => ({ config: {} }));

import {
  parseKeyring,
  sealEnvelope,
  openEnvelope,
  envelopeKeyId,
} from '../../src/gateway/staging-crypto.js';

const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');

describe('staging-crypto — envelope AES-256-GCM versionado', () => {
  it('roundtrip: seal → open devolve o plaintext; envelope carrega a key_id ativa', () => {
    const keyring = parseKeyring(JSON.stringify({ k1: K1 }), 'k1');
    const plain = Buffer.from(JSON.stringify({ hello: 'maia', n: 42 }), 'utf8');
    const envelope = sealEnvelope(plain, keyring);
    expect(envelopeKeyId(envelope)).toBe('k1');
    expect(openEnvelope(envelope, keyring).equals(plain)).toBe(true);
  });

  it('nonce único por selo: dois seals do mesmo plaintext diferem', () => {
    const keyring = parseKeyring(JSON.stringify({ k1: K1 }), 'k1');
    const plain = Buffer.from('same');
    expect(sealEnvelope(plain, keyring).equals(sealEnvelope(plain, keyring))).toBe(false);
  });

  it('rotação: envelope antigo (k1) abre com keyring novo que RETÉM k1; selos novos usam k2', () => {
    const oldRing = parseKeyring(JSON.stringify({ k1: K1 }), 'k1');
    const plain = Buffer.from('pre-rotation');
    const oldEnvelope = sealEnvelope(plain, oldRing);

    const newRing = parseKeyring(JSON.stringify({ k1: K1, k2: K2 }), 'k2');
    expect(openEnvelope(oldEnvelope, newRing).equals(plain)).toBe(true);
    expect(envelopeKeyId(sealEnvelope(plain, newRing))).toBe('k2');
  });

  it('recusa chave ausente: rotacionar REMOVENDO k1 com envelope pendente ⇒ staging_key_unavailable', () => {
    const oldRing = parseKeyring(JSON.stringify({ k1: K1 }), 'k1');
    const envelope = sealEnvelope(Buffer.from('pending row'), oldRing);
    const ringSemK1 = parseKeyring(JSON.stringify({ k2: K2 }), 'k2');
    expect(() => openEnvelope(envelope, ringSemK1)).toThrowError(
      expect.objectContaining({ code: 'staging_key_unavailable' }),
    );
  });

  it('autenticação GCM: um byte adulterado ⇒ open lança', () => {
    const keyring = parseKeyring(JSON.stringify({ k1: K1 }), 'k1');
    const envelope = sealEnvelope(Buffer.from('tamper me'), keyring);
    envelope[envelope.length - 1] = envelope[envelope.length - 1]! ^ 0xff;
    expect(() => openEnvelope(envelope, keyring)).toThrow();
  });

  it('versão desconhecida ⇒ staging_envelope_invalid', () => {
    const keyring = parseKeyring(JSON.stringify({ k1: K1 }), 'k1');
    const envelope = sealEnvelope(Buffer.from('x'), keyring);
    envelope[0] = 0x7f;
    expect(() => openEnvelope(envelope, keyring)).toThrowError(
      expect.objectContaining({ code: 'staging_envelope_invalid' }),
    );
  });
});

describe('staging-crypto — validação do keyring', () => {
  it('sem keyring/ativa configurados ⇒ staging_keyring_missing (strict não liga)', () => {
    expect(() => parseKeyring(undefined, undefined)).toThrowError(
      expect.objectContaining({ code: 'staging_keyring_missing' }),
    );
  });

  it('JSON inválido ⇒ staging_keyring_invalid', () => {
    expect(() => parseKeyring('not-json', 'k1')).toThrowError(
      expect.objectContaining({ code: 'staging_keyring_invalid' }),
    );
  });

  it('chave com tamanho errado ⇒ staging_keyring_invalid', () => {
    const short = randomBytes(16).toString('base64');
    expect(() => parseKeyring(JSON.stringify({ k1: short }), 'k1')).toThrowError(
      expect.objectContaining({ code: 'staging_keyring_invalid' }),
    );
  });

  it('chave ativa ausente do keyring ⇒ staging_keyring_invalid', () => {
    expect(() => parseKeyring(JSON.stringify({ k1: K1 }), 'k9')).toThrowError(
      expect.objectContaining({ code: 'staging_keyring_invalid' }),
    );
  });
});
