/**
 * Issue #518 — material efêmero de pareamento (QR/código) NUNCA em claro.
 *
 * O QR e o código de 8 dígitos são credenciais: quem os lê conecta um
 * aparelho na linha. Como o console e o runtime são processos distintos, eles
 * atravessam o Postgres — e só podem atravessar CIFRADOS, com TTL curto.
 * Estes testes travam o contrato:
 *   - o envelope não contém o material em claro (canário de vazamento);
 *   - roundtrip preserva QR e código;
 *   - sem keyring, cifrar FALHA (fail-closed) em vez de degradar;
 *   - envelope corrompido/estrangeiro nunca devolve conteúdo parcial.
 */
import { describe, it, expect, vi } from 'vitest';

const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

vi.mock('../../../src/config/env.js', () => ({
  config: {
    MAIA_STAGING_KEYRING: JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') }),
    MAIA_STAGING_ACTIVE_KEY_ID: 'k1',
  },
}));

import {
  sealPairingMaterial,
  openPairingMaterial,
  isPairingMaterialConfigured,
  PAIRING_MATERIAL_TTL_MS,
} from '../../../src/setup/pairing-material.js';
import { parseKeyring, sealEnvelope } from '../../../src/gateway/staging-crypto.js';

const QR = '2@abcDEF/ghi+jkl=,mnoPQR/stu+vwx=,yzABCD/efg+hij=,1';
const CODE = '4F7K2M9Q';

describe('pairing-material — canário de vazamento', () => {
  it('o envelope NÃO contém o QR em claro (nem em utf8 nem em base64)', () => {
    const { envelope } = sealPairingMaterial({
      kind: 'qr',
      png_data_uri: `data:image/png;base64,${QR}`,
    });
    expect(envelope.toString('utf8')).not.toContain(QR);
    expect(envelope.toString('base64')).not.toContain(Buffer.from(QR).toString('base64'));
    expect(envelope.toString('latin1')).not.toContain('data:image/png');
  });

  it('o envelope NÃO contém o código de pareamento em claro', () => {
    const { envelope } = sealPairingMaterial({ kind: 'code', code: CODE });
    expect(envelope.toString('utf8')).not.toContain(CODE);
    expect(envelope.toString('latin1')).not.toContain(CODE);
  });

  it('dois selos do MESMO material produzem envelopes distintos (nonce por operação)', () => {
    const a = sealPairingMaterial({ kind: 'code', code: CODE }).envelope;
    const b = sealPairingMaterial({ kind: 'code', code: CODE }).envelope;
    expect(a.equals(b)).toBe(false);
  });
});

describe('pairing-material — roundtrip', () => {
  it('QR: data URI volta idêntico e a key_id ativa acompanha o envelope', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgo=';
    const { envelope, key_id } = sealPairingMaterial({ kind: 'qr', png_data_uri: uri });
    expect(key_id).toBe('k1');
    expect(openPairingMaterial(envelope)).toEqual({ kind: 'qr', png_data_uri: uri });
  });

  it('código: volta idêntico', () => {
    const { envelope } = sealPairingMaterial({ kind: 'code', code: CODE });
    expect(openPairingMaterial(envelope)).toEqual({ kind: 'code', code: CODE });
  });

  it('TTL do material é curto (menor que o TTL de 15min da PairingSession)', () => {
    expect(PAIRING_MATERIAL_TTL_MS).toBeGreaterThan(0);
    expect(PAIRING_MATERIAL_TTL_MS).toBeLessThan(15 * 60_000);
  });
});

describe('pairing-material — fail-closed', () => {
  it('keyring presente ⇒ disponível', () => {
    expect(isPairingMaterialConfigured()).toBe(true);
  });

  it('envelope corrompido não devolve conteúdo parcial: lança pairing_material_unreadable', () => {
    const { envelope } = sealPairingMaterial({ kind: 'code', code: CODE });
    const tampered = Buffer.from(envelope);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => openPairingMaterial(tampered)).toThrowError(/pareamento não pôde ser aberto/);
  });

  it('envelope selado com OUTRA chave (rotação removida) não abre', () => {
    const foreign = parseKeyring(
      JSON.stringify({ other: Buffer.alloc(32, 9).toString('base64') }),
      'other',
    );
    const envelope = sealEnvelope(
      Buffer.from(JSON.stringify({ kind: 'code', code: CODE })),
      foreign,
    );
    expect(() => openPairingMaterial(envelope)).toThrowError(/pareamento não pôde ser aberto/);
  });

  it('envelope válido mas com payload desconhecido é rejeitado (nunca "meio aberto")', () => {
    const ring = parseKeyring(JSON.stringify({ k1: KEY_B64 }), 'k1');
    const envelope = sealEnvelope(Buffer.from(JSON.stringify({ kind: 'token' })), ring);
    expect(() => openPairingMaterial(envelope)).toThrowError(/formato desconhecido/);
  });
});
