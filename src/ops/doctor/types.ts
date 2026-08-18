/**
 * `maia doctor` — the check contract (issue #517).
 *
 * PURE module: types plus two tiny helpers. No I/O, no imports from the
 * runtime graph, so a check author can read the whole contract in one screen.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Where the doctor sits
 * ───────────────────────────────────────────────────────────────────────────
 * Four things in this repo answer "is it safe to run?" and they are NOT
 * interchangeable. The runbook (`docs/runbooks/doctor.md`) has the table; the
 * short version, because getting it wrong is how a check ends up in the wrong
 * place:
 *
 *   - **`config preflight`** (#572, in flight) — reads `compose.prod.yml` +
 *     the `.env.*` files BEFORE `docker compose up` and validates each
 *     service's effective environment against the subset of the contract its
 *     loader owns. Pure: opens no socket. A syntactically valid
 *     `BACKUP_S3_BUCKET` pointing at a bucket that does not exist PASSES there.
 *   - **`maia doctor`** (this) — runs INSIDE the deployed container, against
 *     the environment that actually materialised, and OPENS CONNECTIONS.
 *     Liveness, versions, server-side policy, schema state. Read-only.
 *   - **`/readyz`** — a per-instance, cached, load-balancer-facing gate. Two
 *     questions, one verdict, polled every few seconds.
 *   - **the synthetic probe** (#472) — continuous, and it exercises the LIVE
 *     path with real traffic. The doctor deliberately generates none.
 *
 * A check that can be answered from the environment alone belongs in the
 * config contract (`src/config/contract.ts`), not here. The doctor's own
 * config checks exist for exactly the two things a file-time validator cannot
 * see: what the container actually received, and the admin-ui's boot gates,
 * which are stricter than the contract.
 */
import type { MaiaProfile, MaiaService } from '@/config/metadata.js';
import type { SchemaReadiness } from '@/migrations/types.js';

/**
 * Verdict of a single check.
 *
 * `skip` is a first-class outcome, never a silent success: a check that could
 * not run says so and says why (issue §Critérios de aceite — "checks não
 * aplicáveis retornam `skip`, não falso sucesso").
 */
export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

/** Coarse grouping used for output ordering and for `--only`. */
export type DoctorCategory = 'runtime' | 'config' | 'postgres' | 'redis';

/**
 * What a failure of this check means operationally.
 *
 *   - `blocker` — a `fail` here makes the whole run exit 1.
 *   - `advisory` — a `fail` here is reported and degraded to a warning in the
 *     overall verdict. Reserved for checks whose negative answer is real but
 *     not a reason to hold a deploy.
 */
export type DoctorCriticality = 'blocker' | 'advisory';

/** Evidence values are primitives on purpose — they are rendered and JSON-ed. */
export type DoctorEvidence = Readonly<Record<string, string | number | boolean | null>>;

export interface DoctorResult {
  readonly status: DoctorStatus;
  /** One line, operator-facing. Never a stack trace, never a secret. */
  readonly summary: string;
  readonly evidence?: DoctorEvidence;
  /** Concrete next steps. REQUIRED by the runner for every `fail`. */
  readonly remediation?: readonly string[];
}

/** A result with the runner's bookkeeping attached. */
export interface DoctorCheckOutcome extends DoctorResult {
  readonly id: string;
  readonly category: DoctorCategory;
  readonly criticality: DoctorCriticality;
  readonly duration_ms: number;
  /** True when the check hit its own deadline or the total deadline. */
  readonly timed_out: boolean;
}

/**
 * Read-only Postgres access handed to a check.
 *
 * There is no non-read-only variant. `scripts/doctor.ts` builds this over a
 * pool whose sessions are `default_transaction_read_only=on` AND wraps every
 * statement in an explicit `BEGIN READ ONLY … ROLLBACK`, so a mutation is
 * refused by the SERVER (SQLSTATE 25006), not by our own discipline. See
 * `src/ops/doctor/postgres.ts`.
 */
export interface DoctorPostgres {
  /** Run one statement inside a read-only transaction. */
  query<R extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<readonly R[]>;
}

