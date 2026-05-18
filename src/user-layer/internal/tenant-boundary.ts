/**
 * tenant-boundary — facade trust boundary for the user-layer.
 *
 * Codex review PR #94 round-2 critical: `enforceTenantBoundary` MUST fail
 * closed when AsyncLocalStorage context is absent. A missing context means the
 * call was made outside `runWithTenantContext`, which is always a programming
 * error in production code paths. Silently falling through (the old "bootstrap"
 * path) allowed any caller to supply an arbitrary tenant_id and bypass
 * isolation entirely.
 *
 * `enforceTenantBoundary` is the single chokepoint every slice builder
 * MUST invoke at entry. Behavior:
 *
 *  - When a tenant context is established (normal path: every inbound message
 *    handler wraps work in `runWithTenantContext`), we REQUIRE the caller's
 *    `input.tenant_id` to match the context. Any mismatch throws
 *    `TenantBoundaryViolation`. `agent_id`, when passed, must also match.
 *
 *  - When NO tenant context exists (ALS absent), throws
 *    `MissingTenantContextError`. There is no silent bootstrap path.
 *    Admin/worker fan-out callers MUST wrap their call in
 *    `runWithTenantContext` (one call per tenant) or use a future privileged
 *    admin API that is explicitly audited.
 */
import {
  getCurrentTenant,
  getCurrentAgent,
  tryGetCurrentContext,
  MissingTenantContextError,
} from '../../db/tenant-context.js';

export class TenantBoundaryViolation extends Error {
  readonly code = 'TENANT_BOUNDARY_VIOLATION';
  constructor(detail: string) {
    super(`user-layer trust boundary violation: ${detail}`);
    this.name = 'TenantBoundaryViolation';
  }
}

export interface TenantBoundaryInput {
  tenant_id: string;
  /** Optional — when omitted, no agent_id cross-check is performed. */
  agent_id?: string;
}

export interface TenantBoundaryDecision {
  tenant_id: string;
  /** Effective agent_id from the AsyncLocalStorage context. Always present (boundary throws if context absent). */
  agent_id: string;
}

export function enforceTenantBoundary(
  input: TenantBoundaryInput,
): TenantBoundaryDecision {
  if (!input.tenant_id || typeof input.tenant_id !== 'string') {
    throw new TenantBoundaryViolation(
      'input.tenant_id is required (string)',
    );
  }

  const ctx = tryGetCurrentContext();
  if (!ctx) {
    // Fail-closed: never silently trust caller-supplied tenant_id without an
    // established AsyncLocalStorage context. Admin/worker fan-out callers MUST
    // wrap each tenant call in `runWithTenantContext({ tenant_id, agent_id })`.
    throw new MissingTenantContextError();
  }

  // Context exists — strict cross-check.
  const ctxTenant = getCurrentTenant();
  if (ctxTenant !== input.tenant_id) {
    throw new TenantBoundaryViolation(
      `input tenant_id=${input.tenant_id} does not match context tenant_id=${ctxTenant}`,
    );
  }
  const ctxAgent = getCurrentAgent();
  if (input.agent_id && input.agent_id !== ctxAgent) {
    throw new TenantBoundaryViolation(
      `input agent_id=${input.agent_id} does not match context agent_id=${ctxAgent}`,
    );
  }
  return {
    tenant_id: ctxTenant,
    agent_id: ctxAgent,
  };
}
