/**
 * Process role contract — issue #512, consumed by issue #513.
 *
 * A Maia deployment is ONE codebase that can play several operational roles:
 * serve HTTP, drain the BullMQ agent queue, run the cron scheduler, own the
 * WhatsApp sockets. Today every process plays ALL of them (`MAIA_PROCESS_ROLE=
 * all`), but readiness and shutdown already need to know WHICH role a process
 * is playing:
 *
 *   - readiness is role-aware — a worker-only process must not stay out of
 *     rotation because WhatsApp is reconnecting, and an API-only process must
 *     not announce readiness just because it can reach Redis;
 *   - shutdown is role-aware — you only drain what you own.
 *
 * This module is the EXPLICIT, EXPORTED contract for that split. Issue #513
 * (topology separation) is expected to consume it as-is:
 *
 *   - `roleOwns(role, component)`   → should THIS process start the component?
 *   - `roleRequires(role, component)` → does `/readyz` gate on the component?
 *
 * Adding a topology is therefore a data change here plus wiring in
 * `src/index.ts`, not a redesign of the lifecycle controller.
 *
 * Invariants (AGENTS.md §4):
 *   - fail-closed: an unknown role is a boot error (zod enum in
 *     `src/config/env.ts`), never a silent fallback to a permissive default;
 *   - every role REQUIRES `config`, `db`, `schema` and `redis` — there is no
 *     Maia process that can do useful, tenant-scoped work without them.
 */

/**
 * Every role a Maia process can play. `all` is the single-process compat mode
 * that ships today (and the documented rollback target in issue #512).
 */
export const PROCESS_ROLES = ['all', 'api', 'worker', 'scheduler', 'session-owner'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

/**
 * Named runtime components the lifecycle controller tracks. These are the
 * units of "started / ready / failed / stopped" AND the units readiness
 * reports on, so the two never drift apart.
 */
export const LIFECYCLE_COMPONENTS = [
  /** Config + secrets parsed and cross-validated (incl. strict keyring). */
  'config',
  /** PostgreSQL pool reachable. */
  'db',
  /** Applied migration version is compatible with the code on disk. */
  'schema',
  /** Redis connection established (BullMQ, dedup, debouncer, working memory). */
  'redis',
  /** Redis memory-pressure snapshot is fresh and below the critical ratio (#297). */
  'redis_memory',
  /** BullMQ queues constructed and reachable; backlog within limits. */
  'queue',
  /** BullMQ agent worker (and unrouted-replay worker) consuming. */
  'agent_worker',
  /** node-cron scheduler running the registered jobs. */
  'cron_scheduler',
  /** Primary Baileys session + additional line sessions. */
  'whatsapp_session',
  /** Fastify listening. */
  'http',
] as const;
export type LifecycleComponent = (typeof LIFECYCLE_COMPONENTS)[number];

export type RoleContract = {
  readonly role: ProcessRole;
  /** One-line operator description; surfaced in `/livez` and logs. */
  readonly description: string;
  /**
   * Components this role is responsible for STARTING. Issue #513 uses this to
   * decide what a given process boots; today `all` owns everything.
   */
  readonly owns: readonly LifecycleComponent[];
  /**
   * Components that MUST be healthy before this role announces readiness.
   * Fail-closed: a required component in `unknown`/`down` keeps `/readyz` at
   * 503 — the load balancer never routes to a half-built instance.
   */
  readonly requires: readonly LifecycleComponent[];
};

/** Dependencies no Maia process can do tenant-scoped work without. */
const CORE_REQUIRED = ['config', 'db', 'schema', 'redis', 'redis_memory'] as const;

export const ROLE_CONTRACTS: Readonly<Record<ProcessRole, RoleContract>> = {
  all: {
    role: 'all',
    description: 'single-process compat mode — serves HTTP, drains the queue, schedules crons and owns the WhatsApp sessions',
    owns: [...LIFECYCLE_COMPONENTS],
    requires: [
      ...CORE_REQUIRED,
      'http',
      'queue',
      'agent_worker',
      'cron_scheduler',
      'whatsapp_session',
    ],
  },
  api: {
    role: 'api',
    description: 'HTTP surface only — ingress, setup pairing, probes, metrics',
    owns: ['config', 'db', 'schema', 'redis', 'redis_memory', 'queue', 'http'],
    // Enqueues onto the agent queue, so the QUEUE must be reachable; it does
    // NOT consume, so `agent_worker` is another role's readiness concern.
    requires: [...CORE_REQUIRED, 'queue', 'http'],
  },
  worker: {
    role: 'worker',
    description: 'BullMQ consumer — drains the agent queue and the unrouted-replay queue',
    owns: ['config', 'db', 'schema', 'redis', 'redis_memory', 'queue', 'agent_worker'],
    requires: [...CORE_REQUIRED, 'queue', 'agent_worker'],
  },
  scheduler: {
    role: 'scheduler',
    description: 'cron scheduler — periodic jobs (sweepers, relayers, monitors, briefings)',
    owns: ['config', 'db', 'schema', 'redis', 'redis_memory', 'cron_scheduler'],
    requires: [...CORE_REQUIRED, 'cron_scheduler'],
  },
  'session-owner': {
    role: 'session-owner',
    description: 'WhatsApp transport owner — primary Baileys session + additional line sessions',
    owns: ['config', 'db', 'schema', 'redis', 'redis_memory', 'queue', 'whatsapp_session'],
    // Owns the ingress socket, so it must be able to ENQUEUE what it receives.
    requires: [...CORE_REQUIRED, 'queue', 'whatsapp_session'],
  },
};

export function getRoleContract(role: ProcessRole): RoleContract {
  const contract = ROLE_CONTRACTS[role];
  // Defensive: `role` is typed, but a value crossing a JSON/env boundary could
  // still be wrong. Fail-closed rather than returning a permissive default.
  if (!contract) throw new Error(`unknown process role: ${String(role)}`);
  return contract;
}

/** Should a process in `role` START `component`? */
export function roleOwns(role: ProcessRole, component: LifecycleComponent): boolean {
  return getRoleContract(role).owns.includes(component);
}

/** Does `/readyz` gate on `component` for `role`? */
export function roleRequires(role: ProcessRole, component: LifecycleComponent): boolean {
  return getRoleContract(role).requires.includes(component);
}

/**
 * Parse a raw role string (env, CLI flag, orchestrator label) fail-closed.
 * Unknown → throw, never a fallback. `undefined`/empty → `all`, the documented
 * compat mode.
 */
export function parseProcessRole(raw: string | undefined | null): ProcessRole {
  if (raw === undefined || raw === null || raw === '') return 'all';
  const found = PROCESS_ROLES.find((r) => r === raw);
  if (!found) {
    throw new Error(
      `invalid process role "${raw}" — expected one of: ${PROCESS_ROLES.join(', ')}`,
    );
  }
  return found;
}
