/**
 * Issue #516 — o BOOT decide pelo veredito canônico e mata o processo.
 *
 * ### Por que esta spec importa `src/index.ts` de verdade
 *
 * A armadilha do espelho: um teste que remonta o boot com o próprio harness
 * (chama `getSchemaReadiness()`, olha o veredito, confere um mapa de exit
 * codes) continua VERDE mesmo quando o call site de produção é deletado —
 * porque quem ele exercita é o harness. Esta suíte importa o MÓDULO DE
 * PRODUÇÃO `src/index.ts`, cuja avaliação dispara `main()` e o handler de
 * falha, e observa duas coisas que só o código real pode produzir:
 *
 *   1. o `process.exit(<código>)` do handler de `main()`;
 *   2. a linha `maia.schema_boot_refused` do passo `schema`.
 *
 * Apagar o bloco `if (failure) { … throw … }` de `src/index.ts`, ou trocar
 * `process.exit(bootExitCode(err))` por `process.exit(1)`, reprova esta spec.
 *
 * ### O que é injetado, e por quê
 *
 * Só o que um unitário não pode ter: o banco (um pool falso servindo um ledger
 * montado) e o artefato empacotado (um diretório temporário de migrations). O
 * veredito em si é o REAL — descoberta real, checksum real (SHA-256 dos
 * arquivos escritos no tmpdir), classificação real de blocker. As dependências
 * pesadas do boot (Baileys, BullMQ, Fastify, workers, Redis) são mockadas
 * porque o boot morre ANTES delas; a única que precisa se comportar é o
 * `ensureRedisConnect`, que serve de sentinela para o caminho feliz.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrationChecksum } from '@/migrations/checksum.js';
import { LEDGER_V2_COLUMNS } from '@/migrations/ledger.js';
import type { InvalidIndex, ReadOnlyPool, ReadOnlyPoolClient } from '@/migrations/index.js';

// ── o grafo pesado do boot, mockado (o boot morre antes de tudo isto) ────────
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/db/client.js', () => ({
  pool: { connect: vi.fn() },
  db: { execute: vi.fn() },
  probeDb: vi.fn(async () => true),
  isDbConnected: () => true,
  shutdownDb: vi.fn(async () => undefined),
  pgErrorCode: () => undefined,
}));
vi.mock('@/lib/redis.js', () => ({
  // Sentinela do caminho feliz: se o passo `schema` NÃO abortar, o boot chega
  // aqui e morre com uma falha genérica (exit 1), que é justamente o contraste
  // que os casos negativos precisam ter.
  ensureRedisConnect: vi.fn(async () => {
    throw new Error('redis sentinel — the boot got PAST the schema gate');
  }),
  redis: { ping: vi.fn(), quit: vi.fn() },
  isRedisConnected: () => false,
}));
vi.mock('@/gateway/baileys.js', () => ({
  startBaileys: vi.fn(async () => undefined),
  isBaileysConnected: () => false,
  getLastDisconnectAt: () => null,
}));
vi.mock('@/gateway/queue.js', () => ({
  startAgentWorker: vi.fn(),
  startUnroutedReplayWorker: vi.fn(),
  awaitQueueReady: vi.fn(async () => undefined),
  agentQueue: {},
  unroutedQueue: {},
}));
vi.mock('@/runtime/turns/job-consumer.js', () => ({ runAgentTurnJob: vi.fn() }));
vi.mock('@/server.js', () => ({ startServer: vi.fn(async () => ({})), buildServer: vi.fn() }));
vi.mock('@/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/workers/index.js', () => ({
  startWorkers: vi.fn(),
  haltWorkerScheduling: vi.fn(),
  drainWorkers: vi.fn(async () => undefined),
}));
vi.mock('@/runtime/lifecycle/shutdown-sequence.js', () => ({
  installSignalHandlers: vi.fn(),
  registerShutdownSequence: vi.fn(),
  setHttpApp: vi.fn(),
  runShutdown: vi.fn(async () => undefined),
}));

// ── o artefato empacotado sob teste ─────────────────────────────────────────
const FILES: Record<string, string> = {
  '001_first.sql': 'CREATE TABLE a (id int);\n',
  '002_head.sql': 'CREATE TABLE b (id int);\n',
};
const HEAD = '002_head.sql';
const V2_COLUMNS = ['id', 'applied_at', ...LEDGER_V2_COLUMNS];

let migrationsDir: string;

beforeAll(async () => {
  migrationsDir = await mkdtemp(join(tmpdir(), 'maia-schema-boot-'));
  for (const [name, sql] of Object.entries(FILES)) {
    await writeFile(join(migrationsDir, name), sql, 'utf8');
    await writeFile(join(migrationsDir, name.replace('.sql', '_down.sql')), 'DROP TABLE a;\n', 'utf8');
  }
});

afterAll(async () => {
  if (migrationsDir) await rm(migrationsDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

type LedgerRow = {
  id: string;
  status: string;
  checksum_sha256: string | null;
  checksum_source: string | null;
};

function appliedRow(name: string, overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: name,
    status: 'applied',
    checksum_sha256: migrationChecksum(FILES[name] ?? ''),
    checksum_source: 'computed',
    ...overrides,
  };
}

function ledgerPool(
  rows: readonly LedgerRow[],
  options: { connectError?: Error; invalidIndexes?: readonly InvalidIndex[] } = {},
): ReadOnlyPool {
  return {
    async connect() {
      if (options.connectError) throw options.connectError;
      const client: ReadOnlyPoolClient = {
        query: <R,>(text: string): Promise<{ rows: R[] }> => {
          // #658 — a sonda de `pg_index`. Reconhecida explicitamente: sem isto
          // o `else` devolveria as linhas do LEDGER para a consulta de
          // catálogo, e todo veredito nasceria com um índice inválido fantasma.
          const out = text.includes('NOT i.indisvalid')
            ? (options.invalidIndexes ?? []).map((i) => ({
                schema_name: i.schema,
                index_name: i.index,
                table_name: i.table,
                is_ready: i.ready,
                is_live: i.live,
              }))
            : text.includes('information_schema.columns')
            ? V2_COLUMNS.map((column_name) => ({ column_name }))
            : rows.map((r) => ({
                applied_at: '2026-01-01T00:00:00.000Z',
                started_at: null,
                execution_ms: 1,
                app_version: null,
                runner_version: null,
                error_class: null,
                repaired_at: null,
                repair_reason: null,
                ...r,
              }));
          return Promise.resolve({ rows: out as unknown as R[] });
        },
        release: () => undefined,
      };
      return client;
    },
  };
}

type LogCall = [Record<string, unknown> | string, string?];

interface BootOutcome {
  readonly exitCode: number;
  /** Argumentos de `logger.error`, na ordem em que o boot os emitiu. */
  readonly errors: LogCall[];
  readonly refusal: Record<string, unknown> | undefined;
  /** `err.message` do `maia.fatal` — a mensagem de morte que vai para o log. */
  readonly fatalMessage: string;
}

