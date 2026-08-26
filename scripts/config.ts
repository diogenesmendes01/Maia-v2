#!/usr/bin/env tsx
/**
 * `maia config` — generate, check and initialise Maia configuration (issue #515).
 *
 *   npm run config:generate                 # write every generated artifact
 *   npm run config:check:drift              # fail if an artifact is stale
 *   npm run config:check -- --profile production --env-file .env [--json]
 *   npm run config:check -- --env-file .env.example --allow-placeholders
 *   npm run config:init -- --profile development [--out .env] [--force]
 *   npm run config:preflight                # bring-up do compose, ANTES do `up`
 *   npm run config:preflight -- --compose compose.prod.yml --infra .env.infra
 *
 * This script NEVER prints a secret value: everything it emits comes from the
 * validator, which redacts by construction, from the contract's metadata, or —
 * for `preflight` — from errors that carry only FILE, LINE, structural PATH and
 * variable NAME.
 *
 * That last clause is load-bearing and was not free: `ComposeParseError` used to
 * echo the offending compose LINE, and the shape helpers serialised the node
 * with `JSON.stringify`. A `--compose` file with a literal secret on a
 * malformed line therefore printed that secret to stderr and into the `--json`
 * output (review of PR #595). `tests/unit/config/compose-env-fidelity.spec.ts`
 * runs THIS CLI with a canary value and asserts its absence from stdout, stderr
 * and the JSON.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { MAIA_PROFILES, type MaiaProfile } from '@/config/metadata.js';
import {
  buildJsonSchema,
  renderConfigDoc,
  renderEnvExample,
  renderEnvTemplate,
  renderFixture,
} from '@/config/generate.js';
import { parseEnvFile } from '@/config/env-file.js';
import { runPreflight, type PreflightServiceReport } from '@/config/preflight.js';
import { buildServiceManifest } from '@/config/services.js';
import { formatHuman, formatJson, validateConfig } from '@/config/validate.js';
import { isMaiaProfile } from '@/config/profiles.js';

const ROOT = process.cwd();

interface Artifact {
  readonly path: string;
  readonly content: string;
}

/** Every generated artifact, in a stable order. */
function artifacts(): Artifact[] {
  const out: Artifact[] = [
    { path: '.env.example', content: renderEnvExample() },
    { path: 'docs/configuration.md', content: renderConfigDoc() },
    {
      path: 'src/config/generated/env-schema.json',
      content: `${JSON.stringify(buildJsonSchema(), null, 2)}\n`,
    },
    {
      path: 'src/config/generated/service-env-manifest.json',
      content: `${JSON.stringify(buildServiceManifest(MAIA_PROFILES), null, 2)}\n`,
    },
  ];
  for (const profile of MAIA_PROFILES) {
    out.push({
      path: `src/config/generated/fixtures/${profile}.env`,
      content: renderFixture(profile),
    });
  }
  return out;
}

function readIfExists(absPath: string): string | null {
  return existsSync(absPath) ? readFileSync(absPath, 'utf8') : null;
}

/**
 * The repo has no `.gitattributes` and Windows checkouts run with
 * `core.autocrlf=true`, so a committed LF artifact lands on disk as CRLF.
 * Comparing normalised text keeps the drift check meaningful on every platform
 * (artifacts are always WRITTEN with LF).
 */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function cmdGenerate(check: boolean): number {
  const stale: string[] = [];
  for (const artifact of artifacts()) {
    const abs = resolve(ROOT, artifact.path);
    const current = readIfExists(abs);
    if (current !== null && normalizeEol(current) === artifact.content) continue;
    if (check) {
      stale.push(artifact.path);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, artifact.content, 'utf8');
    console.log(`  escrito  ${relative(ROOT, abs)}`);
  }
  if (check) {
    if (stale.length === 0) {
      console.log('config: artefatos gerados estão em dia.');
      return 0;
    }
    console.error('config: artefatos gerados DESATUALIZADOS:');
    for (const p of stale) console.error(`  - ${p}`);
    console.error('\nRode `npm run config:generate` e commite o resultado.');
    return 1;
  }
  console.log('config: artefatos gerados.');
  return 0;
}

