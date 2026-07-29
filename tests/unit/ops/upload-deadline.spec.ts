import { describe, it, expect, vi } from 'vitest';
import { putWithDeadline, type DeadlineUploadDeps } from '../../../src/ops/backup/upload-deadline.js';

/**
 * Issue #520 §6 — round-1 review finding (P2): the upload timeout rejected the
 * outer promise but never cancelled `PutObject`, so a run classified `failed`
 * could still end up with a remote object nobody tracks.
 *
 * THE FAKE IS ADVERSARIAL. `provider()` models a store whose upload keeps going
 * after the deadline and CREATES the object anyway — the exact behaviour the
 * old `Promise.race` could not see. `honoursAbort: false` is the default for
 * the orphan cases precisely because a well-behaved SDK is the easy case.
 */

function provider(opts: {
  /** How long the upload takes. */
  durationMs: number;
  /** Whether the fake stops when aborted (a well-behaved client). */
  honoursAbort: boolean;
  /**
   * The worst case, and the one the round-2 review said the fake was missing:
   * the operation NEVER settles. Not "ignores abort but eventually resolves" —
   * a Promise that stays pending forever, which is what a wedged socket or a
   * provider SDK that drops the request looks like.
   */
  neverSettles?: boolean;
  /** Whether a completed upload creates the object. */
  creates?: boolean;
  deleteThrows?: boolean;
  existsThrows?: boolean;
  /** Delete "succeeds" but the object is still there. */
  deleteIsLie?: boolean;
}) {
  const store = new Set<string>();
  const logs: { event: string; detail: Record<string, unknown> }[] = [];
  const alerts: Record<string, unknown>[] = [];
  let settled = false;

  const deps: DeadlineUploadDeps = {
    put: (signal) =>
      new Promise<void>((resolve, reject) => {
        if (opts.neverSettles) return; // pending forever, on purpose
        const timer = setTimeout(() => {
          settled = true;
          if (opts.creates !== false) store.add('k');
          resolve();
        }, opts.durationMs);
        if (opts.honoursAbort) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            settled = true;
            reject(new Error('aborted'));
          });
        }
      }),
    alert: async (detail) => {
      alerts.push(detail);
    },
    objectExists: vi.fn(async () => {
      if (opts.existsThrows) throw new Error('403');
      return store.has('k');
    }),
    deleteObject: vi.fn(async () => {
      if (opts.deleteThrows) throw new Error('AccessDenied');
      if (!opts.deleteIsLie) store.delete('k');
    }),
    log: (event, detail) => logs.push({ event, detail }),
  };

  return { deps, store, logs, alerts, hasSettled: () => settled };
}

describe('the happy path is untouched', () => {
  it('resolves when the upload finishes inside the budget', async () => {
    const p = provider({ durationMs: 1, honoursAbort: true });
    await expect(putWithDeadline(p.deps, 200)).resolves.toEqual({
      timedOut: false,
      orphan: 'none',
    });
    expect(p.store.has('k')).toBe(true);
  });

  it('surfaces a destination rejection distinctly from a timeout', async () => {
    const deps: DeadlineUploadDeps = {
      put: async () => {
        throw new Error('AccessDenied');
      },
      objectExists: async () => false,
      deleteObject: async () => undefined,
    };
    await expect(putWithDeadline(deps, 1000)).rejects.toMatchObject({
      code: 'upload_failed',
    });
  });
});

describe('the finding: an upload that completes AFTER the deadline', () => {
  it('waits for the abandoned upload to settle before deciding', async () => {
    const p = provider({ durationMs: 40, honoursAbort: false });
    await expect(putWithDeadline(p.deps, 5)).rejects.toMatchObject({ code: 'upload_timeout' });
    // The old race returned while the request was still in flight; this must
    // not return until the operation is genuinely over.
    expect(p.hasSettled()).toBe(true);
  });

  it('leaves NO orphan object behind', async () => {
    const p = provider({ durationMs: 40, honoursAbort: false });
    await expect(putWithDeadline(p.deps, 5)).rejects.toMatchObject({
      code: 'upload_timeout',
      details: { orphan: 'reaped' },
    });
    expect(p.store.has('k')).toBe(false);
  });

  it('reports `none` when the cancelled upload created nothing', async () => {
    const p = provider({ durationMs: 40, honoursAbort: false, creates: false });
    await expect(putWithDeadline(p.deps, 5)).rejects.toMatchObject({
      details: { orphan: 'none' },
    });
  });

  it('cancels a well-behaved client and still checks for leftovers', async () => {
    const p = provider({ durationMs: 10_000, honoursAbort: true });
    await expect(putWithDeadline(p.deps, 5)).rejects.toMatchObject({ code: 'upload_timeout' });
    expect(p.deps.objectExists).toHaveBeenCalled();
    expect(p.store.size).toBe(0);
  });
});

