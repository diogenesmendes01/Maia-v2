/**
 * `compose.prod.yml` — o ambiente EFETIVO dos três serviços, executado contra
 * o loader de cada um (issue #516, achado da review da PR #569).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O defeito que isto fecha
 * ─────────────────────────────────────────────────────────────────────────
 * `${MAIA_ENV:?…}` chegou só em `services.migrate.environment`. `app` e
 * `admin-ui` recebiam `NODE_ENV=production` e **não** recebiam `MAIA_ENV`; os
 * `env_file` deles também não a declaram nos exemplos que o runbook manda
 * copiar. Como `.env.infra` serve **apenas para interpolação**, declarar a
 * variável lá não a injeta em container nenhum.
 *
 * O contrato marca `MAIA_ENV` como `services: ALL` e
 * `requiredIn: ['staging','production']`. Seguindo `docs/runbooks/deploy-prod.md`
 * §1 à risca, portanto, o migrator terminava com **sucesso** e `app`/`admin-ui`
 * reprovavam no **boot** por configuração ausente — o pior lugar para descobrir,
 * porque o gate que existia (`service_completed_successfully`) já tinha dado o
 * sinal verde. Num ensaio de staging era pior ainda: não havia fonte única, e o
 * migrator podia rodar com `staging` enquanto os consumidores recebiam outro
 * valor, ou nenhum.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que "ambiente efetivo" e não "o que está no `environment:`"
 * ─────────────────────────────────────────────────────────────────────────
 * O que um container recebe é `env_file` + `environment:`, e o defeito vivia
 * exatamente na diferença entre os dois: o `environment:` do `migrate` estava
 * certo, e o do `app` estava incompleto porque alguém supôs que o `.env.app`
 * cobria. Então aqui os dois lados são LIDOS DO REPOSITÓRIO — o bloco
 * `environment:` do compose real e o `.prod.example` que o runbook manda
 * copiar — e o resultado é entregue ao loader de produção do serviço.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A armadilha do espelho, e como ela é evitada
 * ─────────────────────────────────────────────────────────────────────────
 * Nada aqui monta YAML nem escreve um `.env`. O compose vem do parser subset
 * estrito (`_compose-yaml.ts`), que recusa qualquer linha que não entenda; os
 * env files vêm do disco; o nome do arquivo de exemplo é DERIVADO do `env_file`
 * declarado no próprio compose. A única coisa escrita aqui é `OPERATOR_FILLS`
 * — os valores que o exemplo deixa em branco de propósito para o operador
 * preencher — e até esse conjunto é conferido contra o arquivo: preencher uma
 * chave que o exemplo já traz preenchida, ou deixar de preencher uma que ele
 * deixa vazia, reprova.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { asMap, asString, interpolate, parseComposeFile, type ComposeNode } from './_compose-yaml.js';
import { loadServiceConfig, ConfigValidationError } from '@/config/load.js';
import type { MaiaService } from '@/config/metadata.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const PROD = resolve(REPO_ROOT, 'compose.prod.yml');

/**
 * O que `docker compose --env-file .env.infra` fornece para interpolação —
 * o mesmo `.env.infra` do runbook §1, e nada além dele. `.env.infra` NÃO é
 * injetado em container algum: é essa a razão de `MAIA_ENV` precisar aparecer
 * no `environment:` de cada serviço.
 */
const INFRA = {
  POSTGRES_USER: 'maia_prod',
  POSTGRES_PASSWORD: 'f4kepassw0rdf4ke',
  POSTGRES_DB: 'maia',
  REDIS_PASSWORD: 'f4keredispass',
  MAIA_ENV: 'production',
} as const;

/**
 * Serviço do compose → serviço do contrato (`src/config/metadata.ts`), ou seja,
 * qual loader é o dono daquele container. É o mapeamento que faz este spec
 * cobrir os TRÊS, e não só o subset do migrator.
 */
const SERVICES: readonly { compose: string; contract: MaiaService }[] = [
  { compose: 'migrate', contract: 'migrator' },
  { compose: 'app', contract: 'runtime' },
  { compose: 'admin-ui', contract: 'admin-ui' },
];

/**
 * Valores que o `.prod.example` deixa VAZIOS ou com placeholder de propósito,
 * para o operador preencher (`docs/runbooks/deploy-prod.md` §1: "preencha
 * ambos — placeholders __SET_ME__ são rejeitados no boot").
 *
 * `MAIA_ENV` NÃO está aqui, e é justamente esse o ponto: ela tem que chegar
 * pelo compose. Se alguém a acrescentar a um env file, o caso "fonte única"
 * abaixo reprova.
 */
