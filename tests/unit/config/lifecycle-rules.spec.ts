/**
 * Issue #512 × #515 — as variáveis de lifecycle no contrato de configuração.
 *
 * O lifecycle controller (readiness role-aware + graceful shutdown) introduziu
 * 11 variáveis. Depois da #515 elas vivem em `ENV_CONTRACT`, e as relações
 * entre elas são REGRAS EXECUTÁVEIS em `src/config/rules.ts` — não comentários
 * no `.env.example`. Esta suíte cobre justamente essas relações: uma
 * configuração que "parece certa" mas desliga uma proteção precisa ser
 * detectada antes do boot, não durante um deploy.
 */
import { describe, it, expect } from 'vitest';
import { buildFixture } from '@/config/generate.js';
import { validateConfig, formatHuman } from '@/config/validate.js';
import { evaluateCrossFieldRules } from '@/config/rules.js';
import { ENV_CONTRACT } from '@/config/contract.js';
import { GROUP_ORDER, MAIA_KEY_PREFIXES } from '@/config/metadata.js';
import type { MaiaProfile } from '@/config/metadata.js';

const LIFECYCLE_VARS = [
  'MAIA_PROCESS_ROLE',
  'SHUTDOWN_GRACE_MS',
  'SHUTDOWN_STEP_TIMEOUT_MS',
  'SHUTDOWN_EXIT_TIMEOUT_MS',
  'SHUTDOWN_FORCED_EXIT_CODE',
  'READINESS_CACHE_MS',
  'READINESS_PROBE_TIMEOUT_MS',
  'READINESS_SCHEMA_CHECK',
  'READINESS_BACKLOG_MAX',
  'READINESS_REQUIRE_WHATSAPP_LIVE',
  'REDIS_CONNECT_TIMEOUT_MS',
] as const;

function envFor(profile: MaiaProfile, overrides: Record<string, string | undefined> = {}) {
  return { ...buildFixture(profile), ...overrides };
}

function check(profile: MaiaProfile, overrides: Record<string, string | undefined> = {}) {
  return validateConfig({
    env: envFor(profile, overrides),
    profile,
    allowSyntheticFixtures: true,
  });
}

describe('contrato — variáveis de lifecycle (#512)', () => {
  it('declara as 11 variáveis do lifecycle', () => {
    for (const name of LIFECYCLE_VARS) {
      expect(ENV_CONTRACT, `${name} não está no contrato`).toHaveProperty(name);
    }
  });

  it('todas são exclusivas do runtime (não vazam para admin-ui/migrator/backup)', () => {
    for (const name of LIFECYCLE_VARS) {
      const spec = ENV_CONTRACT[name];
      expect(spec.services, `${name}`).toEqual(['runtime']);
      expect(spec.secret, `${name} não é credencial`).toBe(false);
      expect(spec.restartRequired, `${name} só vale no boot`).toBe(true);
    }
  });

  it('o grupo `lifecycle` existe em GROUP_ORDER (senão o gerador de docs some com a seção)', () => {
    expect(GROUP_ORDER.some((g) => g.group === 'lifecycle')).toBe(true);
  });

  it('SHUTDOWN_ e READINESS_ são namespaces da Maia, para que um typo seja detectado', () => {
    expect(MAIA_KEY_PREFIXES).toContain('SHUTDOWN_');
    expect(MAIA_KEY_PREFIXES).toContain('READINESS_');
  });

  it('um typo no namespace vira erro de contrato, não knob silencioso', () => {
    const r = check('production', { SHUTDOWN_GRACE_MSS: '30000' });
    expect(r.errors.some((p) => p.rule === 'contract/unknown')).toBe(true);
  });

  it('REDIS_ NÃO é namespace da Maia — provedores gerenciados injetam REDIS_* próprios', () => {
    // Rejeitar REDIS_* desconhecida quebraria o boot em Upstash/Heroku, que
    // injetam suas próprias variáveis nesse prefixo.
    expect(MAIA_KEY_PREFIXES).not.toContain('REDIS_');
  });
});

