import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runNodes } from '@/cognitive-graph/orchestrator.js';
import type { ModuleDescriptor } from '@/cognitive-graph/types.js';
import { CognitiveLayer } from '@/types/enums.js';
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

const td = <TIn, TOut>(d: Partial<ModuleDescriptor<TIn, TOut>> & { name: string; run: (i: TIn) => Promise<TOut> }): ModuleDescriptor<TIn, TOut> => ({
  layer: CognitiveLayer.SYNC_CONDITIONAL,
  modelTier: 'fast',
  timeoutMs: 1000,
  version: 'v1',
  ...d,
}) as ModuleDescriptor<TIn, TOut>;

describe('P7 — orchestrator runNodes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sync_required: executa serial, output indexado por name', async () => {
    const order: string[] = [];
    const a = td({ name: 'a', layer: CognitiveLayer.SYNC_REQUIRED, run: async () => { order.push('a'); return 1; } });
    const b = td({ name: 'b', layer: CognitiveLayer.SYNC_REQUIRED, run: async () => { order.push('b'); return 2; } });
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const r = await runNodes([a, b], {});
      expect(order).toEqual(['a', 'b']);
      expect(r.nodes['a']!.output).toBe(1);
      expect(r.nodes['b']!.output).toBe(2);
    });
  });

  it('sync_conditional + parallelizable: roda em paralelo', async () => {
    const starts: number[] = [];
    const make = (name: string) => td({
      name, layer: CognitiveLayer.SYNC_CONDITIONAL, parallelizable: true,
      run: async () => { starts.push(Date.now()); await new Promise((r) => setTimeout(r, 80)); return name; },
    });
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const t0 = Date.now();
      const r = await runNodes([make('a'), make('b'), make('c')], {});
      const elapsed = Date.now() - t0;
      // Paralelo: ~80ms total, não 240ms.
      expect(elapsed).toBeLessThan(200);
      expect(Object.keys(r.nodes).sort()).toEqual(['a', 'b', 'c']);
    });
  });

  it('sync_conditional + runWhen=false: node fica SKIPPED', async () => {
    const ran = vi.fn(async () => 'should not run');
    const d = td({ name: 'skip-me', runWhen: () => false, run: ran });
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const r = await runNodes([d], {});
      expect(r.nodes['skip-me']!.status).toBe('skipped');
      expect(r.nodes['skip-me']!.output).toBeNull();
      expect(ran).not.toHaveBeenCalled();
    });
  });

  it('node lança erro: fallback aplicado, outros nodes prosseguem', async () => {
    const ok = td({ name: 'ok', run: async () => 'ok' });
    const boom = td({ name: 'boom', fallback: 'fb', run: async () => { throw new Error('crash'); } });
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const r = await runNodes([ok, boom], {});
      expect(r.nodes['ok']!.output).toBe('ok');
      expect(r.nodes['boom']!.status).toBe('error');
      expect(r.nodes['boom']!.output).toBe('fb');
      expect(r.nodes['boom']!.fallback_triggered).toBe(true);
    });
  });

  it('async layer: fire-and-forget, retorna imediato', async () => {
    let resolved = false;
    const asyncNode = td({
      name: 'bg', layer: CognitiveLayer.ASYNC,
      run: async () => { await new Promise((r) => setTimeout(r, 100)); resolved = true; return 'done'; },
    });
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const t0 = Date.now();
      const r = await runNodes([asyncNode], {});
      const elapsed = Date.now() - t0;
      // Volta antes do node terminar.
      expect(elapsed).toBeLessThan(50);
      expect(resolved).toBe(false);
      expect(r.nodes['bg']!.status).toBe('success'); // placeholder
    });
  });
});
