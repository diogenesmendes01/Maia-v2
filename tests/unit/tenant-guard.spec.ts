import { describe, it, expect } from 'vitest';
import { applyTenantGuard, MissingTenantContextError } from '@/db/tenant-guard.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

describe('tenant-guard', () => {
  it('sem contexto: throws MissingTenantContextError', () => {
    expect(() => applyTenantGuard({})).toThrow(MissingTenantContextError);
  });

  it('com contexto: injeta tenant_id e agent_id', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'sofia' }, async () => {
      const guarded = applyTenantGuard({});
      expect(guarded).toEqual({ tenant_id: 'acme', agent_id: 'sofia' });
    });
  });

  it('com tenant_id explícito DIFERENTE do contexto: throws', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'sofia' }, async () => {
      expect(() => applyTenantGuard({ tenant_id: 'other' })).toThrow(/tenant mismatch/);
    });
  });

  it('com tenant_id explícito IGUAL ao contexto: passa', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'sofia' }, async () => {
      const guarded = applyTenantGuard({ tenant_id: 'acme' });
      expect(guarded).toEqual({ tenant_id: 'acme', agent_id: 'sofia' });
    });
  });
});
