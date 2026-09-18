/**
 * P06 — tarifa versionada a partir do catálogo: só preço BUSCADO e INTEIRO
 * vale, convertido da string decimal com arredondamento para cima.
 */
import { describe, expect, it } from 'vitest';
import {
  createCatalogTariff,
  nanousdPerTokenCeil,
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

  it.each([
    [
      'preço em faixas',
      { prompt: '0.000002', completion: '0.000006', overrides: [{ min: 200000 }] },
    ],
    ['taxa por request', { prompt: '0.000002', completion: '0.000006', request: '0.001' }],
    [
      'raciocínio cobrado à parte',
      { prompt: '0.000002', completion: '0.000006', internal_reasoning: '0.00001' },
    ],
    [
      'escrita de cache',
      { prompt: '0.000002', completion: '0.000006', input_cache_write: '0.0000025' },
    ],
  ])('%s: sem tarifa (duas taxas subcontariam)', async (_n, raw) => {
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
