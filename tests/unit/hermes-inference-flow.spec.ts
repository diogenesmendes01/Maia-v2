/**
 * P06 — decisões puras do caminho de um request no gateway: superfície (nomes
 * E schemas), teto de saída, dinheiro inteiro arredondado para cima, projeção
 * da resposta, SSE e rede interna.
 */
import { describe, expect, it } from 'vitest';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import {
  parseInferenceRequest,
  parseInferenceResponse,
  type InferenceRequestV1,
} from '@/integrations/hermes/inference-gateway.js';
import {
  checkRequestSurface,
  costFromUsage,
  enforceOutputCap,
  estimateExposureMicrousd,
  inputTokensUpperBound,
  isInternalRequest,
  parseSourceAllowlist,
  projectChatCompletion,
  renderChatCompletionSse,
} from '@/integrations/hermes/inference-flow.js';

const SCHEMA = {
  additionalProperties: false,
  properties: { texto: { type: 'string' } },
  required: ['texto'],
  type: 'object',
};
const SURFACE = { fixture_echo: canonicalDigest(SCHEMA) };

function req(over: Record<string, unknown> = {}): InferenceRequestV1 {
  const r = parseInferenceRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'oi' }],
    tools: [{ type: 'function', function: { name: 'fixture_echo', parameters: SCHEMA } }],
    ...over,
  });
  if (r.kind !== 'ok') throw new Error(r.field);
  return r.request;
}

describe('checkRequestSurface — nomes E schemas', () => {
  it('aceita a superfície do grant, com o schema na ordem que for', () => {
    const reordenado = { type: 'object', required: ['texto'], properties: SCHEMA.properties, additionalProperties: false };
    expect(
      checkRequestSurface(
        req({ tools: [{ type: 'function', function: { name: 'fixture_echo', parameters: reordenado } }] }),
        SURFACE,
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    [
      'tool_not_in_surface',
      { tools: [{ type: 'function', function: { name: 'terminal', parameters: SCHEMA } }] },
    ],
    [
      'tool_schema_mismatch',
      {
        tools: [
          {
            type: 'function',
            function: { name: 'fixture_echo', parameters: { ...SCHEMA, additionalProperties: true } },
          },
        ],
      },
    ],
    ['tool_choice_outside', { tool_choice: { type: 'function', function: { name: 'terminal' } } }],
    ['tool_choice_outside', { tools: [], tool_choice: 'required' }],
    [
      'history_tool_outside',
      {
        messages: [
          { role: 'user', content: 'oi' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'terminal', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'x' },
        ],
      },
    ],
  ])('recusa %s', (reason, over) => {
    expect(checkRequestSurface(req(over), SURFACE)).toEqual({ ok: false, reason });
  });

  it('nome que é chave do protótipo não passa por herança', () => {
    expect(
      checkRequestSurface(
        req({ tools: [{ type: 'function', function: { name: 'toString', parameters: SCHEMA } }] }),
        SURFACE,
      ),
    ).toEqual({ ok: false, reason: 'tool_not_in_surface' });
  });
});

describe('enforceOutputCap', () => {
  it('ausente vira o teto; igual passa; acima recusa', () => {
    expect(enforceOutputCap(req(), 256)).toEqual({ ok: true, max_tokens: 256 });
    expect(enforceOutputCap(req({ max_tokens: 256 }), 256)).toEqual({ ok: true, max_tokens: 256 });
    expect(enforceOutputCap(req({ max_tokens: 257 }), 256)).toEqual({ ok: false });
  });
});

describe('dinheiro em inteiros, arredondado para cima', () => {
  const tarifa = { version: 'v1', input_nanousd_per_token: 3000, output_nanousd_per_token: 15000 };

  it('exposição: bytes como cota superior de tokens', () => {
    const r = req();
    const upper = inputTokensUpperBound(r);
    expect(upper).toBeGreaterThan(Buffer.byteLength(JSON.stringify(r.messages)));
    // (upper*3000 + 100*15000) nanousd, arredondado para cima em microusd.
    const esperado = Math.ceil((upper * 3000 + 100 * 15000) / 1000).toString();
    expect(estimateExposureMicrousd(upper, 100, tarifa)).toBe(esperado);
  });

  it('sem tarifa não há número: null, nunca zero', () => {
    expect(estimateExposureMicrousd(10, 10, null)).toBeNull();
    expect(costFromUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, null)).toBeNull();
    expect(costFromUsage(null, tarifa)).toBeNull();
  });

  it('custo do uso: fração de microusd vira 1', () => {
    const t = { version: 'v', input_nanousd_per_token: 200, output_nanousd_per_token: 500 };
    expect(costFromUsage({ prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 }, t)).toBe('1');
    expect(costFromUsage({ prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 }, t)).toBe('1');
    expect(costFromUsage({ prompt_tokens: 6, completion_tokens: 0, total_tokens: 6 }, t)).toBe('2');
  });

  it('tarifa fora de inteiro falha alto', () => {
    expect(() =>
      estimateExposureMicrousd(1, 1, { version: 'v', input_nanousd_per_token: 0.5, output_nanousd_per_token: 1 }),
    ).toThrow(RangeError);
  });
});

describe('projectChatCompletion + parseInferenceResponse', () => {
  const RAW = {
    id: 'gen-1',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    system_fingerprint: 'fp',
    provider: 'x',
    choices: [
      {
        index: 0,
        logprobs: null,
        message: {
          role: 'assistant',
          content: null,
          refusal: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'fixture_echo', arguments: '{"texto":"a"}' } },
          ],
        },
        finish_reason: 'tool_calls',
        native_finish_reason: 'tool_use',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 0 },
      cost: 0.01,
    },
  };

  it('extras do provider saem e o contrato estrito aceita', () => {
    const parsed = parseInferenceResponse(projectChatCompletion(RAW), ['fixture_echo']);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.response.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    expect(parsed.response.choices[0]!.message.tool_calls?.[0]?.function.name).toBe('fixture_echo');
  });

  it('uso parcial some inteiro (desconhecido, não zero)', () => {
    const parcial = { ...RAW, usage: { prompt_tokens: 10 } };
    const parsed = parseInferenceResponse(projectChatCompletion(parcial), ['fixture_echo']);
    expect(parsed.kind === 'ok' && parsed.response.usage).toBeNull();
  });

  it.each([
    ['negativo', -1],
    ['fracionário', 1.5],
    ['acima do int4 do ledger', 2_147_483_648],
  ])('contagem de tokens %s: uso desconhecido, não registrado', (_n, n) => {
    const ruim = { ...RAW, usage: { prompt_tokens: n, completion_tokens: 2, total_tokens: 12 } };
    const parsed = parseInferenceResponse(projectChatCompletion(ruim), ['fixture_echo']);
    expect(parsed.kind === 'ok' && parsed.response.usage).toBeNull();
  });

  it('tool fora da superfície continua recusada depois da projeção', () => {
    expect(parseInferenceResponse(projectChatCompletion(RAW), ['outra']).kind).toBe('invalid');
  });
});

