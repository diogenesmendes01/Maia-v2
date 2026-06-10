import {
  redis,
  isRedisConnected,
  isRedisOomError,
  recordRedisOomDegraded,
} from '@/lib/redis.js';
import { agentQueue } from './queue.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import {
  getCurrentTenant,
  getCurrentAgent,
  MissingTenantContextError,
} from '@/db/tenant-context.js';
import { buildCacheKey } from '@/lib/cache-key.js';
import type { AgentJob } from './types.js';

/**
 * Per-user message debounce. WhatsApp users frequently split a single thought
 * into 2-4 messages within a few seconds ("Oi, " / "como está " / "a finança
 * da empresa X?"). Without buffering, each chunk triggers an LLM turn on
 * partial context, which can produce wrong or partial answers — bad in a
 * financial-assistant setting.
 *
 * Strategy: schedule a delayed BullMQ job per user with a deterministic
 * jobId. Each new message removes the pending job and re-adds it with a
 * fresh delay (timer reset). A max-hold ceiling prevents a continuously-
 * typing user from stalling responses indefinitely: once the original
 * enqueue is older than MESSAGE_DEBOUNCE_MAX_MS, the new message starts a
 * fresh window instead of resetting the existing one.
 *
 * The job's `mensagem_id` always points to the LATEST message at time of
 * scheduling. The agent worker is responsible for fetching any older
 * unprocessed inbound texts in the same conversation and aggregating them
 * into a single LLM turn (see `aggregateUnprocessedTexts` in agent core).
 *
 * Persistence: state lives in Redis + BullMQ. There is NO fallback path
 * when Redis is unavailable. See the FAIL-CLOSED CONTRACT block below for
 * why — silently bypassing the debounce on a Redis blip re-creates the
 * cross-tenant collision the per-key namespacing was added to prevent.
 *
 * TENANT/AGENT-ISOLATION INVARIANT (issue #248, north star principle):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Both the Redis state key AND the BullMQ jobId are namespaced with
 * `tenant_id` AND `agent_id`, pulled from AsyncLocalStorage via
 * `getCurrentTenant()` / `getCurrentAgent()`. Before this fix the keys
 * were derived from `phone` alone — a phone shared across tenants (common
 * in B2B SaaS where the owner uses the same WhatsApp number for personal
 * and company accounts, or a household member appears in two companies)
 * would COLLIDE: a message in tenant A would arm the debouncer, then a
 * message in tenant B with the same phone would either suppress (silent
 * drop) or fire under the wrong tenant context. Severity: MAJOR — silent
 * loss of legitimate messages in production.
 *
 * There is NO fallback to a "default" or empty namespace — if the caller
 * forgets `runWithTenantContext`, `getCurrentTenant()` / `getCurrentAgent()`
 * throw `MissingTenantContextError`. The tenant boundary is INVIOLABLE;
 * a missing-context bug must crash, NOT silently share state across
 * tenants. Both gateway ingress (baileys.ts → handleIncoming wraps in
 * 'default'/'default' for P0) and the agent worker (core.ts → runAgent
 * wraps in the channel-resolved tenant/agent) already provide a context,
 * so this throw is a true regression detector, not a tax on callers.
 *
 * Defense-in-depth (PR #259 review, mirrors #283 + #269 reval): every
 * ALS-derived `tenant_id` / `agent_id` is validated to be a non-empty,
 * non-whitespace string via a local `assertScopeSegment` guard (a stripped
 * equivalent of the project-wide `assertTruthyContext` from
 * `tenant-context.ts`, applied here because the host branch hasn't yet
 * merged that helper). A malformed context object
 * (`{ tenant_id: '', agent_id: null as any }`) coming from a broken
 * upstream wrap would otherwise interpolate as `undefined:undefined:phone`
 * or `:agent_id:phone` and collapse every tenant onto a single namespace —
 * the same silent leak the per-key prefix was supposed to close.
 *
 * Aliasing-safe key encoding (PR #259 review, mirrors PR #257 / #258
 * `buildKey` pattern from `_vision-cache.ts` and `bot-detection.ts`): each
 * segment is URI-encoded via `encodeURIComponent` before joining with `:`.
 * Rationale: `tenants.id` and `agents.id` are TEXT PRIMARY KEY (free-form
 * slug; see `migrations/007_p0_tenants_agents.sql`), so a slug like
 * `acme:dev` would otherwise key-alias against a `(tenant=acme,
 * agent=dev:something, phone=…)` tuple — defeating the isolation
 * invariant by *key aliasing*, not by missing context. The encoding makes
 * the `:` delimiter unambiguous (a `%` is the only escape introducer).
 *
 * FAIL-CLOSED CONTRACT (PR #259 review, MAJOR A):
 *   When Redis is unavailable, every Redis helper (`readState`,
 *   `writeState`, `clearState`) throws `DebouncerRedisUnavailableError`
 *   rather than returning `null` / void. `scheduleDebouncedAgent` and
 *   `clearDebounceState` also wrap their queue and Redis side-effects in
 *   try/catch and re-throw on failure — caller is expected to handle the
 *   error. The pre-fix early-return ladder (return null when
 *   `!isRedisConnected()`) was strictly worse than the documented
 *   contract: it caused `scheduleDebouncedAgent` to continue without
 *   per-tenant state, then fall through to BullMQ `add` which would
 *   succeed and enqueue under the (correct) namespaced jobId, BUT the
 *   caller in `baileys.ts:384-392` ALSO catches any throw and immediately
 *   enqueues without debounce, which silently bypasses the tenant-scoped
 *   debounce window for every message during a Redis blip. The caller's
 *   fallback is fine for the BullMQ-side error (we don't want to lose the
 *   message), but it must NOT be invoked just because Redis state is
 *   transiently unreadable — fail-loud here forces the caller (a) to log
 *   the bypass explicitly, (b) to consider whether immediate enqueue is
 *   truly the right policy. See `baileys.ts:362-393` for the caller side
 *   of the contract.
 *
 * Key formats:
 *   agent-debounce:${enc(tenant_id)}:${enc(agent_id)}:${enc(phone)}   (Redis state)
 *   debounce:${enc(tenant_id)}:${enc(agent_id)}:${enc(phone)}         (BullMQ jobId)
 *
 * Cache-invalidation note: this is a backwards-incompatible key change.
 * Pre-existing entries under the OLD `${phone}`-only prefixes are no
 * longer reachable through the public API and will age out via the
 * STATE_TTL_S Redis TTL (10 min) for state keys and the queue's natural
 * job lifecycle for jobIds. No explicit migration is required — debounce
 * state is short-lived by construction (a few seconds typical window,
 * 10-minute max-hold ceiling). The encoding refinement has the same
 * property: keys whose unencoded form differs only on `:` or `%` simply
 * expire on the existing TTL.
 */

