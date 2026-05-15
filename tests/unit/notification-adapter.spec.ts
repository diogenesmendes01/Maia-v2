/**
 * P5 Task 10 — notification adapter para gaps de capacidade.
 *
 * Critério de aceitação #1 do P5 (§9): "Gap em nível SILENT não notifica owner".
 * Os testes cobrem os 4 níveis garantindo:
 *   - silent      -> channel='none', notified=false
 *   - dashboard   -> channel='dashboard', notified=true
 *   - mentionable -> channel='dashboard', notified=true
 *   - proposed    -> channel='dashboard_plus_queue', runCognitiveModule chamado
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GapLevel } from '@/types/enums.js';
import type { AgentCapabilityGap } from '@/db/schema.js';

// Mock the cognitive runner so we can assert that PROPOSED enqueues.
const runCognitiveModuleMock = vi.fn(async (_opts, fn: () => Promise<unknown>) => {
  const output = await fn();
  return { output, status: 'success', fallback_triggered: false, latency_ms: 1 };
});
vi.mock('@/cognition/runner.js', () => ({
  runCognitiveModule: runCognitiveModuleMock,
}));

// Mock logger to avoid noisy output (and let us verify info() emission).
const loggerInfoMock = vi.fn();
vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: loggerInfoMock,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeGap(level: GapLevel, overrides: Partial<AgentCapabilityGap> = {}): AgentCapabilityGap {
  const now = new Date();
  return {
    id: 'gap-1',
    tenant_id: 'default',
    agent_id: 'default',
    capability_description: 'enviar boleto bancário',
    tipo: 'tool',
    contexto: null,
    frequency_score: 3,
    severity_score: 4,
    current_level: level,
    source_candidate_id: null,
    last_observed: now,
    last_level_change_at: now,
    created_at: now,
    ...overrides,
  } as AgentCapabilityGap;
}

describe('notifyOwnerForGap — mapa de níveis -> canais', () => {
  beforeEach(() => {
    runCognitiveModuleMock.mockClear();
    loggerInfoMock.mockClear();
  });

  it('SILENT → channel="none", notified=false (gate #7 — JAMAIS notifica)', async () => {
    const { notifyOwnerForGap } = await import('@/agent/notification-adapter.js');
    const out = await notifyOwnerForGap({ gap: makeGap(GapLevel.SILENT) });
    expect(out.channel).toBe('none');
    expect(out.notified).toBe(false);
    // Nenhum side-effect: nem runCognitiveModule nem logger.info.
    expect(runCognitiveModuleMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).not.toHaveBeenCalled();
  });

  it('DASHBOARD → channel="dashboard", notified=true (sem queue)', async () => {
    const { notifyOwnerForGap } = await import('@/agent/notification-adapter.js');
    const out = await notifyOwnerForGap({ gap: makeGap(GapLevel.DASHBOARD) });
    expect(out.channel).toBe('dashboard');
    expect(out.notified).toBe(true);
    expect(runCognitiveModuleMock).not.toHaveBeenCalled();
  });

  it('MENTIONABLE → channel="dashboard", notified=true (sem queue; mention vem do prompt)', async () => {
    const { notifyOwnerForGap } = await import('@/agent/notification-adapter.js');
    const out = await notifyOwnerForGap({ gap: makeGap(GapLevel.MENTIONABLE) });
    expect(out.channel).toBe('dashboard');
    expect(out.notified).toBe(true);
    expect(runCognitiveModuleMock).not.toHaveBeenCalled();
  });

  it('PROPOSED → channel="dashboard_plus_queue", notified=true, runCognitiveModule chamado com name correto', async () => {
    const { notifyOwnerForGap } = await import('@/agent/notification-adapter.js');
    const gap = makeGap(GapLevel.PROPOSED, {
      id: 'gap-prop-42',
      capability_description: 'pagar fornecedor via PIX',
      frequency_score: 7,
      severity_score: 6,
    });
    const out = await notifyOwnerForGap({ gap });
    expect(out.channel).toBe('dashboard_plus_queue');
    expect(out.notified).toBe(true);
    expect(runCognitiveModuleMock).toHaveBeenCalledTimes(1);
    const [opts] = runCognitiveModuleMock.mock.calls[0]!;
    expect(opts.name).toBe('owner_notification_proposed');
    expect(opts.triggered_by).toBe('async_event');
    // Verificar que o log foi emitido com o payload esperado.
    expect(loggerInfoMock).toHaveBeenCalledTimes(1);
    const [meta, msg] = loggerInfoMock.mock.calls[0]!;
    expect(meta).toMatchObject({
      gap_id: 'gap-prop-42',
      capability_description: 'pagar fornecedor via PIX',
      frequency_score: 7,
      severity_score: 6,
    });
    expect(msg).toBe('owner_notification.queued_for_proposed_gap');
  });
});
