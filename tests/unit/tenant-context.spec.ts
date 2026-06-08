import { describe, it, expect, vi, beforeEach } from 'vitest';

const { incCounterMock } = vi.hoisted(() => ({ incCounterMock: vi.fn() }));
vi.mock('../../src/lib/metrics.js', () => ({
  incCounter: incCounterMock,
}));

import {
  runWithTenantContext,
  runWithSystemContext,
  getCurrentTenant,
  getCurrentAgent,
  tryGetCurrentContext,
  isSystemContext,
  SYSTEM_TENANT_ID,
  SYSTEM_AGENT_ID,
  SYSTEM_CONTEXT,
  PRIMARY_TENANT_ID,
  PRIMARY_AGENT_ID,
  PRIMARY_CONTEXT,
  isPrimaryContext,
  MissingTenantContextError,
  DefaultLiteralRejectedError,
} from '@/db/tenant-context.js';

describe('tenant-context', () => {
  beforeEach(() => {
    incCounterMock.mockReset();
    delete process.env.MAIA_REJECT_DEFAULT_LITERAL;
  });

  it('runWithTenantContext propaga tenant_id e agent_id', async () => {
    let captured = { t: '', a: '' };
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'sofia' }, async () => {
      captured = { t: getCurrentTenant(), a: getCurrentAgent() };
    });
    expect(captured).toEqual({ t: 'acme', a: 'sofia' });
  });

  it('primary é tenant reservado COMUM: passa no guard mesmo com flag ON', async () => {
    expect(PRIMARY_TENANT_ID).toBe('primary');
    expect(PRIMARY_AGENT_ID).toBe('primary');
    expect(isPrimaryContext(PRIMARY_CONTEXT)).toBe(true);
    expect(isPrimaryContext({ tenant_id: 'default', agent_id: 'default' })).toBe(false);
    expect(isSystemContext(PRIMARY_CONTEXT)).toBe(false);
    // Com a flag de rejeição ON, 'primary' NÃO é rejeitado (só 'default' é).
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
    let captured = { t: '', a: '' };
    await runWithTenantContext(PRIMARY_CONTEXT, async () => {
      captured = { t: getCurrentTenant(), a: getCurrentAgent() };
    });
    expect(captured).toEqual({ t: 'primary', a: 'primary' });
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

  // -------------------------------------------------------------------------
  // Issue #282 / PR #296 — literal 'default' rejection
  //
  // Layered defense against silent synthetic-context leak from the legacy
  // sentinel `{tenant_id:'default', agent_id:'default'}`. Default mode meters
  // (warn+counter); opt-in `MAIA_REJECT_DEFAULT_LITERAL=true` promotes to
  // a hard throw once every legacy path is migrated.
  // -------------------------------------------------------------------------
  describe('issue #282 — literal "default" rejection', () => {
    it('default mode: literal "default" tenant_id increments metric but does NOT throw', async () => {
      let observed: string | null = null;
      await runWithTenantContext({ tenant_id: 'default', agent_id: 'sofia' }, async () => {
        observed = getCurrentTenant();
      });
      expect(observed).toBe('default');
      expect(incCounterMock).toHaveBeenCalledWith(
        'maia_tenant_id_default_literal_total',
        expect.objectContaining({ field: 'tenant_id' }),
      );
    });

    it('default mode: literal "default" agent_id increments metric but does NOT throw', async () => {
      let observed: string | null = null;
      await runWithTenantContext({ tenant_id: 'acme', agent_id: 'default' }, async () => {
        observed = getCurrentAgent();
      });
      expect(observed).toBe('default');
      expect(incCounterMock).toHaveBeenCalledWith(
        'maia_tenant_id_default_literal_total',
        expect.objectContaining({ field: 'agent_id' }),
      );
    });

    it('opt-in mode (MAIA_REJECT_DEFAULT_LITERAL=true): tenant_id="default" throws DefaultLiteralRejectedError', async () => {
      process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
      await expect(
        runWithTenantContext({ tenant_id: 'default', agent_id: 'sofia' }, async () => {
          getCurrentTenant();
        }),
      ).rejects.toThrow(DefaultLiteralRejectedError);
    });

    it('opt-in mode: agent_id="default" throws DefaultLiteralRejectedError', async () => {
      process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
      await expect(
        runWithTenantContext({ tenant_id: 'acme', agent_id: 'default' }, async () => {
          getCurrentAgent();
        }),
      ).rejects.toThrow(DefaultLiteralRejectedError);
    });

    it('opt-in mode: thrown error has stable code TENANT_ID_DEFAULT_LITERAL_REJECTED', async () => {
      process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
      try {
        await runWithTenantContext({ tenant_id: 'default', agent_id: 'sofia' }, async () => {
          getCurrentTenant();
        });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(DefaultLiteralRejectedError);
        expect((e as DefaultLiteralRejectedError).code).toBe('TENANT_ID_DEFAULT_LITERAL_REJECTED');
      }
    });

    it('opt-in mode: throw only fires on default literal, not other tenant_ids', async () => {
      process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
      let observed: string | null = null;
      await runWithTenantContext({ tenant_id: 'acme', agent_id: 'sofia' }, async () => {
        observed = getCurrentTenant();
      });
      expect(observed).toBe('acme');
      expect(incCounterMock).not.toHaveBeenCalled();
    });

    // PR #293 review (blocker 2): tryGetCurrentContext is routed through the
    // SAME helpers as the strict getters and is fail-closed. With the flag ON,
    // a 'default' literal must NOT yield a usable context — it returns null so
    // callers take their missing-context branch instead of getting a synthetic
    // cross-tenant-readable scope.
    it('opt-in mode: tryGetCurrentContext returns null (fail-closed) on default/default', async () => {
      process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
      let observed: ReturnType<typeof tryGetCurrentContext> | undefined;
      await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
        observed = tryGetCurrentContext();
      });
      expect(observed).toBeNull();
      // Metering still fires (via the shared assertNotDefaultLiteral helper)
      // before the throw that drives the null — tenant_id is checked first and
      // short-circuits, so at least the tenant_id field is metered.
      const calls = incCounterMock.mock.calls.filter(
        (c) => c[0] === 'maia_tenant_id_default_literal_total',
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls.some((c) => c[1]?.field === 'tenant_id')).toBe(true);
    });

    it('opt-in mode: tryGetCurrentContext returns null when only agent_id is default', async () => {
      process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
      let observed: ReturnType<typeof tryGetCurrentContext> | undefined;
      await runWithTenantContext({ tenant_id: 'acme', agent_id: 'default' }, async () => {
        observed = tryGetCurrentContext();
      });
      expect(observed).toBeNull();
    });

    // Flag OFF: the 'default' literal is metered but (since the shape checks
    // pass) the context is still returned — preserving the observability
    // rollout. Confirms tryGetCurrentContext reuses the shared metering helper.
    it('default mode: tryGetCurrentContext meters default/default but still returns it', async () => {
      let observed: ReturnType<typeof tryGetCurrentContext> | undefined;
      await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
        observed = tryGetCurrentContext();
      });
      expect(observed).toEqual({ tenant_id: 'default', agent_id: 'default' });
      const calls = incCounterMock.mock.calls.filter(
        (c) => c[0] === 'maia_tenant_id_default_literal_total',
      );
      // Both fields metered (no throw short-circuits when the flag is off).
      expect(calls.some((c) => c[1]?.field === 'tenant_id')).toBe(true);
      expect(calls.some((c) => c[1]?.field === 'agent_id')).toBe(true);
    });

    // PR #293 review (blocker 3): surrounding-whitespace rejection at THIS call
    // site (the strict getters already cover it via assertTruthyContext; verify
    // the try variant rejects it too rather than handing back a padded id that
    // would collide/diverge in cache-key namespaces). Independent of the flag.
    it('tryGetCurrentContext returns null on surrounding-whitespace agent_id (flag on)', async () => {
      process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
      let observed: ReturnType<typeof tryGetCurrentContext> | undefined;
      await runWithTenantContext({ tenant_id: 'acme', agent_id: ' sofia ' }, async () => {
        observed = tryGetCurrentContext();
      });
      expect(observed).toBeNull();
    });

    it('flag is read at access time, not module-load time', async () => {
      // Start without flag — must not throw.
      delete process.env.MAIA_REJECT_DEFAULT_LITERAL;
      await runWithTenantContext({ tenant_id: 'default', agent_id: 'sofia' }, async () => {
        expect(getCurrentTenant()).toBe('default');
      });
      // Flip flag mid-process — must throw on next access.
      process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
      await expect(
        runWithTenantContext({ tenant_id: 'default', agent_id: 'sofia' }, async () => {
          getCurrentTenant();
        }),
      ).rejects.toThrow(DefaultLiteralRejectedError);
    });
  });

  // -------------------------------------------------------------------------
  // Issue #323 phase 1 — reserved 'system' maintenance sentinel.
  //
  // Purely-additive vocabulary for genuinely-global workers. The CRITICAL
  // invariant locked in here: unlike 'default', the 'system' sentinel is NEVER
  // rejected — not by the shape guards, and not by assertNotDefaultLiteral even
  // with MAIA_REJECT_DEFAULT_LITERAL=true. This is the property that makes the
  // eventual default-literal flip safe (global workers re-home to 'system';
  // 'default' becomes a hard-fail signal of a misrouted path).
  // -------------------------------------------------------------------------
  describe('issue #323 — reserved "system" context sentinel', () => {
    it('SYSTEM_CONTEXT exposes the reserved system/system tuple', () => {
      expect(SYSTEM_TENANT_ID).toBe('system');
      expect(SYSTEM_AGENT_ID).toBe('system');
      expect(SYSTEM_CONTEXT).toEqual({ tenant_id: 'system', agent_id: 'system' });
    });

    it('SYSTEM_CONTEXT is frozen (callers cannot mutate the shared object)', () => {
      expect(Object.isFrozen(SYSTEM_CONTEXT)).toBe(true);
      expect(() => {
        (SYSTEM_CONTEXT as { tenant_id: string }).tenant_id = 'hijack';
      }).toThrow();
      expect(SYSTEM_CONTEXT.tenant_id).toBe('system');
    });

    it('runWithSystemContext runs fn under system/system', async () => {
      let captured = { t: '', a: '' };
      await runWithSystemContext(async () => {
        captured = { t: getCurrentTenant(), a: getCurrentAgent() };
      });
      expect(captured).toEqual({ t: 'system', a: 'system' });
    });

    it('runWithSystemContext propagates the fn return value', async () => {
      const out = await runWithSystemContext(async () => 42);
      expect(out).toBe(42);
    });

    it('isSystemContext is true only for the system/system tuple', () => {
      expect(isSystemContext({ tenant_id: 'system', agent_id: 'system' })).toBe(true);
      expect(isSystemContext(SYSTEM_CONTEXT)).toBe(true);
      expect(isSystemContext({ tenant_id: 'system', agent_id: 'sofia' })).toBe(false);
      expect(isSystemContext({ tenant_id: 'acme', agent_id: 'system' })).toBe(false);
      expect(isSystemContext({ tenant_id: 'default', agent_id: 'default' })).toBe(false);
      expect(isSystemContext({ tenant_id: 'acme', agent_id: 'sofia' })).toBe(false);
    });

    it('getCurrentTenant/getCurrentAgent accept system and never meter it (flag OFF)', async () => {
      await runWithSystemContext(async () => {
        expect(getCurrentTenant()).toBe('system');
        expect(getCurrentAgent()).toBe('system');
      });
      expect(incCounterMock).not.toHaveBeenCalledWith(
        'maia_tenant_id_default_literal_total',
        expect.anything(),
      );
    });

    it('CRITICAL: system is NOT rejected even with MAIA_REJECT_DEFAULT_LITERAL=true', async () => {
      process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
      let observed = { t: '', a: '' };
      await runWithSystemContext(async () => {
        observed = { t: getCurrentTenant(), a: getCurrentAgent() };
      });
      expect(observed).toEqual({ t: 'system', a: 'system' });
      // No default-literal metering for the system sentinel.
      expect(incCounterMock).not.toHaveBeenCalledWith(
        'maia_tenant_id_default_literal_total',
        expect.anything(),
      );
    });

    it('tryGetCurrentContext returns the system context (flag ON) — fail-open for global work', async () => {
      process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
      let observed: ReturnType<typeof tryGetCurrentContext> | undefined;
      await runWithSystemContext(async () => {
        observed = tryGetCurrentContext();
      });
      expect(observed).toEqual({ tenant_id: 'system', agent_id: 'system' });
    });
  });
});
