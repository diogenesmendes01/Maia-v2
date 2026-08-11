import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { AgentJob } from '@/gateway/types.js';

/**
 * Issue #535 — owner review of PR #541: the root `turn` span and its
 * `queue.wait` sibling both exported `tenant_id=system, agent_id=system`.
 *
 * `tests/unit/observability/span-attribution.spec.ts` pins the tracer
 * mechanism. This file pins the CALL SITE: it drives the real BullMQ handler
 * built by `startAgentWorker` (`src/gateway/queue.ts`) with a processor that
 * resolves a tenant the way `src/agent/core.ts` does — nested inside the
 * worker's sanctioned `system` context — and asserts what the span sink
 * receives. Asserting the exported bag rather than the arguments at open is
 * deliberate: the defect was never a wrong argument, it was a read taken after
 * the scope it needed had unwound.
 *
 * Only BullMQ/ioredis and the write-side collaborators are stubbed. The tenant
 * context, the correlation ALS, the tracer and the metric sanitizer are all
 * REAL, because the interaction between those four is the thing under test.
 */
type WorkerHandler = (job: Job<AgentJob>) => Promise<void>;

const cfg = vi.hoisted(() => ({
  endpoint: 'http://collector:4318/v1/traces' as string | undefined,
  ratio: 1,
  strict: false,
}));

const { capturedHandler, workerOn } = vi.hoisted(() => ({
  capturedHandler: { fn: null as WorkerHandler | null },
  workerOn: vi.fn(),
}));

vi.mock('bullmq', () => {
  class FakeQueue {
    add = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    waitUntilReady = vi.fn(async () => undefined);
  }
  class FakeWorker {
    on = workerOn;
    close = vi.fn(async () => undefined);
    constructor(_name: string, handler: WorkerHandler) {
      capturedHandler.fn = handler;
    }
  }
  return { Queue: FakeQueue, Worker: FakeWorker, DelayedError: class DelayedError extends Error {} };
});

vi.mock('ioredis', () => {
  class FakeRedis {
    status = 'ready';
    on() {
      return this;
    }
    quit = vi.fn(async () => undefined);
  }
  return { default: FakeRedis };
});

vi.mock('@/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env.js')>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, prop, receiver) => {
        if (prop === 'MAIA_OTLP_TRACES_ENDPOINT') return cfg.endpoint;
        if (prop === 'MAIA_OTLP_SAMPLE_RATIO') return cfg.ratio;
        if (prop === 'MAIA_STRICT_METRIC_LABELS') return cfg.strict;
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});

