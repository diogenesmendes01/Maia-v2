/**
 * Issue #512 — lifecycle controller: state machine, idempotent shutdown,
 * ordered drain with a deadline, and the background-task registry.
 *
 * These are the invariants an operator depends on during a deploy:
 *   - readiness is impossible outside `ready`;
 *   - two simultaneous signals run the sequence ONCE;
 *   - close order is registration order (consumers before pools);
 *   - a step that blows the deadline is REPORTED, not swallowed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { lifecycle, LIFECYCLE_STATES } from '../../../src/runtime/lifecycle/controller.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  lifecycle._resetForTests();
});

describe('lifecycle state machine', () => {
  it('starts in `starting`', () => {
    expect(lifecycle.state).toBe('starting');
    expect(LIFECYCLE_STATES).toContain(lifecycle.state);
  });

  it('allows starting → ready → draining → stopped', () => {
    expect(lifecycle.transitionTo('ready')).toBe(true);
    expect(lifecycle.transitionTo('draining')).toBe(true);
    expect(lifecycle.transitionTo('stopped')).toBe(true);
    expect(lifecycle.state).toBe('stopped');
  });

  it('rejects illegal transitions instead of throwing (shutdown must never crash)', () => {
    lifecycle.transitionTo('ready');
    lifecycle.transitionTo('draining');
    // draining → ready would put a shedding instance back in rotation.
    expect(lifecycle.transitionTo('ready')).toBe(false);
    expect(lifecycle.state).toBe('draining');
  });

  it('never leaves the terminal `stopped` state', () => {
    lifecycle.transitionTo('ready');
    lifecycle.transitionTo('draining');
    lifecycle.transitionTo('stopped');
    for (const s of LIFECYCLE_STATES) {
      if (s === 'stopped') continue;
      expect(lifecycle.transitionTo(s)).toBe(false);
    }
  });

  it('lets a FAILED startup still drain (resources opened must still close)', () => {
    expect(lifecycle.transitionTo('failed', 'redis unavailable')).toBe(true);
    expect(lifecycle.transitionTo('draining')).toBe(true);
    expect(lifecycle.transitionTo('stopped')).toBe(true);
  });

  it('records the reason and a timestamp per transition', () => {
    lifecycle.transitionTo('failed', 'db unreachable');
    const snap = lifecycle.snapshot();
    expect(snap.state).toBe('failed');
    expect(snap.reason).toBe('db unreachable');
    expect(Date.parse(snap.state_since)).not.toBeNaN();
    expect(snap.instance_id).toHaveLength(8);
  });
});

describe('component registry', () => {
  it('every component starts `pending`', () => {
    expect(lifecycle.getComponent('db').state).toBe('pending');
    expect(lifecycle.getComponent('whatsapp_session').state).toBe('pending');
  });

  it('requiredComponentsStarted reports the missing set for the ACTIVE role', () => {
    lifecycle.setRole('worker');
    let r = lifecycle.requiredComponentsStarted();
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('agent_worker');
    // HTTP is not a worker concern — it must never appear in the missing set.
    expect(r.missing).not.toContain('http');

    for (const c of ['config', 'db', 'schema', 'redis', 'redis_memory', 'queue', 'agent_worker'] as const) {
      lifecycle.setComponent(c, 'ready');
    }
    r = lifecycle.requiredComponentsStarted();
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('setRole is fail-closed on an unknown value', () => {
    expect(() => lifecycle.setRole('sheduler')).toThrow(/invalid process role/i);
  });
});

describe('shutdown — idempotency and ordering', () => {
  it('transitions to draining atomically, BEFORE any step runs', async () => {
    const seen: string[] = [];
    lifecycle.transitionTo('ready');
    lifecycle.registerShutdownStep({
      name: 'first',
      run: async () => {
        seen.push(`state=${lifecycle.state}`);
      },
    });
    await lifecycle.shutdown({ signal: 'SIGTERM' });
    expect(seen).toEqual(['state=draining']);
  });

  it('runs steps in REGISTRATION order (consumers before pools)', async () => {
    const order: string[] = [];
    for (const name of ['cron', 'bullmq', 'http', 'pools']) {
      lifecycle.registerShutdownStep({ name, run: async () => void order.push(name) });
    }
    const out = await lifecycle.shutdown();
    expect(order).toEqual(['cron', 'bullmq', 'http', 'pools']);
    expect(out.result).toBe('clean');
    expect(out.drained).toEqual(['cron', 'bullmq', 'http', 'pools']);
    expect(out.undrained).toEqual([]);
  });

  it('is IDEMPOTENT — two simultaneous signals run the sequence once', async () => {
    let runs = 0;
    lifecycle.registerShutdownStep({
      name: 'once',
      run: async () => {
        runs += 1;
        await tick(10);
      },
    });
    const [a, b] = await Promise.all([
      lifecycle.shutdown({ signal: 'SIGTERM' }),
      lifecycle.shutdown({ signal: 'SIGINT' }),
    ]);
    expect(runs).toBe(1);
    expect(a).toBe(b);
    expect(lifecycle.signalCount).toBe(2);
  });

  it('a sequential second call returns the same outcome without re-running', async () => {
    let runs = 0;
    lifecycle.registerShutdownStep({ name: 'once', run: async () => void (runs += 1) });
    const first = await lifecycle.shutdown();
    const second = await lifecycle.shutdown();
    expect(runs).toBe(1);
    expect(second).toEqual(first);
  });

  it('reports a step that exceeds its deadline as UNDRAINED (result=incomplete)', async () => {
    lifecycle.registerShutdownStep({
      name: 'wedged',
      timeoutMs: 20,
      run: () => new Promise<void>(() => undefined), // never settles
    });
    lifecycle.registerShutdownStep({ name: 'after', run: async () => undefined });
    const out = await lifecycle.shutdown();
    expect(out.result).toBe('incomplete');
    expect(out.undrained).toEqual(['wedged']);
    // The sequence CONTINUES: a wedged consumer must not prevent closing pools.
    expect(out.drained).toContain('after');
  });

  it('reports a throwing step as undrained but keeps going', async () => {
    lifecycle.registerShutdownStep({
      name: 'boom',
      run: async () => {
        throw new Error('socket already gone');
      },
    });
    lifecycle.registerShutdownStep({ name: 'pools', run: async () => undefined });
    const out = await lifecycle.shutdown();
    expect(out.undrained).toEqual(['boom']);
    expect(out.drained).toContain('pools');
  });

  it('a step marked non-critical does not make the drain incomplete', async () => {
    lifecycle.registerShutdownStep({
      name: 'audit_stop',
      critical: false,
      run: async () => {
        throw new Error('db already closed');
      },
    });
    const out = await lifecycle.shutdown();
    expect(out.result).toBe('clean');
    expect(out.undrained).toEqual([]);
  });

  it('always reaches `stopped`, even on an incomplete drain', async () => {
    lifecycle.registerShutdownStep({
      name: 'wedged',
      timeoutMs: 10,
      run: () => new Promise<void>(() => undefined),
    });
    const out = await lifecycle.shutdown();
    expect(out.result).toBe('incomplete');
    expect(lifecycle.state).toBe('stopped');
  });

  it('isShuttingDown flips as soon as the first signal lands', async () => {
    expect(lifecycle.isShuttingDown()).toBe(false);
    const p = lifecycle.shutdown({ signal: 'SIGTERM' });
    expect(lifecycle.isShuttingDown()).toBe(true);
    await p;
  });
});

describe('background task registry (fire-and-forget work)', () => {
  it('awaits tracked tasks within the deadline', async () => {
    let done = false;
    lifecycle.trackBackgroundTask(
      'reflection',
      tick(10).then(() => {
        done = true;
      }),
    );
    expect(lifecycle.countBackgroundTasks()).toBe(1);
    const pending = await lifecycle.awaitBackgroundTasks(500);
    expect(pending).toEqual([]);
    expect(done).toBe(true);
  });

  it('returns the names still in flight when the deadline expires', async () => {
    lifecycle.trackBackgroundTask('outbox_flush', new Promise<void>(() => undefined));
    const pending = await lifecycle.awaitBackgroundTasks(20);
    expect(pending).toEqual(['outbox_flush']);
  });

  it('returns the SAME promise so call sites keep their shape', async () => {
    const original = Promise.resolve(42);
    const tracked = lifecycle.trackBackgroundTask('trace_enqueue', original);
    expect(tracked).toBe(original);
    await expect(tracked).resolves.toBe(42);
  });

  it('a rejected tracked task does not break the drain', async () => {
    const failing = Promise.reject(new Error('nope'));
    // The caller keeps ownership of the rejection; tracking must not add an
    // unhandled rejection of its own.
    lifecycle.trackBackgroundTask('alert', failing).catch(() => undefined);
    await expect(lifecycle.awaitBackgroundTasks(200)).resolves.toEqual([]);
  });
});
