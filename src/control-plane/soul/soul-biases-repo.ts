/**
 * P8b — soulBiasesRepo.
 *
 * Append-only versioned repo para `soul_biases`. State machine:
 *   propose()    : NEW row status='proposed' (DEFAULT do DB), version computado
 *                  como MAX(version) + 1 da chave (tenant, agent, scope,
 *                  scope_value, principle).
 *   activate()   : proposed → active. Se já existe active com mesma chave,
 *                  exige `previous_version_id` apontando para ela e a
 *                  deprecia atomicamente no mesmo TX. Partial unique
 *                  `soul_biases_one_active_idx` garante 1 active por chave.
 *   deprecate()  : active → deprecated. Não toca lineage.
 *   rollback()   : ANY → rolled_back. IRREVERSIBLE — nunca reativa versão
 *                  anterior (ROLLBACK ≠ promote previous; é "esta bias
 *                  foi um erro").
 *
 * Tenant isolation: TODA leitura/escrita usa `applyTenantGuard` (P0
 * invariant) ou consulta explícita ao `getCurrentTenant()` + filter no
 * WHERE. Cross-tenant access via id é defendido em todos os métodos.
 *
 * NÃO usa `runCognitiveModule` — este é repo determinístico, sem LLM.
 */
import { eq, and, desc, max as drizzleMax } from 'drizzle-orm';
import { db, withTx } from '@/db/client.js';
import {
  soul_biases,
  type SoulBias,
  type NewSoulBias,
  type ActivationContext,
} from '@/db/schema.js';
import { applyTenantGuard } from '@/db/tenant-guard.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import type { SoulOrigin, SoulScope, SoulBiasStatus } from '@/types/enums.js';

/** Subset retornado em listProposed/findActive/etc. é o próprio SoulBias. */
export type { SoulBias } from '@/db/schema.js';

export type ProposeArgs = {
  scope: SoulScope;
  scope_value: string;
  principle: string;
  guidance: string;
  origin: SoulOrigin;
  /** ∈ [0, 1]. Casted para string para preservar precisão NUMERIC(4,3). */
  strength: number;
  activation_context?: ActivationContext;
  proposed_by: string;
  proposed_reason?: string;
  proposal_id?: string;
  source_drift_alert_id?: string;
  /** Quando criando v2+, aponta para id da versão active vigente. */
  previous_version_id?: string;
};

export type ActivateResult =
  | { ok: true; bias: SoulBias }
  | {
      ok: false;
      reason:
        | 'bias_not_found'
        | 'not_proposed'
        | 'no_lineage_to_replace_active'
        | 'one_active_constraint_violation';
    };

export type DeprecateResult =
  | { ok: true; bias: SoulBias }
  | { ok: false; reason: 'bias_not_found' | 'not_active' };

export type RollbackResult =
  | { ok: true; bias: SoulBias }
  | { ok: false; reason: 'bias_not_found' | 'already_rolled_back' };

export type FindActiveArgs = {
  scope?: SoulScope[];
  scope_value?: string[];
  /** Para overbooking + ranking downstream no slice builder. */
  limit?: number;
};

function strengthToDbString(n: number): string {
  // NUMERIC(4,3) — drizzle armazena como string.
  // 3 casas decimais para preservar precisão.
  return n.toFixed(3);
}

