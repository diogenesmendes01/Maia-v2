/**
 * `compose.prod.yml` — o ambiente EFETIVO dos três serviços, medido contra o
 * loader real.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Duas propriedades, e a segunda mudou de sinal
 * ─────────────────────────────────────────────────────────────────────────
 *  1. **`MAIA_ENV` chega aos TRÊS serviços, de uma fonte só** (issue #516,
 *     PR #569). `${MAIA_ENV:?…}` chegou primeiro só em
 *     `services.migrate.environment`; `app` e `admin-ui` recebiam
 *     `NODE_ENV=production` e nenhuma `MAIA_ENV`. Como `.env.infra` serve
 *     **apenas para interpolação**, declarar a variável lá não a injeta em
 *     container nenhum — o migrator terminava com SUCESSO e os consumidores
 *     reprovavam no BOOT.
 *
 *  2. **O ambiente que o runbook produz satisfaz os TRÊS loaders** (issue
 *     #572). Este arquivo passou boa parte da sua vida afirmando o CONTRÁRIO:
 *     havia um `describe` chamado "gap conhecido" que prendia, pelo nome, as
 *     dez chaves que `docs/runbooks/deploy-prod.md` §1 mandava acrescentar à
 *     mão depois do `cp` — seis `BACKUP_*` ausentes de `.env.app.prod.example`
 *     e quatro `OIDC_*` presentes porém COMENTADAS em
 *     `.env.admin.prod.example`. O gap foi FECHADO nos exemplos, e por isso os
 *     casos viraram positivos: onde se lia "estas chaves faltam", lê-se agora
 *     "o loader não reprova nada" e "cada uma destas linhas é load-bearing".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que este arquivo NÃO afirma — e por que isso está escrito aqui
 * ─────────────────────────────────────────────────────────────────────────
 * A revisão da PR #569 (rodada 2) pegou uma versão anterior deste spec com um
 * caso chamado "o ambiente efetivo … satisfaz o loader". Ele passava porque
 * `effectiveEnv()` fazia, por default, um `Object.assign` com as mesmas dez
 * variáveis — que naquele momento **não existiam** em lugar nenhum do
 * bring-up. O verde afirmava uma coisa ("o ambiente do runbook sobe") e
 * provava outra ("o ambiente do runbook MAIS dez variáveis inventadas aqui
 * sobe").
 *
 * A injeção silenciosa continua REMOVIDA, e é essa a diferença entre este
 * arquivo e aquele: `effectiveEnv()` monta o ambiente a partir do compose e
 * dos `.prod.example` do repositório, e o único acréscimo é `OPERATOR_FILLS`
 * — os valores que o exemplo deixa em branco DE PROPÓSITO para o operador
 * preencher. Esse conjunto é conferido contra os arquivos nos dois sentidos
 * (preencher uma chave que o exemplo já traz preenchida reprova; deixar de
 * preencher uma que ele deixa vazia também).
 *
 * O que continua fora do alcance deste arquivo — e do preflight que ele
 * cobre — está listado em `docs/runbooks/deploy-prod.md` §1 ("O que o
 * preflight NÃO cobre"): nada aqui abre conexão com Postgres, Redis, S3 ou
 * IdP, e nada aqui executa o gate de boot PRÓPRIO do admin-ui
 * (`oidcProviderEnabled` / `resolveSecret` em
 * `src/admin-ui/lib/auth-gating.ts`), que é mais estrito que o contrato em
 * pelo menos dois pontos.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A armadilha do espelho, e como ela é evitada
 * ─────────────────────────────────────────────────────────────────────────
 * Nada aqui monta YAML nem escreve um `.env`. O compose vem do parser subset
 * estrito, os env files vêm do disco, o nome do arquivo de exemplo é DERIVADO
 * do `env_file` declarado no próprio compose, e o veredito vem de
 * `loadServiceConfig` — o mesmo loader do boot.
 *
 * E a COMPOSIÇÃO (`env_file` + `environment:`, nessa precedência) vem de
 * `src/config/compose-env.ts`, que é o mesmo módulo que
 * `scripts/config.ts preflight` roda em produção. Isso é deliberado: uma
 * segunda derivação de "o que o container recebe" seria uma segunda resposta
 * possível, e a do teste é justamente a que ninguém roda no deploy. O que este
 * arquivo mede, portanto, é o preflight de verdade — contra os artefatos de
 * verdade.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { asMap, asString, parseComposeFile, type ComposeNode } from './_compose-yaml.js';
import {
  COMPOSE_SERVICE_CONTRACT,
  effectiveServiceEnv,
  environmentOf,
  envFileNamesOf,
  preflightTargets,
} from '@/config/compose-env.js';
import { loadServiceConfig, ConfigValidationError } from '@/config/load.js';
import { parseEnvFile as parseEnvText } from '@/config/env-file.js';
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
 * cobrir os TRÊS, e não só o subset do migrator. Escrito à mão aqui, e
 * conferido contra `COMPOSE_SERVICE_CONTRACT` (a tabela que o preflight usa)
 * num caso próprio abaixo.
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
 *
 * Nenhum valor daqui é a fixture sintética do contrato para a mesma chave: as
 * fixtures são recusadas em production pela regra `secret/synthetic-fixture`,
 * e é justamente essa regra que este arquivo NÃO pode desligar — o ambiente
 * medido tem que ser um ambiente que um operador poderia ter.
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
  // ---- issue #572: backup off-site cifrado, no env do `app` ----------------
  // O `app` é quem RODA o backup nesta topologia: `compose.prod.yml` não tem
  // container de backup, e o processo sobe no role default `all`, que possui
  // `cron_scheduler` (src/runtime/lifecycle/roles.ts) — de onde saem
  // `nightly_backup`, `backup_retention` e `restore_drill`
  // (src/workers/index.ts). Daí `services: ['runtime', …]` no contrato.
  BACKUP_S3_BUCKET: 'maia-backups-do-operador',
  // Curtas e repetitivas de PROPÓSITO: o `generic-api-key` do gitleaks casa a
  // palavra-chave (`…ACCESS_KEY`, `…SECRET_KEY`) e depois corta por ENTROPIA de
  // Shannon > 3.5. As duas frases descritivas que estavam aqui davam 3.61 e
  // 3.58 e reprovaram o scan da PR #595. O contrato só cobra PRESENÇA destas
  // duas, então encurtar não perde asserção nenhuma — e é melhor que pedir
  // exceção ao scanner, que passaria a ter uma entrada a mais para envelhecer.
  // Medido com gitleaks 8.28.0: 3.20 e 3.34.
  BACKUP_S3_ACCESS_KEY: 'nao-e-credencial',
  BACKUP_S3_SECRET_KEY: 'nao-e-credencial-secreta',
  BACKUP_ENCRYPTION_KEYRING: '{"k1":"nao-e-chave-de-cifra-de-fixture-de-teste"}',
  // ---- issue #572: SSO do admin-ui ---------------------------------------
  OIDC_ISSUER: 'https://login.example.com/realms/maia',
  OIDC_CLIENT_ID: 'maia-admin',
  OIDC_CLIENT_SECRET: 'nao-e-segredo-oidc-de-fixture-de-teste',
  // NUNCA `default`: o slug vai direto para `appUsersRepo.getByEmail(tenant, …)`
  // em src/admin-ui/lib/auth-resolver.ts, ou seja, vira `tenant_id` num caminho
  // dinâmico (AGENTS.md §4 regras 2 e 8). A regra
  // `admin-ui/tenant-slugs-default-literal` (src/config/rules.ts) recusa.
  OIDC_TENANT_SLUGS: 'primary',
};

/**
 * As chaves que FECHARAM o gap da issue #572 — as que os `.prod.example`
 * passaram a declarar. Cada uma é conferida por dois lados:
 *
 *  - está DECLARADA (não comentada) no exemplo do serviço, e
 *  - é LOAD-BEARING: tirá-la do ambiente efetivo volta a reprovar o loader.
 *
 * Uma chave que deixe de ser necessária (o contrato afrouxou) reprova o
 * segundo caso; uma chave que o contrato passe a exigir e o exemplo não traga
 * reprova o primeiro caso desta lista e o "sem reprovas" logo abaixo.
 */
