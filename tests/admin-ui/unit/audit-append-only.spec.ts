/**
 * P8.5 — audit log is append-only by API surface.
 *
 * Verifies that `adminAuditLogRepo` exposes only `append` and `list` methods.
 * If a future change adds an update/delete method, this test fails — forcing
 * a conscious review of the audit invariant.
 */
import { describe, it, expect } from 'vitest';
import { adminAuditLogRepo } from '@/db/repositories.js';

describe('adminAuditLogRepo — append-only API', () => {
  it('exposes ONLY append + list methods (no update/delete)', () => {
    const methods = Object.keys(adminAuditLogRepo).sort();
    expect(methods).toEqual(['append', 'list']);
  });

  it('does not expose any mutation that could alter past entries', () => {
    const forbiddenMethods = ['update', 'delete', 'remove', 'modify', 'amend', 'redact'];
    const methods = Object.keys(adminAuditLogRepo);
    for (const m of forbiddenMethods) {
      expect(methods).not.toContain(m);
    }
  });
});
