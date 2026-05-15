import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeConfidence, daysSinceLastFailure } from '@/cognition/self-model.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

// Mock capabilitiesDomainRepo para capturar mudanças de estado sem DB.
// O `state` faz papel da tabela; cada teste limpa em beforeEach.
const state: Record<string, any> = {};

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    capabilitiesDomainRepo: {
      findByDomain: vi.fn(async (domain: string) => state[domain] ?? null),
      upsertConfidence: vi.fn(async (domain: string, updates: any) => {
        state[domain] = { ...state[domain], ...updates, domain };
      }),
      listAll: vi.fn(async () => Object.values(state)),
    },
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => {}),
      recentByModule: vi.fn(async () => []),
    },
  };
});

import { recordSuccess, recordFailure } from '@/cognition/capability-tracker.js';

describe('P2 self-model integration', () => {
  beforeEach(() => {
    for (const k of Object.keys(state)) delete state[k];
    vi.clearAllMocks();
  });

  it('10 sucessos consecutivos → confidence sobe pra > 0.8', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        for (let i = 0; i < 10; i++) {
          await recordSuccess({ domain: 'comercial' });
        }
        const final = state['comercial'];
        expect(final.success_count).toBe(10);
        expect(final.failure_count).toBe(0);
        // Confidence é persistida como string (numeric(4,3)) — converte
        // para number antes da asserção.
        const c = Number(final.confidence);
        expect(c).toBeGreaterThan(0.8);
      },
    );
  });

  it('5 sucessos + 5 falhas → confidence cai com failure recente', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        for (let i = 0; i < 5; i++) await recordSuccess({ domain: 'mix' });
        for (let i = 0; i < 5; i++) {
          await recordFailure({ domain: 'mix', failure_mode: 'test' });
        }
        const final = state['mix'];
        expect(final.success_count).toBe(5);
        expect(final.failure_count).toBe(5);
        // Failure recente (days=0) → recency_factor próximo de 0.
        // success_rate=0.5, maturity≈1 (10 evidences) → confidence muito baixa.
        const c = Number(final.confidence);
        expect(c).toBeLessThan(0.5);
      },
    );
  });

  it('failure_modes acumula até 50 entries (cap)', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        for (let i = 0; i < 60; i++) {
          await recordFailure({ domain: 'noisy', failure_mode: `mode-${i}` });
        }
        const final = state['noisy'];
        expect(final.failure_count).toBe(60);
        expect((final.failure_modes as string[]).length).toBeLessThanOrEqual(50);
        // Mais recente preservado, mais antigos truncados.
        expect((final.failure_modes as string[]).at(-1)).toBe('mode-59');
      },
    );
  });

  it('zero evidence → confidence 0 (fórmula determinística)', () => {
    const c = computeConfidence({
      success_count: 0,
      failure_count: 0,
      evidence_count: 0,
      days_since_last_failure: 0,
    });
    expect(c).toBe(0);
  });

  it('daysSinceLastFailure retorna número grande pra "nunca falhou"', () => {
    const days = daysSinceLastFailure(null);
    expect(days).toBeGreaterThanOrEqual(365);
  });
});
