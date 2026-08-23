/**
 * Decisão 13 (issue #519) — o grupo `onboarding` no contrato de configuração.
 *
 * As variáveis do domínio de onboarding moravam em grupos de outros domínios
 * (`ONBOARDING_EXPIRER_BATCH_LIMIT` estava em `governance`, entre TTLs de
 * aprovação dupla e de modo auditoria). O grupo é o que ordena as seções do
 * `.env.example` e de `docs/configuration.md` e o que vira `x-maia-group` no
 * `env-schema.json`: enquanto a chave do expirer estava em `governance`, o
 * operador que procurava "onde configuro o onboarding" lia uma seção de
 * limites financeiros.
 *
 * ISTO É REAGRUPAMENTO, NÃO REDESENHO. O bloco "semântica intacta" abaixo é o
 * que separa os dois: default, `services`, `requiredIn`, `secret`,
 * `restartRequired`, `example` e `fixture` são fixados aqui exatamente com os
 * valores que a chave tinha em `governance`. Uma mudança de comportamento
 * disfarçada de mudança de grupo reprova neste arquivo.
 */
import { describe, it, expect } from 'vitest';
import { CONTRACT_ENTRIES, ENV_CONTRACT, findSpec } from '@/config/contract.js';
import { GROUP_ORDER } from '@/config/metadata.js';

/** Comparado como string: o literal ainda não pertence a `ConfigGroup` no RED. */
const ONBOARDING = 'onboarding';

describe('decisão 13 — grupo `onboarding`', () => {
  it('o grupo existe uma única vez em GROUP_ORDER, com título', () => {
    const hits = GROUP_ORDER.filter((g) => String(g.group) === ONBOARDING);
    expect(hits.map((g) => g.group), 'GROUP_ORDER não declara o grupo `onboarding`').toHaveLength(
      1,
    );
    expect(hits[0]!.title.length).toBeGreaterThan(3);
  });

  it('`ONBOARDING_EXPIRER_BATCH_LIMIT` mora no grupo `onboarding`', () => {
    expect(String(findSpec('ONBOARDING_EXPIRER_BATCH_LIMIT')?.group)).toBe(ONBOARDING);
  });

  it('nenhuma chave `ONBOARDING_*` ficou para trás em outro grupo', () => {
    // Guarda direcional: uma chave nova do domínio que nascer em `governance`
    // (o grupo de onde estas saíram) reprova aqui, não seis meses depois.
    const strays = CONTRACT_ENTRIES.filter(
      (s) => s.name.startsWith('ONBOARDING_') && String(s.group) !== ONBOARDING,
    ).map((s) => `${s.name} → ${s.group}`);
    expect(strays, `chaves do domínio fora do grupo: ${strays.join(', ')}`).toEqual([]);
  });

  it('o grupo `onboarding` não recolheu chave de outro domínio', () => {
    // A direção oposta: reagrupar não pode virar "mover o que estiver por
    // perto". Só entra no grupo o que o expirer/saga de fato consomem.
    const members = CONTRACT_ENTRIES.filter((s) => String(s.group) === ONBOARDING).map(
      (s) => s.name,
    );
    expect(members.sort()).toEqual(['ONBOARDING_EXPIRER_BATCH_LIMIT']);
  });

  describe('semântica intacta — reagrupamento, não redesenho', () => {
    const spec = ENV_CONTRACT.ONBOARDING_EXPIRER_BATCH_LIMIT;

    it('o default continua 100', () => {
      expect(spec.schema.parse(undefined)).toBe(100);
    });

    it('`services`, `requiredIn`, `secret` e `restartRequired` não mudaram', () => {
      expect(spec.services).toEqual(['runtime']);
      expect((spec as { requiredIn?: unknown }).requiredIn).toBeUndefined();
      expect(spec.secret).toBe(false);
      expect(spec.restartRequired).toBe(true);
    });

    it('`example` e `fixture` não mudaram', () => {
      expect(spec.example).toBe('100');
      expect(spec.fixture).toBe('100');
    });
  });
});
