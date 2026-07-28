/**
 * Runtime lifecycle controller — issue #512.
 *
 * Before this module the process had no explicit notion of "started" vs
 * "ready" vs "draining": `system_started` was audited BEFORE dependencies were
 * validated, HTTP listened before the agent worker existed, `/readyz` could go
 * positive on a half-built instance, and `gracefulShutdown()` called
 * `process.exit(0)` without draining BullMQ, the crons or the WhatsApp
 * sockets.
 *
 * This is the single source of truth for:
 *
 *   starting → ready → draining → stopped
 *            ↘ failed ↗
 *
 * Design rules (issue #512 "Invariantes de implementação"):
 *   - readiness is NEVER positive during `starting`, `draining` or `failed`;
 *   - shutdown is IDEMPOTENT — concurrent signals share one promise;
 *   - a second signal escalates to a forced exit, and that is AUDITED/metered
 *     (`maia_shutdown_forced_total`), never silent;
 *   - close order never tears down a dependency before its consumers;
 *   - undrained components are reported (log + metric + audit metadata), the
 *     drain never pretends to have succeeded.
 *
 * The controller deliberately depends only on config/logger/metrics: it owns
 * ORDER and STATE, while the concrete "how do I close a Baileys socket"
 * knowledge stays in the module that owns the resource and is injected as a
 * shutdown step from `src/index.ts`.
 */
import { randomUUID } from 'node:crypto';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { incCounter, observeHistogram, setGaugeProvider, _internal } from '@/lib/metrics.js';
import {
  LIFECYCLE_COMPONENTS,
  getRoleContract,
  parseProcessRole,
  type LifecycleComponent,
  type ProcessRole,
} from './roles.js';

export const LIFECYCLE_STATES = ['starting', 'ready', 'draining', 'stopped', 'failed'] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/**
 * Legal transitions. `failed` can still drain — a process that died during
 * startup must still close whatever it already opened, or a crash-looping
 * deploy leaks sockets and pool connections.
 */
const VALID_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  starting: ['ready', 'draining', 'failed'],
  ready: ['draining', 'failed'],
  draining: ['stopped', 'failed'],
  failed: ['draining', 'stopped'],
  stopped: [],
};

export type ComponentState = 'pending' | 'starting' | 'ready' | 'degraded' | 'failed' | 'stopped';

export type ComponentSnapshot = {
  component: LifecycleComponent;
  state: ComponentState;
  since: string;
  /** Short, SANITIZED reason. Never a raw driver message (see `readiness.ts`). */
  reason?: string;
};

export type LifecycleSnapshot = {
  state: LifecycleState;
  role: ProcessRole;
  instance_id: string;
  started_at: string;
  state_since: string;
  uptime_ms: number;
  reason?: string;
  components: ComponentSnapshot[];
};

export type ShutdownStep = {
  /** Stable, low-cardinality label — used as a metric label and in logs. */
  name: string;
  run: () => Promise<void>;
  /** Overrides `SHUTDOWN_STEP_TIMEOUT_MS` for this step. */
  timeoutMs?: number;
  /**
   * When true a timeout/throw on this step marks the drain INCOMPLETE (the
   * step guarded real in-flight work). Informational steps set it to false.
   */
  critical?: boolean;
};

export type ShutdownOutcome = {
  result: 'clean' | 'incomplete';
  duration_ms: number;
  /** Steps that completed within their deadline. */
  drained: string[];
  /** Steps that timed out or threw — the honest "we did not finish" list. */
  undrained: string[];
};

/**
 * The startup was cancelled because a stop signal arrived mid-boot — issue
 * #512 review round 1 (P1 on `src/index.ts:319`).
 *
 * Typed so `main().catch` can tell "we were told to stop" apart from "a
 * mandatory dependency failed": the first is a normal rolling-deploy outcome
 * and must NOT be audited as `system_start_failed`.
 */
