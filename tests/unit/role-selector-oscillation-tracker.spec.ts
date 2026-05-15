/**
 * P6 Task 7 — oscillation-tracker tests.
 *
 * Cenários (mock leve do repo countSwitchesInConversation):
 *  1. conversa_id vazio → não bloqueia (no history).
 *  2. count < max → não bloqueia.
 *  3. count = max → bloqueia (limite inclusivo).
 *  4. count > max → bloqueia.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { countSwitchesMock } = vi.hoisted(() => ({
  countSwitchesMock: vi.fn<[conversa_id: string], Promise<number>>(),
}));

vi.mock('@/db/repositories.js', () => ({
  roleSelectorDecisionsRepo: {
    countSwitchesInConversation: countSwitchesMock,
  },
}));

import { shouldBlockSwitchByOscillation } from '@/cognition/role-selector/oscillation-tracker.js';

beforeEach(() => {
  countSwitchesMock.mockReset();
});

describe('shouldBlockSwitchByOscillation', () => {
  it('conversa_id vazio → não bloqueia, current_switches=0, sem chamar repo', async () => {
    const out = await shouldBlockSwitchByOscillation({ conversa_id: '', max_switches: 3 });
    expect(out).toEqual({ blocked: false, current_switches: 0 });
    expect(countSwitchesMock).not.toHaveBeenCalled();
  });

  it('count < max → não bloqueia', async () => {
    countSwitchesMock.mockResolvedValueOnce(1);
    const out = await shouldBlockSwitchByOscillation({ conversa_id: 'conv-1', max_switches: 3 });
    expect(out).toEqual({ blocked: false, current_switches: 1 });
    expect(countSwitchesMock).toHaveBeenCalledWith('conv-1');
  });

  it('count = max → bloqueia (limite inclusivo)', async () => {
    countSwitchesMock.mockResolvedValueOnce(3);
    const out = await shouldBlockSwitchByOscillation({ conversa_id: 'conv-1', max_switches: 3 });
    expect(out).toEqual({ blocked: true, current_switches: 3 });
  });

  it('count > max → bloqueia', async () => {
    countSwitchesMock.mockResolvedValueOnce(5);
    const out = await shouldBlockSwitchByOscillation({ conversa_id: 'conv-1', max_switches: 3 });
    expect(out).toEqual({ blocked: true, current_switches: 5 });
  });
});
