/**
 * The schema verdict `/readyz` gates on — issue #516 §6 — and, since ADR 0004,
 * the verdict the BOOT gates on too (`src/index.ts` → `./schema-boot-gate.ts`).
 * One evaluation, one cache, one answer: the boot cannot disagree with the
 * probe, because there is nothing left for it to disagree with.
 *
 * This module is a THIN, CACHED adapter over `getSchemaReadiness()`
 * (`src/migrations/readiness.ts`), which is the canonical, fail-closed answer
 * to "may this build serve traffic against this database?". It exists for two
 * reasons and no others:
 *
 *   1. **Wiring.** `getSchemaReadiness()` takes an injected read-only pool and
 *      a migrations directory; the readiness probe has neither. Here they are
 *      bound once to the application's own `pg` pool and to `migrations/` next
 *      to the running process — the same directory `scripts/migrate.ts` uses.
 *   2. **Cost.** `/readyz` is polled by a load balancer. `getSchemaReadiness()`
 *      does REAL I/O per call: it re-reads and SHA-256s every packaged
 *      migration (123 files / 1.3 MB today) and then reads the whole ledger.
 *      Measured on this repo it is ~50-100 ms of disk + CPU + two round trips.
 *      Doing that per request — or even per `READINESS_CACHE_MS` (2 s by
 *      default) — would be an operational regression against the check it
 *      replaces, which cached a single-row query for 60 s.
 *
 * ### Why the previous check is not enough (and what this fixes)
 *
 * `checkSchemaVersion()` compared the newest id in `schema_migrations` with the
 * newest `.sql` on disk and nothing else. It could not see a checksum mismatch,
 * could not see a `dirty` or orphaned `running` row, could not see a migration
 * the database applied but this build does not ship, and deliberately reported
 * "database ahead of the artifact" as OK. Each of those is a schema this build
 * must NOT serve traffic against. `getSchemaReadiness()` names all of them.
 *
 * ### Cache policy
 *
 * `SCHEMA_READINESS_TTL_MS = 10_000`.
 *
 * The TTL bounds two opposite risks and 10 s was chosen against both:
 *
 *   - **Stale positive** — the schema becomes incompatible (a newer release
 *     migrates the database past this build, a migration goes `dirty` mid-run)
 *     and this instance keeps answering 200 for up to one TTL. 10 s is well
 *     inside the window a load balancer needs anyway to declare a target
 *     unhealthy (typically 2-3 consecutive failures at a 5-10 s interval), so
 *     the cache is never the thing that decides how fast traffic drains.
 *
 *     One TTL is NOT the whole story, and the difference is the kind that gets
 *     found during an incident rather than in review. `/readyz` sits behind a
 *     SECOND cache: `evaluateComponents()` in `readiness.ts` memoizes the whole
 *     component set for `READINESS_CACHE_MS` (2 s by default). A composite
 *     entry filled just before this TTL expires keeps serving the same verdict
 *     until IT expires, so the real bound on a stale positive is
 *     `SCHEMA_READINESS_TTL_MS + READINESS_CACHE_MS` — 12 s at the defaults,
 *     and more if an operator raises `READINESS_CACHE_MS`. That composite bound
 *     is what `lifecycle-schema-readiness.spec.ts` pins; if you change either
 *     value, the test tells you the new number rather than letting the doc rot.
 *
 *     Note the irony, since it is load-bearing: the TTL below is a constant
 *     precisely so an operator cannot silently widen the gate — but
 *     `READINESS_CACHE_MS` IS operator-tunable and widens the same window. The
 *     constant bounds this module's contribution, not the end-to-end one.
 *   - **Stale negative** — after `migrate up` repairs the schema, the instance
 *     takes up to one TTL longer to rejoin rotation. 10 s is negligible next to
 *     the migration itself.
 *
 * Cost at that TTL: ~50-100 ms of work every 10 s (≈0.5-1 % of one core,
 * ~0.13 MB/s of page-cache reads), independent of the poll rate. A 60 s TTL
 * would be cheaper still, but it would let an instance serve traffic against a
 * schema it cannot verify for a full minute, which is exactly the failure this
 * gate exists to prevent.
 *
 * BOTH outcomes are cached, deliberately: caching only the positive would turn
 * a database outage into a probe storm at the worst possible moment.
 *
 * Concurrent polls are COALESCED (single-flight). Without that, a slow or
 * unreachable database would let every in-flight `/readyz` request start its
 * own evaluation — the probe timeout in `readiness.ts` returns early, but the
 * work behind it would keep piling up.
 */
