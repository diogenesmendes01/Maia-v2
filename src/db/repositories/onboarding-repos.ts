/**
 * Issue #519 §2/§3/§4 — persistência da saga de onboarding.
 *
 * `commitStep` é o coração: UMA transação SQL curta que faz, atomicamente,
 * tudo o que um comando do wizard precisa fazer:
 *
 *   1. trava a run (`SELECT … FOR UPDATE`) — serializa operadores concorrentes;
 *   2. confere o token de optimistic concurrency (`version`);
 *   3. consulta o LEDGER de idempotência (replay / conflito de payload);
 *   4. valida a transição CONTRA O ESTADO TRAVADO (não contra um estado lido
 *      antes da transação — isso seria TOCTOU);
 *   5. executa a escrita de provisionamento do passo, no MESMO `tx`;
 *   6. grava o ledger, o evento append-only, a auditoria administrativa e o
 *      novo estado da run — tudo no mesmo `tx`.
 *
 * A consequência de (5)+(6) é a garantia que a issue pede: **se o processo
 * morrer no meio de um passo, nada aconteceu.** Ou o tenant/agente/papel/canal
 * existe E o ledger, o evento, a auditoria e o novo estado existem, ou nada
 * disso existe. Não há estado intermediário que exija inspeção manual do banco.
 *
 * E se ele morrer DEPOIS do commit, antes da resposta? O cliente repete com a
 * MESMA idempotency key, o passo (3) encontra o ledger e devolve o resultado
 * já persistido marcado como replay — sem re-executar a escrita.
 *
 * Auditoria: a trilha atômica vai para `admin_audit_log`, no mesmo `tx`, pelo
 * mesmo motivo (e com o mesmo desenho) de
 * `tenantsRepo.createWithAuditAtomic`/`agentsRepo.createWithSeedAndAudit`.
 * `audit_log` NÃO serve aqui: sua coluna `agent_id` é FK para `agents`, e
 * metade dos passos da saga roda antes de o agente existir. Os eventos
 * agente-escopados que ocorrem DEPOIS da criação do agente (readiness,
 * ativação) também emitem `audit()` pós-commit — ver `wizard.ts`.
 */
