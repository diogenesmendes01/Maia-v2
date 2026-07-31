/**
 * Issue #519 — o router `onboarding` do console.
 *
 * O que estes testes travam:
 *   - RBAC: viewer/analyst/compliance_officer recebem FORBIDDEN em TODA
 *     procedure autenticada (provisionar é governança, não leitura);
 *   - a feature flag gateia COMANDOS NOVOS mas NÃO a leitura nem o
 *     cancelamento — é o rollback descrito na issue, não um apagão;
 *   - o bootstrap global é recusado quando a flag está desligada, e o segredo
 *     nunca aparece na mensagem de erro;
 *   - os códigos sanitizados da saga são traduzidos para códigos tRPC
 *     estáveis, e nenhum erro cru atravessa a fronteira;
 *   - `events` passa pela mesma checagem de visibilidade de `get` — sem isso,
 *     seria uma porta lateral para ler a run de outro tenant.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const envMock = vi.hoisted(() => ({
  MAIA_ONBOARDING_WIZARD: true,
  MAIA_ONBOARDING_BOOTSTRAP: false,
}));

vi.mock('@/admin-ui/lib/env.js', () => ({
  getEnv: () => envMock,
}));

const serviceMock = vi.hoisted(() => ({
  startRun: vi.fn(),
  executeStep: vi.fn(),
  cancelRun: vi.fn(),
  getRun: vi.fn(),
  listRuns: vi.fn(),
  bootstrapGlobal: vi.fn(),
}));

vi.mock('@/onboarding/service.js', () => serviceMock);

vi.mock('@/onboarding/readiness.js', async () => {
  const actual = await vi.importActual<typeof import('@/onboarding/readiness.js')>(
    '@/onboarding/readiness.js',
  );
  return { ...actual, evaluateAgentReadiness: vi.fn(async () => ({ ready: true, checks: [] })) };
});

import { onboardingRouter } from '@/admin-ui/trpc/routers/onboarding.js';
import { _resetRateLimitForTests } from '@/admin-ui/trpc/rate-limit.js';
import { OnboardingError } from '@/onboarding/state-machine.js';

const RUN_ID = '99999999-9999-4999-8999-999999999999';

function makeCtx(role: string) {
  return {
    session: { user: { id: 'user-1', role, tenant_id: 'tenant-A' } },
    userId: 'user-1',
    userRole: role,
    tenantId: 'tenant-A',
    repos: {
      onboardingRepo: {
        async listEvents() {
          return [
            {
              id: 1,
              step: 'tenant',
              event_type: 'completed',
              from_state: 'created',
              to_state: 'tenant_ready',
              actor_id: 'user-1',
              actor_role: role,
              error_code: null,
              summary: {},
              created_at: new Date('2026-07-01T00:00:00Z'),
            },
          ];
        },
      },
      appUsersRepo: { async hasAnyUser() { return false; } },
      bootstrapCredentialsRepo: { async hasLiveCredential() { return true; } },
    } as unknown as typeof import('@/db/repositories.js'),
    assertTenant(input_tenant: string) {
      if (role === 'founder') return;
      if (input_tenant !== 'tenant-A') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Tenant isolation violation' });
      }
    },
    assertRole(...allowed: string[]) {
      if (!allowed.includes(role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: `Role ${role} not allowed` });
      }
    },
  };
}

function caller(role: string) {
  return onboardingRouter.createCaller(makeCtx(role) as never);
}

const RUN_VIEW = {
  id: RUN_ID,
  kind: 'tenant_onboarding',
  state: 'created',
  current_step: 'tenant',
  version: 0,
  tenant_id: null,
  agent_id: null,
  allowed_steps: ['tenant'],
  metadata: {},
  readiness: null,
};

beforeEach(() => {
  _resetRateLimitForTests();
  envMock.MAIA_ONBOARDING_WIZARD = true;
  envMock.MAIA_ONBOARDING_BOOTSTRAP = false;
  serviceMock.startRun.mockReset().mockResolvedValue(RUN_VIEW);
  serviceMock.executeStep.mockReset().mockResolvedValue(RUN_VIEW);
  serviceMock.cancelRun.mockReset().mockResolvedValue(RUN_VIEW);
  serviceMock.getRun.mockReset().mockResolvedValue(RUN_VIEW);
  serviceMock.listRuns.mockReset().mockResolvedValue([RUN_VIEW]);
  serviceMock.bootstrapGlobal.mockReset().mockResolvedValue(RUN_VIEW);
});

describe('issue #519 — router onboarding', () => {
  describe('RBAC', () => {
    for (const role of ['viewer', 'analyst', 'compliance_officer']) {
      it(`${role} não lê nem opera o wizard`, async () => {
        const c = caller(role);
        await expect(c.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(c.get({ runId: RUN_ID })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(c.start({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          c.submitStep({
            runId: RUN_ID,
            step: 'tenant',
            expectedVersion: 0,
            idempotencyKey: 'chave-de-teste',
            payload: {},
          }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          c.cancel({ runId: RUN_ID, expectedVersion: 0, comment: 'cancelando o teste' }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      });
    }

    it('owner opera normalmente', async () => {
      const run = await caller('owner').start({});
      expect(run.id).toBe(RUN_ID);
      expect(serviceMock.startRun).toHaveBeenCalledTimes(1);
    });
  });

  describe('feature flag', () => {
    it('desligada, recusa comandos NOVOS', async () => {
      envMock.MAIA_ONBOARDING_WIZARD = false;
      const c = caller('owner');
      await expect(c.start({})).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await expect(
        c.submitStep({
          runId: RUN_ID,
          step: 'tenant',
          expectedVersion: 0,
          idempotencyKey: 'chave-de-teste',
          payload: {},
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    });

    it('desligada, a LEITURA e o CANCELAMENTO continuam funcionando', async () => {
      // Rollback é "impedir novas runs, manter leitura/diagnóstico das
      // existentes" — não apagar a superfície.
      envMock.MAIA_ONBOARDING_WIZARD = false;
      const c = caller('owner');
      await expect(c.list({})).resolves.toMatchObject({ runs: [RUN_VIEW] });
      await expect(c.get({ runId: RUN_ID })).resolves.toMatchObject({ id: RUN_ID });
      await expect(
        c.cancel({ runId: RUN_ID, expectedVersion: 0, comment: 'encerrando durante rollback' }),
      ).resolves.toMatchObject({ id: RUN_ID });
    });
  });

  describe('tradução de erros', () => {
    it('mapeia cada código sanitizado para um código tRPC estável', async () => {
      const cases: Array<[string, string]> = [
        ['run_not_found', 'NOT_FOUND'],
        ['version_conflict', 'CONFLICT'],
        ['idempotency_payload_mismatch', 'CONFLICT'],
        ['step_out_of_order', 'BAD_REQUEST'],
        ['readiness_blocked', 'PRECONDITION_FAILED'],
        ['forbidden_role', 'FORBIDDEN'],
        ['scope_mismatch', 'BAD_REQUEST'],
      ];
      for (const [code, expected] of cases) {
        serviceMock.executeStep.mockRejectedValueOnce(
          new OnboardingError(code as never, 'mensagem para o operador'),
        );
        await expect(
          caller('owner').submitStep({
            runId: RUN_ID,
            step: 'tenant',
            expectedVersion: 0,
            idempotencyKey: 'chave-de-teste',
            payload: {},
          }),
        ).rejects.toMatchObject({ code: expected });
      }
    });

    it('erro CRU nunca atravessa a fronteira', async () => {
      serviceMock.executeStep.mockRejectedValueOnce(
        new Error('duplicate key value violates unique constraint "agents_pkey"'),
      );
      const err = await caller('owner')
        .submitStep({
          runId: RUN_ID,
          step: 'agent',
          expectedVersion: 0,
          idempotencyKey: 'chave-de-teste',
          payload: {},
        })
        .catch((e: unknown) => e as TRPCError);
      expect(err.code).toBe('INTERNAL_SERVER_ERROR');
      expect(err.message).not.toContain('agents_pkey');
    });
  });

  describe('eventos', () => {
    it('exige a mesma visibilidade de `get` antes de devolver a linha do tempo', async () => {
      serviceMock.getRun.mockRejectedValueOnce(
        new OnboardingError('run_not_found', 'Run de onboarding não encontrada.', false),
      );
      await expect(caller('owner').events({ runId: RUN_ID })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('devolve os eventos quando a run é visível', async () => {
      const res = await caller('owner').events({ runId: RUN_ID });
      expect(res.events).toHaveLength(1);
      expect(res.events[0]?.event_type).toBe('completed');
    });
  });

  describe('bootstrap global', () => {
    const input = {
      secret: 'x'.repeat(64),
      tenantId: 'acme',
      tenantNome: 'Acme',
      adminEmail: 'operador@acme.com',
      adminName: 'Operador',
    };

    it('é recusado quando a flag está desligada', async () => {
      envMock.MAIA_ONBOARDING_BOOTSTRAP = false;
      await expect(caller('owner').bootstrapGlobal(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(serviceMock.bootstrapGlobal).not.toHaveBeenCalled();
    });

    it('com a flag ligada, delega ao serviço e NUNCA ecoa o segredo', async () => {
      envMock.MAIA_ONBOARDING_BOOTSTRAP = true;
      serviceMock.bootstrapGlobal.mockRejectedValueOnce(
        new OnboardingError('bootstrap_credential_invalid', 'Credencial inválida.', false),
      );
      const err = await caller('owner')
        .bootstrapGlobal(input)
        .catch((e: unknown) => e as TRPCError);
      expect(err.code).toBe('UNAUTHORIZED');
      expect(err.message).not.toContain(input.secret);
      // O serviço recebe o segredo no CORPO, não em query string.
      expect(serviceMock.bootstrapGlobal).toHaveBeenCalledWith(
        expect.objectContaining({ secret: input.secret, tenant_id: 'acme' }),
        expect.anything(),
      );
    });

    it('bootstrapStatus não exige sessão e não devolve segredo', async () => {
      envMock.MAIA_ONBOARDING_BOOTSTRAP = true;
      const status = await caller('viewer').bootstrapStatus();
      expect(status).toEqual({ open: true, reason: 'ready' });
    });

    it('bootstrapStatus fecha quando já existe identidade administrativa', async () => {
      envMock.MAIA_ONBOARDING_BOOTSTRAP = true;
      const ctx = makeCtx('viewer');
      (ctx.repos as unknown as { appUsersRepo: { hasAnyUser: () => Promise<boolean> } }).appUsersRepo.hasAnyUser =
        async () => true;
      const status = await onboardingRouter.createCaller(ctx as never).bootstrapStatus();
      expect(status).toEqual({ open: false, reason: 'already_bootstrapped' });
    });
  });
});
