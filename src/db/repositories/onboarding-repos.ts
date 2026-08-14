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
import { db, pgErrorCode, withTx } from '../client.js';
import {
  admin_audit_log,
  onboarding_events,
  onboarding_runs,
  onboarding_step_results,
  tenants,
} from '../schema.js';
import type { OnboardingEventRow, OnboardingRunRow } from '../schema.js';
import { planTransition, type OnboardingState } from '@/onboarding/state-machine.js';
import { OnboardingError } from '@/onboarding/errors.js';
import { sanitizeForPersistence } from '@/onboarding/sanitize.js';

type Tx = Parameters<Parameters<typeof withTx>[0]>[0];

/**
 * Bucket de auditoria para trabalho SEM DONO AINDA. É um tenant de verdade,
 * semeado por `migrations/014_p0_seed_system_tenant.sql`, então satisfaz a FK.
 */
export const AUDIT_FALLBACK_TENANT = 'system';

/**
 * Os `event_type` que ESTE repo escreve em `onboarding_events`. A coluna tem
 * `CHECK (event_type IN (…))` na migration 109; um literal fora do CHECK é um
 * 23514 invisível para qualquer teste com store falso, então o conjunto vive
 * aqui, é usado nas escritas, e
 * `tests/unit/onboarding/schema-constraint-compatibility.spec.ts` o confronta
 * com o CHECK lido de `migrations/*.sql`.
 *
 * Não é o conjunto COMPLETO do CHECK: `step_failed` e `readiness_evaluated`
 * estão no schema para uso futuro e nenhuma escrita os emite hoje. A direção
 * que importa é código ⊆ schema.
 */
export const ONBOARDING_EVENT_TYPES = {
  RUN_CREATED: 'run_created',
  STEP_COMPLETED: 'step_completed',
  STEP_REPLAYED: 'step_replayed',
  STEP_DENIED: 'step_denied',
  RUN_CANCELLED: 'run_cancelled',
  RUN_COMPLETED: 'run_completed',
  RUN_EXPIRED: 'run_expired',
} as const;

/**
 * Ações que ESTE repo grava em `admin_audit_log`. A coluna não tem CHECK, e é
 * justamente por isso que o literal não pode ficar solto no call site: um typo
 * quebra a consulta da trilha em silêncio.
 *
 * A expiração reusa `RUN_CANCELLED`, a MESMA ação do cancelamento operado pelo
 * console (`cancel`, abaixo), porque a semântica é a mesma decisão terminal —
 * a run vai para `state='cancelled'`. O que muda é QUEM e POR QUÊ, e isso já
 * está nas colunas certas: `actor_id='system'` e
 * `change_summary.reason_code='expired'` (vocabulário fechado
 * `ONBOARDING_REASONS`, o mesmo que rotula a métrica). Uma ação nova obrigaria
 * quem audita "runs canceladas" a somar duas séries para responder uma
 * pergunta só.
 */
export const ONBOARDING_ADMIN_AUDIT_ACTIONS = {
  RUN_CANCELLED: 'onboarding_run_cancelled',
} as const;

/**
 * Resolve o `tenant_id` que pode ser gravado em `admin_audit_log`.
 *
 * `admin_audit_log.tenant_id` é `TEXT NOT NULL REFERENCES tenants(id)`
 * (`migrations/047_admin_audit_log.sql:10`) — uma FK, não apenas um NOT NULL.
 * E a saga audita ANTES de o tenant existir: numa run `tenant_onboarding` o
 * `tenant_id` da run é o tenant que a saga ainda VAI criar (`provision_tenant`
 * é um passo), então gravá-lo direto na coluna estourava 23503 na criação da
 * run e no cancelamento de uma run ainda em `created`.
 *
 * A resposta NÃO é enfraquecer a FK nem descartar o alvo: a linha vai para o
 * bucket `system` e o alvo PRETENDIDO é preservado em
 * `change_summary.target_tenant_id`. A trilha continua completa e atribuível —
 * "quem iniciou o onboarding do tenant X" é achável por
 * `change_summary->>'target_tenant_id'`, e o índice
 * `admin_audit_log_resource_idx` já resolve a busca pelo `resource_id` da run.
 *
 * O SELECT roda no MESMO `tx`, logo enxerga o tenant que `provision_tenant`
 * acabou de inserir nesta transação: do passo seguinte em diante a auditoria
 * volta a ser gravada sob o tenant real, sem nenhuma janela intermediária.
 */
