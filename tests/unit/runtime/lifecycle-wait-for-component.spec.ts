/**
 * Issue #512 review round 2, P1 (`src/index.ts:189`) — `ready`,
 * `system_started` and `/startupz` must wait for the first `open`.
 *
 * Round 1 fixed `/readyz` (the COMPONENT only becomes `ready` on
 * `connection.update = open`), but the PROCESS state still lied: the boot
 * transitioned the lifecycle to `ready` and audited `system_started` right
 * after the socket was armed. Three consumers were wrong at once — the
 * lifecycle state, the audit trail (claiming the system started at a moment
 * when `/readyz` was deliberately 503), and `/startupz`, which reads that
 * state.
 *
 * `waitForComponent` is the primitive that aligns all three with the same
 * criterion the component already uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { lifecycle } from '../../../src/runtime/lifecycle/controller.js';
import { checkStartup } from '../../../src/runtime/lifecycle/readiness.js';

const isReady = (s: string) => s === 'ready';
const settle = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  lifecycle._resetForTests();
});

describe('waitForComponent', () => {
  it('returns immediately when the component already satisfies the predicate', async () => {
    lifecycle.setComponent('whatsapp_session', 'ready');
    await expect(lifecycle.waitForComponent('whatsapp_session', isReady)).resolves.toBe('matched');
  });

  it('blocks while the component is still `starting`, and resolves on the transition', async () => {
    lifecycle.setComponent('whatsapp_session', 'starting');
    let resolved: string | null = null;
    const waiting = lifecycle
      .waitForComponent('whatsapp_session', isReady)
      .then((r) => (resolved = r));

    await settle();
    expect(resolved).toBeNull();

    // The `connection.update = open` handler does exactly this.
    lifecycle.setComponent('whatsapp_session', 'ready');
    await waiting;
    expect(resolved).toBe('matched');
  });

  it('does NOT resolve on an unrelated component change', async () => {
    lifecycle.setComponent('whatsapp_session', 'starting');
    let resolved: string | null = null;
    void lifecycle.waitForComponent('whatsapp_session', isReady).then((r) => (resolved = r));
    lifecycle.setComponent('db', 'ready');
    lifecycle.setComponent('queue', 'ready');
    await settle();
    expect(resolved).toBeNull();
  });

  it('is ABORTED by a stop signal — a SIGTERM while awaiting pairing drains cleanly', async () => {
    lifecycle.setComponent('whatsapp_session', 'starting');
    let resolved: string | null = null;
    const waiting = lifecycle
      .waitForComponent('whatsapp_session', isReady)
      .then((r) => (resolved = r));
    await settle();
    expect(resolved).toBeNull();

    lifecycle.registerShutdownStep({ name: 'noop', run: async () => undefined });
    const draining = lifecycle.shutdown({ signal: 'SIGTERM' });
    await waiting;
    expect(resolved).toBe('aborted');

    // …and because the wait yielded, the drain does not have to time out on it.
    const out = await draining;
    expect(out.result).toBe('clean');
    expect(out.undrained).toEqual([]);
  });

  it('honours an explicit timeout when one is given', async () => {
    lifecycle.setComponent('whatsapp_session', 'starting');
    await expect(
      lifecycle.waitForComponent('whatsapp_session', isReady, { timeoutMs: 30 }),
    ).resolves.toBe('timeout');
  });

  it('leaves no waiter registered after it settles (no leak across boots)', async () => {
    lifecycle.setComponent('whatsapp_session', 'starting');
    const w = lifecycle.waitForComponent('whatsapp_session', isReady, { timeoutMs: 20 });
    await w;
    // A later change must not throw or re-resolve anything.
    expect(() => lifecycle.setComponent('whatsapp_session', 'ready')).not.toThrow();
  });
});

describe('startup completion is gated on the first `open`', () => {
  /** Reproduces the boot's whatsapp phase for a role that requires the session. */
  async function bootWhatsAppPhase(): Promise<void> {
    await lifecycle.runStartupStep('whatsapp_session', async () => {
      lifecycle.setComponent('whatsapp_session', 'starting');
      await lifecycle.waitForComponent('whatsapp_session', isReady);
    });
    lifecycle.assertStartupNotAborted('ready');
    lifecycle.transitionTo('ready', 'startup_complete');
  }

  it('the lifecycle stays `starting` and /startupz stays 503-worthy until the session opens', async () => {
    let booted = false;
    void bootWhatsAppPhase().then(() => (booted = true));
    await settle();

    expect(booted).toBe(false);
    expect(lifecycle.state).toBe('starting');
    const startup = checkStartup();
    expect(startup.started).toBe(false);
    expect(startup.missing).toContain('whatsapp_session');
  });

  it('reaching `ready` (and therefore the system_started audit) happens only after `open`', async () => {
    let booted = false;
    const boot = bootWhatsAppPhase().then(() => (booted = true));
    await settle();
    expect(booted).toBe(false);

    lifecycle.setComponent('whatsapp_session', 'ready'); // the `open` handler
    await boot;

    expect(booted).toBe(true);
    expect(lifecycle.state).toBe('ready');
    expect(checkStartup().started).toBe(true);
  });

  it('a stop signal during the pairing wait aborts the boot instead of announcing ready', async () => {
    lifecycle.registerShutdownStep({ name: 'noop', run: async () => undefined });
    const boot = bootWhatsAppPhase();
    await settle();
    void lifecycle.shutdown({ signal: 'SIGTERM' });

    await expect(boot).rejects.toThrow(/startup aborted/i);
    // Never claimed ready, so `system_started` is never written.
    expect(lifecycle.state).not.toBe('ready');
  });
});
