#!/usr/bin/env tsx
/**
 * `maia config` — generate, check and initialise Maia configuration (issue #515).
 *
 *   npm run config:generate                 # write every generated artifact
 *   npm run config:check:drift              # fail if an artifact is stale
 *   npm run config:check -- --profile production --env-file .env [--json]
 *   npm run config:check -- --env-file .env.example --allow-placeholders
 *   npm run config:init -- --profile development [--out .env] [--force]
 *
 * This script NEVER prints a secret value: everything it emits comes from the
 * validator, which redacts by construction, or from the contract's metadata.
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
    default:
      usage();
      return command === 'help' ? 0 : 1;
  }
}

process.exitCode = main();
