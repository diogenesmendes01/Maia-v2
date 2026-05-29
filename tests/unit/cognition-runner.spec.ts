import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCognitiveModule } from '@/cognition/runner.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => {}),
      recentByModule: vi.fn(async () => []),
    },
  };
});

describe('runCognitiveModule', () => {
  beforeEach(() => vi.clearAllMocks());

  it('execução normal: retorna output + status=success + audit log', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runCognitiveModule(
        { name: 'test.module', triggered_by: 'sync_required' },
        async () => 'hello',
      );
      expect(result.output).toBe('hello');
      expect(result.status).toBe('success');
      expect(result.fallback_triggered).toBe(false);
    });
  });

  it('timeout: retorna fallback + status=timeout', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runCognitiveModule(
        { name: 'test.slow', triggered_by: 'sync_conditional', timeoutMs: 50, fallback: 'fb' },
        async () => new Promise((r) => setTimeout(() => r('slow'), 200)),
      );
      expect(result.output).toBe('fb');
      expect(result.status).toBe('timeout');
      expect(result.fallback_triggered).toBe(true);
    });
  });

  it('erro do módulo: retorna fallback + status=error', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runCognitiveModule(
        { name: 'test.boom', triggered_by: 'async_event', fallback: null },
        async () => { throw new Error('boom'); },
      );
      expect(result.output).toBeNull();
      expect(result.status).toBe('error');
      expect(result.fallback_triggered).toBe(true);
    });
  });

  it('sem fallback + erro: output null mas não throw', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runCognitiveModule(
        { name: 'test.boom2', triggered_by: 'async_event' },
        async () => { throw new Error('boom'); },
      );
      expect(result.output).toBeNull();
      expect(result.status).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // PR #269 review — fail-closed audit when tenant context is missing or
  // malformed. The primary module must still complete; only the audit row is
  // skipped (the alternative — writing under ('default','default') — silenced
  // caller bugs and polluted the audit table with a cross-tenant bucket).
  // -------------------------------------------------------------------------
  describe('PR #269 — fail-closed audit on missing tenant context', () => {
    it('primary module still returns success when called OUTSIDE runWithTenantContext', async () => {
      // No runWithTenantContext wrapper → audit must be skipped, but the
      // primary module result must propagate normally.
      const result = await runCognitiveModule(
        { name: 'test.no-context', triggered_by: 'sync_required' },
        async () => 'primary-ok',
      );
      expect(result.output).toBe('primary-ok');
      expect(result.status).toBe('success');
      expect(result.fallback_triggered).toBe(false);
    });

    it('audit log is NOT written when called OUTSIDE runWithTenantContext', async () => {
      const repo = await import('@/db/repositories.js');
      vi.mocked(repo.cognitiveModuleLogRepo.record).mockClear();
      await runCognitiveModule(
        { name: 'test.no-context.skip-audit', triggered_by: 'sync_required' },
        async () => 'x',
      );
      // Regression: before #269 this branch wrote a row with
      // tenant_id='default', agent_id='default'. Now it must skip entirely.
      expect(repo.cognitiveModuleLogRepo.record).not.toHaveBeenCalled();
    });

    it('audit log is NOT written when ctx.tenant_id is empty string', async () => {
      const repo = await import('@/db/repositories.js');
      vi.mocked(repo.cognitiveModuleLogRepo.record).mockClear();
      await runWithTenantContext({ tenant_id: '', agent_id: 'sofia' }, async () => {
        await runCognitiveModule(
          { name: 'test.empty-tenant', triggered_by: 'sync_required' },
          async () => 'x',
        );
      });
      // tryGetCurrentContext now returns null for malformed ctx, so audit is
      // skipped — no row with the empty-string tenant should land.
      expect(repo.cognitiveModuleLogRepo.record).not.toHaveBeenCalled();
    });

    it('audit log is NOT written when ctx.agent_id is null', async () => {
      const repo = await import('@/db/repositories.js');
      vi.mocked(repo.cognitiveModuleLogRepo.record).mockClear();
      await runWithTenantContext(
        { tenant_id: 'acme', agent_id: null as unknown as string },
        async () => {
          await runCognitiveModule(
            { name: 'test.null-agent', triggered_by: 'sync_required' },
            async () => 'x',
          );
        },
      );
      expect(repo.cognitiveModuleLogRepo.record).not.toHaveBeenCalled();
    });

    it('audit log IS written with real tenant_id / agent_id when context is valid', async () => {
      const repo = await import('@/db/repositories.js');
      vi.mocked(repo.cognitiveModuleLogRepo.record).mockClear();
      await runWithTenantContext({ tenant_id: 'tenantX', agent_id: 'agentX' }, async () => {
        await runCognitiveModule(
          { name: 'test.valid-context', triggered_by: 'sync_required' },
          async () => 'x',
        );
      });
      expect(repo.cognitiveModuleLogRepo.record).toHaveBeenCalledTimes(1);
      const call = vi.mocked(repo.cognitiveModuleLogRepo.record).mock.calls[0]![0];
      expect(call.tenant_id).toBe('tenantX');
      expect(call.agent_id).toBe('agentX');
      // Regression guard: no fallback strings leak into the audit row.
      expect(call.tenant_id).not.toBe('default');
      expect(call.agent_id).not.toBe('default');
    });
  });

  // Issue #224 — regression: the Promise.race timeout handle must be cleared
  // on every exit path. Otherwise pending setTimeout handles accumulate in
  // the event loop, retain closures, and surface as "open handles" warnings
  // in tests. Sibling fix to the abort-listener cleanup in skill-runner.ts
  // (PR #221).
  describe('issue #224 — clearTimeout on race settle', () => {
    it('success path: clearTimeout is called after fn() resolves before timeout', async () => {
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      const setSpy = vi.spyOn(globalThis, 'setTimeout');
      try {
        await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
          await runCognitiveModule(
            { name: 'test.cleartimeout.success', triggered_by: 'sync_required', timeoutMs: 5000 },
            async () => 'fast',
          );
        });
        // The race installs exactly one setTimeout; clearTimeout must fire on
        // the same handle. We assert clearTimeout was invoked with one of the
        // handles returned by setTimeout — not just "any call" — to be sure
        // we're cleaning *the runner's* timer and not some unrelated one.
        const setHandles = setSpy.mock.results.map((r) => r.value);
        const clearedHandles = clearSpy.mock.calls.map((c) => c[0]);
        const matched = setHandles.some((h) => clearedHandles.includes(h));
        expect(matched).toBe(true);
      } finally {
        clearSpy.mockRestore();
        setSpy.mockRestore();
      }
    });

    it('error path: clearTimeout is called after fn() rejects before timeout', async () => {
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      const setSpy = vi.spyOn(globalThis, 'setTimeout');
      try {
        await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
          await runCognitiveModule(
            { name: 'test.cleartimeout.error', triggered_by: 'async_event', timeoutMs: 5000, fallback: null },
            async () => { throw new Error('boom'); },
          );
        });
        const setHandles = setSpy.mock.results.map((r) => r.value);
        const clearedHandles = clearSpy.mock.calls.map((c) => c[0]);
        const matched = setHandles.some((h) => clearedHandles.includes(h));
        expect(matched).toBe(true);
      } finally {
        clearSpy.mockRestore();
        setSpy.mockRestore();
      }
    });

    it('timeout path: clearTimeout is called even when the timeout wins the race', async () => {
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      const setSpy = vi.spyOn(globalThis, 'setTimeout');
      try {
        await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
          const result = await runCognitiveModule(
            { name: 'test.cleartimeout.timeout', triggered_by: 'sync_conditional', timeoutMs: 20, fallback: 'fb' },
            async () => new Promise((r) => setTimeout(() => r('slow'), 200)),
          );
          expect(result.status).toBe('timeout');
        });
        // After the timeout fires, the handle is already-dispatched but
        // clearTimeout is still called (no-op for fired handles). The
        // contract we're enforcing is "always clear", not "skip when fired".
        const setHandles = setSpy.mock.results.map((r) => r.value);
        const clearedHandles = clearSpy.mock.calls.map((c) => c[0]);
        const matched = setHandles.some((h) => clearedHandles.includes(h));
        expect(matched).toBe(true);
      } finally {
        clearSpy.mockRestore();
        setSpy.mockRestore();
      }
    });
  });
});
