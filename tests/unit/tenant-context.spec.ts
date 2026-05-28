import { describe, it, expect } from 'vitest';
import {
  runWithTenantContext,
  getCurrentTenant,
  getCurrentAgent,
  tryGetCurrentContext,
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

  // -------------------------------------------------------------------------
  // PR #269 review (Codex reval): fail-closed when ALS carries malformed
  // context — empty string, null, undefined, non-string. Previously the
  // accessors returned the raw value, letting downstream queries scope by
  // an empty tenant_id and (worst case) leak rows across tenants.
  // -------------------------------------------------------------------------
  describe('PR #269 — truthy validation of ctx.tenant_id / ctx.agent_id', () => {
    it('getCurrentTenant lança quando tenant_id é string vazia', async () => {
      await runWithTenantContext({ tenant_id: '', agent_id: 'sofia' }, async () => {
        expect(() => getCurrentTenant()).toThrow(MissingTenantContextError);
      });
    });

    it('getCurrentTenant lança quando tenant_id é null', async () => {
      await runWithTenantContext(
        { tenant_id: null as unknown as string, agent_id: 'sofia' },
        async () => {
          expect(() => getCurrentTenant()).toThrow(MissingTenantContextError);
        },
      );
    });

    it('getCurrentTenant lança quando tenant_id é undefined', async () => {
      await runWithTenantContext(
        { tenant_id: undefined as unknown as string, agent_id: 'sofia' },
        async () => {
          expect(() => getCurrentTenant()).toThrow(MissingTenantContextError);
        },
      );
    });

    it('getCurrentAgent lança quando agent_id é string vazia', async () => {
      await runWithTenantContext({ tenant_id: 'acme', agent_id: '' }, async () => {
        expect(() => getCurrentAgent()).toThrow(MissingTenantContextError);
      });
    });

    it('getCurrentAgent lança quando agent_id é null', async () => {
      await runWithTenantContext(
        { tenant_id: 'acme', agent_id: null as unknown as string },
        async () => {
          expect(() => getCurrentAgent()).toThrow(MissingTenantContextError);
        },
      );
    });

    it('MissingTenantContextError preserva código estável e mensagem com razão', async () => {
      await runWithTenantContext({ tenant_id: '', agent_id: 'sofia' }, async () => {
        try {
          getCurrentTenant();
          throw new Error('expected throw');
        } catch (err) {
          expect(err).toBeInstanceOf(MissingTenantContextError);
          expect((err as MissingTenantContextError).code).toBe('MISSING_TENANT_CONTEXT');
          expect((err as Error).message).toMatch(/tenant_id is empty/);
        }
      });
    });

    it('tryGetCurrentContext retorna null quando ctx é malformado', async () => {
      // Callers que escolheram a variante "try" também não devem receber
      // contexto meio populado — força o mesmo code path que ALS ausente.
      await runWithTenantContext({ tenant_id: '', agent_id: 'sofia' }, async () => {
        expect(tryGetCurrentContext()).toBeNull();
      });
      await runWithTenantContext({ tenant_id: 'acme', agent_id: '' }, async () => {
        expect(tryGetCurrentContext()).toBeNull();
      });
      await runWithTenantContext(
        { tenant_id: null as unknown as string, agent_id: null as unknown as string },
        async () => {
          expect(tryGetCurrentContext()).toBeNull();
        },
      );
    });

    it('tryGetCurrentContext retorna ctx quando ambos os campos são truthy', async () => {
      await runWithTenantContext({ tenant_id: 'acme', agent_id: 'sofia' }, async () => {
        expect(tryGetCurrentContext()).toEqual({ tenant_id: 'acme', agent_id: 'sofia' });
      });
    });
  });
});
