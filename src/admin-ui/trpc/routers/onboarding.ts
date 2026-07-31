/**
 * Admin UI — wizard de onboarding persistido (issue #519).
 *
 * Contrato de segurança de cada procedure:
 *   - sessão NextAuth obrigatória, EXCETO nas duas de bootstrap global (que
 *     existem justamente para o momento em que ainda não há a quem autenticar);
 *   - papel `owner|founder` — provisionar tenant/agente/canal é operação de
 *     governança, não leitura;
 *   - o tenant vem da SESSÃO. O `tenantId` do body é aceito só de founder, pelo
 *     mesmo `resolveTenantId` que todo o console usa;
 *   - uma run de outro tenant NÃO EXISTE (NOT_FOUND, nunca FORBIDDEN): a
 *     diferença entre as duas respostas é justamente o que permite descobrir a
 *     existência de recursos alheios;
 *   - toda mutação é rate-limited e auditada com o ATOR administrativo;
 *   - o SEGREDO de bootstrap viaja no CORPO de um POST. tRPC serializa
 *     mutations no body, então ele nunca aparece em query string, histórico de
 *     navegador, referer ou access log.
 *
 * Flag `MAIA_ONBOARDING_WIZARD` (contrato #515, default OFF): desligada,
 * comandos NOVOS são recusados e as runs existentes continuam LEGÍVEIS — é o
 * rollback que a issue descreve, não um apagão.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, publicProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { assertRateLimit } from '../rate-limit.js';
import { getEnv } from '../../lib/env.js';
import {
  bootstrapGlobal,
  cancelRun,
  executeStep,
  getRun,
  listRuns,
  startRun,
  type OnboardingActor,
} from '../../../onboarding/service.js';
import { OnboardingError, type OnboardingErrorCode } from '../../../onboarding/state-machine.js';
import { StepSchema } from '../../../onboarding/commands.js';
import { evaluateAgentReadiness } from '../../../onboarding/readiness.js';

/** Limites: provisionar abre transações e cria recurso — poucos, por usuário. */
const MUTATION_RULE = { max: 60, windowMs: 5 * 60_000 };
const READ_RULE = { max: 240, windowMs: 60_000 };
/**
 * O bootstrap é a superfície NÃO autenticada. O limite é por processo (não há
 * usuário a que atribuir), e propositalmente apertado: junto com o lockout
 * persistido da credencial, fecha a força bruta pelos dois lados.
 */
const BOOTSTRAP_RULE = { max: 10, windowMs: 15 * 60_000 };

const ONBOARDING_ERROR_TO_TRPC: Record<OnboardingErrorCode, TRPCError['code']> = {
  run_not_found: 'NOT_FOUND',
  run_terminal: 'CONFLICT',
  run_expired: 'CONFLICT',
  step_out_of_order: 'BAD_REQUEST',
  kind_not_allowed: 'BAD_REQUEST',
  version_conflict: 'CONFLICT',
  idempotency_payload_mismatch: 'CONFLICT',
  scope_mismatch: 'BAD_REQUEST',
  forbidden_role: 'FORBIDDEN',
  tenant_not_found: 'NOT_FOUND',
  tenant_suspended: 'PRECONDITION_FAILED',
  tenant_duplicate: 'CONFLICT',
  admin_duplicate: 'CONFLICT',
  agent_duplicate: 'CONFLICT',
  agent_not_found: 'NOT_FOUND',
  profile_not_found: 'NOT_FOUND',
  profile_approval_failed: 'CONFLICT',
  role_conflict: 'CONFLICT',
  channel_conflict: 'CONFLICT',
  channel_invalid_line: 'BAD_REQUEST',
  pairing_unavailable: 'PRECONDITION_FAILED',
  pairing_in_progress: 'CONFLICT',
  line_not_verified: 'PRECONDITION_FAILED',
  readiness_blocked: 'PRECONDITION_FAILED',
  activation_race_lost: 'CONFLICT',
  bootstrap_not_allowed: 'FORBIDDEN',
  bootstrap_credential_invalid: 'UNAUTHORIZED',
  bootstrap_credential_locked: 'TOO_MANY_REQUESTS',
  wizard_disabled: 'PRECONDITION_FAILED',
  internal_error: 'INTERNAL_SERVER_ERROR',
};

/**
 * Traduz a falha da saga. O `code` é sanitizado por construção
 * (`ONBOARDING_ERROR_CODES`) e a mensagem é escrita para o operador — nenhum
 * erro cru de banco atravessa esta fronteira.
 */
