#!/usr/bin/env tsx
/**
 * `maia doctor` — read-only preflight and diagnosis (issue #517).
 *
 * A THIN adapter, in the same spirit as `scripts/migrate.ts`: it parses argv,
 * opens the read-only handles, prints, and chooses an exit code. Every verdict
 * comes from `src/ops/doctor/`.
 *
 * ```bash
 * npm run doctor                            # offline: runtime + config only
 * npm run doctor -- --online                # + Postgres and Redis liveness
 * npm run doctor -- --online --format json
 * npm run doctor -- --online --strict       # warnings also exit 1
 * npm run doctor -- --only postgres --online
 * npm run doctor -- --skip redis.persistence --online
 * ```
 *
 * ── Exit codes ──────────────────────────────────────────────────────────────
 *   0  pronto (warnings permitidos; com `--strict`, nenhum warning)
 *   1  há pelo menos um bloqueador
 *   2  uso inválido, ou o próprio doctor quebrou
 *
 * `2` never means "the environment is unhealthy" — a pipeline gating on the
 * doctor must treat it as "the gate did not run", not as a pass or a fail.
 *
 * ── Why this file reads `process.env` directly ──────────────────────────────
 * Every other entry point loads its configuration through `loadServiceConfig`,
 * which THROWS on an invalid environment. The doctor must not: an invalid
 * environment is the thing it exists to REPORT. So it takes the raw snapshot,
 * hands it to `validateConfig()` inside `config.contract`, and uses the two
 * DSNs opportunistically — a missing one becomes a `skip`, never a crash.
 *
 * ── What this command never does ────────────────────────────────────────────
 * No writes, anywhere. No `checkAll()` (which inserts a health row per
 * component — `src/lib/healthcheck.ts`), no `audit()`, no BullMQ job, no
 * WhatsApp socket, no migration, no file created or repaired. The Postgres
 * handle runs everything inside `BEGIN READ ONLY` and the Redis handle refuses
 * any command outside a four-entry allowlist.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import IORedis from 'ioredis';
import pg from 'pg';
import { MAIA_PROFILES, type MaiaProfile, type MaiaService } from '@/config/metadata.js';
import { isMaiaProfile, resolveProfile } from '@/config/profiles.js';
import { MAIA_SERVICES } from '@/config/metadata.js';
import { getSchemaReadiness, type ReadOnlyPool } from '@/migrations/index.js';
import {
  DOCTOR_CATEGORIES,
  DEFAULT_TOTAL_DEADLINE_MS,
  checksForCategories,
  exitCodeFor,
  isDoctorCategory,
  doctorPostgresPool,
  readOnlyPostgres,
  readOnlyRedis,
  renderHuman,
  renderJson,
  runDoctor,
  type DoctorCategory,
  type DoctorContext,
  type DoctorReportMeta,
} from '@/ops/doctor/index.js';

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, 'migrations');

export interface DoctorCliOptions {
  readonly profile?: MaiaProfile;
  readonly service: MaiaService;
  readonly online: boolean;
  readonly strict: boolean;
  readonly verbose: boolean;
  readonly json: boolean;
  readonly timeoutMs: number;
  readonly only: readonly DoctorCategory[];
  readonly skip: readonly string[];
}

function usage(): string {
  return [
    'maia doctor — diagnóstico READ-ONLY do ambiente (issue #517)',
    '',
    'USO',
    '  npm run doctor -- [opções]',
    '',
    'OPÇÕES',
    '  --online                 abre conexões (Postgres, Redis). Sem isto, ZERO I/O de rede',
    '                           e todo check conectado retorna `skip` — nunca um falso `pass`.',
    `  --profile <p>            força o profile (${MAIA_PROFILES.join(' | ')}); default: resolvido do ambiente`,
    `  --service <s>            subset do contrato a validar (${MAIA_SERVICES.join(' | ')}); default: runtime`,
    '  --format <human|json>    formato de saída (ou use --json)',
    '  --strict                 warnings também produzem exit 1',
    '  --verbose                mostra a evidência também dos checks que passaram',
    `  --timeout <ms>           orçamento TOTAL da execução (default ${DEFAULT_TOTAL_DEADLINE_MS})`,
    `  --only <cats>            só estas categorias, separadas por vírgula (${DOCTOR_CATEGORIES.join(',')})`,
    '  --skip <ids>             desabilita checks por ID, separados por vírgula. O relatório marca',
    '                           cada um como SKIP com aviso visível — nunca sucesso silencioso.',
    '  --help                   esta ajuda',
    '',
    'EXIT CODES',
    '  0  pronto (warnings permitidos; com --strict, nenhum warning)',
    '  1  há pelo menos um bloqueador',
    '  2  uso inválido, ou falha interna do doctor — o gate NÃO rodou',
    '',
    'ESCOPO',
    '  O doctor é estritamente read-only: não escreve no Postgres (toda consulta roda',
    '  em `BEGIN READ ONLY`), não escreve no Redis (allowlist fechada de comandos), não',
    '  cria arquivo, não roda migration, não enfileira job, não abre socket de WhatsApp e',
    '  não faz chamada faturável de LLM. Ele nunca CONSERTA nada — só diz o que consertar.',
    '',
    'ELE NÃO SUBSTITUI',
    '  · o preflight de CONFIGURAÇÃO, que valida os arquivos ANTES do `up` — o doctor',
    '    valida o ambiente que o container REALMENTE recebeu, já de pé;',
    '  · `/readyz`, que é o gate por instância que o load balancer consulta;',
    '  · a sonda sintética (#472), que exercita o caminho VIVO com tráfego real.',
  ].join('\n');
}

/** `--flag value` and `--flag=value`; bare `--flag` is boolean true. */
export function parseArgs(argv: readonly string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 2) {
      args.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, true);
    }
  }
  return args;
}

