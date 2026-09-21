/**
 * P02 (spec §5.2, "segundo seam obrigatório") — `routeExistingEngineRun`.
 *
 * A regra é uma só: run em voo NÃO autoriza reexecutar o pipeline. Os casos
 * abaixo cercam as três formas de errar isso — reexecutar em cima de submissão
 * incerta, reexecutar em cima de resultado pronto, e passar por cima de um run
 * que alguém já mandou parar.
 */
import { describe, it, expect } from 'vitest';
import { routeExistingEngineRun } from '@/runtime/engines/route-existing-run.js';
import type { EngineRunSnapshot, TurnEngineState } from '@/db/repositories/engine-repos.js';
import type { EngineRunPhaseV1 } from '@/runtime/engines/contracts.js';

const PIN = {
  engine: 'hermes',
  adapter_revision: 'r1',
  configuration_digest: 'd1',
};

function run(phase: EngineRunPhaseV1): EngineRunSnapshot {
  return {
    id: 'run-1',
    phase,
    generation_no: 1,
    row_version: 1,
    submit_count: 1,
    remote_run_id: null,
    request_key: 'rk-1',
  };
}

const comRun = (phase: EngineRunPhaseV1): TurnEngineState => ({
  kind: 'open_run',
  pin: PIN,
  run: run(phase),
});

describe('routeExistingEngineRun — run em voo não autoriza reexecutar', () => {
  it('sem binding, o pipeline roda normalmente', () => {
    expect(routeExistingEngineRun({ kind: 'no_binding' })).toEqual({ kind: 'run_pipeline' });
  });

  it('binding sem run aberto libera o pipeline: não há run para duplicar', () => {
    expect(routeExistingEngineRun({ kind: 'binding_without_open_run', pin: PIN })).toEqual({
      kind: 'run_pipeline',
    });
  });

  it('submissão incerta NUNCA reexecuta — ausência de registro não é prova', () => {
    for (const phase of ['submitting', 'submission_unknown'] as const) {
      const rota = routeExistingEngineRun(comRun(phase));
      expect(rota.kind).toBe('reconcile_run');
      expect(rota.kind === 'reconcile_run' && rota.reason).toBe('submission_unknown');
    }
  });

  it('run em voo vai para reconciliação, não para o pipeline', () => {
    for (const phase of ['prepared', 'running', 'cancelling', 'reconciling'] as const) {
      const rota = routeExistingEngineRun(comRun(phase));
      expect(rota.kind).toBe('reconcile_run');
      expect(rota.kind === 'reconcile_run' && rota.reason).toBe('in_flight');
    }
  });

  it('resultado pronto é para adotar, não para refazer', () => {
    const rota = routeExistingEngineRun(comRun('result_ready'));
    expect(rota.kind).toBe('reconcile_run');
    expect(rota.kind === 'reconcile_run' && rota.reason).toBe('result_ready');
  });

  it('run bloqueado espera gente: reconciliar seria passar por cima da decisão', () => {
    const rota = routeExistingEngineRun(comRun('blocked'));
    expect(rota.kind).toBe('await_operator');
  });

  it('fase desconhecida cai no lado seguro, não no pipeline', () => {
    // O `closed` não chega pela consulta (ela filtra fases abertas), então ele
    // serve aqui de representante de "fase que este build não sabe tratar". O
    // ponto do caso é que o default NÃO é reexecutar.
    const rota = routeExistingEngineRun(comRun('closed'));
    expect(rota.kind).toBe('reconcile_run');
    expect(rota.kind === 'reconcile_run' && rota.reason).toBe('submission_unknown');
  });
});