async function resolveAuditTenant(tx: Tx, intended: string | null): Promise<string> {
  if (intended === null) return AUDIT_FALLBACK_TENANT;
  const rows = await tx
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, intended))
    .limit(1);
  return rows[0] ? intended : AUDIT_FALLBACK_TENANT;
}

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
  | {
      outcome: 'denied';
      run: OnboardingRunRow;
      code: string;
      message: string;
      /**
       * O CORPO da negativa — o mesmo `result` que o ledger persistiu
       * (`onboarding_step_results.result`). Um `deny` de `evaluate_readiness`
       * ou de `activate` NÃO é só um código: o relatório de readiness (cada
       * check com status, severidade, mensagem e remediação, e o veredito por
       * canal) é o que diz ao operador O QUE FAZER. Devolver code/message e
       * descartar o resto transformava a segunda resposta a uma mesma decisão
       * numa versão pior da primeira.
       *
       * Vem do ledger tanto no caminho novo quanto no replay, e por construção
       * é o MESMO valor nos dois — é o que faz "retry devolve o resultado
       * anterior" valer também para as recusas.
       */
      result: Record<string, unknown>;
      /**
       * `true` quando a negativa veio do LEDGER (retry da mesma chave após um
       * commit cujo resultado se perdeu), não de uma nova avaliação. Sem esta
       * distinção o wizard contaria duas recusas na métrica para uma única
       * decisão — e "quantas vezes o backend recusou" viraria "quantas vezes o
       * cliente perdeu a resposta".
       *
       * É também o que impede a AUDITORIA de duplicar: `audit_log` registra
       * DECISÕES, e um replay não é uma decisão nova. Ver
       * `emitAgentScopedAudit` em `src/onboarding/wizard.ts`.
       */
      replayed?: boolean;
    }
  | { outcome: 'not_found' };

/**
 * Os tipos de RESULTADO CONCLUSIVO que o ledger guarda
 * (`onboarding_step_results.outcome_kind`, migration 113).
 *
 * Antes o ledger só recebia `success`, e o efeito disso era a assimetria que a
 * review descreve: uma negativa avançava versão e estado sem deixar rastro
 * replayável, então o retry da MESMA chave recebia `version_conflict` (a versão
 * já era outra) em vez da negativa anterior — e a proteção contra reciclagem de
 * chave (`idempotency_payload_mismatch`) desaparecia justo no caminho de recusa.
 */
export const STEP_RESULT_OUTCOMES = {
  SUCCESS: 'success',
  DENIED: 'denied',
  CANCELLED: 'cancelled',
} as const;

/**
 * O pseudo-passo sob o qual o CANCELAMENTO entra no ledger de idempotência.
 *
 * `onboarding_step_results.step` não tem CHECK (ver migration 109), e o unique
 * `(run_id, step, idempotency_key_hash)` já é a chave certa — cancelar é um
 * comando conclusivo da run como qualquer outro. Não é um passo da máquina de
 * estados e por isso NÃO está em `ONBOARDING_STEPS`: nenhum `planTransition`
 * jamais o vê.
 */
export const CANCEL_LEDGER_STEP = 'cancel_run';

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

export type CreateRunInput = {
  kind: 'global_bootstrap' | 'tenant_onboarding';
  tenant_id: string | null;
  agent_id: string | null;
  created_by: string;
  actor_role: string;
  correlation_id: string;
  expires_at: Date;
  configuration_contract_version: string;
  schema_version: string;
  /** SHA-256 da idempotency key opaca do cliente. Obrigatória. */
  idempotency_key_hash: string;
  /** SHA-256 canônico do payload de criação (kind + escopo + metadata). */
  payload_hash: string;
  metadata?: Record<string, unknown>;
};

