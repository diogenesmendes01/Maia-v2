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

  /**
   * TESTE INVERTIDO (review adversarial do PR #541, achado 4).
   *
   * A versão anterior deste caso afirmava que TODO passo aceita
   * `failed_retryable` como origem — isto é, ela CRISTALIZAVA o defeito: com o
   * estado sem memória de qual passo falhou, "todo passo é retomável" significa
   * que uma negativa em `start_pairing` autoriza `provision_tenant`,
   * `provision_admin`, `declare_channel` ou `evaluate_readiness`. Passos que
   * rebobinam o estado materializado da saga ou criam recursos adicionais.
   *
   * A asserção foi INVERTIDA, não removida: agora ela prova a propriedade
   * oposta — nenhuma definição declara `failed_retryable`, porque a retomada
   * passou a ser decidida contra o ponto de retomada PERSISTIDO. Se alguém
   * reintroduzir a origem universal numa definição, este caso fica vermelho.
   */
  it('NENHUM passo declara `failed_retryable` como origem — a retomada vem do ponto persistido', () => {
    for (const step of ONBOARDING_STEPS) {
      expect(
        STEP_DEFINITIONS[step].from,
        `'${step}' voltou a aceitar 'failed_retryable' como origem universal`,
      ).not.toContain('failed_retryable');
    }
  });

  it('a partir de `failed_retryable` só o passo que FALHOU (e as remediações dele) é legal', () => {
    // O cenário concreto da review: negativa em `start_pairing`.
    const point = { failed_step: 'start_pairing', resume_state: 'channel_declared' };
    expect(planTransition({ step: 'start_pairing', from: 'failed_retryable', retry_point: point }).to).toBe(
      'pairing_pending',
    );
    for (const step of ['provision_tenant', 'provision_admin', 'declare_channel', 'evaluate_readiness'] as const) {
      try {
        planTransition({ step, from: 'failed_retryable', retry_point: point });
        throw new Error(`'${step}' deveria ser recusado a partir de failed_retryable`);
      } catch (err) {
        expect((err as OnboardingError).code).toBe('invalid_transition');
      }
    }
  });

  it('sem ponto de retomada gravado, `failed_retryable` não autoriza NADA (fail-closed)', () => {
    for (const step of ONBOARDING_STEPS) {
      expect(() => planTransition({ step, from: 'failed_retryable' })).toThrow(OnboardingError);
    }
    expect(allowedStepsFrom('failed_retryable')).toEqual([]);
  });

  it('a remediação declarada é aceita — e só ela', () => {
    // `confirm_channel_ready` falhou (linha não provou posse): refazer o
    // pareamento da MESMA linha é a remediação legal.
    const point = { failed_step: 'confirm_channel_ready', resume_state: 'pairing_pending' };
    expect(planTransition({ step: 'start_pairing', from: 'failed_retryable', retry_point: point }).to).toBe(
      'pairing_pending',
    );
    expect(
      planTransition({ step: 'confirm_channel_ready', from: 'failed_retryable', retry_point: point }).to,
    ).toBe('channel_ready');
    // Declarar OUTRA linha não é remediação — é um segundo canal.
    expect(() =>
      planTransition({ step: 'declare_channel', from: 'failed_retryable', retry_point: point }),
    ).toThrow(OnboardingError);
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

  /**
   * TESTE INVERTIDO (review adversarial do PR #541, achado 4).
   *
   * A versão anterior exigia que `failed_retryable` oferecesse `provision_tenant`
   * E `declare_channel` — ou seja, ela pinava como CORRETO o menu que permite
   * ao operador rebobinar a saga e reprovisionar governança depois de qualquer
   * falha. Como a UI desenha exatamente o que esta função devolve, o teste
   * garantia que o console mostraria esses botões.
   *
   * Invertida: o menu agora é derivado do ponto de retomada, e o que ele NÃO
   * pode conter é justamente o que o caso antigo exigia.
   */
  it('`failed_retryable` oferece SÓ o retry do passo que falhou e as remediações dele', () => {
    const steps = allowedStepsFrom('failed_retryable', {
      failed_step: 'start_pairing',
      resume_state: 'channel_declared',
    });
    expect(steps).toEqual(['start_pairing']);
    expect(steps).not.toContain('provision_tenant');
    expect(steps).not.toContain('declare_channel');
    expect(steps).not.toContain('activate');

    expect(
      allowedStepsFrom('failed_retryable', {
        failed_step: 'confirm_channel_ready',
        resume_state: 'pairing_pending',
      }),
    ).toEqual(['start_pairing', 'confirm_channel_ready']);
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