describe('renderChatCompletionSse', () => {
  const base = {
    id: 'gen-1',
    object: 'chat.completion' as const,
    created: 1,
    model: 'm',
  };

  function chunks(sse: string): unknown[] {
    return sse
      .split('\n\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6))
      .map((d) => (d === '[DONE]' ? d : JSON.parse(d)));
  }

  it('texto: papel, conteúdo, fim, uso e [DONE]', () => {
    const sse = renderChatCompletionSse(
      {
        ...base,
        choices: [{ index: 0, message: { role: 'assistant', content: 'olá' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      true,
    );
    const c = chunks(sse) as Array<Record<string, unknown>>;
    expect(c.at(-1)).toBe('[DONE]');
    expect(c[1]).toMatchObject({ object: 'chat.completion.chunk', choices: [{ delta: { content: 'olá' } }] });
    expect(c[2]).toMatchObject({ choices: [{ finish_reason: 'stop' }] });
    expect(c[3]).toMatchObject({ choices: [], usage: { total_tokens: 2 } });
  });

  it('tool call vai com índice, id e argumentos intactos', () => {
    const sse = renderChatCompletionSse(
      {
        ...base,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: null,
      },
      true,
    );
    const c = chunks(sse) as Array<Record<string, unknown>>;
    expect(c[1]).toMatchObject({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] } }],
    });
    // Uso desconhecido: nenhum chunk de uso.
    expect(c.some((x) => typeof x === 'object' && 'usage' in (x as object))).toBe(false);
  });
});

describe('isInternalRequest — allowlist positiva', () => {
  const allowed = parseSourceAllowlist('10.1.0.0/16, 172.18.0.5, fd00::10')!;

  it.each([
    ['127.0.0.1', [], true],
    ['127.9.9.9', [], true],
    ['::1', [], true],
    ['::ffff:127.0.0.1', [], true],
    // IP privado NÃO basta: o proxy da borda também fala da rede privada.
    ['10.1.2.3', [], false],
    ['192.168.1.1', [], false],
    ['10.1.2.3', allowed, true],
    ['::ffff:10.1.2.3', allowed, true],
    ['10.2.0.1', allowed, false],
    ['172.18.0.5', allowed, true],
    ['172.18.0.6', allowed, false],
    ['fd00::10', allowed, true],
    ['fd00::11', allowed, false],
    ['8.8.8.8', allowed, false],
  ] as const)('%s com %j → %s', (addr, rules, ok) => {
    expect(isInternalRequest({ remote_address: addr, headers: {}, allowed: rules })).toBe(ok);
  });

  it('qualquer cabeçalho de proxy recusa, até da loopback', () => {
    for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'via']) {
      expect(isInternalRequest({ remote_address: '127.0.0.1', headers: { [h]: '1.2.3.4' } })).toBe(false);
    }
  });

  it('sem endereço recusa', () => {
    expect(isInternalRequest({ remote_address: undefined, headers: {} })).toBe(false);
  });
});

describe('parseSourceAllowlist', () => {
  it('vazio é só loopback; lista válida vira regras', () => {
    expect(parseSourceAllowlist(undefined)).toEqual([]);
    expect(parseSourceAllowlist('  ')).toEqual([]);
    expect(parseSourceAllowlist('10.0.0.0/8')).toHaveLength(1);
  });

  it.each(['10.0.0.256', '10.0.0.0/33', 'abc', '10.0.0.0/8,,', 'fd00::zz'])(
    'entrada inválida (%s) recusa a lista inteira',
    (t) => {
      expect(parseSourceAllowlist(t)).toBeNull();
    },
  );
});
