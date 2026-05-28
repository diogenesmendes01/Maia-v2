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
  // PR #272 / #269 review (Codex reval): fail-closed when ALS carries
  // malformed context — empty string, null, undefined, non-string.
  // Previously the accessors returned the raw value, letting downstream
  // queries scope by an empty tenant_id and (worst case) leak rows across
  // tenants. Sem essa guarda, holidays-cache (#263) geraria keys malformadas
  // (`holidays:v2:A::entidade:2026:standard`) que colidem silenciosamente
  // entre contextos quebrados.
  // -------------------------------------------------------------------------
  describe('PR #272 / #269 — truthy validation of ctx.tenant_id / ctx.agent_id', () => {
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

    it('getCurrentAgent lança quando agent_id é undefined', async () => {
      await runWithTenantContext(
        { tenant_id: 'acme', agent_id: undefined as unknown as string },
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

  // -------------------------------------------------------------------------
  // PR #272 reval / Issue #283 / PR #293 — whitespace-only IDs.
  // Strings tipo `'   '` ou `'\t'` passam o check truthy mas geram namespace
  // anômalo determinístico — colisão silenciosa entre contextos malformados.
  // Fix central em assertTruthyContext (PR #293) rejeita whitespace-only
  // E strings com whitespace ao redor (contrato strict, sem trim implícito).
  // -------------------------------------------------------------------------
  describe('PR #272 reval / #283 / #293 — whitespace-only tenant_id / agent_id', () => {
    it('getCurrentTenant lança quando tenant_id é whitespace-only (spaces)', async () => {
      await runWithTenantContext({ tenant_id: '   ', agent_id: 'sofia' }, async () => {
        expect(() => getCurrentTenant()).toThrow(MissingTenantContextError);
      });
    });

    it('getCurrentTenant lança quando tenant_id é tab/newline only', async () => {
      await runWithTenantContext({ tenant_id: '\t\n', agent_id: 'sofia' }, async () => {
        expect(() => getCurrentTenant()).toThrow(MissingTenantContextError);
      });
    });

    it('rejeita tenant_id whitespace-only (tab)', async () => {
      await runWithTenantContext({ tenant_id: '\t', agent_id: 'sofia' }, async () => {
        expect(() => getCurrentTenant()).toThrow(MissingTenantContextError);
      });
    });

    it('rejeita tenant_id whitespace-only (newline)', async () => {
      await runWithTenantContext({ tenant_id: '\n', agent_id: 'sofia' }, async () => {
        expect(() => getCurrentTenant()).toThrow(MissingTenantContextError);
      });
    });

    it('rejeita tenant_id whitespace-only (mixed: tab+newline+space)', async () => {
      await runWithTenantContext({ tenant_id: '\t\n  ', agent_id: 'sofia' }, async () => {
        expect(() => getCurrentTenant()).toThrow(MissingTenantContextError);
      });
    });

    it('getCurrentAgent lança quando agent_id é whitespace-only (spaces)', async () => {
      await runWithTenantContext({ tenant_id: 'acme', agent_id: '   ' }, async () => {
        expect(() => getCurrentAgent()).toThrow(MissingTenantContextError);
      });
    });

    it('getCurrentAgent lança quando agent_id é tab/newline only', async () => {
      await runWithTenantContext({ tenant_id: 'acme', agent_id: '\t\n' }, async () => {
        expect(() => getCurrentAgent()).toThrow(MissingTenantContextError);
      });
    });

    it('rejeita agent_id whitespace-only (tab)', async () => {
      await runWithTenantContext({ tenant_id: 'acme', agent_id: '\t' }, async () => {
        expect(() => getCurrentAgent()).toThrow(MissingTenantContextError);
      });
    });

    // Contrato: ' valid ' (whitespace ao redor) → REJECTED (strict, não trim)
    it('rejeita tenant_id com whitespace ao redor (` valid `) — contrato strict', async () => {
      await runWithTenantContext({ tenant_id: ' acme ', agent_id: 'sofia' }, async () => {
        expect(() => getCurrentTenant()).toThrow(MissingTenantContextError);
      });
    });

    it('rejeita agent_id com leading whitespace', async () => {
      await runWithTenantContext({ tenant_id: 'acme', agent_id: ' sofia' }, async () => {
        expect(() => getCurrentAgent()).toThrow(MissingTenantContextError);
      });
    });

    it('rejeita agent_id com trailing whitespace', async () => {
      await runWithTenantContext({ tenant_id: 'acme', agent_id: 'sofia\t' }, async () => {
        expect(() => getCurrentAgent()).toThrow(MissingTenantContextError);
      });
    });

    it('aceita strings normalizadas (sem whitespace ao redor)', async () => {
      await runWithTenantContext({ tenant_id: 'acme', agent_id: 'sofia' }, async () => {
        expect(getCurrentTenant()).toBe('acme');
        expect(getCurrentAgent()).toBe('sofia');
      });
    });

    it('aceita strings com whitespace interno (não ao redor) — `acme inc`', async () => {
      // Whitespace interno é válido — só rejeitamos leading/trailing.
      await runWithTenantContext({ tenant_id: 'acme inc', agent_id: 'sofia bot' }, async () => {
        expect(getCurrentTenant()).toBe('acme inc');
        expect(getCurrentAgent()).toBe('sofia bot');
      });
    });

    it('tryGetCurrentContext retorna null quando tenant_id é whitespace-only', async () => {
      await runWithTenantContext({ tenant_id: '   ', agent_id: 'sofia' }, async () => {
        expect(tryGetCurrentContext()).toBeNull();
      });
    });

    it('tryGetCurrentContext retorna null quando agent_id é whitespace-only', async () => {
      await runWithTenantContext({ tenant_id: 'acme', agent_id: '\t' }, async () => {
        expect(tryGetCurrentContext()).toBeNull();
      });
    });

    it('tryGetCurrentContext retorna null quando tenant_id tem whitespace ao redor', async () => {
      await runWithTenantContext({ tenant_id: ' acme ', agent_id: 'sofia' }, async () => {
        expect(tryGetCurrentContext()).toBeNull();
      });
    });

    it('mensagem de erro distingue empty vs whitespace para debugging', async () => {
      await runWithTenantContext({ tenant_id: '   ', agent_id: 'sofia' }, async () => {
        try {
          getCurrentTenant();
          throw new Error('expected throw');
        } catch (err) {
          expect(err).toBeInstanceOf(MissingTenantContextError);
          expect((err as Error).message).toMatch(/whitespace-only/);
        }
      });
    });
  });

  // tryGetCurrentContext semantics adicionais (consistente com asserts dos getters)
  describe('tryGetCurrentContext — semantics', () => {
    it('retorna null fora de contexto ALS', () => {
      expect(tryGetCurrentContext()).toBeNull();
    });

    it('retorna ctx válido quando dentro de runWithTenantContext', async () => {
      await runWithTenantContext({ tenant_id: 'acme', agent_id: 'sofia' }, async () => {
        expect(tryGetCurrentContext()).toEqual({ tenant_id: 'acme', agent_id: 'sofia' });
      });
    });

    it('retorna null quando tenant_id é empty string (preserva #269)', async () => {
      await runWithTenantContext({ tenant_id: '', agent_id: 'sofia' }, async () => {
        expect(tryGetCurrentContext()).toBeNull();
      });
    });

    it('retorna null quando tenant_id é non-string (preserva #269)', async () => {
      await runWithTenantContext({ tenant_id: null as any, agent_id: 'sofia' }, async () => {
        expect(tryGetCurrentContext()).toBeNull();
      });
    });
  });
});
