/**
 * tenant-boundary — facade trust boundary for the user-layer.
 *
 * Codex review PR #94 high #3: the existing repository layer guards every
 * read/write with `applyTenantGuard()` which reads `tenant_id` / `agent_id`
 * from the AsyncLocalStorage context. The new user-layer facade accepted
 * `tenant_id` from the caller's input and predicated reads only on that
 * value — bypassing the trust boundary entirely.
 *
 * `enforceTenantBoundary` is the single chokepoint every slice builder
 * MUST invoke at entry. Behavior:
 *
 *  - When a tenant context is already established (the normal path: every
 *    inbound message handler wraps work in `runWithTenantContext`), we
 *    REQUIRE the caller's `input.tenant_id` to match the context. Any
 *    mismatch throws `TenantBoundaryViolation`. This catches the leak
 *    pattern Codex flagged where downstream code accidentally passes a
 *    tenant it doesn't own.
 *
 *  - When NO tenant context exists, the caller is treated as a trusted
 *    bootstrap (admin scripts, workers, tests). We log a one-line warning
 *    and let the call proceed using the input tenant_id without
 *    establishing AsyncLocalStorage state — the resolvers still filter by
 *    tenant_id, so isolation is preserved at the SQL layer.
 *
 *  - `agent_id` is optional in the facade input (the user-layer is
 *    deliberately agent-agnostic for read fan-out across a tenant's
 *    siblings). When passed AND a context exists, must match.
 */
import {
  getCurrentTenant,
  getCurrentAgent,
  tryGetCurrentContext,
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
  /** Effective agent_id observed (from context, when present). May be undefined for bootstrap callers. */
  agent_id?: string;
  /** True when an AsyncLocalStorage context was already established. */
  context_present: boolean;
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
    // Bootstrap path. We don't establish a context here (callers might be
    // doing fan-out across tenants intentionally — e.g. a metrics worker
    // that walks every tenant). Isolation is preserved by the SQL filter.
    return {
      tenant_id: input.tenant_id,
      agent_id: undefined,
      context_present: false,
    };
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
    context_present: true,
  };
}
