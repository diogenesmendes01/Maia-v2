/**
 * O BOOT do console valida o subset `admin-ui` — issue #596.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que este arquivo passa por `register()`, e não por `loadAdminConfig()`
 * ─────────────────────────────────────────────────────────────────────────
 * A armadilha desta issue é escrever um teste que chame `loadAdminConfig()`
 * direto. Ele fica VERDE mesmo que o boot do console nunca a chame — que era
 * exatamente o estado anterior: a função existia, ninguém a chamava, e o
 * container subia sem sign-in configurado.
 *
 * Então o sujeito aqui é `register()` de `src/admin-ui/instrumentation.ts`: a
 * função que o Next.js AWAITA em `BaseServer.prepare()` antes de servir o
 * primeiro request (`next/dist/server/lib/router-utils/instrumentation-globals.external.js`
 * → `registerInstrumentation` → `await instrumentation.register()`, com o erro
 * re-lançado). É a função de produção, no arquivo de produção. Apagar a
 * chamada a `assertAdminBootConfig()` de dentro dela reprova este arquivo.
 *
 * O que NÃO é medido aqui é o Next chamando `register()` — isso é o
 * framework. O que amarra o arquivo ao lugar onde o Next o procura (raiz do
 * projeto Next, nome `instrumentation`, extensão coberta por `pageExtensions`)
 * é o último `describe`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O ambiente medido
 * ─────────────────────────────────────────────────────────────────────────
 * `ADMIN_PROD_ENV` é um `.env.admin` de produção COMPLETO e SEM NENHUMA
 * variável exclusivamente `runtime` — em particular sem as seis `BACKUP_*`.
 * Antes da #596 o console não subia com ele: importava `src/config/env.ts`,
 * que valida o subset `runtime` inteiro. O primeiro caso deste arquivo é essa
 * prova, e ele reprova se alguém reintroduzir o import.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CONTRACT_ENTRIES, TOMBSTONES } from '@/config/contract.js';
import { register } from '@/admin-ui/instrumentation.js';

/** Um `.env.admin` de produção que satisfaz o subset `admin-ui` e nada além. */
const ADMIN_PROD_ENV: Readonly<Record<string, string>> = {
  // Injetadas pelo compose (`environment:`), não pelo `.env.admin`.
  NODE_ENV: 'production',
  MAIA_ENV: 'production',
  DATABASE_URL: 'postgres://maia:f4kepassw0rd@postgres:5432/maia',
  AUTH_TRUST_HOST: 'true',
  TZ: 'America/Sao_Paulo',
  // O `.env.admin` propriamente dito.
  NEXTAUTH_URL: 'https://admin.example.com',
  NEXTAUTH_SECRET: 'nao-e-segredo-nextauth-de-fixture-de-teste',
  OIDC_ISSUER: 'https://login.example.com/realms/maia',
  OIDC_CLIENT_ID: 'maia-admin',
  OIDC_CLIENT_SECRET: 'nao-e-segredo-oidc-de-fixture-de-teste',
  OIDC_TENANT_SLUGS: 'primary',
  RUNTIME_TRACE_HMAC_MASTER_SECRET: 'nao-e-segredo-hmac-de-fixture-de-teste',
  // O Next seta esta variável no processo do servidor; `register()` só valida
  // no runtime `nodejs` (o bundle edge não alcança o contrato).
  NEXT_RUNTIME: 'nodejs',
};

/** As seis que a #572 foi obrigada a pôr no `.env.admin`, e a #596 tirou. */
const SEIS_BACKUP = [
  'BACKUP_S3_BUCKET',
  'BACKUP_S3_ACCESS_KEY',
  'BACKUP_S3_SECRET_KEY',
  'BACKUP_ENCRYPTION_MODE',
  'BACKUP_ENCRYPTION_KEYRING',
  'BACKUP_ENCRYPTION_ACTIVE_KEY_ID',
] as const;

const CONTRACT_NAMES = CONTRACT_ENTRIES.map((s) => s.name);
const TOMBSTONE_NAMES = TOMBSTONES.map((t) => t.name);

let saved: NodeJS.ProcessEnv;

/**
 * Troca o ambiente do processo pelo `env` dado, apagando ANTES toda variável
 * que o validador olha (contrato, tombstones e o namespace `MAIA_*`/`FEATURE_*`
 * inteiro). Sem isso, uma variável do ambiente de quem roda os testes entraria
 * na medição e o veredito deixaria de ser sobre o `.env.admin` do caso.
 */
function useEnv(env: Readonly<Record<string, string>>): void {
  for (const key of [...CONTRACT_NAMES, ...TOMBSTONE_NAMES]) delete process.env[key];
  for (const key of Object.keys(process.env)) {
    if (/^(MAIA_|FEATURE_)/.test(key)) delete process.env[key];
  }
  delete process.env.NEXT_RUNTIME;
  Object.assign(process.env, env);
}

