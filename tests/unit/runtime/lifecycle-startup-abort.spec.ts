/**
 * Issue #512 review round 1, P1 (`src/index.ts:319`) — the STARTUP must be
 * cancellable, not just the shutdown.
 *
 * The hole: a SIGTERM mid-boot started a CONCURRENT shutdown, but `main()`
 * never revalidated the lifecycle after its `await`s. When the pending
 * dependency finally answered, the boot went on to start HTTP, BullMQ, the
 * crons and Baileys — on a process that had already drained and reached
 * `stopped`. A rolling deploy that kills a slow pod would leave exactly that:
 * a process "stopped" on paper and fully wired in reality.
 *
 * Two guarantees:
 *   - CANCELLATION — the boot stops at the first checkpoint after the signal;
 *   - SERIALIZATION — the shutdown waits for the phase already in flight, so
 *     nothing is closed while it is still being opened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  lifecycle,
  StartupAbortedError,
} from '../../../src/runtime/lifecycle/controller.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

beforeEach(() => {
  lifecycle._resetForTests();
});

describe('runStartupStep — cancellation', () => {
  it('runs the phase normally when no signal arrived', async () => {
    const fn = vi.fn(async () => 'value');
    await expect(lifecycle.runStartupStep('db', fn)).resolves.toBe('value');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('REFUSES to start a phase after the shutdown began', async () => {
    lifecycle.registerShutdownStep({ name: 'noop', run: async () => undefined });
    await lifecycle.shutdown({ signal: 'SIGTERM' });

    const fn = vi.fn(async () => undefined);
    await expect(lifecycle.runStartupStep('http', fn)).rejects.toBeInstanceOf(StartupAbortedError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('aborts AFTER a phase whose await spanned the signal — the next phase never opens anything', async () => {
    // This is the exact failure: the boot is parked on a slow dependency when
    // SIGTERM lands. The phase completes, and the boot must stop right there.
    const slow = deferred();
    lifecycle.registerShutdownStep({ name: 'noop', run: async () => undefined });

    const phase = lifecycle.runStartupStep('redis', async () => {
      await slow.promise;
      return 'connected';
    });
    // Signal lands while the phase is parked.
    const draining = lifecycle.shutdown({ signal: 'SIGTERM' });
    slow.resolve();

    await expect(phase).rejects.toBeInstanceOf(StartupAbortedError);
    await draining;

    // …and the phase that would have started BullMQ never runs.
    const startBullmq = vi.fn(async () => undefined);
    await expect(lifecycle.runStartupStep('queues', startBullmq)).rejects.toBeInstanceOf(
      StartupAbortedError,
    );
    expect(startBullmq).not.toHaveBeenCalled();
  });

  it('names the aborted step so the log says WHERE the boot stopped', async () => {
    lifecycle.registerShutdownStep({ name: 'noop', run: async () => undefined });
    await lifecycle.shutdown({ signal: 'SIGTERM' });
    await lifecycle.runStartupStep('whatsapp_session', async () => undefined).catch((err) => {
      expect(err).toBeInstanceOf(StartupAbortedError);
      expect((err as StartupAbortedError).step).toBe('whatsapp_session');
      expect((err as StartupAbortedError & { code: string }).code).toBe('STARTUP_ABORTED');
    });
    expect.assertions(3);
  });

  it('propagates a genuine dependency failure unchanged (not an abort)', async () => {
    await expect(
      lifecycle.runStartupStep('redis', async () => {
        throw new Error('redis unavailable at startup');
      }),
    ).rejects.toThrow(/redis unavailable/);
    expect(lifecycle.isShuttingDown()).toBe(false);
  });

  it('clears the in-flight marker even when the phase throws', async () => {
    await lifecycle.runStartupStep('db', async () => {
      throw new Error('boom');
    }).catch(() => undefined);
    expect(lifecycle.startupStepInFlight).toBeNull();
  });
});

describe('shutdown — serialization against a boot in flight', () => {
  it('WAITS for the startup phase in flight before running any shutdown step', async () => {
    const order: string[] = [];
    const slow = deferred();
    lifecycle.registerShutdownStep({
      name: 'pools',
      run: async () => void order.push('shutdown_step'),
    });

    const phase = lifecycle.runStartupStep('redis', async () => {
      await slow.promise;
      order.push('startup_phase_finished');
    });

    const draining = lifecycle.shutdown({ signal: 'SIGTERM' });
    // Give the shutdown a chance to (incorrectly) race ahead.
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual([]);

    slow.resolve();
    await phase.catch(() => undefined);
    await draining;

    // The resource finished being opened BEFORE anything started closing.
    expect(order).toEqual(['startup_phase_finished', 'shutdown_step']);
  });

  it('still transitions to draining IMMEDIATELY, so /readyz sheds while it waits', async () => {
    const slow = deferred();
    lifecycle.registerShutdownStep({ name: 'noop', run: async () => undefined });
    const phase = lifecycle.runStartupStep('redis', async () => {
      await slow.promise;
    });
    const draining = lifecycle.shutdown({ signal: 'SIGTERM' });
    await new Promise((r) => setTimeout(r, 10));
    expect(lifecycle.state).toBe('draining');
    expect(lifecycle.isAcceptingWork()).toBe(false);
    slow.resolve();
    await phase.catch(() => undefined);
    await draining;
  });

  it('a wedged startup phase does NOT block the drain, but makes it INCOMPLETE', async () => {
    // Review round 2: the previous version of this test asserted
    // `result === 'clean'` and so protected the bug. Giving up on the wait is
    // not a clean shutdown — the boot phase is still running, and whatever it
    // is opening (an HTTP listener, a Baileys socket) can land AFTER the step
    // that would have closed it. The process must say so and exit forced.
    const order: string[] = [];
    lifecycle.registerShutdownStep({
      name: 'pools',
      run: async () => void order.push('shutdown_step'),
    });
    // Never settles — a dependency that hangs must not hold the drain hostage…
    void lifecycle
      .runStartupStep('http', () => new Promise<void>(() => undefined))
      .catch(() => undefined);

    const out = await lifecycle.shutdown({ signal: 'SIGTERM' });

    // …so the remaining steps still run (the pools DO get closed)…
    expect(order).toEqual(['shutdown_step']);
    // …but the outcome is honest about what it could not serialize against.
    expect(out.result).toBe('incomplete');
    expect(out.undrained).toContain('startup:http');
    // `runShutdown()` turns `incomplete` into a forced, non-zero exit.
  }, 30_000);

  it('names the wedged phase so the operator knows which resource may be live', async () => {
    lifecycle.registerShutdownStep({ name: 'baileys', run: async () => undefined });
    void lifecycle
      .runStartupStep('whatsapp_session', () => new Promise<void>(() => undefined))
      .catch(() => undefined);
    const out = await lifecycle.shutdown({ signal: 'SIGTERM' });
    expect(out.undrained).toEqual(['startup:whatsapp_session']);
  }, 30_000);

  it('a phase that yields IN TIME keeps the drain clean', async () => {
    const slow = deferred();
    lifecycle.registerShutdownStep({ name: 'pools', run: async () => undefined });
    const phase = lifecycle.runStartupStep('redis', async () => {
      await slow.promise;
    });
    const draining = lifecycle.shutdown({ signal: 'SIGTERM' });
    slow.resolve();
    await phase.catch(() => undefined);
    const out = await draining;
    expect(out.result).toBe('clean');
    expect(out.undrained).toEqual([]);
  });
});