/**
 * Roda o BOOT DE PRODUÇÃO contra o ledger dado e devolve como ele morreu.
 *
 * `vi.resetModules()` + `import('@/index.js')` reexecuta o módulo — e é a
 * avaliação do módulo que dispara `main()` e instala o handler de falha. Sem
 * isso, o segundo caso importaria o módulo já avaliado e não bootaria nada.
 */
async function boot(
  rows: readonly LedgerRow[],
  options: { connectError?: Error; invalidIndexes?: readonly InvalidIndex[] } = {},
): Promise<BootOutcome> {
  vi.resetModules();
  // `vi.resetModules()` limpa o registro de MÓDULOS, não o de mocks: as
  // fábricas de `vi.mock` continuam devolvendo os mesmos `vi.fn`, então sem
  // isto o segundo boot leria as chamadas de log do primeiro.
  vi.clearAllMocks();
  const schemaReadiness = await import('@/runtime/lifecycle/schema-readiness.js');
  schemaReadiness._setSchemaReadinessDepsForTests({
    pool: ledgerPool(rows, options),
    migrationsDir,
  });
  const { logger } = await import('@/lib/logger.js');

  let settle!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });
  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation(((code?: number) => {
      settle(code ?? 0);
      return undefined as never;
    }) as never);

  await import('@/index.js');

  const exitCode = await Promise.race([
    exited,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error('boot never called process.exit')), 10_000).unref?.(),
    ),
  ]);
  exitSpy.mockRestore();

  const errors = (logger.error as unknown as { mock: { calls: LogCall[] } }).mock.calls;
  const refusalCall = errors.find((c) => c[1] === 'maia.schema_boot_refused');
  const fatalCall = errors.find((c) => c[1] === 'maia.fatal');
  const fatalErr = (fatalCall?.[0] as { err?: { message?: string } } | undefined)?.err;
  return {
    exitCode,
    errors,
    refusal: refusalCall?.[0] as Record<string, unknown> | undefined,
    fatalMessage: fatalErr?.message ?? '',
  };
}

