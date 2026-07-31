/**
 * Issue #519 §4 — a base da idempotência: os HASHES.
 *
 * Duas propriedades são carregadas por estas funções e por mais nada:
 *
 *   1. o mesmo PEDIDO produz o mesmo hash, independentemente da ordem em que o
 *      cliente serializou o objeto. Sem canonicalização, `{a,b}` e `{b,a}`
 *      teriam hashes diferentes e o backend recusaria um retry legítimo com
 *      `idempotency_payload_mismatch`;
 *   2. a chave OPACA nunca é persistida — só o SHA-256 dela. É o mesmo
 *      contrato do segredo de bootstrap.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { hashOpaque, hashPayload } from '@/db/repositories/onboarding-repos.js';

describe('issue #519 — hashes de idempotência', () => {
  it('hashOpaque é SHA-256 hex e não devolve a entrada', () => {
    const secret = 'chave-opaca-do-cliente';
    const h = hashOpaque(secret);
    expect(h).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(secret);
  });

  it('o hash do payload NÃO depende da ordem das chaves', () => {
    const a = hashPayload({ tenant_id: 'acme', nome: 'Acme', comment: 'provisionamento' });
    const b = hashPayload({ comment: 'provisionamento', nome: 'Acme', tenant_id: 'acme' });
    expect(a).toBe(b);
  });

  it('canonicaliza recursivamente (objetos aninhados e listas)', () => {
    const a = hashPayload({ outer: { x: 1, y: [{ p: 1, q: 2 }] } });
    const b = hashPayload({ outer: { y: [{ q: 2, p: 1 }], x: 1 } });
    expect(a).toBe(b);
  });

  it('a ORDEM de uma lista importa — listas são dados, não conjuntos', () => {
    expect(hashPayload({ packs: ['a', 'b'] })).not.toBe(hashPayload({ packs: ['b', 'a'] }));
  });

  it('`undefined` é ignorado, `null` não — campo omitido ≠ campo limpo', () => {
    expect(hashPayload({ a: 1, b: undefined })).toBe(hashPayload({ a: 1 }));
    expect(hashPayload({ a: 1, b: null })).not.toBe(hashPayload({ a: 1 }));
  });

  it('conteúdo diferente produz hash diferente', () => {
    const base = { tenant_id: 'acme', comment: 'provisionamento inicial' };
    expect(hashPayload(base)).not.toBe(hashPayload({ ...base, tenant_id: 'outro' }));
    expect(hashPayload(base)).not.toBe(hashPayload({ ...base, comment: 'outra coisa' }));
  });
});
