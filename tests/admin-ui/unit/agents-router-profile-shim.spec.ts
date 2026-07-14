/**
 * Review PR #496 (alto 5) — o shim `agents.approveProfile` (flag
 * FEATURE_PROFILE_INBOX_SOURCE ligada) precisa VINCULAR a versão ao agente
 * do endpoint: o motor unificado é keyed por (tenant, id), então sem a
 * conferência `proposal.agent_id === input.agentId` uma chamada com agente A
 * + versionId do agente B aprovaria B pelo endpoint de A (mesmo tenant) —
 * violando o escopo tenant_id + agent_id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

vi.mock('@/config/env.js', () => ({
  config: { FEATURE_PROFILE_INBOX_SOURCE: true },
}));

import { agentsRouter } from '@/admin-ui/trpc/routers/agents.js';

const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';
const VERSION_OF_B = '00000000-0000-4000-8000-00000000b001';

const getOneMock = vi.fn();
const decideAtomicallyMock = vi.fn();

function makeCtx(role = 'owner') {
  const repos = {
    agentsRepo: {
      async findById(id: string) {
        if (id === AGENT_A || id === AGENT_B) {
          return {
            id,
            tenant_id: 'tenant-A',
            nome: id,
            status: 'active',
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          };
        }
        return null;
      },
    },
    proposalsUnifiedRepo: {
      getOne: getOneMock,
      decideAtomically: decideAtomicallyMock,
    },
  };
  return {
    session: { user: { id: 'u1', role, tenant_id: 'tenant-A' } },
    userId: 'u1',
    userRole: role,
    tenantId: 'tenant-A',
    repos: repos as unknown as typeof import('@/db/repositories.js'),
    assertTenant: () => {},
    assertRole: (...allowed: string[]) => {
      if (!allowed.includes(role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'nope' });
      }
    },
  };
}

function proposalOfB(overrides: Record<string, unknown> = {}) {
  return {
    id: VERSION_OF_B,
    type: 'operational_profile',
    agent_id: AGENT_B,
    descriptor: `Perfil operacional v2 — ${AGENT_B}`,
    risk: 'low',
    source: 'operational_profile',
    status: 'proposed',
    proposed_at: new Date(),
    proposed_by: 'system',
    body: {},
    locks: [],
    ...overrides,
  };
}

beforeEach(() => {
  getOneMock.mockReset();
  decideAtomicallyMock.mockReset();
});

describe('approveProfile (shim flag-on) — vínculo versão ↔ agente', () => {
  it('agente A + versionId do agente B ⇒ NOT_FOUND e NENHUMA decisão disparada', async () => {
    getOneMock.mockResolvedValueOnce(proposalOfB());
    const call = agentsRouter.createCaller(makeCtx()).approveProfile({
      agentId: AGENT_A,
      versionId: VERSION_OF_B,
      comment: 'cross-agent attempt',
    });
    await expect(call).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(decideAtomicallyMock).not.toHaveBeenCalled();
  });

  it('agente CERTO segue aprovando pelo motor unificado', async () => {
    getOneMock.mockResolvedValueOnce(proposalOfB());
    decideAtomicallyMock.mockResolvedValueOnce({
      ok: true,
      decision: 'approved',
      dualComplete: true,
      sourceTransitioned: true,
      profile: { activated: { id: VERSION_OF_B }, frozen_previous: null },
    });
    const res = await agentsRouter.createCaller(makeCtx()).approveProfile({
      agentId: AGENT_B,
      versionId: VERSION_OF_B,
      comment: 'legit approval',
    });
    expect(decideAtomicallyMock).toHaveBeenCalledTimes(1);
    expect(res.source_transitioned).toBe(true);
    expect(res.activated).toEqual({ id: VERSION_OF_B });
  });
});
