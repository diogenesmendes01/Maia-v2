/**
 * Sonda sintética (spec §1.3 / review P1-C, aceite unit) — init de boot.
 *   - SEMPRE (independe da flag): carrega o conjunto de canais is_synthetic no
 *     gate do sink (impossibilidade de envio físico sobrevive à flag off);
 *   - flag on + canal exclusivamente sintético ⇒ valida (não lança);
 *   - flag on + canal NÃO sintético ⇒ boot FALHA (throw).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/config/env.js', async (importOriginal) => {
  const actual = (await importOriginal()) as { config: Record<string, unknown> };
  return { config: { ...actual.config } };
});

const h = vi.hoisted(() => ({
  checkChannelSynthetic: vi.fn(),
  listSyntheticChannelIds: vi.fn(async () => [] as string[]),
}));
vi.mock('@/db/repositories/synthetic-probe-repos.js', () => ({
  syntheticProbeRepo: {
    checkChannelSynthetic: h.checkChannelSynthetic,
    listSyntheticChannelIds: h.listSyntheticChannelIds,
  },
}));

import { config } from '@/config/env.js';
import { initSyntheticProbe } from '@/probe/boot-validate.js';
import { isSyntheticChannel, _setSyntheticChannelIdsForTests } from '@/probe/sink-guard.js';

describe('initSyntheticProbe', () => {
  beforeEach(() => {
    _setSyntheticChannelIdsForTests([]);
    h.checkChannelSynthetic.mockReset();
    h.listSyntheticChannelIds.mockReset();
    h.listSyntheticChannelIds.mockResolvedValue([]);
    (config as Record<string, unknown>).MAIA_SYNTHETIC_PROBE = false;
  });

  it('flag off ⇒ carrega o sink SEMPRE, mas não valida o triplete', async () => {
    h.listSyntheticChannelIds.mockResolvedValue(['ch-synth-1']);
    await initSyntheticProbe();
    expect(isSyntheticChannel('ch-synth-1')).toBe(true); // sink flag-independente
    expect(h.checkChannelSynthetic).not.toHaveBeenCalled();
  });

  it('flag on + canal exclusivamente sintético ⇒ valida sem lançar', async () => {
    (config as Record<string, unknown>).MAIA_SYNTHETIC_PROBE = true;
    h.listSyntheticChannelIds.mockResolvedValue(['ch-synth-1']);
    h.checkChannelSynthetic.mockResolvedValue({ ok: true });
    await expect(initSyntheticProbe()).resolves.toBeUndefined();
    expect(isSyntheticChannel('ch-synth-1')).toBe(true);
  });

  it('flag on + canal NÃO sintético ⇒ boot FALHA', async () => {
    (config as Record<string, unknown>).MAIA_SYNTHETIC_PROBE = true;
    h.checkChannelSynthetic.mockResolvedValue({ ok: false, reason: 'not_synthetic' });
    await expect(initSyntheticProbe()).rejects.toThrow(/not_synthetic|não é exclusivamente sintético/);
  });
});
