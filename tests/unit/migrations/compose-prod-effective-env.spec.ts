/**
 * `compose.prod.yml` — a propriedade que a PR #569 corrige: **`MAIA_ENV` chega
 * aos TRÊS serviços, de uma fonte só** (issue #516).
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
 * O que este arquivo NÃO afirma — e por que isso está escrito aqui
 * ─────────────────────────────────────────────────────────────────────────
 * A revisão da PR #569 (rodada 2) pegou uma versão anterior deste spec que
 * tinha um caso chamado "o ambiente efetivo … satisfaz o loader". Ele passava
 * porque `effectiveEnv()` fazia, por default, um `Object.assign` com dez
 * variáveis (`BACKUP_*`, `OIDC_*`) que **não existem** no Compose, nem nos
 * `.prod.example`, nem no procedimento de bring-up. Ou seja: o verde afirmava
 * uma coisa ("o ambiente do runbook sobe") e provava outra ("o ambiente do
 * runbook MAIS dez variáveis inventadas aqui sobe"). Um operador que seguisse
 * o runbook à risca continuaria batendo em falha de boot — só que agora com um
 * teste verde dizendo que não bateria.
 *
 * A injeção silenciosa foi REMOVIDA. Este arquivo agora afirma exatamente
 * duas coisas, e nada além delas:
 *
 *  1. **A propriedade da PR** — `MAIA_ENV` é a mesma nos três serviços, vem de
 *     fonte única (`.env.infra`), aborta o `up` inteiro quando ausente, e
 *     propaga `staging`. Executável contra o loader real: tirá-la do ambiente
 *     efetivo acrescenta `MAIA_ENV` — e só ela — às reprovas.
 *
 *  2. **O gap que a PR NÃO fecha**, com nome e sobrenome: o ambiente que o
 *     runbook produz **NÃO** satisfaz o loader de `app` nem o de `admin-ui`.
 *     `FALTA_NOS_EXEMPLOS` lista as chaves, e os casos abaixo a prendem pelos
 *     DOIS lados (suficiência e minimalidade) — de modo que fechar o gap sem
 *     atualizar esta lista deixa o arquivo VERMELHO e obriga a revisitar.
 *
 * Alinhar contrato + exemplos + preflight (`config:check` dos dois
 * consumidores) é a issue #572; é decisão de produto (produção realmente
 * obriga backup off-site cifrado e SSO?), não de wiring, e não cabe nesta PR.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A armadilha do espelho, e como ela é evitada
 * ─────────────────────────────────────────────────────────────────────────
 * Nada aqui monta YAML nem escreve um `.env`. O compose vem do parser subset
 * estrito (`_compose-yaml.ts`), que recusa qualquer linha que não entenda; os
 * env files vêm do disco; o nome do arquivo de exemplo é DERIVADO do `env_file`
 * declarado no próprio compose; e os valores usados para MEDIR o gap são as
 * fixtures que o **contrato** publica (`findSpec().fixture`), não valores
 * escritos à mão neste arquivo. A única coisa escrita aqui é `OPERATOR_FILLS`
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
import { findSpec } from '@/config/contract.js';
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
 * GAP CONHECIDO — o que o operador precisa acrescentar À MÃO depois de seguir
 * `docs/runbooks/deploy-prod.md` §1 ao pé da letra. Deliberadamente NÃO
 * corrigido nesta PR (issue #572).
 *
 * Os dois lados do gap não têm a mesma forma, e o runbook diz isso:
 *
 *  - `app`: as `BACKUP_*` **não aparecem de forma nenhuma** em
 *    `.env.app.prod.example` — não há linha comentada para descomentar.
 *  - `admin-ui`: as quatro `OIDC_*` **existem** em `.env.admin.prod.example`,
 *    porém COMENTADAS, sob o texto "Configure as quatro (ou nenhuma)", que
 *    contradiz o `requiredIn: ['staging','production']` do contrato.
 *
 * A lista é MAIOR que as chaves com `requiredIn`, porque o contrato encadeia:
 * `BACKUP_S3_BUCKET` presente passa a exigir `BACKUP_S3_ACCESS_KEY` e
 * `BACKUP_S3_SECRET_KEY` (`requiredWhen: { var: 'BACKUP_S3_BUCKET', present:
 * true }`), e `BACKUP_ENCRYPTION_MODE` não pode ficar em `none` no profile
 * production (`backup/production-encryption`), o que exige
 * `BACKUP_ENCRYPTION_KEYRING` e `BACKUP_ENCRYPTION_ACTIVE_KEY_ID`
 * (`backup/encryption-key`). Uma lista com só as duas `requiredIn` contaria
 * MENOS do que o operador encontra.
 *
 * Prendida pelos dois lados abaixo: "suficiência" reprova se o gap CRESCER,
 * "minimalidade" reprova se ele ENCOLHER. Fechar o gap sem editar esta lista
 * deixa o arquivo vermelho de propósito.
 */
