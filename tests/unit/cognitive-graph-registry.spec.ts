import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleRegistry } from '@/cognitive-graph/registry.js';
import { CognitiveLayer } from '@/types/enums.js';

describe('P7 — ModuleRegistry', () => {
  let reg: ModuleRegistry;
  beforeEach(() => { reg = new ModuleRegistry(); });

  it('register + get por nome retorna o descriptor', () => {
    const d = {
      name: 'm1', layer: CognitiveLayer.SYNC_REQUIRED,
      modelTier: 'reasoning' as const, timeoutMs: 1000, version: 'v1',
      run: async () => 'ok',
    };
    reg.register(d);
    expect(reg.get('m1')).toBe(d);
  });

  it('registro duplicado lança erro (defesa contra colisão de nomes)', () => {
    const d1 = { name: 'm1', layer: CognitiveLayer.SYNC_REQUIRED, modelTier: 'fast' as const, timeoutMs: 1000, version: 'v1', run: async () => null };
    const d2 = { ...d1, version: 'v2' };
    reg.register(d1);
    expect(() => reg.register(d2)).toThrow(/duplicate/i);
  });

  it('listByLayer retorna apenas descriptors da camada', () => {
    reg.register({ name: 'a', layer: CognitiveLayer.SYNC_REQUIRED, modelTier: 'fast', timeoutMs: 100, version: 'v1', run: async () => null });
    reg.register({ name: 'b', layer: CognitiveLayer.SYNC_CONDITIONAL, modelTier: 'fast', timeoutMs: 100, version: 'v1', run: async () => null });
    reg.register({ name: 'c', layer: CognitiveLayer.SYNC_CONDITIONAL, modelTier: 'fast', timeoutMs: 100, version: 'v1', run: async () => null });
    expect(reg.listByLayer(CognitiveLayer.SYNC_CONDITIONAL).map((d) => d.name).sort()).toEqual(['b', 'c']);
  });

  it('get retorna undefined para nome não registrado', () => {
    expect(reg.get('missing')).toBeUndefined();
  });
});
