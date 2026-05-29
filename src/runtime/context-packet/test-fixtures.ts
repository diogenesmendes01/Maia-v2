/**
 * Test-only fixtures for BaseContextBuilder dependencies.
 *
 * Issue #282: the previous `defaultResolver` was reachable from production
 * paths and returned `{tenant_id:'default', agent_id:'default'}`, violating
 * the inviolable tenant-isolation invariant if mis-wired. The default
 * resolver was replaced with a fail-loud one in the main builder file
 * (`base-context-builder.ts`).
 *
 * Production code MUST NOT import from this file. To make accidental imports
 * loud at runtime, the exports here are guarded by a NODE_ENV check at
 * import time — importing from production processes throws.
 *
 * Tests that need a passthrough resolver MUST inject it explicitly:
 *
 *     import { BaseContextBuilder } from '@/runtime/context-packet/base-context-builder.js';
 *     import { __testOnlyPassthroughResolver } from '@/runtime/context-packet/test-fixtures.js';
 *
 *     const builder = new BaseContextBuilder(__testOnlyPassthroughResolver, …);
 */
import type { IdentityResolverPort } from './base-context-builder.js';

// Tripwire: forbid this module from being imported in production. Tests run
// with NODE_ENV='test' (vitest default); production sets it to 'production'.
// Unset NODE_ENV (some dev shells, CI bootstraps) is treated as non-production
// so that lint/typecheck and ad-hoc scripts don't trip the guard.
if (process.env.NODE_ENV === 'production') {
  throw new Error(
    'test-fixtures.ts must NOT be imported in production. ' +
      'Issue #282: silent default tenant/agent context was removed; production must inject a real resolver.',
  );
}

/**
 * Test-only passthrough resolver: returns the well-known sentinel tuple.
 *
 * Named with `__testOnly` prefix so call sites stand out in code review.
 * Returns the same shape as the old `defaultResolver` so existing tests that
 * relied on the implicit default behaviour can opt back in explicitly.
 */
export const __testOnlyPassthroughResolver: IdentityResolverPort = {
  async resolve(_channel_id: string) {
    return { tenant_id: 'default', agent_id: 'default' };
  },
};