/** Uma cópia de `ADMIN_PROD_ENV` sem as chaves dadas. */
function semAs(...keys: readonly string[]): Record<string, string> {
  const out = { ...ADMIN_PROD_ENV };
  for (const k of keys) delete out[k];
  return out;
}

beforeEach(() => {
  saved = { ...process.env };
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe('boot do admin-ui — nenhuma variável exclusivamente `runtime` (#596)', () => {
  it('sobe com um .env.admin de produção SEM nenhuma das seis BACKUP_*', async () => {
    useEnv(ADMIN_PROD_ENV);
    // Guarda do próprio caso: se alguma BACKUP_* vazou para o ambiente, a
    // afirmação abaixo deixaria de significar o que diz.
    expect(SEIS_BACKUP.filter((k) => process.env[k] !== undefined)).toEqual([]);
    await expect(register()).resolves.toBeUndefined();
  });

  it('nenhuma variável EXCLUSIVA do subset `runtime` está presente neste ambiente', () => {
    // O contrafactual do caso acima em forma de inventário: prova que o verde
    // não veio de o ambiente trazer, por acidente, meio subset `runtime`.
    const admin = new Set(
      CONTRACT_ENTRIES.filter((s) => s.services.includes('admin-ui')).map((s) => s.name),
    );
    const exclusivasDeRuntime = CONTRACT_ENTRIES.filter(
      (s) => s.services.includes('runtime') && !admin.has(s.name),
    ).map((s) => s.name);
    expect(
      exclusivasDeRuntime.filter((k) => k in ADMIN_PROD_ENV),
      'O .env.admin desta spec voltou a carregar variável que só o runtime declara.',
    ).toEqual([]);
    // E a lista não é vazia — senão o caso acima seria vacuamente verdadeiro.
    expect(exclusivasDeRuntime.length).toBeGreaterThan(100);
    expect(exclusivasDeRuntime).toEqual(expect.arrayContaining([...SEIS_BACKUP]));
  });
});

describe('boot do admin-ui — fail-closed no sign-in (#596)', () => {
  it('as quatro OIDC_* ausentes REPROVAM o boot em production', async () => {
    useEnv(semAs('OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_TENANT_SLUGS'));
    // Antes da #596 este `register()` resolvia e o console entregava a tela
    // "no providers configured" — sem erro de boot, sem alerta.
    const err = await register().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err, 'o boot aceitou um console SEM provider de sign-in').not.toBeNull();
    const message = err!.message;
    for (const name of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_TENANT_SLUGS']) {
      expect(message, `a mensagem de boot não nomeia ${name}`).toContain(name);
    }
    expect(message).toContain('profile/required');
  });

  it.each(['default', 'primary,default', ' default '])(
    'OIDC_TENANT_SLUGS=%p REPROVA o boot — o slug vira tenant_id (AGENTS.md §4)',
    async (slugs) => {
      useEnv({ ...ADMIN_PROD_ENV, OIDC_TENANT_SLUGS: slugs });
      const err = await register().then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err, `o boot aceitou OIDC_TENANT_SLUGS=${slugs}`).not.toBeNull();
      expect(err!.message).toContain('admin-ui/tenant-slugs-default-literal');
    },
  );

  it('NEXTAUTH_SECRET curto REPROVA o boot pelo gate PRÓPRIO do console', async () => {
    // O contrato pede `min(8)`; `resolveSecret()` exige 32. O gate real rodava
    // só quando `./lib/auth.ts` fosse carregado — no primeiro request.
    useEnv({ ...ADMIN_PROD_ENV, NEXTAUTH_SECRET: 'curto-mas-passa-no-contrato' });
    await expect(register()).rejects.toThrow(/NEXTAUTH_SECRET/);
  });

  it('NEXTAUTH_SECRET com placeholder conhecido REPROVA o boot', async () => {
    useEnv({
      ...ADMIN_PROD_ENV,
      NEXTAUTH_SECRET: '__SET_ME__rotate_with_openssl_rand_base64_48_before_first_boot',
    });
    await expect(register()).rejects.toThrow(/NEXTAUTH_SECRET/);
  });

  it('MAIA_ENV=staging tem a mesma postura fail-closed que production', async () => {
    useEnv({
      ...semAs('OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_TENANT_SLUGS'),
      MAIA_ENV: 'staging',
      NODE_ENV: 'production',
    });
    await expect(register()).rejects.toThrow(/OIDC_ISSUER/);
  });

  it('no runtime EDGE `register()` não valida nada (o contrato é código de Node)', async () => {
    useEnv({ ...semAs('OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_TENANT_SLUGS'), NEXT_RUNTIME: 'edge' });
    await expect(register()).resolves.toBeUndefined();
  });
});

