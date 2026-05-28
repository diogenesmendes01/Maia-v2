import { redis, isRedisConnected } from '@/lib/redis.js';
import { agentQueue } from './queue.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
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
 * Persistence: state lives in Redis + BullMQ, so a restart preserves the
 * pending debounce. If Redis is unavailable, the caller should fall back to
 * `enqueueAgent` (immediate processing) — this module reports failure but
 * does not retry.
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
 * Key formats:
 *   agent-debounce:${tenant_id}:${agent_id}:${phone}   (Redis state)
 *   debounce:${tenant_id}:${agent_id}:${phone}         (BullMQ jobId)
 *
 * Cache-invalidation note: this is a backwards-incompatible key change.
 * Pre-existing entries under the OLD `${phone}`-only prefixes are no
 * longer reachable through the public API and will age out via the
 * STATE_TTL_S Redis TTL (10 min) for state keys and the queue's natural
 * job lifecycle for jobIds. No explicit migration is required — debounce
 * state is short-lived by construction (a few seconds typical window,
 * 10-minute max-hold ceiling).
 */

const STATE_TTL_S = 600; // 10 min — well above MESSAGE_DEBOUNCE_MAX_MS, auto-cleans on dead users
const JOB_NAME = 'process-message-debounced';

/**
 * Compose the tenant-scoped debounce identity for a phone. Pulls
 * `tenant_id` + `agent_id` from the AsyncLocalStorage tenant context.
 * Throws `MissingTenantContextError` if invoked outside a
 * `runWithTenantContext` boundary — see invariant block above.
 *
 * Single source of truth: `STATE_KEY`, `debounceJobId`, and every
 * internal accessor pass through this so the namespace is impossible to
 * bypass at a callsite (you cannot construct a phone-only key through
 * the module's public surface).
 */
function scopedKey(phone: string): string {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  return `${tenant_id}:${agent_id}:${phone}`;
}

const STATE_KEY = (scoped: string): string => `agent-debounce:${scoped}`;

export const debounceJobId = (phone: string): string =>
  `debounce:${scopedKey(phone)}`;

type DebounceState = {
  /** ms since epoch when the FIRST message of this window was enqueued */
  first_enqueued_at: number;
};

// Note: the `scoped` parameter is the OUTPUT of `scopedKey(phone)` —
// `${tenant_id}:${agent_id}:${phone}`. Internal helpers operate on
// pre-composed values so we don't re-read ALS on every Redis touch.
async function readState(scoped: string): Promise<DebounceState | null> {
  if (!isRedisConnected()) return null;
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
  if (!isRedisConnected()) return;
  await redis.set(STATE_KEY(scoped), JSON.stringify(state), 'EX', STATE_TTL_S);
}

async function clearState(scoped: string): Promise<void> {
  if (!isRedisConnected()) return;
  await redis.del(STATE_KEY(scoped));
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
 */
export async function scheduleDebouncedAgent(params: {
  /**
   * The user's phone (e.g. `+5511999999999`). The debounce identity is
   * derived as `${tenant_id}:${agent_id}:${phone}` from the current
   * ALS tenant context — throws `MissingTenantContextError` when invoked
   * outside `runWithTenantContext` (see invariant block above).
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
  // Compose ONCE — throws here if context missing, before any Redis or
  // queue side-effect runs. Downstream helpers receive the pre-composed
  // value so we don't repeat the ALS read.
  const scoped = scopedKey(phone);
  const jobId = `debounce:${scoped}`;

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
  });

  // Preserve first_enqueued_at across resets so heldMs grows toward the
  // ceiling. On a true first message (no prior), stamp now.
  const first_enqueued_at = prior?.first_enqueued_at ?? now;
  await writeState(scoped, { first_enqueued_at });

  return { kind: 'scheduled', reset: !!prior, held_ms: heldMs };
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
 */
export async function clearDebounceState(phone: string): Promise<void> {
  const scoped = scopedKey(phone);
  await clearState(scoped);
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
};