describe('a tabela de exit codes', () => {
  it('fica fora das faixas já significadas (0/1/2, 1-14 do Node, 126-165 do shell, 255)', async () => {
    const { SCHEMA_BOOT_EXIT_CODES } = await import('@/runtime/lifecycle/schema-boot-gate.js');
    for (const [kind, code] of Object.entries(SCHEMA_BOOT_EXIT_CODES)) {
      expect(code, kind).toBeGreaterThanOrEqual(90);
      // 98 é o teto desde a #658 (`invalid_index`). O que a faixa precisa
      // garantir é não colidir com 0/1/2, com os 1-14 do Node e com os 126-165
      // do shell — e 98 satisfaz todas.
      expect(code, kind).toBeLessThanOrEqual(98);
    }
  });

  it('cobre TODO blocker kind — um kind sem código viraria `undefined` no exit', async () => {
    const { SCHEMA_BOOT_EXIT_CODES, SCHEMA_BOOT_BLOCKER_PRECEDENCE } = await import(
      '@/runtime/lifecycle/schema-boot-gate.js'
    );
    // A precedência e a tabela têm de descrever o MESMO conjunto: um kind só na
    // tabela nunca seria escolhido; um kind só na precedência sairia undefined.
    expect([...SCHEMA_BOOT_BLOCKER_PRECEDENCE].sort()).toEqual(
      Object.keys(SCHEMA_BOOT_EXIT_CODES).sort(),
    );
  });
});

