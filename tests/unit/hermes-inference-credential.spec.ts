/**
 * P06 — a credencial curta de inferência: formato, hash, bearer e a superfície
 * de tools (nome → digest do schema) que o grant autoriza.
 */
import { describe, expect, it } from 'vitest';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import {
  bearerTokenOf,
  hashInferenceToken,
  isWellFormedInferenceToken,
  mintInferenceToken,
  toolSurfaceOf,
} from '@/integrations/hermes/inference-credential.js';

describe('credencial de inferência', () => {
  it('token novo tem 256 bits, forma fixa e nunca se repete', () => {
    const a = mintInferenceToken();
    const b = mintInferenceToken();
    expect(isWellFormedInferenceToken(a)).toBe(true);
    expect(a).not.toBe(b);
    // Cabe no env do filho (supervisor recusa fora de \x21-\x7e).
    expect(a).toMatch(/^[\x21-\x7e]+$/);
  });

  it('forma errada é recusada sem consultar nada', () => {
    for (const t of ['', 'mhi1_curto', `mhi2_${'a'.repeat(43)}`, `mhi1_${'a'.repeat(42)}!`]) {
      expect(isWellFormedInferenceToken(t)).toBe(false);
    }
  });

  it('hash é sha256 hex estável', () => {
    const t = mintInferenceToken();
    expect(hashInferenceToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInferenceToken(t)).toBe(hashInferenceToken(t));
  });

  it('bearer: só `Bearer <token>`', () => {
    expect(bearerTokenOf('Bearer abc')).toBe('abc');
    for (const h of [undefined, '', 'bearer abc', 'Basic abc', 'Bearer ', 'Bearer a b', ['Bearer a']]) {
      expect(bearerTokenOf(h as never)).toBeNull();
    }
  });

  it('superfície: nome → digest do schema, e recusa nome repetido ou reservado', () => {
    const schema = { type: 'object', properties: {}, additionalProperties: false };
    expect(toolSurfaceOf([{ name: 'x', input_schema: schema }])).toEqual({
      x: canonicalDigest(schema),
    });
    expect(() =>
      toolSurfaceOf([
        { name: 'x', input_schema: schema },
        { name: 'x', input_schema: schema },
      ]),
    ).toThrow(TypeError);
    expect(() => toolSurfaceOf([{ name: '__proto__', input_schema: schema }])).toThrow(TypeError);
  });

  it('superfície é o digest do schema que o Hermes envia, não do manifest cru', () => {
    const record = {
      type: 'object',
      properties: {
        meta: { type: 'object', additionalProperties: { type: 'string' } },
        valor: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      },
      additionalProperties: false,
    };
    const enviado = {
      type: 'object',
      properties: {
        meta: { type: 'object', additionalProperties: { type: 'string' }, properties: {} },
        valor: { type: 'number', nullable: true },
      },
      additionalProperties: false,
    };
    expect(toolSurfaceOf([{ name: 'r', input_schema: record }])).toEqual({
      r: canonicalDigest(enviado),
    });
    expect(() =>
      toolSurfaceOf([{ name: 'r', input_schema: { type: 'object', properties: { 'a b': {} } } }]),
    ).toThrow(TypeError);
  });
});
