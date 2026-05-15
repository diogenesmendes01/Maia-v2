import { describe, it, expect } from 'vitest';
import {
  runWithTenantContext,
  getCurrentTenant,
  getCurrentAgent,
  MissingTenantContextError,
} from '@/db/tenant-context.js';

describe('tenant-context', () => {
  it('runWithTenantContext propaga tenant_id e agent_id', async () => {
    let captured = { t: '', a: '' };
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'sofia' }, async () => {
      captured = { t: getCurrentTenant(), a: getCurrentAgent() };
    });
    expect(captured).toEqual({ t: 'acme', a: 'sofia' });
  });

  it('getCurrentTenant fora de contexto lança MissingTenantContextError', () => {
    expect(() => getCurrentTenant()).toThrow(MissingTenantContextError);
  });

  it('contextos aninhados respeitam escopo mais interno', async () => {
    await runWithTenantContext({ tenant_id: 'outer', agent_id: 'a1' }, async () => {
      expect(getCurrentTenant()).toBe('outer');
      await runWithTenantContext({ tenant_id: 'inner', agent_id: 'a2' }, async () => {
        expect(getCurrentTenant()).toBe('inner');
      });
      expect(getCurrentTenant()).toBe('outer');
    });
  });
});
