/**
 * P07 — `tool_schema_digest` da Maia igual ao do worker Python.
 *
 * Os vetores foram gerados pelo próprio worker, sem Hermes instalado:
 *
 *   python -c "import sys; sys.path.insert(0,'.');
 *     from services.hermes_worker.bridge_tools import ToolSpec, tool_schema_digest;
 *     print(tool_schema_digest([ToolSpec.from_projection(e) for e in TOOLS]))"
 *
 * com `TOOLS` = as duas entradas de `DUAS_TOOLS` abaixo (e `[]` para o vazio).
 */
import { describe, it, expect } from 'vitest';
import {
  computeToolSchemaDigest,
  type WorkerToolProjectionV1,
} from '@/integrations/hermes/tool-schema-digest.js';

const ZETA: WorkerToolProjectionV1 = {
  name: 'zeta_lookup',
  input_schema: {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
    additionalProperties: false,
  },
  result_limit_chars: 2048,
};

const ECHO: WorkerToolProjectionV1 = {
  name: 'fixture_echo',
  input_schema: {
    type: 'object',
    properties: { texto: { type: 'string' } },
    required: ['texto'],
    additionalProperties: false,
  },
  result_limit_chars: 4096,
};

const DUAS_TOOLS = [ZETA, ECHO];

describe('computeToolSchemaDigest — paridade com services/hermes_worker', () => {
  it('bate com o vetor gerado pelo Python para duas tools', () => {
    expect(computeToolSchemaDigest(DUAS_TOOLS)).toBe(
      'da2818dacd582f68995260402654a0a1f506d060bb692443446d5b19bcd6424f',
    );
  });

  it('bate com o vetor gerado pelo Python para a superfície vazia', () => {
    expect(computeToolSchemaDigest([])).toBe(
      'ae1af8b1b3fc090b9fc82949533aed6a06bcb524c049ce92403c76675bad3827',
    );
  });

  it('não depende da ordem em que a Maia listou as tools', () => {
    expect(computeToolSchemaDigest([ECHO, ZETA])).toBe(computeToolSchemaDigest([ZETA, ECHO]));
  });

  it('muda quando o schema, o limite ou o nome mudam', () => {
    const base = computeToolSchemaDigest([ECHO]);
    expect(computeToolSchemaDigest([{ ...ECHO, result_limit_chars: 4095 }])).not.toBe(base);
    expect(computeToolSchemaDigest([{ ...ECHO, name: 'fixture_echo2' }])).not.toBe(base);
    expect(
      computeToolSchemaDigest([
        { ...ECHO, input_schema: { ...ECHO.input_schema, required: [] } },
      ]),
    ).not.toBe(base);
  });

  it('ignora campos fora da projeção (description não entra no digest)', () => {
    const comExtra = { ...ECHO, description: 'x' } as WorkerToolProjectionV1;
    expect(computeToolSchemaDigest([comExtra])).toBe(computeToolSchemaDigest([ECHO]));
  });

  it('ordena por code point, como o sorted do Python (fora do BMP)', () => {
    // U+1F600 (surrogate D83D) vem DEPOIS de U+FF5E em code point, mas ANTES
    // em unidade UTF-16. O sort padrão do JS inverteria os dois.
    // Vetor do Python com os nomes ['\U0001F600', '～'] e o schema de ECHO.
    const a = { ...ECHO, name: '\u{1F600}' };
    const b = { ...ECHO, name: '～' };
    const PYTHON = 'a6fc4bb4e6fbbf8f20e82b4ab72053533b0250b31a33a853bc95b118ce618af7';
    expect(computeToolSchemaDigest([a, b])).toBe(PYTHON);
    expect(computeToolSchemaDigest([b, a])).toBe(PYTHON);
  });
});
