/**
 * Issue #631 (fatia B da #506) §Escopo de flag — "uma garantia de durabilidade
 * não pode ficar desligada em produção sem falha explícita".
 *
 * A flag `FEATURE_OUTBOUND_DURABLE_COMMIT` existe como alavanca de rollback,
 * e é exatamente por isso que ela precisa de uma regra: uma flag de
 * durabilidade que possa ser desligada em produção NÃO é um kill switch, é o
 * caminho fail-open com outro nome — o mesmo que a auditoria da #506 encontrou
 * em `src/agent/output-dispatch.ts`.
 *
 * O que estes casos travam:
 *
 *   1. em `production`, desligar a flag é ERRO de BOOT (não aviso);
 *   2. o erro é de escopo `boot`, então ele sobrevive à alavanca de rollback
 *      do próprio contrato (`MAIA_CONFIG_STRICT_BOOT=false`) — senão a
 *      alavanca de emergência viraria, sem querer, a alavanca para desligar a
 *      durabilidade do outbound;
 *   3. fora de produção a alavanca continua existindo (aviso em staging,
 *      silêncio em development), porque um kill switch que não pode ser usado
 *      em lugar nenhum também não é um kill switch;
 *   4. ligada sem a máquina de estados do turno a flag é INERTE, e silêncio
 *      aqui faria o operador acreditar que ligou a durabilidade sem ter ligado.
 */
import { describe, it, expect } from 'vitest';
import { buildFixture } from '@/config/generate.js';
import { validateConfig } from '@/config/validate.js';
import { evaluateCrossFieldRules } from '@/config/rules.js';
import { ENV_CONTRACT } from '@/config/contract.js';
import type { MaiaProfile } from '@/config/metadata.js';

const FLAG = 'FEATURE_OUTBOUND_DURABLE_COMMIT';
const RULE_PROD = 'outbound-commit/production-required';
const RULE_INERTE = 'outbound-commit/requires-state-machine';

function check(profile: MaiaProfile, overrides: Record<string, string | undefined> = {}) {
  return validateConfig({
    env: { ...buildFixture(profile), ...overrides },
    profile,
    allowSyntheticFixtures: true,
  });
}

describe('#631 — a flag do commit transacional não pode ser fail-open', () => {
  it('está declarada no contrato, é do runtime e vale só no boot', () => {
    expect(ENV_CONTRACT).toHaveProperty(FLAG);
    const spec = ENV_CONTRACT[FLAG]!;
    expect(spec.services).toEqual(['runtime']);
    expect(spec.secret).toBe(false);
    expect(spec.restartRequired).toBe(true);
  });

  it('o DEFAULT é ligada — durabilidade não é opt-in', () => {
    // O fixture de produção é gerado a partir do contrato: se o default virasse
    // `false`, uma instalação nova nasceria fail-open e ninguém precisaria
    // desligar nada.
    expect(buildFixture('production')[FLAG]).toBe('true');
    expect(check('production').ok).toBe(true);
  });

  it('desligar em production é ERRO e RECUSA o boot', () => {
    const r = check('production', { [FLAG]: 'false' });
    expect(r.ok).toBe(false);
    const finding = r.errors.find((p) => p.rule === RULE_PROD);
    expect(finding, 'o erro precisa existir').toBeDefined();
    expect(finding!.variable).toBe(FLAG);
    expect(finding!.severity).toBe('error');
    // Não pode sobrar como aviso — um aviso não derruba o boot.
    expect(r.warnings.some((p) => p.rule === RULE_PROD)).toBe(false);
  });

  it('a recusa em production sobrevive à alavanca MAIA_CONFIG_STRICT_BOOT=false', () => {
    // O loader legado (`legacyBootProblems`, src/config/env.ts) só aplica
    // regras de escopo `boot` com severidade `error`. Com escopo `contract`,
    // a alavanca de emergência do contrato desligaria também esta regra.
    const findings = evaluateCrossFieldRules({
      values: { [FLAG]: false },
      raw: {},
      profile: 'production',
      entries: [],
    });
    const boot = findings.filter(
      (f) => f.rule === RULE_PROD && f.scope === 'boot' && f.severity === 'error',
    );
    expect(boot).toHaveLength(1);
  });

  it('em staging desligar continua permitido, como AVISO', () => {
    const r = check('staging', { [FLAG]: 'false' });
    expect(r.warnings.some((p) => p.rule === RULE_PROD)).toBe(true);
    expect(r.errors.some((p) => p.rule === RULE_PROD)).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('em development desligar é silencioso — é o fluxo normal de bisect', () => {
    const r = check('development', { [FLAG]: 'false' });
    expect(r.errors.some((p) => p.rule === RULE_PROD)).toBe(false);
    expect(r.warnings.some((p) => p.rule === RULE_PROD)).toBe(false);
  });

  it('ligada sem FEATURE_TURN_STATE_MACHINE é INERTE, e inerte é erro', () => {
    const findings = evaluateCrossFieldRules({
      values: { [FLAG]: true, FEATURE_TURN_STATE_MACHINE: false },
      raw: {},
      profile: 'development',
      entries: [],
    });
    const inerte = findings.filter((f) => f.rule === RULE_INERTE && f.severity === 'error');
    expect(inerte).toHaveLength(1);
    expect(inerte[0]!.variable).toBe(FLAG);
  });

  it('com a máquina de estados ligada, a combinação normal não gera achado', () => {
    const findings = evaluateCrossFieldRules({
      values: { [FLAG]: true, FEATURE_TURN_STATE_MACHINE: true },
      raw: {},
      profile: 'production',
      entries: [],
    });
    expect(findings.some((f) => f.rule === RULE_INERTE)).toBe(false);
    expect(findings.some((f) => f.rule === RULE_PROD)).toBe(false);
  });
});