const FECHARAM_O_GAP: Readonly<Record<string, readonly string[]>> = {
  // O migrator não tem env_file: tudo que ele recebe está no compose, e o
  // subset `migrator` do contrato já era satisfeito por ele (issue #516).
  migrate: [],
  app: [
    'BACKUP_ENCRYPTION_ACTIVE_KEY_ID',
    'BACKUP_ENCRYPTION_KEYRING',
    'BACKUP_ENCRYPTION_MODE',
    'BACKUP_S3_ACCESS_KEY',
    'BACKUP_S3_BUCKET',
    'BACKUP_S3_SECRET_KEY',
  ],
  'admin-ui': ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_ISSUER', 'OIDC_TENANT_SLUGS'],
};

/** `true` quando o exemplo deixa a chave para o operador preencher. */
function needsOperator(value: string): boolean {
  return value === '' || value.includes('__SET_ME__') || value.endsWith('...');
}

/**
 * `KEY=VALUE` de um env file real, pelo MESMO parser do boot
 * (`dotenv.parse`, via `src/config/env-file.ts`). Comentários e linhas vazias
 * ficam de fora — que é o que elas são para um container.
 */
function parseEnvFile(path: string): Record<string, string> {
  return parseEnvText(readFileSync(path, 'utf8'));
}