/**
 * Read-only Redis access handed to a check.
 *
 * Redis has no server-side read-only mode we can switch on for a normal
 * client, so the guarantee here is a CLOSED ALLOWLIST of commands
 * (`src/ops/doctor/redis.ts`): anything outside it throws before reaching the
 * socket.
 */
export interface DoctorRedis {
  ping(): Promise<string>;
  info(section?: string): Promise<string>;
  configGet(parameter: string): Promise<Readonly<Record<string, string>>>;
  /**
   * Class of the last transport-level error the client saw, or `null`.
   *
   * ioredis rejects a command issued against a dead server with a bare
   * `Error: Connection is closed.` — no `code`, no `errno` — while the useful
   * `ECONNREFUSED` / `ENOTFOUND` / `ETIMEDOUT` arrives separately on the
   * client's `error` EVENT. Without this seam the doctor's most common
   * failure would read "o check lançou (Error)", which diagnoses nothing.
   *
   * It is a CLASS, never a message: an ioredis error message embeds host and
   * port, and `REDIS_URL` carries the password.
   */
  lastErrorClass(): string | null;
}

/**
 * Everything a check may read. Deliberately narrow: a check cannot reach the
 * application pool, the BullMQ queues, the audit repositories or `checkAll()`
 * (which WRITES a health row per component — see `src/lib/healthcheck.ts`).
 */
export interface DoctorContext {
  /** Environment snapshot. Never mutated. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Resolved profile the run is being judged against. */
  readonly profile: MaiaProfile;
  /**
   * Which container's contract subset the run is judging. The doctor runs
   * INSIDE one service, and validating the whole contract there would reprove
   * a correctly-minimal environment for variables that service must never
   * receive — the same trap `config preflight` (#572) documents for the
   * `migrator`.
   */
  readonly service: MaiaService;
  /**
   * `true` when the operator asked for connected checks (`--online`).
   * Offline runs perform NO network I/O at all: checks that need a socket
   * return `skip`.
   */
  readonly online: boolean;
  /** Absolute path of the packaged `migrations/` directory. */
  readonly migrationsDir: string;
  /** `null` when Postgres was not reachable / not requested. */
  readonly postgres: DoctorPostgres | null;
  /** `null` when Redis was not reachable / not requested. */
  readonly redis: DoctorRedis | null;
  /**
   * The CANONICAL schema verdict from `src/migrations/readiness.ts`, bound by
   * the CLI to a read-only pool. `null` when Postgres was not opened.
   *
   * It is a bound thunk rather than something the check derives itself because
   * `src/migrations/index.ts` says so in as many words: "a consumer must never
   * re-derive schema health by parsing runner logs, counting rows or hashing
   * files itself". The doctor is one of the two consumers named there.
   */
  readonly schemaReadiness: (() => Promise<SchemaReadiness>) | null;
}

export interface DoctorCheck {
  readonly id: string;
  readonly category: DoctorCategory;
  readonly criticality: DoctorCriticality;
  /** One line for `--help`/docs: what a `pass` actually asserts. */
  readonly describes: string;
  /** Per-check deadline. The runner enforces it; the check need not. */
  readonly deadlineMs: number;
  /** `true` when the check opens a socket — skipped unless `--online`. */
  readonly requiresNetwork: boolean;
  /**
   * Check ids that must have produced `pass` (or `warn`) before this one is
   * meaningful. A check whose dependency failed is reported `skip`, so ONE
   * unavailable dependency never suppresses the independent checks — the
   * acceptance criterion "uma indisponibilidade não impede que os demais
   * checks independentes rodem".
   */
  readonly dependsOn?: readonly string[];
  run(ctx: DoctorContext, signal: AbortSignal): Promise<DoctorResult>;
}

/** Terse constructors — they keep the check bodies readable. */
export function pass(summary: string, evidence?: DoctorEvidence): DoctorResult {
  return evidence ? { status: 'pass', summary, evidence } : { status: 'pass', summary };
}

export function skip(summary: string, evidence?: DoctorEvidence): DoctorResult {
  return evidence ? { status: 'skip', summary, evidence } : { status: 'skip', summary };
}
