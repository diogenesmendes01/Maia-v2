/**
 * Fase 0 cap. 2 — repositório do store de evidência de aprovação (migration
 * 095). Toda query/mutation escopa tenant + agent via ALS; TODAS as
 * transições de estado são conditional UPDATE (CAS) — nunca leitura +
 * mutação em memória. Corrida entre dois consumidores tem exatamente um
 * vencedor (o UPDATE retorna 0 rows para o perdedor).
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { approval_requests, approval_decisions, engine_tool_calls } from '../schema.js';
import type { ApprovalRequest, ApprovalDecision } from '../schema.js';
import { applyTenantGuard } from '../tenant-guard.js';
import { getCurrentTenant, getCurrentAgent } from '../tenant-context.js';

export type ApprovalClass =
  | 'single_confirmation'
  | 'requester_plus_one_owner'
  | 'two_distinct_owners';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'claimed'
  | 'consumed'
  | 'execution_failed';

const OPEN_STATUSES: ApprovalStatus[] = ['pending', 'approved', 'claimed'];

function scope() {
  return { tenant_id: getCurrentTenant(), agent_id: getCurrentAgent() };
}

export const approvalRequestsRepo = {
  /**
   * Cria um request. A partial unique (tenant, agent, fingerprint | status
   * aberto) garante no máximo um request aberto por intent; em corrida, o
   * perdedor recebe `null` e deve reler via `findOpenByFingerprint`.
   */
  async create(input: {
    requester_pessoa_id: string;
    entidade_id: string | null;
    conversa_id: string | null;
    mensagem_id: string | null;
    request_id: string | null;
    tool: string;
    operation_type: string;
    intent_payload: unknown;
    intent_hash: string;
    intent_hash_version: number;
    approval_class: ApprovalClass;
    required_approvals: number;
    fingerprint: string;
    expires_at: Date;
  }): Promise<ApprovalRequest | null> {
    const guarded = applyTenantGuard({ ...input, status: 'pending' as const });
    const rows = await db
      .insert(approval_requests)
      .values(guarded)
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  },

  async byId(id: string): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .select()
      .from(approval_requests)
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Request aberto (pending/approved/claimed) por referência curta AP-xxxxxxxx. */
  async findOpenByRefPrefix(prefix: string): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    if (!/^[0-9a-f]{8}$/.test(prefix)) return null;
    const rows = await db
      .select()
      .from(approval_requests)
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          inArray(approval_requests.status, OPEN_STATUSES),
          sql`${approval_requests.id}::text LIKE ${prefix + '%'}`,
        ),
      )
      .limit(2);
    // Prefixo ambíguo (2+ requests abertos) falha fechado.
    return rows.length === 1 ? (rows[0] ?? null) : null;
  },

  async findOpenByFingerprint(fingerprint: string): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .select()
      .from(approval_requests)
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.fingerprint, fingerprint),
          inArray(approval_requests.status, OPEN_STATUSES),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** CAS pending → approved. */
  async markApproved(id: string): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .update(approval_requests)
      .set({ status: 'approved', approved_at: sql`now()`, updated_at: sql`now()` })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, id),
          eq(approval_requests.status, 'pending'),
          sql`${approval_requests.expires_at} > now()`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /** CAS pending → denied (terminal). */
  async markDenied(id: string): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .update(approval_requests)
      .set({ status: 'denied', denied_at: sql`now()`, updated_at: sql`now()` })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, id),
          eq(approval_requests.status, 'pending'),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /**
   * CAS approved → claimed. Exatamente um vencedor: o WHERE exige status
   * 'approved' + hash idêntico + não expirado (expiração pelo RELÓGIO DO
   * BANCO). O claim_token cerca o consume subsequente.
   */
  async claim(input: {
    id: string;
    claim_token: string;
    intent_hash: string;
  }): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .update(approval_requests)
      .set({
        status: 'claimed',
        claimed_at: sql`now()`,
        claim_token: input.claim_token,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, input.id),
          eq(approval_requests.status, 'approved'),
          eq(approval_requests.intent_hash, input.intent_hash),
          sql`${approval_requests.expires_at} > now()`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /** CAS claimed → consumed, cercado pelo claim_token (one-time). */
  async consume(input: {
    id: string;
    claim_token: string;
    result_ref: string | null;
  }): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .update(approval_requests)
      .set({
        status: 'consumed',
        consumed_at: sql`now()`,
        result_ref: input.result_ref,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, input.id),
          eq(approval_requests.status, 'claimed'),
          eq(approval_requests.claim_token, input.claim_token),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /**
   * CAS claimed → approved (devolve a evidência). SOMENTE para caminhos em
   * que o handler NÃO chegou a rodar (ex.: corrida de idempotência) — nunca
   * após execução iniciada.
   *
   * §5.5.1 / SPEC-L1406 (SC05) — a segunda condição do `WHERE` é a PROVA de
   * não início, e ela vive AQUI, no mesmo CAS, e não só na política: o handler
   * marcou `engine_tool_calls.handler_started_at` antes de tocar o mundo, e uma
   * vez marcado o journal afirma que o efeito pode ter acontecido. Devolver a
   * evidência nesse estado apagaria a única prova de que a operação aconteceu e
   * convidaria o dono a executá-la duas vezes. Sem journal (caminho legado, sem
   * call no `engine_tool_calls`) o `NOT EXISTS` é verdadeiro e o comportamento
   * não muda.
   *
   * Classe ABORT_SAFE é a exceção declarada: ela mesma afirma ausência de efeito
   * (`classifyToolCancellation`), então o carimbo não prova nada que obrigue a
   * segurar a evidência. Negar a devolução nesse caso deixaria um claim preso
   * para sempre por uma execução que não produziu efeito.
   */
  async releaseClaim(input: { id: string; claim_token: string }): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .update(approval_requests)
      .set({ status: 'approved', claim_token: null, claimed_at: null, updated_at: sql`now()` })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, input.id),
          eq(approval_requests.status, 'claimed'),
          eq(approval_requests.claim_token, input.claim_token),
          sql`NOT EXISTS (
            SELECT 1 FROM ${engine_tool_calls} c
             WHERE c.tenant_id = ${approval_requests.tenant_id}
               AND c.agent_id = ${approval_requests.agent_id}
               AND c.approval_request_id = ${approval_requests.id}
               AND c.handler_started_at IS NOT NULL
               AND c.effect_class IS DISTINCT FROM 'abort_safe'
          )`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /**
   * §5.5.1 (SC05) — expiração LAZY de um pedido VENCIDO, por RELÓGIO DO BANCO.
   *
   * O sweeper (`expireDue`) cobre `pending` no tick do engine, mas não é
   * suficiente para o caminho de execução: entre o instante em que o TTL venceu
   * e o próximo tick, o pedido continua `open` — e `findOpenByFingerprint` o
   * devolveria como se valesse. Pior, um pedido que chegou a `approved` e venceu
   * sem ser executado não era coberto por ninguém: ficava preso na partial unique
   * do fingerprint, bloqueando um pedido novo da MESMA intenção.
   *
   * `approved` é incluído de propósito: vencimento é vencimento. A janela em que
   * a evidência podia ser consumida fechou, e `claim` já exige
   * `expires_at > now()`, então este CAS apenas dá ao pedido o estado terminal
   * que a regra do claim já implicava.
   *
   * Devolve a row quando ESTE chamador venceu o CAS; `null` quando o pedido não
   * estava vencido (ou mudou de estado no meio). Quem chama não pode concluir
   * nada de não ter vencido — pode ter perdido para uma decisão humana.
   */
  async expireIfDue(input: { id: string }): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .update(approval_requests)
      .set({ status: 'expired', updated_at: sql`now()` })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, input.id),
          inArray(approval_requests.status, ['pending', 'approved']),
          sql`${approval_requests.expires_at} <= now()`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /** CAS claimed → execution_failed (terminal; nova aprovação exigida). */
  async markExecutionFailed(input: {
    id: string;
    claim_token: string;
  }): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .update(approval_requests)
      .set({ status: 'execution_failed', updated_at: sql`now()` })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, input.id),
          eq(approval_requests.status, 'claimed'),
          eq(approval_requests.claim_token, input.claim_token),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /** Expira requests pending vencidos (relógio do banco). Retorna as rows. */
  async expireDue(): Promise<ApprovalRequest[]> {
    const { tenant_id, agent_id } = scope();
    return db
      .update(approval_requests)
      .set({ status: 'expired', updated_at: sql`now()` })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.status, 'pending'),
          lt(approval_requests.expires_at, sql`now()`),
        ),
      )
      .returning();
  },
};

export const approvalDecisionsRepo = {
  /**
   * Registra a decisão de um principal. Idempotente por (request, principal):
   * duplicate approve (mesmo por outro canal) não conta duas vezes — retorna
   * `null` no conflito.
   */
  async record(input: {
    request_id: string;
    principal_pessoa_id: string;
    principal_tipo: string;
    decision: 'approve' | 'deny';
    channel: string;
    reason: string | null;
  }): Promise<ApprovalDecision | null> {
    const guarded = applyTenantGuard(input);
    const rows = await db
      .insert(approval_decisions)
      .values(guarded)
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  },

  async byRequest(request_id: string): Promise<ApprovalDecision[]> {
    const { tenant_id, agent_id } = scope();
    return db
      .select()
      .from(approval_decisions)
      .where(
        and(
          eq(approval_decisions.tenant_id, tenant_id),
          eq(approval_decisions.agent_id, agent_id),
          eq(approval_decisions.request_id, request_id),
        ),
      );
  },
};