const STATE_TTL_S = 600; // 10 min — well above MESSAGE_DEBOUNCE_MAX_MS, auto-cleans on dead users
const JOB_NAME = 'process-message-debounced';

/**
 * Signal that the debouncer cannot make a tenant-safe decision because
 * Redis is unavailable. Distinct from `MissingTenantContextError` (which
 * means the caller forgot the wrap) — this one is caused by infrastructure
 * the caller cannot fix in the moment.
 *
 * The caller in `baileys.ts` catches this AND the underlying Redis/BullMQ
 * errors and decides whether to fall through to immediate (non-debounced)
 * enqueue. We deliberately do NOT decide that here: the debouncer's job
 * is to either schedule a tenant-isolated buffered turn or report it
 * cannot, NOT to silently issue a non-debounced enqueue under the wrong
 * abstraction layer.
 */
export class DebouncerRedisUnavailableError extends Error {
  readonly code = 'DEBOUNCER_REDIS_UNAVAILABLE';
  /** True when the underlying cause was a Redis OOM (capacity) rather than a
   *  connection-down condition. Both map to the same fail-closed handling in
   *  the caller, but the flag lets observability separate capacity incidents
   *  from connectivity ones. */
  readonly oom: boolean;
  constructor(op: string, opts?: { oom?: boolean }) {
    const cause = opts?.oom ? 'OOM (memory cap reached)' : 'unavailable';
    super(`debouncer: Redis ${cause} during ${op}; refusing to bypass tenant-scoped debounce`);
    this.name = 'DebouncerRedisUnavailableError';
    this.oom = opts?.oom ?? false;
  }
}

