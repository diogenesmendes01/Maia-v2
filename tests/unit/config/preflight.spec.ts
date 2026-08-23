/**
 * `npm run config:preflight` — o passo que `docs/runbooks/deploy-prod.md` §1
 * manda rodar ANTES do `docker compose up` (issue #572).
 *
 * A propriedade central está no primeiro caso e vale a pena dizê-la em voz
 * alta: rodando o preflight sobre os `.prod.example` CRUS — sem nenhum
 * preenchimento — toda reprova é sobre uma chave que o próprio exemplo deixa
 * PARA O OPERADOR (vazia, `__SET_ME__` ou terminada em `...`). Nenhuma reprova
 * sobra sem dono. É essa a diferença entre o estado anterior e o atual: até a
 * #572, `BACKUP_S3_BUCKET` e as quatro `OIDC_*` reprovavam sem aparecer em
 * lugar nenhum do arquivo, e o operador só descobria no boot do container.
 *
 * O caso é escrito ASSIM — sobre o arquivo cru, e não sobre uma cópia
 * preenchida — de propósito: preencher exige uma tabela de valores escrita no
 * teste, e uma tabela dessas mascara justamente o defeito que se quer pegar
 * (uma chave ausente do exemplo entra pela tabela e some do vermelho). Sem
 * preenchimento não há o que mascarar.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPreflight, type PreflightServiceReport } from '@/config/preflight.js';
import {
  composeInterpolationRefs,
  envFileNamesOf,
  parseComposeText,
} from '@/config/compose-env.js';
import { parseEnvFile } from '@/config/env-file.js';
import { entriesForService } from '@/config/contract.js';
import {
  MIN_NEXTAUTH_SECRET_LEN,
  MIN_OIDC_CLIENT_SECRET_LEN,
} from '@/config/admin-boot-gates.js';
import type { ConfigProblem } from '@/config/metadata.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const COMPOSE = resolve(REPO_ROOT, 'compose.prod.yml');
const COMPOSE_TEXT = readFileSync(COMPOSE, 'utf8');

/** O `.env.infra` do runbook §1 — só interpolação, nunca injetado. */
const INFRA_TEXT = [
  'POSTGRES_USER=maia_prod',
  'POSTGRES_PASSWORD=f4kepassw0rdf4ke',
  'POSTGRES_DB=maia',
  'REDIS_PASSWORD=f4keredispass',
  'MAIA_ENV=production',
  '',
].join('\n');

/** `.env.app` ⇒ `.env.app.prod.example`, exatamente como o runbook manda copiar. */
function readExampleFor(name: string): string {
  return readFileSync(resolve(REPO_ROOT, `${name}.prod.example`), 'utf8');
}

function preflightSobreOsExemplos(
  overrides: Readonly<Record<string, string>> = {},
  opts: { readonly drop?: readonly string[] } = {},
) {
  return runPreflight({
    composeText: COMPOSE_TEXT,
    composeLabel: 'compose.prod.yml',
    infraText: INFRA_TEXT,
    readEnvFile: (name) => {
      const text = dropKeys(readExampleFor(name), opts.drop ?? []);
      const extra = Object.entries(overrides)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
      return extra === '' ? text : `${text}\n${extra}\n`;
    },
  });
}

/**
 * Apaga a LINHA de uma chave num env file, como um operador que edita o
 * arquivo. Não é `delete` sobre o mapa parseado de propósito: o que se quer
 * medir é o arquivo que o container recebe.
 */
