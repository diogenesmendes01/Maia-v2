import { describe, it, expect } from 'vitest';
import {
  BACKUP_STATES,
  canTransition,
  assertTransition,
  isTerminalState,
  classifyOutcome,
  outcomeAuditAction,
  type BackupEvidence,
} from '../../../src/ops/backup/state-machine.js';

/**
 * Issue #520 §2 — the lifecycle is the mechanism that stops "pg_dump exited 0"
 * from being reported as success.
 */

function evidence(over: Partial<BackupEvidence> = {}): BackupEvidence {
  return {
    locally_verified: true,
    encryption_required: false,
    encrypted: false,
    offsite_required: false,
    offsite_configured: false,
    offsite_attempted: false,
    offsite_verified: false,
    ...over,
  };
}

describe('backup lifecycle transitions', () => {
  it('refuses the baseline shortcut running → completed', () => {
    expect(canTransition('running', 'completed')).toBe(false);
    expect(() => assertTransition('running', 'completed')).toThrowError(
      /illegal backup lifecycle transition/,
    );
  });

  it('allows the full verified path', () => {
    const path = [
      'scheduled',
      'running',
      'dump_created',
      'locally_verified',
      'encrypted',
      'uploaded',
      'remotely_verified',
      'completed',
    ] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(() => assertTransition(path[i]!, path[i + 1]!)).not.toThrow();
    }
  });

  it('lets any non-terminal state abort to failed', () => {
    const nonTerminal = BACKUP_STATES.filter((s) => !isTerminalState(s));
    for (const s of nonTerminal) {
      expect(canTransition(s, 'failed')).toBe(true);
    }
  });

  it('treats completed/degraded/failed/expired/deleted as terminal', () => {
    expect(isTerminalState('completed')).toBe(true);
    expect(isTerminalState('completed_degraded')).toBe(true);
    expect(isTerminalState('failed')).toBe(true);
    expect(isTerminalState('expired')).toBe(true);
    expect(isTerminalState('deleted')).toBe(true);
    expect(isTerminalState('running')).toBe(false);
  });

  it('never leaves a terminal state except toward expired/deleted', () => {
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('failed', 'completed')).toBe(false);
    expect(canTransition('deleted', 'completed')).toBe(false);
    expect(canTransition('completed', 'deleted')).toBe(true);
  });
});

describe('classifyOutcome', () => {
  it('fails when local verification did not pass', () => {
    expect(classifyOutcome(evidence({ locally_verified: false }))).toEqual({
      outcome: 'failed',
      reason: 'local_verification_failed',
    });
  });

  it('fails (never degrades) when encryption is required but the artifact is plaintext', () => {
    const verdict = classifyOutcome(
      evidence({ encryption_required: true, encrypted: false, offsite_verified: true }),
    );
    expect(verdict).toEqual({
      outcome: 'failed',
      reason: 'encryption_required_but_absent',
    });
  });

  it('fails a production-shaped run whose off-site copy was not verified', () => {
    const verdict = classifyOutcome(
      evidence({
        offsite_required: true,
        offsite_configured: true,
        offsite_attempted: true,
        offsite_verified: false,
      }),
    );
    expect(verdict).toEqual({
      outcome: 'failed',
      reason: 'offsite_required_but_unverified',
    });
  });

  it('never reports local-only as a normal success', () => {
    const verdict = classifyOutcome(evidence({ offsite_configured: false }));
    expect(verdict.outcome).toBe('completed_degraded');
    expect(verdict.reason).toBe('offsite_not_configured');
  });

  it('degrades when a configured but non-mandatory upload failed', () => {
    const verdict = classifyOutcome(
      evidence({ offsite_configured: true, offsite_attempted: true, offsite_verified: false }),
    );
    expect(verdict).toEqual({ outcome: 'completed_degraded', reason: 'offsite_upload_failed' });
  });

  it('completes only when the remote copy is verified', () => {
    const verdict = classifyOutcome(
      evidence({
        encryption_required: true,
        encrypted: true,
        offsite_required: true,
        offsite_configured: true,
        offsite_attempted: true,
        offsite_verified: true,
      }),
    );
    expect(verdict).toEqual({ outcome: 'completed', reason: 'ok' });
  });
});

describe('outcomeAuditAction', () => {
  it('maps each outcome to a distinct audit action', () => {
    expect(outcomeAuditAction('completed')).toBe('backup_run_completed');
    expect(outcomeAuditAction('completed_degraded')).toBe('backup_run_degraded');
    expect(outcomeAuditAction('failed')).toBe('backup_run_failed');
  });
});
