/**
 * Issue #518 §4 / review PR #528 (P1) — gate de readiness de roteamento.
 *
 * A regra é DETERMINÍSTICA e decidida no backend, não sugerida pela UI. O caso
 * sutil é o papel padrão DESATIVADO: a política existe (`has_policy` é true),
 * mas o canal não tem papel para escolher — não está pronto. Ativar aí seria
 * exatamente a "linha entrando em roteamento sem policy pronta" que o review
 * apontou.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { policiesMock, rolesMock } = vi.hoisted(() => ({
  policiesMock: { getByChannelId: vi.fn() },
  rolesMock: { getById: vi.fn() },
}));

vi.mock('../../../src/db/repositories/channel-repos.js', () => ({
  channelPoliciesRepo: policiesMock,
  rolesRepo: rolesMock,
}));

import { evaluateLineReadiness } from '../../../src/setup/line-readiness.js';
import { tryGetCurrentContext } from '../../../src/db/tenant-context.js';

const CHANNEL = { id: 'ch-1', tenant_id: 'tenant-A', agent_id: 'agent-a' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('evaluateLineReadiness', () => {
  it('sem política: não pronta (missing_policy)', async () => {
    policiesMock.getByChannelId.mockResolvedValue(null);
    expect(await evaluateLineReadiness(CHANNEL)).toEqual({
      ready: false,
      reason_code: 'missing_policy',
    });
    expect(rolesMock.getById).not.toHaveBeenCalled();
  });

  it('política com papel padrão DESATIVADO: não pronta', async () => {
    policiesMock.getByChannelId.mockResolvedValue({ default_role_id: 'role-1' });
    rolesMock.getById.mockResolvedValue({ id: 'role-1', active: false });
    expect(await evaluateLineReadiness(CHANNEL)).toEqual({
      ready: false,
      reason_code: 'default_role_inactive',
    });
  });

  it('política cujo papel padrão sumiu do escopo: não pronta', async () => {
    policiesMock.getByChannelId.mockResolvedValue({ default_role_id: 'role-x' });
    rolesMock.getById.mockResolvedValue(null);
    expect(await evaluateLineReadiness(CHANNEL)).toEqual({
      ready: false,
      reason_code: 'default_role_inactive',
    });
  });

  it('política + papel ativo: pronta', async () => {
    policiesMock.getByChannelId.mockResolvedValue({ default_role_id: 'role-1' });
    rolesMock.getById.mockResolvedValue({ id: 'role-1', active: true });
    expect(await evaluateLineReadiness(CHANNEL)).toEqual({ ready: true });
  });

  it('consulta SEMPRE sob o ALS do (tenant, agent) dono do canal', async () => {
    const seen: Array<{ tenant_id: string; agent_id: string } | null> = [];
    policiesMock.getByChannelId.mockImplementation(async () => {
      const ctx = tryGetCurrentContext();
      seen.push(ctx ? { tenant_id: ctx.tenant_id, agent_id: ctx.agent_id } : null);
      return { default_role_id: 'role-1' };
    });
    rolesMock.getById.mockImplementation(async () => {
      const ctx = tryGetCurrentContext();
      seen.push(ctx ? { tenant_id: ctx.tenant_id, agent_id: ctx.agent_id } : null);
      return { id: 'role-1', active: true };
    });

    await evaluateLineReadiness(CHANNEL);

    // Sem o wrap, os repos tenant-scoped leriam o contexto errado (ou nenhum)
    // e a decisão de ativar sairia de dados de outro escopo.
    expect(seen).toEqual([
      { tenant_id: 'tenant-A', agent_id: 'agent-a' },
      { tenant_id: 'tenant-A', agent_id: 'agent-a' },
    ]);
  });
});
