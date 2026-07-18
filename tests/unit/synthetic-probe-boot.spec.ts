/**
 * Sonda sintética (spec §1.3, aceite unit) — validação FAIL-FAST de boot.
 *   - flag off ⇒ no-op, sink NÃO armado, DB não consultado;
 *   - flag on + canal exclusivamente sintético ⇒ arma o sink;
 *   - flag on + canal NÃO sintético (ou primary/ausente) ⇒ boot FALHA (throw),
 *     sink NÃO armado (nunca silencia um recurso real).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// config mutável: espelha o real e permite flipar MAIA_SYNTHETIC_PROBE por caso.
vi.mock('@/config/env.js', async (importOriginal) => {
  const actual = (await importOriginal()) as { config: Record<string, unknown> };
  return { config: { ...actual.config } };
});

const h = vi.hoisted(() => ({ checkChannelSynthetic: vi.fn() }));
vi.mock('@/db/repositories/synthetic-probe-repos.js', () => ({
  syntheticProbeRepo: { checkChannelSynthetic: h.checkChannelSynthetic },
}));

import { config } from '@/config/env.js';
import { validateAndArmSyntheticProbe } from '@/probe/boot-validate.js';
import { isProbeSinkArmed, _setProbeSinkArmedForTests } from '@/probe/sink-guard.js';

describe('validateAndArmSyntheticProbe', () => {
  beforeEach(() => {
    _setProbeSinkArmedForTests(false);
    h.checkChannelSynthetic.mockReset();
    (config as Record<string, unknown>).MAIA_SYNTHETIC_PROBE = false;
  });

  it('flag off ⇒ no-op: não arma, não consulta o DB', async () => {
    await validateAndArmSyntheticProbe();
    expect(isProbeSinkArmed()).toBe(false);
    expect(h.checkChannelSynthetic).not.toHaveBeenCalled();
  });

  it('flag on + canal exclusivamente sintético ⇒ arma o sink', async () => {
    (config as Record<string, unknown>).MAIA_SYNTHETIC_PROBE = true;
    h.checkChannelSynthetic.mockResolvedValue({ ok: true });
    await validateAndArmSyntheticProbe();
    expect(isProbeSinkArmed()).toBe(true);
  });

  it('flag on + canal NÃO sintético ⇒ boot FALHA e NÃO arma', async () => {
    (config as Record<string, unknown>).MAIA_SYNTHETIC_PROBE = true;
    h.checkChannelSynthetic.mockResolvedValue({ ok: false, reason: 'not_synthetic' });
    await expect(validateAndArmSyntheticProbe()).rejects.toThrow(/not_synthetic|não é exclusivamente sintético/);
    expect(isProbeSinkArmed()).toBe(false);
  });

  it('flag on + canal ausente ⇒ boot FALHA', async () => {
    (config as Record<string, unknown>).MAIA_SYNTHETIC_PROBE = true;
    h.checkChannelSynthetic.mockResolvedValue({ ok: false, reason: 'not_found' });
    await expect(validateAndArmSyntheticProbe()).rejects.toThrow();
    expect(isProbeSinkArmed()).toBe(false);
  });
});