const FALTA_NOS_EXEMPLOS: Readonly<Record<string, readonly string[]>> = {
  // O migrator não tem env_file: tudo que ele recebe está no compose, e o
  // subset `migrator` do contrato é satisfeito por ele. Este `[]` é o gate
  // que ESTA PR entrega — e é só ele.
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

/**
 * O que o loader ACUSA hoje, no primeiro boot, para cada serviço — o subconjunto
 * de `FALTA_NOS_EXEMPLOS` que aparece na PRIMEIRA rodada. É menor que o gap
 * inteiro justamente por causa do encadeamento descrito acima: o operador
 * conserta estas, roda de novo, e o contrato pede as próximas.
 */
const PRIMEIRA_RODADA: Readonly<Record<string, readonly string[]>> = {
  migrate: [],
  app: ['BACKUP_ENCRYPTION_MODE', 'BACKUP_S3_BUCKET'],
  'admin-ui': ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_ISSUER', 'OIDC_TENANT_SLUGS'],
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
 * O que o container REALMENTE recebe seguindo o runbook: `env_file` primeiro,
 * `environment:` por cima (é essa a precedência do Compose), mais os valores
 * que o exemplo manda o operador preencher. **E nada além disso** — não há
 * completamento silencioso aqui; `add` é sempre explícito no ponto da chamada.
 */
function effectiveEnv(
  composeName: string,
  opts: {
    readonly infra?: Readonly<Record<string, string>>;
    readonly drop?: readonly string[];
    /** Chaves acrescentadas À MÃO pelo operador, com a fixture do contrato. */
    readonly add?: readonly string[];
  } = {},
): Record<string, string> {
  const env: Record<string, string> = { TZ: 'America/Sao_Paulo' };
  for (const file of exampleFilesOf(composeName)) {
    for (const [key, value] of Object.entries(parseEnvFile(file))) {
      env[key] = needsOperator(value) ? (OPERATOR_FILLS[key] ?? value) : value;
    }
  }
  Object.assign(env, environmentOf(composeName, opts.infra ?? INFRA));
  for (const key of opts.add ?? []) env[key] = fixtureDoContrato(key);
  for (const key of opts.drop ?? []) delete env[key];
  return env;
}

/**
 * O valor de production que o PRÓPRIO contrato publica para uma chave
 * (`src/config/generated/fixtures/production.env` sai daqui). Usar isto em vez
 * de escrever valores neste arquivo tem duas consequências que importam:
 * nenhum material sintético novo entra no repositório (o guard
 * `secret/synthetic-fixture` e o gitleaks continuam valendo sobre valores que
 * já existiam), e a medição do gap não pode divergir do contrato.
 */
function fixtureDoContrato(name: string): string {
  const spec = findSpec(name);
  if (spec === undefined) throw new Error(`${name}: não existe no contrato`);
  const value = spec.fixtureByProfile?.production ?? spec.fixture;
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name}: o contrato não publica fixture utilizável em production`);
  }
  return value;
}

/**
 * Variáveis que o loader do serviço reprova, para um dado ambiente efetivo.
 *
 * `allowSyntheticFixtures` só é ligado quando o ambiente foi montado com
 * `add:` — aí os valores SÃO as fixtures do contrato, e o que se está medindo
 * é "que chaves faltam", não "que credencial é real".
 */
function reprovadas(
  contract: MaiaService,
  env: Record<string, string>,
  allowSyntheticFixtures = false,
): string[] {
  try {
    loadServiceConfig(contract, { env, allowSyntheticFixtures });
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
    'MAIA_ENV chega ao ambiente efetivo de $compose e o loader de $contract NÃO reclama dela',
    ({ compose, contract }) => {
      // Este caso NÃO afirma que o ambiente sobe — ele afirma que, seja qual
      // for o resto, MAIA_ENV não é mais um dos problemas. O que o ambiente
      // ainda NÃO satisfaz está no bloco "gap conhecido" abaixo, nomeado.
      expect(effectiveEnv(compose).MAIA_ENV).toBe(INFRA.MAIA_ENV);
      expect(reprovadas(contract, effectiveEnv(compose))).not.toContain('MAIA_ENV');
    },
  );

  it.each(SERVICES)(
    'tirar MAIA_ENV do ambiente efetivo de $compose acrescenta MAIA_ENV — e SÓ ela — às reprovas',
    ({ compose, contract }) => {
      // Prova que a linha injetada é LOAD-BEARING, e não decoração: retirada do
      // ambiente efetivo (mantendo NODE_ENV=production), o profile continua
      // resolvendo para `production` e `requiredIn` reprova. Sem este caso,
      // acrescentar a variável ao compose seria indistinguível de não
      // acrescentar. A comparação é com o ambiente REAL (gap incluído), então
      // ela continua exata quando o gap mudar.
      const com = reprovadas(contract, effectiveEnv(compose));
      const sem = reprovadas(contract, effectiveEnv(compose, { drop: ['MAIA_ENV'] }));
      expect(sem, `${compose}: o loader aceitou um ambiente efetivo sem MAIA_ENV`).toEqual(
        [...com, 'MAIA_ENV'].sort(),
      );
    },
  );

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

describe('gap conhecido: o ambiente do runbook NÃO satisfaz o loader (issue #572)', () => {
  it('o `up` do runbook reprova app e admin-ui já na PRIMEIRA rodada, e nestas chaves', () => {
    // Lido do loader REAL sobre os artefatos REAIS, sem nenhum completamento.
    // É o que o operador vê no primeiro `docker compose up -d` depois de
    // seguir `docs/runbooks/deploy-prod.md` §1 ao pé da letra.
    const primeira = Object.fromEntries(
      SERVICES.map(({ compose, contract }) => [
        compose,
        reprovadas(contract, effectiveEnv(compose)),
      ]),
    );
    expect(
      primeira,
      'Se isto mudou, o gap mudou: atualize PRIMEIRA_RODADA, FALTA_NOS_EXEMPLOS e a ' +
        'seção §1 de docs/runbooks/deploy-prod.md JUNTOS — a issue #572 existe para isso.',
    ).toEqual(PRIMEIRA_RODADA);
  });

  it.each(SERVICES)(
    'suficiência: com FALTA_NOS_EXEMPLOS acrescentada à mão, o loader de $compose aceita',
    ({ compose, contract }) => {
      // Vermelho quando o gap CRESCER (contrato passa a exigir mais uma chave
      // que os exemplos não trazem) — aí a lista está contando menos do que o
      // operador encontra, que é exatamente o defeito da rodada 2.
      const add = FALTA_NOS_EXEMPLOS[compose]!;
      expect(reprovadas(contract, effectiveEnv(compose, { add }), true)).toEqual([]);
    },
  );

  it.each(SERVICES)(
    'minimalidade: tirar QUALQUER uma das chaves de $compose volta a reprovar',
    ({ compose, contract }) => {
      // Vermelho quando o gap ENCOLHER (alguém acrescenta a chave ao
      // `.prod.example` e ela deixa de ser necessária à mão) — obrigando a
      // encolher esta lista DE PROPÓSITO, em vez de deixá-la mentindo.
      const todas = FALTA_NOS_EXEMPLOS[compose]!;
      const aindaNecessaria = todas.filter(
        (k) =>
          reprovadas(contract, effectiveEnv(compose, { add: todas.filter((o) => o !== k) }), true)
            .length > 0,
      );
      expect(
        aindaNecessaria,
        `${compose}: alguma chave de FALTA_NOS_EXEMPLOS já não é necessária — os exemplos ` +
          'melhoraram (ou o contrato afrouxou) e a lista ficou para trás.',
      ).toEqual([...todas]);
    },
  );

  it('nenhuma chave do gap está DECLARADA nos .prod.example — nem preenchida, nem em branco', () => {
    // O outro lado da mesma verdade, dito sobre o ARQUIVO e não sobre o
    // loader: `parseEnvFile` ignora comentários, então as quatro `OIDC_*` que
    // existem comentadas em `.env.admin.prod.example` contam como ausentes —
    // que é o que elas são para um container.
    const declaradas = SERVICES.flatMap(({ compose }) =>
      exampleFilesOf(compose).flatMap((file) =>
        Object.keys(parseEnvFile(file))
          .filter((k) => FALTA_NOS_EXEMPLOS[compose]!.includes(k))
          .map((k) => `${compose}: ${k}`),
      ),
    ).sort();
    expect(declaradas).toEqual([]);
  });
});
