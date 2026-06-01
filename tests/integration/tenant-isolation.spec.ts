import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/db/client.js';
import {
  tenants,
  agents,
  transacoes,
  entidades,
  contas_bancarias,
  pessoas,
} from '@/db/schema.js';
import { tenantsRepo, transacoesRepo, pessoasRepo } from '@/db/repositories.js';
import {
  runWithTenantContext,
  getCurrentTenant,
  getCurrentAgent,
  MissingTenantContextError,
} from '@/db/tenant-context.js';
import { like, inArray } from 'drizzle-orm';

// Padrão do projeto (tests/integration/leak.spec.ts): integration tests
// só rodam quando TEST_DB_URL está setada. No CI a validate job não tem
// Postgres — o integration job (com service container) cuida desse caso.
const SHOULD_RUN = !!process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

d('Tenant isolation (P0)', () => {
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
    // Cleanup em ordem reversa de FK (transacoes → contas → entidades).
    // Filtrar por tenant dos próprios fixtures — agora entidades/contas
    // herdam o tenant_id do contexto onde foram criadas (não 'default').
    const tenantIds = ['t-a', 't-b'];
    await db.delete(transacoes).where(inArray(transacoes.tenant_id, tenantIds));
    await db
      .delete(contas_bancarias)
      .where(like(contas_bancarias.apelido, 'Conta-test-%'));
    await db.delete(entidades).where(like(entidades.nome, 'TestEnt-%'));
    // findByPhone test seeds a pessoa under agent-a; drop it before agents to
    // satisfy pessoas_agent_id_fkey.
    await db.delete(pessoas).where(inArray(pessoas.tenant_id, tenantIds));
    await db.delete(agents).where(inArray(agents.tenant_id, tenantIds));
    await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  });

  // Helper pra criar transacao válida (todos os NOT NULL preenchidos +
  // valores aceitos pelos CHECKs de natureza/status/tipo).
  //
  // Importante: precisa rodar DENTRO de `runWithTenantContext`. Lê o tenant
  // atual e injeta nas inserções raw, garantindo que entidade/conta/transação
  // ficam todos no mesmo tenant (sem isso, o raw insert cairia no default
  // 'default' do schema e a tx referenciaria entidade de outro tenant).
  let fixtureCounter = 0;
  async function makeTxFixture(descricao: string) {
    fixtureCounter++;
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const [ent] = await db
      .insert(entidades)
      .values({ nome: `TestEnt-${fixtureCounter}`, tipo: 'pj', tenant_id, agent_id })
      .returning();
    const [conta] = await db
      .insert(contas_bancarias)
      .values({
        entidade_id: ent.id,
        banco: 'X',
        apelido: `Conta-test-${fixtureCounter}`,
        tipo: 'cc',
        tenant_id,
        agent_id,
      })
      .returning();
    return {
      entidade_id: ent.id,
      conta_id: conta.id,
      natureza: 'despesa' as const,
      valor: '100.00',
      data_competencia: '2026-05-11',
      status: 'paga',
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
      // tenant_id é Omitted do tipo de input do create — passar mesmo assim
      // exige bypass do excess-property check. `unknown` é o cast mínimo.
      type CreateInput = Parameters<typeof transacoesRepo.create>[0];
      const malicious = { ...fixture, tenant_id: 't-b' } as unknown as CreateInput;
      await expect(transacoesRepo.create(malicious)).rejects.toThrow(/tenant mismatch/);
    });
  });

  it('query fora de tenant context lança MissingTenantContextError', async () => {
    await expect(transacoesRepo.listRecent()).rejects.toThrow(/Tenant context/);
  });

  // PR #75 review finding #C2 / Superpowers #1: pessoa lookup by phone is the
  // first step on every WhatsApp inbound. If it leaks across tenants, every
  // downstream permission/escopo check is already compromised.
  it('pessoasRepo.findByPhone is isolated by tenant (PR #75 #C2)', async () => {
    const sharedPhone = '+5511999990123';

    await runWithTenantContext(
      { tenant_id: 't-a', agent_id: 'agent-a' },
      async () => {
        await pessoasRepo.create({
          nome: 'Pessoa A',
          telefone_whatsapp: sharedPhone,
          tipo: 'funcionario',
          email: null,
          cpf: null,
          status: 'ativa',
          preferencias: {},
          metadata: {},
        } as Parameters<typeof pessoasRepo.create>[0]);
      },
    );

    // Tenant B searches for the SAME phone — must NOT see Tenant A's pessoa.
    const seenByB = await runWithTenantContext(
      { tenant_id: 't-b', agent_id: 'agent-b' },
      () => pessoasRepo.findByPhone(sharedPhone),
    );
    expect(seenByB).toBeNull();

    // Tenant A still sees their own row.
    const seenByA = await runWithTenantContext(
      { tenant_id: 't-a', agent_id: 'agent-a' },
      () => pessoasRepo.findByPhone(sharedPhone),
    );
    expect(seenByA).not.toBeNull();
    expect(seenByA?.tenant_id).toBe('t-a');
  });

  it('pessoasRepo.findByPhone outside any tenant context throws', async () => {
    await expect(pessoasRepo.findByPhone('+5511999990123')).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
  });
});