/**
 * OOM handling (#309): convert a raw Redis OOM `ReplyError` into the
 * debouncer's controlled `DebouncerRedisUnavailableError` so the caller's
 * EXISTING fail-closed contract handles it (baileys.ts logs
 * `baileys.debounce_failed_fail_closed` and stops — the message is already
 * persisted in `mensagensRepo` and swept by `aggregateUnprocessedTexts` on
 * the next cycle). This is FAIL-CLOSED, NOT fail-open: we deliberately do
 * NOT silently "skip the debounce and continue", because that would either
 * drop the message or leave a BullMQ job armed without its companion Redis
 * state (the MAJOR D bug this module guards against). A raw `ReplyError`
 * must never escape to crash the dispatcher — it becomes a typed,
 * already-handled signal. Re-throws non-OOM errors untouched.
 */
function rethrowIfOom(err: unknown, op: string, scoped?: string): void {
  if (isRedisOomError(err)) {
    recordRedisOomDegraded(
      op === 'clearState' ? 'debouncer.clear_state' : 'debouncer.write_state',
      scoped ? { scoped_key: scoped } : undefined,
    );
    throw new DebouncerRedisUnavailableError(op, { oom: true });
  }
}

/**
 * Local equivalent of `assertTruthyContext` from `src/db/tenant-context.ts`
 * (added in commit c01c9c0 — landed on a sibling branch this PR has not
 * rebased onto yet). Reject empty, whitespace-only, or
 * surrounded-by-whitespace tenant/agent segments — `getCurrentTenant`/
 * `getCurrentAgent` would return them as-is on this branch, which a
 * malformed `runWithTenantContext({ tenant_id: '', agent_id: ' x ' }, …)`
 * wrap would silently propagate.
 *
 * We mirror the validation rules of the project-wide helper:
 *   1. Must be a string (reject null/undefined/number/etc.)
 *   2. `.trim().length > 0` (reject '', '   ', '\t', '\n')
 *   3. No surrounding whitespace (' acme ' rejects, not implicit-trim)
 *
 * Surrounding-whitespace rejection is intentional. Cache keys would
 * either alias or diverge silently between ' acme ', 'acme', and 'acme '
 * — the same class of bug the URI-encoding fix closes.
 *
 * Throws `MissingTenantContextError` (not a new type) because, from the
 * caller's perspective, a malformed value is the same defect as a missing
 * one: the boundary is unenforced. Same error code unblocks i18n/UI.
 */
function assertScopeSegment(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    // Note: `MissingTenantContextError`'s constructor on this branch does
    // NOT accept a `reason` argument yet (that landed on a sibling branch,
    // commit c01c9c0). We log the segment name alongside the throw so the
    // attribution survives without depending on the constructor signature.
    logger.warn(
      { segment: name, reason: 'empty_whitespace_or_surrounded' },
      'debounce.scope_segment_invalid',
    );
    throw new MissingTenantContextError();
  }
}

/**
 * Build the tenant-scoped Redis/jobId suffix via the centralized
 * `buildCacheKey` helper (issue #287 consolidation; empty prefix because
 * the namespace markers — `agent-debounce:` / `debounce:` — are prepended
 * by `STATE_KEY` / `debounceJobId`). Each segment is URI-encoded so the
 * `:` delimiter is unambiguous, and Redis glob metacharacters
 * (`* ? [ ] !`) are neutralized so a free-form WhatsApp lid can never act
 * as a wildcard in a `KEYS`/`SCAN` pattern.
 *
 * Key-compatibility note (#287): for segments without `*`/`!` the helper
 * emits byte-identical suffixes to the previous inline
 * `encodeURIComponent` concat — no version bump needed. Pathological keys
 * age out via STATE_TTL_S (10 min) / the BullMQ job lifecycle.
 */
