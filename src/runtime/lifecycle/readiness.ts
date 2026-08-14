/**
 * Role-aware readiness — issue #512 §2 (`/readyz`).
 *
 * Before this module `/readyz` answered a SINGLE question ("is Redis memory
 * pressure below the critical ratio?", issue #297) and therefore went positive
 * on an instance with no database, no agent worker and no WhatsApp session.
 * The composite gate here answers the real load-balancer question — "should
 * this instance be in rotation?" — against the components THIS PROCESS ROLE is
 * responsible for (see `roles.ts`).
 *
 * Contract:
 *   - lifecycle state is checked FIRST and is never cached, so a drain flips
 *     `/readyz` to 503 on the very next request (issue #512 acceptance:
 *     "Readiness retorna 503 imediatamente ao iniciar drain");
 *   - readiness is impossible in `starting`, `draining`, `failed`, `stopped`;
 *   - a REQUIRED component that is `down` or `unknown` keeps the instance out
 *     of rotation (fail-closed — AGENTS.md §4.2). Only components with an
 *     explicit, documented degradation policy may report `degraded` and stay
 *     in rotation;
 *   - the `schema` component is the CANONICAL migration verdict
 *     (`getSchemaReadiness()`, issue #516) via `schema-readiness.ts`: dirty
 *     state, a divergent checksum, a migration file this build does not ship
 *     and an incompatible head all answer 503, and so does `unknown`;
 *   - every probe is READ-ONLY (no writes, no rows) and bounded by
 *     `READINESS_PROBE_TIMEOUT_MS`; a timeout reports `unknown`, i.e. it fails
 *     closed for a required component;
 *   - the component evaluation is memoized for `READINESS_CACHE_MS` so an
 *     aggressive LB poll cannot turn the probe into a load generator;
 *   - `detail` strings are OUR literals. Raw driver messages, secrets and
 *     internal paths never reach the response body — they go to the log.
 */
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { incCounter, observeHistogram } from '@/lib/metrics.js';
import { probeDb } from '@/db/client.js';
import { isRedisConnected, redis } from '@/lib/redis.js';
import { isBaileysConnected } from '@/gateway/baileys.js';
import { checkReadiness as checkRedisMemoryReadiness } from '@/lib/healthcheck.js';
import { lifecycle, type LifecycleState } from './controller.js';
import { checkSchemaReadiness, describeSchemaReadiness } from './schema-readiness.js';
import { getRoleContract, type LifecycleComponent, type ProcessRole } from './roles.js';

export type ReadinessStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export type ReadinessCheck = {
  component: LifecycleComponent;
  status: ReadinessStatus;
  /** Whether this component gates readiness for the CURRENT role. */
  required: boolean;
  latency_ms?: number;
  /** Sanitized, operator-facing hint. Never a raw driver message. */
  detail?: string;
};

export type RoleReadinessReport = {
  ready: boolean;
  state: LifecycleState;
  role: ProcessRole;
  instance_id: string;
  reason?: string;
  checks: ReadinessCheck[];
};

/** States in which readiness can never be positive. */
const NOT_READY_STATES: readonly LifecycleState[] = ['starting', 'draining', 'failed', 'stopped'];

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Map a controller component state to a probe status (no I/O). */
function fromComponentState(component: LifecycleComponent): ReadinessCheck {
  const snap = lifecycle.getComponent(component);
  const status: ReadinessStatus =
    snap.state === 'ready'
      ? 'ok'
      : snap.state === 'degraded'
        ? 'degraded'
        : snap.state === 'failed'
          ? 'down'
          : 'unknown';
  return { component, status, required: false, detail: snap.reason };
}

