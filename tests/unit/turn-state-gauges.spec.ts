/**
 * Issue #503 — gauges `maia_turns_current{status}` e
 * `maia_turn_state_age_seconds{status}`.
 *
 * O que importa provar: as séries existem no scrape, o snapshot é
 * COMPARTILHADO (um scrape = uma query, não uma por série), falha do banco não
 * derruba `/metrics`, e a flag off não toca o banco.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const snapshotLiveTurnStates = vi.fn();
const flags = {
  FEATURE_TURN_STATE_MACHINE: true,
  FEATURE_TURN_STATE_AUTHORITATIVE: false,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
};

vi.mock('@/config/env.js', () => ({ config: flags }));
vi.mock('@/db/repositories/turn-repos.js', () => ({
  agentTurnsRepo: { snapshotLiveTurnStates },
}));

const { registerTurnStateGauges, _resetTurnStateCollectorForTests } = await import(
  '@/observability/turn-state-collector.js'
);
const { renderPrometheus, _resetForTests } = await import('@/lib/metrics.js');

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  _resetTurnStateCollectorForTests();
  flags.FEATURE_TURN_STATE_MACHINE = true;
  snapshotLiveTurnStates.mockResolvedValue([
    { status: 'running', total: 3, oldest_age_seconds: 42 },
    { status: 'retryable', total: 1, oldest_age_seconds: 900 },
  ]);
});

describe('gauges da máquina de estados do turno', () => {
  it('expõe contagem e idade por estado VIVO', async () => {
    registerTurnStateGauges();
    const out = await renderPrometheus();
    expect(out).toContain('maia_turns_current{status="running"} 3');
    expect(out).toContain('maia_turn_state_age_seconds{status="running"} 42');
    expect(out).toContain('maia_turns_current{status="retryable"} 1');
    expect(out).toContain('maia_turn_state_age_seconds{status="retryable"} 900');
  });

  it('estado vivo sem turnos aparece como 0 (ausência de série seria ambígua)', async () => {
    registerTurnStateGauges();
    const out = await renderPrometheus();
    expect(out).toContain('maia_turns_current{status="queued"} 0');
    expect(out).toContain('maia_turn_state_age_seconds{status="queued"} 0');
  });

  it('NÃO expõe estados terminais (volume histórico, não sinal de saúde)', async () => {
    registerTurnStateGauges();
    const out = await renderPrometheus();
    for (const terminal of ['completed', 'ignored', 'superseded', 'dead_letter']) {
      expect(out).not.toContain(`maia_turns_current{status="${terminal}"}`);
    }
  });

  it('um scrape faz UMA query, não uma por série', async () => {
    registerTurnStateGauges();
    await renderPrometheus();
    expect(snapshotLiveTurnStates).toHaveBeenCalledTimes(1);
  });

  it('scrapes dentro da janela do snapshot não repetem a query', async () => {
    registerTurnStateGauges();
    await renderPrometheus();
    await renderPrometheus();
    await renderPrometheus();
    expect(snapshotLiveTurnStates).toHaveBeenCalledTimes(1);
  });

  it('falha do banco não derruba /metrics — mantém o último snapshot', async () => {
    registerTurnStateGauges();
    await renderPrometheus();
    expect(snapshotLiveTurnStates).toHaveBeenCalledTimes(1);

    // Expira a janela e faz a próxima leitura falhar.
    _resetTurnStateCollectorForTests();
    registerTurnStateGauges();
    snapshotLiveTurnStates.mockRejectedValue(new Error('DB down'));
    const out = await renderPrometheus();
    expect(out).toContain('maia_turns_current{status="running"} 0');
  });

  it('flag OFF: séries presentes em 0, sem tocar o banco', async () => {
    flags.FEATURE_TURN_STATE_MACHINE = false;
    registerTurnStateGauges();
    const out = await renderPrometheus();
    expect(out).toContain('maia_turns_current{status="running"} 0');
    expect(snapshotLiveTurnStates).not.toHaveBeenCalled();
  });

  it('registrar duas vezes é idempotente', async () => {
    registerTurnStateGauges();
    registerTurnStateGauges();
    const out = await renderPrometheus();
    const occurrences = out.split('\n').filter((l) => l.startsWith('maia_turns_current{status="running"}'));
    expect(occurrences).toHaveLength(1);
  });
});
