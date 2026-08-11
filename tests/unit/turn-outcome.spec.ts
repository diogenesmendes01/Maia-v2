/**
 * Issue #503 — regra que traduz o resultado do ReAct no destino do turno.
 *
 * Cobre a matriz COMPLETA de `ReActDelivery` (4 exit reasons x dispatched x
 * persistUnknown x sideEffectsCommitted = 32 combinações), porque foi
 * exatamente aqui que a rodada 1 do review encontrou dois defeitos: retry
 * cego a efeito colateral já aplicado, e conclusão falsa de entrega.
 */
import { describe, it, expect } from 'vitest';
import { decideTurnAction } from '@/agent/turn-outcome.js';
import type { ReActDelivery, ReActExitReason } from '@/agent/react-loop.js';

const EXITS: ReActExitReason[] = [
  'reasoner_failed',
  'outbound_failure',
  'empty_final_text',
  'iteration_cap',
];

function delivery(over: Partial<ReActDelivery> = {}): ReActDelivery {
  return {
    dispatched: false,
    exitReason: 'empty_final_text',
    persistUnknown: false,
    sideEffectsCommitted: false,
    ...over,
  };
}

describe('decideTurnAction — resposta entregue', () => {
  it.each(EXITS)('dispatched vence qualquer exitReason (%s) → reply_delivered', (exitReason) => {
    expect(decideTurnAction(delivery({ dispatched: true, exitReason }))).toEqual({
      kind: 'complete',
      outcome: 'reply_delivered',
    });
  });

  it('persistência ambígua NUNCA reenvia: reply_delivery_unknown', () => {
    expect(
      decideTurnAction(delivery({ dispatched: true, persistUnknown: true })),
    ).toEqual({ kind: 'complete', outcome: 'reply_delivery_unknown' });
  });

  it('entregue + efeito colateral continua completed (não vira dead letter)', () => {
    expect(
      decideTurnAction(delivery({ dispatched: true, sideEffectsCommitted: true })),
    ).toEqual({ kind: 'complete', outcome: 'reply_delivered' });
  });
});

describe('decideTurnAction — falha SEM efeito irreversível é retry', () => {
  it.each(['reasoner_failed', 'outbound_failure'] as const)(
    '%s sem side effect → retry (cenários A e B da issue)',
    (exitReason) => {
      expect(decideTurnAction(delivery({ exitReason }))).toEqual({ kind: 'retry', code: exitReason });
    },
  );
});

describe('decideTurnAction — falha COM efeito irreversível não pode voltar à fila', () => {
  it.each(['reasoner_failed', 'outbound_failure'] as const)(
    '%s com side effect → dead_letter/unsafe_to_retry',
    (exitReason) => {
      expect(decideTurnAction(delivery({ exitReason, sideEffectsCommitted: true }))).toEqual({
        kind: 'dead_letter',
        code: exitReason,
        outcome: 'unsafe_to_retry',
      });
    },
  );

  it('o gate é o efeito colateral, não o motivo da saída', () => {
    // Mesmo exitReason, decisões opostas — a única variável é o side effect.
    const safe = decideTurnAction(delivery({ exitReason: 'reasoner_failed' }));
    const unsafe = decideTurnAction(
      delivery({ exitReason: 'reasoner_failed', sideEffectsCommitted: true }),
    );
    expect(safe.kind).toBe('retry');
    expect(unsafe.kind).toBe('dead_letter');
  });
});

describe('decideTurnAction — turno correu até o fim sem resposta', () => {
  it.each(['empty_final_text', 'iteration_cap'] as const)(
    '%s → completed/no_reply_produced, nunca retry',
    (exitReason) => {
      expect(decideTurnAction(delivery({ exitReason }))).toEqual({
        kind: 'complete',
        outcome: 'no_reply_produced',
      });
    },
  );

  it('iteration_cap com efeito colateral continua completed (tools já rodaram por decisão)', () => {
    expect(
      decideTurnAction(delivery({ exitReason: 'iteration_cap', sideEffectsCommitted: true })),
    ).toEqual({ kind: 'complete', outcome: 'no_reply_produced' });
  });
});

describe('decideTurnAction — matriz completa', () => {
  it('nenhuma combinação fica sem decisão, e retry SÓ existe sem side effect', () => {
    let checked = 0;
    for (const exitReason of EXITS) {
      for (const dispatched of [true, false]) {
        for (const persistUnknown of [true, false]) {
          for (const sideEffectsCommitted of [true, false]) {
            checked++;
            const action = decideTurnAction(
              delivery({ dispatched, exitReason, persistUnknown, sideEffectsCommitted }),
            );
            expect(['complete', 'retry', 'dead_letter']).toContain(action.kind);
            // A invariante que protege o usuário de efeito duplicado.
            if (action.kind === 'retry') {
              expect(sideEffectsCommitted, 'retry com side effect committed é proibido').toBe(false);
            }
            // Nada que não chegou ao usuário pode ser `reply_delivered`.
            if (action.kind === 'complete' && action.outcome === 'reply_delivered') {
              expect(dispatched).toBe(true);
            }
          }
        }
      }
    }
    expect(checked).toBe(32);
  });
});
