/**
 * Issue #519 §3 — a máquina de estados. É a defesa que impede o
 * PROVISIONAMENTO DUPLICADO quando o retry vem com uma idempotency key
 * DIFERENTE (o ledger só cobre a mesma chave), e a que impede "saltos não
 * autorizados" até a ativação.
 */
import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_STATES,
  ONBOARDING_STEPS,
  STEP_DEFINITIONS,
  TERMINAL_STATES,
  allowedStepsFrom,
  getStepDefinition,
  isTerminalState,
  planCancellation,
  planTransition,
  type OnboardingState,
} from '../../../src/onboarding/state-machine.js';
import { OnboardingError } from '../../../src/onboarding/errors.js';

/** O caminho feliz completo, na ordem: (passo, estado de origem). */
const HAPPY_PATH: Array<[string, OnboardingState]> = [
  ['provision_tenant', 'created'],
  ['provision_admin', 'tenant_ready'],
  ['provision_agent', 'admin_ready'],
  ['configure_profile', 'agent_draft'],
  ['apply_capability_packs', 'profile_ready'],
  ['configure_role', 'capabilities_ready'],
  ['declare_channel', 'policy_ready'],
  ['start_pairing', 'channel_declared'],
  ['confirm_channel_ready', 'pairing_pending'],
  ['evaluate_readiness', 'channel_ready'],
  ['activate', 'ready_for_activation'],
];

describe('planTransition — caminho feliz', () => {
  it('encadeia os onze passos até `active`', () => {
    let state: OnboardingState = 'created';
    for (const [step, expectedFrom] of HAPPY_PATH) {
      expect(state).toBe(expectedFrom);
      state = planTransition({ step, from: state }).to;
    }
    expect(state).toBe('active');
  });
});

describe('planTransition — saltos não autorizados', () => {
  it('nenhum passo alcança `active` sem passar por `ready_for_activation`', () => {
    // A única definição cujo destino é `active` é `activate`, e a única origem
    // dela (fora de `activating`, que é a retomada de um crash) é
    // `ready_for_activation`. Prova estrutural, não por enumeração de casos.
    const toActive = ONBOARDING_STEPS.filter((s) => STEP_DEFINITIONS[s].to === 'active');
    expect(toActive).toEqual(['activate']);
    expect(STEP_DEFINITIONS.activate.from).toEqual(['ready_for_activation', 'activating']);
  });

  it('recusa ativar direto de `agent_draft`', () => {
    try {
      planTransition({ step: 'activate', from: 'agent_draft' });
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect((err as OnboardingError).code).toBe('invalid_transition');
    }
  });

  it('recusa pular a declaração do canal', () => {
    expect(() => planTransition({ step: 'confirm_channel_ready', from: 'policy_ready' })).toThrow(
      OnboardingError,
    );
  });

  it('recusa reexecutar um passo NÃO repetível a partir do próprio destino — o anti-duplo-provisionamento', () => {
    // Este é o cenário do double-click com DUAS chaves de idempotência
    // diferentes: o primeiro commit já moveu a run para `tenant_ready`, e o
    // segundo comando não é mais legal.
    expect(() => planTransition({ step: 'provision_tenant', from: 'tenant_ready' })).toThrow(
      OnboardingError,
    );
    expect(() => planTransition({ step: 'provision_agent', from: 'agent_draft' })).toThrow(
      OnboardingError,
    );
    expect(() => planTransition({ step: 'declare_channel', from: 'channel_declared' })).toThrow(
      OnboardingError,
    );
  });

  it('permite reexecutar os passos REPETÍVEIS (observação, não provisionamento)', () => {
    expect(planTransition({ step: 'start_pairing', from: 'pairing_pending' }).to).toBe(
      'pairing_pending',
    );
    expect(planTransition({ step: 'confirm_channel_ready', from: 'channel_ready' }).to).toBe(
      'channel_ready',
    );
    expect(planTransition({ step: 'evaluate_readiness', from: 'readiness_failed' }).to).toBe(
      'ready_for_activation',
    );
  });

  it('todo passo pode ser retomado a partir de `failed_retryable`', () => {
    for (const step of ONBOARDING_STEPS) {
      if (step === 'activate') continue; // ativação nunca parte de uma falha genérica
      expect(STEP_DEFINITIONS[step].from).toContain('failed_retryable');
    }
  });

  it('passo desconhecido é erro tipado', () => {
    try {
      getStepDefinition('drop_database');
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect((err as OnboardingError).code).toBe('unknown_step');
    }
  });
});

describe('estados terminais', () => {
  it.each(TERMINAL_STATES)("nenhum comando parte de '%s'", (state) => {
    expect(isTerminalState(state)).toBe(true);
    expect(allowedStepsFrom(state)).toEqual([]);
    try {
      planTransition({ step: 'evaluate_readiness', from: state });
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect((err as OnboardingError).code).toBe('run_terminal');
    }
  });

  it('run cancelada não é retomada implicitamente', () => {
    expect(() => planTransition({ step: 'activate', from: 'cancelled' })).toThrow(OnboardingError);
    expect(() => planCancellation('cancelled')).toThrow(OnboardingError);
  });

  it('cancelamento é legal a partir de qualquer estado vivo, inclusive `activating`', () => {
    for (const state of ONBOARDING_STATES) {
      if (TERMINAL_STATES.includes(state)) continue;
      expect(planCancellation(state)).toEqual({ from: state, to: 'cancelled' });
    }
  });
});

describe('allowedStepsFrom — o que a UI pode desenhar', () => {
  it('devolve exatamente os passos cuja definição aceita o estado', () => {
    expect(allowedStepsFrom('created')).toEqual(['provision_tenant']);
    expect(allowedStepsFrom('channel_ready')).toEqual(['confirm_channel_ready', 'evaluate_readiness']);
    expect(allowedStepsFrom('ready_for_activation')).toEqual(['evaluate_readiness', 'activate']);
  });

  it('`failed_retryable` oferece todo passo retomável', () => {
    const steps = allowedStepsFrom('failed_retryable');
    expect(steps).toContain('provision_tenant');
    expect(steps).toContain('declare_channel');
    expect(steps).not.toContain('activate');
  });
});

describe('integridade do contrato', () => {
  it('todo destino e toda origem declarados são estados válidos', () => {
    for (const step of ONBOARDING_STEPS) {
      const def = STEP_DEFINITIONS[step];
      expect(ONBOARDING_STATES).toContain(def.to);
      for (const from of def.from) expect(ONBOARDING_STATES).toContain(from);
      if (def.onDeny) expect(ONBOARDING_STATES).toContain(def.onDeny);
    }
  });

  it('nenhum passo parte de um estado terminal', () => {
    for (const step of ONBOARDING_STEPS) {
      for (const from of STEP_DEFINITIONS[step].from) {
        expect(TERMINAL_STATES).not.toContain(from);
      }
    }
  });
});
