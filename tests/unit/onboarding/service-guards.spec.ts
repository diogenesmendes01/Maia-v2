/**
 * Issue #519 — as guardas do SERVIÇO da saga.
 *
 * O que estes testes travam:
 *   - "Outro tenant não descobre, abre ou muta a run": a resposta é
 *     `run_not_found`, NUNCA `forbidden` — a diferença entre as duas é
 *     exatamente o oráculo que permitiria enumerar runs alheias;
 *   - papéis de leitura (viewer/analyst/compliance_officer) não operam o wizard;
 *   - o replay de um passo já concluído NÃO reexecuta o efeito;
 *   - a ativação exige confirmação do par exato e reavalia a prontidão DENTRO
 *     da transição — um laudo verde lido antes não basta;
 *   - a run é devolvida de `activating` para `readiness_failed` quando a
 *     reavaliação bloqueia (o runbook procura por runs presas em `activating`).
 *
 * O barrel de repositórios é mockado inteiro: o alvo aqui é a orquestração,
 * não o SQL.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  run: null as Record<string, unknown> | null,
  claim: null as Record<string, unknown> | null,
  readiness: null as Record<string, unknown> | null,
  beginActivation: null as Record<string, unknown> | null,
  finishActivation: null as Record<string, unknown> | null,
  calls: [] as string[],
}));

vi.mock('@/db/repositories.js', () => ({
  hashOpaque: (v: string) => `h:${v}`,
  hashPayload: (v: unknown) => `p:${JSON.stringify(v)}`,
  onboardingRepo: {
    getForActor: async () => state.run,
    getById: async () => state.run,
    createRun: async () => ({ ok: true, run: state.run }),
    expireStaleRuns: async () => [],
    claimStep: async () => {
      state.calls.push('claimStep');
      return state.claim;
    },
    completeStep: async () => {
      state.calls.push('completeStep');
      return { ok: true, run: state.run };
    },
    failStep: async () => {
      state.calls.push('failStep');
    },
    transitionRun: async () => {
      state.calls.push('transitionRun');
      return { ok: true, run: state.run };
    },
    beginActivation: async () => {
      state.calls.push('beginActivation');
      return state.beginActivation;
    },
    finishActivation: async () => {
      state.calls.push('finishActivation');
      return state.finishActivation;
    },
    abortActivation: async () => {
      state.calls.push('abortActivation');
    },
    cancelRun: async () => ({ ok: true, run: state.run }),
    listForActor: async () => (state.run ? [state.run] : []),
  },
  tenantsRepo: { findById: async () => null, createWithAuditAtomic: async () => ({ ok: true }) },
  agentsRepo: { findById: async () => null, createWithSeedAndAudit: async () => ({ ok: true }) },
  appUsersRepo: { getByEmail: async () => null, create: async () => ({ id: 'u1' }) },
  agentToolGrantsRepo: { upsertForCurrentAgent: async () => ({ id: 'g1' }) },
  channelsRepo: { createWithAudit: async () => ({ ok: true }) },
  channelPoliciesRepo: { getByChannelId: async () => null, create: async () => ({ id: 'p1' }) },
  channelLineStateRepo: {
    listLinesForScope: async () => [],
    requestCommandWithAudit: async () => ({ ok: true }),
  },
  rolesRepo: { getDefault: async () => null, getByKey: async () => null, createWithAudit: async () => ({ ok: true }) },
  operationalProfileVersionsRepo: {
    getActive: async () => null,
    listByStatus: async () => [],
    approveAndActivateAtomic: async () => ({ ok: true }),
  },
  bootstrapCredentialsRepo: {
    consume: async () => ({ ok: true }),
    revokeLive: async () => 0,
    hasLiveCredential: async () => false,
  },
}));

vi.mock('@/onboarding/readiness.js', async () => {
  const actual = await vi.importActual<typeof import('@/onboarding/readiness.js')>(
    '@/onboarding/readiness.js',
  );
  return {
    ...actual,
    evaluateAgentReadiness: async () => state.readiness,
  };
});

import { OnboardingError } from '@/onboarding/state-machine.js';
import { cancelRun, executeStep, getRun } from '@/onboarding/service.js';

const OWNER = { user_id: 'u1', role: 'owner', tenant_id: 'acme', is_founder: false };
const FOUNDER = { user_id: 'u0', role: 'founder', tenant_id: 'home', is_founder: true };

function makeRun(over: Record<string, unknown> = {}) {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    kind: 'tenant_onboarding',
    tenant_id: 'acme',
    agent_id: 'atendimento',
    actor_tenant_id: 'acme',
    state: 'ready_for_activation',
    current_step: 'activation',
    version: 7,
    created_by: 'u1',
    created_by_role: 'owner',
    correlation_id: 'corr-1',
    created_at: new Date('2026-07-01T00:00:00Z'),
    updated_at: new Date('2026-07-01T00:00:00Z'),
    completed_at: null,
    cancelled_at: null,
    expires_at: new Date('2099-01-01T00:00:00Z'),
    last_error_code: null,
    metadata: {},
    ...over,
  };
}

function readiness(ready: boolean, blocking: string[] = []) {
  return {
    tenant_id: 'acme',
    agent_id: 'atendimento',
    ready,
    checks: blocking.map((code) => ({
      code,
      status: 'fail' as const,
      severity: 'blocking' as const,
      message: 'bloqueado',
      remediation: 'corrija',
    })),
    evaluated_at: new Date('2026-07-01T00:00:00Z'),
    configuration_fingerprint: 'cfg',
    schema_fingerprint: 'sch',
  };
}

beforeEach(() => {
  state.run = makeRun();
  state.claim = { ok: true, outcome: 'claimed', run: state.run, to_state: 'active', next_step: 'done' };
  state.readiness = readiness(true);
  state.beginActivation = { ok: true, run: makeRun({ state: 'activating', version: 8 }) };
  state.finishActivation = {
    ok: true,
    run: makeRun({ state: 'active', version: 9, completed_at: new Date('2026-07-01T01:00:00Z') }),
  };
  state.calls = [];
});

describe('issue #519 — guardas do serviço de onboarding', () => {
  describe('isolamento', () => {
    it('run de OUTRO tenant não existe para um owner (nunca FORBIDDEN)', async () => {
      state.run = makeRun({ tenant_id: 'outro', actor_tenant_id: 'outro' });
      await expect(getRun(OWNER, state.run.id as string)).rejects.toMatchObject({
        code: 'run_not_found',
      });
    });

    it('founder atravessa tenants (mesmo privilégio de `founderProcedure`)', async () => {
      state.run = makeRun({ tenant_id: 'outro', actor_tenant_id: 'outro' });
      const view = await getRun(FOUNDER, state.run.id as string);
      expect(view.tenant_id).toBe('outro');
    });

    it('o operador enxerga a run que ELE abriu mesmo antes de o tenant alvo existir', async () => {
      // Uma run recém-aberta ainda não tem `tenant_id`; o vínculo é o
      // `actor_tenant_id`. Sem isso, a run sumiria do próprio dono.
      state.run = makeRun({ tenant_id: null, actor_tenant_id: 'acme', state: 'created' });
      const view = await getRun(OWNER, state.run.id as string);
      expect(view.tenant_id).toBeNull();
    });

    it('papel de leitura não opera o wizard', async () => {
      for (const role of ['viewer', 'analyst', 'compliance_officer']) {
        await expect(
          getRun({ user_id: 'u9', role, tenant_id: 'acme', is_founder: false }, 'x'),
        ).rejects.toMatchObject({ code: 'forbidden_role' });
      }
    });
  });

  describe('idempotência', () => {
    it('replay de um passo concluído NÃO reexecuta o efeito', async () => {
      state.run = makeRun({ state: 'policy_ready', current_step: 'channel', version: 5 });
      state.claim = { ok: true, outcome: 'replay', run: state.run, result: { role_id: 'r1' } };
      await executeStep(OWNER, {
        run_id: state.run.id as string,
        step: 'role',
        expected_version: 5,
        idempotency_key: 'k-1',
        payload: {},
      });
      expect(state.calls).toContain('claimStep');
      expect(state.calls).not.toContain('completeStep');
    });

    it('mesma chave com payload divergente vira erro tipado, não resultado antigo', async () => {
      state.run = makeRun({ state: 'capabilities_ready', current_step: 'role', version: 5 });
      state.claim = { ok: false, reason: 'idempotency_payload_mismatch', run: state.run };
      await expect(
        executeStep(OWNER, {
          run_id: state.run.id as string,
          step: 'role',
          expected_version: 5,
          idempotency_key: 'k-1',
          payload: { role_key: 'outro' },
        }),
      ).rejects.toMatchObject({ code: 'idempotency_payload_mismatch' });
    });

    it('conflito de versão (dois operadores) é tipado e repetível', async () => {
      state.run = makeRun({ state: 'capabilities_ready', current_step: 'role', version: 5 });
      state.claim = { ok: false, reason: 'version_conflict', run: state.run };
      const err = await executeStep(OWNER, {
        run_id: state.run.id as string,
        step: 'role',
        expected_version: 4,
        idempotency_key: 'k-1',
        payload: {},
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OnboardingError);
      expect((err as OnboardingError).code).toBe('version_conflict');
      expect((err as OnboardingError).retryable).toBe(true);
    });
  });

  describe('ativação fail-closed', () => {
    const activationPayload = {
      confirm_tenant_id: 'acme',
      confirm_agent_id: 'atendimento',
      comment: 'colocar no ar após validação',
    };

    it('ativa quando a reavaliação continua verde', async () => {
      const view = await executeStep(OWNER, {
        run_id: state.run!.id as string,
        step: 'activation',
        expected_version: 7,
        idempotency_key: 'k-act',
        payload: activationPayload,
      });
      expect(state.calls).toEqual(['beginActivation', 'finishActivation']);
      expect(view.state).toBe('active');
    });

    it('recusa quando o par confirmado diverge do da run — antes de tocar no banco', async () => {
      await expect(
        executeStep(OWNER, {
          run_id: state.run!.id as string,
          step: 'activation',
          expected_version: 7,
          idempotency_key: 'k-act',
          payload: { ...activationPayload, confirm_agent_id: 'outro-agente' },
        }),
      ).rejects.toMatchObject({ code: 'scope_mismatch' });
      expect(state.calls).toEqual([]);
    });

    it('reavalia DENTRO da ativação: laudo que virou vermelho aborta e devolve a run', async () => {
      // O cenário real: a política foi alterada entre a avaliação e o clique.
      state.readiness = readiness(false, ['channel_policy_resolved']);
      await expect(
        executeStep(OWNER, {
          run_id: state.run!.id as string,
          step: 'activation',
          expected_version: 7,
          idempotency_key: 'k-act',
          payload: activationPayload,
        }),
      ).rejects.toMatchObject({ code: 'readiness_blocked' });
      expect(state.calls).toEqual(['beginActivation', 'abortActivation']);
      expect(state.calls).not.toContain('finishActivation');
    });

    it('run que não passou por prontidão verde não entra em ativação', async () => {
      state.beginActivation = { ok: false, reason: 'not_ready' };
      await expect(
        executeStep(OWNER, {
          run_id: state.run!.id as string,
          step: 'activation',
          expected_version: 7,
          idempotency_key: 'k-act',
          payload: activationPayload,
        }),
      ).rejects.toMatchObject({ code: 'readiness_blocked' });
      expect(state.calls).not.toContain('finishActivation');
    });

    it('ativação concorrente perdida vira conflito, não sucesso silencioso', async () => {
      state.finishActivation = { ok: false, reason: 'activation_race_lost' };
      await expect(
        executeStep(OWNER, {
          run_id: state.run!.id as string,
          step: 'activation',
          expected_version: 7,
          idempotency_key: 'k-act',
          payload: activationPayload,
        }),
      ).rejects.toMatchObject({ code: 'activation_race_lost' });
    });
  });

  describe('cancelamento', () => {
    it('encerra a sessão de pareamento (recurso efêmero) e conclui a run', async () => {
      state.run = makeRun({
        state: 'pairing_pending',
        current_step: 'pairing',
        metadata: { channel_id: '11111111-1111-4111-8111-111111111111' },
      });
      const view = await cancelRun(OWNER, {
        run_id: state.run.id as string,
        expected_version: 7,
        comment: 'cliente desistiu do provisionamento',
      });
      expect(view.id).toBe(state.run.id);
    });
  });
});
