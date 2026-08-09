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

const { policiesMock, rolesMock, profileMock, ownerMock } = vi.hoisted(() => ({
  policiesMock: { getByChannelId: vi.fn() },
  rolesMock: { getById: vi.fn() },
  profileMock: { getActive: vi.fn() },
  ownerMock: vi.fn(),
}));

vi.mock('../../../src/db/repositories/channel-repos.js', () => ({
  channelPoliciesRepo: policiesMock,
  rolesRepo: rolesMock,
}));
vi.mock('../../../src/db/repositories/profile-repos.js', () => ({
  operationalProfileVersionsRepo: profileMock,
}));
// Re-review do PR #541, achado 1 — a precondição ZERO do gate.
vi.mock('../../../src/setup/line-activation-owner.js', () => ({
  resolveLineActivationOwner: ownerMock,
}));

import { evaluateLineReadiness } from '../../../src/setup/line-readiness.js';
import { tryGetCurrentContext } from '../../../src/db/tenant-context.js';

const CHANNEL = { id: 'ch-1', tenant_id: 'tenant-A', agent_id: 'agent-a' };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: agente com perfil operacional ativo — os casos legados de
  // política/papel isolam a variável que estão testando.
  profileMock.getActive.mockResolvedValue({ id: 'prof-1', status: 'active' });
  // Default: nenhuma saga viva — o dono é o pareamento (#518), como sempre foi.
  ownerMock.mockResolvedValue({ owner: 'line_pairing' });
});

describe('evaluateLineReadiness — dono da ativação (re-review do PR #541, achado 1)', () => {
  it('run de onboarding VIVA: não pronta, e nem chega a olhar perfil/política/papel', async () => {
    ownerMock.mockResolvedValue({
      owner: 'onboarding_saga',
      run_id: 'run-1',
      run_state: 'channel_ready',
    });
    policiesMock.getByChannelId.mockResolvedValue({ default_role_id: 'role-1' });
    rolesMock.getById.mockResolvedValue({ id: 'role-1', active: true });

    expect(await evaluateLineReadiness(CHANNEL)).toEqual({
      ready: false,
      reason_code: 'onboarding_saga_owns_activation',
    });
    // Precondição ZERO: a configuração pode estar impecável — a DECISÃO não é
    // desta máquina.
    expect(profileMock.getActive).not.toHaveBeenCalled();
    expect(policiesMock.getByChannelId).not.toHaveBeenCalled();
  });

  it('o dono é resolvido pelo (tenant, agent) DONO do canal', async () => {
    await evaluateLineReadiness(CHANNEL);
    expect(ownerMock).toHaveBeenCalledWith({ tenant_id: 'tenant-A', agent_id: 'agent-a' });
  });

  it('FAIL-CLOSED: se a consulta do dono falhar, a exceção PROPAGA — não vira "pode ativar"', async () => {
    ownerMock.mockRejectedValue(new Error('connection terminated'));
    policiesMock.getByChannelId.mockResolvedValue({ default_role_id: 'role-1' });
    rolesMock.getById.mockResolvedValue({ id: 'role-1', active: true });
    await expect(evaluateLineReadiness(CHANNEL)).rejects.toThrow('connection terminated');
  });
});

describe('evaluateLineReadiness — perfil operacional (rodada 2 do review PR #528)', () => {
  it('agente SEM perfil ativo: não pronta, mesmo com política e papel prontos', async () => {
    profileMock.getActive.mockResolvedValue(null);
    policiesMock.getByChannelId.mockResolvedValue({ default_role_id: 'role-1' });
    rolesMock.getById.mockResolvedValue({ id: 'role-1', active: true });

    expect(await evaluateLineReadiness(CHANNEL)).toEqual({
      ready: false,
      reason_code: 'missing_active_profile',
    });
    // Precondição mais alta na hierarquia: nem consulta a política.
    expect(policiesMock.getByChannelId).not.toHaveBeenCalled();
  });

  it('perfil existente mas com status ≠ active é rejeitado (re-check defensivo)', async () => {
    profileMock.getActive.mockResolvedValue({ id: 'prof-1', status: 'frozen' });
    expect(await evaluateLineReadiness(CHANNEL)).toEqual({
      ready: false,
      reason_code: 'missing_active_profile',
    });
  });

  it('o perfil é lido sob o ALS do (tenant, agent) dono do canal', async () => {
    let seen: { tenant_id: string; agent_id: string } | null = null;
    profileMock.getActive.mockImplementation(async () => {
      const ctx = tryGetCurrentContext();
      seen = ctx ? { tenant_id: ctx.tenant_id, agent_id: ctx.agent_id } : null;
      return null;
    });
    await evaluateLineReadiness(CHANNEL);
    expect(seen).toEqual({ tenant_id: 'tenant-A', agent_id: 'agent-a' });
  });
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
    profileMock.getActive.mockImplementation(async () => {
      const ctx = tryGetCurrentContext();
      seen.push(ctx ? { tenant_id: ctx.tenant_id, agent_id: ctx.agent_id } : null);
      return { id: 'prof-1', status: 'active' };
    });
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
      { tenant_id: 'tenant-A', agent_id: 'agent-a' },
    ]);
  });
});