describe('an upload that NEVER settles (round-2 finding)', () => {
  it('returns instead of hanging forever', async () => {
    const p = provider({ durationMs: 0, honoursAbort: false, neverSettles: true });
    // Without the cancellation grace this await never resolves and the run
    // stays active — which the single-active index turns into a permanent
    // block on every future backup.
    await expect(
      putWithDeadline(p.deps, 5, { cancelGraceMs: 10 }),
    ).rejects.toMatchObject({ code: 'upload_cancel_timeout' });
  });

  it('DECLARES the orphan as unknown instead of claiming a cleanup', async () => {
    const p = provider({ durationMs: 0, honoursAbort: false, neverSettles: true });
    await expect(
      putWithDeadline(p.deps, 5, { cancelGraceMs: 10 }),
    ).rejects.toMatchObject({ details: { orphan: 'unknown' } });
  });

  it('does NOT touch the key — a delete would race a write still in flight', async () => {
    const p = provider({ durationMs: 0, honoursAbort: false, neverSettles: true });
    await putWithDeadline(p.deps, 5, { cancelGraceMs: 10 }).catch(() => undefined);
    expect(p.deps.objectExists).not.toHaveBeenCalled();
    expect(p.deps.deleteObject).not.toHaveBeenCalled();
  });

  it('alerts, naming the impact and the operator action', async () => {
    const p = provider({ durationMs: 0, honoursAbort: false, neverSettles: true });
    await putWithDeadline(p.deps, 5, { cancelGraceMs: 10 }).catch(() => undefined);
    expect(p.alerts).toHaveLength(1);
    expect(String(p.alerts[0]!.impact)).toMatch(/no manifest and no run row/);
    expect(String(p.alerts[0]!.action)).toMatch(/inspect the bucket prefix/);
    expect(p.logs.some((l) => l.event === 'backup.upload_cancel_timeout')).toBe(true);
  });

  it('still resolves normally when cancellation IS acknowledged within the grace', async () => {
    // Same deadline, but the client stops when told — this must reap, not
    // degrade to `unknown`.
    const p = provider({ durationMs: 10_000, honoursAbort: true });
    await expect(putWithDeadline(p.deps, 5, { cancelGraceMs: 500 })).rejects.toMatchObject({
      code: 'upload_timeout',
    });
    expect(p.deps.objectExists).toHaveBeenCalled();
  });

  it('a late failure from the abandoned upload never becomes an unhandled rejection', async () => {
    let rejectLate: ((e: Error) => void) | null = null;
    const deps: DeadlineUploadDeps = {
      put: () =>
        new Promise<void>((_res, rej) => {
          rejectLate = rej;
        }),
      objectExists: async () => false,
      deleteObject: async () => undefined,
    };
    await putWithDeadline(deps, 5, { cancelGraceMs: 10 }).catch(() => undefined);
    // The operation fails AFTER we gave up on it. Absorbed, not thrown.
    rejectLate!(new Error('socket reset, far too late'));
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('the reap is confirmed, never assumed', () => {
  it('reports reap_failed when the delete is refused', async () => {
    const p = provider({ durationMs: 40, honoursAbort: false, deleteThrows: true });
    await expect(putWithDeadline(p.deps, 5)).rejects.toMatchObject({
      details: { orphan: 'reap_failed' },
    });
    expect(p.logs.some((l) => l.event === 'backup.orphan_reap_failed')).toBe(true);
  });

  it('reports reap_failed when delete claims success but the object remains', async () => {
    const p = provider({ durationMs: 40, honoursAbort: false, deleteIsLie: true });
    await expect(putWithDeadline(p.deps, 5)).rejects.toMatchObject({
      details: { orphan: 'reap_failed' },
    });
    expect(p.logs.some((l) => l.event === 'backup.orphan_still_present')).toBe(true);
  });

  it('reports reap_unconfirmed when the bucket cannot be inspected', async () => {
    const p = provider({ durationMs: 40, honoursAbort: false, existsThrows: true });
    await expect(putWithDeadline(p.deps, 5)).rejects.toMatchObject({
      details: { orphan: 'reap_unconfirmed' },
    });
    expect(p.logs.some((l) => l.event === 'backup.orphan_check_failed')).toBe(true);
  });

  it('names the operational impact in every failed-reap log', async () => {
    const p = provider({ durationMs: 40, honoursAbort: false, deleteThrows: true });
    await putWithDeadline(p.deps, 5).catch(() => undefined);
    const entry = p.logs.find((l) => l.event === 'backup.orphan_reap_failed');
    expect(String(entry!.detail.impact)).toMatch(/outside the backup lifecycle/);
  });
});