import { and, asc, desc, eq, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { TERMINAL_STATES } from '@/onboarding/state-machine.js';
import { db, withTx } from '../client.js';
import {
  admin_audit_log,
  onboarding_events,
  onboarding_runs,
  onboarding_step_results,
} from '../schema.js';
import type { OnboardingEventRow, OnboardingRunRow } from '../schema.js';
import { planTransition, type OnboardingState } from '@/onboarding/state-machine.js';
import { OnboardingError } from '@/onboarding/errors.js';
import { sanitizeForPersistence } from '@/onboarding/sanitize.js';

type Tx = Parameters<Parameters<typeof withTx>[0]>[0];

export type StepApplication = {
  /** Resultado materializado devolvido ao caller e persistido no ledger. */
  result: Record<string, unknown>;
  /** Escopo que o passo acabou de resolver (provision_tenant / provision_agent). */
  scope_patch?: { tenant_id?: string; agent_id?: string };
  /**
   * NEGATIVA de governança — não é exceção, é decisão do backend. A run vai
   * para o estado `onDeny` do passo e NENHUMA linha de ledger é gravada (uma
   * negativa não é um passo concluído: o operador corrige e tenta de novo).
   */
  deny?: { code: string; message: string };
  /** Resumo SANITIZADO para o evento append-only. */
  summary?: Record<string, unknown>;
  /** Ação registrada em `admin_audit_log`, no mesmo `tx`. */
  audit: { action: string; resource_type: string; resource_id: string | null };
  /** `true` no passo que conclui a run (ativação). */
  completes?: boolean;
};

export type CommitStepOutcome =
  | { outcome: 'committed'; run: OnboardingRunRow; result: Record<string, unknown> }
  | { outcome: 'replayed'; run: OnboardingRunRow; result: Record<string, unknown> }
  | { outcome: 'payload_conflict'; run: OnboardingRunRow }
  | { outcome: 'version_conflict'; run: OnboardingRunRow }
  | { outcome: 'invalid_transition'; run: OnboardingRunRow; code: string; message: string }
  | { outcome: 'denied'; run: OnboardingRunRow; code: string; message: string }
  | { outcome: 'not_found' };

export type CommitStepInput = {
  run_id: string;
  /**
   * Escopo do CHAMADOR. `null` só é aceito para runs que ainda não têm tenant
   * (bootstrap global antes de resolvê-lo). Quando presente, entra no `WHERE`
   * do `SELECT … FOR UPDATE`: um operador de outro tenant não consegue nem
   * TRAVAR a run alheia, muito menos avançá-la (`not_found`, indistinguível de
   * "não existe" — descoberta horizontal por id conhecido não é permitida).
   */
  tenant_id: string | null;
  expected_version: number;
  step: string;
  idempotency_key_hash: string;
  payload_hash: string;
  actor_id: string;
  actor_role: string;
  correlation_id: string;
  apply: (tx: Tx, run: OnboardingRunRow) => Promise<StepApplication>;
};

export const onboardingRunsRepo = {
  async create(input: {
    kind: 'global_bootstrap' | 'tenant_onboarding';
    tenant_id: string | null;
    agent_id: string | null;
    created_by: string;
    actor_role: string;
    correlation_id: string;
    expires_at: Date;
    configuration_contract_version: string;
    schema_version: string;
    metadata?: Record<string, unknown>;
  }): Promise<OnboardingRunRow> {
    return withTx(async (tx) => {
      const [run] = await tx
        .insert(onboarding_runs)
        .values({
          kind: input.kind,
          tenant_id: input.tenant_id,
          agent_id: input.agent_id,
          state: 'created',
          version: 1,
          created_by: input.created_by,
          expires_at: input.expires_at,
          metadata: sanitizeForPersistence(input.metadata ?? {}),
          configuration_contract_version: input.configuration_contract_version,
          schema_version: input.schema_version,
        })
        .returning();
      if (!run) throw new OnboardingError('run_not_found', 'INSERT não devolveu a run');

      await tx.insert(onboarding_events).values({
        run_id: run.id,
        tenant_id: run.tenant_id,
        agent_id: run.agent_id,
        step: 'create_run',
        event_type: 'run_created',
        actor_id: input.created_by,
        correlation_id: input.correlation_id,
        from_state: null,
        to_state: 'created',
        summary: sanitizeForPersistence({ kind: input.kind }),
      });

      // `admin_audit_log.tenant_id` é NOT NULL. Uma run de bootstrap global
      // ainda não tem tenant; o bucket reservado `system` é o home sancionado
      // para trabalho sem dono (tenant-context.ts) e é o que usamos aqui.
      await tx.insert(admin_audit_log).values({
        tenant_id: run.tenant_id ?? 'system',
        actor_id: input.created_by,
        actor_role: input.actor_role,
        action: 'onboarding_run_started',
        resource_type: 'onboarding_run',
        resource_id: run.id,
        change_summary: { kind: input.kind, correlation_id: input.correlation_id },
      });

      return run;
    });
  },

  /**
   * Leitura ESCOPADA. `tenant_id` entra no `WHERE`, então um operador de outro
   * tenant recebe `null` para um id que existe — indistinguível de "não
   * existe". Descoberta horizontal por id conhecido é exatamente o que os leak
   * tests da issue cobrem.
   *
   * `tenant_id: null` significa SEM FILTRO e é reservado ao papel global
   * (`founder`) e às runs de bootstrap que ainda não resolveram o tenant. Quem
   * passa `null` é `wizard.ts`, e só depois de provar que o ator é founder —
   * um operador comum com sessão sem tenant é recusado antes de chegar aqui.
   */
  async getForScope(input: {
    run_id: string;
    tenant_id: string | null;
  }): Promise<OnboardingRunRow | null> {
    const rows = await db
      .select()
      .from(onboarding_runs)
      .where(
        input.tenant_id === null
          ? eq(onboarding_runs.id, input.run_id)
          : and(
              eq(onboarding_runs.id, input.run_id),
              eq(onboarding_runs.tenant_id, input.tenant_id),
            ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Runs do tenant do operador, mais recentes primeiro. */
  async listForTenant(input: {
    tenant_id: string;
    include_terminal?: boolean;
    limit?: number;
  }): Promise<OnboardingRunRow[]> {
    return db
      .select()
      .from(onboarding_runs)
      .where(
        input.include_terminal
          ? eq(onboarding_runs.tenant_id, input.tenant_id)
          : and(
              eq(onboarding_runs.tenant_id, input.tenant_id),
              notInArray(onboarding_runs.state, [...TERMINAL_STATES]),
            ),
      )
      .orderBy(desc(onboarding_runs.created_at))
      .limit(input.limit ?? 50);
  },

  /** Histórico append-only de uma run, escopado pelo tenant do operador. */
  async listEvents(input: {
    run_id: string;
    tenant_id: string | null;
    limit?: number;
  }): Promise<OnboardingEventRow[]> {
    const run = await this.getForScope({ run_id: input.run_id, tenant_id: input.tenant_id });
    if (!run) return [];
    return db
      .select()
      .from(onboarding_events)
      .where(eq(onboarding_events.run_id, input.run_id))
      .orderBy(asc(onboarding_events.created_at))
      .limit(input.limit ?? 200);
  },

  async commitStep(input: CommitStepInput): Promise<CommitStepOutcome> {
    return withTx(async (tx) => {
      // (1) Trava a run. O `tenant_id` do CHAMADOR entra no WHERE — sem isso,
      // um operador com o id da run de outro tenant conseguiria avançá-la.
      const lockedRows = await tx
        .select()
        .from(onboarding_runs)
        .where(
          input.tenant_id === null
            ? // Sem filtro: papel global (`founder`) ou run de bootstrap ainda
              // sem tenant. `wizard.ts` só passa `null` depois de provar o papel.
              eq(onboarding_runs.id, input.run_id)
            : // A run que ainda não resolveu o tenant é legítima para o operador
              // que a criou: aceitamos NULL ou o tenant do chamador.
              and(
                eq(onboarding_runs.id, input.run_id),
                or(
                  eq(onboarding_runs.tenant_id, input.tenant_id),
                  isNull(onboarding_runs.tenant_id),
                ),
              ),
        )
        .for('update')
        .limit(1);
      const run = lockedRows[0];
      if (!run) return { outcome: 'not_found' as const };

      // (2) Expiração: uma run vencida não avança (mas continua legível).
      if (run.expires_at.getTime() <= Date.now()) {
        return {
          outcome: 'invalid_transition' as const,
          run,
          code: 'run_expired',
          message: `run expirada em ${run.expires_at.toISOString()}`,
        };
      }

      // (3) LEDGER ANTES da versão: um retry após um commit perdido carrega a
      // versão ANTIGA (o cliente nunca viu a nova). Checar a versão primeiro
      // devolveria `version_conflict` para o caso mais comum de retry — o
      // exato cenário que a idempotência existe para resolver.
      const ledger = await tx
        .select()
        .from(onboarding_step_results)
        .where(
          and(
            eq(onboarding_step_results.run_id, run.id),
            eq(onboarding_step_results.step, input.step),
            eq(onboarding_step_results.idempotency_key_hash, input.idempotency_key_hash),
          ),
        )
        .limit(1);
      const previous = ledger[0];
      if (previous) {
        if (previous.payload_hash !== input.payload_hash) {
          return { outcome: 'payload_conflict' as const, run };
        }
        await tx.insert(onboarding_events).values({
          run_id: run.id,
          tenant_id: run.tenant_id,
          agent_id: run.agent_id,
          step: input.step,
          event_type: 'step_replayed',
          actor_id: input.actor_id,
          correlation_id: input.correlation_id,
          idempotency_key_hash: input.idempotency_key_hash,
          from_state: run.state,
          to_state: run.state,
          summary: {},
        });
        return {
          outcome: 'replayed' as const,
          run,
          result: (previous.result ?? {}) as Record<string, unknown>,
        };
      }

      // (4) Optimistic concurrency: dois operadores no mesmo passo.
      if (run.version !== input.expected_version) {
        return { outcome: 'version_conflict' as const, run };
      }

      // (5) Transição validada contra o estado TRAVADO.
      let plan;
      try {
        plan = planTransition({ step: input.step, from: run.state as OnboardingState });
      } catch (err) {
        const code = err instanceof OnboardingError ? err.code : 'invalid_transition';
        return {
          outcome: 'invalid_transition' as const,
          run,
          code,
          message: err instanceof Error ? err.message : 'transição inválida',
        };
      }

      // (6) A escrita de provisionamento do passo, no MESMO tx.
      const applied = await input.apply(tx, run);

      const now = new Date();
      const nextTenant = applied.scope_patch?.tenant_id ?? run.tenant_id;
      const nextAgent = applied.scope_patch?.agent_id ?? run.agent_id;

      if (applied.deny) {
        const [denied] = await tx
          .update(onboarding_runs)
          .set({
            state: plan.onDeny,
            current_step: input.step,
            version: run.version + 1,
            last_error_code: applied.deny.code,
            updated_at: now,
          })
          .where(
            and(eq(onboarding_runs.id, run.id), eq(onboarding_runs.version, run.version)),
          )
          .returning();

        await tx.insert(onboarding_events).values({
          run_id: run.id,
          tenant_id: run.tenant_id,
          agent_id: run.agent_id,
          step: input.step,
          event_type: 'step_denied',
          actor_id: input.actor_id,
          correlation_id: input.correlation_id,
          idempotency_key_hash: input.idempotency_key_hash,
          from_state: run.state,
          to_state: plan.onDeny,
          summary: sanitizeForPersistence({ ...(applied.summary ?? {}), code: applied.deny.code }),
        });

        await tx.insert(admin_audit_log).values({
          tenant_id: nextTenant ?? 'system',
          actor_id: input.actor_id,
          actor_role: input.actor_role,
          action: `${applied.audit.action}_denied`,
          resource_type: applied.audit.resource_type,
          resource_id: applied.audit.resource_id,
          change_summary: {
            run_id: run.id,
            step: input.step,
            from_state: run.state,
            to_state: plan.onDeny,
            code: applied.deny.code,
            correlation_id: input.correlation_id,
          },
        });

        return {
          outcome: 'denied' as const,
          run: denied ?? run,
          code: applied.deny.code,
          message: applied.deny.message,
        };
      }

      const sanitizedResult = sanitizeForPersistence(applied.result);

      await tx.insert(onboarding_step_results).values({
        run_id: run.id,
        tenant_id: nextTenant,
        step: input.step,
        idempotency_key_hash: input.idempotency_key_hash,
        payload_hash: input.payload_hash,
        result: sanitizedResult,
      });

      const [updated] = await tx
        .update(onboarding_runs)
        .set({
          state: plan.to,
          current_step: input.step,
          version: run.version + 1,
          tenant_id: nextTenant,
          agent_id: nextAgent,
          last_error_code: null,
          updated_at: now,
          ...(applied.completes ? { completed_at: now } : {}),
        })
        .where(and(eq(onboarding_runs.id, run.id), eq(onboarding_runs.version, run.version)))
        .returning();
      if (!updated) {
        // Inalcançável: seguramos `FOR UPDATE` sobre esta row desde (1). Se
        // acontecer, o rollback é a resposta certa — jamais declarar sucesso.
        throw new OnboardingError(
          'version_conflict',
          `UPDATE não casou com version=${run.version} para a run ${run.id}`,
        );
      }

      await tx.insert(onboarding_events).values({
        run_id: run.id,
        tenant_id: nextTenant,
        agent_id: nextAgent,
        step: input.step,
        event_type: applied.completes ? 'run_completed' : 'step_completed',
        actor_id: input.actor_id,
        correlation_id: input.correlation_id,
        idempotency_key_hash: input.idempotency_key_hash,
        from_state: run.state,
        to_state: plan.to,
        summary: sanitizeForPersistence(applied.summary ?? {}),
      });

      await tx.insert(admin_audit_log).values({
        tenant_id: nextTenant ?? 'system',
        actor_id: input.actor_id,
        actor_role: input.actor_role,
        action: applied.audit.action,
        resource_type: applied.audit.resource_type,
        resource_id: applied.audit.resource_id,
        change_summary: {
          run_id: run.id,
          step: input.step,
          from_state: run.state,
          to_state: plan.to,
          target_tenant_id: nextTenant,
          target_agent_id: nextAgent,
          correlation_id: input.correlation_id,
        },
      });

      return { outcome: 'committed' as const, run: updated, result: sanitizedResult };
    });
  },

  /**
   * Cancelamento. NÃO desprovisiona: a compensação segura desta fatia é
   * "encerrar a run e preservar tudo", porque nenhum recurso criado pela saga
   * é exclusivo dela (um tenant/agente/canal pode já estar em uso por outro
   * caminho). Auditoria e eventos são preservados por construção — ambas as
   * tabelas são append-only e a run continua legível.
   */
  async cancel(input: {
    run_id: string;
    tenant_id: string | null;
    expected_version: number;
    actor_id: string;
    actor_role: string;
    correlation_id: string;
    reason_code: string;
  }): Promise<CommitStepOutcome> {
    return withTx(async (tx) => {
      const lockedRows = await tx
        .select()
        .from(onboarding_runs)
        .where(
          input.tenant_id === null
            ? eq(onboarding_runs.id, input.run_id)
            : and(
                eq(onboarding_runs.id, input.run_id),
                or(
                  eq(onboarding_runs.tenant_id, input.tenant_id),
                  isNull(onboarding_runs.tenant_id),
                ),
              ),
        )
        .for('update')
        .limit(1);
      const run = lockedRows[0];
      if (!run) return { outcome: 'not_found' as const };

      if ((TERMINAL_STATES as readonly string[]).includes(run.state)) {
        return {
          outcome: 'invalid_transition' as const,
          run,
          code: 'run_terminal',
          message: `run em estado terminal '${run.state}' não pode ser cancelada`,
        };
      }
      if (run.version !== input.expected_version) {
        return { outcome: 'version_conflict' as const, run };
      }

      const now = new Date();
      const [cancelled] = await tx
        .update(onboarding_runs)
        .set({
          state: 'cancelled',
          version: run.version + 1,
          cancelled_at: now,
          updated_at: now,
          last_error_code: input.reason_code,
        })
        .where(and(eq(onboarding_runs.id, run.id), eq(onboarding_runs.version, run.version)))
        .returning();

      await tx.insert(onboarding_events).values({
        run_id: run.id,
        tenant_id: run.tenant_id,
        agent_id: run.agent_id,
        step: run.current_step ?? 'cancel',
        event_type: 'run_cancelled',
        actor_id: input.actor_id,
        correlation_id: input.correlation_id,
        from_state: run.state,
        to_state: 'cancelled',
        summary: sanitizeForPersistence({ reason_code: input.reason_code }),
      });

      await tx.insert(admin_audit_log).values({
        tenant_id: run.tenant_id ?? 'system',
        actor_id: input.actor_id,
        actor_role: input.actor_role,
        action: 'onboarding_run_cancelled',
        resource_type: 'onboarding_run',
        resource_id: run.id,
        change_summary: {
          run_id: run.id,
          from_state: run.state,
          reason_code: input.reason_code,
          correlation_id: input.correlation_id,
        },
      });

      return { outcome: 'committed' as const, run: cancelled ?? run, result: {} };
    });
  },

  /**
   * Varredura de runs vencidas. Marca `cancelled` com
   * `last_error_code='expired'` — nunca apaga: uma run abandonada precisa
   * continuar diagnosticável (critério de aceite da issue).
   */
  async expireStale(now: Date = new Date(), limit = 100): Promise<number> {
    const stale = await db
      .select({ id: onboarding_runs.id })
      .from(onboarding_runs)
      .where(
        and(
          lt(onboarding_runs.expires_at, now),
          notInArray(onboarding_runs.state, [...TERMINAL_STATES]),
        ),
      )
      .limit(limit);
    if (stale.length === 0) return 0;

    let expired = 0;
    for (const { id } of stale) {
      const done = await withTx(async (tx) => {
        const rows = await tx
          .select()
          .from(onboarding_runs)
          .where(eq(onboarding_runs.id, id))
          .for('update')
          .limit(1);
        const run = rows[0];
        if (
          !run ||
          (TERMINAL_STATES as readonly string[]).includes(run.state) ||
          run.expires_at.getTime() > now.getTime()
        ) {
          return false;
        }
        await tx
          .update(onboarding_runs)
          .set({
            state: 'cancelled',
            version: run.version + 1,
            cancelled_at: now,
            updated_at: now,
            last_error_code: 'expired',
          })
          .where(and(eq(onboarding_runs.id, run.id), eq(onboarding_runs.version, run.version)));
        await tx.insert(onboarding_events).values({
          run_id: run.id,
          tenant_id: run.tenant_id,
          agent_id: run.agent_id,
          step: run.current_step ?? 'expire',
          event_type: 'run_expired',
          actor_id: 'system',
          from_state: run.state,
          to_state: 'cancelled',
          summary: {},
        });
        return true;
      });
      if (done) expired += 1;
    }
    return expired;
  },
};
