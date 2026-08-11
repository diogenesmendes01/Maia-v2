import { describe, it, expect, vi } from 'vitest';
import {
  planArtifactRetention,
  runArtifactRetention,
  assertConclusive,
  type RetentionCandidate,
  type RetentionPorts,
} from '../../../src/ops/backup/retention.js';
import { resolveArtifactPath } from '../../../src/ops/backup/artifact-path.js';

/**
 * Issue #520 §10 — round-1 review finding (P1): the destructive paths deleted
 * by mtime/LastModified without consulting the manifest or legal hold, swallowed
 * per-chunk failures, and audited `completed` for a partial pass.
 *
 * THE FAKE IS ADVERSARIAL. `store()` models a destination where a delete can
 * SUCCEED WITHOUT DELETING (`lyingDelete`) — the shape of the swallowed chunk
 * failure — and where the hold evaluator can be unavailable rather than simply
 * returning "no hold". A complacent fake is what let the original code look
 * correct.
 */

const NOW = new Date('2026-07-28T12:00:00.000Z');
const PAST = new Date('2026-07-01T00:00:00.000Z');
const FUTURE = new Date('2026-08-30T00:00:00.000Z');

function candidate(over: Partial<RetentionCandidate> = {}): RetentionCandidate {
  return {
    backup_id: 'b-1',
    artifact_ref: 'maia-2026-07-01T03-00-00-aaaaaaaaaaaa.dump',
    state: 'completed',
    destination_kind: 's3',
    delete_after: PAST,
    has_manifest: true,
    ...over,
  };
}

function store(opts: {
  candidates?: RetentionCandidate[];
  held?: boolean;
  holdUnavailable?: boolean;
  lyingDelete?: boolean;
  deleteThrowsFor?: string;
  listThrows?: boolean;
} = {}) {
  const present = new Set((opts.candidates ?? [candidate()]).map((c) => c.backup_id));
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const logs: { event: string; detail: Record<string, unknown> }[] = [];
  const marked: string[] = [];
  // Round-2: `markDeleted` takes the CANDIDATE now, because one run can have
  // two copies and only the last one to go marks the run deleted.

  const ports: RetentionPorts = {
    now: () => NOW,
    listCandidates: vi.fn(async () => {
      if (opts.listThrows) throw new Error('db down');
      return opts.candidates ?? [candidate()];
    }),
    anyActiveHold: vi.fn(async () =>
      opts.holdUnavailable ? null : { held: opts.held === true, hold_ids: opts.held ? ['h1'] : [] },
    ),
    deleteArtifact: vi.fn(async (c: RetentionCandidate) => {
      if (opts.deleteThrowsFor === c.backup_id) throw new Error('AccessDenied');
      // The lying delete: reports success, removes nothing.
      if (!opts.lyingDelete) present.delete(c.backup_id);
    }),
    confirmDeleted: vi.fn(async (c: RetentionCandidate) => !present.has(c.backup_id)),
    markDeleted: vi.fn(async (c: RetentionCandidate) => {
      marked.push(c.backup_id);
    }),
    audit: vi.fn(async (action, metadata) => {
      audits.push({ action, metadata });
    }),
    log: (event, detail) => logs.push({ event, detail }),
  };
  return { ports, present, audits, logs, marked };
}

