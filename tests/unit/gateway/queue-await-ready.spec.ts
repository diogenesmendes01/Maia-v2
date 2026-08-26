/**
 * Issue #512 review round 1, P1 (`src/index.ts:170`) — "the object exists" is
 * not "the queue can consume".
 *
 * The hole: `queue` and `agent_worker` were marked `ready` immediately after
 * `new Queue(...)` / `new Worker(...)`. The BullMQ connection is LAZY, so the
 * flag could be true while Redis was still connecting. And because
 * `READINESS_BACKLOG_MAX` defaults to 0 (backlog probe disabled), that flag is
 * the ONLY evidence `/readyz` has about the queue — so `/readyz` could answer
 * 200 for a process that could not yet pull a single job.
 *
 * Fix: `awaitQueueReady()` waits for a live connection on both queues and both
 * workers before the components are marked ready, and rejects if the
 * connection cannot be established (boot fails closed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { deferreds, queueCtor, workerCtor } = vi.hoisted(() => {
  const deferreds: { name: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  function makeWaitUntilReady(name: string) {
    return vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          deferreds.push({ name, resolve: () => resolve(), reject });
        }),
    );
  }
  const queueCtor = vi.fn(function (this: Record<string, unknown>, name: string) {
    this.name = name;
    this.add = vi.fn(async () => undefined);
    this.close = vi.fn(async () => undefined);
    this.getWaitingCount = vi.fn(async () => 0);
    this.waitUntilReady = makeWaitUntilReady(`queue:${name}`);
  });
  const workerCtor = vi.fn(function (this: Record<string, unknown>, name: string) {
    this.name = name;
    this.on = vi.fn();
    this.pause = vi.fn(async () => undefined);
    this.isPaused = vi.fn(() => false);
    this.close = vi.fn(async () => undefined);
    this.waitUntilReady = makeWaitUntilReady(`worker:${name}`);
  });
  return { deferreds, queueCtor, workerCtor };
});

vi.mock('bullmq', () => ({
  Queue: queueCtor,
  Worker: workerCtor,
  DelayedError: class extends Error {},
}));
vi.mock('ioredis', () => ({
  default: class {
    status = 'ready';
    on = vi.fn();
    off = vi.fn();
    quit = vi.fn(async () => undefined);
  },
}));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/db/repositories.js', () => ({ dlqRepo: { add: vi.fn() } }));
vi.mock('../../../src/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../../../src/lib/alerts.js', () => ({ sendAlert: vi.fn(async () => undefined) }));
vi.mock('../../../src/db/tenant-context.js', () => ({
  runWithSystemContext: (fn: () => Promise<unknown>) => fn(),
}));

import {
  awaitQueueReady,
  startAgentWorker,
  startUnroutedReplayWorker,
  startOutboundDeliveryWorker,
  shutdownQueue,
} from '../../../src/gateway/queue.js';

const settled = async () => new Promise((r) => setTimeout(r, 10));

beforeEach(async () => {
  deferreds.length = 0;
  await shutdownQueue();
  vi.clearAllMocks();
});

describe('awaitQueueReady', () => {
  it('does NOT resolve while the BullMQ connection is still coming up', async () => {
    startAgentWorker(vi.fn(async () => undefined));
    startUnroutedReplayWorker(vi.fn(async () => undefined));

    let resolved = false;
    const p = awaitQueueReady().then(() => {
      resolved = true;
    });
    await settled();
    // Constructing the objects succeeded; the connection has not.
    expect(resolved).toBe(false);

    // `awaitQueueReady` waits sequentially, so each resolve reveals the next
    // pending connection.
    while (deferreds.length > 0) {
      deferreds.shift()!.resolve();
      await settled();
    }
    await p;
    expect(resolved).toBe(true);
  });

  it('waits for TODAS as filas e TODOS os workers construídos', async () => {
    startAgentWorker(vi.fn(async () => undefined));
    startUnroutedReplayWorker(vi.fn(async () => undefined));
    // Issue #633 — a terceira fila. Ela é construída SEMPRE (o `new Queue` é o
    // produtor, e o dispatcher/varredura enfileira mesmo num processo que não
    // consome); o WORKER dela é opcional e gated por
    // `FEATURE_OUTBOUND_DELIVERY_WORKER`. A distinção importa e é a razão de
    // este caso não iniciar `startOutboundDeliveryWorker`: uma readiness que
    // esperasse por um worker que o papel não registrou nunca resolveria.
    const p = awaitQueueReady();
    // Resolve them one at a time; the names prove all of them were awaited.
    const names: string[] = [];
    while (deferreds.length > 0) {
      const d = deferreds.shift()!;
      names.push(d.name);
      d.resolve();
      await settled();
    }
    await p;
    expect(names).toEqual([
      'queue:agent',
      'queue:unrouted-replay',
      'queue:outbound-delivery',
      'worker:agent',
      'worker:unrouted-replay',
    ]);
  });

  it('espera também pelo worker de entrega quando ELE foi registrado (#633)', async () => {
    startAgentWorker(vi.fn(async () => undefined));
    startUnroutedReplayWorker(vi.fn(async () => undefined));
    startOutboundDeliveryWorker(vi.fn(async () => undefined));
    const p = awaitQueueReady();
    const names: string[] = [];
    while (deferreds.length > 0) {
      const d = deferreds.shift()!;
      names.push(d.name);
      d.resolve();
      await settled();
    }
    await p;
    expect(names).toEqual([
      'queue:agent',
      'queue:unrouted-replay',
      'queue:outbound-delivery',
      'worker:agent',
      'worker:unrouted-replay',
      'worker:outbound-delivery',
    ]);
  });

  it('skips the workers for a role that only PRODUCES (api)', async () => {
    // No worker started at all — an api-role process enqueues but never consumes.
    const p = awaitQueueReady({ includeWorkers: false });
    const names: string[] = [];
    while (deferreds.length > 0) {
      const d = deferreds.shift()!;
      names.push(d.name);
      d.resolve();
      await settled();
    }
    await p;
    expect(names).toEqual([
      'queue:agent',
      'queue:unrouted-replay',
      'queue:outbound-delivery',
    ]);
  });

  it('REJECTS when the connection cannot be established, so the boot fails closed', async () => {
    startAgentWorker(vi.fn(async () => undefined));
    const p = awaitQueueReady();
    await settled();
    deferreds[0]!.reject(new Error('ECONNREFUSED 127.0.0.1:6379'));
    await expect(p).rejects.toThrow(/ECONNREFUSED/);
  });
});
