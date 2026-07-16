import { eq, and, desc, isNull, sql, gt } from 'drizzle-orm';
import { db, withTx } from '../client.js';
import {
  capability_proposals,
  agent_operational_profile_versions,
  app_users,
  proposal_approvals,
  admin_audit_log,
  debug_snapshot_grants,
  global_settings,
} from '../schema.js';
import type {
  AppUser,
  NewAppUser,
  ProposalApproval,
  NewProposalApproval,
  AdminAuditLogEntry,
  NewAdminAuditLogEntry,
  DebugSnapshotGrant,
  NewDebugSnapshotGrant,
  ProposalTypeId,
  RiskLevelId,
  ProposalUnifiedStatus,
} from '../schema.js';
import { TypedError } from '@/lib/utils.js';
import { deriveCapabilityRisk, deriveCapabilityLocks } from '../capability-risk.js';
import {
  classifyProfileChangeRisk,
  type ProfileChangeEntry,
} from '../profile-risk.js';
import {
  operationalProfileVersionsRepo,
  ProfileTransitionError,
  type ProfileTransitionFailure,
} from './profile-repos.js';
import { readExpectedPredecessor, lockParentAgent } from './profile-internal.js';

// =====================================================================
// P8.5 Admin UI v1 — auth, approvals, audit log, debug snapshot grants
// =====================================================================

/**
 * Repository wrapper for P8.5 admin-ui app_users (NextAuth integration).
 */
export const appUsersRepo = {
  async getByEmail(tenant_id: string, email: string): Promise<AppUser | null> {
    const rows = await db
      .select()
      .from(app_users)
      .where(and(eq(app_users.tenant_id, tenant_id), eq(app_users.email, email)))
      .limit(1);
    return rows[0] ?? null;
  },

  async getById(id: string): Promise<AppUser | null> {
    const rows = await db.select().from(app_users).where(eq(app_users.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async create(input: NewAppUser): Promise<AppUser> {
    const rows = await db.insert(app_users).values(input).returning();
    if (!rows[0]) throw new TypedError('app_user_create_failed', 'Could not create app_user');
    return rows[0];
  },
};

/**
 * Cursor opaco da fila unificada (review PR #496 médio 8): base64url de
 * {ts, id} do último item devolvido. Composto porque `created_at` empata
 * (batches) — o id desempata na MESMA ordem do keyset por source.
 * Cursor ilegível/estranho ⇒ null (primeira página) — nunca lança.
 */
export function encodeListCursor(item: { proposed_at: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ ts: item.proposed_at.toISOString(), id: item.id }),
  ).toString('base64url');
}

export function decodeListCursor(
  cursor: string | null | undefined,
): { ts: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      ts?: unknown;
      id?: unknown;
    };
    if (typeof parsed.ts !== 'string' || typeof parsed.id !== 'string') return null;
    const ts = new Date(parsed.ts);
    if (Number.isNaN(ts.getTime())) return null;
    return { ts, id: parsed.id };
  } catch {
    return null;
  }
}

/**
 * proposalsUnified — virtual UNION view aggregating all proposal sources.
 *
 * Targets (post-merge of #93–#96):
 *   - policy_rules               (P8e — PolicyDescriptorResolver)
 *   - soul_biases                (P8b — Soul Layer)
 *   - skills                     (P8c — User Layer)
 *   - capability_proposals       (P5 — already in main)
 *   - knowledge_pending_review   (P10a — knowledge state machine)
 *
 * In current main, only `capability_proposals` exists. This wrapper falls back
 * gracefully: tables that do not exist yet contribute zero rows (verified at
 * call time via information_schema lookups). Once the dependent PRs merge,
 * the UNION view materializes the full federation without code changes.
 */
