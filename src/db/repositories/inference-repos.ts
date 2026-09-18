/**
 * P06 (spec §9.1, §9.2) — repositório do LEDGER do gateway de inferência:
 * grant, admissão com reserva, liquidação e revogação.
 *
 * As mesmas regras do `engine-repos.ts`:
 *
 *  1. **Escopo vem do ALS.** Todo WHERE carrega `tenant_id + agent_id` de
 *     `scope()`. A ÚNICA exceção é `resolveGrantScope`: a credencial chega
 *     antes de haver tenant, e é ela que diz qual tenant abrir. Ela devolve só
 *     o par de escopo e o id — como `enumerateDueScopes`.
 *  2. **Zero rows é resultado tipado.** Perder corrida devolve `{ ok: false }`.
 *  3. **Nenhuma TX durante I/O.** A admissão comita a reserva ANTES do provider;
 *     a liquidação é outra TX, depois.
 *  4. **Ordem de locks** (a do journal, estendida): `conversation_controls` →
 *     `engine_runs` → `engine_inference_grants` → `engine_budget_accounts` →
 *     `engine_inference_attempts`. Sem caminho inverso.
 *
 * O que decide está nos módulos PUROS (`inference-gateway.ts`,
 * `cost-reservation.ts`); aqui eles recebem o estado LIDO SOB LOCK, dentro da
 * transação que grava a reserva. Decidir fora da TX e gravar dentro seria
 * decidir sobre um estado que já pode ter mudado.
 */
import { sql } from "drizzle-orm";
import { incCounter } from "@/lib/metrics.js";
import {
  applyAdmission,
  decideAdmission,
  type AdmissionPolicyV1,
  type BudgetAccountV1,
} from "@/integrations/hermes/cost-reservation.js";
import type { UsageSource } from "@/integrations/hermes/cost-accounting.js";
import {
  hashInferenceToken,
  mintInferenceToken,
} from "@/integrations/hermes/inference-credential.js";
import {
  validateInferenceGrant,
  type InferenceErrorCode,
  type InferenceGrantV1,
} from "@/integrations/hermes/inference-gateway.js";
import type { EngineRunPhaseV1 } from "@/runtime/engines/contracts.js";
import { db, withTx } from "../client.js";
import { lockControlByRunSql, type ConversationControlLockRow } from "./conversation-control-sql.js";
import {
  engine_budget_accounts,
  engine_inference_attempts,
  engine_inference_grants,
  engine_runs,
  engine_usage_events,
} from "../schema.js";
import { getCurrentAgent, getCurrentTenant } from "../tenant-context.js";

type Executor = typeof db;

function scope(): { tenant_id: string; agent_id: string } {
  return { tenant_id: getCurrentTenant(), agent_id: getCurrentAgent() };
}

function linhas<T>(res: { rows: unknown }): T[] {
  return Array.from(res.rows as unknown as T[]);
}