function cmdCheck(args: Map<string, string | true>): number {
  const envFile = typeof args.get('env-file') === 'string' ? (args.get('env-file') as string) : '.env';
  const abs = resolve(ROOT, envFile);
  const content = readIfExists(abs);
  if (content === null) {
    console.error(`config: arquivo não encontrado: ${envFile}`);
    console.error('Rode `npm run config:init -- --profile development` para criar um a partir do contrato.');
    return 1;
  }
  const env = parseEnvFile(content);

  const rawProfile = args.get('profile');
  if (typeof rawProfile === 'string' && !isMaiaProfile(rawProfile)) {
    console.error(`config: profile inválido "${rawProfile}". Use: ${MAIA_PROFILES.join(', ')}.`);
    return 1;
  }
  const profile = typeof rawProfile === 'string' ? (rawProfile as MaiaProfile) : undefined;

  const result = validateConfig({
    env,
    profile,
    allowPlaceholders: args.get('allow-placeholders') === true,
    allowSyntheticFixtures: args.get('allow-fixtures') === true,
  });

  console.log(args.get('json') === true ? formatJson(result) : formatHuman(result));
  return result.ok ? 0 : 1;
}

function cmdInit(args: Map<string, string | true>): number {
  const rawProfile = args.get('profile') ?? 'development';
  if (typeof rawProfile !== 'string' || !isMaiaProfile(rawProfile)) {
    console.error(`config: profile inválido. Use: ${MAIA_PROFILES.join(', ')}.`);
    return 1;
  }
  const out = typeof args.get('out') === 'string' ? (args.get('out') as string) : '.env';
  const abs = resolve(ROOT, out);
  if (existsSync(abs) && args.get('force') !== true) {
    console.error(`config: ${out} já existe. Use --force para sobrescrever (você perde o conteúdo atual).`);
    return 1;
  }
  // NEVER the CI fixtures. `config init` used to write
  // `src/config/generated/fixtures/<profile>.env` for staging/production, so a
  // `.env` full of `sk-ant-fixture-*` values passed the very `config check`
  // printed below — a production configuration that authenticates against
  // nothing, certified as valid (PR #522 review round 1 [P1]). The operational
  // template marks every value the operator owns with `__SET_ME__`, which the
  // strict check rejects until it is replaced.
  const content = renderEnvTemplate(rawProfile);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  console.log(`config: ${out} criado a partir do contrato (profile ${rawProfile}).`);
  console.log('Todo valor __SET_ME__ é seu. A validação FALHA até você preenchê-los:');
  console.log(`  npm run config:check -- --profile ${rawProfile} --env-file ${out}`);
  return 0;
}

/**
 * Preflight de bring-up (issue #572) — o passo que `docs/runbooks/deploy-prod.md`
 * §1 manda rodar ANTES do `docker compose up`.
 *
 * Por que não basta `config check --env-file .env.app`: metade do ambiente do
 * `app` (e do `admin-ui`) vem do `environment:` do compose, interpolado do
 * `.env.infra`. Checar só o env file acusa como ausente o que o compose injeta
 * e não vê o que o compose sobrescreve — falso positivo dos dois lados. Aqui as
 * DUAS fontes são compostas na precedência do Compose, e cada serviço é
 * validado com o subset do SEU loader (`src/config/preflight.ts`).
 *
 * O que ele NÃO cobre está documentado em `src/config/preflight.ts` e no
 * runbook: liveness (nada conecta em Postgres/Redis/S3/IdP) e os gates de boot
 * próprios do admin-ui, que são mais estritos que o contrato.
 */