const OPERATOR_FILLS: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: 'sk-ant-f4ke0000000000000000000000000000000000',
  OPENAI_API_KEY: 'sk-f4ke0000000000000000000000000000000000',
  VOYAGE_API_KEY: 'pa-f4ke0000000000000000000000000000000000',
  OWNER_NOME: 'Operador de Producao',
  // Sem forma de base64 e sem entropia: o `generic-api-key` do gitleaks dispara
  // por ENTROPIA, não por prefixo, e reprovou a PR #569 exatamente nestas duas
  // linhas. O contrato não pede base64 aqui — `NEXTAUTH_SECRET` é `min(8)` e o
  // HMAC não tem restrição —, então a forma de segredo era gratuita. Tirá-la é
  // melhor que pedir exceção ao scanner.
  RUNTIME_TRACE_HMAC_MASTER_SECRET: 'nao-e-segredo-hmac-de-fixture-de-teste',
  NEXTAUTH_SECRET: 'nao-e-segredo-nextauth-de-fixture-de-teste',
};

/**
 * GAP CONHECIDO, e deliberadamente NÃO corrigido aqui.
 *
 * O profile `production` exige estas variáveis, e os `.prod.example` não as
 * trazem — as de backup não aparecem em `.env.app.prod.example` de forma
 * alguma, e as de OIDC estão em `.env.admin.prod.example` apenas COMENTADAS,
 * sob o texto "Configure as quatro (ou nenhuma)", que contradiz o
 * `requiredIn: ['production']` do contrato.
 *
 * Ou seja: o achado da review ("seguindo o runbook à risca, app/admin-ui
 * reprovam no boot") é MAIOR do que o `MAIA_ENV` que ele nomeia. Fechar o
 * resto significa decidir se produção realmente obriga backup off-site
 * cifrado e SSO — decisão de produto, não de wiring, e ela é do dono. O que
 * esta correção faz é parar de esconder o gap: o caso
 * "gap conhecido…" abaixo o prende com nome e sobrenome, lido do loader REAL,
 * e fica vermelho no dia em que os exemplos melhorarem — obrigando quem
 * melhorar a encolher esta lista de propósito, em vez de deixá-la mentindo.
 */
const FORA_DOS_EXEMPLOS: Readonly<Record<string, string>> = {
  BACKUP_S3_BUCKET: 'maia-backups-prod',
  BACKUP_S3_ACCESS_KEY: 'f4keaccesskey0000000',
  BACKUP_S3_SECRET_KEY: 'f4kesecretkey00000000000000000000000000',
  BACKUP_ENCRYPTION_MODE: 'envelope_aes256_gcm',
  // Sem base64: o contrato aqui é `z.string()` sem restrição, então a forma de
  // material criptográfico era gratuita — e é ela que o `generic-api-key` vê.
  BACKUP_ENCRYPTION_KEYRING: '{"k1":"nao-e-chave-de-verdade-fixture"}',
  BACKUP_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
  OIDC_ISSUER: 'https://login.example.com/realms/maia',
  OIDC_CLIENT_ID: 'maia-admin',
  OIDC_CLIENT_SECRET: 'f4ke-oidc-client-secret-0000000000000000',
  OIDC_TENANT_SLUGS: 'primary',
};

/** `true` quando o exemplo deixa a chave para o operador preencher. */
function needsOperator(value: string): boolean {
  return value === '' || value.includes('__SET_ME__') || value.endsWith('...');
}

/** `KEY=VALUE` de um env file real. Comentários e linhas vazias fora. */
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) throw new Error(`${path}: linha que não é KEY=VALUE: ${line}`);
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function services(): Record<string, ComposeNode> {
  return asMap(parseComposeFile(PROD).services, 'compose.prod.yml: services');
}

function service(name: string): Record<string, ComposeNode> {
  return asMap(services()[name], `compose.prod.yml: services.${name}`);
}

/**
 * Os `.prod.example` de um serviço, DERIVADOS do `env_file` que o próprio
 * compose declara (`.env.app` ⇒ `.env.app.prod.example`). Um serviço sem
 * `env_file` — o `migrate` — devolve lista vazia, que é o ponto dele.
 */
