/**
 * Issue #536 / PR #737 — o BOOT recusa uma política periódica destrutiva
 * ativa sem homologação, ANTES de iniciar qualquer worker, e
 * `MAIA_CONFIG_STRICT_BOOT=false` NÃO desliga isso.
 *
 * ### Por que esta spec importa `src/index.ts` de verdade
 *
 * Mesma razão de `schema-boot-gate.spec.ts`: um teste que chamasse
 * `evaluatePeriodicPolicyActivation` com o próprio harness continuaria VERDE
 * com a chamada apagada de `src/index.ts`. Aqui o MÓDULO DE PRODUÇÃO é
 * avaliado — a avaliação dispara `main()` e o handler de falha — e o que se
 * observa só o código real produz:
 *
 *   1. o `process.exit(1)` do handler de `main()`, com a mensagem
 *      `HOMOLOGATION BOOT REFUSED` no `maia.fatal`;
 *   2. a linha `maia.homologation_boot_refused` do passo `config`;
 *   3. `startWorkers` NUNCA chamado — e, mais cedo que isso, `probeDb` também
 *      não: a trava vem ANTES do banco, do Redis e das filas.
 *
 * Sondas vermelhas do brief: (a) remover a chamada do avaliador em
 * `src/index.ts` ⇒ o boot passa a morrer no sentinela do banco e os casos de
 * recusa ficam vermelhos; (b) fazer o avaliador respeitar
 * `MAIA_CONFIG_STRICT_BOOT=false` ⇒ o caso com bypass fica vermelho.
 *
 * ### O que é injetado
 *
 * Nada do avaliador. `@/config/env.js` NÃO é mockado: o `config` que chega ao
 * avaliador é o que o loader REAL parseou do `process.env` desta spec (com
 * `RETENTION_DRY_RUN=false` de propósito). O grafo pesado (Baileys, BullMQ,
 * Fastify, workers) é mockado porque o boot morre antes dele; `probeDb` é o
 * sentinela do caminho feliz — se a trava deixar passar, o boot chega ao banco
 * e morre ali com uma mensagem que os casos de recusa NÃO podem ter.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/db/client.js', () => ({
  pool: { connect: vi.fn() },
  db: { execute: vi.fn() },
  // Sentinela do caminho feliz: a trava vem ANTES do passo `db`. Se o boot
  // chegar aqui, a trava não recusou.
  probeDb: vi.fn(async () => {
    throw new Error('db sentinel — the boot got PAST the homologation gate');
  }),
  isDbConnected: () => false,
  shutdownDb: vi.fn(async () => undefined),
  pgErrorCode: () => undefined,
}));
vi.mock('@/lib/redis.js', () => ({
  ensureRedisConnect: vi.fn(async () => undefined),
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
vi.mock('@/runtime/turns/job-consumer.js', () => ({
  runAgentTurnJob: vi.fn(),
}));
vi.mock('@/server.js', () => ({
  startServer: vi.fn(async () => ({})),
  buildServer: vi.fn(),
}));
vi.mock('@/governance/audit.js', () => ({
  audit: vi.fn(async () => undefined),
}));
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

const REPO_ROOT = resolve(__dirname, '../../..');
const CANARY = 'CANARIO-boot-dpo-9f3a';
const ENV_KEYS = ['RETENTION_DRY_RUN', 'MAIA_CONFIG_STRICT_BOOT', 'RETENTION_POLICY'] as const;
const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) ORIGINAL[k] = process.env[k];
  // O caminho não-estrito avisa alto no console; o aviso não é o objeto aqui.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
  vi.restoreAllMocks();
});

type LogCall = [Record<string, unknown> | string, string?];

interface BootOutcome {
  readonly exitCode: number;
  readonly refusal: Record<string, unknown> | undefined;
  readonly fatalMessage: string;
  readonly startWorkersCalls: number;
  readonly probeDbCalls: number;
  readonly ensureRedisCalls: number;
}

/** Roda o BOOT DE PRODUÇÃO com o ambiente dado e devolve como ele morreu. */
async function boot(env: Record<string, string | undefined>): Promise<BootOutcome> {
  vi.resetModules();
  vi.clearAllMocks();
  for (const k of ENV_KEYS) {
    const v = env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { logger } = await import('@/lib/logger.js');
  const { startWorkers } = await import('@/workers/index.js');
  const { probeDb } = await import('@/db/client.js');
  const { ensureRedisConnect } = await import('@/lib/redis.js');

  let settle!: (code: number) => void;
  const exited = new Promise<number>((resolveExit) => {
    settle = resolveExit;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
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
  const refusalCall = errors.find((c) => c[1] === 'maia.homologation_boot_refused');
  const fatalCall = errors.find((c) => c[1] === 'maia.fatal');
  const fatalErr = (fatalCall?.[0] as { err?: { message?: string } } | undefined)?.err;
  const calls = (fn: unknown) => (fn as { mock: { calls: unknown[] } }).mock.calls.length;
  return {
    exitCode,
    refusal: refusalCall?.[0] as Record<string, unknown> | undefined,
    fatalMessage: fatalErr?.message ?? '',
    startWorkersCalls: calls(startWorkers),
    probeDbCalls: calls(probeDb),
    ensureRedisCalls: calls(ensureRedisConnect),
  };
}

function approvedPolicy(): string {
  return JSON.stringify({
    version: 'v1-dpo-2026-07',
    approved_by: CANARY,
    approved_at: '2026-07-01T00:00:00.000Z',
    classes: { 'postgres.traces': { retention_days: 30 } },
  });
}

describe('src/index.ts — a trava de homologação recusa o boot ANTES de qualquer worker', () => {
  it('RETENTION_DRY_RUN=false sem homologação: exit 1, refusal nomeada, nenhum worker, nenhum banco', async () => {
    const out = await boot({
      RETENTION_DRY_RUN: 'false',
      MAIA_CONFIG_STRICT_BOOT: undefined,
    });
    expect(out.exitCode).toBe(1);
    expect(out.fatalMessage).toContain('HOMOLOGATION BOOT REFUSED');
    expect(out.fatalMessage).toContain('RETENTION_DRY_RUN');
    expect(out.fatalMessage).toContain('backup.artifact.retention_sweep');
    expect(out.fatalMessage).not.toMatch(/db sentinel/);
    expect(out.refusal).toBeDefined();
    const violations = out.refusal?.violations as Array<Record<string, unknown>>;
    expect(violations.map((v) => v.policy_id)).toEqual(['backup.artifact.retention_sweep']);
    expect(violations[0]?.variables).toEqual(['RETENTION_DRY_RUN']);
    // O critério mínimo do dono: nenhum worker inicia. E mais cedo que isso.
    expect(out.startWorkersCalls).toBe(0);
    expect(out.probeDbCalls).toBe(0);
    expect(out.ensureRedisCalls).toBe(0);
  }, 20_000);

  it('MAIA_CONFIG_STRICT_BOOT=false NÃO desliga a trava — mesma recusa, mesmo exit, nenhum worker', async () => {
    // A sonda vermelha (b): um avaliador (ou um call site) que respeitasse o
    // bypass deixaria este boot passar até o sentinela do banco.
    const out = await boot({
      RETENTION_DRY_RUN: 'false',
      MAIA_CONFIG_STRICT_BOOT: 'false',
    });
    expect(out.exitCode).toBe(1);
    expect(out.fatalMessage).toContain('HOMOLOGATION BOOT REFUSED');
    expect(out.fatalMessage).not.toMatch(/db sentinel/);
    expect(out.refusal).toBeDefined();
    expect(out.startWorkersCalls).toBe(0);
    expect(out.probeDbCalls).toBe(0);
  }, 20_000);

  it('RETENTION_POLICY real + dry-run desligado: as DUAS políticas na recusa, e o valor da política NÃO vaza', async () => {
    const out = await boot({
      RETENTION_DRY_RUN: 'false',
      RETENTION_POLICY: approvedPolicy(),
      MAIA_CONFIG_STRICT_BOOT: 'false',
    });
    expect(out.exitCode).toBe(1);
    const violations = out.refusal?.violations as Array<Record<string, unknown>>;
    expect(violations.map((v) => v.policy_id).sort()).toEqual([
      'backup.artifact.retention_sweep',
      'retention.class_purge',
    ]);
    expect(out.fatalMessage).toContain('RETENTION_POLICY');
    expect(out.fatalMessage).toContain('retention.class_purge');
    expect(out.fatalMessage).not.toContain(CANARY);
    expect(JSON.stringify(out.refusal)).not.toContain(CANARY);
    expect(out.startWorkersCalls).toBe(0);
  }, 20_000);

  it('CONTROLE: com os defaults (dry-run ligado) o boot PASSA a trava e morre no sentinela do banco', async () => {
    // Sem isto, uma trava que recusasse TUDO passaria nos casos acima.
    const out = await boot({
      RETENTION_DRY_RUN: undefined,
      RETENTION_POLICY: undefined,
      MAIA_CONFIG_STRICT_BOOT: undefined,
    });
    expect(out.fatalMessage).toMatch(/db sentinel/);
    expect(out.refusal).toBeUndefined();
    expect(out.exitCode).toBe(1);
    expect(out.probeDbCalls).toBe(1);
    expect(out.startWorkersCalls).toBe(0);
  }, 20_000);

  it('no código, a chamada do avaliador precede `startWorkers()` e vive no passo `config`', () => {
    // Redundante com o comportamento acima de propósito: se alguém mover a
    // chamada para depois das filas, o teste comportamental continua verde
    // (o sentinela do banco muda de lugar) e este fica vermelho.
    const source = readFileSync(resolve(REPO_ROOT, 'src/index.ts'), 'utf8');
    const gate = source.indexOf('evaluatePeriodicPolicyActivation(config)');
    const configStep = source.indexOf("runStartupStep('config'");
    const dbStep = source.indexOf("runStartupStep('db'");
    // A CHAMADA, não a menção: `startWorkers()` aparece antes em comentários.
    const workers = source.indexOf('const inventory = startWorkers()');
    expect(workers).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(configStep);
    expect(gate).toBeLessThan(dbStep);
    expect(gate).toBeLessThan(workers);
    // E o call site não consulta o interruptor de rollback do contrato.
    const semComentarios = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(semComentarios).not.toMatch(/STRICT_BOOT/);
  });
});