/** Thrown for anything that must exit 2 rather than 1. */
export class DoctorUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DoctorUsageError';
  }
}

/**
 * Flags the CLI understands. Anything else is a USAGE error, not a no-op.
 *
 * Silently ignoring an unknown flag is the worst failure mode a diagnostic
 * tool has: `--tenant acme` (a shape the issue sketches but this build does not
 * implement yet, see `docs/runbooks/doctor.md` §8) would produce a green report
 * that answered nothing about tenants, and the operator would believe it did.
 */
const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  'help',
  'h',
  'online',
  'profile',
  'service',
  'format',
  'json',
  'strict',
  'verbose',
  'timeout',
  'only',
  'skip',
]);

export function resolveOptions(args: Map<string, string | true>): DoctorCliOptions {
  const unknown = [...args.keys()].filter((k) => !KNOWN_FLAGS.has(k));
  if (unknown.length > 0) {
    throw new DoctorUsageError(
      `opção desconhecida: ${unknown.map((k) => `--${k}`).join(', ')}. ` +
        'Um doctor que ignora uma flag em silêncio devolve um verde que não responde à pergunta feita.',
    );
  }

  const rawProfile = args.get('profile');
  if (rawProfile !== undefined && (typeof rawProfile !== 'string' || !isMaiaProfile(rawProfile))) {
    throw new DoctorUsageError(`--profile inválido. Use: ${MAIA_PROFILES.join(', ')}.`);
  }

  const rawService = args.get('service') ?? 'runtime';
  if (typeof rawService !== 'string' || !MAIA_SERVICES.includes(rawService as MaiaService)) {
    throw new DoctorUsageError(`--service inválido. Use: ${MAIA_SERVICES.join(', ')}.`);
  }

  const rawFormat = args.get('format');
  if (rawFormat !== undefined && rawFormat !== 'human' && rawFormat !== 'json') {
    throw new DoctorUsageError('--format aceita apenas "human" ou "json".');
  }

  const rawTimeout = args.get('timeout');
  let timeoutMs = DEFAULT_TOTAL_DEADLINE_MS;
  if (rawTimeout !== undefined) {
    const parsed = Number(rawTimeout);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new DoctorUsageError('--timeout precisa ser um número de milissegundos > 0.');
    }
    timeoutMs = parsed;
  }

  const only: DoctorCategory[] = [];
  const rawOnly = args.get('only');
  if (rawOnly !== undefined) {
    if (typeof rawOnly !== 'string') throw new DoctorUsageError('--only exige uma lista.');
    for (const part of rawOnly.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
      if (!isDoctorCategory(part)) {
        throw new DoctorUsageError(
          `--only: categoria desconhecida "${part}". Use: ${DOCTOR_CATEGORIES.join(', ')}.`,
        );
      }
      only.push(part);
    }
  }

  const rawSkip = args.get('skip');
  const skip =
    typeof rawSkip === 'string'
      ? rawSkip.split(',').map((s) => s.trim()).filter((s) => s !== '')
      : [];

  return {
    ...(typeof rawProfile === 'string' ? { profile: rawProfile } : {}),
    service: rawService as MaiaService,
    online: args.get('online') === true,
    strict: args.get('strict') === true,
    verbose: args.get('verbose') === true,
    json: args.get('json') === true || rawFormat === 'json',
    timeoutMs,
    only,
    skip,
  };
}

