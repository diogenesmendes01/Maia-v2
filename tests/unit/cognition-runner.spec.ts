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
});
