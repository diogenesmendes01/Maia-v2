/**
 * Issue #369 — BullMQ Worker handler must run inside a valid ALS context.
 *
 * Before this fix, `startAgentWorker`'s handler called `await processor(job)`
 * directly, with NO `runWithTenantContext`. The early part of the worker
 * callstack (channel resolver + cross-tenant adoption in `src/agent/core.ts`,
 * which only opens `runWithTenantContext` at ~:388 AFTER the tuple is resolved)
 * therefore ran with no ALS — a blind spot that bypasses the fail-closed guard
 * in `src/db/tenant-context.ts` (`getCurrentTenant`/`getCurrentAgent` throw
 * `MissingTenantContextError` when the store is empty) and blocked the #323
 * `MAIA_REJECT_DEFAULT_LITERAL` flip.
 *
 * The job payload (`AgentJob = { mensagem_id }`, `src/gateway/types.ts`) carries
 * no tenant/agent tuple, so the handler cannot extract a real tenant. The fix
 * wraps the processor call in the sanctioned global-maintenance context via
 * `runWithSystemContext` (`src/db/tenant-context.ts`). This spec drives the real
 * handler with a fake processor that reads the ALS context at processor entry
 * and asserts:
 *   1. it does NOT throw `MissingTenantContextError` (a context is present), and
 *   2. the context is the reserved `system` sentinel (`isSystemContext`).
 *
 * We use the REAL `@/db/tenant-context.js` so the assertion exercises the actual
 * fail-closed getters, and stub only BullMQ/ioredis so importing `queue.ts`
 * (which does `new Queue(...)`/`new Worker(...)` at module load) never touches a
 * broker. The `FakeWorker` captures the handler the production code passes to
 * `new Worker(name, handler, opts)` — that captured handler is the unit here.
 *
 * `startAgentWorker` memoises its Worker (`if (worker) return worker`), so the
 * handler is constructed exactly once. We therefore register a single processor
 * that records what it observes at entry into a shared slot, then each `it`
 * invokes the captured handler and inspects the recording — instead of swapping
 * processors (which the memoisation would ignore).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { AgentJob } from '@/gateway/types.js';

type WorkerHandler = (job: Job<AgentJob>) => Promise<void>;

const { capturedHandler, workerOn } = vi.hoisted(() => {
  return {
    // Mutable slot the FakeWorker fills with the handler constructor arg so the
    // test can invoke the real `queue.ts` callback directly.
    capturedHandler: { fn: null as WorkerHandler | null },
    workerOn: vi.fn(),
  };
});

// Stub BullMQ so importing `queue.ts` doesn't open a real broker; the Worker
// constructor's 2nd arg (the handler) is the seam under test.
vi.mock('bullmq', () => {
  class FakeQueue {
    add = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
  }
  class FakeWorker {
    on = workerOn;
    close = vi.fn(async () => undefined);
    constructor(_name: string, handler: WorkerHandler) {
      capturedHandler.fn = handler;
    }
  }
  return { Queue: FakeQueue, Worker: FakeWorker };
});

vi.mock('ioredis', () => {
  class FakeRedis {
    on() {
      return this;
    }
    quit = vi.fn(async () => undefined);
  }
  return { default: FakeRedis };
});

vi.mock('@/config/env.js', () => ({ config: { REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('@/db/repositories.js', () => ({ dlqRepo: { add: vi.fn() } }));
vi.mock('@/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/alerts.js', () => ({ sendAlert: vi.fn(async () => undefined) }));
vi.mock('@/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Real tenant-context module — we WANT the actual fail-closed getters here.
const { startAgentWorker } = await import('@/gateway/queue.js');
const { getCurrentTenant, getCurrentAgent, isSystemContext, MissingTenantContextError } =
  await import('@/db/tenant-context.js');

function fakeJob(mensagem_id = 'm1'): Job<AgentJob> {
  return { id: 'job-1', data: { mensagem_id } } as unknown as Job<AgentJob>;
}

// What the single registered processor recorded at its entry on the last run.
type Recording = {
  calls: number;
  thrown: unknown;
  ctx: { tenant_id: string; agent_id: string } | null;
};
const recording: Recording = { calls: 0, thrown: null, ctx: null };

beforeAll(() => {
  // Register the worker exactly once. `startAgentWorker` memoises, so this is
  // the only handler that will ever be constructed for this module instance.
  startAgentWorker(async () => {
    recording.calls += 1;
    // At processor entry the fail-closed getters MUST resolve — the handler
    // wraps us in an ALS context. Capture any throw so assertions can pinpoint
    // the failure mode rather than rejecting the whole handler.
    try {
      recording.ctx = { tenant_id: getCurrentTenant(), agent_id: getCurrentAgent() };
    } catch (err) {
      recording.thrown = err;
      recording.ctx = null;
    }
  });
});

beforeEach(() => {
  recording.calls = 0;
  recording.thrown = null;
  recording.ctx = null;
  workerOn.mockClear();
});

describe('startAgentWorker — BullMQ handler ALS wrap (#369)', () => {
  it('runs the processor inside a valid ALS context (no MissingTenantContextError at entry)', async () => {
    expect(capturedHandler.fn).toBeTypeOf('function');

    await capturedHandler.fn!(fakeJob());

    expect(recording.calls).toBe(1);
    expect(recording.thrown).toBeNull();
    expect(recording.thrown).not.toBeInstanceOf(MissingTenantContextError);
    expect(recording.ctx).not.toBeNull();
  });

  it('the context the processor observes is the reserved system sentinel', async () => {
    await capturedHandler.fn!(fakeJob());

    expect(recording.ctx).not.toBeNull();
    expect(isSystemContext(recording.ctx!)).toBe(true);
    expect(recording.ctx).toEqual({ tenant_id: 'system', agent_id: 'system' });
  });
});