export type CreateRunOutcome =
  | { outcome: 'created'; run: OnboardingRunRow }
  /** Retry da MESMA chave: a run já materializada, sem segunda trilha. */
  | { outcome: 'replayed'; run: OnboardingRunRow }
  /** Mesma chave, payload divergente — a chave foi reciclada para outra intenção. */
  | { outcome: 'payload_conflict'; run: OnboardingRunRow }
  /** Já existe uma run VIVA para o escopo inicial, aberta com outra chave. */
  | { outcome: 'live_run_exists' };

/**
 * Uma linha do agregado de `expireStale`: quantas runs foram expiradas para um
 * `tenant_id + agent_id`. O par é NULLABLE porque a coluna é — a run de
 * `global_bootstrap` vence antes de existir tenant, e essa run PRECISA
 * continuar sendo expirada e contada.
 */
export type ExpiredRunScope = {
  readonly tenant_id: string | null;
  readonly agent_id: string | null;
  readonly total: number;
};

/**
 * Agregador de `expireStale`, isolado para que a chave composta (um par
 * nullable) não vire uma concatenação improvisada dentro do laço.
 *
 * A chave é `JSON.stringify([tenant, agent])`: `null` e a string `'null'` viram
 * chaves DIFERENTES (`[null,…]` vs `["null",…]`), e nenhum separador precisa ser
 * escapado. Um `${t}:${a}` colidiria `('a:b', 'c')` com `('a', 'b:c')` — improvável
 * com slugs, mas a colisão somaria escopos distintos numa série só, que é
 * exatamente o defeito que este agregado existe para corrigir.
 */
class ScopeTally {
  private readonly counts = new Map<
    string,
    { tenant_id: string | null; agent_id: string | null; total: number }
  >();
  private total = 0;

  add(tenant_id: string | null, agent_id: string | null): void {
    const key = JSON.stringify([tenant_id, agent_id]);
    const entry = this.counts.get(key);
    if (entry) entry.total += 1;
    else this.counts.set(key, { tenant_id, agent_id, total: 1 });
    this.total += 1;
  }

  /** `total` é somado à parte: a soma dos escopos e o total NÃO podem divergir. */
  result(): { total: number; by_scope: ExpiredRunScope[] } {
    return { total: this.total, by_scope: Array.from(this.counts.values()) };
  }
}