vi.mock('@/db/repositories.js', () => ({ dlqRepo: { add: vi.fn() } }));
vi.mock('@/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/alerts.js', () => ({ sendAlert: vi.fn(async () => undefined) }));
vi.mock('@/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { startAgentWorker } = await import('@/gateway/queue.js');
const { runWithTenantContext } = await import('@/db/tenant-context.js');
const { publishSpanAttribution } = await import('@/observability/tracer.js');
const { setSpanSink } = await import('@/observability/tracer.js');
const { SPAN } = await import('@/observability/taxonomy.js');
type EndedSpan = import('@/observability/tracer.js').EndedSpan;

/** What the single registered processor should do on the next invocation. */
const plan: {
  tenant: { tenant_id: string; agent_id: string } | null;
  throws: Error | null;
  park: (() => Promise<void>) | null;
} = { tenant: null, throws: null, park: null };

let captured: EndedSpan[] = [];

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fakeJob(overrides: Partial<AgentJob> & { id?: string } = {}): Job<AgentJob> {
  const { id = 'job-1', ...data } = overrides;
  return {
    id,
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: { mensagem_id: 'm1', enqueued_at_ms: Date.now() - 1_500, ...data },
  } as unknown as Job<AgentJob>;
}

beforeAll(() => {
  // `startAgentWorker` memoises its Worker, so exactly one handler is ever
  // constructed. The processor reads `plan` so each test can steer it.
  startAgentWorker(async () => {
    // The pre-resolution window `src/agent/core.ts` runs before it knows the
    // tenant: channel resolver + cross-tenant adoption, under `system`.
    await tick();
    if (plan.tenant) {
      // Espelha `src/agent/core.ts`: a tupla resolvida é publicada
      // explicitamente, antes de abrir o escopo. `runWithTenantContext` não
      // tem hook — a fronteira fail-closed ficou sem ponto de extensão.
      publishSpanAttribution(plan.tenant);
      await runWithTenantContext(plan.tenant, async () => {
        await tick();
        if (plan.park) await plan.park();
      });
    }
    // The scope has unwound again by the time we return to the worker.
    await tick();
    if (plan.throws) throw plan.throws;
  });
});

beforeEach(() => {
  captured = [];
  plan.tenant = null;
  plan.throws = null;
  plan.park = null;
  cfg.endpoint = 'http://collector:4318/v1/traces';
  cfg.ratio = 1;
  setSpanSink((s) => captured.push(s));
});

afterEach(() => setSpanSink(null));

function spanNamed(name: string): EndedSpan | undefined {
  return captured.find((s) => s.name === name);
}

describe('startAgentWorker — exported span attribution (#535 review)', () => {
  it('exports the root `turn` span with the tenant the processor RESOLVED', async () => {
    plan.tenant = { tenant_id: 'acme', agent_id: 'acme-bot' };

    await capturedHandler.fn!(fakeJob());

    const turn = spanNamed(SPAN.TURN);
    expect(turn, 'the root span must reach the sink').toBeDefined();
    expect(turn?.attributes.tenant_id).toBe('acme');
    expect(turn?.attributes.agent_id).toBe('acme-bot');
    // The pre-resolution attributes the call site does pass are still there.
    expect(turn?.attributes.queue).toBe('agent');
    expect(turn?.attributes.phase).toBe('first');
  });

  it('exports the `queue.wait` sibling with the SAME tuple as the root', async () => {
    // `queue.wait` reconstructs a window that closed before this worker
    // existed, so it has no scope of its own to read; it is handed the tuple
    // the root resolved to. Before the fix both said `system`; the danger of a
    // half fix is that they stop agreeing.
    plan.tenant = { tenant_id: 'acme', agent_id: 'acme-bot' };

    await capturedHandler.fn!(fakeJob());

    const wait = spanNamed(SPAN.QUEUE_WAIT);
    const turn = spanNamed(SPAN.TURN);
    expect(wait, 'the queue.wait span must reach the sink').toBeDefined();
    expect(wait?.attributes.tenant_id).toBe('acme');
    expect(wait?.attributes.agent_id).toBe('acme-bot');
    expect(wait?.attributes.tenant_id).toBe(turn?.attributes.tenant_id);
    expect(wait?.attributes.queue).toBe('agent');
    // Still a SIBLING of the turn, not a child: the waiting happened before
    // the turn started running.
    expect(wait?.parent_span_id).toBeNull();
    expect(wait?.trace_id).toBe(turn?.trace_id);
  });

  it('still emits an attributed `queue.wait` when the turn FAILS', async () => {
    plan.tenant = { tenant_id: 'acme', agent_id: 'acme-bot' };
    plan.throws = new Error('turn exploded');

    await expect(capturedHandler.fn!(fakeJob())).rejects.toThrow('turn exploded');

    expect(spanNamed(SPAN.TURN)?.attributes.tenant_id).toBe('acme');
    expect(spanNamed(SPAN.QUEUE_WAIT)?.attributes.tenant_id).toBe('acme');
    expect(spanNamed(SPAN.QUEUE_WAIT)?.attributes.agent_id).toBe('acme-bot');
  });

  it('falls back to `system` for a turn that never resolves a tenant', async () => {
    plan.tenant = null;

    await capturedHandler.fn!(fakeJob());

    expect(spanNamed(SPAN.TURN)?.attributes.tenant_id).toBe('system');
    expect(spanNamed(SPAN.QUEUE_WAIT)?.attributes.tenant_id).toBe('system');
  });

  it('two concurrent jobs of different tenants keep their own tuples', async () => {
    // BullMQ runs this worker at concurrency 1, but the handler is a plain
    // async function and nothing stops a second instance (a second worker in
    // the same process, a test, a future concurrency bump). If attribution
    // were stored anywhere shared, this is where one tenant's tuple would land
    // on the other's span.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked = 0;
    plan.park = async () => {
      parked += 1;
      await gate;
    };

    plan.tenant = { tenant_id: 'acme', agent_id: 'acme-bot' };
    const a = capturedHandler.fn!(fakeJob({ id: 'job-a', mensagem_id: 'm-a' }));
    // Flip the plan the moment the first job is past its resolution point, so
    // the two turns are genuinely interleaved under different tenants.
    while (parked < 1) await tick();
    plan.tenant = { tenant_id: 'globex', agent_id: 'globex-bot' };
    const b = capturedHandler.fn!(fakeJob({ id: 'job-b', mensagem_id: 'm-b' }));

    while (parked < 2) await tick();
    release();
    await Promise.all([a, b]);

    const turns = captured.filter((s) => s.name === SPAN.TURN);
    const waits = captured.filter((s) => s.name === SPAN.QUEUE_WAIT);
    expect(turns).toHaveLength(2);
    expect(waits).toHaveLength(2);

    const tuples = [...turns, ...waits].map(
      (s) => `${String(s.attributes.tenant_id)}/${String(s.attributes.agent_id)}`,
    );
    // Never a mixed tuple, and each tenant is represented exactly twice
    // (its `turn` and its `queue.wait`).
    for (const t of tuples) expect(t).toMatch(/^(acme\/acme-bot|globex\/globex-bot)$/);
    expect(tuples.filter((t) => t.startsWith('acme')).length).toBe(2);
    expect(tuples.filter((t) => t.startsWith('globex')).length).toBe(2);

    // And the two turns did not collapse onto one trace.
    expect(new Set(turns.map((s) => s.trace_id)).size).toBe(2);
  });
});
