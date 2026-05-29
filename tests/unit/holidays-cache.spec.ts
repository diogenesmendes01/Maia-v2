import { describe, it, expect, beforeEach } from 'vitest';
import {
  _internal_cache,
  cacheKey,
  getApplicableHolidaysSet,
  invalidateCacheForHolidayChange,
} from '../../src/lib/holidays-cache.js';
import { MissingTenantContextError, runWithTenantContext } from '../../src/db/tenant-context.js';

describe('holidays cache', () => {
  beforeEach(() => _internal_cache.clear());

  it('cacheKey is tenant-scoped', () => {
    const a = cacheKey('tenantA', 'agent-1', undefined, 2026, 'standard');
    const b = cacheKey('tenantB', 'agent-1', undefined, 2026, 'standard');
    expect(a).not.toBe(b);
    expect(a).toContain('tenantA');
  });

  it('key inclui tenant_id (cross-tenant isolation)', () => {
    const set = new Set(['2026-12-25']);
    _internal_cache.set(cacheKey('tenantA', 'agent-1', undefined, 2026, 'standard'), set);
    expect(_internal_cache.get(cacheKey('tenantA', 'agent-1', undefined, 2026, 'standard'))).toBe(set);
    expect(_internal_cache.get(cacheKey('tenantB', 'agent-1', undefined, 2026, 'standard'))).toBeUndefined();
  });

  // Issue #263 — cross-agent isolation within the same tenant
  it('key inclui agent_id — same (tenant, entidade, year, kind) com agents diferentes gera keys diferentes', () => {
    const keyAgentA = cacheKey('tenantA', 'agent-A', 'entidade-1', 2026, 'standard');
    const keyAgentB = cacheKey('tenantA', 'agent-B', 'entidade-1', 2026, 'standard');
    expect(keyAgentA).not.toBe(keyAgentB);
    expect(keyAgentA).toContain('agent-A');
    expect(keyAgentB).toContain('agent-B');
  });

  it('cross-agent isolation: set para agentA NÃO vaza para agentB (mesmo tenant)', () => {
    const setA = new Set(['2026-12-25', '2026-06-15']);
    const setB = new Set(['2026-12-25']);
    _internal_cache.set(cacheKey('tenantA', 'agent-A', 'entidade-1', 2026, 'standard'), setA);
    _internal_cache.set(cacheKey('tenantA', 'agent-B', 'entidade-1', 2026, 'standard'), setB);

    expect(_internal_cache.get(cacheKey('tenantA', 'agent-A', 'entidade-1', 2026, 'standard'))).toBe(setA);
    expect(_internal_cache.get(cacheKey('tenantA', 'agent-B', 'entidade-1', 2026, 'standard'))).toBe(setB);
    expect(setA).not.toBe(setB);
  });

  it('cross-agent isolation é simétrico (swap agent ids)', () => {
    const setA = new Set(['2026-12-25']);
    const setB = new Set(['2026-06-15']);
    const keyA = cacheKey('tenantA', 'agent-A', 'entidade-1', 2026, 'standard');
    const keyB = cacheKey('tenantA', 'agent-B', 'entidade-1', 2026, 'standard');
    _internal_cache.set(keyA, setA);
    _internal_cache.set(keyB, setB);
    expect(_internal_cache.get(keyA)).toBe(setA);
    expect(_internal_cache.get(keyB)).toBe(setB);
    // swap returns swapped values
    _internal_cache.set(keyA, setB);
    _internal_cache.set(keyB, setA);
    expect(_internal_cache.get(keyA)).toBe(setB);
    expect(_internal_cache.get(keyB)).toBe(setA);
  });

  it('key prefix é v3 (regression test para o bump v2 → v3 — encoding)', () => {
    const key = cacheKey('tenantA', 'agent-1', 'entidade-1', 2026, 'standard');
    expect(key.startsWith('holidays:v3:')).toBe(true);
    // Não regridir para v1 ou v2 (mudança de layout — encoded segments)
    expect(key.startsWith('holidays:v1:')).toBe(false);
    expect(key.startsWith('holidays:v2:')).toBe(false);
  });

  it('layout esperado: holidays:v3:{enc(tenant)}:{enc(agent)}:{enc(entidade)}:{year}:{kind}', () => {
    expect(cacheKey('tenantA', 'agent-1', 'entidade-1', 2026, 'standard')).toBe(
      'holidays:v3:tenantA:agent-1:entidade-1:2026:standard',
    );
    expect(cacheKey('tenantA', 'agent-1', undefined, 2026, 'clt')).toBe(
      'holidays:v3:tenantA:agent-1:global:2026:clt',
    );
  });

  // ---------------------------------------------------------------------
  // Issue #263 / PR #272 reval — collision por `:` delimiter sem escape.
  // Sem encoding, `tenant="T", agent="A:B", entity="E"` colide com
  // `tenant="T", agent="A", entity="B:E"` — mesma cache key, vazamento
  // cross-agent. Pattern mirror'd de #257 (vision-cache) / #258 (embedding).
  // ---------------------------------------------------------------------
  describe('encoding de segmentos (#272 reval — collision por `:`)', () => {
    it('agent_id contendo `:` não colide com particionamento alternativo', () => {
      // (tenant=T, agent="A:B", entity="E") vs (tenant=T, agent="A", entity="B:E")
      const k1 = cacheKey('T', 'A:B', 'E', 2026, 'standard');
      const k2 = cacheKey('T', 'A', 'B:E', 2026, 'standard');
      expect(k1).not.toBe(k2);
    });

    it('tenant_id contendo `:` não colide com particionamento alternativo', () => {
      // (tenant="T:A", agent="B") vs (tenant="T", agent="A:B")
      const k1 = cacheKey('T:A', 'B', 'E', 2026, 'standard');
      const k2 = cacheKey('T', 'A:B', 'E', 2026, 'standard');
      expect(k1).not.toBe(k2);
    });

    it('entidadeId contendo `:` é encodada', () => {
      const key = cacheKey('T', 'A', 'ent:1', 2026, 'standard');
      // `:` no entidadeId vira %3A
      expect(key).toContain('ent%3A1');
      // E o número de `:` cru na chave bate o layout estável
      // holidays:v3:T:A:ent%3A1:2026:standard → 6 colons
      expect(key.split(':').length).toBe(7);
    });

    it('tenant_id contendo `:` é encodada (acme:dev real-world slug)', () => {
      const key = cacheKey('acme:dev', 'agent-1', undefined, 2026, 'standard');
      expect(key).toContain('acme%3Adev');
      expect(key).not.toContain('acme:dev:'); // delimitador-original NÃO aparece cru
    });

    it('agent_id com caracteres especiais (%, espaço) é encodada', () => {
      const key = cacheKey('T', 'agent with space', 'E', 2026, 'standard');
      expect(key).toContain('agent%20with%20space');
    });

    it('round-trip determinístico: mesma input gera mesma chave', () => {
      const k1 = cacheKey('acme:dev', 'sof:ia', 'ent:1', 2026, 'standard');
      const k2 = cacheKey('acme:dev', 'sof:ia', 'ent:1', 2026, 'standard');
      expect(k1).toBe(k2);
    });
  });

  // ---------------------------------------------------------------------
  // Invalidação tenant-scoped com tenant contendo `:` — prefix encoding
  // garante que `tenant="acme"` NÃO limpa entradas de `tenant="acme:dev"`.
  // ---------------------------------------------------------------------
  it('invalidação tenant-scoped não vaza entre tenants com `:` no slug', () => {
    _internal_cache.set(cacheKey('acme', 'a', undefined, 2026, 'standard'), new Set(['2026-12-25']));
    _internal_cache.set(cacheKey('acme:dev', 'a', undefined, 2026, 'standard'), new Set(['2026-12-25']));

    invalidateCacheForHolidayChange(
      { tenant_id: 'acme', type: 'national' },
      { changeKind: 'create' },
    );

    // tenant="acme" limpo
    expect(_internal_cache.get(cacheKey('acme', 'a', undefined, 2026, 'standard'))).toBeUndefined();
    // tenant="acme:dev" INTACTO (não vazou)
    expect(_internal_cache.get(cacheKey('acme:dev', 'a', undefined, 2026, 'standard'))).toBeDefined();
  });

  it('getApplicableHolidaysSet lança MissingTenantContextError fora do contexto', async () => {
    await expect(
      getApplicableHolidaysSet(2026, {}, async () => new Set()),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  // Issue #263 / PR #272 review — fail-closed on falsy agent_id mesmo COM ctx
  // (cenário MAJOR do Codex: ALS presente mas malformado → key colidente).
  it('getApplicableHolidaysSet lança quando agent_id é string vazia (ctx existe)', async () => {
    await runWithTenantContext({ tenant_id: 'tenantA', agent_id: '' }, async () => {
      await expect(
        getApplicableHolidaysSet(2026, { entidadeId: 'e1' }, async () => new Set()),
      ).rejects.toBeInstanceOf(MissingTenantContextError);
    });
  });

  it('getApplicableHolidaysSet lança quando tenant_id é string vazia (ctx existe)', async () => {
    await runWithTenantContext({ tenant_id: '', agent_id: 'agent-A' }, async () => {
      await expect(
        getApplicableHolidaysSet(2026, { entidadeId: 'e1' }, async () => new Set()),
      ).rejects.toBeInstanceOf(MissingTenantContextError);
    });
  });

  it('getApplicableHolidaysSet lança quando agent_id é null (ctx existe)', async () => {
    await runWithTenantContext(
      { tenant_id: 'tenantA', agent_id: null as unknown as string },
      async () => {
        await expect(
          getApplicableHolidaysSet(2026, { entidadeId: 'e1' }, async () => new Set()),
        ).rejects.toBeInstanceOf(MissingTenantContextError);
      },
    );
  });

  // Issue #283 / PR #272 reval — whitespace-only IDs gerariam namespace
  // anômalo encoded (`holidays:v3:%20%20%20:...`) que ainda colide entre si.
  it('getApplicableHolidaysSet lança quando agent_id é whitespace-only', async () => {
    await runWithTenantContext({ tenant_id: 'tenantA', agent_id: '   ' }, async () => {
      await expect(
        getApplicableHolidaysSet(2026, { entidadeId: 'e1' }, async () => new Set()),
      ).rejects.toBeInstanceOf(MissingTenantContextError);
    });
  });

  it('getApplicableHolidaysSet lança quando tenant_id é whitespace-only', async () => {
    await runWithTenantContext({ tenant_id: '\t', agent_id: 'agent-A' }, async () => {
      await expect(
        getApplicableHolidaysSet(2026, { entidadeId: 'e1' }, async () => new Set()),
      ).rejects.toBeInstanceOf(MissingTenantContextError);
    });
  });

  it('getApplicableHolidaysSet usa agent_id do ALS context na chave', async () => {
    const loader = async (_tenant_id: string) => new Set(['2026-12-25']);
    await runWithTenantContext({ tenant_id: 'tenantA', agent_id: 'agent-X' }, async () => {
      await getApplicableHolidaysSet(2026, { entidadeId: 'entidade-1' }, loader);
    });
    // o set foi cacheado sob a chave que inclui agent-X
    expect(_internal_cache.get(cacheKey('tenantA', 'agent-X', 'entidade-1', 2026, 'standard'))).toBeDefined();
    // mesmo tenant, agent diferente, é miss
    expect(_internal_cache.get(cacheKey('tenantA', 'agent-Y', 'entidade-1', 2026, 'standard'))).toBeUndefined();
  });

  it('getApplicableHolidaysSet cross-agent: agent-A cacheia, agent-B chama loader novamente', async () => {
    let loadCount = 0;
    const loader = async (_tenant_id: string) => {
      loadCount++;
      return new Set([`2026-12-25:${loadCount}`]);
    };
    await runWithTenantContext({ tenant_id: 'tenantA', agent_id: 'agent-A' }, async () => {
      await getApplicableHolidaysSet(2026, { entidadeId: 'entidade-1' }, loader);
      await getApplicableHolidaysSet(2026, { entidadeId: 'entidade-1' }, loader);
    });
    expect(loadCount).toBe(1); // segundo call hit cache

    await runWithTenantContext({ tenant_id: 'tenantA', agent_id: 'agent-B' }, async () => {
      await getApplicableHolidaysSet(2026, { entidadeId: 'entidade-1' }, loader);
    });
    expect(loadCount).toBe(2); // agent-B é miss, chama loader
  });

  it('invalidateCacheForHolidayChange scopes to tenant', () => {
    _internal_cache.set(cacheKey('tenantA', 'agent-1', undefined, 2026, 'standard'), new Set(['2026-12-25']));
    _internal_cache.set(cacheKey('tenantB', 'agent-1', undefined, 2026, 'standard'), new Set(['2026-12-25']));
    invalidateCacheForHolidayChange(
      { tenant_id: 'tenantA', type: 'national' },
      { changeKind: 'create' },
    );
    expect(_internal_cache.get(cacheKey('tenantA', 'agent-1', undefined, 2026, 'standard'))).toBeUndefined();
    expect(_internal_cache.get(cacheKey('tenantB', 'agent-1', undefined, 2026, 'standard'))).toBeDefined();
  });

  // Issue #263 — broad invalidation deve limpar TODOS os agents do tenant
  it('invalidateCacheForHolidayChange limpa TODOS os agents do mesmo tenant (wildcard agent_id)', () => {
    _internal_cache.set(cacheKey('tenantA', 'agent-A', undefined, 2026, 'standard'), new Set(['2026-12-25']));
    _internal_cache.set(cacheKey('tenantA', 'agent-B', undefined, 2026, 'standard'), new Set(['2026-12-25']));
    _internal_cache.set(cacheKey('tenantA', 'agent-C', 'entidade-1', 2026, 'clt'), new Set(['2026-06-15']));
    _internal_cache.set(cacheKey('tenantB', 'agent-A', undefined, 2026, 'standard'), new Set(['2026-12-25']));

    invalidateCacheForHolidayChange(
      { tenant_id: 'tenantA', type: 'national' },
      { changeKind: 'create' },
    );

    // todos os agents do tenantA limpos
    expect(_internal_cache.get(cacheKey('tenantA', 'agent-A', undefined, 2026, 'standard'))).toBeUndefined();
    expect(_internal_cache.get(cacheKey('tenantA', 'agent-B', undefined, 2026, 'standard'))).toBeUndefined();
    expect(_internal_cache.get(cacheKey('tenantA', 'agent-C', 'entidade-1', 2026, 'clt'))).toBeUndefined();
    // tenantB intacto
    expect(_internal_cache.get(cacheKey('tenantB', 'agent-A', undefined, 2026, 'standard'))).toBeDefined();
  });
});
