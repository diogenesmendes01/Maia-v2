/**
 * P06 — tarifa versionada a partir do catálogo: só preço BUSCADO vale, as duas
 * taxas cobrem tudo o que uma chamada pelo gateway pode custar, e a conversão
 * da string decimal arredonda para cima.
 */
import { describe, expect, it } from 'vitest';
import { parseInferenceRequest } from '@/integrations/hermes/inference-gateway.js';
import {
  createCatalogTariff,
  nanousdPerTokenCeil,
  TARIFF_UNREACHABLE_COMPONENTS,
} from '@/integrations/hermes/inference-tariff.js';
import type { OpenRouterModel } from '@/lib/openrouter-models.js';

function model(pricing_raw?: Record<string, unknown>): OpenRouterModel {
  return {
    id: 'anthropic/claude-sonnet-4.6',
    name: 'Sonnet',
    context_length: 200_000,
    pricing: { prompt_per_million: 3, completion_per_million: 15 },
    supports_tools: true,
    ...(pricing_raw ? { pricing_raw } : {}),
  };
}

const tariff = (models: OpenRouterModel[], fallback = false) =>
  createCatalogTariff({ models: async () => ({ models, fallback }) });

const ID = 'anthropic/claude-sonnet-4.6';

describe('nanousdPerTokenCeil', () => {
  it.each([
    ['0.000003', 3000],
    ['0.00000057816', 579],
    ['0.000000578', 578],
    ['0', 0],
    ['1', 1_000_000_000],
  ])('%s → %i (para cima)', (s, n) => {
    expect(nanousdPerTokenCeil(s)).toBe(n);
  });

  it.each(['-0.1', '1e-7', 'abc', '', '0.1.2'])('forma inválida (%s) é null', (s) => {
    expect(nanousdPerTokenCeil(s)).toBeNull();
  });
});

describe('createCatalogTariff', () => {
  it('preço cru por token vira nanousd inteiro, versão ligada ao preço inteiro', async () => {
    const t = await tariff([
      model({ prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' }),
    ])(ID);
    expect(t).toMatchObject({ input_nanousd_per_token: 3000, output_nanousd_per_token: 15000 });
    expect(t?.version).toMatch(/^openrouter:[0-9a-f]{16}$/);
    const outro = await tariff([model({ prompt: '0.0000035', completion: '0.000015' })])(ID);
    expect(outro?.version).not.toBe(t?.version);
  });

  it('preço real do Sonnet 4.6: busca e escrita de cache são inalcançáveis pelo gateway', async () => {
    // Objeto `pricing` do catálogo OpenRouter (2026-09-18).
    const sonnet = {
      prompt: '0.000003',
      completion: '0.000015',
      web_search: '0.01',
      input_cache_read: '0.0000003',
      input_cache_write: '0.00000375',
      input_cache_write_1h: '0.000006',
    };
    expect(await tariff([model(sonnet)])(ID)).toMatchObject({
      input_nanousd_per_token: 3000,
      output_nanousd_per_token: 15000,
    });
  });

  it('faixas: vale a maior taxa, qualquer que seja a condição', async () => {
    const t = await tariff([
      model({
        prompt: '0.00000125',
        completion: '0.00001',
        overrides: [
          { min_prompt_tokens: 200000, prompt: '0.0000025', completion: '0.000015' },
          {
            utc_days: [0, 6],
            utc_start: '00:00',
            utc_end: '06:00',
            prompt: '0.000001',
            completion: '0.00002',
          },
        ],
      }),
    ])(ID);
    expect(t).toMatchObject({ input_nanousd_per_token: 2500, output_nanousd_per_token: 20000 });
  });

  it('raciocínio até a taxa de completion é coberto; acima, sem tarifa', async () => {
    const base = { prompt: '0.000002', completion: '0.000006' };
    expect(await tariff([model({ ...base, internal_reasoning: '0.000006' })])(ID)).not.toBeNull();
    expect(await tariff([model({ ...base, internal_reasoning: '0.000007' })])(ID)).toBeNull();
  });

  it.each([
    ['taxa por request', { prompt: '0.000002', completion: '0.000006', request: '0.001' }],
    ['componente desconhecido', { prompt: '0.000002', completion: '0.000006', novidade: '0.1' }],
    [
      'faixa sem completion',
      {
        prompt: '0.000002',
        completion: '0.000006',
        overrides: [{ min_prompt_tokens: 1, prompt: '0.1' }],
      },
    ],
    [
      'faixa com condição desconhecida',
      {
        prompt: '0.000002',
        completion: '0.000006',
        overrides: [{ min_x: 1, prompt: '0.1', completion: '0.1' }],
      },
    ],
    [
      'faixa com taxa por request',
      {
        prompt: '0.000002',
        completion: '0.000006',
        overrides: [{ min_prompt_tokens: 1, prompt: '0.1', completion: '0.1', request: '0.01' }],
      },
    ],
    [
      'overrides fora de forma',
      { prompt: '0.000002', completion: '0.000006', overrides: { a: 1 } },
    ],
  ])('%s: sem tarifa', async (_n, raw) => {
    expect(await tariff([model(raw)])(ID)).toBeNull();
  });

  it('componentes zerados não impedem', async () => {
    const t = await tariff([
      model({ prompt: '0.000002', completion: '0.000006', request: '0', image: '0' }),
    ])(ID);
    expect(t).not.toBeNull();
  });

  it('fallback fixo, sem preço cru ou modelo ausente: sem tarifa', async () => {
    const cru = { prompt: '0.000003', completion: '0.000015' };
    expect(await tariff([model(cru)], true)(ID)).toBeNull();
    expect(await tariff([model()])(ID)).toBeNull();
    expect(await tariff([model(cru)])('outro/modelo')).toBeNull();
  });
});

describe('componentes ignorados só são ignoráveis porque o contrato recusa quem os dispara', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: 'oi' }] };
  const parte = (p: Record<string, unknown>) => ({
    ...base,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }, p] }],
  });
  // Componente → pedido que o geraria. Nenhum pode passar pelo contrato.
  const gatilhos: Record<string, Array<Record<string, unknown>>> = {
    web_search: [
      { ...base, plugins: [{ id: 'web' }] },
      { ...base, web_search_options: {} },
      { ...base, tools: [{ type: 'web_search' }] },
    ],
    input_cache_write: [
      { ...base, cache_control: { type: 'ephemeral' } },
      parte({ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }),
    ],
    input_cache_write_1h: [
      parte({ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }),
    ],
    image: [parte({ type: 'image_url', image_url: { url: 'https://x/y.png' } })],
    audio: [parte({ type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } })],
    input_audio_cache: [
      parte({ type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } }),
    ],
    image_output: [{ ...base, modalities: ['image', 'text'] }],
    audio_output: [
      { ...base, modalities: ['audio', 'text'] },
      { ...base, audio: { voice: 'x' } },
    ],
  };

  it('a lista de ignorados é exatamente estes gatilhos mais a leitura de cache', () => {
    expect([...TARIFF_UNREACHABLE_COMPONENTS].sort()).toEqual(
      [...Object.keys(gatilhos), 'input_cache_read'].sort(),
    );
  });

  it.each(Object.entries(gatilhos))('%s: todo gatilho é recusado', (_c, pedidos) => {
    expect(parseInferenceRequest(base).kind).toBe('ok');
    for (const p of pedidos) expect(parseInferenceRequest(p).kind).toBe('invalid');
  });
});