describe('o hook está onde o Next.js o procura', () => {
  it('`instrumentation.ts` mora na raiz do projeto Next e casa com pageExtensions', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const root = resolve(__dirname, '../../../src/admin-ui');
    expect(
      existsSync(resolve(root, 'instrumentation.ts')),
      'O Next só carrega `instrumentation.<ext>` na raiz do projeto (ou em `src/`). ' +
        'Movido dali, o boot volta a ser permissivo — e em silêncio.',
    ).toBe(true);
    // `pageExtensions` do next.config.mjs governa a detecção do hook
    // (build/index.js: `instrumentationHookDetectionRegExp`).
    const nextConfig = readFileSync(resolve(root, 'next.config.mjs'), 'utf8');
    expect(nextConfig).toMatch(/pageExtensions:\s*\[[^\]]*'ts'/);
  });

  it('o `import()` do contrato está DENTRO de um `NEXT_RUNTIME === \'nodejs\'` positivo', async () => {
    // Lock textual, e a razão de ele existir é que a falha que ele previne só
    // aparece em `next build` — que não roda nesta suíte.
    //
    // `middleware.ts` faz o Next compilar TAMBÉM um `edge-instrumentation.js`.
    // `NEXT_RUNTIME` é constante de DefinePlugin: na forma positiva
    // (`=== 'nodejs'`) a condição dobra para `false` no bundle edge e o webpack
    // elimina o ramo com o `import()` junto. Escrita como guard invertido
    // (`!== 'nodejs'` → `return`), a eliminação NÃO acontece — o webpack segue o
    // `import()`, tenta empacotar `@/config/*` para o edge e o build morre com
    // `UnhandledSchemeError: Reading from "node:path"`.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(__dirname, '../../../src/admin-ui/instrumentation.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const bloco = /if\s*\(\s*process\.env\.NEXT_RUNTIME\s*===\s*'nodejs'\s*\)\s*\{([\s\S]*?)\n {2}\}/.exec(src);
    expect(bloco, 'o guard positivo de NEXT_RUNTIME sumiu de instrumentation.ts').not.toBeNull();
    expect(bloco![1]).toContain("await import('./lib/boot-config.js')");
    expect(bloco![1]).toContain('assertAdminBootConfig()');
    // E nenhum import ESTÁTICO do contrato no arquivo — ele iria para os dois
    // bundles, e o edge não sabe ler `node:`.
    expect(src).not.toMatch(/^\s*import\s.*from\s*'[^']*(config|boot-config)[^']*'/m);
  });
});

describe('o .env.admin.prod.example REAL sobe o console (#596)', () => {
  /**
   * O caso anterior mede um `.env.admin` escrito nesta spec. Este mede o
   * ARQUIVO que o runbook manda copiar (`docs/runbooks/deploy-prod.md` §1:
   * `cp .env.admin.prod.example .env.admin`), mais o `environment:` que o
   * compose injeta e os `__SET_ME__` que o exemplo deixa ao operador. É a
   * diferença entre "existe um .env.admin que sobe" e "o que o runbook manda
   * fazer sobe".
   */
  const OPERADOR_PREENCHE: Readonly<Record<string, string>> = {
    NEXTAUTH_SECRET: 'nao-e-segredo-nextauth-de-fixture-de-teste',
    OIDC_ISSUER: 'https://login.example.com/realms/maia',
    OIDC_CLIENT_ID: 'maia-admin',
    OIDC_CLIENT_SECRET: 'nao-e-segredo-oidc-de-fixture-de-teste',
    OIDC_TENANT_SLUGS: 'primary',
    RUNTIME_TRACE_HMAC_MASTER_SECRET: 'nao-e-segredo-hmac-de-fixture-de-teste',
  };

  /** O que `compose.prod.yml` injeta no `environment:` do serviço `admin-ui`. */
  const DO_COMPOSE: Readonly<Record<string, string>> = {
    NODE_ENV: 'production',
    MAIA_ENV: 'production',
    DATABASE_URL: 'postgres://maia:f4kepassw0rd@postgres:5432/maia',
    REDIS_URL: 'redis://:f4keredispass@redis:6379',
    POSTGRES_USER: 'maia',
    POSTGRES_PASSWORD: 'f4kepassw0rd',
    POSTGRES_DB: 'maia',
    AUTH_TRUST_HOST: 'true',
    TZ: 'America/Sao_Paulo',
  };

  it('cp + preencher os __SET_ME__ = console que sobe, sem nenhuma BACKUP_*', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { parseEnvFile } = await import('@/config/env-file.js');
    const exemplo = parseEnvFile(
      readFileSync(resolve(__dirname, '../../../.env.admin.prod.example'), 'utf8'),
    );
    // O arquivo não declara nenhuma BACKUP_* — a asserção que a #596 entrega.
    expect(Object.keys(exemplo).filter((k) => k.startsWith('BACKUP_'))).toEqual([]);
    const env: Record<string, string> = { ...exemplo, ...DO_COMPOSE, NEXT_RUNTIME: 'nodejs' };
    for (const [k, v] of Object.entries(OPERADOR_PREENCHE)) {
      expect(env[k], `${k} deixou de ser um __SET_ME__ no exemplo`).toContain('__SET_ME__');
      env[k] = v;
    }
    useEnv(env);
    await expect(register()).resolves.toBeUndefined();
  });
});
