/**
 * P06 — o `parameters` que o Hermes pinado envia: porte do sanitizador, com
 * vetores gerados pelo `tools/schema_sanitizer.py` real (o spike
 * `hermes-schema-normalizer-spike` confere que o arquivo continua fiel).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify } from '@/integrations/hermes/canonical-json.js';
import {
  HermesSchemaUnsupportedError,
  hermesToolParameters,
  isMoonshotModel,
} from '@/integrations/hermes/hermes-schema-normalizer.js';

type Vector = {
  name: string;
  model: string;
  input_schema: unknown;
  expected: unknown;
  is_moonshot: boolean;
};
const M = 'maia-stub-model';
const { vectors } = JSON.parse(
  readFileSync(resolve('tests/fixtures/hermes-schema-sanitizer/vectors.json'), 'utf8'),
) as { vectors: Vector[] };

describe('hermesToolParameters — paridade com o sanitizador Python', () => {
  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_n, v) => {
    expect(isMoonshotModel(v.model)).toBe(v.is_moonshot);
    expect(canonicalJsonStringify(hermesToolParameters(v.input_schema, v.model))).toBe(
      canonicalJsonStringify(v.expected),
    );
  });

  it('não altera a entrada', () => {
    const v = vectors.find((x) => x.name === 'anulavel_aninhado')!;
    const antes = canonicalJsonStringify(v.input_schema);
    hermesToolParameters(v.input_schema, 'moonshotai/kimi-k2');
    expect(canonicalJsonStringify(v.input_schema)).toBe(antes);
  });
});

describe('hermesToolParameters — recusa o que o porte não reproduz', () => {
  it('nome de propriedade que o Hermes renomearia', () => {
    for (const nome of ['nome completo', 'a/b', 'x'.repeat(65), '']) {
      expect(() =>
        hermesToolParameters({ type: 'object', properties: { [nome]: { type: 'string' } } }, M),
      ).toThrow(HermesSchemaUnsupportedError);
    }
  });

  it('nome renomeável também em objeto aninhado', () => {
    expect(() =>
      hermesToolParameters(
        {
          type: 'object',
          properties: { ok: { type: 'object', properties: { 'não ok': { type: 'string' } } } },
        },
        M,
      ),
    ).toThrow(HermesSchemaUnsupportedError);
  });

  it('`__proto__` em qualquer ponto', () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"a":{"type":"string","default":{"__proto__":{"x":1}}}}}',
    ) as unknown;
    expect(() => hermesToolParameters(schema, M)).toThrow(HermesSchemaUnsupportedError);
  });

  it('Kimi: forma que derrubaria o sanitizador Moonshot do Python', () => {
    const kimi = 'moonshotai/kimi-k2';
    // As duas levantam TypeError no `agent/moonshot_schema.py` pinado.
    const casos = [
      { type: 'object', properties: { a: { type: { x: 1 } } } },
      {
        type: 'object',
        properties: { o: { properties: { a: { type: 'string' } }, required: [{}] } },
      },
    ];
    for (const c of casos) {
      expect(() => hermesToolParameters(c, kimi)).toThrow(HermesSchemaUnsupportedError);
    }
  });

  it('Kimi: tipo inferido do enum segue a leitura do Python (inteiro até 1e21)', () => {
    const tipo = (v: number) =>
      (
        hermesToolParameters(
          { type: 'object', properties: { e: { enum: [v] } } },
          'moonshotai/kimi-k2',
        ).properties as Record<string, { type: string }>
      ).e.type;
    expect(tipo(2 ** 60)).toBe('integer');
    expect(tipo(1e21)).toBe('number');
    expect(tipo(1.5)).toBe('number');
  });
});
