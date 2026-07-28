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
  /** Whether a completed upload creates the object. */
  creates?: boolean;
  deleteThrows?: boolean;
  existsThrows?: boolean;
  /** Delete "succeeds" but the object is still there. */
  deleteIsLie?: boolean;
}) {
  const store = new Set<string>();
  const logs: { event: string; detail: Record<string, unknown> }[] = [];
  let settled = false;

  const deps: DeadlineUploadDeps = {
    put: (signal) =>
      new Promise<void>((resolve, reject) => {
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

  return { deps, store, logs, hasSettled: () => settled };
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