async function readAppVersion(): Promise<string> {
  try {
    const raw = await readFile(join(ROOT, 'package.json'), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Adapter from the doctor's own pool to the shape `getSchemaReadiness()` wants.
 * It borrows one pooled client per evaluation and releases it in `finally`.
 */
function schemaReadinessPool(pool: pg.Pool): ReadOnlyPool {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        query: <R>(text: string, values?: unknown[]) =>
          client.query(text, values as unknown[]) as unknown as Promise<{ rows: R[] }>,
        release: () => {
          client.release();
        },
      };
    },
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.get('help') === true || args.get('h') === true) {
    console.log(usage());
    return 0;
  }

  const env = process.env as Record<string, string | undefined>;
  let options: DoctorCliOptions;
  try {
    options = resolveOptions(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('\n`npm run doctor -- --help` lista as opções.');
    return 2;
  }

  const profile = options.profile ?? resolveProfile(env).profile;

  let pool: pg.Pool | null = null;
  let redis: IORedis | null = null;
  let lastRedisErrorClass: string | null = null;

  try {
    // Handles are created but NEVER pre-connected. That is deliberate: if the
    // doctor connected here and swallowed a failure, an unreachable service
    // would arrive at the checks as `null` and be reported `skip` — a dead
    // dependency rendered as "not applicable". Instead the first command a
    // check issues does the connecting, so an unreachable Postgres or Redis
    // surfaces where it belongs: as a FAILING liveness check.
    if (options.online && typeof env.DATABASE_URL === 'string' && env.DATABASE_URL !== '') {
      pool = doctorPostgresPool(env.DATABASE_URL);
    }

    if (options.online && typeof env.REDIS_URL === 'string' && env.REDIS_URL !== '') {
      redis = new IORedis(env.REDIS_URL, {
        lazyConnect: true,
        connectTimeout: 3_000,
        maxRetriesPerRequest: 1,
        // Without this, an unreachable Redis is retried forever and the check
        // only ever ends by deadline — a `fail`, but a slow and mute one.
        retryStrategy: () => null,
      });
      // The command rejection ioredis produces for a dead server is a bare
      // `Error: Connection is closed.`; the diagnosable class (ECONNREFUSED,
      // ENOTFOUND, ETIMEDOUT) only ever arrives HERE. Keep the CLASS, never
      // the message — it embeds host:port, and REDIS_URL carries a password.
      redis.on('error', (err: unknown) => {
        const code = (err as { code?: unknown } | null)?.code;
        lastRedisErrorClass =
          typeof code === 'string' && code !== ''
            ? code
            : err instanceof Error
              ? err.constructor.name
              : 'UnknownError';
      });
    }

    const ctx: DoctorContext = {
      env,
      profile,
      service: options.service,
      online: options.online,
      migrationsDir: MIGRATIONS_DIR,
      postgres: pool ? readOnlyPostgres(pool) : null,
      redis: redis ? readOnlyRedis(redis, { lastErrorClass: () => lastRedisErrorClass }) : null,
      schemaReadiness: pool
        ? () =>
            getSchemaReadiness({
              pool: schemaReadinessPool(pool as pg.Pool),
              migrationsDir: MIGRATIONS_DIR,
            })
        : null,
    };

    const run = await runDoctor(checksForCategories(options.only), ctx, {
      totalDeadlineMs: options.timeoutMs,
      disabled: options.skip,
    });

    const meta: DoctorReportMeta = {
      run_id: randomUUID(),
      started_at: new Date().toISOString(),
      profile,
      app_version: await readAppVersion(),
      commit: env.MAIA_BUILD_COMMIT ?? null,
      online: options.online,
      strict: options.strict,
    };

    console.log(
      options.json
        ? renderJson(run, meta, env)
        : renderHuman(run, meta, env, { verbose: options.verbose }),
    );
    return exitCodeFor(run, options.strict);
  } catch (err) {
    // Exit 2, never 1: an internal failure means the gate did not run, and a
    // pipeline must not read that as "the environment is broken".
    console.error(
      `doctor: falha interna (${err instanceof Error ? err.constructor.name : 'UnknownError'}). ` +
        'O diagnóstico NÃO foi produzido; trate como "gate não executado".',
    );
    return 2;
  } finally {
    await pool?.end().catch(() => {
      /* nothing to salvage on the way out */
    });
    redis?.disconnect();
  }
}

/* c8 ignore start — entry point guard, exercised by running the CLI itself */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 2;
    });
}
/* c8 ignore stop */