function exampleFilesOf(composeName: string): string[] {
  const declared = service(composeName).env_file;
  if (declared === undefined) return [];
  const list = Array.isArray(declared) ? declared : [asString(declared, 'env_file')];
  return list.map((f) => resolve(REPO_ROOT, `${asString(f, 'env_file[]')}.prod.example`));
}

/** O bloco `environment:` do serviço, interpolado com um `.env.infra`. */
function environmentOf(
  composeName: string,
  infra: Readonly<Record<string, string>> = INFRA,
): Record<string, string> {
  const raw = asMap(service(composeName).environment, `services.${composeName}.environment`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = interpolate(asString(value, `services.${composeName}.environment.${key}`), infra);
  }
  return out;
}

/**
 * O que o container REALMENTE recebe: `env_file` primeiro, `environment:`
 * por cima (é essa a precedência do Compose), mais os valores que o operador
 * preenche.
 */
function effectiveEnv(
  composeName: string,
  opts: {
    readonly infra?: Readonly<Record<string, string>>;
    readonly drop?: readonly string[];
    /** `false` = exatamente o que os exemplos trazem, sem tapar o gap conhecido. */
    readonly fillGap?: boolean;
  } = {},
): Record<string, string> {
  const env: Record<string, string> = { TZ: 'America/Sao_Paulo' };
  for (const file of exampleFilesOf(composeName)) {
    for (const [key, value] of Object.entries(parseEnvFile(file))) {
      env[key] = needsOperator(value) ? (OPERATOR_FILLS[key] ?? value) : value;
    }
  }
  if (opts.fillGap !== false && exampleFilesOf(composeName).length > 0) {
    Object.assign(env, FORA_DOS_EXEMPLOS);
  }
  Object.assign(env, environmentOf(composeName, opts.infra ?? INFRA));
  for (const key of opts.drop ?? []) delete env[key];
  return env;
}

/** Variáveis que o loader do serviço reprova, para um dado ambiente efetivo. */
function reprovadas(contract: MaiaService, env: Record<string, string>): string[] {
  try {
    loadServiceConfig(contract, { env });
    return [];
  } catch (err) {
    if (!(err instanceof ConfigValidationError)) throw err;
    return [...new Set(err.problems.map((p) => p.variable ?? '<config>'))].sort();
  }
}