function toTRPC(err: unknown): never {
  if (err instanceof OnboardingError) {
    throw new TRPCError({
      code: ONBOARDING_ERROR_TO_TRPC[err.code] ?? 'BAD_REQUEST',
      message: err.message,
      cause: err,
    });
  }
  if (err instanceof TRPCError) throw err;
  if (err instanceof z.ZodError) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: err.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
    });
  }
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Falha interna no onboarding.' });
}

interface ActorCtx {
  userId: string;
  userRole: string;
  tenantId: string;
}

function actorOf(ctx: ActorCtx): OnboardingActor {
  return {
    user_id: ctx.userId,
    role: ctx.userRole,
    tenant_id: ctx.tenantId,
    is_founder: ctx.userRole === 'founder',
  };
}

/** Comandos NOVOS exigem a flag. Leitura nunca — rollback não é apagão. */
function assertWizardEnabled(): void {
  if (getEnv().MAIA_ONBOARDING_WIZARD !== true) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'O wizard de onboarding está desligado (MAIA_ONBOARDING_WIZARD=false). ' +
        'Runs existentes continuam legíveis; para operar, habilite a flag e reinicie o serviço.',
    });
  }
}

const StartInputSchema = z.object({
  /** Tenant alvo já existente. Omitido ⇒ a run cria o tenant no passo 1. */
  tenantId: z.string().optional(),
  label: z.string().min(1).max(200).optional(),
});

const StepInputSchema = z.object({
  runId: z.string().uuid(),
  step: StepSchema,
  expectedVersion: z.number().int().min(0),
  /**
   * Chave OPACA da tentativa. O cliente DEVE conservá-la até obter resultado
   * conclusivo — é o que faz o retry após timeout devolver o resultado
   * anterior em vez de provisionar duas vezes.
   */
  idempotencyKey: z.string().min(8).max(200),
  payload: z.unknown(),
});

const CancelInputSchema = z.object({
  runId: z.string().uuid(),
  expectedVersion: z.number().int().min(0),
  comment: z.string().min(10).max(1000),
});

const ReadinessInputSchema = z.object({
  tenantId: z.string().optional(),
  agentId: z.string(),
});

const BootstrapInputSchema = z.object({
  /** SEGREDO — corpo do POST, nunca URL. Nada dele entra em log/auditoria. */
  secret: z.string().min(32).max(512),
  tenantId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  tenantNome: z.string().min(1).max(200),
  adminEmail: z.string().email().max(320),
  adminName: z.string().min(1).max(200),
});

