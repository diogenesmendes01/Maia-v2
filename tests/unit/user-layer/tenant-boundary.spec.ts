/**
 * tenant-boundary — unit tests for the fail-closed trust boundary.
 *
 * PR #94 round-2 critical: enforceTenantBoundary MUST throw
 * MissingTenantContextError when called without an established
 * AsyncLocalStorage context. The old "bootstrap" fallback allowed
 * callers to supply arbitrary tenant_ids without any ALS guard,
 * which bypassed the isolation invariant.
 *
 * Tests:
 *   1. Throws MissingTenantContextError when no ALS context is present.
 *   2. Throws TenantBoundaryViolation when input.tenant_id mismatches context.
 *   3. Returns correct decision when context matches.
 *   4. Throws TenantBoundaryViolation when input.agent_id mismatches context.
 *   5. Returns effective agent_id from context (not from input).
 */
import { describe, it, expect } from 'vitest';
import { runWithTenantContext, MissingTenantContextError } from '@/db/tenant-context.js';
import {
  enforceTenantBoundary,
  TenantBoundaryViolation,
} from '@/user-layer/internal/tenant-boundary.js';

describe('enforceTenantBoundary', () => {
  it('[critical] throws MissingTenantContextError when called without ALS context', () => {
    // No runWithTenantContext wrapper — context is absent.
    expect(() =>
      enforceTenantBoundary({ tenant_id: 'some-tenant' }),
    ).toThrow(MissingTenantContextError);
  });

  it('[critical] error code is MISSING_TENANT_CONTEXT', () => {
    try {
      enforceTenantBoundary({ tenant_id: 'some-tenant' });
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTenantContextError);
      expect((err as MissingTenantContextError).code).toBe('MISSING_TENANT_CONTEXT');
    }
  });

  it('throws TenantBoundaryViolation when input.tenant_id mismatches context', async () => {
    await runWithTenantContext({ tenant_id: 'ctx-tenant', agent_id: 'ctx-agent' }, async () => {
      expect(() =>
        enforceTenantBoundary({ tenant_id: 'other-tenant' }),
      ).toThrow(TenantBoundaryViolation);
    });
  });

  it('throws TenantBoundaryViolation when input.agent_id mismatches context', async () => {
    await runWithTenantContext({ tenant_id: 'ctx-tenant', agent_id: 'ctx-agent' }, async () => {
      expect(() =>
        enforceTenantBoundary({ tenant_id: 'ctx-tenant', agent_id: 'other-agent' }),
      ).toThrow(TenantBoundaryViolation);
    });
  });

  it('returns effective tenant_id and agent_id from ALS context when matching', async () => {
    await runWithTenantContext({ tenant_id: 'ctx-tenant', agent_id: 'ctx-agent' }, async () => {
      const decision = enforceTenantBoundary({ tenant_id: 'ctx-tenant' });
      expect(decision.tenant_id).toBe('ctx-tenant');
      expect(decision.agent_id).toBe('ctx-agent');
    });
  });

  it('returns effective agent_id from context even when input.agent_id not provided', async () => {
    await runWithTenantContext({ tenant_id: 'ctx-tenant', agent_id: 'ctx-agent' }, async () => {
      const decision = enforceTenantBoundary({ tenant_id: 'ctx-tenant' });
      // agent_id is always present — comes from ALS, never undefined
      expect(decision.agent_id).toBe('ctx-agent');
    });
  });

  it('accepts matching agent_id in input (explicit cross-check passes)', async () => {
    await runWithTenantContext({ tenant_id: 'ctx-tenant', agent_id: 'ctx-agent' }, async () => {
      expect(() =>
        enforceTenantBoundary({ tenant_id: 'ctx-tenant', agent_id: 'ctx-agent' }),
      ).not.toThrow();
    });
  });
});