export const soulBiasesRepo = {
  /**
   * Lista TODAS as active biases do (tenant, agent) atual.
   * O slice builder aplica activation_context filter em memória.
   * Ranking primário: strength DESC (slice builder reordena por specificity).
   */
  async findActiveForScope(args: FindActiveArgs = {}): Promise<SoulBias[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const limit = args.limit ?? 50;

    const rows = await db
      .select()
      .from(soul_biases)
      .where(
        and(
          eq(soul_biases.tenant_id, tenant_id),
          eq(soul_biases.agent_id, agent_id),
          eq(soul_biases.status, 'active'),
        ),
      )
      .orderBy(desc(soul_biases.strength))
      .limit(limit);

    return rows;
  },

  /**
   * Lookup por id, sempre filtra por tenant+agent.
   * Retorna null se o id pertence a outro tenant (anti cross-tenant by-id).
   */
  async getById(id: string): Promise<SoulBias | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(soul_biases)
      .where(
        and(
          eq(soul_biases.id, id),
          eq(soul_biases.tenant_id, tenant_id),
          eq(soul_biases.agent_id, agent_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Lista todas as versões de uma chave (audit / lineage UI). */
  async listVersions(args: {
    scope: SoulScope;
    scope_value: string;
    principle: string;
  }): Promise<SoulBias[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(soul_biases)
      .where(
        and(
          eq(soul_biases.tenant_id, tenant_id),
          eq(soul_biases.agent_id, agent_id),
          eq(soul_biases.scope, args.scope),
          eq(soul_biases.scope_value, args.scope_value),
          eq(soul_biases.principle, args.principle),
        ),
      )
      .orderBy(soul_biases.version);
  },

  /** Lista status='proposed' para a Proposal Inbox (Admin UI). */
  async listProposed(args: { limit?: number } = {}): Promise<SoulBias[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const limit = args.limit ?? 20;
    return db
      .select()
      .from(soul_biases)
      .where(
        and(
          eq(soul_biases.tenant_id, tenant_id),
          eq(soul_biases.agent_id, agent_id),
          eq(soul_biases.status, 'proposed'),
        ),
      )
      .orderBy(desc(soul_biases.created_at))
      .limit(limit);
  },

  /**
   * Cria nova bias com status='proposed' (DEFAULT do DB — não enviamos status).
   * Calcula `version = MAX(version) + 1` para a chave composta.
   */
  async propose(args: ProposeArgs): Promise<SoulBias> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();

    // Calcular próxima version (locked-read não necessário: append-only,
    // colisão em race = retry pelo caller).
    const maxRows = await db
      .select({ v: drizzleMax(soul_biases.version) })
      .from(soul_biases)
      .where(
        and(
          eq(soul_biases.tenant_id, tenant_id),
          eq(soul_biases.agent_id, agent_id),
          eq(soul_biases.scope, args.scope),
          eq(soul_biases.scope_value, args.scope_value),
          eq(soul_biases.principle, args.principle),
        ),
      );
    const currentMax = maxRows[0]?.v ?? null;
    const nextVersion = (currentMax ?? 0) + 1;

    const newRow: NewSoulBias = applyTenantGuard({
      scope: args.scope,
      scope_value: args.scope_value,
      principle: args.principle,
      guidance: args.guidance,
      origin: args.origin,
      strength: strengthToDbString(args.strength),
      activation_context: args.activation_context ?? {},
      // status omitido → DEFAULT 'proposed' do DB (invariante 5).
      version: nextVersion,
      previous_version_id: args.previous_version_id ?? null,
      proposed_by: args.proposed_by,
      proposed_reason: args.proposed_reason ?? null,
      proposal_id: args.proposal_id ?? null,
      source_drift_alert_id: args.source_drift_alert_id ?? null,
    });

    const [inserted] = await db.insert(soul_biases).values(newRow).returning();
    return inserted!;
  },

  /**
   * Activate proposed → active. Se já existe active com mesma chave:
   *  - Exige bias.previous_version_id === active.id (lineage check)
   *  - Deprecia active vigente E ativa esta no MESMO TX
   *
   * Falhas tipadas via { ok:false, reason } — não throw para casos esperados
   * (caller pode decidir reconciliar). Falhas inesperadas (DB error que não
   * é 23505) propagam.
   */
  async activate(args: { id: string; approved_by: string }): Promise<ActivateResult> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();

    const current = await this.getById(args.id);
    if (!current) return { ok: false, reason: 'bias_not_found' };
    if (current.status !== 'proposed') return { ok: false, reason: 'not_proposed' };

    try {
      const activated = await withTx(async (tx) => {
        // Procura active vigente com mesma chave (dentro do TX para consistência).
        const existing = await tx
          .select()
          .from(soul_biases)
          .where(
            and(
              eq(soul_biases.tenant_id, tenant_id),
              eq(soul_biases.agent_id, agent_id),
              eq(soul_biases.scope, current.scope),
              eq(soul_biases.scope_value, current.scope_value),
              eq(soul_biases.principle, current.principle),
              eq(soul_biases.status, 'active'),
            ),
          )
          .limit(1);

        if (existing.length > 0) {
          const incumbent = existing[0]!;
          if (current.previous_version_id !== incumbent.id) {
            throw new LineageError();
          }
          await tx
            .update(soul_biases)
            .set({
              status: 'deprecated',
              deprecated_at: new Date(),
              deprecated_reason: 'replaced by new version',
            })
            .where(eq(soul_biases.id, incumbent.id));
        }

        const now = new Date();
        const [row] = await tx
          .update(soul_biases)
          .set({
            status: 'active',
            approved_by: args.approved_by,
            approved_at: now,
            activated_at: now,
          })
          .where(
            and(
              eq(soul_biases.id, current.id),
              eq(soul_biases.tenant_id, tenant_id),
              eq(soul_biases.agent_id, agent_id),
            ),
          )
          .returning();
        if (!row) throw new Error('activate_update_returned_no_row');
        return row;
      });

      return { ok: true, bias: activated };
    } catch (err) {
      if (err instanceof LineageError) {
        return { ok: false, reason: 'no_lineage_to_replace_active' };
      }
      const e = err as { code?: string };
      if (e?.code === '23505') {
        return { ok: false, reason: 'one_active_constraint_violation' };
      }
      throw err;
    }
  },

  /** Active → deprecated. Não toca lineage. */
  async deprecate(args: {
    id: string;
    deprecated_reason: string;
  }): Promise<DeprecateResult> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const current = await this.getById(args.id);
    if (!current) return { ok: false, reason: 'bias_not_found' };
    if (current.status !== 'active') return { ok: false, reason: 'not_active' };

    const [row] = await db
      .update(soul_biases)
      .set({
        status: 'deprecated',
        deprecated_at: new Date(),
        deprecated_reason: args.deprecated_reason,
      })
      .where(
        and(
          eq(soul_biases.id, args.id),
          eq(soul_biases.tenant_id, tenant_id),
          eq(soul_biases.agent_id, agent_id),
        ),
      )
      .returning();
    return { ok: true, bias: row! };
  },

  /**
   * Rollback irreversível. ANY status → rolled_back, EXCETO se já rolled_back
   * (idempotência: caller que retenta vê "already_rolled_back" e não cria
   * efeitos colaterais). NÃO reativa previous_version_id — rollback é declaração
   * de erro, não promote anterior.
   */
  async rollback(args: {
    id: string;
    rollback_reason: string;
    rolled_back_by: string;
  }): Promise<RollbackResult> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const current = await this.getById(args.id);
    if (!current) return { ok: false, reason: 'bias_not_found' };
    if (current.status === 'rolled_back') {
      return { ok: false, reason: 'already_rolled_back' };
    }

    const [row] = await db
      .update(soul_biases)
      .set({
        status: 'rolled_back',
        rolled_back_at: new Date(),
        rollback_reason: `${args.rollback_reason} (by ${args.rolled_back_by})`,
      })
      .where(
        and(
          eq(soul_biases.id, args.id),
          eq(soul_biases.tenant_id, tenant_id),
          eq(soul_biases.agent_id, agent_id),
        ),
      )
      .returning();
    return { ok: true, bias: row! };
  },
};

class LineageError extends Error {
  constructor() {
    super('no_lineage_to_replace_active');
    this.name = 'LineageError';
  }
}

// Re-export status type for callers that need to narrow on string.
export type { SoulBiasStatus };