function cmdPreflight(args: Map<string, string | true>): number {
  const composeArg =
    typeof args.get('compose') === 'string' ? (args.get('compose') as string) : 'compose.prod.yml';
  const infraArg =
    typeof args.get('infra') === 'string' ? (args.get('infra') as string) : '.env.infra';

  const composeAbs = resolve(ROOT, composeArg);
  const composeText = readIfExists(composeAbs);
  if (composeText === null) {
    console.error(`config preflight: arquivo de compose não encontrado: ${composeArg}`);
    return 1;
  }
  const infraAbs = resolve(ROOT, infraArg);
  const infraText = readIfExists(infraAbs);
  if (infraText === null) {
    console.error(`config preflight: arquivo de interpolação não encontrado: ${infraArg}`);
    console.error(
      'Ele é o mesmo `--env-file` do `docker compose` (POSTGRES_*, REDIS_PASSWORD, MAIA_ENV) — ' +
        'ver docs/runbooks/deploy-prod.md §1.',
    );
    return 1;
  }

  const rawProfile = args.get('profile');
  if (typeof rawProfile === 'string' && !isMaiaProfile(rawProfile)) {
    console.error(`config: profile inválido "${rawProfile}". Use: ${MAIA_PROFILES.join(', ')}.`);
    return 1;
  }

  // `env_file` é relativo ao diretório do arquivo de compose, como no Compose.
  const composeDir = dirname(composeAbs);
  let report;
  try {
    report = runPreflight({
      composeText,
      composeLabel: composeArg,
      infraText,
      profile: typeof rawProfile === 'string' ? (rawProfile as MaiaProfile) : undefined,
      // O preflight é HERMÉTICO: `process.env` NÃO interpola nada. Ele entra
      // só para DETECTAR que o shell sequestraria uma variável do `.env.infra`
      // — o `docker compose` dá precedência ao ambiente exportado sobre o
      // `--env-file`, então uma `MAIA_ENV` exportada faria o `up` produzir um
      // ambiente diferente do certificado aqui (review de PR #595).
      shellEnv: process.env,
      readEnvFile: (name) => {
        const abs = resolve(composeDir, name);
        const content = readIfExists(abs);
        if (content === null) {
          // Um `env_file` declarado e ausente é falha de bring-up, não ambiente
          // vazio: o `docker compose up` também aborta.
          throw new Error(
            `env_file declarado no compose não existe: ${name} (procurado em ${abs}). ` +
              'Rode o `cp` do .prod.example correspondente — ver docs/runbooks/deploy-prod.md §1.',
          );
        }
        return content;
      },
    });
  } catch (err) {
    // Compose ilegível, ou serviço sem classificação no preflight: os dois são
    // erro do preflight, não de configuração do operador.
    console.error(`config preflight: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (args.get('json') === true) {
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          compose: composeArg,
          // Nomes das variáveis, nunca valores — nem do shell, nem do arquivo.
          shell_divergence: report.shellDivergence,
          services: report.services.map((s: PreflightServiceReport) => ({
            compose_service: s.target.compose,
            contract_services: s.target.contracts,
            env_files: s.target.envFiles,
            ...(s.failure !== undefined
              ? { ok: false, failure: s.failure }
              : {
                  ok:
                    s.bootGateProblems.length === 0 && s.contracts.every((c) => c.result.ok),
                  contracts: s.contracts.map((c) => ({
                    contract_service: c.contract,
                    ok: c.result.ok,
                    profile: c.result.profile,
                    config_hash: c.result.configHash,
                    errors: c.result.errors,
                    warnings: c.result.warnings,
                  })),
                  boot_gate_problems: s.bootGateProblems,
                }),
          })),
        },
        null,
        2,
      ),
    );
    return report.ok ? 0 : 1;
  }

  console.log(`Maia config preflight — ${composeArg} (interpolação: ${infraArg})`);
  if (report.shellDivergence.length > 0) {
    console.log('');
    console.log('── ambiente do shell');
    console.log(
      '  DIVERGÊNCIA: as variáveis abaixo estão EXPORTADAS no seu shell e o `docker compose` dá',
    );
    console.log(
      '  precedência a ele sobre o `--env-file`. O ambiente certificado abaixo NÃO é o que o `up`',
    );
    console.log('  produziria neste terminal.');
    for (const d of report.shellDivergence) {
      console.log(
        `    ${d.variable} — ${d.absentFromInfra ? `ausente de ${infraArg}` : `difere de ${infraArg}`}`,
      );
    }
    console.log(
      `  Conserte de um jeito só: \`unset\` a variável no shell, ou alinhe ${infraArg} com ela.`,
    );
  }
  for (const s of report.services) {
    const files = s.target.envFiles.length > 0 ? s.target.envFiles.join(', ') : '(nenhum)';
    console.log('');
    console.log(
      `── serviço ${s.target.compose} → loaders ${s.target.contracts.join(' + ')} · env_file: ${files}`,
    );
    if (s.failure !== undefined) {
      console.log(`  FALHA ANTES DA VALIDAÇÃO: ${s.failure}`);
      continue;
    }
    for (const c of s.contracts) {
      console.log(`  · subset ${c.contract}`);
      console.log(`    ${formatHuman(c.result)}`.replace(/\n/g, '\n    '));
    }
    if (s.target.adminBootGates) {
      console.log('  · gates de boot do admin-ui (src/admin-ui/lib/auth-gating.ts)');
      if (s.bootGateProblems.length === 0) {
        console.log('    OK: comprimentos e padrões aceitos (isto NÃO testa o IdP).');
      } else {
        for (const g of s.bootGateProblems) {
          console.log(`    ${g.variable} [${g.rule}]: ${g.message}`);
          console.log(`      → ${g.remediation}`);
        }
      }
    }
  }
  console.log('');
  if (report.ok) {
    console.log(
      'OK: os ambientes efetivos satisfazem TODOS os subsets do contrato que cada container avalia,',
    );
    console.log('e os gates de boot próprios do admin-ui.');
    console.log(
      'Isto NÃO testa conectividade (Postgres/Redis/S3/IdP) — ver docs/runbooks/deploy-prod.md §1, ' +
        '"O que o preflight NÃO cobre".',
    );
    return 0;
  }
  console.error('');
  console.error(
    'FALHOU: o `docker compose up` subiria containers que reprovam no boot. Corrija acima ANTES do `up`.',
  );
  return 1;
}

