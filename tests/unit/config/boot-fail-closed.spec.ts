/**
 * Issue #515, PR #522 review round 1 [P1] on `src/config/env.ts` — the BOOT
 * fails closed on contract violations, in EVERY profile.
 *
 * The bug the reviewer found: the boot only applied `scope: 'boot'` rules, so
 * with `MAIA_ENV=production` a stale `FEATURE_MULTI_CHANNEL=true` came up
 * silently — the operator believed a gate was active that had been deleted in
 * PR #411. The owner's decision was to go further than the review asked and
 * enforce it in `development` too: a `.env` that boots on a laptop and dies in
 * staging is exactly the drift this issue exists to remove.
 *
 * This spec boots the REAL `src/config/env.ts` against a controlled
 * `process.env`, so it covers the loader, not just the validator.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// Hermetic: never let a developer's local `.env` leak into these assertions.
vi.mock('dotenv/config', () => ({}));

/** Minimum environment that boots clean under the `development` profile. */
const BASE: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://maia_boot:bootspec1234@localhost:5432/maia_boot',
  POSTGRES_USER: 'maia_boot',
  POSTGRES_PASSWORD: 'bootspec1234',
  POSTGRES_DB: 'maia_boot',
  REDIS_URL: 'redis://localhost:6379',
  ANTHROPIC_API_KEY: 'sk-ant-boot-spec-key',
  VOYAGE_API_KEY: 'voyage-boot-spec-key',
  WHATSAPP_NUMBER_MAIA: '+5500000000000',
  OWNER_TELEFONE_WHATSAPP: '+5511111111111',
  OWNER_NOME: 'Boot Spec Owner',
  ALERT_CHANNELS: 'log',
};

const ORIGINAL = { ...process.env };

function setEnv(next: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) process.env[key] = value;
  }
}

/** Import the REAL loader with a controlled environment. */
async function boot(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  setEnv({ ...BASE, ...overrides });
  return import('@/config/env.js');
}

/** Boot and return the thrown message (empty string when it booted fine). */
async function bootError(overrides: Record<string, string | undefined>): Promise<string> {
  try {
    await boot(overrides);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  setEnv(ORIGINAL);
  vi.resetModules();
});