function conta(op: string, result: string): void {
  incCounter("maia_hermes_inference_ops_total", { op, result });
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type IssueGrantResult =
  | { ok: true; grant_id: string; token: string; expires_at: string }
  | { ok: false; reason: "run_not_found" | "run_revoked" | "run_closed" };

/** O que a rota precisa saber do grant ANTES de admitir (fora de TX). */
export interface InferenceGrantStateV1 {
  grant_id: string;
  /** Para `validateInferenceGrant`. `revoked_at` já dobra a revogação do run. */
  grant: InferenceGrantV1;
  /** nome da tool -> digest canônico do input_schema. */
  tool_surface: Record<string, string>;
  max_output_tokens: number;
  run_phase: EngineRunPhaseV1;
  run_manifest_digest: string;
  run_deadline_at: string;
  calls_so_far: number;
  /** Conversa em `bot` e epoch do controle e do run iguais ao do grant. */
  control_ok: boolean;
  now: string;
}

export type AdmitAttemptResult =
  | {
      ok: true;
      attempt_id: string;
      attempt_seq: number;
      /** `null` = admitido sem preço (policy `admit_unpriced`). */
      reserved_microusd: string | null;
    }
  | { ok: false; code: InferenceErrorCode; audit_reason: string };

export type SettleOutcomeV1 =
  /** Comprovadamente não saiu: libera a reserva. */
  | { kind: "not_sent"; error_code: string }
  /** Resposta recebida. `cost_microusd` null = custo desconhecido. */
  | {
      kind: "completed";
      prompt_tokens: number | null;
      completion_tokens: number | null;
      cost_microusd: string | null;
      source: UsageSource;
    }
  /** Saiu (ou pode ter saído) e não voltou íntegro: exposição fica. */
  | { kind: "failed_after_send"; error_code: string };

export type SettleAttemptResult =
  | { ok: true; already: boolean; accounting_status: string }
  | { ok: false; reason: "not_found" };

// ---------------------------------------------------------------------------
// Linhas
// ---------------------------------------------------------------------------

type GrantRow = {
  id: string;
  run_id: string;
  audience: string;
  model: string;
  control_epoch: string;
  manifest_digest: string;
  tool_surface: Record<string, string>;
  max_inference_calls: number;
  max_output_tokens: number;
  expires_at: string;
  revoked_at: string | null;
  tenant_id: string;
  agent_id: string;
};

type RunRow = {
  phase: string;
  control_epoch: string;
  manifest_digest: string;
  deadline_at: string;
  capabilities_revoked_at: string | null;
};

/**
 * Instante em ISO-8601 UTC gerado PELO POSTGRES. O `::text` de `timestamptz`
 * sai como `2026-09-18 17:20:27.123+00`, que `Date.parse` não garante ler; as
 * funções puras recebem ISO.
 */
const ISO = (col: string) =>
  sql.raw(`to_char((${col}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

const GRANT_COLS = sql`id, run_id, audience, model, control_epoch::text AS control_epoch,
  manifest_digest, tool_surface, max_inference_calls, max_output_tokens,
  ${ISO("expires_at")} AS expires_at, ${ISO("revoked_at")} AS revoked_at, tenant_id, agent_id`;

const RUN_COLS = sql`phase, control_epoch::text AS control_epoch, manifest_digest,
  ${ISO("deadline_at")} AS deadline_at,
  ${ISO("capabilities_revoked_at")} AS capabilities_revoked_at`;

function grantV1(g: GrantRow, run: RunRow): InferenceGrantV1 {
  return {
    run_id: g.run_id,
    tenant_id: g.tenant_id,
    agent_id: g.agent_id,
    control_epoch: g.control_epoch,
    audience: g.audience,
    model: g.model,
    manifest_digest: g.manifest_digest,
    allowed_tool_names: Object.keys(g.tool_surface),
    expires_at: g.expires_at,
    // Revogar o run revoga o grant: a revogação do journal fecha a inferência.
    revoked_at: g.revoked_at ?? run.capabilities_revoked_at,
    max_inference_calls: g.max_inference_calls,
  };
}

async function agoraDb(tx: Executor): Promise<string> {
  const r = linhas<{ agora: string }>(
    await tx.execute(sql`SELECT ${ISO("clock_timestamp()")} AS agora`),
  );
  return r[0]!.agora;
}

async function contarTentativas(tx: Executor, run_id: string): Promise<number> {
  const { tenant_id, agent_id } = scope();
  const r = linhas<{ n: string | number }>(
    await tx.execute(sql`
      SELECT count(*) AS n FROM ${engine_inference_attempts}
       WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND run_id = ${run_id}`),
  );
  return Number(r[0]?.n ?? 0);
}

function controleOk(
  controle: ConversationControlLockRow | null,
  run: RunRow,
  grant: GrantRow,
): boolean {
  return (
    controle !== null &&
    controle.mode === "bot" &&
    controle.control_epoch === grant.control_epoch &&
    run.control_epoch === grant.control_epoch
  );
}

// ---------------------------------------------------------------------------
// Repositório
// ---------------------------------------------------------------------------

export const inferenceRepo = {
  /**
   * Emite a credencial do run. `control_epoch` e `manifest_digest` vêm do RUN,
   * não de quem chama: o grant vale para aquele epoch e aquele manifest.
   * Devolve o token UMA vez; o banco só guarda a hash.
   */
  async issueGrant(input: {
    run_id: string;
    audience: string;
    model: string;
    tool_surface: Record<string, string>;
    max_inference_calls: number;
    max_output_tokens: number;
    ttl_ms: number;
  }): Promise<IssueGrantResult> {
    const { tenant_id, agent_id } = scope();
    const token = mintInferenceToken();
    return withTx(async (tx): Promise<IssueGrantResult> => {
      const runs = linhas<RunRow>(
        await tx.execute(sql`
          SELECT ${RUN_COLS} FROM ${engine_runs}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
           FOR SHARE`),
      );
      const run = runs[0];
      if (!run) {
        conta("issue_grant", "run_not_found");
        return { ok: false, reason: "run_not_found" };
      }
      if (run.capabilities_revoked_at !== null) {
        conta("issue_grant", "run_revoked");
        return { ok: false, reason: "run_revoked" };
      }
      if (run.phase === "closed") {
        conta("issue_grant", "run_closed");
        return { ok: false, reason: "run_closed" };
      }
      const rows = linhas<{ id: string; expires_at: string }>(
        await tx.execute(sql`
          INSERT INTO ${engine_inference_grants}
            (tenant_id, agent_id, run_id, token_hash, audience, model, control_epoch,
             manifest_digest, tool_surface, max_inference_calls, max_output_tokens, expires_at)
          VALUES (${tenant_id}, ${agent_id}, ${input.run_id}, ${hashInferenceToken(token)},
                  ${input.audience}, ${input.model}, ${run.control_epoch}::bigint,
                  ${run.manifest_digest}, ${JSON.stringify(input.tool_surface)}::jsonb,
                  ${input.max_inference_calls}, ${input.max_output_tokens},
                  clock_timestamp() + make_interval(secs => ${input.ttl_ms / 1000}))
          RETURNING id, ${ISO("expires_at")} AS expires_at`),
      );
      conta("issue_grant", "ok");
      return { ok: true, grant_id: rows[0]!.id, token, expires_at: rows[0]!.expires_at };
    });
  },

  /**
   * CROSS-TENANT, e é a única operação assim: hash da credencial → escopo.
   * Devolve só o par de escopo e o id; quem chama abre o ALS com eles.
   */
  async resolveGrantScope(
    token_hash: string,
  ): Promise<{ grant_id: string; tenant_id: string; agent_id: string } | null> {
    const rows = linhas<{ id: string; tenant_id: string; agent_id: string }>(
      await db.execute(sql`
        SELECT id, tenant_id, agent_id FROM ${engine_inference_grants}
         WHERE token_hash = ${token_hash}
         LIMIT 1`),
    );
    const g = rows[0];
    conta("resolve_grant", g ? "ok" : "absent");
    return g ? { grant_id: g.id, tenant_id: g.tenant_id, agent_id: g.agent_id } : null;
  },

  /** Estado do grant para as validações da rota. Sem lock: a admissão relê. */
  async loadGrantState(grant_id: string): Promise<InferenceGrantStateV1 | null> {
    const { tenant_id, agent_id } = scope();
    const grants = linhas<GrantRow>(
      await db.execute(sql`
        SELECT ${GRANT_COLS} FROM ${engine_inference_grants}
         WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${grant_id}`),
    );
    const g = grants[0];
    if (!g) return null;
    const runs = linhas<RunRow>(
      await db.execute(sql`
        SELECT ${RUN_COLS} FROM ${engine_runs}
         WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${g.run_id}`),
    );
    const run = runs[0];
    if (!run) return null;
    const controles = linhas<ConversationControlLockRow>(
      await db.execute(sql`
        SELECT c.id, c.mode, c.control_epoch::text AS control_epoch
          FROM conversation_controls c
          JOIN ${engine_runs} r
            ON r.tenant_id = c.tenant_id AND r.agent_id = c.agent_id AND r.control_id = c.id
         WHERE r.tenant_id = ${tenant_id} AND r.agent_id = ${agent_id} AND r.id = ${g.run_id}`),
    );
    return {
      grant_id: g.id,
      grant: grantV1(g, run),
      tool_surface: g.tool_surface,
      max_output_tokens: g.max_output_tokens,
      run_phase: run.phase as EngineRunPhaseV1,
      run_manifest_digest: run.manifest_digest,
      run_deadline_at: run.deadline_at,
      calls_so_far: await contarTentativas(db, g.run_id),
      control_ok: controleOk(controles[0] ?? null, run, g),
      now: await agoraDb(db),
    };
  },

  /**
   * A transação de admissão do §9.2: trava controle, run, grant e conta na
   * ordem do módulo; revalida autoridade e limites sobre o estado travado;
   * reserva; grava a tentativa. Comita ANTES do provider.
   */
  async admitAttempt(input: {
    grant_id: string;
    attempt_id: string;
    request_hash: string;
    provider: string;
    presented_audience: string;
    model_requested: string;
    tool_names_requested: readonly string[];
    estimate_microusd: string | null;
    tariff_version: string | null;
    policy: AdmissionPolicyV1;
  }): Promise<AdmitAttemptResult> {
    const { tenant_id, agent_id } = scope();
    return withTx(async (tx): Promise<AdmitAttemptResult> => {
      const recusa = (code: InferenceErrorCode, audit_reason: string): AdmitAttemptResult => {
        conta("admit", audit_reason);
        return { ok: false, code, audit_reason };
      };

      // Sem lock: só descobre de qual run é o grant, para travar na ordem.
      const alvo = linhas<{ run_id: string }>(
        await tx.execute(sql`
          SELECT run_id FROM ${engine_inference_grants}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.grant_id}`),
      );
      const run_id = alvo[0]?.run_id;
      if (!run_id) return recusa("invalid_inference_grant", "absent");

      const controle =
        linhas<ConversationControlLockRow>(
          await tx.execute(lockControlByRunSql({ tenant_id, agent_id, run_id })),
        )[0] ?? null;
      const run = linhas<RunRow>(
        await tx.execute(sql`
          SELECT ${RUN_COLS} FROM ${engine_runs}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${run_id}
           FOR UPDATE`),
      )[0];
      const grant = linhas<GrantRow>(
        await tx.execute(sql`
          SELECT ${GRANT_COLS} FROM ${engine_inference_grants}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.grant_id}
           FOR UPDATE`),
      )[0];
      if (!run || !grant) return recusa("invalid_inference_grant", "absent");

      const now = await agoraDb(tx);
      const calls_so_far = await contarTentativas(tx, run_id);
      const validacao = validateInferenceGrant(grantV1(grant, run), {
        presented_audience: input.presented_audience,
        now,
        run_phase: run.phase as EngineRunPhaseV1,
        calls_so_far,
        model_requested: input.model_requested,
        manifest_digest_effective: run.manifest_digest,
        tool_names_requested: input.tool_names_requested,
      });
      if (validacao.kind === "refused") return recusa(validacao.code, validacao.audit_reason);
      // O que o módulo puro não enxerga: controle humano/epoch e o prazo do run.
      if (!controleOk(controle, run, grant)) return recusa("run_revoked", "control_changed");
      if (Date.parse(now) >= Date.parse(run.deadline_at)) {
        return recusa("run_not_active", "deadline_passed");
      }

      const contaRows = linhas<{
        id: string;
        limit_microusd: string;
        reserved_microusd: string;
        settled_microusd: string;
        row_version: number | string;
      }>(
        await tx.execute(sql`
          SELECT id, limit_microusd::text AS limit_microusd,
                 reserved_microusd::text AS reserved_microusd,
                 settled_microusd::text AS settled_microusd, row_version
            FROM ${engine_budget_accounts}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND currency = 'microusd'
             AND period_start_utc = (clock_timestamp() AT TIME ZONE 'UTC')::date
           FOR UPDATE`),
      );
      const linhaConta = contaRows[0];
      const account: BudgetAccountV1 | null = linhaConta
        ? {
            limit_microusd: linhaConta.limit_microusd,
            reserved_microusd: linhaConta.reserved_microusd,
            settled_microusd: linhaConta.settled_microusd,
            row_version: Number(linhaConta.row_version),
          }
        : null;

      let decisao: ReturnType<typeof decideAdmission>;
      try {
        decisao = decideAdmission(
          account,
          {
            estimate_microusd: input.estimate_microusd,
            calls_so_far,
            max_inference_calls: grant.max_inference_calls,
          },
          input.policy,
        );
      } catch {
        // Valor monetário fora do formato: não admitir é o único desfecho seguro.
        return recusa("admission_unavailable", "money_format");
      }
      if (decisao.kind === "refuse") return recusa(decisao.code, `admission_${decisao.code}`);
      if (!account || !linhaConta) return recusa("admission_unavailable", "no_account");

      const proxima = applyAdmission(account, decisao);
      const atualizada = linhas<{ id: string }>(
        await tx.execute(sql`
          UPDATE ${engine_budget_accounts}
             SET reserved_microusd = ${proxima.reserved_microusd}::bigint,
                 row_version = ${proxima.row_version},
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND id = ${linhaConta.id} AND row_version = ${account.row_version}
           RETURNING id`),
      );
      if (!atualizada[0]) return recusa("admission_unavailable", "account_cas");

      const attempt_seq = calls_so_far + 1;
      await tx.execute(sql`
        INSERT INTO ${engine_inference_attempts}
          (id, tenant_id, agent_id, run_id, grant_id, account_id, attempt_seq, provider, model,
           request_hash, state, accounting_status, reserved_microusd, tariff_version)
        VALUES (${input.attempt_id}::uuid, ${tenant_id}, ${agent_id}, ${run_id}, ${grant.id},
                ${linhaConta.id}, ${attempt_seq}, ${input.provider}, ${input.model_requested},
                ${input.request_hash}, 'reserved', 'reserved',
                ${decisao.reserve_microusd}::bigint, ${input.tariff_version})`);
      conta("admit", "ok");
      return {
        ok: true,
        attempt_id: input.attempt_id,
        attempt_seq,
        reserved_microusd: decisao.reserve_microusd,
      };
    });
  },

  /**
   * Liquida uma tentativa UMA vez (idempotente): libera a reserva quando não
   * saiu; troca reserva por custo quando o custo é conhecido; mantém a
   * exposição quando não é. Nunca grava custo zero por desconhecimento.
   */
  async settleAttempt(input: {
    attempt_id: string;
    outcome: SettleOutcomeV1;
  }): Promise<SettleAttemptResult> {
    const { tenant_id, agent_id } = scope();
    const o = input.outcome;
    return withTx(async (tx): Promise<SettleAttemptResult> => {
      const tentativa = linhas<{
        id: string;
        run_id: string;
        account_id: string;
        state: string;
        accounting_status: string;
        reserved_microusd: string | null;
      }>(
        await tx.execute(sql`
          SELECT id, run_id, account_id, state, accounting_status,
                 reserved_microusd::text AS reserved_microusd
            FROM ${engine_inference_attempts}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.attempt_id}
           FOR UPDATE`),
      )[0];
      if (!tentativa) {
        conta("settle", "not_found");
        return { ok: false, reason: "not_found" };
      }
      if (tentativa.state !== "reserved") {
        conta("settle", "already");
        return { ok: true, already: true, accounting_status: tentativa.accounting_status };
      }
      await tx.execute(sql`
        SELECT id FROM ${engine_budget_accounts}
         WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${tentativa.account_id}
         FOR UPDATE`);

      const reservado = tentativa.reserved_microusd ?? "0";
      const evento = async (delta: string | null, source: UsageSource): Promise<void> => {
        await tx.execute(sql`
          INSERT INTO ${engine_usage_events}
            (tenant_id, agent_id, run_id, attempt_id, event_key, kind, source, delta_microusd)
          VALUES (${tenant_id}, ${agent_id}, ${tentativa.run_id}, ${tentativa.id},
                  ${`attempt:${tentativa.id}:settle`}, 'reported', ${source}, ${delta}::bigint)
          ON CONFLICT (tenant_id, agent_id, event_key) DO NOTHING`);
      };

      let status: string;
      if (o.kind === "not_sent") {
        status = "settled";
        await tx.execute(sql`
          UPDATE ${engine_inference_attempts}
             SET state = 'not_sent', accounting_status = 'settled', settled_microusd = 0,
                 last_error_code = ${o.error_code.slice(0, 64)}, finished_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${tentativa.id}`);
        await tx.execute(sql`
          UPDATE ${engine_budget_accounts}
             SET reserved_microusd = reserved_microusd - ${reservado}::bigint,
                 row_version = row_version + 1, updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${tentativa.account_id}`);
      } else if (o.kind === "completed" && o.cost_microusd !== null) {
        status = "settled";
        await tx.execute(sql`
          UPDATE ${engine_inference_attempts}
             SET state = 'completed', accounting_status = 'settled',
                 settled_microusd = ${o.cost_microusd}::bigint,
                 prompt_tokens = ${o.prompt_tokens}, completion_tokens = ${o.completion_tokens},
                 finished_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${tentativa.id}`);
        await tx.execute(sql`
          UPDATE ${engine_budget_accounts}
             SET reserved_microusd = reserved_microusd - ${reservado}::bigint,
                 settled_microusd = settled_microusd + ${o.cost_microusd}::bigint,
                 row_version = row_version + 1, updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${tentativa.account_id}`);
        await evento(o.cost_microusd, o.source);
      } else {
        // Custo desconhecido: a reserva continua como exposição até a
        // reconciliação. Nem liberada, nem trocada por zero.
        status = "unknown";
        const completed = o.kind === "completed";
        await tx.execute(sql`
          UPDATE ${engine_inference_attempts}
             SET state = ${completed ? "completed" : "failed_after_send"},
                 accounting_status = 'unknown',
                 prompt_tokens = ${completed ? o.prompt_tokens : null},
                 completion_tokens = ${completed ? o.completion_tokens : null},
                 last_error_code = ${o.kind === "failed_after_send" ? o.error_code.slice(0, 64) : null},
                 finished_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${tentativa.id}`);
        await evento(null, "unavailable");
      }
      conta("settle", status);
      return { ok: true, already: false, accounting_status: status };
    });
  },

  /** Revoga todos os grants do run. Monotônico: revogado continua revogado. */
  async revokeGrantsForRun(input: { run_id: string; reason: string }): Promise<{ revoked: number }> {
    const { tenant_id, agent_id } = scope();
    const rows = linhas<{ id: string }>(
      await db.execute(sql`
        UPDATE ${engine_inference_grants}
           SET revoked_at = clock_timestamp(), revoke_reason = ${input.reason.slice(0, 64)}
         WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
           AND run_id = ${input.run_id} AND revoked_at IS NULL
         RETURNING id`),
    );
    conta("revoke_grants", "ok");
    return { revoked: rows.length };
  },

  /**
   * Abre a conta do dia (provisionamento). Idempotente: a conta que já existe
   * mantém o limite que tinha — mudar limite é operação própria, auditável.
   */
  async openBudgetAccount(input: {
    period_start_utc: string;
    limit_microusd: string;
  }): Promise<{ account_id: string; created: boolean }> {
    const { tenant_id, agent_id } = scope();
    const criada = linhas<{ id: string }>(
      await db.execute(sql`
        INSERT INTO ${engine_budget_accounts}
          (tenant_id, agent_id, period_start_utc, currency, limit_microusd)
        VALUES (${tenant_id}, ${agent_id}, ${input.period_start_utc}::date, 'microusd',
                ${input.limit_microusd}::bigint)
        ON CONFLICT (tenant_id, agent_id, period_start_utc, currency) DO NOTHING
        RETURNING id`),
    );
    if (criada[0]) return { account_id: criada[0].id, created: true };
    const existente = linhas<{ id: string }>(
      await db.execute(sql`
        SELECT id FROM ${engine_budget_accounts}
         WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
           AND period_start_utc = ${input.period_start_utc}::date AND currency = 'microusd'`),
    );
    return { account_id: existente[0]!.id, created: false };
  },
};
