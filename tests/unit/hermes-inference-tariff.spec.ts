/**
 * P06 — tarifa versionada a partir do catálogo: só preço BUSCADO vale; a lista
 * fixa de fallback e modelo fora do catálogo não viram teto duro.
 */
import { describe, expect, it } from 'vitest';
import { createCatalogTariff } from '@/integrations/hermes/inference-tariff.js';
import type { OpenRouterModel } from '@/lib/openrouter-models.js';

const SONNET: OpenRouterModel = {
  id: 'anthropic/claude-sonnet-4.6',
  name: 'Sonnet',
  pricing: { prompt_per_million: 3, completion_per_million: 15 },
} as OpenRouterModel;

const tariff = (models: OpenRouterModel[], fallback = false) =>
  createCatalogTariff({ models: async () => ({ models, fallback }) });

describe('createCatalogTariff', () => {
  it('US$/Mtok vira nanousd/token inteiro, com versão ligada ao preço', async () => {
    const t = await tariff([SONNET])('anthropic/claude-sonnet-4.6');
    expect(t).toMatchObject({ input_nanousd_per_token: 3000, output_nanousd_per_token: 15000 });
    expect(t?.version).toMatch(/^openrouter:[0-9a-f]{16}$/);
    const outroPreco = await tariff([
      { ...SONNET, pricing: { prompt_per_million: 3.5, completion_per_million: 15 } },
    ])(SONNET.id);
    expect(outroPreco?.version).not.toBe(t?.version);
    expect(outroPreco?.input_nanousd_per_token).toBe(3500);
  });

  it('fallback fixo, modelo ausente ou preço inválido: sem tarifa', async () => {
    expect(await tariff([SONNET], true)(SONNET.id)).toBeNull();
    expect(await tariff([SONNET])('outro/modelo')).toBeNull();
    expect(
      await tariff([{ ...SONNET, pricing: { prompt_per_million: -1, completion_per_million: 1 } }])(
        SONNET.id,
      ),
    ).toBeNull();
  });
});
