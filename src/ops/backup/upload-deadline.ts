/**
 * Issue #520 §6 — a bounded upload that actually cancels, and leaves nothing
 * behind when it does not.
 *
 * ROUND-1 REVIEW FINDING (P2). The old bound was a `Promise.race` against a
 * timer: it rejected the OUTER promise and moved on, but the `PutObject` kept
 * going and the file stream stayed open. The run was then classified `failed`
 * while the upload quietly finished, producing a remote copy that no manifest
 * and no `backup_runs` row describes — an object outside the lifecycle, outside
 * retention and outside legal hold. Verifiable retention cannot have those.
 *
 * Three properties this module guarantees:
 *
 *  1. The deadline ABORTS the request (`AbortSignal` reaches the SDK and the
 *     source stream), rather than abandoning it.
 *  2. It then AWAITS the underlying operation's settlement. Reaping before the
 *     upload has finished would race — a slow request could recreate the object
 *     right after the delete.
 *  3. Only once it has settled does it reap: if an object exists at the key, it
 *     is deleted and the deletion is CONFIRMED. An unconfirmed reap is reported,
 *     never assumed.
 *
 * Pure orchestration with injected IO, so "the upload completes after the
 * deadline" is a case the tests can actually produce.
 */
import { TypedError } from '@/lib/utils.js';

export interface DeadlineUploadDeps {
  /** Perform the upload. MUST honour `signal`. */
  put(signal: AbortSignal): Promise<void>;
  /** Does an object exist at the target key right now? */
  objectExists(): Promise<boolean>;
  /** Delete the object at the target key. */
  deleteObject(): Promise<void>;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface DeadlineUploadResult {
  /** Whether the deadline fired (the upload was cancelled). */
  timedOut: boolean;
  /** What happened to a possible leftover object. */
  orphan: 'none' | 'reaped' | 'reap_failed' | 'reap_unconfirmed';
}

/**
 * Run `put` under a hard deadline. Resolves only when the operation has
 * genuinely finished — successfully, or cancelled AND cleaned up.
 *
 * Throws `upload_timeout` after a cancellation and `upload_failed` for any
 * other error, so the caller can tell "we ran out of budget" from "the
 * destination rejected us".
 */
export async function putWithDeadline(
  deps: DeadlineUploadDeps,
  timeoutMs: number,
): Promise<DeadlineUploadResult> {
  const log = deps.log ?? (() => undefined);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let putError: unknown = null;
  try {
    // Awaited even after the abort: we must know the request is really over
    // before deciding whether anything was left behind.
    await deps.put(controller.signal);
  } catch (err) {
    putError = err;
  } finally {
    clearTimeout(timer);
  }

  if (!timedOut) {
    if (putError !== null) {
      throw new TypedError('upload_failed', 'the destination rejected the upload', {
        cause: (putError as Error).name,
      });
    }
    return { timedOut: false, orphan: 'none' };
  }

  // Cancelled. The upload may still have created a complete or partial object
  // (a provider can finish committing a request whose client went away), so the
  // key is reaped rather than assumed clean.
  const orphan = await reapOrphan(deps, log);
  throw new TypedError('upload_timeout', 'upload exceeded its budget and was cancelled', {
    orphan,
  });
}

async function reapOrphan(
  deps: DeadlineUploadDeps,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<DeadlineUploadResult['orphan']> {
  let exists: boolean;
  try {
    exists = await deps.objectExists();
  } catch {
    // Cannot even tell — report it. An operator must check the bucket.
    log('backup.orphan_check_failed', { impact: 'a cancelled upload may have left an object' });
    return 'reap_unconfirmed';
  }
  if (!exists) return 'none';

  try {
    await deps.deleteObject();
  } catch {
    log('backup.orphan_reap_failed', {
      impact: 'a cancelled upload left an object outside the backup lifecycle',
    });
    return 'reap_failed';
  }

  // Confirm the deletion actually took. "We called delete" is not evidence.
  try {
    if (await deps.objectExists()) {
      log('backup.orphan_still_present', {
        impact: 'delete returned success but the object is still listed',
      });
      return 'reap_failed';
    }
  } catch {
    return 'reap_unconfirmed';
  }
  return 'reaped';
}