describe('MAIA_PROCESS_ROLE — contrato de papéis (fail-closed)', () => {
  it('aceita exatamente os cinco papéis declarados', () => {
    for (const role of ['all', 'api', 'worker', 'scheduler', 'session-owner']) {
      const parsed = ENV_CONTRACT.MAIA_PROCESS_ROLE.schema.safeParse(role);
      expect(parsed.success, role).toBe(true);
    }
  });

  it('REJEITA um papel desconhecido — nunca cai num default permissivo', () => {
    for (const bad of ['workers', 'API', 'default', 'todos', '']) {
      expect(ENV_CONTRACT.MAIA_PROCESS_ROLE.schema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('o default é o modo compatível de processo único', () => {
    expect(ENV_CONTRACT.MAIA_PROCESS_ROLE.schema.parse(undefined)).toBe('all');
  });

  it('um papel desconhecido aborta a validação inteira (boot fail-closed)', () => {
    const r = check('production', { MAIA_PROCESS_ROLE: 'workers' });
    expect(r.ok).toBe(false);
  });

  it('um papel != all é AVISADO enquanto a topologia (#513) não está separada', () => {
    const r = check('production', { MAIA_PROCESS_ROLE: 'worker' });
    expect(r.warnings.some((p) => p.rule === 'lifecycle/process-role-not-default')).toBe(true);
    // Aviso, não erro: bloquear impediria o rollout da própria #513.
    expect(r.ok, formatHuman(r)).toBe(true);
  });

  it('all não produz aviso nenhum', () => {
    const r = check('production', { MAIA_PROCESS_ROLE: 'all' });
    expect(r.warnings.some((p) => p.rule === 'lifecycle/process-role-not-default')).toBe(false);
  });
});

describe('regras cruzadas de shutdown', () => {
  it('teto por passo maior que o orçamento total é ERRO', () => {
    const r = check('production', {
      SHUTDOWN_GRACE_MS: '5000',
      SHUTDOWN_STEP_TIMEOUT_MS: '30000',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((p) => p.rule === 'lifecycle/step-timeout-exceeds-grace')).toBe(true);
  });

  it('teto por passo igual ao orçamento é aceito (degenerado, mas coerente)', () => {
    const r = check('production', {
      SHUTDOWN_GRACE_MS: '10000',
      SHUTDOWN_STEP_TIMEOUT_MS: '10000',
    });
    expect(r.errors.some((p) => p.rule === 'lifecycle/step-timeout-exceeds-grace')).toBe(false);
  });

  it('os defaults do contrato são coerentes entre si', () => {
    const r = check('production');
    expect(r.errors.filter((p) => p.rule.startsWith('lifecycle/')), formatHuman(r)).toEqual([]);
    expect(r.warnings.filter((p) => p.rule.startsWith('lifecycle/'))).toEqual([]);
  });
});

describe('regras cruzadas de readiness', () => {
  it('probe mais lento que a janela de cache é AVISO (o cache deixa de proteger)', () => {
    const r = check('production', {
      READINESS_CACHE_MS: '1000',
      READINESS_PROBE_TIMEOUT_MS: '9000',
    });
    expect(r.warnings.some((p) => p.rule === 'lifecycle/probe-timeout-exceeds-cache')).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('cache desligado (0) não dispara a regra — é uma escolha, não um descompasso', () => {
    const r = check('production', {
      READINESS_CACHE_MS: '0',
      READINESS_PROBE_TIMEOUT_MS: '9000',
    });
    expect(r.warnings.some((p) => p.rule === 'lifecycle/probe-timeout-exceeds-cache')).toBe(false);
  });

  // Issue #516 — desde que o /readyz consome `getSchemaReadiness()`, desligar
  // este gate é desligar a única coisa que impede a instância de servir tráfego
  // contra um schema dirty, com checksum divergente, com arquivo de migration
  // ausente ou incompatível. Em production isso deixou de ser aviso.
  it('READINESS_SCHEMA_CHECK=false em production é ERRO e RECUSA o boot', () => {
    const r = check('production', { READINESS_SCHEMA_CHECK: 'false' });
    expect(r.ok).toBe(false);
    const finding = r.errors.find((p) => p.rule === 'lifecycle/schema-check-disabled');
    expect(finding, 'o erro precisa existir').toBeDefined();
    expect(finding!.variable).toBe('READINESS_SCHEMA_CHECK');
    expect(finding!.severity).toBe('error');
    // Não pode sobrar como aviso — um aviso não derruba o boot.
    expect(r.warnings.some((p) => p.rule === 'lifecycle/schema-check-disabled')).toBe(false);
  });

  it('a recusa em production sobrevive à alavanca de rollback MAIA_CONFIG_STRICT_BOOT=false', () => {
    // O loader legado (`legacyBootProblems` em src/config/env.ts) só aplica
    // regras de escopo `boot` com severidade `error`. Se esta regra fosse de
    // escopo `contract`, a alavanca de emergência do contrato viraria, sem
    // querer, a alavanca para desligar o gate de schema em production.
    const findings = evaluateCrossFieldRules({
      values: { READINESS_SCHEMA_CHECK: false },
      raw: {},
      profile: 'production',
      entries: [],
    });
    const boot = findings.filter(
      (f) => f.rule === 'lifecycle/schema-check-disabled' && f.scope === 'boot' && f.severity === 'error',
    );
    expect(boot).toHaveLength(1);
  });

  it('em staging desligar o gate de schema continua permitido, como AVISO', () => {
    const r = check('staging', { READINESS_SCHEMA_CHECK: 'false' });
    expect(r.warnings.some((p) => p.rule === 'lifecycle/schema-check-disabled')).toBe(true);
    expect(r.errors.some((p) => p.rule === 'lifecycle/schema-check-disabled')).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('em development desligar o gate de schema é silencioso (fluxo normal de dev)', () => {
    const r = check('development', { READINESS_SCHEMA_CHECK: 'false' });
    expect(r.warnings.some((p) => p.rule === 'lifecycle/schema-check-disabled')).toBe(false);
    expect(r.errors.some((p) => p.rule === 'lifecycle/schema-check-disabled')).toBe(false);
  });

  it('o gate de schema ligado não avisa nem erra em nenhum profile', () => {
    for (const profile of ['development', 'staging', 'production'] as const) {
      const r = check(profile, { READINESS_SCHEMA_CHECK: 'true' });
      expect(r.warnings.some((p) => p.rule === 'lifecycle/schema-check-disabled')).toBe(false);
      expect(r.errors.some((p) => p.rule === 'lifecycle/schema-check-disabled')).toBe(false);
    }
  });
});