function buildKey(tenant_id: string, agent_id: string, phone: string): string {
  return buildCacheKey('', tenant_id, agent_id, phone);
}

/**
 * Compose the tenant-scoped debounce identity for a phone. Pulls
 * `tenant_id` + `agent_id` from the AsyncLocalStorage tenant context.
 * Throws `MissingTenantContextError` if invoked outside a
 * `runWithTenantContext` boundary OR if the context carries empty /
 * whitespace-only segments — see invariant block above.
 *
 * Single source of truth: `STATE_KEY`, `debounceJobId`, and every
 * internal accessor pass through this so the namespace is impossible to
 * bypass at a callsite (you cannot construct a phone-only key through
 * the module's public surface).
 */
function scopedKey(phone: string): string {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  // Defense-in-depth: even after the ALS read, validate the segments are
  // truthy + trimmed. `tenant-context.ts` on the merge base of this PR
  // does NOT yet include `assertTruthyContext` (see commit c01c9c0 on a
  // sibling branch), so we MUST run the check locally to avoid emitting
  // `undefined:undefined:phone` from a malformed ALS context.
  assertScopeSegment(tenant_id, 'tenant_id');
  assertScopeSegment(agent_id, 'agent_id');
  return buildKey(tenant_id, agent_id, phone);
}

const STATE_KEY = (scoped: string): string => `agent-debounce:${scoped}`;

export const debounceJobId = (phone: string): string =>
  `debounce:${scopedKey(phone)}`;

type DebounceState = {
  /** ms since epoch when the FIRST message of this window was enqueued */
  first_enqueued_at: number;
};