async function probeComponent(component: LifecycleComponent): Promise<ReadinessCheck> {
  switch (component) {
    case 'db': {
      const ok = await probeDb();
      return { component, status: ok ? 'ok' : 'down', required: false };
    }
    case 'schema': {
      // Issue #516: the gate is `getSchemaReadiness()` — the CANONICAL schema
      // verdict — and not the weaker #512 id comparison it replaced. It names
      // dirty state, checksum divergence, a migration the database applied but
      // this build does not ship, and an out-of-range schema; the old check saw
      // none of those. See `schema-readiness.ts` for the caching policy.
      //
      // `READINESS_SCHEMA_CHECK=false` is a documented, explicit policy for
      // environments that publish code and schema out of band. It is REFUSED at
      // boot in the production profile (`lifecycle/schema-check-disabled`,
      // src/config/rules.ts), so this branch cannot be reached in production.
      if (!config.READINESS_SCHEMA_CHECK) {
        return { component, status: 'ok', required: false, detail: 'schema check disabled' };
      }
      const r = await checkSchemaReadiness();
      // FAIL-CLOSED, both ways: `blocked` is a named incompatibility (`down`),
      // and `unknown` — the state could not be established at all — is
      // `unknown`, which keeps a required component out of rotation just as
      // hard. "I could not read the schema" is never "the schema is fine".
      return {
        component,
        status: r.state === 'ready' ? 'ok' : r.state === 'blocked' ? 'down' : 'unknown',
        required: false,
        detail: r.state === 'ready' ? undefined : describeSchemaReadiness(r),
      };
    }
    case 'redis': {
      if (!isRedisConnected()) return { component, status: 'down', required: false };
      try {
        await redis.ping();
        return { component, status: 'ok', required: false };
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'readiness.redis_ping_failed');
        return { component, status: 'down', required: false, detail: 'ping failed' };
      }
    }
    case 'redis_memory': {
      const r = await checkRedisMemoryReadiness();
      return {
        component,
        status: r.ready ? 'ok' : 'down',
        required: false,
        detail: r.ready ? undefined : r.reason,
      };
    }
    case 'queue': {
      const base = fromComponentState('queue');
      if (base.status !== 'ok' || config.READINESS_BACKLOG_MAX <= 0) return base;
      // Opt-in capacity shedding. Imported lazily so a role that never enables
      // it does not construct the BullMQ queues just to answer a probe.
      try {
        const { agentQueue } = await import('@/gateway/queue.js');
        const waiting = await agentQueue.getWaitingCount();
        if (waiting > config.READINESS_BACKLOG_MAX) {
          return {
            component,
            status: 'down',
            required: false,
            detail: `agent queue backlog ${waiting} > ${config.READINESS_BACKLOG_MAX}`,
          };
        }
        return base;
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'readiness.queue_backlog_probe_failed');
        return { component, status: 'unknown', required: false, detail: 'backlog probe failed' };
      }
    }
    case 'whatsapp_session': {
      const snap = lifecycle.getComponent('whatsapp_session');
      // Never established (or explicitly failed) → fail closed. This is the
      // "instância não fica ready antes do componente obrigatório" criterion.
      if (snap.state !== 'ready' && snap.state !== 'degraded') {
        return {
          component,
          status: snap.state === 'failed' ? 'down' : 'unknown',
          required: false,
          detail: snap.reason ?? 'session not established yet',
        };
      }
      if (isBaileysConnected()) return { component, status: 'ok', required: false };
      // Established once, currently reconnecting. Baileys drops are routine;
      // gating on them makes readiness flap and would drain the whole fleet on
      // a WhatsApp hiccup (issue #512 "Riscos residuais": WhatsApp readiness
      // must separate API capacity from CHANNEL capacity). Operators who want
      // the strict coupling set READINESS_REQUIRE_WHATSAPP_LIVE=true.
      return {
        component,
        status: config.READINESS_REQUIRE_WHATSAPP_LIVE ? 'down' : 'degraded',
        required: false,
        detail: 'socket disconnected (reconnecting)',
      };
    }
    // Purely in-process components: the controller registry IS the truth.
    case 'config':
    case 'agent_worker':
    case 'cron_scheduler':
    case 'http':
      return fromComponentState(component);
  }
}

type CacheEntry = { at: number; state: LifecycleState; role: ProcessRole; checks: ReadinessCheck[] };
let cache: CacheEntry | null = null;

