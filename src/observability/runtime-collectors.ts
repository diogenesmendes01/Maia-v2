/**
 * Issue #535 §2 — the three scrape-time metric families the platform was
 * missing: Postgres pool saturation, WhatsApp session presence, scheduler lag.
 *
 * All three are STATE, not events, so they are gauges read at scrape time
 * rather than counters incremented on the hot path. The failure posture is the
 * one #514 established and the runbook depends on: a provider that cannot read
 * its source returns `NaN`, never `0` — "métrica ausente não é interpretada
 * como zero saudável". A dashboard plotting a healthy 0 for a dead pool is
 * worse than one plotting a gap, because the gap is unambiguous.
 *
 * ## Cardinality
 *
 * None of these carries `tenant_id`/`agent_id`, deliberately. They describe
 * PROCESS and INFRASTRUCTURE state (one pg pool, one WhatsApp socket, one
 * scheduler backlog), which no tenant owns. Adding tenant labels would
 * multiply series by tenant count for a value that is identical across all of
 * them — the exact growth the issue's predecessor asks us not to make worse.
 * Scheduler lag is a cross-tenant AGGREGATE for the same reason, following the
 * precedent of `turn-state-collector.ts`: the scope lives in the SQL, and only
 * counts leave the query — no ids, no payloads, no per-tenant series.
 */
import { gauge } from './metrics.js';
import { METRIC } from './taxonomy.js';
import { logger } from '@/lib/logger.js';

// ---------------------------------------------------------------------------
// Postgres pool
// ---------------------------------------------------------------------------

/**
 * The pg pool surface we need. Declared structurally rather than importing
 * `pg.Pool` so a test can hand in a plain object, and so this module does not
 * drag the driver into contexts that only want the taxonomy.
 */
export interface PoolStats {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
  readonly options?: { readonly max?: number };
}

/**
 * `maia_db_pool{state}` — four series describing one pool.
 *
 * The diagnostic that matters is the RELATION between them, which is why they
 * share a metric name instead of being four metrics: `waiting > 0` while
 * `idle == 0` and `total == max` is pool exhaustion (add connections or find
 * the leak); `waiting > 0` with `total < max` means the pool is still growing
 * and the wait is a connection-establishment cost, not saturation. `max` is
 * exported so an alert can be written against saturation RATIO without the
 * alert author having to know the deployment's configured ceiling.
 */
export function registerDbPoolGauges(pool: PoolStats): void {
  const read = (fn: () => number | undefined) => (): number => {
    const v = fn();
    return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
  };
  gauge(METRIC.DB_POOL, read(() => pool.totalCount), { state: 'total' });
  gauge(METRIC.DB_POOL, read(() => pool.idleCount), { state: 'idle' });
  gauge(METRIC.DB_POOL, read(() => pool.waitingCount), { state: 'waiting' });
  gauge(METRIC.DB_POOL, read(() => pool.options?.max), { state: 'max' });
}

// ---------------------------------------------------------------------------
// WhatsApp session
// ---------------------------------------------------------------------------

export interface WhatsAppSessionSource {
  connected(): boolean;
  lastDisconnectAt(): Date | null;
}

/**
 * `maia_whatsapp_sessions{state}` + `maia_whatsapp_session_age_seconds`.
 *
 * Two series (`connected` / `disconnected`) rather than one 0/1 gauge, because
 * with a single series "0" and "the scrape failed" render identically, and the
 * runbook's §4.7 rule says that ambiguity is the bug. With the pair, exactly
 * one is 1 when the collector is healthy and BOTH are absent when it is not.
 *
 * The age gauge is the reconnect-flapping signal the issue asks for: a value
 * that keeps resetting to ~0 is a socket that keeps dropping, which the binary
 * presence gauge cannot show because it may be `connected` at every scrape.
 * Before the first disconnect there is no reference instant, so the series is
 * `NaN` — not 0, which would read as "just dropped".
 */