// Note: the `scoped` parameter is the OUTPUT of `scopedKey(phone)` —
// `${enc(tenant_id)}:${enc(agent_id)}:${enc(phone)}`. Internal helpers
// operate on pre-composed values so we don't re-read ALS on every Redis
// touch.
//
// Fail-closed contract: each helper THROWS `DebouncerRedisUnavailableError`
// when Redis is disconnected — see FAIL-CLOSED CONTRACT block in the file
// header for why returning null/void here is unsafe.
async function readState(scoped: string): Promise<DebounceState | null> {
  if (!isRedisConnected()) {
    throw new DebouncerRedisUnavailableError('readState');
  }
  const raw = await redis.get(STATE_KEY(scoped));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DebounceState;
    if (typeof parsed.first_enqueued_at !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeState(scoped: string, state: DebounceState): Promise<void> {
  if (!isRedisConnected()) {
    throw new DebouncerRedisUnavailableError('writeState');
  }
  try {
    await redis.set(STATE_KEY(scoped), JSON.stringify(state), 'EX', STATE_TTL_S);
  } catch (err) {
    // OOM (#309) → typed fail-closed error; non-OOM falls through and propagates.
    rethrowIfOom(err, 'writeState', scoped);
    throw err;
  }
}

async function clearState(scoped: string): Promise<void> {
  if (!isRedisConnected()) {
    throw new DebouncerRedisUnavailableError('clearState');
  }
  try {
    await redis.del(STATE_KEY(scoped));
  } catch (err) {
    // OOM (#309) → typed fail-closed error; non-OOM falls through and propagates.
    rethrowIfOom(err, 'clearState', scoped);
    throw err;
  }
}

export type DebounceResult =
  | { kind: 'scheduled'; reset: boolean; held_ms: number }
  | { kind: 'max_hold_passthrough'; reason: 'max_hold_exceeded' };

/**
 * Schedule (or reschedule) a debounced agent job for the given key.
 *
 * - First message: enqueues a delayed job, records first_enqueued_at.
 * - Subsequent message within window AND within max-hold: removes the
 *   pending delayed job and re-adds it with a fresh delay (reset).
 * - Subsequent message after max-hold: leaves the pending job intact (it
 *   will fire on its original schedule) and returns `max_hold_passthrough`.
 *   Caller can choose to enqueue immediately for the new message, or trust
 *   that the next debounce cycle will catch it — current callers do NOT
 *   re-enqueue, since the agent worker aggregates unprocessed messages on
 *   its own (the new message will be picked up by the next firing cycle).
 *
 * Returns the action taken so callers can audit/log.
 *
 * Throws:
 *   - `MissingTenantContextError` — caller forgot the ALS wrap or
 *     supplied an empty/whitespace tenant/agent segment.
 *   - `DebouncerRedisUnavailableError` — Redis disconnected while we
 *     were trying to read/write debounce state. The caller (currently
 *     `baileys.ts`) decides whether to fall through to immediate enqueue.
 *   - Underlying Redis/BullMQ errors — surfaced as-is so the caller's
 *     observability path captures them. We do NOT swallow them, because
 *     swallowing would re-introduce the very bypass the namespace fix
 *     was meant to eliminate.
 */
export async function scheduleDebouncedAgent(params: {
  /**
   * The user's phone (e.g. `+5511999999999`). The debounce identity is
   * derived as `${enc(tenant_id)}:${enc(agent_id)}:${enc(phone)}` from
   * the current ALS tenant context — throws `MissingTenantContextError`
   * when invoked outside `runWithTenantContext` (see invariant block
   * above).
   */
  phone: string;
  mensagem_id: string;
  delay_ms?: number;
  max_hold_ms?: number;
}): Promise<DebounceResult> {
  const { phone, mensagem_id } = params;
  const delay = params.delay_ms ?? config.MESSAGE_DEBOUNCE_MS;
  const maxHold = params.max_hold_ms ?? config.MESSAGE_DEBOUNCE_MAX_MS;
  const now = Date.now();
  // Compose ONCE — throws here if context missing/malformed, before any
  // Redis or queue side-effect runs. Downstream helpers receive the
  // pre-composed value so we don't repeat the ALS read.
  const scoped = scopedKey(phone);
  const jobId = `debounce:${scoped}`;

  // Wrap the entire side-effect sequence in a single try/catch so a
  // failure mid-stream (e.g. Redis blip between `readState` and `add`,
  // or `writeState` failure after the BullMQ `add` already landed) is
  // surfaced loudly. Pre-fix, every `await` ran outside any local
  // try/catch — a failure on `agentQueue.add` would leak as an
  // unhandled rejection, AND a failure on `writeState` after a
  // successful `add` would leave the BullMQ job armed without its
  // companion Redis state, breaking the next message's reset logic.
  // (MAJOR D in the review.)
  try {
    const prior = await readState(scoped);
    const heldMs = prior ? now - prior.first_enqueued_at : 0;

    // Max-hold ceiling: don't let a continuously-typing user stall the
    // response forever. Leave the in-flight delayed job alone — when it
    // fires, the agent will sweep up the message we just received via the
    // unprocessed-aggregation path.
    if (prior && heldMs >= maxHold) {
      logger.debug(
        { scoped_key: scoped, held_ms: heldMs, max_hold_ms: maxHold },
        'debounce.max_hold_passthrough',
      );
      return { kind: 'max_hold_passthrough', reason: 'max_hold_exceeded' };
    }

    // Reset the timer: remove the pending job (if any) and re-add with a
    // fresh delay. Job ID is deterministic so BullMQ rejects duplicates
    // unless we remove the previous one first.
    const existing = await agentQueue.getJob(jobId).catch(() => null);
    if (existing) {
      await existing.remove().catch((err) => {
        // Race: job may have moved to active between getJob and remove.
        // That's OK — caller's new message will be aggregated when the
        // active job's agent run does the unprocessed sweep.
        logger.debug(
          { scoped_key: scoped, err: (err as Error).message },
          'debounce.remove_existing_failed_benign',
        );
      });
    }

    const data: AgentJob = { mensagem_id };
    await agentQueue.add(JOB_NAME, data, {
      jobId,
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 86_400 },
      // Bound failed-job retention so they age out instead of piling in Redis
      // indefinitely (#349). Working-memory keys carry a TTL but BullMQ jobs
      // did not — `removeOnComplete` was set while `removeOnFail` was not. The
      // bound is generous (1000 jobs / 7d) so the DLQ inspection path keeps
      // enough recent history; see docs/runbooks/redis.md §3.
      removeOnFail: { count: 1000, age: 7 * 24 * 3600 },
    });

    // Preserve first_enqueued_at across resets so heldMs grows toward the
    // ceiling. On a true first message (no prior), stamp now.
    const first_enqueued_at = prior?.first_enqueued_at ?? now;
    await writeState(scoped, { first_enqueued_at });

    return { kind: 'scheduled', reset: !!prior, held_ms: heldMs };
  } catch (err) {
    // OOM handling (#309): a raw OOM `ReplyError` can also surface from the
    // BullMQ `agentQueue.add` enqueue or the `readState` GET above (the
    // `writeState`/`clearState` helpers already converted theirs to a typed
    // `DebouncerRedisUnavailableError`, which is NOT an OOM ReplyError, so no
    // double-count here). Record the capacity signal and convert to the same
    // typed fail-closed error so the caller's existing
    // `baileys.debounce_failed_fail_closed` path handles it (message stays
    // persisted in Postgres, no raw ReplyError crash, no double-enqueue).
    if (isRedisOomError(err)) {
      recordRedisOomDegraded('debouncer.write_state', { scoped_key: scoped });
      logger.warn(
        { scoped_key: scoped, mensagem_id, redis_oom: true },
        'debounce.schedule_failed',
      );
      throw new DebouncerRedisUnavailableError('scheduleDebouncedAgent', { oom: true });
    }
    // Log here so the failing operation is attributable even if the
    // caller's catch logs a generic "debounce failed". We re-throw so
    // the caller can pick its fallback policy — fail-closed at this
    // layer means "I can't make a tenant-safe decision", not "drop the
    // message". See FAIL-CLOSED CONTRACT block at the file header.
    logger.warn(
      {
        scoped_key: scoped,
        mensagem_id,
        err: (err as Error).message,
        err_code: (err as { code?: string }).code,
      },
      'debounce.schedule_failed',
    );
    throw err;
  }
}

/**
 * Clear any pending debounce state for the given phone under the current
 * tenant/agent context. Called by the agent worker after it has aggregated
 * and processed the buffered messages, so the NEXT message starts a fresh
 * window. The BullMQ job is already gone at that point (it just finished
 * executing), so we only clear the Redis state key.
 *
 * Throws `MissingTenantContextError` when called outside a
 * `runWithTenantContext` boundary — fail-loud is intentional (see
 * invariant block above). Clearing the WRONG tenant's state would not
 * leak data, but it would corrupt debounce semantics for a sibling
 * tenant, so a missing context is treated as a hard error rather than
 * a silent no-op.
 *
 * Throws `DebouncerRedisUnavailableError` when Redis is unavailable —
 * same rationale as `scheduleDebouncedAgent`. Caller (agent worker) can
 * log and continue; the state TTL (10 min) means a missed clear is
 * self-healing within at most the next debounce window.
 */
export async function clearDebounceState(phone: string): Promise<void> {
  // Compose key OUTSIDE the try/catch so a context error throws cleanly
  // without being relabelled as a debounce.clear_failed log line — same
  // ordering rationale as `scheduleDebouncedAgent`.
  const scoped = scopedKey(phone);
  try {
    await clearState(scoped);
  } catch (err) {
    logger.warn(
      {
        scoped_key: scoped,
        err: (err as Error).message,
        err_code: (err as { code?: string }).code,
      },
      'debounce.clear_failed',
    );
    throw err;
  }
}

/**
 * Test seam — exposes internals so tests can drive the debouncer without
 * a live Redis. Not used in production.
 */
export const _internal = {
  STATE_KEY,
  JOB_NAME,
  readState,
  writeState,
  scopedKey,
  buildKey,
  assertScopeSegment,
};
