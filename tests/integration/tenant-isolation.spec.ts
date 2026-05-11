import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/db/client.js';
import {
  tenants,
  agents,
  transacoes,
  entidades,
  contas_bancarias,
} from '@/db/schema.js';
import { tenantsRepo, agentsRepo, transacoesRepo } from '@/db/repositories.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { eq, like } from 'drizzle-orm';

describe('Tenant isolation (P0)', () => {
  beforeAll(async () => {
    // Cria 2 tenants + 1 agente cada
    await tenantsRepo.create({ id: 't-a', nome: 'Tenant A' });
    await tenantsRepo.create({ id: 't-b', nome: 'Tenant B' });
    await db.insert(agents).values([
      { id: 'agent-a', tenant_id: 't-a', nome: 'Agent A' },
      { id: 'agent-b', tenant_id: 't-b', nome: 'Agent B' },
    ]);
  });

  afterAll(async () => {
    // Cleanup em ordem reversa de FK (transacoes → contas → entidades)
    await db.delete(transacoes).where(eq(transacoes.tenant_id, 't-a'));
    await db.delete(transacoes).where(eq(transacoes.tenant_id, 't-b'));
    // Helper-created rows ficam em tenant 'default' (raw insert bypassa context).
    await db.delete(contas_bancarias).where(like(contas_bancarias.apelido, 'Conta-test-%'));
    await db.delete(entidades).where(like(entidades.nome, 'TestEnt-%'));
    await db.delete(agents).where(eq(agents.tenant_id, 't-a'));
    await db.delete(agents).where(eq(agents.tenant_id, 't-b'));
    await db.delete(tenants).where(eq(tenants.id, 't-a'));
    await db.delete(tenants).where(eq(tenants.id, 't-b'));
  });

  // Helper pra criar transacao válida (todos os NOT NULL preenchidos).
  // Cria entidade/conta com nomes únicos prefixados pra limpeza confiável.
  let fixtureCounter = 0;
  async function makeTxFixture(descricao: string) {
    fixtureCounter++;
    const [ent] = await db
      .insert(entidades)
      .values({ nome: `TestEnt-${fixtureCounter}`, tipo: 'pj' })
      .returning();
    const [conta] = await db
      .insert(contas_bancarias)
      .values({
        entidade_id: ent.id,
        banco: 'X',
        apelido: `Conta-test-${fixtureCounter}`,
        tipo: 'corrente',
      })
      .returning();
    return {
      entidade_id: ent.id,
      conta_id: conta.id,
      natureza: 'saida' as const,
      valor: '100.00',
      data_competencia: '2026-05-11',
      status: 'confirmada',
      descricao,
      origem: 'manual' as const,
    };
  }

  it('insert no tenant A não aparece em queries do tenant B', async () => {
    await runWithTenantContext({ tenant_id: 't-a', agent_id: 'agent-a' }, async () => {
      const fixture = await makeTxFixture('TESTE A');
      await transacoesRepo.create(fixture);
    });

    const visibleToB = await runWithTenantContext(
      { tenant_id: 't-b', agent_id: 'agent-b' },
      () => transacoesRepo.listRecent(),
    );

    expect(visibleToB.find((t) => t.descricao === 'TESTE A')).toBeUndefined();
  });

  it('tentativa de injetar tenant_id no input lança erro', async () => {
    await runWithTenantContext({ tenant_id: 't-a', agent_id: 'agent-a' }, async () => {
      const fixture = await makeTxFixture('INJECTION');
      await expect(
        transacoesRepo.create({ ...fixture, tenant_id: 't-b' } as any),
      ).rejects.toThrow(/tenant mismatch/);
    });
  });

  it('query fora de tenant context lança MissingTenantContextError', async () => {
    await expect(transacoesRepo.listRecent()).rejects.toThrow(/Tenant context/);
  });
});
