/**
 * Issue #519 — persistência da SAGA de onboarding (migrations 113/114).
 *
 * Este módulo é só persistência: ele guarda o estado, serializa concorrência e
 * escreve a trilha. Quem sabe o que cada passo FAZ é `src/onboarding/service.ts`.
 *
 * ── O padrão, e por que é este ────────────────────────────────────────────────
 *
 * A #518 já resolveu, em `channel-line-state-repos.ts`, o problema de "um
 * console e um runtime coordenando trabalho durável sem inventar uma API
 * interna": row travada com `FOR UPDATE`, CAS por token de versão, comando e
 * trilha no MESMO commit. Reimplementar isso diferente aqui criaria uma segunda
 * fonte de verdade sobre concorrência. Então a saga usa a MESMA gramática:
 *
 *   - `SELECT … FOR UPDATE` na row da run serializa dois operadores;
 *   - `version` é o token de CAS (o `command_id` da #518 aplicado a uma saga
 *     de múltiplos passos);
 *   - evento + `admin_audit_log` caem no MESMO commit da transição.
 *
 * ── Por que CLAIM → EFEITO → COMPLETE, em três transações curtas ──────────────
 *
 * Os efeitos de cada passo já existem, atômicos e auditados, nos repos de
 * domínio (`tenantsRepo.createWithAuditAtomic`, `agentsRepo.createWithSeedAndAudit`,
 * `rolesRepo.createWithAudit`, `channelsRepo.createWithAudit`,
 * `operationalProfileVersionsRepo.approveAndActivateAtomic`). Cada um abre a
 * PRÓPRIA transação — `withTx` pega um client novo do pool, então chamá-los
 * dentro de outra transação não os aninharia: seriam duas conexões, dois
 * commits e nenhuma atomicidade real. Reescrever os cinco para aceitar um `tx`
 * emprestado seria a alternativa, ao custo de mexer em código atômico já
 * revisado e testado por outras issues.
 *
 * A saída é o CLAIM, que é o mesmo mecanismo do `idempotency_keys` (064/065)
 * aplicado a passos:
 *
 *   A. `claimStep` — tx curta: trava a run, valida versão/escopo/expiração e
 *      a transição, e INSERE a linha do ledger com `pending`. O UNIQUE
 *      `(run_id, step)` faz duas requisições simultâneas do mesmo passo
 *      serializarem: uma reivindica, a outra vê a reivindicação.
 *   B. efeito — o repo de domínio faz o trabalho e audita, atomicamente.
 *   C. `completeStep` — tx curta: trava a run, CAS na versão, grava o
 *      resultado no ledger, avança estado/passo/escopo e escreve evento +
 *      auditoria no mesmo commit.
 *
 * Uma queda entre A e B (ou entre B e C) deixa o ledger em `pending`. O retry
 * com a MESMA chave reencontra a reivindicação, refaz o efeito — que devolve
 * `duplicate_*` porque o recurso já existe — e o serviço ADOTA o recurso já
 * criado em vez de duplicar. É exatamente o critério "retry após timeout
 * devolve o resultado anterior", e é a razão de o ledger existir separado da
 * row da run.
 *
 * Uma reivindicação `pending` ABANDONADA (o processo morreu e ninguém voltou)
 * expira por LEASE, igual à posse de linha da #518: passado o TTL, outra
 * tentativa pode tomá-la. Sem isso, um crash no meio de um passo travaria a run
 * para sempre.
 */
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { db, withTx, pgErrorCode } from '../client.js';
import {
  admin_audit_log,
  agents,
  bootstrap_credentials,
  onboarding_events,
  onboarding_runs,
  onboarding_step_results,
} from '../schema.js';
import type {
  BootstrapCredentialRow,
  OnboardingEventRow,
  OnboardingRunRow,
  OnboardingStepResultRow,
} from '../schema.js';
import {
  isTerminal,
  planTransition,
  type OnboardingEventType,
  type OnboardingKind,
  type OnboardingState,
  type OnboardingStep,
} from '@/onboarding/state-machine.js';

type Tx = Parameters<Parameters<typeof withTx>[0]>[0];

/**
 * TTL da reivindicação de um passo. Confortavelmente maior que o passo mais
 * lento (a aprovação de perfil abre uma transação com locks de perfil) e
 * pequeno o bastante para que um processo morto não trave a run por muito
 * tempo. Mesmo racional da `OWNER_LEASE_MS` da #518, outra ordem de grandeza
 * porque aqui o "dono" é uma requisição HTTP, não um socket.
 */
export const STEP_CLAIM_TTL_MS = 2 * 60_000;

/** Validade padrão de uma run abandonada. */
export const RUN_TTL_MS = 7 * 24 * 60 * 60_000;

/** Marcador do ledger enquanto o efeito ainda não confirmou. */
const PENDING = '__pending__';

