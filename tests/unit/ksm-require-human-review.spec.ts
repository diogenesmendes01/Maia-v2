/**
 * §7.4.1 (extensão NOVA do KSM) — `require_human_review`.
 *
 * O problema que ele resolve: alguns itens exigem revisão por SEMÂNTICA —
 * uma regra, uma memória pessoal — independentemente de o scorer achar o
 * conteúdo inofensivo. Havia duas saídas erradas, e a spec proíbe as duas:
 *
 *  1. **falsificar `risk=high`** para forçar revisão. O risco é lido por
 *     outras coisas, e mentir nele estraga todas elas.
 *  2. **`UPDATE` posterior de `ephemeral` para `pending_review`**. Essa
 *     transição não existe na máquina — forçá-la inventaria uma aresta.
 *
 * O campo faz o KSM decidir certo na PRIMEIRA transição, preservando o
 * resultado real do scorer ao lado.
 */
import { describe, it, expect } from 'vitest';
import { decideInitialStatus } from '@/control-plane/knowledge-state-machine/state-machine.js';

describe('decideInitialStatus — require_human_review', () => {
  it('força pending_review mesmo em risco baixo e confiança alta', () => {
    // Sem o campo, esta combinação nasceria `ephemeral` — visível ao LLM.
    expect(
      decideInitialStatus({
        kind: 'fact',
        risk_level: 'low',
        sensitivity: 'low',
        confidence: 0.95,
      }),
    ).toBe('ephemeral');

    expect(
      decideInitialStatus({
        kind: 'fact',
        risk_level: 'low',
        sensitivity: 'low',
        confidence: 0.95,
        require_human_review: true,
      }),
    ).toBe('pending_review');
  });

  it('vale para memory e behavioral_hint também', () => {
    for (const kind of ['memory', 'behavioral_hint'] as const) {
      expect(
        decideInitialStatus({
          kind,
          risk_level: 'low',
          sensitivity: 'low',
          confidence: 0.9,
          require_human_review: true,
        }),
        kind,
      ).toBe('pending_review');
    }
  });

  it('`false` NÃO força ephemeral — só permite o algoritmo conservador seguir', () => {
    // A spec é explícita: "O caso false apenas permite o algoritmo
    // conservador existente; não força ephemeral em presença de risco ou
    // falha."
    expect(
      decideInitialStatus({
        kind: 'fact',
        risk_level: 'high',
        sensitivity: 'low',
        confidence: 0.99,
        require_human_review: false,
      }),
    ).toBe('pending_review');

    expect(
      decideInitialStatus({
        kind: 'rule',
        risk_level: 'low',
        sensitivity: 'low',
        confidence: 0.99,
        require_human_review: false,
      }),
    ).toBe('pending_review');
  });

  it('ausente, o comportamento é exatamente o de antes', () => {
    for (const risco of ['low', 'medium', 'high', 'critical'] as const) {
      const com = decideInitialStatus({
        kind: 'fact',
        risk_level: risco,
        sensitivity: 'low',
        confidence: 0.8,
      });
      const semCampo = decideInitialStatus({
        kind: 'fact',
        risk_level: risco,
        sensitivity: 'low',
        confidence: 0.8,
        require_human_review: undefined,
      });
      expect(semCampo, risco).toBe(com);
    }
  });
});