function compose(): Record<string, ComposeNode> {
  return parseComposeFile(PROD);
}

function service(name: string): Record<string, ComposeNode> {
  return asMap(asMap(compose().services, 'services')[name], `services.${name}`);
}

/**
 * Os `.prod.example` de um serviço, DERIVADOS do `env_file` que o próprio
 * compose declara (`.env.app` ⇒ `.env.app.prod.example`). Um serviço sem
 * `env_file` — o `migrate` — devolve lista vazia, que é o ponto dele.
 */
function exampleFilesOf(composeName: string): string[] {
  return envFileNamesOf(compose(), composeName).map((f) =>
    resolve(REPO_ROOT, `${f}.prod.example`),
  );
}

/**
 * O que o container REALMENTE recebe seguindo o runbook: a composição vem de
 * `effectiveServiceEnv` (o módulo que o preflight roda), sobre os
 * `.prod.example` do repositório, mais os valores que o exemplo manda o
 * operador preencher. **E nada além disso** — `add` é sempre explícito no
 * ponto da chamada, e `OPERATOR_FILLS` só toca chave que o arquivo deixou em
 * branco.
 */
function effectiveEnv(
  composeName: string,
  opts: {
    readonly infra?: Readonly<Record<string, string>>;
    readonly drop?: readonly string[];
    /** Chaves acrescentadas À MÃO, para medir o contrafactual. */
    readonly add?: Readonly<Record<string, string>>;
  } = {},
): Record<string, string> {
  const env = effectiveServiceEnv(compose(), composeName, {
    envFileContents: exampleFilesOf(composeName).map((f) => readFileSync(f, 'utf8')),
    infra: opts.infra ?? INFRA,
  });
  for (const [key, value] of Object.entries(env)) {
    if (needsOperator(value) && OPERATOR_FILLS[key] !== undefined) {
      env[key] = OPERATOR_FILLS[key];
    }
  }
  Object.assign(env, opts.add ?? {});
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
    const declared = SERVICES.map(({ compose: name }) => {
      const env = asMap(service(name).environment, `services.${name}.environment`);
      return {
        service: name,
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
    ).toEqual(SERVICES.map(({ compose: name }) => ({ service: name, MAIA_ENV: migrate })));
    // E a forma tem que ser a obrigatória: um `:-production` num dos três
    // devolveria a divergência silenciosa por outro caminho.
    expect(migrate).toMatch(/^\$\{MAIA_ENV:\?/);
  });

  it('nenhum env_file declara MAIA_ENV — o compose é a fonte única', () => {
    const declaredInFiles = SERVICES.flatMap(({ compose: name }) =>
      exampleFilesOf(name)
        .filter((file) => 'MAIA_ENV' in parseEnvFile(file))
        .map((file) => `${name}: ${file}`),
    );
    expect(
      declaredInFiles,
      'Uma segunda fonte é uma fonte que pode divergir: o migrator rodaria com um valor ' +
        'e os consumidores com outro, sem nada apontando a contradição.',
    ).toEqual([]);
  });

  it.each(SERVICES)(
    'MAIA_ENV chega ao ambiente efetivo de $compose e o loader de $contract NÃO reclama dela',
    ({ compose: name, contract }) => {
      expect(effectiveEnv(name).MAIA_ENV).toBe(INFRA.MAIA_ENV);
      expect(reprovadas(contract, effectiveEnv(name))).not.toContain('MAIA_ENV');
    },
  );

  it.each(SERVICES)(
    'tirar MAIA_ENV do ambiente efetivo de $compose acrescenta MAIA_ENV — e SÓ ela — às reprovas',
    ({ compose: name, contract }) => {
      // Prova que a linha injetada é LOAD-BEARING, e não decoração: retirada do
      // ambiente efetivo (mantendo NODE_ENV=production), o profile continua
      // resolvendo para `production` e `requiredIn` reprova.
      const com = reprovadas(contract, effectiveEnv(name));
      const sem = reprovadas(contract, effectiveEnv(name, { drop: ['MAIA_ENV'] }));
      expect(sem, `${name}: o loader aceitou um ambiente efetivo sem MAIA_ENV`).toEqual(
        [...com, 'MAIA_ENV'].sort(),
      );
    },
  );

  it.each(SERVICES)(
    'um .env.infra sem MAIA_ENV aborta a interpolação de $compose antes de qualquer container',
    ({ compose: name }) => {
      const { MAIA_ENV: _dropped, ...withoutMaiaEnv } = INFRA;
      expect(() => environmentOf(compose(), name, withoutMaiaEnv)).toThrow(
        /MAIA_ENV is required/,
      );
    },
  );

  it('um MAIA_ENV=staging no .env.infra chega igual nos três', () => {
    const staging = { ...INFRA, MAIA_ENV: 'staging' };
    const got = SERVICES.map(({ compose: name }) => environmentOf(compose(), name, staging).MAIA_ENV);
    expect(got).toEqual(['staging', 'staging', 'staging']);
  });

  it('OPERATOR_FILLS cobre exatamente o que os exemplos deixam em branco', () => {
    // Mantém os `.prod.example` load-bearing: uma variável nova e vazia neles
    // sem entrada aqui aparece como "faltando", e uma entrada aqui que o
    // exemplo já preenche aparece como "sobrando" — em vez de o preenchimento
    // silenciosamente mascarar o arquivo real.
    const blanks = new Set<string>();
    for (const { compose: name } of SERVICES) {
      for (const file of exampleFilesOf(name)) {
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

describe('o ambiente do runbook satisfaz o loader dos TRÊS serviços (issue #572)', () => {
  it('o preflight cobre exatamente os serviços deste spec, com o mesmo loader dono', () => {
    // Sem isto, um serviço novo no compose sairia do preflight em silêncio e
    // este arquivo continuaria verde medindo três dos quatro consumidores.
    expect(preflightTargets(compose()).map((t) => ({ compose: t.compose, contract: t.contract }))).toEqual(
      [...SERVICES],
    );
    expect(COMPOSE_SERVICE_CONTRACT).toEqual(
      Object.fromEntries(SERVICES.map(({ compose: name, contract }) => [name, contract])),
    );
  });

  it('o `up` do runbook NÃO tem reprova de configuração em nenhum dos três', () => {
    // Lido do loader REAL sobre os artefatos REAIS, sem nenhum completamento.
    // É o que o operador vê no primeiro `docker compose up -d` depois de
    // seguir `docs/runbooks/deploy-prod.md` §1 ao pé da letra — e é a
    // propriedade que a issue #572 existe para entregar. Antes dela, `app`
    // reprovava com BACKUP_ENCRYPTION_MODE/BACKUP_S3_BUCKET (e outras quatro
    // na segunda rodada) e `admin-ui` com as quatro OIDC_*.
    const reprovas = Object.fromEntries(
      SERVICES.map(({ compose: name, contract }) => [name, reprovadas(contract, effectiveEnv(name))]),
    );
    expect(
      reprovas,
      'Se isto ficou vermelho, o bring-up documentado voltou a não subir: o contrato passou a ' +
        'exigir algo que os .prod.example não entregam. Atualize os exemplos, FECHARAM_O_GAP e ' +
        'docs/runbooks/deploy-prod.md §1 juntos.',
    ).toEqual({ migrate: [], app: [], 'admin-ui': [] });
  });

  it.each(SERVICES)(
    'as chaves que fecharam o gap estão DECLARADAS (não comentadas) no exemplo de $compose',
    ({ compose: name }) => {
      // Dito sobre o ARQUIVO, e não sobre o loader: `parseEnvFile` ignora
      // comentários, então uma chave que volte a ser "documentada em comentário"
      // conta como ausente — que é o que ela é para um container. Era
      // exatamente esse o estado das quatro OIDC_* antes da #572.
      const declaradas = exampleFilesOf(name)
        .flatMap((file) => Object.keys(parseEnvFile(file)))
        .filter((k) => FECHARAM_O_GAP[name]!.includes(k))
        .sort();
      expect(declaradas).toEqual([...FECHARAM_O_GAP[name]!]);
    },
  );

  it.each(SERVICES)(
    'cada chave que fechou o gap de $compose é LOAD-BEARING: tirá-la volta a reprovar',
    ({ compose: name, contract }) => {
      // O contrafactual do caso acima. Sem ele, acrescentar as linhas ao
      // exemplo seria indistinguível de acrescentar comentários: o verde não
      // diria se alguma delas ainda é exigida. Uma chave que deixe de ser
      // necessária aparece aqui como "não reprovou", obrigando a encolher
      // FECHARAM_O_GAP DE PROPÓSITO em vez de deixá-la mentindo.
      const naoReprovaram = FECHARAM_O_GAP[name]!.filter(
        (k) => reprovadas(contract, effectiveEnv(name, { drop: [k] })).length === 0,
      );
      expect(
        naoReprovaram,
        `${name}: chave(s) de FECHARAM_O_GAP que o loader já não exige — o contrato afrouxou ` +
          'e a lista ficou para trás.',
      ).toEqual([]);
    },
  );

  it('OIDC_TENANT_SLUGS=default é RECUSADO — o slug vira tenant_id (AGENTS.md §4)', () => {
    // O exemplo trazia `OIDC_TENANT_SLUGS=default` numa linha comentada. O slug
    // não é decorativo: `resolveOidcAppUser` (src/admin-ui/lib/auth-resolver.ts)
    // o passa direto para `appUsersRepo.getByEmail(tenant, email)` e
    // `tenantsRepo.findById(tenant)`. Um `default` ali autentica gente contra o
    // bucket legado presumido-mal-roteado.
    const comDefault = reprovadas(
      'admin-ui',
      effectiveEnv('admin-ui', { add: { OIDC_TENANT_SLUGS: 'default' } }),
    );
    expect(comDefault).toContain('OIDC_TENANT_SLUGS');
    // E não é só o literal sozinho: numa lista, também.
    expect(
      reprovadas('admin-ui', effectiveEnv('admin-ui', { add: { OIDC_TENANT_SLUGS: 'primary,default' } })),
    ).toContain('OIDC_TENANT_SLUGS');
  });
});