export function hashOpaque(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Hash do payload CANÔNICO. Ordena as chaves recursivamente para que a mesma
 * intenção produza o mesmo hash independentemente da ordem em que o cliente
 * serializou o objeto — senão "mesma chave, payload diferente" dispararia por
 * ordem de propriedade, que não é uma diferença de intenção.
 */
export function hashPayload(payload: unknown): string {
  return hashOpaque(canonicalize(payload));
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Trilha (evento + auditoria administrativa) — sempre na tx do chamador
// ---------------------------------------------------------------------------

export interface StepAudit {
  action: string;
  resource_type: string;
  resource_id: string | null;
  change_summary: Record<string, unknown>;
}

async function appendEvent(
  tx: Tx,
  args: {
    run: Pick<OnboardingRunRow, 'id' | 'tenant_id' | 'agent_id' | 'correlation_id'>;
    step: OnboardingStep;
    event_type: OnboardingEventType;
    actor_id: string;
    actor_role: string;
    idempotency_key_hash?: string | null;
    from_state?: OnboardingState | null;
    to_state?: OnboardingState | null;
    summary?: Record<string, unknown>;
    error_code?: string | null;
  },
): Promise<void> {
  await tx.insert(onboarding_events).values({
    run_id: args.run.id,
    tenant_id: args.run.tenant_id,
    agent_id: args.run.agent_id,
    step: args.step,
    event_type: args.event_type,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    correlation_id: args.run.correlation_id,
    idempotency_key_hash: args.idempotency_key_hash ?? null,
    from_state: args.from_state ?? null,
    to_state: args.to_state ?? null,
    summary: args.summary ?? {},
    error_code: args.error_code ?? null,
  });
}

/**
 * `admin_audit_log.tenant_id` é FK para `tenants(id)`, então a trilha
 * administrativa só pode ser escrita depois que o tenant existe. Durante o
 * `global_bootstrap` (antes do passo `tenant`) a trilha vive apenas em
 * `onboarding_events` — que é append-only e carrega o mesmo ator. Assim que o
 * tenant existe, as duas passam a andar juntas no mesmo commit.
 */
async function appendAdminAudit(
  tx: Tx,
  tenant_id: string,
  actor_id: string,
  actor_role: string,
  audit: StepAudit,
): Promise<void> {
  await tx.insert(admin_audit_log).values({
    tenant_id,
    actor_id,
    actor_role,
    action: audit.action,
    resource_type: audit.resource_type,
    resource_id: audit.resource_id,
    change_summary: audit.change_summary,
  });
}

// ---------------------------------------------------------------------------
// Resultados tipados
// ---------------------------------------------------------------------------

export type ClaimResult =
  | {
      ok: true;
      outcome: 'claimed' | 'resumed';
      run: OnboardingRunRow;
      to_state: OnboardingState;
      next_step: OnboardingStep;
    }
  | { ok: true; outcome: 'replay'; run: OnboardingRunRow; result: Record<string, unknown> }
  | {
      ok: false;
      reason:
        | 'run_not_found'
        | 'run_terminal'
        | 'run_expired'
        | 'version_conflict'
        | 'step_out_of_order'
        | 'kind_not_allowed'
        | 'idempotency_payload_mismatch'
        | 'claim_in_progress';
      run?: OnboardingRunRow;
    };

export type CompleteResult =
  | { ok: true; run: OnboardingRunRow }
  | { ok: false; reason: 'run_not_found' | 'version_conflict' | 'claim_lost' };

// ---------------------------------------------------------------------------

export const onboardingRepo = {
  /**
   * Abre a run. O evento `started` cai no MESMO commit — uma run sem primeiro
   * evento seria uma saga sem origem rastreável.
   *
   * `actor_tenant_id` é o tenant da SESSÃO. É por ele que a listagem filtra:
   * uma run de bootstrap ainda não tem tenant alvo, e sem esta coluna ela seria
   * invisível para o dono ou visível para todo mundo.
   */
  async createRun(args: {
    kind: OnboardingKind;
    actor_tenant_id: string;
    tenant_id?: string | null;
    created_by: string;
    created_by_role: string;
    configuration_contract_version: string;
    schema_version: string;
    metadata?: Record<string, unknown>;
    ttl_ms?: number;
  }): Promise<{ ok: true; run: OnboardingRunRow } | { ok: false; reason: 'active_run_exists' }> {
    const now = new Date();
    const correlation_id = randomUUID();
    try {
      return await withTx(async (tx) => {
        const inserted = await tx
          .insert(onboarding_runs)
          .values({
            kind: args.kind,
            actor_tenant_id: args.actor_tenant_id,
            tenant_id: args.tenant_id ?? null,
            state: 'created',
            current_step: 'tenant',
            version: 0,
            created_by: args.created_by,
            created_by_role: args.created_by_role,
            correlation_id,
            expires_at: new Date(now.getTime() + (args.ttl_ms ?? RUN_TTL_MS)),
            metadata: args.metadata ?? {},
            configuration_contract_version: args.configuration_contract_version,
            schema_version: args.schema_version,
          })
          .returning();
        const run = inserted[0]!;
        await appendEvent(tx, {
          run,
          step: 'tenant',
          event_type: 'started',
          actor_id: args.created_by,
          actor_role: args.created_by_role,
          to_state: 'created',
          summary: { kind: args.kind },
        });
        // Auditoria administrativa só quando já existe um tenant âncora (a FK
        // de `admin_audit_log`). O bootstrap global audita no passo `tenant`.
        await appendAdminAudit(tx, args.actor_tenant_id, args.created_by, args.created_by_role, {
          action: 'onboarding_run_started',
          resource_type: 'onboarding_run',
          resource_id: run.id,
          change_summary: {
            kind: args.kind,
            target_tenant_id: args.tenant_id ?? null,
            correlation_id,
          },
        });
        return { ok: true as const, run };
      });
    } catch (err) {
      // Índices parciais da 113: uma run viva por (tenant, agente) e um
      // bootstrap global vivo por vez.
      if (pgErrorCode(err) === '23505') {
        return { ok: false as const, reason: 'active_run_exists' as const };
      }
      throw err;
    }
  },

  /**
   * Cria a run do BOOTSTRAP GLOBAL, sem sessão e portanto sem tenant âncora
   * para a auditoria administrativa. A trilha inicial vive só em
   * `onboarding_events` (ver `appendAdminAudit`).
   */
  async createBootstrapRun(args: {
    created_by: string;
    configuration_contract_version: string;
    schema_version: string;
    metadata?: Record<string, unknown>;
    ttl_ms?: number;
  }): Promise<{ ok: true; run: OnboardingRunRow } | { ok: false; reason: 'active_run_exists' }> {
    const now = new Date();
    const correlation_id = randomUUID();
    try {
      return await withTx(async (tx) => {
        const inserted = await tx
          .insert(onboarding_runs)
          .values({
            kind: 'global_bootstrap',
            // Sem sessão não há tenant de ator. O sentinela `system` é o mesmo
            // que `governance/audit.ts` usa para caminhos genuinamente sem
            // tenant — NUNCA o literal `default`, recusado pelo AGENTS.md §4.8.
            actor_tenant_id: 'system',
            tenant_id: null,
            state: 'created',
            current_step: 'tenant',
            version: 0,
            created_by: args.created_by,
            created_by_role: 'founder',
            correlation_id,
            expires_at: new Date(now.getTime() + (args.ttl_ms ?? RUN_TTL_MS)),
            metadata: args.metadata ?? {},
            configuration_contract_version: args.configuration_contract_version,
            schema_version: args.schema_version,
          })
          .returning();
        const run = inserted[0]!;
        await appendEvent(tx, {
          run,
          step: 'tenant',
          event_type: 'started',
          actor_id: args.created_by,
          actor_role: 'founder',
          to_state: 'created',
          summary: { kind: 'global_bootstrap' },
        });
        return { ok: true as const, run };
      });
    } catch (err) {
      if (pgErrorCode(err) === '23505') {
        return { ok: false as const, reason: 'active_run_exists' as const };
      }
      throw err;
    }
  },

  async getById(id: string): Promise<OnboardingRunRow | null> {
    const rows = await db.select().from(onboarding_runs).where(eq(onboarding_runs.id, id)).limit(1);
    return rows[0] ?? null;
  },

  /**
   * Leitura ESCOPADA. `cross_tenant` só é ligado para founder (o mesmo
   * privilégio que `founderProcedure` já concede em todo o console). Para
   * qualquer outro papel, uma run de outro tenant simplesmente NÃO EXISTE —
   * fail-closed, sem distinguir "não existe" de "não é seu".
   */
  async getForActor(args: {
    id: string;
    actor_tenant_id: string;
    cross_tenant: boolean;
  }): Promise<OnboardingRunRow | null> {
    const rows = await db
      .select()
      .from(onboarding_runs)
      .where(
        args.cross_tenant
          ? eq(onboarding_runs.id, args.id)
          : and(
              eq(onboarding_runs.id, args.id),
              or(
                eq(onboarding_runs.actor_tenant_id, args.actor_tenant_id),
                eq(onboarding_runs.tenant_id, args.actor_tenant_id),
              ),
            ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listForActor(args: {
    actor_tenant_id: string;
    cross_tenant: boolean;
    include_terminal?: boolean;
    limit?: number;
  }): Promise<OnboardingRunRow[]> {
    const scope = args.cross_tenant
      ? undefined
      : or(
          eq(onboarding_runs.actor_tenant_id, args.actor_tenant_id),
          eq(onboarding_runs.tenant_id, args.actor_tenant_id),
        );
    const terminal = args.include_terminal
      ? undefined
      : sql`${onboarding_runs.state} NOT IN ('active','cancelled','failed_terminal')`;
    const where =
      scope && terminal ? and(scope, terminal) : (scope ?? terminal ?? sql`true`);
    return db
      .select()
      .from(onboarding_runs)
      .where(where)
      .orderBy(desc(onboarding_runs.created_at))
      .limit(args.limit ?? 50);
  },

  async listEvents(run_id: string, limit = 200): Promise<OnboardingEventRow[]> {
    return db
      .select()
      .from(onboarding_events)
      .where(eq(onboarding_events.run_id, run_id))
      .orderBy(onboarding_events.id)
      .limit(limit);
  },

  async listStepResults(run_id: string): Promise<OnboardingStepResultRow[]> {
    return db
      .select()
      .from(onboarding_step_results)
      .where(eq(onboarding_step_results.run_id, run_id))
      .orderBy(onboarding_step_results.created_at);
  },

  /**
   * Fase A — reivindica o passo.
   *
   * Tudo numa transação com a row da run travada: dois cliques simultâneos
   * serializam e o segundo enxerga a reivindicação do primeiro em vez de
   * duplicar o efeito.
   */
  async claimStep(args: {
    run_id: string;
    step: OnboardingStep;
    expected_version: number;
    idempotency_key_hash: string;
    request_hash: string;
    actor_id: string;
    actor_role: string;
    /** `now` injetável para o teste de expiração não depender do relógio. */
    now?: Date;
    claim_ttl_ms?: number;
  }): Promise<ClaimResult> {
    const now = args.now ?? new Date();
    const ttl = args.claim_ttl_ms ?? STEP_CLAIM_TTL_MS;
    return withTx(async (tx) => {
      const locked = await tx
        .select()
        .from(onboarding_runs)
        .where(eq(onboarding_runs.id, args.run_id))
        .limit(1)
        .for('update');
      const run = locked[0];
      if (!run) return { ok: false as const, reason: 'run_not_found' as const };

      const state = run.state as OnboardingState;

      // Ledger ANTES da máquina de estados: um replay legítimo tem de ser
      // reconhecido mesmo quando o passo já avançou (é justamente o caso do
      // retry após timeout, em que a run já está no estado seguinte).
      const ledger = await tx
        .select()
        .from(onboarding_step_results)
        .where(
          and(
            eq(onboarding_step_results.run_id, args.run_id),
            eq(onboarding_step_results.step, args.step),
          ),
        )
        .limit(1);
      const existing = ledger[0] ?? null;

      if (existing) {
        const samePayload = existing.request_hash === args.request_hash;
        const sameKey = existing.idempotency_key_hash === args.idempotency_key_hash;
        const result = (existing.result ?? {}) as Record<string, unknown>;
        const pending = result[PENDING] === true;

        if (sameKey && !samePayload) {
          // A chave foi reusada para OUTRO pedido. Devolver o resultado antigo
          // esconderia um bug do cliente; refazer o efeito duplicaria recurso.
          return { ok: false as const, reason: 'idempotency_payload_mismatch' as const, run };
        }
        if (!pending) {
          // Passo já concluído: replay puro, sem tocar em nada.
          return { ok: true as const, outcome: 'replay' as const, run, result };
        }
        // Reivindicação PENDENTE.
        const claimAge = now.getTime() - existing.created_at.getTime();
        if (sameKey && samePayload) {
          // Mesma tentativa voltando (queda entre efeito e conclusão): retoma.
          return {
            ok: true as const,
            outcome: 'resumed' as const,
            run,
            to_state: state,
            next_step: run.current_step as OnboardingStep,
          };
        }
        if (claimAge < ttl) {
          // Outra tentativa está no ar AGORA. Fail-closed: não corremos junto.
          return { ok: false as const, reason: 'claim_in_progress' as const, run };
        }
        // Lease vencida — o dono anterior morreu. Tomamos a reivindicação.
        await tx
          .update(onboarding_step_results)
          .set({
            idempotency_key_hash: args.idempotency_key_hash,
            request_hash: args.request_hash,
            created_at: now,
          })
          .where(eq(onboarding_step_results.id, existing.id));
        await appendEvent(tx, {
          run,
          step: args.step,
          event_type: 'started',
          actor_id: args.actor_id,
          actor_role: args.actor_role,
          idempotency_key_hash: args.idempotency_key_hash,
          from_state: state,
          summary: { claim: 'taken_over' },
        });
        const plan = planTransition({ kind: run.kind as OnboardingKind, state, step: args.step });
        return {
          ok: true as const,
          outcome: 'resumed' as const,
          run,
          to_state: plan.ok ? plan.to : state,
          next_step: plan.ok ? plan.nextStep : (run.current_step as OnboardingStep),
        };
      }

      // Sem ledger: é uma execução nova. Agora sim, as guardas.
      if (isTerminal(state)) return { ok: false as const, reason: 'run_terminal' as const, run };
      if (run.expires_at.getTime() <= now.getTime()) {
        return { ok: false as const, reason: 'run_expired' as const, run };
      }
      if (run.version !== args.expected_version) {
        return { ok: false as const, reason: 'version_conflict' as const, run };
      }
      const plan = planTransition({ kind: run.kind as OnboardingKind, state, step: args.step });
      if (!plan.ok) {
        await appendEvent(tx, {
          run,
          step: args.step,
          event_type: 'denied',
          actor_id: args.actor_id,
          actor_role: args.actor_role,
          idempotency_key_hash: args.idempotency_key_hash,
          from_state: state,
          error_code: plan.reason,
        });
        return {
          ok: false as const,
          reason: plan.reason === 'unknown_step' ? ('step_out_of_order' as const) : plan.reason,
          run,
        };
      }

      await tx.insert(onboarding_step_results).values({
        run_id: run.id,
        tenant_id: run.tenant_id,
        agent_id: run.agent_id,
        step: args.step,
        idempotency_key_hash: args.idempotency_key_hash,
        request_hash: args.request_hash,
        result: { [PENDING]: true },
        created_at: now,
      });
      await appendEvent(tx, {
        run,
        step: args.step,
        event_type: 'started',
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        idempotency_key_hash: args.idempotency_key_hash,
        from_state: state,
        to_state: plan.to,
      });

      return {
        ok: true as const,
        outcome: 'claimed' as const,
        run,
        to_state: plan.to,
        next_step: plan.nextStep,
      };
    });
  },

  /**
   * Fase C — conclui o passo: grava o resultado, avança a run e escreve
   * evento + auditoria administrativa NO MESMO COMMIT.
   *
   * O CAS por `version` fecha a corrida "dois operadores avançam a mesma
   * versão". A versão só é comparada quando o chamador a declara: uma retomada
   * (`resumed`) já viu a run em outro ponto e passa `expected_version: null`.
   */
  async completeStep(args: {
    run_id: string;
    step: OnboardingStep;
    expected_version: number | null;
    to_state: OnboardingState;
    next_step: OnboardingStep;
    actor_id: string;
    actor_role: string;
    result: Record<string, unknown>;
    /** Patch de escopo: o passo `tenant` resolve `tenant_id`, o `agent` resolve `agent_id`. */
    tenant_id?: string | null;
    agent_id?: string | null;
    metadata_patch?: Record<string, unknown>;
    audit?: StepAudit;
    now?: Date;
  }): Promise<CompleteResult> {
    const now = args.now ?? new Date();
    return withTx(async (tx) => {
      const locked = await tx
        .select()
        .from(onboarding_runs)
        .where(eq(onboarding_runs.id, args.run_id))
        .limit(1)
        .for('update');
      const run = locked[0];
      if (!run) return { ok: false as const, reason: 'run_not_found' as const };
      if (args.expected_version !== null && run.version !== args.expected_version) {
        return { ok: false as const, reason: 'version_conflict' as const };
      }

      const claimed = await tx
        .update(onboarding_step_results)
        .set({ result: args.result, tenant_id: args.tenant_id ?? run.tenant_id, agent_id: args.agent_id ?? run.agent_id })
        .where(
          and(
            eq(onboarding_step_results.run_id, args.run_id),
            eq(onboarding_step_results.step, args.step),
          ),
        )
        .returning({ id: onboarding_step_results.id });
      if (claimed.length === 0) return { ok: false as const, reason: 'claim_lost' as const };

      const tenant_id = args.tenant_id ?? run.tenant_id;
      const agent_id = args.agent_id ?? run.agent_id;
      const metadata = {
        ...((run.metadata ?? {}) as Record<string, unknown>),
        ...(args.metadata_patch ?? {}),
      };

      // O índice parcial `onboarding_runs_active_scope_uq` só passa a valer
      // quando (tenant_id, agent_id) ficam AMBOS resolvidos — o que acontece
      // exatamente neste UPDATE, no passo `agent`. Duas runs vivas apontando
      // para o mesmo par colidem aqui, e a segunda tem de receber conflito
      // tipado em vez de um 500 com SQLSTATE cru.
      let after: OnboardingRunRow;
      try {
        const updated = await tx
          .update(onboarding_runs)
          .set({
            state: args.to_state,
            current_step: args.next_step,
            version: run.version + 1,
            tenant_id,
            agent_id,
            metadata,
            last_error_code: null,
            updated_at: now,
            ...(args.to_state === 'active' ? { completed_at: now } : {}),
          })
          .where(eq(onboarding_runs.id, args.run_id))
          .returning();
        after = updated[0]!;
      } catch (err) {
        if (pgErrorCode(err) === '23505') {
          return { ok: false as const, reason: 'version_conflict' as const };
        }
        throw err;
      }

      await appendEvent(tx, {
        run: after,
        step: args.step,
        event_type: 'completed',
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        from_state: run.state as OnboardingState,
        to_state: args.to_state,
        summary: sanitizeSummary(args.result),
      });

      if (args.audit && tenant_id) {
        await appendAdminAudit(tx, tenant_id, args.actor_id, args.actor_role, args.audit);
      }

      return { ok: true as const, run: after };
    });
  },

  /**
   * Transição SEM ledger, para os passos que não criam recurso.
   *
   * `pairing`, `readiness` e `activation` são avaliações/declarações de
   * intenção, não criações. Registrá-las no ledger de idempotência seria pior
   * do que inútil: o UNIQUE `(run_id, step)` impediria justamente o que elas
   * precisam ser — REPETÍVEIS. Reparear uma linha, reavaliar a prontidão depois
   * de consertar a política e tentar ativar de novo são operações normais, e
   * nenhuma delas duplica recurso: a idempotência do pareamento vive no
   * `command_id` da #518, e a da avaliação é intrínseca (ler duas vezes não
   * cria nada).
   *
   * O CAS por `version` continua fechando a corrida entre dois operadores.
   */
  async transitionRun(args: {
    run_id: string;
    step: OnboardingStep;
    expected_version: number;
    actor_id: string;
    actor_role: string;
    /** Estado lateral no lugar do estado feliz do plano (ex.: readiness_failed). */
    override_state?: OnboardingState;
    override_next_step?: OnboardingStep;
    event_type?: OnboardingEventType;
    error_code?: string | null;
    summary?: Record<string, unknown>;
    metadata_patch?: Record<string, unknown>;
    audit?: StepAudit;
    now?: Date;
  }): Promise<
    | { ok: true; run: OnboardingRunRow }
    | {
        ok: false;
        reason:
          | 'run_not_found'
          | 'run_terminal'
          | 'run_expired'
          | 'version_conflict'
          | 'step_out_of_order'
          | 'kind_not_allowed';
        run?: OnboardingRunRow;
      }
  > {
    const now = args.now ?? new Date();
    return withTx(async (tx) => {
      const locked = await tx
        .select()
        .from(onboarding_runs)
        .where(eq(onboarding_runs.id, args.run_id))
        .limit(1)
        .for('update');
      const run = locked[0];
      if (!run) return { ok: false as const, reason: 'run_not_found' as const };

      const state = run.state as OnboardingState;
      if (isTerminal(state)) return { ok: false as const, reason: 'run_terminal' as const, run };
      if (run.expires_at.getTime() <= now.getTime()) {
        return { ok: false as const, reason: 'run_expired' as const, run };
      }
      if (run.version !== args.expected_version) {
        return { ok: false as const, reason: 'version_conflict' as const, run };
      }

      const plan = planTransition({ kind: run.kind as OnboardingKind, state, step: args.step });
      if (!plan.ok) {
        await appendEvent(tx, {
          run,
          step: args.step,
          event_type: 'denied',
          actor_id: args.actor_id,
          actor_role: args.actor_role,
          from_state: state,
          error_code: plan.reason,
        });
        return {
          ok: false as const,
          reason: plan.reason === 'unknown_step' ? ('step_out_of_order' as const) : plan.reason,
          run,
        };
      }

      const to_state = args.override_state ?? plan.to;
      const next_step = args.override_next_step ?? plan.nextStep;
      const updated = await tx
        .update(onboarding_runs)
        .set({
          state: to_state,
          current_step: next_step,
          version: run.version + 1,
          last_error_code: args.error_code ?? null,
          metadata: {
            ...((run.metadata ?? {}) as Record<string, unknown>),
            ...(args.metadata_patch ?? {}),
          },
          updated_at: now,
        })
        .where(eq(onboarding_runs.id, args.run_id))
        .returning();
      const after = updated[0]!;

      await appendEvent(tx, {
        run: after,
        step: args.step,
        event_type: args.event_type ?? 'completed',
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        from_state: state,
        to_state,
        error_code: args.error_code ?? null,
        summary: args.summary ?? {},
      });
      if (args.audit && after.tenant_id) {
        await appendAdminAudit(tx, after.tenant_id, args.actor_id, args.actor_role, args.audit);
      }
      return { ok: true as const, run: after };
    });
  },

  /**
   * Registra a falha de um passo SEM avançar a run: libera a reivindicação
   * (para o operador poder corrigir e repetir) e deixa o código sanitizado no
   * estado e no evento.
   *
   * `state` opcional move a run para um estado lateral (`readiness_failed`,
   * `failed_terminal`). Quando omitido, a run fica onde estava — é o caso do
   * erro corrigível.
   */
  async failStep(args: {
    run_id: string;
    step: OnboardingStep;
    error_code: string;
    actor_id: string;
    actor_role: string;
    state?: OnboardingState;
    /** `false` mantém a reivindicação (falha não-repetível). */
    release_claim?: boolean;
    audit?: StepAudit;
    now?: Date;
  }): Promise<void> {
    const now = args.now ?? new Date();
    await withTx(async (tx) => {
      const locked = await tx
        .select()
        .from(onboarding_runs)
        .where(eq(onboarding_runs.id, args.run_id))
        .limit(1)
        .for('update');
      const run = locked[0];
      if (!run) return;

      if (args.release_claim !== false) {
        // O ledger só solta reivindicações PENDENTES: um passo já concluído
        // nunca é desfeito por uma falha posterior.
        await tx
          .delete(onboarding_step_results)
          .where(
            and(
              eq(onboarding_step_results.run_id, args.run_id),
              eq(onboarding_step_results.step, args.step),
              sql`${onboarding_step_results.result} ->> ${PENDING} = 'true'`,
            ),
          );
      }

      const updated = await tx
        .update(onboarding_runs)
        .set({
          last_error_code: args.error_code,
          updated_at: now,
          ...(args.state ? { state: args.state, version: run.version + 1 } : {}),
        })
        .where(eq(onboarding_runs.id, args.run_id))
        .returning();
      const after = updated[0] ?? run;

      await appendEvent(tx, {
        run: after,
        step: args.step,
        event_type: 'failed',
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        from_state: run.state as OnboardingState,
        to_state: (args.state ?? run.state) as OnboardingState,
        error_code: args.error_code,
      });
      if (args.audit && after.tenant_id) {
        await appendAdminAudit(tx, after.tenant_id, args.actor_id, args.actor_role, args.audit);
      }
    });
  },

  /**
   * Cancela a run. NÃO apaga nada: eventos e auditoria continuam, e as
   * compensações (revogar credencial, encerrar pareamento) são decididas pelo
   * serviço — este método só fecha a saga.
   */
  async cancelRun(args: {
    run_id: string;
    expected_version: number;
    actor_id: string;
    actor_role: string;
    reason: string;
    now?: Date;
  }): Promise<
    | { ok: true; run: OnboardingRunRow }
    | { ok: false; reason: 'run_not_found' | 'run_terminal' | 'version_conflict' }
  > {
    const now = args.now ?? new Date();
    return withTx(async (tx) => {
      const locked = await tx
        .select()
        .from(onboarding_runs)
        .where(eq(onboarding_runs.id, args.run_id))
        .limit(1)
        .for('update');
      const run = locked[0];
      if (!run) return { ok: false as const, reason: 'run_not_found' as const };
      if (isTerminal(run.state as OnboardingState)) {
        return { ok: false as const, reason: 'run_terminal' as const };
      }
      if (run.version !== args.expected_version) {
        return { ok: false as const, reason: 'version_conflict' as const };
      }

      const updated = await tx
        .update(onboarding_runs)
        .set({
          state: 'cancelled',
          current_step: 'done',
          version: run.version + 1,
          cancelled_at: now,
          updated_at: now,
        })
        .where(eq(onboarding_runs.id, args.run_id))
        .returning();
      const after = updated[0]!;

      await appendEvent(tx, {
        run: after,
        step: run.current_step as OnboardingStep,
        event_type: 'cancelled',
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        from_state: run.state as OnboardingState,
        to_state: 'cancelled',
        summary: { reason: args.reason },
      });
      if (after.tenant_id) {
        await appendAdminAudit(tx, after.tenant_id, args.actor_id, args.actor_role, {
          action: 'onboarding_run_cancelled',
          resource_type: 'onboarding_run',
          resource_id: after.id,
          change_summary: {
            from_state: run.state,
            agent_id: after.agent_id,
            reason: args.reason,
          },
        });
      }
      return { ok: true as const, run: after };
    });
  },

  /**
   * Marca a INTENÇÃO de ativar: CAS `ready_for_activation` → `activating`.
   *
   * A intenção é durável de propósito. O runbook de rollback pede "verificar
   * que nenhuma run ficou em `activating`"; sem esta marca, uma queda no meio
   * da ativação seria indistinguível de uma ativação que nunca começou.
   */
  async beginActivation(args: {
    run_id: string;
    expected_version: number;
    actor_id: string;
    actor_role: string;
    now?: Date;
  }): Promise<
    | { ok: true; run: OnboardingRunRow }
    | { ok: false; reason: 'run_not_found' | 'not_ready' | 'version_conflict' }
  > {
    const now = args.now ?? new Date();
    return withTx(async (tx) => {
      const locked = await tx
        .select()
        .from(onboarding_runs)
        .where(eq(onboarding_runs.id, args.run_id))
        .limit(1)
        .for('update');
      const run = locked[0];
      if (!run) return { ok: false as const, reason: 'run_not_found' as const };
      if (run.state !== 'ready_for_activation') {
        return { ok: false as const, reason: 'not_ready' as const };
      }
      if (run.version !== args.expected_version) {
        return { ok: false as const, reason: 'version_conflict' as const };
      }
      const updated = await tx
        .update(onboarding_runs)
        .set({ state: 'activating', version: run.version + 1, updated_at: now })
        .where(eq(onboarding_runs.id, args.run_id))
        .returning();
      const after = updated[0]!;
      await appendEvent(tx, {
        run: after,
        step: 'activation',
        event_type: 'started',
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        from_state: 'ready_for_activation',
        to_state: 'activating',
      });
      return { ok: true as const, run: after };
    });
  },

  /**
   * A TRANSIÇÃO FINAL, atômica: muda o status do agente, conclui a run,
   * escreve evento e auditoria — tudo num commit. Se qualquer insert falhar, o
   * agente NÃO fica ativo. É o único ponto do sistema que liga um agente pelo
   * wizard.
   *
   * O `UPDATE agents` é CAS sobre `(id, tenant_id, status <> 'active')`, o
   * mesmo formato de `channelsRepo.activateVerified`: duas ativações
   * concorrentes produzem UMA transição conclusiva, e a segunda descobre pelo
   * `rowCount` que perdeu.
   */
  async finishActivation(args: {
    run_id: string;
    tenant_id: string;
    agent_id: string;
    actor_id: string;
    actor_role: string;
    configuration_fingerprint: string;
    schema_fingerprint: string;
    comment: string;
    now?: Date;
  }): Promise<
    | { ok: true; run: OnboardingRunRow }
    | { ok: false; reason: 'run_not_found' | 'not_activating' | 'activation_race_lost' }
  > {
    const now = args.now ?? new Date();
    return withTx(async (tx) => {
      const locked = await tx
        .select()
        .from(onboarding_runs)
        .where(eq(onboarding_runs.id, args.run_id))
        .limit(1)
        .for('update');
      const run = locked[0];
      if (!run) return { ok: false as const, reason: 'run_not_found' as const };
      if (run.state !== 'activating') return { ok: false as const, reason: 'not_activating' as const };
      // Defesa em profundidade: a run precisa apontar para o MESMO par que o
      // laudo avaliou. Divergência aqui é bug — recusa em vez de ativar.
      if (run.tenant_id !== args.tenant_id || run.agent_id !== args.agent_id) {
        return { ok: false as const, reason: 'activation_race_lost' as const };
      }

      const flipped = await tx
        .update(agents)
        .set({ status: 'active', updated_at: now })
        .where(
          and(
            eq(agents.id, args.agent_id),
            eq(agents.tenant_id, args.tenant_id),
            sql`${agents.status} <> 'active'`,
          ),
        )
        .returning({ id: agents.id });

      // `rowCount = 0` com o agente JÁ ativo é a corrida perdida — outra
      // ativação venceu. A run mesmo assim conclui: o efeito desejado existe, e
      // deixar a saga presa em `activating` seria pior.
      const alreadyActive = flipped.length === 0;

      const updated = await tx
        .update(onboarding_runs)
        .set({
          state: 'active',
          current_step: 'done',
          version: run.version + 1,
          completed_at: now,
          updated_at: now,
        })
        .where(eq(onboarding_runs.id, args.run_id))
        .returning();
      const after = updated[0]!;

      await appendEvent(tx, {
        run: after,
        step: 'activation',
        event_type: 'completed',
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        from_state: 'activating',
        to_state: 'active',
        summary: {
          configuration_fingerprint: args.configuration_fingerprint,
          schema_fingerprint: args.schema_fingerprint,
          already_active: alreadyActive,
        },
      });

      await appendAdminAudit(tx, args.tenant_id, args.actor_id, args.actor_role, {
        action: 'agent_activation_approved',
        resource_type: 'agent',
        resource_id: args.agent_id,
        change_summary: {
          agent_id: args.agent_id,
          onboarding_run_id: after.id,
          correlation_id: after.correlation_id,
          configuration_fingerprint: args.configuration_fingerprint,
          schema_fingerprint: args.schema_fingerprint,
          already_active: alreadyActive,
          reason: args.comment,
        },
      });

      return { ok: true as const, run: after };
    });
  },

  /**
   * Devolve a run de `activating` para `readiness_failed` quando a reavaliação
   * bloqueia. Sem isto a run ficaria presa em `activating` — o estado que o
   * runbook de rollback manda procurar.
   */
  async abortActivation(args: {
    run_id: string;
    actor_id: string;
    actor_role: string;
    error_code: string;
    blocking: readonly string[];
    now?: Date;
  }): Promise<void> {
    const now = args.now ?? new Date();
    await withTx(async (tx) => {
      const locked = await tx
        .select()
        .from(onboarding_runs)
        .where(eq(onboarding_runs.id, args.run_id))
        .limit(1)
        .for('update');
      const run = locked[0];
      if (!run || run.state !== 'activating') return;
      const updated = await tx
        .update(onboarding_runs)
        .set({
          state: 'readiness_failed',
          current_step: 'readiness',
          version: run.version + 1,
          last_error_code: args.error_code,
          updated_at: now,
        })
        .where(eq(onboarding_runs.id, args.run_id))
        .returning();
      const after = updated[0]!;
      await appendEvent(tx, {
        run: after,
        step: 'activation',
        event_type: 'denied',
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        from_state: 'activating',
        to_state: 'readiness_failed',
        error_code: args.error_code,
        summary: { blocking: [...args.blocking] },
      });
      if (after.tenant_id) {
        await appendAdminAudit(tx, after.tenant_id, args.actor_id, args.actor_role, {
          action: 'agent_activation_denied',
          resource_type: 'agent',
          resource_id: after.agent_id,
          change_summary: {
            agent_id: after.agent_id,
            onboarding_run_id: after.id,
            correlation_id: after.correlation_id,
            blocking_checks: [...args.blocking],
          },
        });
      }
    });
  },

  /**
   * Sweep de expiração. Uma run vencida vira `failed_terminal` e libera o par
   * (tenant, agente) para uma run nova — continuando DIAGNOSTICÁVEL: nada é
   * apagado, os eventos ficam.
   */
  async expireStaleRuns(now: Date = new Date()): Promise<Array<{ id: string }>> {
    return withTx(async (tx) => {
      const stale = await tx
        .update(onboarding_runs)
        .set({
          state: 'failed_terminal',
          last_error_code: 'run_expired',
          updated_at: now,
          version: sql`${onboarding_runs.version} + 1`,
        })
        .where(
          and(
            lt(onboarding_runs.expires_at, now),
            sql`${onboarding_runs.state} NOT IN ('active','cancelled','failed_terminal')`,
          ),
        )
        .returning({
          id: onboarding_runs.id,
          tenant_id: onboarding_runs.tenant_id,
          agent_id: onboarding_runs.agent_id,
          correlation_id: onboarding_runs.correlation_id,
          current_step: onboarding_runs.current_step,
        });
      for (const row of stale) {
        await appendEvent(tx, {
          run: row,
          step: row.current_step as OnboardingStep,
          event_type: 'expired',
          actor_id: 'system',
          actor_role: 'system',
          to_state: 'failed_terminal',
          error_code: 'run_expired',
        });
      }
      return stale.map((r) => ({ id: r.id }));
    });
  },
};

/**
 * Resumo do evento: só chaves de identificação e contadores. Corta qualquer
 * valor que não seja escalar curto — é a última barreira antes de um segredo
 * ou um dado pessoal entrar num registro append-only que ninguém apaga.
 */
function sanitizeSummary(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (key === PENDING) continue;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      out[key] = value;
      continue;
    }
    if (typeof value === 'string' && value.length <= 128) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Credencial de bootstrap global (114)
// ---------------------------------------------------------------------------

/** Tentativas erradas antes do lockout. */
export const BOOTSTRAP_MAX_ATTEMPTS = 5;
export const BOOTSTRAP_LOCKOUT_MS = 15 * 60_000;

export type BootstrapConsumeResult =
  | { ok: true; credential: BootstrapCredentialRow }
  | { ok: false; reason: 'invalid' | 'expired' | 'consumed' | 'locked' };

export const bootstrapCredentialsRepo = {
  /**
   * Emite a credencial. Recebe APENAS o hash — o segredo em claro nunca chega
   * ao banco, e quem o gerou (`scripts/bootstrap-credential.ts`) o imprime uma
   * vez e o esquece.
   */
  async issue(args: {
    secret_hash: string;
    label?: string | null;
    created_by: string;
    expires_at: Date;
  }): Promise<{ ok: true; credential: BootstrapCredentialRow } | { ok: false; reason: 'live_credential_exists' }> {
    try {
      const rows = await db
        .insert(bootstrap_credentials)
        .values({
          secret_hash: args.secret_hash,
          label: args.label ?? null,
          created_by: args.created_by,
          expires_at: args.expires_at,
        })
        .returning();
      return { ok: true as const, credential: rows[0]! };
    } catch (err) {
      if (pgErrorCode(err) === '23505') {
        return { ok: false as const, reason: 'live_credential_exists' as const };
      }
      throw err;
    }
  },

  async revokeLive(args: { reason: string; now?: Date }): Promise<number> {
    const now = args.now ?? new Date();
    const rows = await db
      .update(bootstrap_credentials)
      .set({ revoked_at: now, revoked_reason: args.reason })
      .where(and(isNull(bootstrap_credentials.consumed_at), isNull(bootstrap_credentials.revoked_at)))
      .returning({ id: bootstrap_credentials.id });
    return rows.length;
  },

  /** Existe credencial viva? Usado pela UI para explicar por que o bootstrap está fechado. */
  async hasLiveCredential(now: Date = new Date()): Promise<boolean> {
    const rows = await db
      .select({ id: bootstrap_credentials.id })
      .from(bootstrap_credentials)
      .where(
        and(
          isNull(bootstrap_credentials.consumed_at),
          isNull(bootstrap_credentials.revoked_at),
          gt(bootstrap_credentials.expires_at, now),
        ),
      )
      .limit(1);
    return rows.length > 0;
  },

  /**
   * CONSOME a credencial. O CAS (`consumed_at IS NULL`) é o que garante o
   * critério "corridas simultâneas criam no máximo um bootstrap válido": duas
   * requisições com o segredo certo serializam na row travada e só a primeira
   * a marca consumida.
   *
   * Tentativa errada não vaza nada: incrementa `attempts` da credencial VIVA
   * (se houver) e, no limite, tranca por `locked_until`. Sem lockout o hash
   * viraria um oráculo de força bruta com resposta binária instantânea.
   */
  async consume(args: {
    secret_hash: string;
    run_id: string;
    now?: Date;
    max_attempts?: number;
    lockout_ms?: number;
  }): Promise<BootstrapConsumeResult> {
    const now = args.now ?? new Date();
    const maxAttempts = args.max_attempts ?? BOOTSTRAP_MAX_ATTEMPTS;
    const lockoutMs = args.lockout_ms ?? BOOTSTRAP_LOCKOUT_MS;
    return withTx(async (tx) => {
      const liveRows = await tx
        .select()
        .from(bootstrap_credentials)
        .where(and(isNull(bootstrap_credentials.consumed_at), isNull(bootstrap_credentials.revoked_at)))
        .limit(1)
        .for('update');
      const live = liveRows[0] ?? null;
      if (!live) return { ok: false as const, reason: 'invalid' as const };
      if (live.locked_until && live.locked_until.getTime() > now.getTime()) {
        return { ok: false as const, reason: 'locked' as const };
      }
      if (live.secret_hash !== args.secret_hash) {
        const attempts = live.attempts + 1;
        await tx
          .update(bootstrap_credentials)
          .set({
            attempts,
            last_attempt_at: now,
            ...(attempts >= maxAttempts
              ? { locked_until: new Date(now.getTime() + lockoutMs) }
              : {}),
          })
          .where(eq(bootstrap_credentials.id, live.id));
        return { ok: false as const, reason: 'invalid' as const };
      }
      if (live.expires_at.getTime() <= now.getTime()) {
        return { ok: false as const, reason: 'expired' as const };
      }

      const consumed = await tx
        .update(bootstrap_credentials)
        .set({ consumed_at: now, consumed_by_run_id: args.run_id, last_attempt_at: now })
        .where(and(eq(bootstrap_credentials.id, live.id), isNull(bootstrap_credentials.consumed_at)))
        .returning();
      if (consumed.length === 0) return { ok: false as const, reason: 'consumed' as const };
      return { ok: true as const, credential: consumed[0]! };
    });
  },
};
