/**
 * PR #207 round 2 [REGRESSION] — importing the Admin UI Tools Catalog router
 * must NOT load the gateway.
 *
 * Root cause (round 1 remained): `tools-catalog.ts` did
 * `import('@/tools/_registry.js')` at request time. The registry transitively
 * imports the gateway:
 *   send-proactive-message → gateway/baileys → gateway/presence
 *     (top-level `setInterval` orphan sweep timer, presence.ts:193)
 *   send-proactive-message → gateway/queue
 *     (top-level `new IORedis(...)` + `new Queue(...)`, queue.ts:10/15)
 * So the first `/tools` request installed a timer + a Redis connection + a
 * BullMQ queue inside the admin-ui process.
 *
 * The fix routes the router through a generated, side-effect-free artifact
 * (`src/admin-ui/generated/tool-catalog.ts`). This test proves it: it spies on
 * `globalThis.setInterval` and on `ioredis`'s constructor BEFORE importing the
 * router + the artifact WITHOUT mocking the gateway, then asserts neither was
 * triggered by the import.
 *
 * IMPORTANT: this test deliberately does NOT mock `@/gateway/*`. If the router
 * (or the artifact) regressed to importing `@/tools/_registry.js`, the
 * presence `setInterval` and the queue's `new IORedis(...)` WOULD run during
 * import and these assertions WOULD fail — which is exactly the regression we
 * want to catch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Count `ioredis` constructions without opening a real socket. (ioredis is the
// transitive dep the gateway queue constructs at module load.) If the router
// pulled in `gateway/queue`, this constructor would fire during import.
const ioredisCtor = vi.hoisted(() => vi.fn());
vi.mock('ioredis', () => {
  class FakeIORedis {
    constructor(...args: unknown[]) {
      ioredisCtor(...args);
    }
    on() {
      return this;
    }
    once() {
      return this;
    }
    connect() {
      return Promise.resolve();
    }
    quit() {
      return Promise.resolve();
    }
    disconnect() {}
  }
  return { default: FakeIORedis, Redis: FakeIORedis };
});

describe('tools-catalog router — gateway-free import (PR #207 round 2)', () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    ioredisCtor.mockClear();
    // Spy installed BEFORE the dynamic import so any module-load
    // `setInterval(...)` in the import graph is recorded. Keep the real timer
    // behavior (call-through) so nothing else breaks.
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  it('importing the generated artifact triggers no setInterval and no ioredis', async () => {
    const before = setIntervalSpy.mock.calls.length;

    const mod = await import('../../src/admin-ui/generated/tool-catalog.js');

    // Sanity: it's the real data artifact (non-empty catalog).
    expect(Array.isArray(mod.TOOL_CATALOG)).toBe(true);
    expect(mod.TOOL_CATALOG.length).toBeGreaterThan(0);

    // The whole point: the artifact pulls in ZERO gateway code.
    expect(setIntervalSpy.mock.calls.length).toBe(before);
    expect(ioredisCtor).not.toHaveBeenCalled();
  });

  it('importing AND calling the catalog ROUTER installs no presence timer and no queue Redis', async () => {
    const before = setIntervalSpy.mock.calls.length;

    // No `@/gateway/*` mocks here — if the router went back to importing the
    // registry (whether top-level OR via a request-time dynamic import), the
    // presence `setInterval` + queue `new IORedis(...)` would run and fail the
    // assertions below.
    const { toolsCatalogRouter } = await import(
      '../../src/admin-ui/trpc/routers/tools-catalog.js'
    );

    // The router module loaded (its tRPC router is exported)…
    expect(toolsCatalogRouter).toBeDefined();

    // …and we EXERCISE THE REQUEST PATH too. The previous router deferred the
    // registry import into the `.query()` body, so a regression only fires when
    // `listCatalog` runs — call it here so this assertion catches that form.
    const ctx = {
      session: { user: { id: 'u1', role: 'founder', tenant_id: 't1' } },
      repos: {}, // founder path skips the tenant-status lookup
    };
    const caller = toolsCatalogRouter.createCaller(ctx as never);
    const list = await caller.listCatalog();
    expect(list.length).toBeGreaterThan(0);

    // Neither the import NOR the request booted the gateway: no presence sweep
    // timer…
    expect(
      setIntervalSpy.mock.calls.length,
      'importing/calling tools-catalog.ts must not call setInterval (presence ' +
        'sweep) — the router must NOT import @/tools/_registry or @/gateway/*',
    ).toBe(before);

    // …and no BullMQ-queue Redis connection constructed.
    expect(
      ioredisCtor,
      'importing/calling tools-catalog.ts must not construct an ioredis client ' +
        '(gateway/queue) — the router must consume the generated artifact only',
    ).not.toHaveBeenCalled();
  });

  it('the router computes enabled from config flags without importing the registry', async () => {
    // Drive listCatalog with a minimal protected-procedure context and assert
    // the per-tool `enabled` reflects config flags — proving the runtime gating
    // works off the static artifact + config (no registry import).
    const { toolsCatalogRouter } = await import(
      '../../src/admin-ui/trpc/routers/tools-catalog.js'
    );
    const { config } = await import('../../src/config/env.js');

    const ctx = {
      session: { user: { id: 'u1', role: 'founder', tenant_id: 't1' } },
      repos: {}, // founder path skips the tenant-status lookup
    };
    const caller = toolsCatalogRouter.createCaller(ctx as never);
    const list = await caller.listCatalog();

    expect(list.length).toBeGreaterThan(0);

    // An always-on tool (no gating flag) is enabled.
    const ungated = list.find((t) => t.feature_flag === null);
    expect(ungated?.enabled).toBe(true);

    // A config-gated tool's `enabled` tracks its live config flag.
    const report = list.find((t) => t.name === 'generate_report');
    expect(report).toBeDefined();
    expect(report!.feature_flag).toBe('FEATURE_PDF_REPORTS');
    expect(report!.enabled).toBe(config.FEATURE_PDF_REPORTS);

    // Gateway still never loaded by any of the above.
    expect(ioredisCtor).not.toHaveBeenCalled();
  });
});