describe('boot — configuração válida (#515)', () => {
  it('sobe e expõe o config tipado', async () => {
    const mod = await boot();
    expect(mod.config.POSTGRES_DB).toBe('maia_boot');
    expect(mod.config.LLM_PROVIDER).toBe('anthropic');
    expect(mod.config.ALERT_CHANNELS).toEqual(['log']);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('boot — fail-closed em TODOS os profiles (#515)', () => {
  it('TOMBSTONE: FEATURE_MULTI_CHANNEL=true aborta o boot em development', async () => {
    const message = await bootError({ FEATURE_MULTI_CHANNEL: 'true' });
    expect(message, 'o boot precisa abortar').not.toBe('');
    // variável + regra + remediação acionável
    expect(message).toContain('FEATURE_MULTI_CHANNEL');
    expect(message).toContain('contract/removed');
    expect(message).toContain('PR #411');
    expect(message).toContain('Remova FEATURE_MULTI_CHANNEL do ambiente');
    // e o profile em que falhou
    expect(message).toContain('profile development');
  });

  it('DESCONHECIDA: MAIA_TOTALLY_MADE_UP=1 aborta o boot em development', async () => {
    const message = await bootError({ MAIA_TOTALLY_MADE_UP: '1' });
    expect(message).toContain('MAIA_TOTALLY_MADE_UP');
    expect(message).toContain('contract/unknown');
    expect(message).toContain('digitação');
    expect(message).toContain('config:generate');
  });

  it('CONTRADIÇÃO: NODE_ENV=development × MAIA_ENV=production aborta o boot', async () => {
    const message = await bootError({ NODE_ENV: 'development', MAIA_ENV: 'production' });
    expect(message).toContain('profile/node-env-contradiction');
    expect(message).toContain('MAIA_ENV=production');
    expect(message).toContain('NODE_ENV=development');
    // A remediação explica que NODE_ENV não é o profile.
    expect(message).toContain('NODE_ENV controla apenas as otimizações');
  });

  it('cada um dos 5 tombstones registrados aborta o boot', async () => {
    const { TOMBSTONES } = await import('@/config/contract.js');
    expect(TOMBSTONES.length).toBe(5);
    for (const tombstone of TOMBSTONES) {
      const message = await bootError({ [tombstone.name]: 'true' });
      expect(message, `${tombstone.name} deveria abortar o boot`).toContain(tombstone.name);
      expect(message).toContain(tombstone.removedIn);
    }
  });

  it('o tombstone com substituta aponta para ela (mensagem acionável)', async () => {
    const message = await bootError({ APROVAR_MENSAGENS_PROATIVAS: 'true' });
    expect(message).toContain('O gate real hoje é FEATURE_PROACTIVE_MESSAGES');
  });

  it('reporta TODOS os problemas de uma vez, não um por restart', async () => {
    const message = await bootError({
      FEATURE_MULTI_CHANNEL: 'true',
      MAIA_TOTALLY_MADE_UP: '1',
      MAIA_OUTRA_INVENTADA: '1',
    });
    expect(message).toContain('FEATURE_MULTI_CHANNEL');
    expect(message).toContain('MAIA_TOTALLY_MADE_UP');
    expect(message).toContain('MAIA_OUTRA_INVENTADA');
    expect(message).toMatch(/^Invalid configuration: 3 problema\(s\)/);
  });

  it('a mensagem de erro NUNCA contém o valor de um segredo', async () => {
    const CANARY = 'sk-ant-CANARY-boot-do-not-leak';
    const message = await bootError({
      ANTHROPIC_API_KEY: CANARY,
      POSTGRES_PASSWORD: CANARY,
      FEATURE_MULTI_CHANNEL: 'true',
    });
    expect(message).not.toBe('');
    expect(message.includes(CANARY)).toBe(false);
  });

  it('aponta o comando que inspeciona o ambiente inteiro', async () => {
    const message = await bootError({ MAIA_TOTALLY_MADE_UP: '1' });
    expect(message).toContain('npm run config:check');
  });

  it('variáveis de terceiros (CLAUDE_*, ANTHROPIC_BASE_URL) não abortam o boot', async () => {
    // Uma máquina com o Claude Code instalado carrega ~18 CLAUDE_*. Se esse
    // namespace fosse reivindicado, `npm run dev` e a suíte inteira quebrariam.
    const mod = await boot({
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_PID: '4242',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    expect(mod.config.POSTGRES_DB).toBe('maia_boot');
  });
});

describe('boot — rollback documentado: MAIA_CONFIG_STRICT_BOOT=false (#515)', () => {
  it('destrava um ambiente com tombstone e chave desconhecida', async () => {
    const mod = await boot({
      MAIA_CONFIG_STRICT_BOOT: 'false',
      FEATURE_MULTI_CHANNEL: 'true',
      MAIA_TOTALLY_MADE_UP: '1',
    });
    expect(mod.config.POSTGRES_DB).toBe('maia_boot');
  });

  it('avisa alto que a garantia está desligada (escape hatch não pode ser silencioso)', async () => {
    await boot({ MAIA_CONFIG_STRICT_BOOT: 'false' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warning = String(warnSpy.mock.calls[0]?.[0]);
    expect(warning).toContain('MAIA_CONFIG_STRICT_BOOT=false');
    expect(warning).toContain('DESLIGADA');
    expect(warning).toContain('docs/runbooks/config-contract.md');
  });

  it('NÃO desliga as regras de boot legadas (a mensagem histórica é preservada)', async () => {
    const message = await bootError({
      MAIA_CONFIG_STRICT_BOOT: 'false',
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: undefined,
    });
    expect(message).toContain('ANTHROPIC_API_KEY required when LLM_PROVIDER=anthropic');
  });

  it('NÃO desliga o schema Zod (variável obrigatória ausente continua fatal)', async () => {
    const message = await bootError({
      MAIA_CONFIG_STRICT_BOOT: 'false',
      DATABASE_URL: undefined,
    });
    expect(message).toContain('DATABASE_URL');
  });

  it('a mensagem de falha ensina o rollback', async () => {
    const message = await bootError({ MAIA_TOTALLY_MADE_UP: '1' });
    expect(message).toContain('MAIA_CONFIG_STRICT_BOOT=false');
    expect(message).toContain('docs/runbooks/config-contract.md');
  });

  it('MAIA_CONFIG_STRICT_BOOT está declarada no contrato (não é chave desconhecida)', async () => {
    const { findSpec } = await import('@/config/contract.js');
    const spec = findSpec('MAIA_CONFIG_STRICT_BOOT');
    expect(spec).toBeDefined();
    expect(spec!.description).toContain('ROLLBACK DE EMERGÊNCIA');
    expect(spec!.description).toContain('docs/runbooks/config-contract.md');
  });
});