export const proposalsUnifiedRepo = {
  /** Tables expected to exist post-merge; queried with COALESCE-style fallback. */
  EXPECTED_TABLES: [
    'policy_rules',
    'soul_biases',
    'skills',
    'capability_proposals',
    'knowledge_pending_review',
  ] as const,

  async _availableTables(): Promise<string[]> {
    const result = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY (ARRAY['policy_rules','soul_biases','skills','capability_proposals','knowledge_pending_review'])
    `);
    return result.rows.map((r) => r.table_name);
  },

  /**
   * Review PR #496 (médio 8) — a fila unificada é paginada com KEYSET GLOBAL:
   * cada source recebe o predicado composto `(created_at, id) < cursor` e o
   * merge final ordena por `proposed_at DESC, id DESC` antes do slice — sem
   * isso, capabilities entravam primeiro no array e `limit` capabilities
   * pendentes escondiam TODOS os perfis indefinidamente (e o cursor aceito
   * nunca era aplicado). O cursor é opaco: base64url de {ts, id} do último
   * item devolvido.
   */
  async list(input: {
    tenantId: string;
    types?: ProposalTypeId[];
    risks?: RiskLevelId[];
    sources?: string[];
    status?: ProposalUnifiedStatus;
    ageBucket?: 'lt_1h' | 'lt_24h' | 'lt_7d' | 'lt_30d' | 'older';
    limit: number;
    cursor?: string | null;
  }): Promise<{
    items: Array<{
      id: string;
      type: ProposalTypeId;
      descriptor: string;
      risk: RiskLevelId;
      source: string;
      status: ProposalUnifiedStatus;
      proposed_at: Date;
      proposed_by: string;
    }>;
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const available = await this._availableTables();
    const status = input.status ?? 'proposed';
    const cursor = decodeListCursor(input.cursor);

    // capability_proposals is the only table guaranteed to exist on main.
    if (!available.includes('capability_proposals')) {
      return { items: [], hasMore: false, nextCursor: null };
    }

    const items: Array<{
      id: string;
      type: ProposalTypeId;
      descriptor: string;
      risk: RiskLevelId;
      source: string;
      status: ProposalUnifiedStatus;
      proposed_at: Date;
      proposed_by: string;
    }> = [];

    // capability_proposals: title column → descriptor
    // capability_proposals.status uses values: 'draft' | 'submitted' | 'approved' | 'rejected' | 'delivered'
    // We map admin-ui statuses ('proposed' | 'pending_review' | 'rejected' | 'activated') to those values:
    //   proposed → submitted
    //   pending_review → submitted (alias for current admin-ui review queue)
    //   rejected → rejected
    //   activated → delivered
    const capStatusMap: Record<ProposalUnifiedStatus, string> = {
      proposed: 'submitted',
      pending_review: 'submitted',
      rejected: 'rejected',
      activated: 'delivered',
    };
    if (available.includes('capability_proposals')) {
      const dbStatus = capStatusMap[status];
      const rows = await db
        .select()
        .from(capability_proposals)
        .where(
          and(
            eq(capability_proposals.tenant_id, input.tenantId),
            eq(capability_proposals.status, dbStatus),
            ...(cursor
              ? [
                  sql`(${capability_proposals.created_at}, ${capability_proposals.id})
                      < (${cursor.ts}, ${cursor.id}::uuid)`,
                ]
              : []),
          ),
        )
        .orderBy(desc(capability_proposals.created_at), desc(capability_proposals.id))
        .limit(input.limit + 1);
      for (const r of rows) {
        // Post-Codex-review #101: risk is DERIVED from capability_type +
        // proposed_spec markers; never hardcoded. Fail-closed default is
        // 'critical' (forces dual approval). See ./capability-risk.ts.
        items.push({
          id: r.id,
          type: 'capability_proposal',
          descriptor: r.title,
          risk: deriveCapabilityRisk(r.capability_type, r.proposed_spec),
          source: r.capability_type,
          status,
          proposed_at: r.created_at,
          proposed_by: r.decided_by ?? 'system',
        });
      }
    }

    // Spec perfil-inbox v4 §3 (fase C: incondicional) — perfis operacionais
    // PROPOSTOS entram na fila unificada. Risco é COMPUTADO (nunca LLM)
    // contra o predecessor DECLARADO da proposta (classifyProfileChangeRisk,
    // fail-UP).
    {
      const profStatusMap: Record<ProposalUnifiedStatus, string> = {
        proposed: 'proposed',
        pending_review: 'proposed',
        rejected: 'rolled_back',
        activated: 'active',
      };
      const rows = await db
        .select()
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.tenant_id, input.tenantId),
            eq(agent_operational_profile_versions.status, profStatusMap[status]),
            ...(cursor
              ? [
                  sql`(${agent_operational_profile_versions.created_at}, ${agent_operational_profile_versions.id})
                      < (${cursor.ts}, ${cursor.id}::uuid)`,
                ]
              : []),
          ),
        )
        .orderBy(
          desc(agent_operational_profile_versions.created_at),
          desc(agent_operational_profile_versions.id),
        )
        .limit(input.limit + 1);
      for (const r of rows) {
        const { risk } = await this._classifyProfileRow(r);
        items.push({
          id: r.id,
          type: 'operational_profile',
          descriptor: `Perfil operacional v${r.version} — ${r.agent_id}`,
          risk,
          source: 'operational_profile',
          status,
          proposed_at: r.created_at,
          proposed_by: r.proposed_by,
        });
      }
    }

    // Future tables (policy_rules, soul_biases, skills, knowledge_pending_review)
    // are wired up here once their schemas land in main; the available[] check
    // gates each block independently to avoid runtime errors before merge.

    // Simple in-memory filter on optional facets (UI-side filters). Nota:
    // facetas podem sub-preencher uma página (limitação pré-existente); a
    // paginação por cursor continua correta porque o nextCursor é sempre o
    // ÚLTIMO item devolvido, na mesma ordem do keyset.
    const filtered = items.filter((it) => {
      if (input.types && !input.types.includes(it.type)) return false;
      if (input.risks && !input.risks.includes(it.risk)) return false;
      if (input.sources && !input.sources.includes(it.source)) return false;
      return true;
    });

    // Merge global: mesma ordem do keyset de cada source (created_at DESC,
    // id DESC — uuid canônico compara igual em texto e no pg), para que
    // sources se INTERCALEM por recência em vez de concatenar por tipo.
    filtered.sort((a, b) => {
      const d = b.proposed_at.getTime() - a.proposed_at.getTime();
      if (d !== 0) return d;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });

    const hasMore = filtered.length > input.limit;
    const trimmed = filtered.slice(0, input.limit);
    const last = trimmed[trimmed.length - 1];
    const nextCursor = hasMore && last ? encodeListCursor(last) : null;
    return { items: trimmed, hasMore, nextCursor };
  },

  async countersByType(tenantId: string): Promise<Record<ProposalTypeId, number>> {
    const counts: Record<ProposalTypeId, number> = {
      policy_rule: 0,
      soul_bias: 0,
      skill: 0,
      capability_proposal: 0,
      knowledge_proposal: 0,
      operational_profile: 0,
    };
    const available = await this._availableTables();
    if (available.includes('capability_proposals')) {
      const result = await db.execute<{ count: number | string }>(sql`
        SELECT COUNT(*)::int AS count
          FROM capability_proposals
         WHERE tenant_id = ${tenantId}
           AND status = 'submitted'
      `);
      const raw = result.rows[0]?.count ?? 0;
      counts.capability_proposal = typeof raw === 'string' ? Number(raw) : raw;
    }
    // Spec perfil-inbox v4 (fase C) — contadores nativos; o card bespoke
    // `pendingProfileApprovals` (#492) foi removido junto com a flag.
    {
      const result = await db.execute<{ count: number | string }>(sql`
        SELECT COUNT(*)::int AS count
          FROM agent_operational_profile_versions
         WHERE tenant_id = ${tenantId}
           AND status = 'proposed'
      `);
      const raw = result.rows[0]?.count ?? 0;
      counts.operational_profile = typeof raw === 'string' ? Number(raw) : raw;
    }
    return counts;
  },

  /**
   * Spec perfil-inbox v4 §1.2 — risco computado contra o predecessor
   * DECLARADO (`metadata.previous_version_id`), não contra o active do
   * momento da leitura — coerente com o guard de predecessor que decidirá a
   * ativação. Predecessor ausente/ilegível ⇒ o classificador falha PARA CIMA
   * (`high`), exceto o seed intencional v1 (sem predecessor por construção),
   * cujo risco também é `high` — a primeira ativação define o contrato do
   * agente inteiro.
   */
  async _classifyProfileRow(row: {
    version: number;
    profile_body: unknown;
    tenant_id: string;
    agent_id: string;
  }): Promise<{ risk: RiskLevelId; changes: ProfileChangeEntry[]; reasons: string[] }> {
    const declared = readExpectedPredecessor(row.profile_body);
    let predecessorBody: unknown = null;
    if (typeof declared === 'string' && declared !== 'unknown') {
      const rows = await db
        .select({ profile_body: agent_operational_profile_versions.profile_body })
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.id, declared),
            eq(agent_operational_profile_versions.tenant_id, row.tenant_id),
            eq(agent_operational_profile_versions.agent_id, row.agent_id),
          ),
        )
        .limit(1);
      predecessorBody = rows[0]?.profile_body ?? null;
    }
    const out = classifyProfileChangeRisk(predecessorBody, row.profile_body);
    return { risk: out.risk, changes: out.changes, reasons: out.reasons };
  },

  async getOne(
    tenantId: string,
    id: string,
  ): Promise<{
    id: string;
    type: ProposalTypeId;
    /**
     * Agente DONO da proposta (review PR #496 alto 5): chamadores que
     * recebem um agent_id do cliente DEVEM conferir este campo antes de
     * decidir — sem isso uma versão do agente B seria aprovável por um
     * endpoint invocado para o agente A dentro do mesmo tenant.
     */
    agent_id: string;
    descriptor: string;
    risk: RiskLevelId;
    source: string;
    status: ProposalUnifiedStatus;
    proposed_at: Date;
    proposed_by: string;
    body: unknown;
    locks: string[];
  } | null> {
    const available = await this._availableTables();
    if (available.includes('capability_proposals')) {
      const rows = await db
        .select()
        .from(capability_proposals)
        .where(and(eq(capability_proposals.tenant_id, tenantId), eq(capability_proposals.id, id)))
        .limit(1);
      const r = rows[0];
      if (r) {
        // Reverse-map db status → admin-ui status; fall back to 'proposed'.
        const reverseStatusMap: Record<string, ProposalUnifiedStatus> = {
          draft: 'proposed',
          submitted: 'proposed',
          approved: 'pending_review',
          rejected: 'rejected',
          delivered: 'activated',
        };
        // Post-Codex-review #101: risk + locks DERIVED from spec, not hardcoded.
        return {
          id: r.id,
          type: 'capability_proposal',
          agent_id: r.agent_id,
          descriptor: r.title,
          risk: deriveCapabilityRisk(r.capability_type, r.proposed_spec),
          source: r.capability_type,
          status: reverseStatusMap[r.status] ?? 'proposed',
          proposed_at: r.created_at,
          proposed_by: r.decided_by ?? 'system',
          body: r.proposed_spec,
          locks: deriveCapabilityLocks(r.capability_type, r.proposed_spec),
        };
      }
    }

    // Spec perfil-inbox v4 — detalhe do perfil proposto: o body carrega o
    // corpo proposto + o do predecessor DECLARADO + as entradas do walker
    // (mesma fonte do classificador) para o DiffOperationalProfile.
    {
      const rows = await db
        .select()
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.tenant_id, tenantId),
            eq(agent_operational_profile_versions.id, id),
          ),
        )
        .limit(1);
      const r = rows[0];
      if (r) {
        const reverseProfileStatus: Record<string, ProposalUnifiedStatus> = {
          proposed: 'proposed',
          active: 'activated',
          frozen: 'activated',
          rolled_back: 'rejected',
        };
        const classified = await this._classifyProfileRow(r);
        const declared = readExpectedPredecessor(r.profile_body);
        let predecessorBody: unknown = null;
        if (typeof declared === 'string' && declared !== 'unknown') {
          const predRows = await db
            .select({ profile_body: agent_operational_profile_versions.profile_body })
            .from(agent_operational_profile_versions)
            .where(
              and(
                eq(agent_operational_profile_versions.id, declared),
                eq(agent_operational_profile_versions.tenant_id, tenantId),
                eq(agent_operational_profile_versions.agent_id, r.agent_id),
              ),
            )
            .limit(1);
          predecessorBody = predRows[0]?.profile_body ?? null;
        }
        return {
          id: r.id,
          type: 'operational_profile',
          agent_id: r.agent_id,
          descriptor: `Perfil operacional v${r.version} — ${r.agent_id}`,
          risk: classified.risk,
          source: 'operational_profile',
          status: reverseProfileStatus[r.status] ?? 'proposed',
          proposed_at: r.created_at,
          proposed_by: r.proposed_by,
          body: {
            agent_id: r.agent_id,
            version: r.version,
            proposed_profile_body: r.profile_body,
            predecessor_profile_body: predecessorBody,
            changes: classified.changes,
            risk_reasons: classified.reasons,
          },
          locks: [],
        };
      }
    }
    return null;
  },

  /**
   * decideAtomically — single-transaction approve/reject for a unified proposal.
   *
   * Post-Codex-review #101: the old approve/reject path inserted into
   * proposal_approvals + admin_audit_log but never touched the source-of-truth
   * row. A capability_proposal could stay in status='submitted' forever while
   * the admin UI reported "activated". This method closes that gap.
   *
   * Behavior per source:
   *   capability_proposals:
   *     - On approve gate satisfied (dual or single): submitted → approved
   *       (capabilityProposalsRepo.transition). Subsequent activation
   *       (approved → testing → delivered) is owned by the capability-test-runner.
   *     - On reject: submitted → rejected.
   *
   *   policy_rules / soul_biases / skills / knowledge_pending_review:
   *     - Transitions deferred to the source repo once each schema lands.
   *       Returns { ok: false, reason: 'source_not_supported' } until then —
   *       NEVER silently succeeds.
   *
   * Pre-conditions enforced inside the transaction:
   *   - Source row exists for (tenantId, id)
   *   - Source status is currently in a valid pre-decision state for the
   *     attempted transition (rejects double-approval, double-reject, race
   *     between two operators).
   *
   * round-2 fix: dup-check (same user cannot approve twice) and gate
   * recomputation now happen INSIDE the transaction after locking the source
   * row. This prevents the race where two concurrent approvers both compute
   * willSatisfyGate=false outside the tx, then both serialize through the
   * lock and insert approvals without triggering the transition.
   *
   * Gate inputs from the tRPC layer (requiredRoles, allLocks) are passed in
   * so this method can recompute dualComplete from the fresh approval list.
   */
  async decideAtomically(input: {
    tenantId: string;
    proposalId: string;
    type: ProposalTypeId;
    approvalClass: string;
    actorId: string;
    actorRole: string;
    decision: 'approved' | 'rejected';
    comment: string;
    /**
     * Provided by the tRPC layer for gate recomputation inside the tx.
     * If absent, falls back to the pre-computed dualComplete (old behaviour,
     * kept for backwards-compat with the mock in tests).
     */
    gateParams?: {
      dualRequired: boolean;
      requiredRoles: string[];
      allLocks: string[];
    };
    /** True ⇒ the gate is satisfied; perform the source transition.
     * Ignored when gateParams is present (recomputed inside tx). */
    dualComplete: boolean;
  }): Promise<{
    ok: true;
    sourceTransitioned: boolean;
    approval: ProposalApproval;
    finalStatus: ProposalUnifiedStatus;
    /** Recomputed inside transaction. */
    dualComplete: boolean;
    /** Presente só no source operational_profile (shim legado da aba Versões). */
    profile?: {
      activated: { id: string; version: number } | null;
      frozen_previous: { id: string; version: number } | null;
    };
  } | {
    ok: false;
    reason:
      | 'not_found'
      | 'invalid_source_status'
      | 'source_not_supported'
      | 'transition_failed'
      | 'already_approved_by_user'
      | 'already_approved_by_role';
  } | {
    /**
     * Spec perfil-inbox v4 §1.4 — falha tipada dos guards de perfil
     * (predecessor_conflict, migrated_legacy_proposal, missing_predecessor,
     * …), capturada FORA do withTx: o rollback já desfez approval + audit.
     * O router traduz com as mesmas mensagens do caminho legado.
     */
    ok: false;
    reason: 'profile_transition_failed';
    detail: ProfileTransitionFailure;
  }> {
    // Spec perfil-inbox v4 — source operational_profile tem caminho próprio:
    // a transição delega aos primitivos InTx do repo de perfis (guards de
    // predecessor intactos) e o contrato de falha é THROW→rollback→catch.
    // Fase C: caminho ÚNICO — a flag e o shim legado foram removidos.
    if (input.type === 'operational_profile') {
      return this._decideProfileAtomically(input);
    }

    const available = await this._availableTables();

    return await withTx(async (tx) => {
      // (1) Re-read + LOCK source row to prevent races.
      if (input.type === 'capability_proposal') {
        if (!available.includes('capability_proposals')) {
          return { ok: false, reason: 'source_not_supported' as const };
        }
        const rows = await tx
          .select()
          .from(capability_proposals)
          .where(
            and(
              eq(capability_proposals.tenant_id, input.tenantId),
              eq(capability_proposals.id, input.proposalId),
            ),
          )
          .for('update')
          .limit(1);
        const sourceRow = rows[0];
        if (!sourceRow) return { ok: false, reason: 'not_found' as const };

        // Only 'submitted' rows are eligible for approve/reject. 'draft' would
        // need explicit submit first; terminal states block.
        if (sourceRow.status !== 'submitted') {
          return { ok: false, reason: 'invalid_source_status' as const };
        }

        // (1b) Re-read existing approvals INSIDE the transaction + re-run dup
        // checks so concurrent approvers cannot race past the idempotency guard.
        let resolvedDualComplete = input.dualComplete;
        if (input.decision === 'approved' && input.gateParams) {
          // 093 (spec perfil-inbox v4 §1.6): predicates de leitura carregam
          // tenant_id SEMPRE; rows legadas (source NULL) continuam contando —
          // eram deste proposal antes do escopo existir.
          const existingInTx = await tx
            .select()
            .from(proposal_approvals)
            .where(
              and(
                eq(proposal_approvals.proposal_id, input.proposalId),
                eq(proposal_approvals.tenant_id, input.tenantId),
              ),
            );

          // Idempotency by user: same user cannot record two approvals.
          if (existingInTx.some(
            (a) => a.approver_user_id === input.actorId && a.decision === 'approved',
          )) {
            return { ok: false, reason: 'already_approved_by_user' as const };
          }

          const { dualRequired, requiredRoles, allLocks } = input.gateParams;

          // For non-lockdown dual classes: same role cannot double-sign.
          if (dualRequired && allLocks.length === 0) {
            if (existingInTx.some(
              (a) => a.approver_role === input.actorRole && a.decision === 'approved',
            )) {
              return { ok: false, reason: 'already_approved_by_role' as const };
            }
          }

          // Recompute gate from the fresh (locked) approval list + this approval.
          if (allLocks.length > 0) {
            const priorFounderIds = new Set(
              existingInTx
                .filter((a) => a.decision === 'approved' && a.approver_role === 'founder')
                .map((a) => a.approver_user_id),
            );
            priorFounderIds.add(input.actorId);
            resolvedDualComplete = priorFounderIds.size >= 2;
          } else if (dualRequired) {
            const approvedRoles = new Set(
              existingInTx.filter((a) => a.decision === 'approved').map((a) => a.approver_role),
            );
            approvedRoles.add(input.actorRole);
            resolvedDualComplete = requiredRoles.every((r) => approvedRoles.has(r));
          } else {
            resolvedDualComplete = true;
          }
        }

        // (2) Insert approval row — 093 (spec perfil-inbox v4 §1.6): escritas
        // novas preenchem agent_id + proposal_source OBRIGATORIAMENTE (o CHECK
        // de pareamento NULL e a partial unique escopada são os juízes no DB).
        const insertedApprovals = await tx
          .insert(proposal_approvals)
          .values({
            tenant_id: input.tenantId,
            agent_id: sourceRow.agent_id,
            proposal_source: 'capability_proposal',
            proposal_id: input.proposalId,
            approval_class: input.approvalClass,
            approver_user_id: input.actorId,
            approver_role: input.actorRole,
            decision: input.decision,
            comment: input.comment,
          })
          .returning();
        const approval = insertedApprovals[0];
        if (!approval) {
          throw new TypedError('approval_insert_failed', 'Could not record approval');
        }

        // (3) Audit BEFORE source mutation, so the audit row is visible
        // even if the source UPDATE rolls back.
        await tx.insert(admin_audit_log).values({
          tenant_id: input.tenantId,
          actor_id: input.actorId,
          actor_role: input.actorRole,
          action: input.decision === 'approved' ? 'proposal_approve' : 'proposal_reject',
          resource_type: 'capability_proposal',
          resource_id: input.proposalId,
          change_summary: {
            approval_class: input.approvalClass,
            comment: input.comment,
            dual_complete: resolvedDualComplete,
            source_transition_attempted:
              input.decision === 'rejected' || resolvedDualComplete,
          },
        });

        // (4) Mutate source-of-truth.
        let finalStatus: ProposalUnifiedStatus = 'pending_review';
        let sourceTransitioned = false;
        if (input.decision === 'rejected') {
          // Direct UPDATE inside the same txn so we don't depend on
          // capabilityProposalsRepo.transition (which uses module-level `db`).
          const patched = await tx
            .update(capability_proposals)
            .set({
              status: 'rejected',
              decided_at: new Date(),
              decided_by: input.actorId,
              decision_reason: input.comment,
              updated_at: new Date(),
            })
            .where(eq(capability_proposals.id, input.proposalId))
            .returning();
          if (patched.length === 0) {
            return { ok: false, reason: 'transition_failed' as const };
          }
          finalStatus = 'rejected';
          sourceTransitioned = true;
        } else if (resolvedDualComplete) {
          // submitted → approved. (approved → testing → delivered is owned by
          // capability-test-runner and runs out-of-band.)
          const patched = await tx
            .update(capability_proposals)
            .set({
              status: 'approved',
              decided_at: new Date(),
              decided_by: input.actorId,
              decision_reason: input.comment,
              updated_at: new Date(),
            })
            .where(eq(capability_proposals.id, input.proposalId))
            .returning();
          if (patched.length === 0) {
            return { ok: false, reason: 'transition_failed' as const };
          }
          // Admin-ui surface name: 'pending_review' once approved but not yet
          // delivered. The reverseStatusMap in getOne also maps 'approved' →
          // 'pending_review' for consistency.
          finalStatus = 'pending_review';
          sourceTransitioned = true;
        }

        return {
          ok: true as const,
          sourceTransitioned,
          approval,
          finalStatus,
          dualComplete: resolvedDualComplete,
        };
      }

      // policy_rule / soul_bias / skill / knowledge_proposal:
      //
      // Reverted (Codex review of PR #162, finding [critical]): the previous
      // attempt to add a generic raw-table activation path skipped each
      // source's lifecycle invariants — policy descriptor cache events, soul
      // bias lineage + incumbent deprecation, skill scope + active-version
      // deprecation, etc. Those live in their per-source repos
      // (`policyRulesRepo.activate`, `soulBiasesRepo.activate`,
      // `skillsRepo.activate`).
      //
      // Wiring those properly into a transactional `decideAtomically` requires
      // each source repo to expose a tx-aware `activate(tx, ...)` overload.
      // Until that lands, source_not_supported is the fail-safe — the tRPC
      // layer maps it to NOT_IMPLEMENTED rather than pretending success.
      // (operational_profile já é despachado ANTES do withTx — ver acima.)
      return { ok: false, reason: 'source_not_supported' as const };
    });
  },

  /**
   * Spec perfil-inbox v4 §1.4 — decisão de PERFIL pelo motor unificado.
   *
   * A ordem interna espelha o caminho capability (dup-check → approval →
   * audit → transição do source), e é exatamente por isso que a transição
   * usa os primitivos InTx com contrato de THROW: `ProfileTransitionError`
   * dentro do withTx faz rollback TOTAL — a approval e o audit inseridos
   * antes da transição desaparecem junto (invariante 1b: nenhum estado
   * parcial, nenhum dup-check falso-positivo no retry). O catch fica FORA
   * do withTx e converte para o resultado tipado do motor.
   */
  async _decideProfileAtomically(input: {
    tenantId: string;
    proposalId: string;
    approvalClass: string;
    actorId: string;
    actorRole: string;
    decision: 'approved' | 'rejected';
    comment: string;
    gateParams?: {
      dualRequired: boolean;
      requiredRoles: string[];
      allLocks: string[];
    };
    dualComplete: boolean;
  }): Promise<
    | {
        ok: true;
        sourceTransitioned: boolean;
        approval: ProposalApproval;
        finalStatus: ProposalUnifiedStatus;
        dualComplete: boolean;
        /** Detalhe da ativação de perfil (só para type=operational_profile). */
        profile?: {
          activated: { id: string; version: number } | null;
          frozen_previous: { id: string; version: number } | null;
        };
      }
    | {
        ok: false;
        reason:
          | 'not_found'
          | 'invalid_source_status'
          | 'already_approved_by_user'
          | 'already_approved_by_role';
      }
    | { ok: false; reason: 'profile_transition_failed'; detail: ProfileTransitionFailure }
  > {
    try {
      return await withTx(async (tx) => {
        // (0) Leitura SEM lock só para descobrir o agent_id — o lock do
        // agente pai precisa vir ANTES de qualquer row lock desta tabela
        // (MESMA ordem de todos os writers: lockParentAgent → row FOR
        // UPDATE). Inverter a ordem criaria um deadlock AB-BA com o caminho
        // legado/seeds.
        const probe = await tx
          .select({
            id: agent_operational_profile_versions.id,
            agent_id: agent_operational_profile_versions.agent_id,
          })
          .from(agent_operational_profile_versions)
          .where(
            and(
              eq(agent_operational_profile_versions.tenant_id, input.tenantId),
              eq(agent_operational_profile_versions.id, input.proposalId),
            ),
          )
          .limit(1);
        if (!probe[0]) return { ok: false, reason: 'not_found' as const };

        const agentLocked = await lockParentAgent(tx, input.tenantId, probe[0].agent_id);
        if (!agentLocked) return { ok: false, reason: 'not_found' as const };

        // (1) Lock do source row (pós-lock do pai) — serializa decisões
        // concorrentes: a 2ª assinatura do dual VÊ a approval da 1ª no
        // re-read transacional abaixo. O InTx re-trava (idempotente na
        // mesma tx).
        const rows = await tx
          .select()
          .from(agent_operational_profile_versions)
          .where(
            and(
              eq(agent_operational_profile_versions.tenant_id, input.tenantId),
              eq(agent_operational_profile_versions.id, input.proposalId),
            ),
          )
          .for('update')
          .limit(1);
        const sourceRow = rows[0];
        if (!sourceRow) return { ok: false, reason: 'not_found' as const };
        if (sourceRow.status !== 'proposed') {
          return { ok: false, reason: 'invalid_source_status' as const };
        }

        // (1b) Dup-check + recomputação do gate DENTRO da tx, leitura
        // ESCOPADA (tenant + source + proposal — §1.6).
        let resolvedDualComplete = input.dualComplete;
        if (input.decision === 'approved' && input.gateParams) {
          const existingInTx = await tx
            .select()
            .from(proposal_approvals)
            .where(
              and(
                eq(proposal_approvals.proposal_id, input.proposalId),
                eq(proposal_approvals.tenant_id, input.tenantId),
                eq(proposal_approvals.proposal_source, 'operational_profile'),
              ),
            );

          if (
            existingInTx.some(
              (a) => a.approver_user_id === input.actorId && a.decision === 'approved',
            )
          ) {
            return { ok: false, reason: 'already_approved_by_user' as const };
          }

          const { dualRequired, requiredRoles, allLocks } = input.gateParams;
          if (dualRequired && allLocks.length === 0) {
            if (
              existingInTx.some(
                (a) => a.approver_role === input.actorRole && a.decision === 'approved',
              )
            ) {
              return { ok: false, reason: 'already_approved_by_role' as const };
            }
          }

          if (allLocks.length > 0) {
            const priorFounderIds = new Set(
              existingInTx
                .filter((a) => a.decision === 'approved' && a.approver_role === 'founder')
                .map((a) => a.approver_user_id),
            );
            priorFounderIds.add(input.actorId);
            resolvedDualComplete = priorFounderIds.size >= 2;
          } else if (dualRequired) {
            const approvedRoles = new Set(
              existingInTx
                .filter((a) => a.decision === 'approved')
                .map((a) => a.approver_role),
            );
            approvedRoles.add(input.actorRole);
            resolvedDualComplete = requiredRoles.every((r) => approvedRoles.has(r));
          } else {
            resolvedDualComplete = true;
          }
        }

        // (2) Approval com ESCOPO COMPLETO (invariante 5; CHECK 093 no DB).
        const insertedApprovals = await tx
          .insert(proposal_approvals)
          .values({
            tenant_id: input.tenantId,
            agent_id: sourceRow.agent_id,
            proposal_source: 'operational_profile',
            proposal_id: input.proposalId,
            approval_class: input.approvalClass,
            approver_user_id: input.actorId,
            approver_role: input.actorRole,
            decision: input.decision,
            comment: input.comment,
          })
          .returning();
        const approval = insertedApprovals[0];
        if (!approval) {
          throw new TypedError('approval_insert_failed', 'Could not record approval');
        }

        // (3) Audit do MOTOR (uma trilha por decisão — invariante 3; o
        // wrapper legado mantém a dele até ser aposentado, e cada decisão
        // passa por exatamente UM caminho).
        await tx.insert(admin_audit_log).values({
          tenant_id: input.tenantId,
          actor_id: input.actorId,
          actor_role: input.actorRole,
          action: input.decision === 'approved' ? 'proposal_approve' : 'proposal_reject',
          resource_type: 'agent_operational_profile_version',
          resource_id: input.proposalId,
          change_summary: {
            agent_id: sourceRow.agent_id,
            approval_class: input.approvalClass,
            comment: input.comment,
            dual_complete: resolvedDualComplete,
            source_transition_attempted:
              input.decision === 'rejected' || resolvedDualComplete,
          },
        });

        // (4) Transição do source pelos primitivos endurecidos (guards de
        // predecessor intactos — invariante 1). Falha ⇒ THROW ⇒ rollback.
        let finalStatus: ProposalUnifiedStatus = 'pending_review';
        let sourceTransitioned = false;
        let profile:
          | {
              activated: { id: string; version: number } | null;
              frozen_previous: { id: string; version: number } | null;
            }
          | undefined;
        if (input.decision === 'rejected') {
          await operationalProfileVersionsRepo.rejectProposedInTx(tx, {
            tenant_id: input.tenantId,
            agent_id: sourceRow.agent_id,
            id: input.proposalId,
            rollback_reason: input.comment,
          });
          finalStatus = 'rejected';
          sourceTransitioned = true;
        } else if (resolvedDualComplete) {
          const r = await operationalProfileVersionsRepo.approveAndActivateInTx(tx, {
            tenant_id: input.tenantId,
            agent_id: sourceRow.agent_id,
            id: input.proposalId,
            actor_id: input.actorId,
          });
          profile = { activated: r.activated, frozen_previous: r.frozen_previous };
          finalStatus = 'activated';
          sourceTransitioned = true;
        }
        // high sem segunda assinatura: NENHUMA transição (invariante 2) — a
        // approval fica gravada aguardando o segundo aprovador.

        return {
          ok: true as const,
          sourceTransitioned,
          approval,
          finalStatus,
          dualComplete: resolvedDualComplete,
          ...(profile ? { profile } : {}),
        };
      });
    } catch (err) {
      if (err instanceof ProfileTransitionError) {
        return { ok: false, reason: 'profile_transition_failed', detail: err.detail };
      }
      throw err;
    }
  },

  /**
   * Bulk reject — only allowed for risk=low proposals.
   * Hard-limit / architecture-lock proposals are rejected one-at-a-time.
   */
  async bulkReject(
    tenantId: string,
    ids: string[],
    actorId: string,
    actorRole: string,
    comment: string,
  ): Promise<{ rejected_count: number; skipped_ids: string[] }> {
    if (ids.length === 0) return { rejected_count: 0, skipped_ids: [] };
    // round-2 fix: each proposal is processed in its own nested transaction
    // using decideAtomically so that:
    //   (a) The source row is locked (SELECT FOR UPDATE) before reading status.
    //   (b) audit/approval rows are ONLY inserted when the source transition
    //       succeeds (UPDATE returns a row), not on stale/already-handled rows.
    //   (c) rejected_count is only incremented for actual state changes.
    let rejected = 0;
    const skipped: string[] = [];

    for (const id of ids) {
      // Pre-flight: read outside tx for fast-skip (risk, locks). If the row
      // disappears between here and decideAtomically, decideAtomically returns
      // not_found and we skip.
      const proposal = await this.getOne(tenantId, id);
      if (!proposal) {
        skipped.push(id);
        continue;
      }
      // Spec perfil-inbox v4 §1.5 — perfis FORA do bulkReject na v1 da
      // integração: rejeitar perfil é transição terminal (rolled_back) e
      // merece decisão individual com o diff na frente do operador.
      if (proposal.type === 'operational_profile') {
        skipped.push(id);
        continue;
      }
      if (proposal.risk !== 'low') {
        skipped.push(id);
        continue;
      }
      if (proposal.locks.length > 0) {
        skipped.push(id);
        continue;
      }
      // Authoritative transactional path: lock + validate + write atomically.
      const result = await this.decideAtomically({
        tenantId,
        proposalId: id,
        type: proposal.type,
        approvalClass: `${proposal.type}_${proposal.risk}`,
        actorId,
        actorRole,
        decision: 'rejected',
        comment,
        dualComplete: true, // single rejection is always gate-complete.
      });
      if (!result.ok) {
        // invalid_source_status → row already delivered/approved/rejected.
        // not_found → race: row deleted between pre-flight and lock.
        // Either way: no state change → skip without counting.
        skipped.push(id);
        continue;
      }
      rejected += 1;
    }
    return { rejected_count: rejected, skipped_ids: skipped };
  },
};

/**
 * proposalApprovalsRepo — track + check dual-approval state.
 */
export const proposalApprovalsRepo = {
  /**
   * 093 (spec perfil-inbox v4 §1.6): predicates de leitura incluem
   * `tenant_id` SEMPRE que o chamador o conhece (todos os routers conhecem);
   * o parâmetro é opcional só para compatibilidade com chamadores legados.
   */
  async listByProposal(proposalId: string, tenantId?: string): Promise<ProposalApproval[]> {
    return await db
      .select()
      .from(proposal_approvals)
      .where(
        and(
          eq(proposal_approvals.proposal_id, proposalId),
          ...(tenantId ? [eq(proposal_approvals.tenant_id, tenantId)] : []),
        ),
      );
  },

  /**
   * 093 (spec perfil-inbox v4 §1.6) — guard de escrita: decisão NOVA sem
   * escopo completo (agent_id + proposal_source, aos pares) é rejeitada AQUI
   * além do CHECK no DB. Rows legadas (ambos nulos) só existem via histórico.
   */
  async record(input: NewProposalApproval): Promise<ProposalApproval> {
    if ((input.agent_id == null) !== (input.proposal_source == null)) {
      throw new TypedError(
        'approval_scope_incomplete',
        'proposal_approvals: agent_id and proposal_source must be provided together',
      );
    }
    if (input.agent_id == null) {
      throw new TypedError(
        'approval_scope_incomplete',
        'proposal_approvals: new decisions must carry full scope (tenant, agent, source)',
      );
    }
    const rows = await db.insert(proposal_approvals).values(input).returning();
    if (!rows[0]) throw new TypedError('approval_insert_failed', 'Could not record approval');
    return rows[0];
  },
};

/**
 * adminAuditLogRepo — APPEND-ONLY mutation trail for admin-ui actions.
 *
 * IMPORTANT: this repo exposes ONLY `append` and `list`. There is NO update
 * or delete method. Lint rule (eslint custom config) flags any direct
 * `update(admin_audit_log)` or `delete(admin_audit_log)` usage in src/.
 */
export const adminAuditLogRepo = {
  async append(entry: NewAdminAuditLogEntry): Promise<AdminAuditLogEntry> {
    const rows = await db.insert(admin_audit_log).values(entry).returning();
    if (!rows[0]) throw new TypedError('audit_log_append_failed', 'Could not append audit entry');
    return rows[0];
  },

  async list(input: {
    tenantId: string;
    actorId?: string;
    resourceType?: string;
    limit?: number;
  }): Promise<AdminAuditLogEntry[]> {
    const limit = input.limit ?? 100;
    const where = [eq(admin_audit_log.tenant_id, input.tenantId)];
    if (input.actorId) where.push(eq(admin_audit_log.actor_id, input.actorId));
    if (input.resourceType) where.push(eq(admin_audit_log.resource_type, input.resourceType));
    return await db
      .select()
      .from(admin_audit_log)
      .where(and(...where))
      .orderBy(desc(admin_audit_log.created_at))
      .limit(limit);
  },
};

/**
 * debugSnapshotGrantsRepo — TTL-bounded permission grants for trace bodies.
 */
export const debugSnapshotGrantsRepo = {
  async create(input: NewDebugSnapshotGrant): Promise<DebugSnapshotGrant> {
    const rows = await db.insert(debug_snapshot_grants).values(input).returning();
    if (!rows[0]) throw new TypedError('grant_insert_failed', 'Could not create grant');
    return rows[0];
  },

  async findActive(args: {
    tenantId: string;
    userId: string;
    traceId: string;
  }): Promise<DebugSnapshotGrant | null> {
    const now = new Date();
    const rows = await db
      .select()
      .from(debug_snapshot_grants)
      .where(
        and(
          eq(debug_snapshot_grants.tenant_id, args.tenantId),
          eq(debug_snapshot_grants.granted_to_user_id, args.userId),
          eq(debug_snapshot_grants.trace_id, args.traceId),
          isNull(debug_snapshot_grants.revoked_at),
          gt(debug_snapshot_grants.expires_at, now),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
};

// =====================================================================
// global_settings — issue #183 / PR #188 Codex round 1 (high + medium)
// =====================================================================

/**
 * globalSettingsRepo — process-wide singleton settings (NOT scoped to
 * tenant/agent). Currently backs the founder-only LLM model switch
 * (/setup/llm-settings) but the table is intentionally generic so future
 * deployment-wide settings can reuse it.
 *
 * Why a new table (round 1, [high]):
 *   The previous storage in `agent_facts (tenant_id, agent_id, escopo, chave)`
 *   silently scoped the founder's "global" model pick to the founder's own
 *   `default` agent. Runtime `callLLM` reads inside the CURRENT request's
 *   (tenant_id, agent_id) AsyncLocalStorage context — for any non-default
 *   agent or any other tenant, that's a different row. Founder UI showed
 *   "audited successfully", but those callers kept using the env model.
 *   In incident-time (Anthropic outage, model deprecation) this defeats the
 *   entire purpose of the page. The fix is structural: a table with NO
 *   tenant/agent discriminator.
 *
 * Why `updateAtomic` instead of separate `set` + audit (round 1, [medium]):
 *   The router originally read current values OUTSIDE the tx, then skipped
 *   writes based on that stale snapshot, then audited
 *   `after={input.main, input.fast}`. Two concurrent founders updating
 *   different sides could observe stale `before`, write different values
 *   than what the audit row claims, and leave the DB in a state where the
 *   audit trail is corrupted (forensic gap). Fix: read the current value
 *   INSIDE the tx under `SELECT ... FOR UPDATE` on the row's PK, then
 *   UPSERT, then audit — all in one withTx. Audit `before` is the actual
 *   locked value; audit `after` is what the UPSERT just committed.
 */
/**
 * Codex round 5 on PR #188 [high]: subset-match comparator used by
 * `globalSettingsRepo.updateAtomic`'s optimistic-concurrency check.
 *
 *   - `expected === null` ⇔ "no row should exist". Matches only when
 *     `locked === null` (covers both SQL NULL and the placeholder
 *     'null'::jsonb that updateAtomic INSERTs before the FOR UPDATE).
 *   - `expected = { k1: v1, ... }` ⇔ for each key in `expected`, the
 *     corresponding key in `locked` must deep-equal that value. Extra
 *     keys in `locked` (e.g. `provider` stamped by round-5 writes when
 *     the caller only observed `model`) are allowed. This is the
 *     key behavioral change that lets the LLM settings helper grow
 *     the persisted jsonb shape without breaking clients that observed
 *     only the older shape.
 *
 * Equality on nested values is JSON-canonical (`JSON.stringify`
 * after a stable key sort). All values stored in `global_settings` so
 * far are plain JSON (no functions, dates, etc.), so this is safe.
 */
function matchesExpected(
  locked: unknown,
  expected: Record<string, unknown> | null,
): boolean {
  if (expected === null) {
    // "Expect no row" — locked must be one of the null shapes.
    return locked === null;
  }
  if (locked === null || typeof locked !== 'object') {
    // Caller asked for fields; locked has none to offer.
    return false;
  }
  const lockedObj = locked as Record<string, unknown>;
  for (const k of Object.keys(expected)) {
    if (canonicalize(lockedObj[k]) !== canonicalize(expected[k])) {
      return false;
    }
  }
  return true;
}

function canonicalize(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      o[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return o;
  }
  return v;
}

export const globalSettingsRepo = {
  /**
   * Read a single global setting by key. Returns null if the key is not
   * set (caller must apply its own default — for LLM models, that's the
   * env var fallback). Caller-tolerant of DB errors via the surrounding
   * try/catch in `getCurrent*Model` (DB hiccup → env default rather than
   * blocking the LLM call).
   */
  async getByKey(key: string): Promise<{ value: unknown; updated_at: Date; updated_by: string | null } | null> {
    const rows = await db
      .select()
      .from(global_settings)
      .where(eq(global_settings.key, key))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { value: row.value, updated_at: row.updated_at, updated_by: row.updated_by };
  },

  /**
   * Atomic multi-key update + audit. All keys are upserted under a single
   * tx with `SELECT ... FOR UPDATE` on each row (serializes concurrent
   * founders). Audit row sees the REAL before/after under the lock — not a
   * stale pre-tx snapshot. If the audit insert throws, every upsert rolls
   * back together.
   *
   * Steps inside the tx:
   *   1. For each key, first `INSERT ... ON CONFLICT DO NOTHING` with a
   *      JSON-null placeholder, then `SELECT value FROM global_settings
   *      WHERE key = $1 FOR UPDATE` — Codex round 2 [P2] showed that
   *      without the placeholder, `FOR UPDATE` on a non-existent row
   *      doesn't take any lock, so two concurrent first-writers on a
   *      fresh deploy could both read null and both UPSERT, producing
   *      audit rows whose `before`/`after` don't match the committed DB
   *      state. The placeholder INSERT serializes the race because the
   *      conflict path waits on the inserting tx's row-level lock; the
   *      subsequent SELECT FOR UPDATE then holds the lock for the rest
   *      of this tx. Concurrent writers wait here.
   *   2. Compute `before[key]` from the locked value (JSON null and SQL
   *      NULL both coalesce to JS null — pre-062 rows and the new
   *      placeholder look identical to callers).
   *   3. For each key where `before !== requested`, UPSERT new value with
   *      `updated_at = now`, `updated_by = audit.actor_id`.
   *   4. If NO key actually changed, return `{ ok:false, reason:'no_changes', before }`
   *      so the caller can map to BAD_REQUEST without polluting the audit
   *      log with a no-op row.
   *   5. INSERT admin_audit_log with `action`, `change_summary={ before, after, ...meta }`.
   *      If this throws, ROLLBACK reverts every UPSERT (atomicity invariant
   *      matching `tenantsRepo.updateStatusAtomic`).
   *
   * `meta` is merged into `change_summary` so the caller can stamp extra
   * fields (operator comment, scope label, etc.) without us hardcoding a
   * schema that future callers won't need.
   */
  async updateAtomic(input: {
    keys: ReadonlyArray<{
      key: string;
      value: Record<string, unknown>;
      // Codex round 3 on PR #188 [P2]: optional optimistic-concurrency
      // pre-check. When set, the locked value MUST match `expected`
      // or the whole tx aborts with `reason: 'optimistic_conflict'`. The
      // check runs INSIDE the tx, AFTER the SELECT ... FOR UPDATE, so
      // it's race-free against concurrent writers. `expected = null`
      // means "expect the key to be unset"; `expected = undefined` (or
      // omitted) means "no expectation, proceed unconditionally".
      //
      // Codex round 5 on PR #188 [high]: the comparison semantic is
      // "expected is a key-subset of locked" — every field in
      // `expected` must equal the same field in `lockedValue`, but
      // locked may have additional fields. This lets writes that grow
      // the persisted shape (e.g. adding `provider` alongside `model`)
      // keep accepting clients that observed only the old shape. If a
      // caller wants strict full-shape equality, pass every locked-
      // shape field in `expected`.
      expected?: Record<string, unknown> | null;
    }>;
    audit: {
      tenant_id: string;
      actor_id: string;
      actor_role: string;
      action: string;
      resource_type: string;
      resource_id?: string | null;
      meta?: Record<string, unknown>;
    };
  }): Promise<
    | {
        ok: true;
        applied_at: Date;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      }
    | {
        ok: false;
        reason: 'no_changes';
        before: Record<string, unknown>;
      }
    | {
        ok: false;
        reason: 'optimistic_conflict';
        // Identify the FIRST key that failed the expected check (sorted
        // key order — same order as the lock acquisition).
        key: string;
        expected: Record<string, unknown> | null;
        current: unknown;
        // Full `before` snapshot of all keys read up to the conflict
        // point. Callers use this to render a useful UI message.
        before: Record<string, unknown>;
      }
  > {
    return await withTx(async (tx) => {
      const now = new Date();
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      let changedCount = 0;
      let conflict:
        | {
            key: string;
            expected: Record<string, unknown> | null;
            current: unknown;
          }
        | null = null;

      // (1) Lock each row FOR UPDATE in deterministic key order. Sorting
      // the keys before locking prevents two concurrent updates that touch
      // an overlapping set of keys from deadlocking each other (a holds
      // main waiting for fast, b holds fast waiting for main). Same trick
      // we use elsewhere in the codebase for multi-row locks.
      const sortedKeys = [...input.keys].sort((a, b) => a.key.localeCompare(b.key));

      for (const entry of sortedKeys) {
        // Codex round 2 on PR #188 [P2]: `SELECT ... FOR UPDATE` does NOT
        // lock a row that doesn't exist. Migration 062 ships the
        // `global_settings` table empty, so two concurrent founders on a
        // fresh deploy could both read `null` here, both UPSERT, and end
        // up with an audit row whose `before` claims null but whose
        // `after` reflects only one founder's input — the same forensic-
        // gap class as round 1 [medium]. Fix: insert a placeholder row
        // via ON CONFLICT DO NOTHING BEFORE the FOR UPDATE select. The
        // placeholder uses `'null'::jsonb` as the value so the lineage
        // starts at literal null (not at a fake string) — `before[key]`
        // computed below honors that. Once the row exists, the FOR
        // UPDATE on the next select actually serializes concurrent txs.
        await tx.execute(sql`
          INSERT INTO ${global_settings} (key, value, updated_at, updated_by)
          VALUES (${entry.key}, 'null'::jsonb, now(), ${input.audit.actor_id})
          ON CONFLICT (key) DO NOTHING
        `);

        const locked = await tx
          .select()
          .from(global_settings)
          .where(eq(global_settings.key, entry.key))
          .for('update')
          .limit(1);
        // Treat the placeholder JSON null exactly like a never-set row so
        // existing callers (and the "no_changes" check below) keep the
        // null-as-absent semantics. With the placeholder INSERT above the
        // row now always exists, but its value can be SQL NULL (legacy
        // pre-062 rows, if any) OR JSON null (placeholder from this tx)
        // OR a real `{model: "..."}` payload (a prior committed write).
        // Both null shapes coalesce to JS `null` here.
        const lockedValue = locked[0]?.value ?? null;
        before[entry.key] = lockedValue;
        after[entry.key] = entry.value;

        // Codex round 3 on PR #188 [P2]: optimistic-concurrency check.
        // If the caller supplied `expected`, compare against the LOCKED
        // value (NOT the pre-tx snapshot — same reason the rest of this
        // function reads under FOR UPDATE). On mismatch we don't break
        // the loop yet: we continue locking remaining keys so all
        // subsequent rows get released cleanly when the tx aborts via
        // throw, and so `before` is populated for the response. The
        // throw below converts the conflict into the typed return
        // shape after the loop.
        //
        // Codex round 5 [high]: comparison is "expected is a key-subset
        // of locked" — every key present in `expected` must match the
        // same key in `lockedValue`, but lockedValue may have extra
        // keys. This lets the LLM settings helper grow the persisted
        // shape (adding `provider` next to `model`) without breaking
        // optimistic-conflict checks from clients that observed only
        // the older `{ model }` shape. The two edge cases (expected
        // === null and locked === null) keep their original strict
        // equality — those signal "no row" and must match exactly.
        if (
          entry.expected !== undefined &&
          conflict === null &&
          !matchesExpected(lockedValue, entry.expected)
        ) {
          conflict = {
            key: entry.key,
            expected: entry.expected,
            current: lockedValue,
          };
          // Don't break: finish locking so `before` is complete and the
          // tx rolls back the placeholder INSERTs uniformly. We skip
          // the upsert below by short-circuiting on `conflict !== null`.
          continue;
        }

        // If a prior key conflicted, don't write this one either —
        // we're going to abort below.
        if (conflict !== null) continue;

        // Deep-equal comparison via JSON canonicalization. Both sides are
        // simple JSON (no functions, no Dates) so JSON.stringify is a safe
        // canonical form. Skipping the UPSERT when the value matches avoids
        // a wasted write AND keeps `updated_at` honest (it should reflect
        // the last actual change, not a no-op renew).
        if (JSON.stringify(lockedValue) === JSON.stringify(entry.value)) {
          continue;
        }

        await tx
          .insert(global_settings)
          .values({
            key: entry.key,
            value: entry.value,
            updated_at: now,
            updated_by: input.audit.actor_id,
          })
          .onConflictDoUpdate({
            target: [global_settings.key],
            set: {
              value: entry.value,
              updated_at: now,
              updated_by: input.audit.actor_id,
            },
          });
        changedCount++;
      }

      // (2) Optimistic-conflict abort. We did NOT call the upsert for the
      // conflicting key (or any subsequent key), so the only DB effect
      // inside this tx is the placeholder INSERTs from step (1) — those
      // are harmless on rollback. We do NOT write the audit row because
      // there's no real state change to record.
      if (conflict !== null) {
        // Throw to force a rollback of the placeholder INSERTs above.
        // The withTx wrapper catches and re-raises, so we package the
        // typed payload as a non-Error sentinel that updateAtomic itself
        // unwraps. But the simpler path here: since we haven't UPSERTED
        // anything, the placeholder INSERTs of a NULL jsonb are
        // observationally equivalent to "key was never set" for the
        // null-as-absent semantics callers rely on. Still, we rely on
        // rollback for correctness if any side effects existed.
        throw new ConflictAbortSignal({
          key: conflict.key,
          expected: conflict.expected,
          current: conflict.current,
          before,
        });
      }

      if (changedCount === 0) {
        // No real change under the lock → caller can map to BAD_REQUEST.
        // The tx will commit empty (no audit row, no upsert) — cheap and
        // honest. Returning `before` lets the caller surface what's
        // currently in DB if it wants to.
        return { ok: false as const, reason: 'no_changes' as const, before };
      }

      // (3) Audit in the SAME tx. before/after here are the REAL locked
      // values, not whatever the caller read pre-tx — so concurrent
      // founders can't corrupt the audit trail.
      await tx.insert(admin_audit_log).values({
        tenant_id: input.audit.tenant_id,
        actor_id: input.audit.actor_id,
        actor_role: input.audit.actor_role,
        action: input.audit.action,
        resource_type: input.audit.resource_type,
        resource_id: input.audit.resource_id ?? null,
        change_summary: {
          before,
          after,
          ...(input.audit.meta ?? {}),
        },
      });

      return { ok: true as const, applied_at: now, before, after };
    }).catch((err: unknown) => {
      // Unwrap the optimistic-conflict sentinel into the typed return.
      // Any other error (DB, audit-insert FK violation, etc.) is a real
      // failure — propagate it so callers preserve the atomicity
      // invariant: a thrown error means NO state changed.
      if (err instanceof ConflictAbortSignal) {
        return {
          ok: false as const,
          reason: 'optimistic_conflict' as const,
          key: err.payload.key,
          expected: err.payload.expected,
          current: err.payload.current,
          before: err.payload.before,
        };
      }
      throw err;
    });
  },
};

// Sentinel used to abort the withTx callback when an optimistic check
// fails. Throwing inside withTx is the standard way to force a ROLLBACK;
// catching this specific type lets us convert the rollback into a typed
// `{ ok: false, reason: 'optimistic_conflict' }` return without leaking
// the throw to callers. Not exported — the conflict path is observable
// via the discriminated union only.
class ConflictAbortSignal {
  constructor(
    public readonly payload: {
      key: string;
      expected: Record<string, unknown> | null;
      current: unknown;
      before: Record<string, unknown>;
    },
  ) {}
}
