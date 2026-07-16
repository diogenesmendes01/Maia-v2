/**
 * Spec perfil-inbox v4 fase C + review PR #499 (risco residual) — o CONTRATO
 * que a aba Versões consome de `proposals.approve` para perfis operacionais.
 *
 * Com o shim `agents.approveProfile` removido, a aba decide pelo endpoint
 * unificado e depende de três comportamentos:
 *   1. risco baixo/médio (classe single): uma assinatura ⇒ `activated` com
 *      `source_transitioned: true` — o modal fecha sem aviso;
 *   2. risco alto (classe dual, aprovadores DISTINTOS): a primeira
 *      assinatura devolve `pending_dual_approval` SEM transicionar — a aba
 *      mostra o aviso de segunda assinatura;
 *   3. falha de guard de predecessor: `profile_transition_failed` vira
 *      CONFLICT com a mensagem de refresh (profileTransitionToTrpcError) —
 *      exibida no modal.
 */
import { describe, it, expect } from 'vitest';
import { proposalsRouter } from '@/admin-ui/trpc/routers/proposals.js';

type Approval = {
  id: string;
  tenant_id: string;
  proposal_id: string;
  approval_class: string;
  approver_user_id: string;
  approver_role: string;
  decision: 'approved' | 'rejected';
  comment: string;
  decided_at: Date;
};

type ProfileProposal = {
  id: string;
  type: 'operational_profile';
  agent_id: string;
  descriptor: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  source: string;
  status: 'proposed' | 'rejected' | 'activated';
  proposed_at: Date;
  proposed_by: string;
  body: unknown;
  locks: string[];
};

/**
 * Mock espelhando o dispatch REAL de decideAtomically para
 * operational_profile (_decideProfileAtomically): dual incompleto insere a
 * approval e NÃO transiciona; gate satisfeito ativa e devolve `profile`;
 * `failTransition` simula o throw do InTx já traduzido para o resultado
 * tipado `profile_transition_failed`.
 */
function makeRepos(proposal: ProfileProposal, opts: { failTransition?: unknown } = {}) {
  const approvals: Approval[] = [];
  const state = { ...proposal };
  return {
    proposalsUnifiedRepo: {
      async getOne(_tenantId: string, id: string) {
        return id === state.id ? { ...state } : null;
      },
      async decideAtomically(input: {
        tenantId: string;
        proposalId: string;
        approvalClass: string;
        actorId: string;
        actorRole: string;
        decision: 'approved' | 'rejected';
        comment: string;
        dualComplete: boolean;
      }) {
        if (opts.failTransition) {
          return {
            ok: false as const,
            reason: 'profile_transition_failed' as const,
            detail: opts.failTransition,
          };
        }
        const approval: Approval = {
          id: `approval-${approvals.length + 1}`,
          tenant_id: input.tenantId,
          proposal_id: input.proposalId,
          approval_class: input.approvalClass,
          approver_user_id: input.actorId,
          approver_role: input.actorRole,
          decision: input.decision,
          comment: input.comment,
          decided_at: new Date(),
        };
        approvals.push(approval);
        let sourceTransitioned = false;
        let profile: unknown;
        if (input.decision === 'approved' && input.dualComplete) {
          state.status = 'activated';
          sourceTransitioned = true;
          profile = {
            activated: { id: state.id, version: 3 },
            frozen_previous: { id: 'prev-uuid', version: 2 },
          };
        }
        return {
          ok: true as const,
          approval,
          sourceTransitioned,
          finalStatus: state.status,
          dualComplete: input.dualComplete,
          profile,
        };
      },
    },
    proposalApprovalsRepo: {
      async listByProposal(proposalId: string) {
        return approvals.filter((a) => a.proposal_id === proposalId);
      },
    },
    adminAuditLogRepo: {
      async append(entry: Record<string, unknown>) {
        return { ...entry, id: 1, created_at: new Date() };
      },
    },
    _inspect: { approvals, state },
  };
}

function callerFor(
  role: string,
  userId: string,
  repos: ReturnType<typeof makeRepos>,
) {
  const ctx = {
    session: { user: { id: userId, role, tenant_id: 'tenant-A' } },
    userId,
    userRole: role,
    tenantId: 'tenant-A',
    repos: repos as unknown as typeof import('@/db/repositories.js'),
    assertTenant: () => {},
    assertRole: () => {},
  };
  return proposalsRouter.createCaller(ctx);
}

const profileProposal = (risk: ProfileProposal['risk']): ProfileProposal => ({
  id: '00000000-0000-4000-8000-0000000000p1'.replace('p', 'a'),
  type: 'operational_profile',
  agent_id: 'agent-x',
  descriptor: 'Perfil operacional v3 — agent-x',
  risk,
  source: 'operational_profile',
  status: 'proposed',
  proposed_at: new Date('2026-07-01'),
  proposed_by: 'system',
  body: {},
  locks: [],
});

describe('proposals.approve — operational_profile (contrato da aba Versões)', () => {
  it('risco baixo (classe single): UMA assinatura ativa — status "activated" com detalhe do profile', async () => {
    const repos = makeRepos(profileProposal('low'));
    const res = await callerFor('owner', 'u-owner', repos).approve({
      id: profileProposal('low').id,
      comment: 'perfil revisado — aprovado',
    });
    expect(res.status).toBe('activated');
    expect(res.dual_required).toBe(false);
    expect(res.source_transitioned).toBe(true);
    expect(repos._inspect.state.status).toBe('activated');
  });

  it('risco alto (classe dual): primeira assinatura ⇒ "pending_dual_approval", NADA transiciona', async () => {
    const repos = makeRepos(profileProposal('high'));
    const res = await callerFor('owner', 'u-owner', repos).approve({
      id: profileProposal('high').id,
      comment: 'primeira assinatura do dual',
    });
    // É este shape que dispara o aviso "Aprovação parcial registrada" na aba.
    expect(res.status).toBe('pending_dual_approval');
    expect(res.dual_required).toBe(true);
    expect(res.dual_complete).toBe(false);
    expect(res.source_transitioned).toBe(false);
    expect(repos._inspect.state.status).toBe('proposed'); // segue proposto
    expect(repos._inspect.approvals).toHaveLength(1); // assinatura registrada
  });

  it('segunda assinatura DISTINTA completa o dual e ativa', async () => {
    const repos = makeRepos(profileProposal('high'));
    const first = await callerFor('owner', 'u-owner', repos).approve({
      id: profileProposal('high').id,
      comment: 'primeira assinatura do dual',
    });
    expect(first.status).toBe('pending_dual_approval');
    const second = await callerFor('founder', 'u-founder', repos).approve({
      id: profileProposal('high').id,
      comment: 'segunda assinatura do dual',
    });
    expect(second.status).toBe('activated');
    expect(second.source_transitioned).toBe(true);
    expect(repos._inspect.state.status).toBe('activated');
  });

  it('guard de predecessor (transition_failed) ⇒ CONFLICT com mensagem de refresh', async () => {
    const repos = makeRepos(profileProposal('low'), {
      failTransition: {
        reason: 'predecessor_conflict',
        expected: 'v2-uuid',
        current: 'v3-uuid',
      },
    });
    await expect(
      callerFor('owner', 'u-owner', repos).approve({
        id: profileProposal('low').id,
        comment: 'aprovação contra predecessor obsoleto',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Refresh and re-propose'),
    });
    // Falha de guard nunca deixa transição parcial visível ao caller.
    expect(repos._inspect.state.status).toBe('proposed');
  });
});