describe('planArtifactRetention — evidence only', () => {
  it('deletes an expired, manifested, terminal artifact', () => {
    const [p] = planArtifactRetention([candidate()], NOW, false);
    expect(p!.decision).toEqual({ action: 'delete', reason: 'expired' });
  });

  it('KEEPS anything under legal hold, whatever its age', () => {
    const [p] = planArtifactRetention([candidate({ delete_after: PAST })], NOW, true);
    expect(p!.decision).toEqual({ action: 'keep', reason: 'legal_hold' });
  });

  it('keeps an artifact with no manifest — an unidentifiable file is never reaped on a guess', () => {
    const [p] = planArtifactRetention([candidate({ has_manifest: false })], NOW, false);
    expect(p!.decision).toEqual({ action: 'keep', reason: 'no_manifest' });
  });

  it('keeps an artifact whose expiry has not arrived', () => {
    const [p] = planArtifactRetention([candidate({ delete_after: FUTURE })], NOW, false);
    expect(p!.decision).toEqual({ action: 'keep', reason: 'not_expired' });
  });

  it('keeps an artifact the policy never gave an expiry', () => {
    const [p] = planArtifactRetention([candidate({ delete_after: null })], NOW, false);
    expect(p!.decision).toEqual({ action: 'keep', reason: 'no_expiry_set' });
  });

  it('keeps the artifact of a run still in flight', () => {
    for (const state of ['running', 'uploaded', 'locally_verified'] as const) {
      const [p] = planArtifactRetention([candidate({ state })], NOW, false);
      expect(p!.decision).toEqual({ action: 'keep', reason: 'not_terminal' });
    }
  });

  it('never uses mtime — age alone decides nothing', () => {
    // Identical age, different evidence, opposite decisions.
    const held = planArtifactRetention([candidate()], NOW, true)[0]!.decision.action;
    const free = planArtifactRetention([candidate()], NOW, false)[0]!.decision.action;
    expect(held).toBe('keep');
    expect(free).toBe('delete');
  });
});

describe('legal hold is evaluated before every pass, and failure is fatal', () => {
  it('refuses to delete anything when holds cannot be evaluated', async () => {
    const s = store({ holdUnavailable: true });
    const out = await runArtifactRetention(s.ports, 's3', {
      dryRun: false,
      correlationId: 'c',
    });
    expect(out.status).toBe('failed');
    expect(out.error_code).toBe('legal_hold_unavailable');
    expect(s.ports.deleteArtifact).not.toHaveBeenCalled();
    expect(s.logs.some((l) => l.event === 'backup.retention_hold_unavailable')).toBe(true);
  });

  it('destroys NOTHING while a hold is active', async () => {
    const s = store({ held: true });
    const out = await runArtifactRetention(s.ports, 's3', { dryRun: false, correlationId: 'c' });
    expect(s.ports.deleteArtifact).not.toHaveBeenCalled();
    expect(out.skipped_held).toBe(1);
    expect(out.deleted).toBe(0);
    expect(out.status).toBe('completed');
  });
});

describe('every delete is confirmed', () => {
  it('counts a delete that reported success but changed nothing as FAILED', async () => {
    const s = store({ lyingDelete: true });
    const out = await runArtifactRetention(s.ports, 's3', { dryRun: false, correlationId: 'c' });
    expect(out.deleted).toBe(0);
    expect(out.failed).toBe(1);
    expect(out.status).toBe('failed');
    expect(s.logs.some((l) => l.event === 'backup.retention_delete_unconfirmed')).toBe(true);
  });

  it('does not mark the run deleted, nor audit it, when the delete was not confirmed', async () => {
    const s = store({ lyingDelete: true });
    await runArtifactRetention(s.ports, 's3', { dryRun: false, correlationId: 'c' });
    expect(s.marked).toEqual([]);
    expect(s.audits).toEqual([]);
  });

  it('marks and audits a confirmed delete', async () => {
    const s = store();
    const out = await runArtifactRetention(s.ports, 's3', { dryRun: false, correlationId: 'c' });
    expect(out).toMatchObject({ status: 'completed', deleted: 1, failed: 0 });
    expect(s.marked).toEqual(['b-1']);
    expect(s.audits[0]!.action).toBe('backup_artifact_deleted');
    expect(s.audits[0]!.metadata.artifact_ref).toBe(candidate().artifact_ref);
  });

  it('never puts a path or a URL in the deletion audit', async () => {
    const s = store();
    await runArtifactRetention(s.ports, 's3', { dryRun: false, correlationId: 'c' });
    const body = JSON.stringify(s.audits);
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).not.toMatch(/\/opt\//);
  });
});

