/**
 * Issue #270 — Regression test: the legacy `rateLimit` helper in
 * `src/memory/working.ts` MUST NOT exist.
 *
 * Background
 * ----------
 * Before this fix, `src/memory/working.ts` exported a `rateLimit(pessoa_id,
 * kind, max, windowSec)` helper that was:
 *   1. **Fail-open on Redis-down** — returned `{ allowed: true, count: 0 }`
 *      when Redis was disconnected, granting unlimited quota inadvertently.
 *   2. **Cross-tenant** — used key `rate:${pessoa_id}:${kind}:${hour}` with
 *      no `tenant_id` / `agent_id` scope, violating the inviolable
 *      cross-tenant isolation invariant.
 *   3. **Race-prone** — split `INCR` and `EXPIRE` into separate Redis calls,
 *      so two concurrent first-counters could both see `count === 1` but only
 *      one would set the TTL (the "EXPIRE on first count" race that PR #258
 *      eliminated in the gateway rate-limiter).
 *
 * Verification (issue #270 approach)
 * ----------------------------------
 * A repo-wide grep at the time of resolution found **0 callers** outside
 * the file itself:
 *   - No `import { rateLimit } from '@/memory/working'` anywhere.
 *   - No `import * as working from '@/memory/working'` with `working.rateLimit`.
 *   - The only other `rateLimit` symbol in the codebase is the unrelated
 *     `@fastify/rate-limit` plugin import in `src/setup/index.ts`.
 *
 * The helper was dead code (Option A in #270). Rather than re-implement it
 * with the PR #258 pattern (`maia:ratelimit:${tenant_id}:${agent_id}:...`,
 * fail-closed on Redis-down, Lua-script atomicity), we removed it.
 *
 * What this spec proves
 * ---------------------
 * 1. The `rateLimit` export no longer exists on the `working` module.
 * 2. The two remaining exports (`pushMessage`, `readRecent`) are still present
 *    so we don't accidentally widen the removal.
 *
 * If anyone ever needs an agent-scoped rate-limiter for working memory, they
 * should follow the PR #258 pattern (Lua/MULTI for atomicity, tenant+agent
 * key prefix, fail-CLOSED on Redis-down) instead of resurrecting this helper.
 */

import { describe, it, expect } from 'vitest';
import * as workingMemoryModule from '@/memory/working.js';

describe('Issue #270 — legacy `rateLimit` helper removed from memory/working', () => {
  it('does NOT export `rateLimit` (was fail-open + cross-tenant + INCR/EXPIRE race)', () => {
    // Cast through `unknown` so TS doesn't reject the assertion just because
    // the property genuinely no longer exists on the typed module shape.
    const mod = workingMemoryModule as unknown as Record<string, unknown>;
    expect(mod.rateLimit).toBeUndefined();
    expect('rateLimit' in workingMemoryModule).toBe(false);
  });

  it('still exports `pushMessage` and `readRecent` (removal is surgical)', () => {
    expect(typeof workingMemoryModule.pushMessage).toBe('function');
    expect(typeof workingMemoryModule.readRecent).toBe('function');
  });
});
