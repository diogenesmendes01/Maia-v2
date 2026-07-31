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

/**
 * Issue #513 §5 — GRUPOS DE JOB de cron.
 *
 * `phase` (in `src/workers/index.ts`) is a ROLLOUT gate: "is this job safe to
 * enable yet?". It never said anything about topology, and that is precisely
 * why splitting roles broke things silently — a cron that manipulates the
 * Baileys socket map and a cron that only sweeps Postgres both carry
 * `phase: 1`, yet they cannot live in the same process once the topology is
 * split.
 *
 * The group is that second, orthogonal axis. It is declared on BOTH sides:
 * each job names its group, each role names the groups it runs. Neither side
 * can drift without the other noticing, and the boot log can answer "what is
 * this process running?" from data alone.
 *
 *   - `maintenance` — Postgres/Redis only: sweepers, relayers, monitors,
 *     matview refresh, backups. Runs in the `scheduler` role.
 *   - `session`     — reaches the in-process Baileys socket map, directly or
 *     transitively: the pairing bridge, the outbound drains, the synthetic
 *     probe, the briefings. Runs in the `session-owner` role.
 *
 * `all` declares BOTH, which is what keeps the single-process compat mode of
 * issue #512 byte-for-byte identical.
 */
export const JOB_GROUPS = ['maintenance', 'session'] as const;
export type JobGroup = (typeof JOB_GROUPS)[number];

export type RoleContract = {
  readonly role: ProcessRole;
  /** One-line operator description; surfaced in `/livez` and logs. */
  readonly description: string;
  /**
   * Cron job groups this role RUNS. Empty for roles that do not schedule at
   * all. A role listing a group MUST own `cron_scheduler` (the machinery),
   * and a role listing `session` MUST own `whatsapp_session` (the socket the
   * group's jobs reach for) — both invariants are locked by test.
   */
  readonly jobGroups: readonly JobGroup[];
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
    jobGroups: [...JOB_GROUPS],
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
    jobGroups: [],
    owns: ['config', 'db', 'schema', 'redis', 'redis_memory', 'queue', 'http'],
    // Enqueues onto the agent queue, so the QUEUE must be reachable; it does
    // NOT consume, so `agent_worker` is another role's readiness concern.
    requires: [...CORE_REQUIRED, 'queue', 'http'],
  },
  worker: {
    role: 'worker',
    description: 'BullMQ consumer — drains the agent queue and the unrouted-replay queue',
    jobGroups: [],
    owns: ['config', 'db', 'schema', 'redis', 'redis_memory', 'queue', 'agent_worker'],
    requires: [...CORE_REQUIRED, 'queue', 'agent_worker'],
  },
  scheduler: {
    role: 'scheduler',
    description: 'cron scheduler — periodic maintenance jobs (sweepers, relayers, monitors)',
    jobGroups: ['maintenance'],
    // Issue #513: `queue` was MISSING here and that made the role unusable.
    // `message_recovery` and `unrouted_recovery` are scheduler jobs whose whole
    // purpose is to ENQUEUE (`enqueueAgent` / `enqueueUnroutedReplay`), and
    // `src/index.ts` phase 7 returns early when the role does not own `queue` —
    // so a scheduler-only process ran those crons against a queue that had
    // never been constructed. Same shape as `api`: produces, never consumes.
    owns: ['config', 'db', 'schema', 'redis', 'redis_memory', 'queue', 'cron_scheduler'],
    requires: [...CORE_REQUIRED, 'queue', 'cron_scheduler'],
  },
  'session-owner': {
    role: 'session-owner',
    description:
      'WhatsApp transport owner — Baileys sessions + the session-bound cron jobs (pairing bridge, outbound drains)',
    jobGroups: ['session'],
    // Issue #513: `cron_scheduler` was MISSING here, and that silently broke
    // the #518 Admin→runtime bridge the moment the topology was actually
    // split. `channel_pairing` is a CRON job, but every one of its effects
    // reaches into the in-process Baileys session map:
    //   - `publishLocalSessionOwnership()` reads `listLocalLineSessions()`;
    //   - `stop_line`/`repair` call `stopLineSession()`;
    //   - `promoteReadyVerifiedLines()` calls `startLineSession()`.
    // In a split deployment that job ran on the SCHEDULER, where the map is
    // empty — so ownership was never published, addressed `stop_line` commands
    // were claimed by a replica holding no socket and "confirmed" against an
    // empty map (exactly the P1 that PR #528 round 2 closed, reintroduced by
    // topology), and the scheduler tried to OPEN Baileys sockets, violating
    // "scheduler não abre sockets".
    //
    // Owning `cron_scheduler` here does NOT mean this role runs every cron:
    // `startWorkers()` filters the registry by each job's declared `requires`
    // (see `src/workers/index.ts`). The session owner runs only the
    // session-bound jobs; the scheduler runs only the rest; `all` runs both.
    owns: [
      'config',
      'db',
      'schema',
      'redis',
      'redis_memory',
      'queue',
      'cron_scheduler',
      'whatsapp_session',
    ],
    // Owns the ingress socket, so it must be able to ENQUEUE what it receives.
    // Gates on `cron_scheduler` too: without it the pairing bridge and the
    // ownership heartbeat are not running, and an owner that cannot be
    // commanded or whose lease is not renewed must not be in rotation.
    requires: [...CORE_REQUIRED, 'queue', 'cron_scheduler', 'whatsapp_session'],
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
 * Should a process in `role` schedule the cron jobs of `group`?
 *
 * Deliberately NOT derived from `owns`: `session-owner` owns `cron_scheduler`
 * (it needs the machinery for the pairing bridge) but must NOT pick up the
 * maintenance sweepers — otherwise every maintenance job would run twice in a
 * split deployment, once on the scheduler and once on each session owner.
 * Ownership of the machinery and responsibility for a group are two different
 * questions, so they are two different fields.
 */
export function roleRunsJobGroup(role: ProcessRole, group: JobGroup): boolean {
  return getRoleContract(role).jobGroups.includes(group);
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