export const onboardingRunsRepo = {
  /**
   * Busca a run pela chave de criação, no ESCOPO INICIAL dela.
   *
   * O escopo entra na busca (e no índice único) porque a idempotency key é
   * opaca e escolhida pelo CLIENTE: duas sessões administrativas de tenants
   * diferentes podem legitimamente gerar a mesma chave, e deduplicá-las
   * globalmente devolveria a run de OUTRO tenant para quem fizesse retry — um
   * vazamento horizontal criado pela própria idempotência.
   */
  async findByCreationKey(input: {
    kind: string;
    tenant_id: string | null;
    idempotency_key_hash: string;
  }): Promise<OnboardingRunRow | null> {
    const rows = await db
      .select()
      .from(onboarding_runs)
      .where(
        and(
          eq(onboarding_runs.kind, input.kind),
          input.tenant_id === null
            ? isNull(onboarding_runs.tenant_id)
            : eq(onboarding_runs.tenant_id, input.tenant_id),
          eq(onboarding_runs.creation_idempotency_key_hash, input.idempotency_key_hash),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Criação IDEMPOTENTE da run (review do PR #541, achado 2).
   *
   * O comando que ABRE a saga é mutável como qualquer outro, e o contrato da
   * issue vale para ele: "cada comando mutável é idempotente" e "retry após
   * timeout devolve o resultado anterior". Antes não valia — cada retry, cada
   * duplo-clique no console, inseria outra run e outra trilha, e o único índice
   * existente (`onboarding_runs_one_live_per_agent_uq`) tem predicado
   * `agent_id IS NOT NULL`, isto é, não cobre a metade da saga que ainda não
   * criou o agente.
   *
   * A ordem aqui é a mesma do `commitStep`: LEDGER PRIMEIRO. A busca pela chave
   * acontece antes de qualquer escrita, e a corrida (dois retries simultâneos,
   * ambos sem encontrar nada) é resolvida pelo índice único — o perdedor recebe
   * 23505, relê pela chave e replaya a run do vencedor.
   */
  async create(input: CreateRunInput): Promise<CreateRunOutcome> {
    const previous = await this.findByCreationKey({
      kind: input.kind,
      tenant_id: input.tenant_id,
      idempotency_key_hash: input.idempotency_key_hash,
    });
    if (previous) {
      return previous.creation_payload_hash === input.payload_hash
        ? { outcome: 'replayed' as const, run: previous }
        : { outcome: 'payload_conflict' as const, run: previous };
    }

    try {
      return await this.insertRun(input);
    } catch (err) {
      if (pgErrorCode(err) !== '23505') throw err;
      // Ou perdemos a corrida da MESMA chave (replay), ou esbarramos no índice
      // de "uma run viva por escopo inicial" com uma chave DIFERENTE. Os dois
      // casos são 23505 e precisam de respostas opostas, então desempatamos
      // relendo pela chave.
      const raced = await this.findByCreationKey({
        kind: input.kind,
        tenant_id: input.tenant_id,
        idempotency_key_hash: input.idempotency_key_hash,
      });
      if (raced) {
        return raced.creation_payload_hash === input.payload_hash
          ? { outcome: 'replayed' as const, run: raced }
          : { outcome: 'payload_conflict' as const, run: raced };
      }
      return { outcome: 'live_run_exists' as const };
    }
  },

  async insertRun(input: CreateRunInput): Promise<{ outcome: 'created'; run: OnboardingRunRow }> {
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
          creation_idempotency_key_hash: input.idempotency_key_hash,
          creation_payload_hash: input.payload_hash,
        })
        .returning();
      if (!run) throw new OnboardingError('run_not_found', 'INSERT não devolveu a run');

      await tx.insert(onboarding_events).values({
        run_id: run.id,
        tenant_id: run.tenant_id,
        agent_id: run.agent_id,
        step: 'create_run',
        event_type: ONBOARDING_EVENT_TYPES.RUN_CREATED,
        actor_id: input.created_by,
        correlation_id: input.correlation_id,
        from_state: null,
        to_state: 'created',
        summary: sanitizeForPersistence({ kind: input.kind }),
      });

      // O tenant-alvo desta run AINDA NÃO EXISTE (`provision_tenant` é o passo
      // seguinte), e `admin_audit_log.tenant_id` é FK. Ver `resolveAuditTenant`:
      // a linha vai para o bucket `system` e o alvo fica em `change_summary`.
      await tx.insert(admin_audit_log).values({
        tenant_id: await resolveAuditTenant(tx, run.tenant_id),
        actor_id: input.created_by,
        actor_role: input.actor_role,
        action: 'onboarding_run_started',
        resource_type: 'onboarding_run',
        resource_id: run.id,
        change_summary: {
          kind: input.kind,
          correlation_id: input.correlation_id,
          run_id: run.id,
          target_tenant_id: run.tenant_id,
          target_agent_id: run.agent_id,
        },
      });

      return { outcome: 'created' as const, run };
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
          event_type: ONBOARDING_EVENT_TYPES.STEP_REPLAYED,
          actor_id: input.actor_id,
          correlation_id: input.correlation_id,
          idempotency_key_hash: input.idempotency_key_hash,
          from_state: run.state,
          to_state: run.state,
          summary: {},
        });
        // O ledger guarda resultados conclusivos TIPADOS (migration 113): uma
        // negativa replayada devolve a MESMA negativa, com o mesmo código e a
        // mesma mensagem. Devolver `replayed`/`committed` aqui — como o código
        // anterior faria se a linha existisse — transformaria uma recusa em
        // sucesso na segunda tentativa.
        if (previous.outcome_kind === STEP_RESULT_OUTCOMES.DENIED) {
          return {
            outcome: 'denied' as const,
            run,
            code: previous.outcome_code ?? 'readiness_blocked',
            message: previous.outcome_message ?? 'passo recusado',
            // O CORPO da negativa também sai do ledger. Sem isto o replay de
            // uma recusa de readiness devolvia só code/message: o relatório e a
            // remediação — a única parte acionável da resposta — sumiam na
            // segunda tentativa, e o operador que perdeu a primeira resposta
            // ficava sabendo que foi recusado sem saber por quê.
            result: (previous.result ?? {}) as Record<string, unknown>,
            replayed: true,
          };
        }
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

      // (5) Transição validada contra o estado TRAVADO — e, quando a origem é
      // `failed_retryable`, contra o PONTO DE RETOMADA gravado na mesma row
      // travada. É por isso que `failed_step` viaja daqui e não do chamador:
      // qualquer coisa lida fora do lock seria TOCTOU.
      let plan;
      try {
        plan = planTransition({
          step: input.step,
          from: run.state as OnboardingState,
          retry_point: { failed_step: run.failed_step, resume_state: run.resume_state },
        });
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
        // O LEDGER PRIMEIRO, e ANTES de mexer em versão/estado: uma negativa é
        // um resultado CONCLUSIVO. Sem esta linha, o retry da mesma chave caía
        // na checagem de versão (já incrementada) e recebia `version_conflict`
        // em vez da negativa anterior — e a mesma chave com payload diferente
        // deixava de produzir `idempotency_payload_mismatch`.
        // O MESMO valor vai para o ledger e para a resposta. Se a negativa
        // devolvesse `applied.result` cru e persistisse o sanitizado, a
        // primeira resposta e o replay dela divergiriam — e a divergência só
        // apareceria no retry, que é o caminho menos exercitado.
        const deniedResult = sanitizeForPersistence(applied.result);

        await tx.insert(onboarding_step_results).values({
          run_id: run.id,
          tenant_id: nextTenant,
          step: input.step,
          idempotency_key_hash: input.idempotency_key_hash,
          payload_hash: input.payload_hash,
          result: deniedResult,
          outcome_kind: STEP_RESULT_OUTCOMES.DENIED,
          outcome_code: applied.deny.code,
          outcome_message: applied.deny.message,
        });

        // Ponto de retomada (migration 113). Só faz sentido quando a negativa
        // leva a `failed_retryable`: os estados de negativa PRÓPRIOS
        // (`readiness_failed`) já dizem qual passo reexecutar pelo seu nome, e
        // gravar um `failed_step` neles autorizaria retomadas que a máquina de
        // estados não pretende.
        const retryPoint =
          plan.onDeny === 'failed_retryable'
            ? { failed_step: input.step, resume_state: run.state }
            : { failed_step: null, resume_state: null };

        const [denied] = await tx
          .update(onboarding_runs)
          .set({
            state: plan.onDeny,
            current_step: input.step,
            version: run.version + 1,
            last_error_code: applied.deny.code,
            updated_at: now,
            ...retryPoint,
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
          event_type: ONBOARDING_EVENT_TYPES.STEP_DENIED,
          actor_id: input.actor_id,
          correlation_id: input.correlation_id,
          idempotency_key_hash: input.idempotency_key_hash,
          from_state: run.state,
          to_state: plan.onDeny,
          summary: sanitizeForPersistence({ ...(applied.summary ?? {}), code: applied.deny.code }),
        });

        await tx.insert(admin_audit_log).values({
          tenant_id: await resolveAuditTenant(tx, nextTenant),
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
            target_tenant_id: nextTenant,
            target_agent_id: nextAgent,
            correlation_id: input.correlation_id,
          },
        });

        return {
          outcome: 'denied' as const,
          run: denied ?? run,
          code: applied.deny.code,
          message: applied.deny.message,
          result: deniedResult,
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
        outcome_kind: STEP_RESULT_OUTCOMES.SUCCESS,
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
          // O passo commitou: o ponto de retomada anterior deixou de existir.
          // Mantê-lo autorizaria, depois de uma falha futura em OUTRO passo, o
          // retry de um passo já superado.
          failed_step: null,
          resume_state: null,
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
        event_type: applied.completes
          ? ONBOARDING_EVENT_TYPES.RUN_COMPLETED
          : ONBOARDING_EVENT_TYPES.STEP_COMPLETED,
        actor_id: input.actor_id,
        correlation_id: input.correlation_id,
        idempotency_key_hash: input.idempotency_key_hash,
        from_state: run.state,
        to_state: plan.to,
        summary: sanitizeForPersistence(applied.summary ?? {}),
      });

      await tx.insert(admin_audit_log).values({
        // Depois de `provision_tenant` o tenant existe NESTE `tx`, então esta
        // linha é gravada sob o tenant real. Antes dele, cai no bucket.
        tenant_id: await resolveAuditTenant(tx, nextTenant),
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
    /** SHA-256 da idempotency key opaca do cliente. Obrigatória — ver abaixo. */
    idempotency_key_hash: string;
    /** SHA-256 canônico de `{ reason_code }`. */
    payload_hash: string;
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

      // LEDGER ANTES do estado terminal e ANTES da versão — a mesma ordem do
      // `commitStep`, e pelo mesmo motivo. O cancelamento é um comando mutável:
      // se a resposta se perde, o cliente repete com a MESMA chave. Sem esta
      // consulta o retry via o estado já `cancelled` e recebia `run_terminal`,
      // isto é, um ERRO para uma operação que na verdade tinha dado certo.
      const ledger = await tx
        .select()
        .from(onboarding_step_results)
        .where(
          and(
            eq(onboarding_step_results.run_id, run.id),
            eq(onboarding_step_results.step, CANCEL_LEDGER_STEP),
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
          step: CANCEL_LEDGER_STEP,
          event_type: ONBOARDING_EVENT_TYPES.STEP_REPLAYED,
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
      const cancelResult = { cancelled_at: now.toISOString(), reason_code: input.reason_code };

      await tx.insert(onboarding_step_results).values({
        run_id: run.id,
        tenant_id: run.tenant_id,
        step: CANCEL_LEDGER_STEP,
        idempotency_key_hash: input.idempotency_key_hash,
        payload_hash: input.payload_hash,
        result: sanitizeForPersistence(cancelResult),
        outcome_kind: STEP_RESULT_OUTCOMES.CANCELLED,
        outcome_code: input.reason_code,
        outcome_message: 'run cancelada pelo operador',
      });

      const [cancelled] = await tx
        .update(onboarding_runs)
        .set({
          state: 'cancelled',
          version: run.version + 1,
          cancelled_at: now,
          updated_at: now,
          last_error_code: input.reason_code,
          // Uma run cancelada é terminal: não há o que retomar.
          failed_step: null,
          resume_state: null,
        })
        .where(and(eq(onboarding_runs.id, run.id), eq(onboarding_runs.version, run.version)))
        .returning();

      await tx.insert(onboarding_events).values({
        run_id: run.id,
        tenant_id: run.tenant_id,
        agent_id: run.agent_id,
        step: run.current_step ?? 'cancel',
        event_type: ONBOARDING_EVENT_TYPES.RUN_CANCELLED,
        actor_id: input.actor_id,
        correlation_id: input.correlation_id,
        from_state: run.state,
        to_state: 'cancelled',
        summary: sanitizeForPersistence({ reason_code: input.reason_code }),
      });

      // Cancelar uma run ainda em `created` acontece ANTES de `provision_tenant`:
      // o tenant-alvo não existe e a FK recusaria. Mesmo tratamento da criação.
      await tx.insert(admin_audit_log).values({
        tenant_id: await resolveAuditTenant(tx, run.tenant_id),
        actor_id: input.actor_id,
        actor_role: input.actor_role,
        action: 'onboarding_run_cancelled',
        resource_type: 'onboarding_run',
        resource_id: run.id,
        change_summary: {
          run_id: run.id,
          from_state: run.state,
          reason_code: input.reason_code,
          target_tenant_id: run.tenant_id,
          target_agent_id: run.agent_id,
          correlation_id: input.correlation_id,
        },
      });

      return {
        outcome: 'committed' as const,
        run: cancelled ?? run,
        // O MESMO objeto que o replay devolverá: o retry pós-commit precisa
        // enxergar a resposta original, não um `{}` que o cliente não sabe ler.
        result: sanitizeForPersistence(cancelResult),
      };
    });
  },

  /**
   * Varredura de runs vencidas. Marca `cancelled` com
   * `last_error_code='expired'` — nunca apaga: uma run abandonada precisa
   * continuar diagnosticável (critério de aceite da issue).
   *
   * DEVOLVE UM AGREGADO LIMITADO POR ESCOPO, não uma contagem (decisão do dono
   * na revisão de #555). O motivo é de observabilidade e não de conveniência:
   * `maia_onboarding_run_cancelled_total{reason="expired"}` é a MESMA série que
   * o cancelamento pelo console emite (`src/onboarding/wizard.ts:595`), e
   * aquele caminho a atribui ao `tenant_id + agent_id` da run. Com só a
   * contagem, o varredor não tinha como fazer o mesmo e a metade dele saía sob
   * `system`: duas fontes da mesma série com atribuição diferente, e um
   * dashboard por tenant que mente sobre quem foi cancelado.
   *
   * `by_scope` traz o par TRAVADO (lido de dentro da transação, depois do
   * `FOR UPDATE`), então é o escopo que realmente foi cancelado — não o que a
   * varredura enxergou antes da trava. O par continua `null | null` para a run
   * de `global_bootstrap`, que vence antes de existir tenant: quem traduz
   * ausência de escopo em bucket de métrica é o EMISSOR, não este repositório
   * (aqui `null` é o dado; `'system'` seria uma decisão de rotulagem).
   */
  async expireStale(
    now: Date = new Date(),
    limit = 100,
  ): Promise<{ total: number; by_scope: ExpiredRunScope[] }> {
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
    if (stale.length === 0) return { total: 0, by_scope: [] };

    const tally = new ScopeTally();
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
          return null;
        }
        await tx
          .update(onboarding_runs)
          .set({
            state: 'cancelled',
            version: run.version + 1,
            cancelled_at: now,
            updated_at: now,
            last_error_code: 'expired',
            // Terminal: não há ponto de retomada a preservar.
            failed_step: null,
            resume_state: null,
          })
          .where(and(eq(onboarding_runs.id, run.id), eq(onboarding_runs.version, run.version)));
        await tx.insert(onboarding_events).values({
          run_id: run.id,
          tenant_id: run.tenant_id,
          agent_id: run.agent_id,
          step: run.current_step ?? 'expire',
          event_type: ONBOARDING_EVENT_TYPES.RUN_EXPIRED,
          actor_id: 'system',
          from_state: run.state,
          to_state: 'cancelled',
          summary: {},
        });
        // O evento acima reconstrói o WORKFLOW; ele NÃO é a trilha de
        // governança (o cabeçalho deste arquivo é explícito). A expiração é
        // uma decisão TERMINAL do backend, com mutação durável e sem operador
        // por perto — exatamente o caso da invariante MUST nº 4 do AGENTS.md.
        // Vai no MESMO `tx`: auditoria que sobrevive ao rollback do UPDATE
        // seria trilha de uma expiração que não aconteceu.
        //
        // A tabela é `admin_audit_log`, e não `audit_log`, pelo motivo que
        // vale para a saga inteira: `audit_log.agent_id` é FK para `agents` e
        // metade das runs vence ANTES de o agente existir (a de
        // `global_bootstrap` nem tenant tem). O alvo pretendido fica em
        // `change_summary`, como no cancelamento e na criação.
        await tx.insert(admin_audit_log).values({
          tenant_id: await resolveAuditTenant(tx, run.tenant_id),
          actor_id: 'system',
          actor_role: 'system',
          action: ONBOARDING_ADMIN_AUDIT_ACTIONS.RUN_CANCELLED,
          resource_type: 'onboarding_run',
          resource_id: run.id,
          change_summary: {
            run_id: run.id,
            kind: run.kind,
            from_state: run.state,
            reason_code: 'expired',
            target_tenant_id: run.tenant_id,
            target_agent_id: run.agent_id,
            // A REGRA e o DADO a que ela foi aplicada: venceu em X, varrido
            // em Y. Sem isso a linha diz "expirou" sem dizer por quê.
            expires_at: run.expires_at.toISOString(),
            expired_at: now.toISOString(),
            swept_by: 'onboarding_expirer',
          },
        });
        // O par TRAVADO. Devolver `run.tenant_id`/`run.agent_id` (e não o que
        // o SELECT da varredura viu) é o que faz a atribuição corresponder ao
        // que foi de fato cancelado: entre o SELECT e a trava, um passo da
        // saga pode ter resolvido o tenant.
        return { tenant_id: run.tenant_id, agent_id: run.agent_id };
      });
      // `null` = a corrida perdeu a disputa (run já terminal sob a trava).
      // Nada foi escrito, então nada é contado — nem no total, nem no escopo.
      if (done) tally.add(done.tenant_id, done.agent_id);
    }
    return tally.result();
  },

  /**
   * BACKLOG da varredura: quantas runs já venceram e ainda não foram expiradas,
   * e há quanto tempo a mais atrasada esperava.
   *
   * O predicado é EXATAMENTE o de `expireStale` — as mesmas linhas que o
   * próximo tick pegaria. Um backlog medido com outro predicado responderia
   * outra pergunta.
   *
   * Por que este agregado existe (issue #519, decisão do dono): sem ele, um
   * backlog maior que a vazão é INVISÍVEL. O worker drena 1.200 runs/hora, a
   * série de cancelamento sobe, `maia_worker_run_total{status="ok"}` sobe — e a
   * fila cresce o tempo todo. Contagem e idade juntas porque separadas mentem:
   * uma contagem parada no teto do lote não distingue "empatando" de
   * "perdendo", e uma idade alta sozinha não distingue uma run presa (que o
   * `FOR UPDATE` nunca solta) de mil runs atrasadas.
   *
   * SEM recorte por tenant, e isto é deliberado: é a profundidade de uma FILA
   * GLOBAL de housekeeping — o mesmo desenho de
   * `maia_scheduler_backlog{queue}` (`src/observability/runtime-collectors.ts`)
   * e de `turnRepos.snapshotLiveTurnStates()`. O escopo mora no agregado, e só
   * números saem da query: nenhum id, nenhum payload, nenhum identificador de
   * tenant atravessa a fronteira, então o agregado cross-tenant não vira
   * leitura de dado de ninguém. Quem precisa saber DE QUEM é a run atrasada
   * tem a run, o evento e a auditoria.
   */
  async snapshotExpiryBacklog(
    now: Date = new Date(),
  ): Promise<{ backlog: number; oldest_age_seconds: number }> {
    const rows = await db
      .select({
        backlog: sql<string>`count(*)::text`,
        // EPOCH em vez do timestamp cru: o driver devolveria `min(...)` em um
        // formato dependente de tipo/parser, e uma idade errada é pior que
        // ausente. Segundos desde a época são um número e só.
        oldest_expires_epoch: sql<
          string | null
        >`EXTRACT(EPOCH FROM min(${onboarding_runs.expires_at}))::text`,
      })
      .from(onboarding_runs)
      .where(
        and(
          lt(onboarding_runs.expires_at, now),
          notInArray(onboarding_runs.state, [...TERMINAL_STATES]),
        ),
      );
    const row = rows[0];
    const backlog = Number(row?.backlog ?? 0);
    const epoch = row?.oldest_expires_epoch;
    if (!Number.isFinite(backlog) || backlog === 0 || epoch === null || epoch === undefined) {
      return { backlog: Number.isFinite(backlog) ? backlog : 0, oldest_age_seconds: 0 };
    }
    // Relógio INJETADO, o mesmo contra o qual o predicado foi avaliado — sem
    // isso a idade poderia sair negativa num teste com clock fixo.
    const age = now.getTime() / 1000 - Number(epoch);
    return { backlog, oldest_age_seconds: Math.max(0, Math.round(age)) };
  },
};