export class StartupAbortedError extends Error {
  readonly code = 'STARTUP_ABORTED';
  constructor(readonly step: string) {
    super(`startup aborted at step "${step}": shutdown requested`);
    this.name = 'StartupAbortedError';
  }
}

/** Timeout helper that resolves to a sentinel instead of racing an unhandled rejection. */
async function withDeadline<T>(
  p: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: boolean; err?: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ ok: false; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
    timer.unref?.();
  });
  try {
    const settled = await Promise.race([
      p.then((value) => ({ ok: true as const, value })).catch((err) => ({
        ok: false as const,
        timedOut: false,
        err,
      })),
      timeout,
    ]);
    return settled;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class LifecycleController {
  readonly instanceId = randomUUID().slice(0, 8);
  readonly startedAt = new Date();

  #role: ProcessRole = 'all';
  #state: LifecycleState = 'starting';
  #stateSince = new Date();
  #reason: string | undefined;
  #components = new Map<LifecycleComponent, ComponentSnapshot>();
  #steps: ShutdownStep[] = [];
  #shutdownPromise: Promise<ShutdownOutcome> | null = null;
  #signalCount = 0;
  #backgroundTasks = new Map<string, Set<Promise<unknown>>>();
  #gaugesRegistered = false;
  /** The startup phase currently executing, if any. See `runStartupStep`. */
  #startupStep: { name: string; done: Promise<unknown> } | null = null;

  constructor() {
    this.#resetComponents();
  }

  #resetComponents(): void {
    this.#components.clear();
    for (const c of LIFECYCLE_COMPONENTS) {
      this.#components.set(c, { component: c, state: 'pending', since: new Date().toISOString() });
    }
  }

  get role(): ProcessRole {
    return this.#role;
  }

  get state(): LifecycleState {
    return this.#state;
  }

  /**
   * Bind the process to a role. Called once at boot from `src/index.ts` (and
   * by tests). Fail-closed on an unknown value via `parseProcessRole`.
   */
  setRole(raw: ProcessRole | string | undefined): ProcessRole {
    this.#role = parseProcessRole(raw as string | undefined);
    return this.#role;
  }

  /**
   * Register `maia_lifecycle_state{role,state}`. Idempotent — safe to call
   * from `buildServer()` which tests invoke repeatedly.
   */
  registerGauges(): void {
    if (this.#gaugesRegistered) return;
    this.#gaugesRegistered = true;
    for (const state of LIFECYCLE_STATES) {
      setGaugeProvider(_internal.key('maia_lifecycle_state', { role: this.#role, state }), () =>
        this.#state === state ? 1 : 0,
      );
    }
  }

  isTransitionAllowed(to: LifecycleState): boolean {
    return VALID_TRANSITIONS[this.#state].includes(to);
  }

  /**
   * Atomic state transition. Returns false (and logs) on an illegal
   * transition instead of throwing: a shutdown path must never crash because
   * a second signal arrived a millisecond late.
   */
  transitionTo(to: LifecycleState, reason?: string): boolean {
    if (to === this.#state) return true;
    if (!this.isTransitionAllowed(to)) {
      logger.warn(
        { from: this.#state, to, role: this.#role, instance_id: this.instanceId },
        'lifecycle.transition_rejected',
      );
      return false;
    }
    const from = this.#state;
    this.#state = to;
    this.#stateSince = new Date();
    this.#reason = reason;
    logger.info(
      {
        from,
        to,
        role: this.#role,
        instance_id: this.instanceId,
        reason,
        grace_deadline_ms: config.SHUTDOWN_GRACE_MS,
      },
      'lifecycle.transition',
    );
    incCounter('maia_lifecycle_transition_total', { role: this.#role, from, to });
    return true;
  }

  setComponent(component: LifecycleComponent, state: ComponentState, reason?: string): void {
    this.#components.set(component, {
      component,
      state,
      since: new Date().toISOString(),
      reason,
    });
    logger.debug(
      { component, state, reason, role: this.#role, instance_id: this.instanceId },
      'lifecycle.component',
    );
  }

  getComponent(component: LifecycleComponent): ComponentSnapshot {
    return (
      this.#components.get(component) ?? {
        component,
        state: 'pending',
        since: this.startedAt.toISOString(),
      }
    );
  }

  /**
   * True when every component this ROLE requires reached `ready` at least
   * once. This is the startup gate (`/startupz`); steady-state health is
   * `readiness.ts`'s job.
   */
  requiredComponentsStarted(): { ok: boolean; missing: LifecycleComponent[] } {
    const missing = getRoleContract(this.#role).requires.filter(
      (c) => this.getComponent(c).state !== 'ready' && this.getComponent(c).state !== 'degraded',
    );
    return { ok: missing.length === 0, missing };
  }

  snapshot(): LifecycleSnapshot {
    return {
      state: this.#state,
      role: this.#role,
      instance_id: this.instanceId,
      started_at: this.startedAt.toISOString(),
      state_since: this.#stateSince.toISOString(),
      uptime_ms: Date.now() - this.startedAt.getTime(),
      reason: this.#reason,
      components: [...this.#components.values()],
    };
  }

  // ─── abortable startup ──────────────────────────────────────────────────
  //
  // Issue #512 review round 1 (P1 on `src/index.ts:319`): a SIGTERM mid-boot
  // triggered a CONCURRENT shutdown, but `main()` never revalidated the
  // lifecycle after its `await`s. When the pending dependency finally
  // answered, the boot happily went on to start HTTP, BullMQ, the crons and
  // Baileys — AFTER the sequence had already drained and closed them. In a
  // rolling deploy that kills a slow pod, this leaves a process that is
  // `stopped` on paper and fully wired in reality.
  //
  // Two guarantees here:
  //   - CANCELLATION: every startup phase checks the shutdown flag before it
  //     runs, so the boot stops at the first checkpoint after the signal;
  //   - SERIALIZATION: the shutdown waits for the phase already in flight
  //     before running its steps, so nothing is closed while it is still
  //     being opened.

  /**
   * Run one startup phase under the abort/serialize contract.
   * @throws StartupAbortedError when a stop signal already arrived.
   */
  async runStartupStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.assertStartupNotAborted(name);
    const run = fn();
    // Swallow on the BOOKKEEPING copy only — the caller keeps its own
    // rejection, which propagates out of the `await` below.
    this.#startupStep = { name, done: run.catch(() => undefined) };
    try {
      const value = await run;
      // A signal that landed WHILE this phase ran must stop the boot here,
      // before the next phase opens anything else.
      this.assertStartupNotAborted(name);
      return value;
    } finally {
      this.#startupStep = null;
    }
  }

  /** Throw if a stop signal already arrived. Cheap; call between boot phases. */
  assertStartupNotAborted(step: string): void {
    if (this.isShuttingDown()) throw new StartupAbortedError(step);
  }

  /** Name of the startup phase currently running (diagnostics/tests). */
  get startupStepInFlight(): string | null {
    return this.#startupStep?.name ?? null;
  }

  // ─── background tasks ───────────────────────────────────────────────────
  //
  // Fire-and-forget promises (post-turn reflection, trace enqueue, outbox
  // flush, alerts) used to be invisible to shutdown: `process.exit(0)` killed
  // them mid-flight. Anything registered here is AWAITED during the drain,
  // within the grace budget.

  /**
   * Track a critical fire-and-forget promise so the drain can wait for it.
   * Returns the SAME promise so call sites keep their current shape:
   * `void trackBackgroundTask('reflection', doIt())`.
   */
  trackBackgroundTask<T>(name: string, p: Promise<T>): Promise<T> {
    let set = this.#backgroundTasks.get(name);
    if (!set) {
      set = new Set();
      this.#backgroundTasks.set(name, set);
    }
    // Swallow rejection on the TRACKING copy only — the caller's own handler
    // (or lack of one) is unchanged by tracking.
    const tracked = p.catch(() => undefined);
    set.add(tracked);
    void tracked.finally(() => {
      set.delete(tracked);
      if (set.size === 0) this.#backgroundTasks.delete(name);
    });
    return p;
  }

  countBackgroundTasks(): number {
    let n = 0;
    for (const set of this.#backgroundTasks.values()) n += set.size;
    return n;
  }

  /** Names of task groups still in flight — reported on an incomplete drain. */
  pendingBackgroundTaskNames(): string[] {
    return [...this.#backgroundTasks.keys()];
  }

  async awaitBackgroundTasks(deadlineMs: number): Promise<string[]> {
    if (this.countBackgroundTasks() === 0) return [];
    const all = Promise.all([...this.#backgroundTasks.values()].flatMap((s) => [...s]));
    const settled = await withDeadline(all, deadlineMs);
    // `Promise.all` resolving means every tracked promise settled — nothing is
    // left in flight regardless of when the bookkeeping `finally` runs.
    if (settled.ok) return [];
    return this.pendingBackgroundTaskNames();
  }

  // ─── shutdown ───────────────────────────────────────────────────────────

  /**
   * Register a shutdown step. ORDER MATTERS and is the registration order:
   * `src/index.ts` registers stop-accepting-work steps before drain steps
   * before close-the-pool steps, so a consumer is never left holding a closed
   * Redis/Postgres handle.
   */
  registerShutdownStep(step: ShutdownStep): void {
    this.#steps.push(step);
  }

  /** Test seam — the controller is a process-wide singleton. */
  _resetForTests(): void {
    this.#state = 'starting';
    this.#stateSince = new Date();
    this.#reason = undefined;
    this.#steps = [];
    this.#shutdownPromise = null;
    this.#signalCount = 0;
    this.#backgroundTasks.clear();
    this.#startupStep = null;
    this.#role = 'all';
    this.#resetComponents();
  }

  isShuttingDown(): boolean {
    return this.#shutdownPromise !== null;
  }

  /**
   * May this process START a new unit of work (a BullMQ job, a cron tick, a
   * new side effect)? — issue #512 review round 1, P1 on `src/index.ts:260`.
   *
   * Deliberately checks `#shutdownPromise` and NOT just the state: `shutdown()`
   * sets the promise SYNCHRONOUSLY, before `#runShutdown` gets its first tick
   * to transition to `draining`. A queue consumer that only looked at the
   * state could therefore pull one more job out of that window and start
   * producing external effects while the transport is already closing.
   *
   * `starting` counts as accepting: the BullMQ workers are constructed before
   * the `ready` transition, and by then every mandatory dependency for the
   * role has been verified.
   */
  isAcceptingWork(): boolean {
    if (this.#shutdownPromise !== null) return false;
    return this.#state === 'starting' || this.#state === 'ready';
  }

  /**
   * Idempotent graceful shutdown. Concurrent callers (SIGTERM + SIGINT, or a
   * supervisor that sends both) share ONE promise — the sequence runs exactly
   * once. The SECOND signal escalates: it is counted, audited by the caller
   * and forces the exit after the in-flight drain gets no further chance.
   */
  shutdown(opts?: { reason?: string; signal?: string }): Promise<ShutdownOutcome> {
    this.#signalCount += 1;
    if (this.#shutdownPromise) {
      logger.warn(
        {
          signal: opts?.signal,
          signal_count: this.#signalCount,
          state: this.#state,
          instance_id: this.instanceId,
        },
        'lifecycle.shutdown_already_in_progress',
      );
      return this.#shutdownPromise;
    }
    this.#shutdownPromise = this.#runShutdown(opts);
    return this.#shutdownPromise;
  }

  /** How many stop signals this process has seen. */
  get signalCount(): number {
    return this.#signalCount;
  }

  async #runShutdown(opts?: { reason?: string; signal?: string }): Promise<ShutdownOutcome> {
    const t0 = Date.now();
    // Atomic FIRST move: `/readyz` must answer 503 on the very next request,
    // before any resource starts closing.
    this.transitionTo('draining', opts?.reason ?? opts?.signal ?? 'shutdown_requested');

    // SERIALIZE against a boot in flight (review round 1, P1 on
    // `src/index.ts:319`). Closing a resource while `main()` is still opening
    // it is how a "stopped" process ends up with live sockets. `runStartupStep`
    // aborts at its next checkpoint, so this wait is short — but it is bounded
    // anyway so a wedged dependency cannot hold the whole drain hostage.
    const startup = this.#startupStep;
    if (startup) {
      logger.info({ step: startup.name }, 'lifecycle.shutdown_waiting_for_startup_step');
      const settled = await withDeadline(startup.done, config.SHUTDOWN_STEP_TIMEOUT_MS);
      if (!settled.ok) {
        logger.error(
          { step: startup.name, timeout_ms: config.SHUTDOWN_STEP_TIMEOUT_MS },
          'lifecycle.shutdown_startup_step_did_not_yield',
        );
      }
    }

    const grace = config.SHUTDOWN_GRACE_MS;
    const drained: string[] = [];
    const undrained: string[] = [];

    for (const step of this.#steps) {
      const remaining = grace - (Date.now() - t0);
      if (remaining <= 0) {
        undrained.push(step.name);
        logger.error(
          { step: step.name, grace_ms: grace, instance_id: this.instanceId },
          'lifecycle.shutdown_step_skipped_deadline_expired',
        );
        continue;
      }
      const budget = Math.min(step.timeoutMs ?? config.SHUTDOWN_STEP_TIMEOUT_MS, remaining);
      const stepStart = Date.now();
      const settled = await withDeadline(step.run(), budget);
      const elapsed = Date.now() - stepStart;
      observeHistogram('maia_shutdown_duration_ms', elapsed, { component: step.name });
      if (settled.ok) {
        drained.push(step.name);
        logger.info({ step: step.name, duration_ms: elapsed }, 'lifecycle.shutdown_step_done');
        continue;
      }
      // `critical !== false` defaults to critical — a step must opt OUT.
      if (step.critical === false) {
        drained.push(step.name);
      } else {
        undrained.push(step.name);
      }
      logger.error(
        {
          step: step.name,
          duration_ms: elapsed,
          timed_out: settled.timedOut,
          err: settled.timedOut ? 'deadline_exceeded' : (settled.err as Error)?.message,
          instance_id: this.instanceId,
        },
        'lifecycle.shutdown_step_failed',
      );
    }

    const result: ShutdownOutcome['result'] = undrained.length === 0 ? 'clean' : 'incomplete';
    this.transitionTo('stopped', result === 'clean' ? 'drained' : 'deadline_or_error');
    incCounter('maia_shutdown_total', { result, role: this.#role });
    const duration_ms = Date.now() - t0;
    logger.info(
      {
        result,
        duration_ms,
        drained,
        undrained,
        role: this.#role,
        instance_id: this.instanceId,
      },
      result === 'clean' ? 'lifecycle.shutdown_complete' : 'lifecycle.shutdown_incomplete',
    );
    return { result, duration_ms, drained, undrained };
  }

  /** Record a forced exit (second signal, or the post-drain exit backstop). */
  recordForcedShutdown(reason: string): void {
    incCounter('maia_shutdown_forced_total', { reason, role: this.#role });
    logger.error(
      { reason, role: this.#role, instance_id: this.instanceId, state: this.#state },
      'lifecycle.forced_shutdown',
    );
  }
}

/** Process-wide singleton. */
export const lifecycle = new LifecycleController();

/** Convenience re-export used by probes and tests. */
export function getLifecycleState(): LifecycleState {
  return lifecycle.state;
}
