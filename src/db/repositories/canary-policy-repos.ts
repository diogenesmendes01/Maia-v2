/**
 * P12 (spec §10.1) — leitura e escrita CAS de `agent_canary_policy` (147).
 *
 * `src/runtime/engines/canary-policy.ts` responde "o que este degrau
 * permite?". Este módulo responde a outra metade — "em que degrau este agente
 * está?" — e é a metade que precisa de banco: ela muda por agente, por decisão
 * humana, e precisa sobreviver a deploy.
 *
 * Regras que este módulo segura, as mesmas de `engine-policy-repos.ts`:
 *
 *  1. **Escopo vem do ALS.** `tenant_id + agent_id` saem de `scope()`. O
 *     chamador não escolhe de quem é o degrau que está lendo.
 *  2. **Ausência ≠ falha.** Consulta que funcionou e não achou linha devolve
 *     `null`, que a escada lê como `off`. Consulta que FALHOU lança
 *     `CanaryPolicyLookupError` — e quem decide capacidade trata a exceção
 *     como NEGAÇÃO (`canaryCapabilityAllowed`, abaixo). Um banco quebrado não
 *     pode virar autorização.
 *  3. **Escrita é CAS.** Só aplica se `row_version` bate (insert quando
 *     `expected_row_version` é `null`). Perder a corrida devolve
 *     `stale_row_version` tipado e a linha não muda.
 *  4. **Política incoerente não é lida como degrau.** `validateCanaryPolicy`
 *     roda na leitura; uma linha que não passa vale `off`, como se não
 *     existisse. A CHECK da 147 já deveria ter barrado — se chegou aqui, o
 *     banco e o código discordam, e o lado em que se erra é o de negar.
 *
 * Auditoria NÃO acontece aqui, como nos irmãos puro-DB: quem escreve degrau
 * (console) audita, porque é lá que existe o ator.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  CANARY_STAGES,
  canaryAllows,
  validateCanaryPolicy,
  type AgentCanaryPolicyV1,
  type CanaryCapability,
  type CanaryStage,
} from '@/runtime/engines/canary-policy.js';
import { logger } from '@/lib/logger.js';
import { db } from '../client.js';
import { agent_canary_policy } from '../schema.js';
import { getCurrentAgent, getCurrentTenant } from '../tenant-context.js';

function scope(): { tenant_id: string; agent_id: string } {
  return { tenant_id: getCurrentTenant(), agent_id: getCurrentAgent() };
}

export type CanaryPolicyWriteResult =
  | { ok: true; row_version: number }
  | { ok: false; reason: 'stale_row_version'; current_row_version: number | null }
  | { ok: false; reason: 'incoherent_policy'; problems: string[] };

/** Lookup que não conseguiu responder. Nunca significa "sem linha". */
export class CanaryPolicyLookupError extends Error {
  readonly code = 'CANARY_POLICY_LOOKUP_FAILED';

  constructor(
    readonly reason: 'query_failed' | 'invalid_row',
    options?: { cause?: unknown },
  ) {
    super(`lookup de agent_canary_policy falhou: ${reason}`, options);
    this.name = 'CanaryPolicyLookupError';
  }
}

function isCanaryStage(v: string): v is CanaryStage {
  return (CANARY_STAGES as readonly string[]).includes(v);
}

const t = agent_canary_policy;