export const onboardingRouter = router({
  /** Runs do PRÓPRIO tenant (founder enxerga todas). */
  list: protectedProcedure
    .input(z.object({ includeTerminal: z.boolean().optional() }).optional())
    .query(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      assertRateLimit(`onboarding:list:${ctx.userId}`, READ_RULE);
      try {
        return { runs: await listRuns(actorOf(ctx), input?.includeTerminal ?? false) };
      } catch (err) {
        toTRPC(err);
      }
    }),

  /**
   * Detalhe da run + laudo de readiness. É esta resposta que a tela usa para
   * saber o que está habilitado — o backend é a fonte de verdade, a UI só
   * renderiza `allowed_steps`.
   */
  get: protectedProcedure
    .input(z.object({ runId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      assertRateLimit(`onboarding:get:${ctx.userId}`, READ_RULE);
      try {
        return await getRun(actorOf(ctx), input.runId);
      } catch (err) {
        toTRPC(err);
      }
    }),

  /** Linha do tempo da run (append-only). Nenhum segredo entra nos eventos. */
  events: protectedProcedure
    .input(z.object({ runId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      assertRateLimit(`onboarding:events:${ctx.userId}`, READ_RULE);
      try {
        // A visibilidade é checada primeiro: sem isto, os eventos seriam uma
        // porta lateral para ler a run de outro tenant.
        await getRun(actorOf(ctx), input.runId);
        const events = await ctx.repos.onboardingRepo.listEvents(input.runId);
        return {
          events: events.map((e) => ({
            id: e.id,
            step: e.step,
            event_type: e.event_type,
            from_state: e.from_state,
            to_state: e.to_state,
            actor_id: e.actor_id,
            actor_role: e.actor_role,
            error_code: e.error_code,
            summary: e.summary,
            created_at: e.created_at,
          })),
        };
      } catch (err) {
        toTRPC(err);
      }
    }),

  start: protectedProcedure.input(StartInputSchema).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    assertWizardEnabled();
    assertRateLimit(`onboarding:start:${ctx.userId}`, MUTATION_RULE);
    // `resolveTenantId` só é aplicado quando o operador declara um tenant
    // alvo: uma run que ainda VAI criar o tenant não tem alvo a validar.
    const tenantId = input.tenantId ? resolveTenantId(ctx, input.tenantId) : null;
    try {
      return await startRun(actorOf(ctx), {
        tenant_id: tenantId,
        metadata: input.label ? { label: input.label } : {},
      });
    } catch (err) {
      toTRPC(err);
    }
  }),

  /**
   * Executa um passo. O backend decide tudo: precondição, transição, efeito e
   * auditoria. A UI apenas PROPÕE — mandar `step` fora de ordem devolve erro
   * tipado, nunca um avanço silencioso.
   */
  submitStep: protectedProcedure.input(StepInputSchema).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    assertWizardEnabled();
    assertRateLimit(`onboarding:step:${ctx.userId}`, MUTATION_RULE);
    try {
      return await executeStep(actorOf(ctx), {
        run_id: input.runId,
        step: input.step,
        expected_version: input.expectedVersion,
        idempotency_key: input.idempotencyKey,
        payload: input.payload,
      });
    } catch (err) {
      toTRPC(err);
    }
  }),

  cancel: protectedProcedure.input(CancelInputSchema).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    // Cancelar NÃO exige a flag: com o wizard desligado, o operador ainda
    // precisa conseguir encerrar uma run pendente.
    assertRateLimit(`onboarding:cancel:${ctx.userId}`, MUTATION_RULE);
    try {
      return await cancelRun(actorOf(ctx), {
        run_id: input.runId,
        expected_version: input.expectedVersion,
        comment: input.comment,
      });
    } catch (err) {
      toTRPC(err);
    }
  }),

  /**
   * Readiness canônico de um par (tenant, agente), fora de qualquer run.
   *
   * É a MESMA função que o wizard e a ativação usam. Dashboard e checklist
   * consomem daqui em vez de recalcular sinais próprios — era exatamente a
   * divergência que produzia o falso positivo de "go live".
   */
  readiness: protectedProcedure.input(ReadinessInputSchema).query(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    assertRateLimit(`onboarding:readiness:${ctx.userId}`, READ_RULE);
    const tenantId = resolveTenantId(ctx, input.tenantId);
    return evaluateAgentReadiness(tenantId, input.agentId);
  }),

  /**
   * A instalação ainda aceita bootstrap global? Resposta BINÁRIA e sem
   * segredo: a tela precisa saber se mostra o formulário ou manda o operador
   * fazer login.
   */
  bootstrapStatus: publicProcedure.query(async ({ ctx }) => {
    const enabled = getEnv().MAIA_ONBOARDING_BOOTSTRAP === true;
    if (!enabled) return { open: false as const, reason: 'disabled' as const };
    const hasUser = await ctx.repos.appUsersRepo.hasAnyUser();
    if (hasUser) return { open: false as const, reason: 'already_bootstrapped' as const };
    const hasCredential = await ctx.repos.bootstrapCredentialsRepo.hasLiveCredential();
    return hasCredential
      ? { open: true as const, reason: 'ready' as const }
      : { open: false as const, reason: 'no_credential' as const };
  }),

  /**
   * BOOTSTRAP GLOBAL — cria o primeiro tenant e o primeiro administrador sem
   * `psql`. `publicProcedure` de propósito: é a única operação do sistema que
   * acontece antes de existir alguém a autenticar. O que a protege:
   *
   *   - a flag `MAIA_ONBOARDING_BOOTSTRAP` (default OFF);
   *   - a precondição "nenhum `app_users` existe" — checada no serviço;
   *   - a credencial de uso único, consumida por CAS, com expiração e lockout
   *     PERSISTIDOS (um contador em memória não sobrevive a restart);
   *   - rate limit por processo.
   *
   * Depois do sucesso, a porta fecha por construção: passa a existir um
   * `app_users`, e a precondição nunca mais é satisfeita.
   */
  bootstrapGlobal: publicProcedure.input(BootstrapInputSchema).mutation(async ({ input, ctx }) => {
    if (getEnv().MAIA_ONBOARDING_BOOTSTRAP !== true) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'O bootstrap global está desabilitado nesta instalação.',
      });
    }
    assertRateLimit('onboarding:bootstrap', BOOTSTRAP_RULE);
    try {
      return await bootstrapGlobal(
        {
          secret: input.secret,
          tenant_id: input.tenantId,
          tenant_nome: input.tenantNome,
          admin_email: input.adminEmail,
          admin_name: input.adminName,
        },
        { hasAnyAppUser: () => ctx.repos.appUsersRepo.hasAnyUser() },
      );
    } catch (err) {
      toTRPC(err);
    }
  }),
});
