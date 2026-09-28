/**
 * P02 (spec §5.2, "segundo seam obrigatório") — `routeExistingEngineRun`.
 *
 * A regra é uma só: run em voo NÃO autoriza reexecutar o pipeline. Os casos
 * abaixo cercam as três formas de errar isso — reexecutar em cima de submissão
 * incerta, reexecutar em cima de resultado pronto, e passar por cima de um run
 * que alguém já mandou parar.
 */
import { describe, it, expect } from 'vitest';
import {
  routeExistingEngineRun,
  decideRouteTurnAction,
} from '@/runtime/engines/route-existing-run.js';
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

/**
 * O desfecho DURÁVEL da rota.
 *
 * O caso que dá nome a este bloco é o do laço: antes, quando a rota recusava o
 * pipeline, o turno ficava no estado do claim — `claimed`/`running`, ambos
 * recuperáveis —, o recovery o rearmava, a rota recusava de novo, e nada
 * contava tentativa. Uma mensagem de cliente girando para sempre sem resposta
 * e sem aparecer em lugar nenhum.
 */
describe('decideRouteTurnAction — nenhuma rota sai sem desfecho', () => {
  it('pipeline segue sendo pipeline', () => {
    expect(decideRouteTurnAction({ kind: 'run_pipeline' })).toEqual({ kind: 'run_pipeline' });
  });

  it('run em voo: retry com contador, não silêncio', () => {
    // Retry NÃO reexecuta o pipeline — na volta, a rota recusa de novo antes
    // dele. O que o retry compra é backoff e tentativa contada, para que a
    // reconciliação tenha janela e o esgotamento tenha fim.
    const acao = decideRouteTurnAction(routeExistingEngineRun(comRun('running')));
    expect(acao).toEqual({ kind: 'retry', code: 'engine_run_in_flight' });
  });

  it('submissão incerta: espera, mas com o código que diz o que houve', () => {
    const acao = decideRouteTurnAction(routeExistingEngineRun(comRun('submitting')));
    expect(acao).toEqual({ kind: 'retry', code: 'engine_run_submission_unknown' });
  });

  it('resultado pronto: espera a adoção em vez de concluir o turno vazio', () => {
    // Concluir aqui apagaria do registro durável um resultado que existe e
    // ninguém entregou.
    const acao = decideRouteTurnAction(routeExistingEngineRun(comRun('result_ready')));
    expect(acao).toEqual({ kind: 'retry', code: 'engine_run_result_ready' });
  });

  it('run bloqueado: dead letter, porque tempo não resolve decisão humana', () => {
    const acao = decideRouteTurnAction(routeExistingEngineRun(comRun('blocked')));
    expect(acao).toEqual({
      kind: 'dead_letter',
      code: 'engine_run_blocked',
      outcome: 'unsafe_to_retry',
    });
  });

  it('`unsafe_to_retry` não afirma efeito: afirma que não dá para descartá-lo', () => {
    // O §5.3.1 proíbe ler ausência de registro como prova de ausência de
    // efeito, e é essa proibição — não um efeito conhecido — que torna o
    // retry inseguro num run que alguém travou com trabalho possivelmente em
    // voo.
    const acao = decideRouteTurnAction(routeExistingEngineRun(comRun('blocked')));
    expect(acao.kind === 'dead_letter' && acao.outcome).toBe('unsafe_to_retry');
  });

  it('`reconcile_run` com motivo blocked cai no lado da pessoa, não no da espera', () => {
    // `routeExistingEngineRun` não constrói esse par, mas o TIPO admite. Um
    // caller novo que o construa não pode cair no ramo do "espera e tenta".
    const acao = decideRouteTurnAction({
      kind: 'reconcile_run',
      pin: PIN,
      run: run('blocked'),
      reason: 'blocked',
    });
    expect(acao).toEqual({
      kind: 'dead_letter',
      code: 'engine_run_blocked',
      outcome: 'unsafe_to_retry',
    });
  });
});