describe('a partial pass can never report completed', () => {
  it('reports `partial` when some deletes succeeded and some failed', async () => {
    const a = candidate({ backup_id: 'ok' });
    const b = candidate({ backup_id: 'bad' });
    const s = store({ candidates: [a, b], deleteThrowsFor: 'bad' });
    const out = await runArtifactRetention(s.ports, 's3', { dryRun: false, correlationId: 'c' });
    expect(out).toMatchObject({ status: 'partial', deleted: 1, failed: 1 });
    expect(out.error_code).toBe('delete_failed');
  });

  it('reports `failed` when nothing could be deleted', async () => {
    const s = store({ deleteThrowsFor: 'b-1' });
    const out = await runArtifactRetention(s.ports, 's3', { dryRun: false, correlationId: 'c' });
    expect(out).toMatchObject({ status: 'failed', deleted: 0, failed: 1 });
  });

  it('records a resumable cursor at the first artifact it could not process', async () => {
    const s = store({ deleteThrowsFor: 'b-1' });
    const out = await runArtifactRetention(s.ports, 's3', { dryRun: false, correlationId: 'c' });
    expect(out.cursor_watermark).toEqual(PAST);
  });

  it('fails the pass when the candidate listing itself fails', async () => {
    const s = store({ listThrows: true });
    const out = await runArtifactRetention(s.ports, 's3', { dryRun: false, correlationId: 'c' });
    expect(out).toMatchObject({ status: 'failed', error_code: 'candidate_listing_failed' });
  });

  it('assertConclusive throws for anything but a clean pass', async () => {
    const s = store({ deleteThrowsFor: 'b-1' });
    const out = await runArtifactRetention(s.ports, 's3', { dryRun: false, correlationId: 'c' });
    expect(() => assertConclusive(out)).toThrowError(/retention pass ended failed/);
  });
});

describe('a poisoned artifact_ref cannot delete anything (round-2 finding)', () => {
  // Wires the REAL guard into the fake port, so this proves the COMPOSITION —
  // the executor plus the confinement check — not just the check in isolation.
  function guardedStore(ref: string) {
    const removed: string[] = [];
    const s = store({ candidates: [candidate({ artifact_ref: ref })] });
    s.ports.deleteArtifact = vi.fn(async (c) => {
      removed.push(resolveArtifactPath('/opt/maia/backups', c.artifact_ref));
    });
    s.ports.confirmDeleted = vi.fn(async () => true);
    return { ...s, removed };
  }

  it.each([
    ['posix traversal', '../../etc/passwd'],
    ['absolute path', '/etc/passwd'],
    ['windows separator', '..\\..\\evil.dump'],
    ['drive-relative', 'C:evil.dump'],
  ])('refuses to remove anything for a %s reference', async (_name, ref) => {
    const s = guardedStore(ref);
    const out = await runArtifactRetention(s.ports, 'local', {
      dryRun: false,
      correlationId: 'c',
    });
    expect(s.removed).toEqual([]);
    // A poisoned row makes the pass NON-CONCLUSIVE and alertable, rather than
    // silently doing damage or silently doing nothing.
    expect(out.status).toBe('failed');
    expect(out.failed).toBe(1);
    expect(s.marked).toEqual([]);
  });

  it('still removes a legitimate artifact, inside the root', async () => {
    const s = guardedStore('maia-2026-07-01T03-00-00-aaaaaaaaaaaa.dump');
    const out = await runArtifactRetention(s.ports, 'local', {
      dryRun: false,
      correlationId: 'c',
    });
    expect(out.status).toBe('completed');
    expect(s.removed).toHaveLength(1);
    expect(s.removed[0]).toMatch(/backups[\\/]maia-2026-07-01T03-00-00-aaaaaaaaaaaa\.dump$/);
  });
});

describe('dry run', () => {
  it('counts what WOULD be deleted and deletes nothing', async () => {
    const s = store();
    const out = await runArtifactRetention(s.ports, 's3', { dryRun: true, correlationId: 'c' });
    expect(out).toMatchObject({ status: 'completed', eligible: 1, deleted: 0 });
    expect(s.ports.deleteArtifact).not.toHaveBeenCalled();
    expect(s.present.has('b-1')).toBe(true);
  });

  it('still evaluates holds, so the dry run reflects the real decision', async () => {
    const s = store({ held: true });
    const out = await runArtifactRetention(s.ports, 's3', { dryRun: true, correlationId: 'c' });
    expect(out.eligible).toBe(0);
    expect(out.skipped_held).toBe(1);
  });

  it('surfaces unidentified artifacts for the operator', async () => {
    const s = store({ candidates: [candidate({ has_manifest: false })] });
    const out = await runArtifactRetention(s.ports, 's3', { dryRun: true, correlationId: 'c' });
    expect(out.unidentified).toBe(1);
    expect(out.eligible).toBe(0);
  });
});