function parseArgs(argv: string[]): { command: string; args: Map<string, string | true> } {
  const [command = 'help', ...rest] = argv;
  const args = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, true);
    }
  }
  return { command, args };
}

function usage(): void {
  console.log(
    [
      'maia config <comando>',
      '',
      '  generate                         regenera .env.example, docs/configuration.md,',
      '                                   o JSON Schema, o manifest por serviço e as fixtures',
      '  generate --check                 falha se algum artefato estiver desatualizado',
      '  check [--profile P] [--env-file F] [--json] [--allow-placeholders]',
      '        [--allow-fixtures]',
      '                                   valida um arquivo de ambiente contra o contrato.',
      '                                   --allow-placeholders: modo estrutural (checa o',
      '                                   .env.example, que traz placeholders de propósito).',
      '                                   --allow-fixtures: aceita os valores sintéticos de',
      '                                   src/config/generated/fixtures/ — só para validar',
      '                                   ESSES arquivos, nunca um ambiente real.',
      '  preflight [--compose F] [--infra F] [--profile P] [--json]',
      '                                   compõe, para CADA serviço do compose, o `env_file` +',
      '                                   o `environment:` interpolado do .env.infra, e valida o',
      '                                   ambiente EFETIVO contra o subset do loader daquele',
      '                                   serviço. Roda ANTES do `up`: falha aqui em vez de no',
      '                                   boot do container. NÃO testa conectividade.',
      '  init [--profile P] [--out F] [--force]',
      '                                   cria um ponto de partida operacional: todo valor',
      '                                   que é do operador vem como __SET_ME__ e a',
      '                                   validação estrita FALHA até ser preenchido',
      '',
      `  P ∈ {${MAIA_PROFILES.join(', ')}}`,
    ].join('\n'),
  );
}

function main(): number {
  const { command, args } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'generate':
      return cmdGenerate(args.get('check') === true);
    case 'check':
      return cmdCheck(args);
    case 'init':
      return cmdInit(args);
    case 'preflight':
      return cmdPreflight(args);
    default:
      usage();
      return command === 'help' ? 0 : 1;
  }
}

process.exitCode = main();