export function registerWhatsAppSessionGauges(source: WhatsAppSessionSource): void {
  gauge(METRIC.WHATSAPP_SESSIONS, () => (source.connected() ? 1 : 0), {
    state: 'connected',
  });
  gauge(METRIC.WHATSAPP_SESSIONS, () => (source.connected() ? 0 : 1), {
    state: 'disconnected',
  });
  gauge(METRIC.WHATSAPP_SESSION_AGE_SECONDS, () => {
    const at = source.lastDisconnectAt();
    if (!at) return Number.NaN;
    return Math.max(0, Math.round((Date.now() - at.getTime()) / 1000));
  });
}

// ---------------------------------------------------------------------------
// Scheduler lag
// ---------------------------------------------------------------------------

/** One row of the scheduler-lag snapshot. */
export interface SchedulerLagEntry {
  /** Bounded queue name: `occurrences` | `outbox`. */
  readonly queue: string;
  /** Rows already due and not yet claimed. */
  readonly backlog: number;
  /** How late the OLDEST due row is, in ms. 0 when the backlog is empty. */
  readonly lag_ms: number;
}

export type SchedulerLagSnapshot = () => Promise<SchedulerLagEntry[]>;

/** Queues the gauges expose. Fixed set — the labels can never grow. */
const SCHEDULER_QUEUES = ['occurrences', 'outbox'] as const;

const SNAPSHOT_TTL_MS = 15_000;

let snapshot = new Map<string, SchedulerLagEntry>();
let lastRefreshAt = 0;
let inFlight: Promise<void> | null = null;
let snapshotFresh = false;
let registered = false;
let source: SchedulerLagSnapshot | null = null;

/**
 * Refresh at most once per window, sharing one promise between the concurrent
 * providers of a single scrape. Same shape as `turn-state-collector.ts`: four
 * gauge providers must not become four queries per scrape.
 *
 * A failed refresh clears `snapshotFresh` so the providers report `NaN`. This
 * is the deliberate difference from `turn-state-collector.ts`, which keeps
 * serving its last snapshot: a STALE lag value is actively misleading — it
 * says "the backlog is fine" using numbers from before the incident — whereas
 * a stale turn COUNT is merely old. `MaiaSchedulerMetricsAbsent` covers the
 * gap.
 */
async function refresh(): Promise<void> {
  if (Date.now() - lastRefreshAt < SNAPSHOT_TTL_MS) return;
  if (inFlight) return inFlight;
  lastRefreshAt = Date.now();
  inFlight = (async () => {
    try {
      const rows = (await source?.()) ?? [];
      const next = new Map<string, SchedulerLagEntry>();
      for (const r of rows) next.set(r.queue, r);
      snapshot = next;
      snapshotFresh = true;
    } catch (err) {
      snapshotFresh = false;
      logger.debug(
        { err: (err as Error).message },
        'scheduler_lag_collector.refresh_failed',
      );
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function read(queue: string, field: 'backlog' | 'lag_ms'): () => Promise<number> {
  return async () => {
    await refresh();
    if (!snapshotFresh) return Number.NaN;
    // A queue absent from the snapshot has no due rows — that IS zero, and the
    // query returning no row for it is how "empty" is expressed.
    return snapshot.get(queue)?.[field] ?? 0;
  };
}

/**
 * `maia_scheduler_lag_ms{queue}` + `maia_scheduler_backlog{queue}`.
 *
 * Lag, not depth, is the SLI: a scheduler with 10 000 items due in an hour is
 * healthy, and one with a single item three minutes overdue is not. Backlog is
 * the companion that separates "one stuck row" from "the tick stopped".
 */
export function registerSchedulerLagGauges(snapshotSource: SchedulerLagSnapshot): void {
  source = snapshotSource;
  if (registered) return;
  for (const queue of SCHEDULER_QUEUES) {
    gauge(METRIC.SCHEDULER_LAG_MS, read(queue, 'lag_ms'), { queue });
    gauge(METRIC.SCHEDULER_BACKLOG, read(queue, 'backlog'), { queue });
  }
  registered = true;
}

/** Test-only: module state survives between specs. */
export function _resetSchedulerLagForTests(): void {
  snapshot = new Map();
  lastRefreshAt = 0;
  inFlight = null;
  snapshotFresh = false;
  registered = false;
  source = null;
}

export const _SCHEDULER_QUEUES = SCHEDULER_QUEUES;
