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
  /** Perform the upload. SHOULD honour `signal` — but must not be trusted to. */
  put(signal: AbortSignal): Promise<void>;
  /** Does an object exist at the target key right now? */
  objectExists(): Promise<boolean>;
  /** Delete the object at the target key. */
  deleteObject(): Promise<void>;
  log?: (event: string, detail: Record<string, unknown>) => void;
  /** Raise an operator alert. Used when an orphan can only be DECLARED. */
  alert?: (detail: Record<string, unknown>) => Promise<void>;
}

export interface DeadlineUploadResult {
  /** Whether the deadline fired (the upload was cancelled). */
  timedOut: boolean;
  /**
   * What happened to a possible leftover object.
   *
   * `unknown` is the honest answer when the transport never acknowledged the
   * cancellation: we do not know whether an object exists, and we must not
   * claim we cleaned up. A DECLARED orphan is recoverable; a silent one is not.
   */
  orphan: 'none' | 'reaped' | 'reap_failed' | 'reap_unconfirmed' | 'unknown';
}

/**
 * How long to wait for a cancelled upload to actually stop.
 *
 * ROUND-2 REVIEW FINDING: the first version awaited the aborted operation with
 * NO second bound. A provider or transport that ignores `AbortSignal` and never
 * settles would hang the run forever — and a run that never terminalizes leaves
 * its `backup_runs` row non-terminal, which the single-active index turns into
 * a permanent block on all future backups. Exactly the outage the round-1 audit
 * fix closed, reached by another road.
 */
export const DEFAULT_CANCEL_GRACE_MS = 30_000;

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
  options: { cancelGraceMs?: number } = {},
): Promise<DeadlineUploadResult> {
  const log = deps.log ?? (() => undefined);
  const graceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const controller = new AbortController();

  let putError: unknown = null;
  // Both outcomes are absorbed here, so the promise NEVER rejects and a late
  // failure — arriving after we have already given up on it — cannot surface as
  // an unhandled rejection and take the process down.
  const put = deps.put(controller.signal).then(
    () => undefined,
    (err: unknown) => {
      putError = err;
    },
  );

  if (await settledWithin(put, timeoutMs)) {
    if (putError !== null) {
      throw new TypedError('upload_failed', 'the destination rejected the upload', {
        cause: (putError as Error).name,
      });
    }
    return { timedOut: false, orphan: 'none' };
  }

  // Budget exhausted. Cancel, then wait a BOUNDED grace for the operation to
  // acknowledge it. Waiting unbounded here was the round-2 finding.
  controller.abort();
  if (!(await settledWithin(put, graceMs))) {
    // The transport never acknowledged the cancellation. We do not know whether
    // an object exists, and touching the key now would race a write that may
    // still be in flight — so we DECLARE the uncertainty and alert instead of
    // claiming a cleanup we did not perform.
    log('backup.upload_cancel_timeout', {
      timeout_ms: timeoutMs,
      cancel_grace_ms: graceMs,
      impact:
        'upload did not acknowledge cancellation; an untracked object may exist at the destination',
    });
    await deps
      .alert?.({
        reason: 'upload_cancel_timeout',
        impact: 'a backup object may exist off-site with no manifest and no run row',
        action: 'inspect the bucket prefix for an object with no matching backup_runs row',
      })
      .catch(() => undefined);
    throw new TypedError(
      'upload_cancel_timeout',
      'upload exceeded its budget and did not acknowledge cancellation',
      { orphan: 'unknown' },
    );
  }

  // Cancellation acknowledged. The upload may still have created a complete or
  // partial object (a provider can finish committing a request whose client
  // went away), so the key is reaped rather than assumed clean.
  const orphan = await reapOrphan(deps, log);
  throw new TypedError('upload_timeout', 'upload exceeded its budget and was cancelled', {
    orphan,
  });
}

/**
 * Resolve `true` when `p` settles within `ms`, `false` when the timer wins.
 *
 * Never rejects and never leaves a timer armed. `p` is expected to be already
 * failure-absorbing (see `putWithDeadline`), so a pending operation simply
 * loses the race instead of throwing into it.
 */
function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    // `unref` where available so a pending grace timer cannot by itself keep a
    // CLI process (npm run backup) alive after the work is done.
    (timer as unknown as { unref?: () => void }).unref?.();
    void p.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
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