function dropKeys(text: string, keys: readonly string[]): string {
  if (keys.length === 0) return text;
  return text
    .split('\n')
    .filter((line) => !keys.some((k) => new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=`).test(line)))
    .join('\n');
}

/** Todos os problemas de contrato de um serviço, de TODOS os subsets que ele avalia. */
function errosDeContrato(s: PreflightServiceReport): ConfigProblem[] {
  return s.contracts.flatMap((c) => [...c.result.errors]);
}

function servico(report: { services: readonly PreflightServiceReport[] }, name: string) {
  return report.services.find((s) => s.target.compose === name)!;
}

/** Chaves que o exemplo de um serviço deixa para o operador preencher. */
function operatorOwnedKeys(composeService: string): Set<string> {
  const compose = parseComposeText(COMPOSE_TEXT, 'compose.prod.yml');
  const out = new Set<string>();
  for (const name of envFileNamesOf(compose, composeService)) {
    for (const [key, value] of Object.entries(parseEnvFile(readExampleFor(name)))) {
      if (value === '' || value.includes('__SET_ME__') || value.endsWith('...')) out.add(key);
    }
  }
  return out;
}

describe('config preflight — os .prod.example não escondem nenhuma chave (issue #572)', () => {
  it('cobre os três serviços do compose, com TODOS os loaders que cada um avalia', () => {
    const report = preflightSobreOsExemplos();
    expect(
      report.services.map((s) => ({
        compose: s.target.compose,
        contracts: [...s.target.contracts],
        envFiles: [...s.target.envFiles],
        adminBootGates: s.target.adminBootGates,
      })),
    ).toEqual([
      { compose: 'migrate', contracts: ['migrator'], envFiles: [], adminBootGates: false },
      { compose: 'app', contracts: ['runtime'], envFiles: ['.env.app'], adminBootGates: false },
      // DOIS subsets: o boot do console importa `@/config/env.js` e valida
      // `runtime`, e o subset `admin-ui` só é avaliado aqui. Um só deles é o
      // falso verde do achado [Alta] nº 1 da review de PR #595.
      {
        compose: 'admin-ui',
        contracts: ['runtime', 'admin-ui'],
        envFiles: ['.env.admin'],
        adminBootGates: true,
      },
    ]);
  });

  it('o migrator passa sem env_file nenhum — todo o ambiente dele vem do compose', () => {
    const migrate = servico(preflightSobreOsExemplos(), 'migrate');
    expect(migrate.failure).toBeUndefined();
    expect(errosDeContrato(migrate)).toEqual([]);
  });

  it.each(['app', 'admin-ui'])(
    'em %s, TODA reprova sobre o exemplo cru é de uma chave que o exemplo deixa ao operador',
    (composeService) => {
      const doOperador = operatorOwnedKeys(composeService);
      const s = servico(preflightSobreOsExemplos(), composeService);
      expect(s.failure).toBeUndefined();
      // `variable: null` são regras cross-field cujo insumo é uma das chaves
      // acima (ex.: `embeddings/provider-key`, que dispara porque
      // VOYAGE_API_KEY está vazia no exemplo). Elas somem junto quando o
      // operador preenche, e não têm nome próprio para conferir aqui.
      const semDono = errosDeContrato(s)
        .filter((e) => e.variable !== null && !doOperador.has(e.variable))
        .map((e) => `${e.variable} [${e.rule}]`)
        .sort();
      expect(
        semDono,
        `${composeService}: o preflight reprova em chave(s) que o .prod.example não menciona. ` +
          'Era exatamente esse o defeito da issue #572 (BACKUP_* e OIDC_*): o operador copia o ' +
          'exemplo, preenche tudo que vê, e o container reprova no boot mesmo assim.',
      ).toEqual([]);
      // E o exemplo tem que estar reprovando ALGO — senão este caso passaria
      // sobre um arquivo que não exige nada do operador, e não provaria nada.
      expect(errosDeContrato(s).length).toBeGreaterThan(0);
    },
  );

  it('OIDC_TENANT_SLUGS=default é reprovado pelo preflight, com a regra nomeada', () => {
    // O slug vai direto para `appUsersRepo.getByEmail(tenant, email)` em
    // src/admin-ui/lib/auth-resolver.ts — ele É o tenant_id (AGENTS.md §4).
    const s = servico(preflightSobreOsExemplos({ OIDC_TENANT_SLUGS: 'default' }), 'admin-ui');
    expect(errosDeContrato(s).map((e) => e.rule)).toContain('admin-ui/tenant-slugs-default-literal');
  });

  it('um .env.infra sem MAIA_ENV falha ANTES da validação, nos três serviços', () => {
    // Mesmo ponto em que o `docker compose up` aborta, e pelo mesmo motivo:
    // `${MAIA_ENV:?…}` não tem default.
    const report = runPreflight({
      composeText: COMPOSE_TEXT,
      composeLabel: 'compose.prod.yml',
      infraText: INFRA_TEXT.replace('MAIA_ENV=production\n', ''),
      readEnvFile: readExampleFor,
    });
    expect(report.ok).toBe(false);
    expect(report.services.map((s) => s.failure !== undefined)).toEqual([true, true, true]);
    expect(report.services[0]!.failure).toMatch(/MAIA_ENV is required/);
  });

  it('um env_file declarado e ausente é FALHA, não ambiente vazio', () => {
    // Um `readEnvFile` que devolvesse '' faria o preflight reprovar por
    // "variável obrigatória ausente" — mensagem que manda o operador editar um
    // arquivo que ele nem criou. O `docker compose up` também aborta aqui.
    const report = runPreflight({
      composeText: COMPOSE_TEXT,
      composeLabel: 'compose.prod.yml',
      infraText: INFRA_TEXT,
      readEnvFile: (name) => {
        throw new Error(`env_file declarado no compose não existe: ${name}`);
      },
    });
    expect(report.ok).toBe(false);
    const app = servico(report, 'app');
    expect(app.failure).toMatch(/\.env\.app/);
    expect(app.contracts).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Os dois canários da review de PR #595, achado [Alta] nº 1
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Os dois medem a MESMA propriedade por dois lados: o preflight tem de
  // reprovar tudo que derruba o container do console no boot, e o container
  // avalia mais coisa do que o subset `admin-ui`.

  /**
   * Chaves que o `.env.admin.prod.example` declara com valor REAL (não
   * `__SET_ME__`, não vazio), que vivem SÓ no subset `runtime` — fora do
   * subset `admin-ui` — e que o contrato EXIGE no profile production.
   *
   * São exatamente as que, removidas do `.env.admin`, passavam despercebidas:
   * o preflight validava `admin-ui` e nem olhava para elas; o boot valida
   * `runtime` e morre. A lista é DERIVADA do contrato de propósito: escrita à
   * mão, ela envelheceria em silêncio.
   *
   * O filtro `requiredIn` não é cosmético: uma chave somente-runtime COM
   * default (`LLM_PROVIDER`, `ALERT_CHANNELS`) some do arquivo sem reprovar
   * nada — e deve ser assim. O canário mede o que o container exige, não o
   * que o arquivo escreve.
   */
  function somenteRuntimeNoExemploDoAdmin(): string[] {
    const doAdmin = new Set(entriesForService('admin-ui').map((e) => e.name));
    const exigidasEmProd = new Set(
      entriesForService('runtime')
        .filter((e) => e.requiredIn?.includes('production') === true)
        .map((e) => e.name),
    );
    const noArquivo = parseEnvFile(readExampleFor('.env.admin'));
    return Object.entries(noArquivo)
      .filter(
        ([k, v]) =>
          exigidasEmProd.has(k) && !doAdmin.has(k) && v !== '' && !v.includes('__SET_ME__'),
      )
      .map(([k]) => k)
      .sort();
  }

  it('há chaves SOMENTE-runtime com valor real no .env.admin — senão o canário abaixo não mede nada', () => {
    expect(somenteRuntimeNoExemploDoAdmin().length).toBeGreaterThan(0);
  });

  it.each(somenteRuntimeNoExemploDoAdmin())(
    'CANÁRIO: tirar %s (somente-runtime) do .env.admin REPROVA o preflight do admin-ui',
    (chave) => {
      // O delta, e não o valor absoluto: o exemplo CRU já reprova nos
      // `__SET_ME__` que ele deixa ao operador. O que este caso afirma é que
      // remover a linha ACRESCENTA uma reprova nomeada — o que só acontece
      // porque o preflight agora roda o subset `runtime` no serviço `admin-ui`.
      const antes = new Set(
        errosDeContrato(servico(preflightSobreOsExemplos(), 'admin-ui')).map((e) => e.variable),
      );
      const depois = errosDeContrato(
        servico(preflightSobreOsExemplos({}, { drop: [chave] }), 'admin-ui'),
      ).map((e) => e.variable);
      expect(antes.has(chave)).toBe(false);
      expect(
        depois,
        `${chave} sumiu do .env.admin e o preflight do admin-ui continuou sem reprová-la. ` +
          'O container do console valida o subset `runtime` no boot (ele importa @/config/env.js), ' +
          'então este verde é o container caindo em produção.',
      ).toContain(chave);
    },
  );

  it('CANÁRIO: secrets que PASSAM no contrato e FALHAM no gate de boot reprovam o preflight', () => {
    // Comprimentos escolhidos na fresta exata entre os dois validadores:
    //   NEXTAUTH_SECRET     — contrato: min(8). Gate: >= 32.
    //   OIDC_CLIENT_SECRET  — contrato: só presença. Gate: >= 16.
    // Valores derivados (repeat), não literais: baixa entropia de propósito,
    // para não parecerem segredo para o scanner nem para quem lê.
    const nextauth = 'n'.repeat(MIN_NEXTAUTH_SECRET_LEN - 20);
    const clientSecret = 'c'.repeat(MIN_OIDC_CLIENT_SECRET_LEN - 8);
    expect(nextauth.length).toBeLessThan(MIN_NEXTAUTH_SECRET_LEN);
    expect(clientSecret.length).toBeLessThan(MIN_OIDC_CLIENT_SECRET_LEN);

    const report = preflightSobreOsExemplos({
      NEXTAUTH_SECRET: nextauth,
      OIDC_CLIENT_SECRET: clientSecret,
      // O gate de OIDC só roda com issuer presente, como no boot real.
      OIDC_ISSUER: 'https://idp.example.com/realms/maia',
      OIDC_CLIENT_ID: 'maia-admin',
      OIDC_TENANT_SLUGS: 'primary',
    });
    const s = servico(report, 'admin-ui');

    // A metade que dá o nome ao canário: o CONTRATO aceita os dois valores.
    const reprovadasNoContrato = errosDeContrato(s).map((e) => e.variable);
    expect(reprovadasNoContrato).not.toContain('NEXTAUTH_SECRET');
    expect(reprovadasNoContrato).not.toContain('OIDC_CLIENT_SECRET');

    // E o preflight reprova assim mesmo, pelos gates de boot do console.
    expect(s.bootGateProblems.map((g) => g.variable).sort()).toEqual([
      'NEXTAUTH_SECRET',
      'OIDC_CLIENT_SECRET',
    ]);
    expect(report.ok).toBe(false);

    // Comprimento é evidência; valor nunca é.
    const serializado = JSON.stringify(s.bootGateProblems);
    expect(serializado).not.toContain(nextauth);
    expect(serializado).not.toContain(clientSecret);
  });

  it('os gates de boot NÃO reprovam quando os comprimentos são aceitos', () => {
    const s = servico(
      preflightSobreOsExemplos({
        NEXTAUTH_SECRET: 'n'.repeat(MIN_NEXTAUTH_SECRET_LEN + 8),
        OIDC_ISSUER: 'https://idp.example.com/realms/maia',
        OIDC_CLIENT_ID: 'maia-admin',
        OIDC_CLIENT_SECRET: 'c'.repeat(MIN_OIDC_CLIENT_SECRET_LEN + 8),
        OIDC_TENANT_SLUGS: 'primary',
      }),
      'admin-ui',
    );
    expect(s.bootGateProblems).toEqual([]);
  });

  it('o `__SET_ME__` do exemplo cru já é reprovado pelos gates, e não só pelo contrato', () => {
    // O `.env.admin.prod.example` traz NEXTAUTH_SECRET=__SET_ME__…: o gate
    // recusa por comprimento OU por padrão de placeholder. Sem este caso, o
    // canário acima poderia estar medindo um gate que nunca dispara sozinho.
    const s = servico(preflightSobreOsExemplos(), 'admin-ui');
    expect(s.bootGateProblems.map((g) => g.variable)).toContain('NEXTAUTH_SECRET');
  });

  it('um shell que sequestraria uma variável de interpolação REPROVA o preflight', () => {
    // `docker compose` dá precedência ao ambiente exportado sobre o
    // `--env-file`. Um MAIA_ENV=staging exportado faria o `up` produzir um
    // ambiente diferente do certificado aqui (review de PR #595, [Média]).
    const report = runPreflight({
      composeText: COMPOSE_TEXT,
      composeLabel: 'compose.prod.yml',
      infraText: INFRA_TEXT,
      readEnvFile: readExampleFor,
      shellEnv: { MAIA_ENV: 'staging', PATH: '/usr/bin' },
    });
    expect(report.shellDivergence).toEqual([{ variable: 'MAIA_ENV', absentFromInfra: false }]);
    expect(report.ok).toBe(false);
    // `PATH` não é referenciado pelo compose: não é divergência.
    expect(report.shellDivergence.map((d) => d.variable)).not.toContain('PATH');
  });

  it('uma variável citada só num COMENTÁRIO do compose não é divergência', () => {
    // `compose.prod.yml` menciona `$HOME` num comentário sobre `tmpfs`. Uma
    // varredura TEXTUAL das referências reportava o HOME do shell em toda
    // execução — e um alarme falso permanente é um alarme que o operador
    // aprende a ignorar. O `docker compose` interpola valores de YAML, não
    // comentários; a varredura anda pela árvore parseada.
    expect(COMPOSE_TEXT).toMatch(/#[^\n]*\$HOME/);
    const report = runPreflight({
      composeText: COMPOSE_TEXT,
      composeLabel: 'compose.prod.yml',
      infraText: INFRA_TEXT,
      readEnvFile: readExampleFor,
      shellEnv: { HOME: '/root' },
    });
    expect(report.shellDivergence).toEqual([]);
  });

  it('uma variável referenciada só DENTRO de um `env_file` também é divergência', () => {
    // O buraco da rodada 1 (review de PR #595, [Média]): a checagem olhava só
    // `composeInterpolationRefs(compose)`. O ambiente efetivo também interpola
    // `${VAR}` dentro de cada `env_file`, e ali o mapa do projeto (`--env-file`
    // + shell) VENCE as chaves do próprio arquivo — logo um `DOMAIN` que só
    // aparece no `.env.admin` é igualmente sequestrável, e o preflight saía
    // verde certificando outra `NEXTAUTH_URL` que a do `up`.
    // A premissa do caso: `DOMAIN` não é referência do YAML. Ele APARECE em
    // `compose.prod.yml`, mas dentro de um comentário sobre o roteamento —
    // exatamente o que a varredura pela árvore parseada ignora.
    expect(COMPOSE_TEXT).toMatch(/#[^\n]*\$\{DOMAIN\}/);
    expect([
      ...composeInterpolationRefs(parseComposeText(COMPOSE_TEXT, 'compose.prod.yml')),
    ]).not.toContain('DOMAIN');
    const report = runPreflight({
      composeText: COMPOSE_TEXT,
      composeLabel: 'compose.prod.yml',
      infraText: `${INFRA_TEXT}DOMAIN=example.com\n`,
      readEnvFile: (name) =>
        name === '.env.admin'
          ? `${readExampleFor(name)}\nNEXTAUTH_URL=https://\${DOMAIN}/admin\n`
          : readExampleFor(name),
      shellEnv: { DOMAIN: 'outro.example' },
    });
    expect(report.shellDivergence).toEqual([{ variable: 'DOMAIN', absentFromInfra: false }]);
    expect(report.ok).toBe(false);
    // Só o NOME. Nem o valor do shell nem o do arquivo entram no relatório.
    const serializado = JSON.stringify(report.shellDivergence);
    expect(serializado).not.toContain('outro.example');
    expect(serializado).not.toContain('example.com');
  });

  it('uma variável citada só num COMENTÁRIO de um `env_file` não é divergência', () => {
    // O mesmo alarme falso que a varredura da ÁRVORE evita no YAML, do lado do
    // `env_file`: o `dotenv.parse` descarta comentários e o Compose não
    // interpola nada ali. Os dois `.prod.example` do repositório citam
    // `${MAIA_ENV:?...}` em comentário — se a varredura fosse textual, todo
    // operador com essas variáveis exportadas levaria um vermelho eterno.
    const report = runPreflight({
      composeText: COMPOSE_TEXT,
      composeLabel: 'compose.prod.yml',
      infraText: INFRA_TEXT,
      readEnvFile: (name) => `${readExampleFor(name)}\n# NOTA: use \${SO_EM_COMENTARIO} aqui\n`,
      shellEnv: { SO_EM_COMENTARIO: 'qualquer' },
    });
    expect(report.shellDivergence).toEqual([]);
  });

  it('uma referência entre ASPAS SIMPLES num `env_file` não é divergência', () => {
    // O Compose não interpola valor entre aspas simples (provado contra o
    // `docker compose config` real em compose-config-differential.spec.ts), e
    // o shell não tem como sequestrar o que ninguém expande.
    const report = runPreflight({
      composeText: COMPOSE_TEXT,
      composeLabel: 'compose.prod.yml',
      infraText: INFRA_TEXT,
      readEnvFile: (name) => `${readExampleFor(name)}\nLITERAL='x \${SO_LITERAL} y'\n`,
      shellEnv: { SO_LITERAL: 'qualquer' },
    });
    expect(report.shellDivergence).toEqual([]);
  });

  it('um `env_file` AUSENTE vira falha nomeada do serviço, não crash da divergência', () => {
    // A varredura de referências lê os `env_file`. Se ela propagasse o erro de
    // leitura, um `.env.app` faltando trocaria a mensagem que diz qual arquivo
    // copiar por um stack trace do preflight.
    const report = runPreflight({
      composeText: COMPOSE_TEXT,
      composeLabel: 'compose.prod.yml',
      infraText: INFRA_TEXT,
      readEnvFile: (name) => {
        if (name === '.env.app') throw new Error(`env_file declarado no compose não existe: ${name}`);
        return readExampleFor(name);
      },
      shellEnv: { MAIA_ENV: 'staging' },
    });
    expect(servico(report, 'app').failure).toMatch(/\.env\.app/);
    // …e o que o YAML referencia continua sendo medido.
    expect(report.shellDivergence).toEqual([{ variable: 'MAIA_ENV', absentFromInfra: false }]);
  });

  it('um shell com o MESMO valor do .env.infra não é divergência', () => {
    const report = runPreflight({
      composeText: COMPOSE_TEXT,
      composeLabel: 'compose.prod.yml',
      infraText: INFRA_TEXT,
      readEnvFile: readExampleFor,
      shellEnv: { MAIA_ENV: 'production' },
    });
    expect(report.shellDivergence).toEqual([]);
  });

  it('um serviço novo, sem classificação, LANÇA em vez de sair do preflight em silêncio', () => {
    const comServicoNovo = `${COMPOSE_TEXT.replace(
      /\nservices:\n/,
      '\nservices:\n  relatorios:\n    image: exemplo/relatorios:1\n',
    )}`;
    expect(() =>
      runPreflight({
        composeText: comServicoNovo,
        composeLabel: 'compose.prod.yml',
        infraText: INFRA_TEXT,
        readEnvFile: readExampleFor,
      }),
    ).toThrow(/relatorios/);
  });
});