async function evaluateComponents(
  role: ProcessRole,
  state: LifecycleState,
): Promise<ReadinessCheck[]> {
  const now = Date.now();
  if (cache && cache.role === role && cache.state === state && now - cache.at < config.READINESS_CACHE_MS) {
    return cache.checks;
  }
  const contract = getRoleContract(role);
  const required = new Set<LifecycleComponent>(contract.requires);
  const components = [...new Set<LifecycleComponent>([...contract.owns, ...contract.requires])];

  const checks = await Promise.all(
    components.map(async (component) => {
      const t0 = Date.now();
      const check = await withTimeout(
        probeComponent(component).catch((err): ReadinessCheck => {
          logger.warn(
            { component, err: (err as Error).message },
            'readiness.component_probe_threw',
          );
          return { component, status: 'unknown', required: false, detail: 'probe failed' };
        }),
        config.READINESS_PROBE_TIMEOUT_MS,
        { component, status: 'unknown', required: false, detail: 'probe timed out' },
      );
      const latency_ms = Date.now() - t0;
      observeHistogram('maia_readiness_check_duration_ms', latency_ms, { component });
      incCounter('maia_readiness_check_total', { component, result: check.status });
      return { ...check, required: required.has(component), latency_ms };
    }),
  );
  cache = { at: now, state, role, checks };
  return checks;
}

/** Not-ready answer derived purely from the lifecycle state — no I/O. */
function notReadyByState(state: LifecycleState, role: ProcessRole): RoleReadinessReport {
  // Report the in-memory component registry (free) so an operator can see
  // WHAT is missing, but do no I/O — a draining instance must not probe.
  const contract = getRoleContract(role);
  const checks = contract.requires.map((component) => ({
    ...fromComponentState(component),
    required: true,
  }));
  return {
    ready: false,
    state,
    role,
    instance_id: lifecycle.instanceId,
    reason:
      state === 'draining'
        ? 'draining: instance is shedding traffic before shutdown'
        : state === 'failed'
          ? 'startup failed: mandatory dependency unavailable'
          : state === 'stopped'
            ? 'stopped'
            : 'starting: mandatory components not verified yet',
    checks,
  };
}

/**
 * Composite readiness for the current process role.
 *
 * The lifecycle state is checked TWICE and never cached — before the probes
 * (so a draining instance does no I/O at all) and again immediately before the
 * response is built.
 *
 * The second check is the fix for review round 1 (P2 on `readiness.ts:275`):
 * `evaluateComponents()` can take up to `READINESS_PROBE_TIMEOUT_MS`, and a
 * SIGTERM landing inside that window used to be invisible — the request had
 * already sampled `state = 'ready'` and answered 200 from a snapshot taken
 * before the drain. That silently broke the "503 immediately on drain"
 * guarantee for exactly the requests in flight when the signal arrives, which
 * are the ones a rolling deploy produces.
 */
export async function checkRoleReadiness(): Promise<RoleReadinessReport> {
  const role = lifecycle.role;
  const instance_id = lifecycle.instanceId;

  const stateBefore = lifecycle.state;
  if (NOT_READY_STATES.includes(stateBefore)) return notReadyByState(stateBefore, role);

  const checks = await evaluateComponents(role, stateBefore);

  // RESAMPLE: the drain may have started while the probes were in flight.
  const stateAfter = lifecycle.state;
  if (NOT_READY_STATES.includes(stateAfter)) return notReadyByState(stateAfter, role);

  const blocking = checks.filter(
    (c) => c.required && c.status !== 'ok' && c.status !== 'degraded',
  );
  if (blocking.length > 0) {
    return {
      ready: false,
      state: stateAfter,
      role,
      instance_id,
      reason: `required component(s) not healthy: ${blocking
        .map((c) => `${c.component}=${c.status}`)
        .join(', ')}`,
      checks,
    };
  }
  return { ready: true, state: stateAfter, role, instance_id, checks };
}

/** Startup probe (`/startupz`): did this process finish initialization? */
export function checkStartup(): {
  started: boolean;
  state: LifecycleState;
  role: ProcessRole;
  instance_id: string;
  missing: LifecycleComponent[];
  reason?: string;
} {
  const state = lifecycle.state;
  const role = lifecycle.role;
  const { missing } = lifecycle.requiredComponentsStarted();
  // Once initialization completed the startup probe stays positive for the
  // rest of the process lifetime (Kubernetes hands over to liveness/readiness
  // at that point) — including while draining, where killing the pod for a
  // "failed startup probe" would abort the drain.
  const started = state === 'ready' || state === 'draining';
  return {
    started,
    state,
    role,
    instance_id: lifecycle.instanceId,
    missing,
    reason: started
      ? undefined
      : state === 'failed'
        ? 'startup failed: mandatory dependency unavailable'
        : 'initialization in progress',
  };
}

/** Test seam — drops the memoized component evaluation. */
export function _resetReadinessCacheForTests(): void {
  cache = null;
}