describe('src/index.ts — o passo `schema` decide pelo veredito canônico', () => {
  it('DIRTY: exit 90, e a mensagem nomeia a migration e o repair', async () => {
    const out = await boot([appliedRow('001_first.sql'), appliedRow(HEAD, { status: 'dirty' })]);
    expect(out.exitCode).toBe(90);
    expect(out.refusal).toMatchObject({
      exit_code: 90,
      blocker: 'dirty_migration',
      migration_id: HEAD,
      verdict: 'blocked',
    });
    expect(String(out.refusal?.remediation)).toMatch(/migrate\.ts repair/);
    expect(out.fatalMessage).toContain('SCHEMA BOOT REFUSED');
    expect(out.fatalMessage).toContain(HEAD);
  }, 20_000);

  /**
   * #658 — o ledger diz `applied` para TUDO, e mesmo assim o boot recusa,
   * porque o catálogo carrega um índice `indisvalid = false`. É o caso que o
   * gate anterior não tinha como enxergar: nenhuma linha do ledger o revela.
   *
   * O `dirty` entra junto de propósito: os dois blockers coexistem no mundo
   * real (a mesma falha produz ambos), e a precedência tem de escolher o 98 —
   * um operador que lesse 90 primeiro repararia a linha e reaplicaria o
   * arquivo, e o `IF NOT EXISTS` devolveria sucesso sobre o índice ainda
   * inválido.
   */
  it('ÍNDICE INVÁLIDO: exit 98, à frente do `dirty`, com o índice nomeado e o DROP na remediação', async () => {
    const out = await boot([appliedRow('001_first.sql'), appliedRow(HEAD, { status: 'dirty' })], {
      invalidIndexes: [
        {
          schema: 'public',
          index: 'agent_turns_stream_active_uq',
          table: 'agent_turns',
          ready: false,
          live: true,
        },
      ],
    });
    expect(out.exitCode).toBe(98);
    expect(out.refusal).toMatchObject({ exit_code: 98, blocker: 'invalid_index', verdict: 'blocked' });
    expect(String(out.refusal?.remediation)).toMatch(/DROP INDEX CONCURRENTLY/);
    expect(out.fatalMessage).toContain('SCHEMA BOOT REFUSED');
    expect(out.fatalMessage).toContain('agent_turns_stream_active_uq');
    // O `dirty` continua visível — o operador precisa saber que há os dois.
    expect(out.refusal?.blockers).toContain('dirty_migration');
  }, 20_000);

  it('CHECKSUM DIVERGENTE: exit 91, com esperado vs. encontrado no log', async () => {
    const divergent = 'f'.repeat(64);
    const out = await boot([
      appliedRow('001_first.sql'),
      appliedRow(HEAD, { checksum_sha256: divergent }),
    ]);
    expect(out.exitCode).toBe(91);
    expect(out.refusal).toMatchObject({
      exit_code: 91,
      blocker: 'checksum_mismatch',
      migration_id: HEAD,
      expected_checksum: migrationChecksum(FILES[HEAD]!),
      found_checksum: divergent,
    });
    // A mensagem de morte carrega os DOIS checksums — é o que distingue
    // "alguém editou uma migration aplicada" de "esta build é outra".
    expect(out.fatalMessage).toContain(migrationChecksum(FILES[HEAD]!));
    expect(out.fatalMessage).toContain(divergent);
  }, 20_000);

  it('MIGRATION AUSENTE (head não aplicado): exit 94, remediação = rodar o migrator', async () => {
    const out = await boot([appliedRow('001_first.sql')]);
    expect(out.exitCode).toBe(94);
    expect(out.refusal).toMatchObject({ exit_code: 94, blocker: 'schema_below_minimum' });
    expect(String(out.refusal?.remediation)).toMatch(/db:migrate|release:migrate/);
  }, 20_000);

  it('MIGRATION NO BANCO QUE ESTA BUILD NÃO EMPACOTA: exit 93', async () => {
    const out = await boot([
      appliedRow('001_first.sql'),
      appliedRow(HEAD),
      {
        id: '003_from_the_future.sql',
        status: 'applied',
        checksum_sha256: 'a'.repeat(64),
        checksum_source: 'computed',
      },
    ]);
    expect(out.exitCode).toBe(93);
    expect(out.refusal).toMatchObject({ exit_code: 93, blocker: 'missing_file' });
  }, 20_000);

  it('CHECKSUM AUSENTE (ledger v1 nunca backfillado): exit 92', async () => {
    const out = await boot([
      appliedRow('001_first.sql'),
      appliedRow(HEAD, { checksum_sha256: null, checksum_source: null }),
    ]);
    expect(out.exitCode).toBe(92);
    expect(out.refusal).toMatchObject({ exit_code: 92, blocker: 'checksum_unknown' });
  }, 20_000);

  it('VEREDITO `unknown` (banco fora do ar): exit 97, e o log NÃO carrega a DSN', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const out = await boot([], { connectError: err });
    expect(out.exitCode).toBe(97);
    expect(out.refusal).toMatchObject({ verdict: 'unknown' });
    const serialized = JSON.stringify(out.refusal);
    expect(serialized).not.toMatch(/127\.0\.0\.1/);
    expect(serialized).not.toMatch(/password/i);
  }, 20_000);

  it('exit codes são DISTINGUÍVEIS entre si — nenhum caso cai no 1 genérico', async () => {
    const dirty = await boot([appliedRow('001_first.sql'), appliedRow(HEAD, { status: 'dirty' })]);
    const mismatch = await boot([
      appliedRow('001_first.sql'),
      appliedRow(HEAD, { checksum_sha256: 'f'.repeat(64) }),
    ]);
    const missing = await boot([appliedRow('001_first.sql')]);
    const codes = [dirty.exitCode, mismatch.exitCode, missing.exitCode];
    expect(new Set(codes).size).toBe(3);
    expect(codes).not.toContain(1);
    expect(codes).not.toContain(0);
  }, 20_000);

  it('SCHEMA VERIFICADO: o boot NÃO morre no schema — segue e falha no passo seguinte (exit 1)', async () => {
    const out = await boot([appliedRow('001_first.sql'), appliedRow(HEAD)]);
    // O sentinela do `ensureRedisConnect` prova que o passo `schema` deixou
    // passar; sem ele, um gate que recusasse TUDO passaria nos casos acima.
    expect(out.fatalMessage).toMatch(/redis sentinel/);
    expect(out.exitCode).toBe(1);
    expect(out.refusal).toBeUndefined();
  }, 20_000);
});
