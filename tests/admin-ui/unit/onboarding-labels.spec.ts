/**
 * Issue #519 §7 — a apresentação não pode ficar para trás da máquina de
 * estados.
 *
 * Um estado ou passo novo no backend sem rótulo aqui apareceria na tela como
 * identificador cru (`readiness_failed`), e o operador não tem por que aprender
 * o vocabulário interno da saga. Este teste amarra os dois lados.
 */
import { describe, it, expect } from 'vitest';
import { ONBOARDING_STATES, ONBOARDING_STEPS } from '@/onboarding/state-machine.js';
import {
  STATE_LABEL,
  STATE_TONE,
  STEP_LABEL,
  WIZARD_STEPS,
} from '@/admin-ui/app/onboarding/_components/labels.js';

describe('issue #519 — rótulos do wizard', () => {
  it('todo estado do backend tem rótulo e tom', () => {
    for (const state of ONBOARDING_STATES) {
      expect(STATE_LABEL[state], `sem rótulo: ${state}`).toBeTruthy();
      expect(STATE_TONE[state], `sem tom: ${state}`).toBeTruthy();
    }
  });

  it('todo passo do backend tem rótulo', () => {
    for (const step of ONBOARDING_STEPS) {
      expect(STEP_LABEL[step], `sem rótulo: ${step}`).toBeTruthy();
    }
  });

  it('o stepper cobre todos os passos executáveis, na ordem canônica', () => {
    expect(WIZARD_STEPS).toEqual(ONBOARDING_STEPS.filter((s) => s !== 'done'));
  });

  it('não inventa rótulo para estado/passo que o backend não conhece', () => {
    const known = new Set<string>(ONBOARDING_STATES);
    for (const key of Object.keys(STATE_LABEL)) {
      expect(known.has(key), `rótulo órfão: ${key}`).toBe(true);
    }
    const knownSteps = new Set<string>(ONBOARDING_STEPS);
    for (const key of Object.keys(STEP_LABEL)) {
      expect(knownSteps.has(key), `rótulo órfão: ${key}`).toBe(true);
    }
  });
});
