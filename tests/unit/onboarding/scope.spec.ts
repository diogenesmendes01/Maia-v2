/**
 * Issue #519 — o guard fail-closed de escopo de provisionamento.
 *
 * A regra que este arquivo protege é a mais fácil de regredir do repo inteiro:
 * o wizard recebe `tenant_id`/`agent_id` como PAYLOAD, antes de qualquer ALS,
 * então a rejeição do literal `'default'` feita em `tenant-context.ts` não
 * cobre este caminho. Um wizard que aceitasse `{tenant_id:'default'}` no corpo
 * provisionaria no bucket legado sem nunca passar por um getter do ALS.
 */
import { describe, it, expect } from 'vitest';
import {
  assertAgentScope,
  assertProvisioningScope,
  assertTenantScope,
  isValidProvisioningScope,
  FORBIDDEN_SCOPE_LITERALS,
} from '../../../src/onboarding/scope.js';
import { OnboardingError } from '../../../src/onboarding/errors.js';

describe('assertProvisioningScope — fail-closed', () => {
  it('aceita um par válido', () => {
    expect(() =>
      assertProvisioningScope({ tenant_id: 'acme', agent_id: 'acme-suporte' }),
    ).not.toThrow();
  });

  it("aceita 'primary' — é um tenant ORDINÁRIO, não um sentinel proibido", () => {
    // Regressão deliberada: `primary` é o home single-tenant da #323 e
    // re-onboardá-lo é uma operação legítima. Confundir os dois sentinels
    // quebraria o wizard exatamente na instalação mais comum.
    expect(() =>
      assertProvisioningScope({ tenant_id: 'primary', agent_id: 'primary' }),
    ).not.toThrow();
  });

  it.each(FORBIDDEN_SCOPE_LITERALS)("rejeita o literal reservado '%s' no tenant", (literal) => {
    try {
      assertProvisioningScope({ tenant_id: literal, agent_id: 'ok-agent' });
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(OnboardingError);
      expect((err as OnboardingError).code).toBe('forbidden_scope_literal');
    }
  });

  it.each(FORBIDDEN_SCOPE_LITERALS)("rejeita o literal reservado '%s' no agente", (literal) => {
    try {
      assertProvisioningScope({ tenant_id: 'acme', agent_id: literal });
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect((err as OnboardingError).code).toBe('forbidden_scope_literal');
    }
  });

  it.each([
    ['string vazia', ''],
    ['whitespace-only', '   '],
    ['whitespace nas bordas', ' acme '],
    ['maiúscula', 'Acme'],
    ['dois-pontos (colidiria em chave de cache)', 'acme:1'],
    ['curto demais', 'a'],
    ['começa com hífen', '-acme'],
  ])('rejeita %s', (_label, value) => {
    expect(() => assertProvisioningScope({ tenant_id: value, agent_id: 'ok-agent' })).toThrow(
      OnboardingError,
    );
  });

  it.each([null, undefined, 42, {}, []])('rejeita não-string (%p)', (value) => {
    expect(() => assertProvisioningScope({ tenant_id: value, agent_id: 'ok-agent' })).toThrow(
      OnboardingError,
    );
  });

  it('assertTenantScope e assertAgentScope aplicam as mesmas regras', () => {
    expect(() => assertTenantScope('default')).toThrow(OnboardingError);
    expect(() => assertAgentScope('system')).toThrow(OnboardingError);
    expect(() => assertTenantScope('acme')).not.toThrow();
    expect(() => assertAgentScope('acme-bot')).not.toThrow();
  });

  it('isValidProvisioningScope não lança e reflete o guard', () => {
    expect(isValidProvisioningScope({ tenant_id: 'acme', agent_id: 'bot' })).toBe(true);
    expect(isValidProvisioningScope({ tenant_id: 'default', agent_id: 'bot' })).toBe(false);
    expect(isValidProvisioningScope({ tenant_id: 'acme', agent_id: '' })).toBe(false);
  });
});
