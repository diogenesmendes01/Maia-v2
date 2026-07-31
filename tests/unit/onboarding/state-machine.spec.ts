/**
 * Issue #519 §3 — a máquina de estados da saga.
 *
 * O que estes testes travam:
 *   - fail-closed: nenhum par (estado, passo) fora da tabela é aceito;
 *   - salto de etapa devolve negação TIPADA, nunca avanço silencioso;
 *   - repetir um passo já concluído é RETRY (permitido), não erro — é o
 *     caminho do retry após timeout;
 *   - `readiness_failed` reabre os passos de configuração (o "erro corrigível"
 *     do plano de testes), mas NÃO reabre a ativação;
 *   - run terminal não aceita mais nada;
 *   - o progresso nunca "volta" numa falha.
 */
import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_STATES,
  ONBOARDING_STEPS,
  ONBOARDING_ERROR_CODES,
  OnboardingError,
  allowedSteps,
  denialToError,
  isTerminal,
  planTransition,
  progressOf,
  type OnboardingState,
  type OnboardingStep,
} from '@/onboarding/state-machine.js';

const KIND = 'tenant_onboarding' as const;

describe('issue #519 — máquina de estados do onboarding', () => {
  it('percorre o caminho feliz inteiro, do zero até `active`', () => {
    const sequence: Array<[OnboardingStep, OnboardingState]> = [
      ['tenant', 'tenant_ready'],
      ['admin', 'admin_ready'],
      ['agent', 'agent_draft'],
      ['profile', 'profile_ready'],
      ['capabilities', 'capabilities_ready'],
      ['role', 'policy_ready'],
      ['channel', 'channel_declared'],
      ['pairing', 'pairing_pending'],
      ['readiness', 'ready_for_activation'],
      ['activation', 'active'],
    ];

    let state: OnboardingState = 'created';
    for (const [step, expected] of sequence) {
      const plan = planTransition({ kind: KIND, state, step });
      expect(plan.ok, `${state} + ${step}`).toBe(true);
      if (!plan.ok) return;
      expect(plan.to).toBe(expected);
      state = plan.to;
    }
    expect(state).toBe('active');
    expect(isTerminal(state)).toBe(true);
  });

  it('recusa salto de etapa com razão tipada', () => {
    const plan = planTransition({ kind: KIND, state: 'created', step: 'activation' });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('step_out_of_order');
    expect(denialToError(plan)).toBeInstanceOf(OnboardingError);
    expect(denialToError(plan).code).toBe('step_out_of_order');
  });

  it('NUNCA permite ativar sem passar por uma avaliação de prontidão verde', () => {
    // Este é o gate fail-closed da issue. Só `ready_for_activation` habilita
    // `activation`; se algum dia alguém adicionar `channel_ready` ou
    // `readiness_failed` à lista, este teste quebra.
    const canActivateFrom = ONBOARDING_STATES.filter(
      (state) => planTransition({ kind: KIND, state, step: 'activation' }).ok,
    );
    expect(canActivateFrom).toEqual(['ready_for_activation']);
  });

  it('trata a repetição de um passo já concluído como retry, não como erro', () => {
    // O cliente não recebeu a resposta (timeout de rede) e repete. A run já
    // avançou; recusar aqui transformaria um retry legítimo em erro e forçaria
    // o operador a adivinhar se o recurso foi criado.
    const plan = planTransition({ kind: KIND, state: 'agent_draft', step: 'agent' });
    expect(plan.ok).toBe(true);
  });

  it('reabre os passos de configuração após `readiness_failed`, mas não a ativação', () => {
    const reopenable: OnboardingStep[] = [
      'profile',
      'capabilities',
      'role',
      'channel',
      'pairing',
      'readiness',
    ];
    for (const step of reopenable) {
      expect(planTransition({ kind: KIND, state: 'readiness_failed', step }).ok, step).toBe(true);
    }
    expect(planTransition({ kind: KIND, state: 'readiness_failed', step: 'activation' }).ok).toBe(
      false,
    );
  });

  it('recusa qualquer passo numa run terminal', () => {
    for (const state of ['active', 'cancelled', 'failed_terminal'] as const) {
      for (const step of ONBOARDING_STEPS) {
        const plan = planTransition({ kind: KIND, state, step });
        expect(plan.ok, `${state}+${step}`).toBe(false);
        if (!plan.ok && step !== 'done') expect(plan.reason).toBe('run_terminal');
      }
    }
  });

  it('`done` não é um passo executável', () => {
    for (const state of ONBOARDING_STATES) {
      expect(planTransition({ kind: KIND, state, step: 'done' }).ok).toBe(false);
    }
  });

  it('allowedSteps é exatamente o conjunto que planTransition aceita', () => {
    for (const state of ONBOARDING_STATES) {
      const allowed = allowedSteps({ kind: KIND, state });
      for (const step of ONBOARDING_STEPS) {
        expect(allowed.includes(step)).toBe(planTransition({ kind: KIND, state, step }).ok);
      }
    }
  });

  it('o progresso é monotônico no caminho feliz e não regride numa falha de prontidão', () => {
    expect(progressOf('created')).toBe(0);
    expect(progressOf('active')).toBe(1);
    expect(progressOf('tenant_ready')).toBeGreaterThan(progressOf('created'));
    expect(progressOf('ready_for_activation')).toBeGreaterThan(progressOf('channel_ready'));
    // Uma falha de prontidão não pode fazer a barra "voltar" e sugerir que o
    // que já foi provisionado se perdeu.
    expect(progressOf('readiness_failed')).toBe(progressOf('channel_ready'));
  });

  it('todo código de erro é um identificador estável em snake_case', () => {
    for (const code of ONBOARDING_ERROR_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(new Set(ONBOARDING_ERROR_CODES).size).toBe(ONBOARDING_ERROR_CODES.length);
  });

  it('marca como não-repetível o que o operador não pode consertar repetindo', () => {
    const plan = planTransition({ kind: KIND, state: 'active', step: 'profile' });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(denialToError(plan).retryable).toBe(false);
  });
});
