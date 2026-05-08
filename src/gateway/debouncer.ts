import { redis, isRedisConnected } from '@/lib/redis.js';
import { agentQueue } from './queue.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
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
 */

const STATE_KEY = (key: string): string => `agent-debounce:${key}`;
const STATE_TTL_S = 600; // 10 min — well above MESSAGE_DEBOUNCE_MAX_MS, auto-cleans on dead users
const JOB_NAME = 'process-message-debounced';

export const debounceJobId = (key: string): string => `debounce:${key}`;

type DebounceState = {
  /** ms since epoch when the FIRST message of this window was enqueued */
  first_enqueued_at: number;
};

async function readState(key: string): Promise<DebounceState | null> {
  if (!isRedisConnected()) return null;
  const raw = await redis.get(STATE_KEY(key));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DebounceState;
    if (typeof parsed.first_enqueued_at !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeState(key: string, state: DebounceState): Promise<void> {
  if (!isRedisConnected()) return;
  await redis.set(STATE_KEY(key), JSON.stringify(state), 'EX', STATE_TTL_S);
}

async function clearState(key: string): Promise<void> {
  if (!isRedisConnected()) return;
  await redis.del(STATE_KEY(key));
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
  key: string;
  mensagem_id: string;
  delay_ms?: number;
  max_hold_ms?: number;
}): Promise<DebounceResult> {
  const { key, mensagem_id } = params;
  const delay = params.delay_ms ?? config.MESSAGE_DEBOUNCE_MS;
  const maxHold = params.max_hold_ms ?? config.MESSAGE_DEBOUNCE_MAX_MS;
  const now = Date.now();
  const jobId = debounceJobId(key);

  const prior = await readState(key);
  const heldMs = prior ? now - prior.first_enqueued_at : 0;

  // Max-hold ceiling: don't let a continuously-typing user stall the
  // response forever. Leave the in-flight delayed job alone — when it
  // fires, the agent will sweep up the message we just received via the
  // unprocessed-aggregation path.
  if (prior && heldMs >= maxHold) {
    logger.debug({ key, held_ms: heldMs, max_hold_ms: maxHold }, 'debounce.max_hold_passthrough');
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
        { key, err: (err as Error).message },
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
  await writeState(key, { first_enqueued_at });

  return { kind: 'scheduled', reset: !!prior, held_ms: heldMs };
}

/**
 * Clear any pending debounce state for a key. Called by the agent worker
 * after it has aggregated and processed the buffered messages, so the
 * NEXT message starts a fresh window. The BullMQ job is already gone at
 * that point (it just finished executing), so we only clear the Redis
 * state key.
 */
export async function clearDebounceState(key: string): Promise<void> {
  await clearState(key);
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
};