describe('compose.prod.yml — MAIA_ENV chega aos TRÊS serviços, de uma fonte só', () => {
  it('os três declaram MAIA_ENV, e na MESMA expressão obrigatória', () => {
    const declared = SERVICES.map(({ compose }) => {
      const env = asMap(service(compose).environment, `services.${compose}.environment`);
      return {
        service: compose,
        // `undefined` (e não uma exceção) para o vermelho mostrar QUAL serviço
        // ficou sem a variável, que é exatamente o defeito original.
        MAIA_ENV: env.MAIA_ENV === undefined ? null : asString(env.MAIA_ENV, 'MAIA_ENV'),
      };
    });
    const migrate = declared.find((d) => d.service === 'migrate')!.MAIA_ENV;
    expect(
      declared,
      'MAIA_ENV é `services: ALL` + `requiredIn: [staging, production]` no contrato, e ' +
        '`.env.infra` serve SÓ para interpolação — declará-la lá não injeta nada. ' +
        'Um serviço sem esta linha reprova no boot DEPOIS de o migrator ter dito sucesso.',
    ).toEqual(SERVICES.map(({ compose }) => ({ service: compose, MAIA_ENV: migrate })));
    // E a forma tem que ser a obrigatória: um `:-production` num dos três
    // devolveria a divergência silenciosa por outro caminho.
    expect(migrate).toMatch(/^\$\{MAIA_ENV:\?/);
  });

  it('nenhum env_file declara MAIA_ENV — o compose é a fonte única', () => {
    const declaredInFiles = SERVICES.flatMap(({ compose }) =>
      exampleFilesOf(compose)
        .filter((file) => 'MAIA_ENV' in parseEnvFile(file))
        .map((file) => `${compose}: ${file}`),
    );
    expect(
      declaredInFiles,
      'Uma segunda fonte é uma fonte que pode divergir: o migrator rodaria com um valor ' +
        'e os consumidores com outro, sem nada apontando a contradição.',
    ).toEqual([]);
  });

  it.each(SERVICES)(
    'o ambiente efetivo de $compose satisfaz loadServiceConfig("$contract")',
    ({ compose, contract }) => {
      // A metade EXECUTÁVEL da afirmação, e a que faltava: o spec anterior
      // rodava o loader só para o `migrate`.
      expect(() => loadServiceConfig(contract, { env: effectiveEnv(compose) })).not.toThrow();
    },
  );

  it.each(SERVICES)(
    'sem MAIA_ENV no ambiente efetivo, o loader de $compose REPROVA',
    ({ compose, contract }) => {
      // Prova que a linha injetada é LOAD-BEARING, e não decoração: retirada do
      // ambiente efetivo (mantendo NODE_ENV=production), o profile resolve para
      // `production` e `requiredIn` reprova. Sem este caso, acrescentar a
      // variável ao compose seria indistinguível de não acrescentar.
      expect(
        reprovadas(contract, effectiveEnv(compose, { drop: ['MAIA_ENV'] })),
        `${compose}: o loader aceitou um ambiente efetivo sem MAIA_ENV`,
      ).toEqual(['MAIA_ENV']);
    },
  );

  it('gap conhecido: o que o profile production exige e os .prod.example não trazem', () => {
    // Lido do loader REAL, não de uma lista escrita à mão. Ver o comentário de
    // FORA_DOS_EXEMPLOS: este caso existe para o gap ter nome, e para encolher
    // de propósito quando alguém corrigir os exemplos.
    const gap = Object.fromEntries(
      SERVICES.map(({ compose, contract }) => [
        compose,
        reprovadas(contract, effectiveEnv(compose, { fillGap: false })),
      ]),
    );
    expect(gap).toEqual({
      // O migrator não tem env_file: tudo que ele recebe está no compose.
      migrate: [],
      // Backup off-site cifrado é exigido em production e `.env.app.prod.example`
      // não menciona nenhuma dessas variáveis. A lista é o PRIMEIRO nível de
      // problemas: definir o bucket destrava a exigência das credenciais S3, e
      // sair de `BACKUP_ENCRYPTION_MODE=none` destrava a do keyring — por isso
      // `FORA_DOS_EXEMPLOS` tem mais chaves do que aparecem aqui.
      app: ['BACKUP_ENCRYPTION_MODE', 'BACKUP_S3_BUCKET'],
      // As quatro do OIDC estão no exemplo apenas COMENTADAS, sob "configure as
      // quatro (ou nenhuma)" — o contrato diz que production exige as quatro.
      'admin-ui': ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_ISSUER', 'OIDC_TENANT_SLUGS'],
    });
  });

  it.each(SERVICES)(
    'um .env.infra sem MAIA_ENV aborta a interpolação de $compose antes de qualquer container',
    ({ compose }) => {
      const { MAIA_ENV: _dropped, ...withoutMaiaEnv } = INFRA;
      expect(() => environmentOf(compose, withoutMaiaEnv)).toThrow(/MAIA_ENV is required/);
    },
  );

  it('um MAIA_ENV=staging no .env.infra chega igual nos três', () => {
    // A outra metade da fonte única: não basta abortar quando falta, tem que
    // PROPAGAR o valor do operador — e o mesmo valor para os três, senão o
    // ensaio de staging volta a poder rodar migrator e consumidores em
    // profiles diferentes.
    const staging = { ...INFRA, MAIA_ENV: 'staging' };
    const got = SERVICES.map(({ compose }) => environmentOf(compose, staging).MAIA_ENV);
    expect(got).toEqual(['staging', 'staging', 'staging']);
  });

  it('OPERATOR_FILLS cobre exatamente o que os exemplos deixam em branco', () => {
    // Mantém os `.prod.example` load-bearing: uma variável nova e vazia neles
    // sem entrada aqui aparece como "faltando", e uma entrada aqui que o
    // exemplo já preenche aparece como "sobrando" — em vez de o preenchimento
    // silenciosamente mascarar o arquivo real.
    const blanks = new Set<string>();
    for (const { compose } of SERVICES) {
      for (const file of exampleFilesOf(compose)) {
        for (const [key, value] of Object.entries(parseEnvFile(file))) {
          if (needsOperator(value)) blanks.add(key);
        }
      }
    }
    expect({
      faltando: [...blanks].filter((k) => !(k in OPERATOR_FILLS)).sort(),
      sobrando: Object.keys(OPERATOR_FILLS).filter((k) => !blanks.has(k)).sort(),
    }).toEqual({ faltando: [], sobrando: [] });
  });
});