import { join } from 'node:path';
import { pool } from '@/db/client.js';
import { getSchemaReadiness, type ReadOnlyPool, type SchemaReadiness } from '@/migrations/index.js';

/**
 * How long a schema verdict is reused. See the module doc for the trade-off;
 * it is a constant rather than a contract variable on purpose — a value an
 * operator can raise is a value that can silently unbind the gate.
 *
 * This bounds THIS module only. End to end, `/readyz` can serve a verdict for
 * `SCHEMA_READINESS_TTL_MS + READINESS_CACHE_MS`, because the composite
 * readiness cache sits in front of it. See the "Stale positive" bullet above.
 */
export const SCHEMA_READINESS_TTL_MS = 10_000;

/** Max length of the operator-facing detail put on the readiness response. */
const MAX_DETAIL_LENGTH = 400;

export interface SchemaReadinessDeps {
  readonly pool: ReadOnlyPool;
  readonly migrationsDir: string;
}

/**
 * Adapter over the application pool. `getSchemaReadiness()` needs only
 * `connect()` → `{ query, release }`, and it releases in a `finally`, so this
 * borrows one pooled connection per evaluation (once per TTL) and returns it.
 */
function applicationPool(): ReadOnlyPool {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        query: <R>(text: string, values?: unknown[]) =>
          client.query(text, values as unknown[]) as unknown as Promise<{ rows: R[] }>,
        release: () => {
          client.release();
        },
      };
    },
  };
}

let overrideDeps: SchemaReadinessDeps | null = null;

function resolveDeps(): SchemaReadinessDeps {
  return (
    overrideDeps ?? { pool: applicationPool(), migrationsDir: join(process.cwd(), 'migrations') }
  );
}

let cached: { at: number; verdict: SchemaReadiness } | null = null;
let inFlight: Promise<SchemaReadiness> | null = null;

/**
 * The cached, single-flight schema verdict.
 *
 * Never throws (`getSchemaReadiness()` guarantees it), and never returns
 * `ready: true` for a state it could not verify — the `unknown` verdict is a
 * NOT-ready answer, not a missing one.
 */
export async function checkSchemaReadiness(): Promise<SchemaReadiness> {
  const now = Date.now();
  if (cached && now - cached.at < SCHEMA_READINESS_TTL_MS) return cached.verdict;
  if (inFlight) return inFlight;

  inFlight = getSchemaReadiness(resolveDeps())
    .then((verdict) => {
      cached = { at: Date.now(), verdict };
      return verdict;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Sanitized, operator-facing one-liner for a NOT-ready verdict.
 *
 * Everything interpolated here is a literal from `src/migrations/` — blocker
 * kinds are a closed enum and blocker `detail` strings are our own text, which
 * `src/migrations/readiness.ts` guarantees never carries SQL, a driver message
 * or a DSN (a pg error message embeds `DATABASE_URL` with its password).
 */
export function describeSchemaReadiness(verdict: SchemaReadiness): string {
  const kinds = [...new Set(verdict.blockers.map((b) => b.kind))].join(', ');
  const reason = verdict.reason ?? 'schema state unavailable';
  const line = `${verdict.state}${kinds ? ` (${kinds})` : ''}: ${reason}`;
  return line.length > MAX_DETAIL_LENGTH ? `${line.slice(0, MAX_DETAIL_LENGTH - 1)}…` : line;
}

/** Test seam — drops the memoized verdict and any in-flight evaluation. */
export function _resetSchemaReadinessCacheForTests(): void {
  cached = null;
  inFlight = null;
}

/**
 * Test seam — point the gate at an injected pool / migrations directory so a
 * spec can drive the REAL `/readyz` route through the REAL evaluation logic
 * without mutating the shared database's `schema_migrations`. `null` restores
 * the application pool.
 */
export function _setSchemaReadinessDepsForTests(deps: SchemaReadinessDeps | null): void {
  overrideDeps = deps;
  _resetSchemaReadinessCacheForTests();
}