export const canaryPolicyRepo = {
  /** O degrau do escopo do ALS; `null` quando não há linha (vale `off`). */
  async find(): Promise<AgentCanaryPolicyV1 | null> {
    const { tenant_id, agent_id } = scope();
    let rows: Array<{
      stage: string;
      cohort_ref: string | null;
      acceptance_evidence_ref: string | null;
    }>;
    try {
      rows = await db
        .select({
          stage: t.stage,
          cohort_ref: t.cohort_ref,
          acceptance_evidence_ref: t.acceptance_evidence_ref,
        })
        .from(t)
        .where(and(eq(t.tenant_id, tenant_id), eq(t.agent_id, agent_id)));
    } catch (err) {
      throw new CanaryPolicyLookupError('query_failed', { cause: err });
    }
    const row = rows[0];
    if (!row) return null;
    // O CHECK da 147 já impede; conferir aqui evita que um degrau fora da
    // escada chegue com cara de degrau válido.
    if (!isCanaryStage(row.stage)) throw new CanaryPolicyLookupError('invalid_row');
    return {
      tenant_id,
      agent_id,
      stage: row.stage,
      cohort_ref: row.cohort_ref,
      acceptance_evidence_ref: row.acceptance_evidence_ref,
    };
  },

  /**
   * Escrita CAS. `expected_row_version: null` = "não existe linha": insere com
   * versão 1. Número = "a linha está nesta versão": atualiza e sobe 1.
   *
   * A coerência é validada ANTES de tocar o banco. A CHECK da 147 diz a mesma
   * coisa, e de propósito — mas a CHECK devolve erro de driver, e quem escreve
   * degrau merece saber QUAL requisito faltou.
   */
  async write(input: {
    stage: CanaryStage;
    cohort_ref: string | null;
    acceptance_evidence_ref: string | null;
    expected_row_version: number | null;
    updated_by: string;
  }): Promise<CanaryPolicyWriteResult> {
    const { tenant_id, agent_id } = scope();
    const { stage, cohort_ref, acceptance_evidence_ref, expected_row_version, updated_by } = input;

    const problemas = validateCanaryPolicy({
      tenant_id,
      agent_id,
      stage,
      cohort_ref,
      acceptance_evidence_ref,
    });
    if (problemas.length > 0) {
      return { ok: false, reason: 'incoherent_policy', problems: [...problemas] };
    }

    const doEscopo = and(eq(t.tenant_id, tenant_id), eq(t.agent_id, agent_id));

    const aplicada =
      expected_row_version === null
        ? await db
            .insert(t)
            .values({ tenant_id, agent_id, stage, cohort_ref, acceptance_evidence_ref, updated_by })
            .onConflictDoNothing({ target: [t.tenant_id, t.agent_id] })
            .returning({ row_version: t.row_version })
        : await db
            .update(t)
            .set({
              stage,
              cohort_ref,
              acceptance_evidence_ref,
              updated_by,
              row_version: sql`${t.row_version} + 1`,
              updated_at: sql`now()`,
            })
            .where(and(doEscopo, eq(t.row_version, expected_row_version)))
            .returning({ row_version: t.row_version });

    if (aplicada[0]) return { ok: true, row_version: Number(aplicada[0].row_version) };

    const atual = await db.select({ row_version: t.row_version }).from(t).where(doEscopo);
    return {
      ok: false,
      reason: 'stale_row_version',
      current_row_version: atual[0] ? Number(atual[0].row_version) : null,
    };
  },
};

/**
 * A PERGUNTA DE RUNTIME: o agente do escopo atual pode esta capacidade?
 *
 * Esta é a função que os call sites chamam — não `canaryAllows` direto. A
 * diferença é o que acontece quando a leitura FALHA: `canaryAllows` recebe uma
 * política e responde; aqui não há política para receber, e a única resposta
 * honesta é `false`.
 *
 * Tratar falha de lookup como "off" (e não como "prossegue") é o mesmo regime
 * de `EnginePolicyLookupError`: uma indisponibilidade de banco pode negar
 * capacidade, nunca concedê-la. O inverso seria um canário que se habilita
 * sozinho quando o Postgres oscila.
 */
export async function canaryCapabilityAllowed(capability: CanaryCapability): Promise<boolean> {
  let policy: AgentCanaryPolicyV1 | null;
  try {
    policy = await canaryPolicyRepo.find();
  } catch (err) {
    logger.error(
      { err, capability, ops_alert: true },
      'canary.policy_lookup_failed_denying_capability',
    );
    return false;
  }
  return canaryAllows(policy, capability);
}
