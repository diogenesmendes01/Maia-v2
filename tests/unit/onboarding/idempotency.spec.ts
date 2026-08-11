/**
 * Issue #519 §4 — idempotência. Três propriedades e os motivos de cada uma:
 *   - a chave do cliente NUNCA é persistida em claro (só o hash);
 *   - o hash de payload é CANÔNICO, senão a mesma intenção com as chaves JSON
 *     em outra ordem viraria "conflito";
 *   - mesma chave + payload divergente é CONFLITO, senão devolveríamos o
 *     resultado de uma intenção diferente da que o cliente enviou.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalJson,
  decideIdempotency,
  hashIdempotencyKey,
  hashPayload,
} from '../../../src/onboarding/idempotency.js';
import { OnboardingError } from '../../../src/onboarding/errors.js';

describe('hashIdempotencyKey', () => {
  it('produz o SHA-256 da chave e nunca a chave', () => {
    const key = 'wizard-run-42-step-1';
    const hash = hashIdempotencyKey(key);
    expect(hash).toBe(createHash('sha256').update(key, 'utf8').digest('hex'));
    expect(hash).not.toContain(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('é determinístico', () => {
    expect(hashIdempotencyKey('abcdefgh')).toBe(hashIdempotencyKey('abcdefgh'));
  });

  it.each([['', 'vazia'], ['short', 'curta demais'], ['   \t  ', 'whitespace']])(
    'rejeita chave %s (%s)',
    (key) => {
      try {
        hashIdempotencyKey(key);
        throw new Error('deveria ter lançado');
      } catch (err) {
        expect((err as OnboardingError).code).toBe('missing_idempotency_key');
      }
    },
  );

  it.each([null, undefined, 12345678, {}])('rejeita não-string (%p)', (key) => {
    expect(() => hashIdempotencyKey(key)).toThrow(OnboardingError);
  });
});

describe('canonicalJson / hashPayload', () => {
  it('ordena as chaves de objeto recursivamente', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('a ordem das chaves NÃO muda o hash', () => {
    expect(hashPayload({ tenant_id: 'acme', nome: 'Acme' })).toBe(
      hashPayload({ nome: 'Acme', tenant_id: 'acme' }),
    );
  });

  it('`undefined` some — o round-trip JSON o removeria de qualquer forma', () => {
    expect(hashPayload({ a: 1 })).toBe(hashPayload({ a: 1, b: undefined }));
  });

  it('a ordem de ARRAY é semântica e MUDA o hash', () => {
    // Deliberado: normalizar conjunto é responsabilidade de quem monta o
    // payload (o wizard ordena `granted_packs`), não do hasher.
    expect(hashPayload({ p: ['a', 'b'] })).not.toBe(hashPayload({ p: ['b', 'a'] }));
  });

  it('valores diferentes produzem hashes diferentes', () => {
    expect(hashPayload({ nome: 'Acme' })).not.toBe(hashPayload({ nome: 'Globex' }));
  });

  it('Date é normalizada para ISO', () => {
    expect(canonicalJson({ d: new Date('2026-08-04T00:00:00Z') })).toBe(
      '{"d":"2026-08-04T00:00:00.000Z"}',
    );
  });
});

describe('decideIdempotency', () => {
  it('sem linha no ledger ⇒ executa', () => {
    expect(decideIdempotency({ payload_hash: 'h1', existing: null })).toEqual({
      outcome: 'execute',
    });
  });

  it('mesma chave + mesmo payload ⇒ REPLAY do resultado persistido', () => {
    expect(
      decideIdempotency({
        payload_hash: 'h1',
        existing: { payload_hash: 'h1', result: { tenant_id: 'acme' } },
      }),
    ).toEqual({ outcome: 'replay', result: { tenant_id: 'acme' } });
  });

  it('mesma chave + payload DIVERGENTE ⇒ CONFLITO (nunca devolve o resultado antigo)', () => {
    expect(
      decideIdempotency({
        payload_hash: 'h2',
        existing: { payload_hash: 'h1', result: { tenant_id: 'acme' } },
      }),
    ).toEqual({ outcome: 'conflict' });
  });
});
