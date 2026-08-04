import { eq, and, inArray, desc, isNull, sql } from 'drizzle-orm';
import { db } from '../client.js';
import {
  entidades,
  contas_bancarias,
  transacoes,
  contrapartes,
  categorias,
  entity_states,
  } from '../schema.js';
import { applyTenantGuard } from '../tenant-guard.js';
import { getCurrentTenant, getCurrentAgent } from '../tenant-context.js';
import type { Entidade, Conta, Transacao, Contraparte, Categoria, EntityState } from '../schema.js';
import { EmptyScopeError } from './core.js';
import type { EntityScope } from './core.js';

export const entidadesRepo = {
  /**
   * Issue #345 (Phase 4 of #323) — tenant-scope the entity list.
   *
   * `list()` feeds the briefing inners (morning/evening/weekly), which now run
   * ONCE PER enumerated (tenant_id, agent_id) tuple. An UNSCOPED `select(entidades)`
   * would return EVERY tenant's entities under each tuple's run, and the morning
   * briefing's per-entity `contasRepo.byEntity()` + balance sum would then mix
   * another tenant's accounts into the briefing sent to THIS tenant's owner — a
   * severe cross-tenant financial leak (the inviolable isolation invariant). Bind
   * the current ALS (tenant_id, agent_id) so the list is the running tuple's
   * entities only. `entidades` carries both columns (schema NOT NULL), so the
   * predicate is exact.
   */
  async list(): Promise<Entidade[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(entidades)
      .where(and(eq(entidades.tenant_id, tenant_id), eq(entidades.agent_id, agent_id)));
  },
  async byId(id: string): Promise<Entidade | null> {
    const rows = await db.select().from(entidades).where(eq(entidades.id, id)).limit(1);
    return rows[0] ?? null;
  },
  /**
   * Issue #525 — `byIds` used to match on `entidades.id` ALONE.
   *
   * Every live caller (`agent/turn-context/loader.ts`, `tools/identify-entity`,
   * `tools/compare-entities`, `tools/generate-report`) feeds it ids that came
   * from `resolveScope`, so the ids were already tenant-checked and no leak was
   * reachable in practice. But "safe because of what the caller happened to
   * pass" is not the isolation invariant (AGENTS.md §4.1): an id is not a
   * boundary, and this read renders `ent.nome` straight into the system prompt.
   * Bind (tenant_id, agent_id) from ALS so a foreign id is simply absent from
   * the result — the same shape the callers already handle for a missing row.
   */
  async byIds(ids: string[]): Promise<Entidade[]> {
    if (ids.length === 0) return [];
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(entidades)
      .where(
        and(
          inArray(entidades.id, ids),
          eq(entidades.tenant_id, tenant_id),
          eq(entidades.agent_id, agent_id),
        ),
      );
  },

  /**
   * Issue #525 — entity rows AND their state rows in ONE round-trip.
   *
   * The turn's "## Escopo desta conversa" and "## Estado atual" blocks are the
   * same set of entities read twice: `entidadesRepo.byIds` for the names, then
   * `entityStatesRepo.byIds` for the balances. They are joined on
   * `entity_states.entidade_id = entidades.id`, which is exactly what a LEFT
   * JOIN does — so the second statement was never buying anything except a
   * round-trip on the fixed 10-connection pool (`src/db/client.ts`).
   *
   * LEFT, not INNER: an entity with no state row must still render its name in
   * the scope block. The caller distinguishes the two by `state === null`,
   * which is the same signal `entityStatesRepo.byId` gave by returning null.
   *
   * Tenant scoping is applied on BOTH sides. On `entidades` it is the ordinary
   * predicate; on `entity_states` it lives in the JOIN condition, because
   * `entity_states`'s PK is `entidade_id` alone — a row can exist for an id
   * under another tuple, and putting the predicate in the WHERE clause of a
   * LEFT JOIN would filter the whole row out instead of just the state half.
   *
   * `limit` bounds the result the same way `entityStatesRepo.byIds` did; the
   * join is 1:1 on a PK, so the row count is at most `ids.length`.
   */
  async byIdsWithState(
    ids: string[],
    limit = 500,
  ): Promise<Array<{ entidade: Entidade; state: EntityState | null }>> {
    if (ids.length === 0) return [];
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select({ entidade: entidades, state: entity_states })
      .from(entidades)
      .leftJoin(
        entity_states,
        and(
          eq(entity_states.entidade_id, entidades.id),
          eq(entity_states.tenant_id, tenant_id),
          eq(entity_states.agent_id, agent_id),
        ),
      )
      .where(
        and(
          inArray(entidades.id, Array.from(new Set(ids))),
          eq(entidades.tenant_id, tenant_id),
          eq(entidades.agent_id, agent_id),
        ),
      )
      // Deterministic order so the rendered blocks are byte-stable for the same
      // scope across turns. The caller re-sorts into scope order; ordering here
      // just removes DB nondeterminism.
      .orderBy(entidades.id)
      .limit(limit);
    return rows.map((r) => ({ entidade: r.entidade, state: r.state ?? null }));
  },
  async create(input: Omit<Entidade, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<Entidade> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(entidades).values(guarded).returning();
    return rows[0]!;
  },
};

export const contasRepo = {
  /**
   * Issue #345 (Phase 4 of #323) — tenant-scope the per-entity account read.
   *
   * `byEntity()` is called by the morning briefing inner (per entity, per tuple)
   * and by read tools (`query-balance`, `compare-entities`). Filtering by
   * `entidade_id` ALONE is not enough: `entidade_id` is a random UUID, but a
   * per-tuple briefing run that already (pre-fix) saw another tenant's entities
   * would then read that entity's accounts and sum their balances into THIS
   * tenant's briefing. Add an EXPLICIT (tenant_id, agent_id) predicate bound from
   * ALS so a row is returned iff it belongs to the running tuple — defense in
   * depth alongside the now-scoped `entidadesRepo.list()`. `contas_bancarias`
   * carries both columns (schema NOT NULL).
   */
  async byEntity(entidade_id: string): Promise<Conta[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(contas_bancarias)
      .where(
        and(
          eq(contas_bancarias.tenant_id, tenant_id),
          eq(contas_bancarias.agent_id, agent_id),
          eq(contas_bancarias.entidade_id, entidade_id),
        ),
      );
  },
  async byId(id: string): Promise<Conta | null> {
    // Flip-readiness (#323, H3 of #355 — PR #364 review blocker 1) — FINANCIAL
    // pre-write lookup: tenant+agent scope the WHERE (bound from ALS), mirroring
    // the now-scoped `byEntity` read and the `addToBalance` write below. Both
    // columns are NOT NULL (schema `contas_bancarias`). Both live callers run
    // inside the agent turn's `runWithTenantContext({tenant_id, agent_id})`
    // (agent/core.ts `runAgentForMensagem`):
    //   - `tools/register-transaction.ts` pre-loads the conta here BEFORE the
    //     balance write; an id-only WHERE would let a misrouted/cross-tenant
    //     account id pass this pre-check and only trip the now-scoped
    //     `addToBalance` 0-row guard AFTER the ledger row committed. Scoping the
    //     read rejects the cross-tenant account EARLY (returns null →
    //     `conta_not_found`), so the transaction is never created.
    //   - `tools/query-balance.ts` already discards an out-of-scope conta via
    //     `ctx.scope.entidades.includes(c.entidade_id)`; the predicate just makes
    //     the read itself tenant-safe (defense in depth — a foreign conta no
    //     longer even loads).
    // Returns null (not throw) on no-match: a missing/foreign account is a
    // legitimate not-found for a READ, and both callers already handle null.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(contas_bancarias)
      .where(
        and(
          eq(contas_bancarias.tenant_id, tenant_id),
          eq(contas_bancarias.agent_id, agent_id),
          eq(contas_bancarias.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async byEntities(scope: EntityScope): Promise<Conta[]> {
    if (scope.entidades.length === 0) throw new EmptyScopeError();
    return db
      .select()
      .from(contas_bancarias)
      .where(inArray(contas_bancarias.entidade_id, scope.entidades));
  },
  async create(input: Omit<Conta, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<Conta> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(contas_bancarias).values(guarded).returning();
    return rows[0]!;
  },
  async addToBalance(id: string, delta: number): Promise<Conta | null> {
    // Non-tx entry point (kept for callers that don't need to bundle the credit
    // with another write). Delegates to the shared scoped + fail-loud core on
    // the pooled `db` handle. `register-transaction.ts` now uses `addToBalanceTx`
    // so the credit is atomic with its ledger INSERT (see below).
    return addToBalanceWith(db, id, delta);
  },
  /**
   * Flip-readiness (#323, H3 of #355 — PR #364 review blocker 2) — tx-aware
   * balance credit, identical scoping + fail-loud to `addToBalance` but issued
   * on the caller's in-tx handle so it commits ATOMICALLY with a paired
   * `transacoesRepo.createTx` ledger INSERT inside one `withTx`. A 0-row throw
   * (cross-tenant misroute) then rolls the ledger row back too — closing the
   * "committed transaction with no balance credit" inconsistency. Mirrors the
   * `*Tx` convention (`pendingQuestionsRepo.resolveTx`). Caller MUST already be
   * inside `withTx`.
   */
  async addToBalanceTx(tx: typeof db, id: string, delta: number): Promise<Conta | null> {
    return addToBalanceWith(tx, id, delta);
  },
};

/**
 * Shared scoped + FAIL-LOUD core for `contasRepo.addToBalance` /
 * `addToBalanceTx`. Kept as ONE function so the tenant/agent predicate and the
 * 0-row guard can never drift between the pooled-`db` and the in-`tx` paths.
 *
 * Flip-readiness (#323, H3 of #355) — FINANCIAL mutation: tenant+agent scope the
 * WHERE (bound from ALS), mirroring the now-scoped `contasRepo.byEntity` /
 * `byId`. Both columns are NOT NULL (schema `contas_bancarias`). The sole live
 * caller (`tools/register-transaction.ts`) runs inside the agent turn's
 * `runWithTenantContext({tenant_id, agent_id})` (agent/core.ts
 * `runAgentForMensagem`) and only ever adjusts the `conta` it loaded via the
 * now-scoped `contasRepo.byId(conta_id)` + asserted `conta.entidade_id ===
 * args.entidade_id`, where `args.entidade_id` was authorized against the running
 * tuple's entity scope by the dispatcher — so the conta belongs to the running
 * (tenant_id, agent_id) and the predicate matches the exact row.
 *
 * FAIL-LOUD (throw on !=1): this UPDATEs one specific, known-present account's
 * running balance by an exact numeric delta. The id-only WHERE always matched,
 * so a 0-row result under the new predicate can ONLY mean a tenant/agent
 * mismatch (a cross-tenant misroute) — NOT a benign no-op. Silently swallowing
 * that miss would leave `saldo_atual` un-incremented while the matching
 * `transacoes` row already exists: the balance and its ledger would diverge
 * permanently — corrupted money. There is no legitimate 0-row path (the caller
 * gates the call itself behind `status==='paga'|'recebida'`; when it does call,
 * the target account is the one it just loaded), so we surface the miss loudly
 * instead of returning `null`. Same `.returning()` + `.length` idiom as
 * `mensagensRepo.markProcessed` / `pendingQuestionsRepo.resolve`. The thrown
 * message keeps the `addToBalance matched N rows` token across both entry points
 * so dashboards/tests match either path.
 */
async function addToBalanceWith(
  executor: typeof db,
  id: string,
  delta: number,
): Promise<Conta | null> {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  const rows = await executor
    .update(contas_bancarias)
    .set({
      saldo_atual: sql`saldo_atual + ${delta}`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(contas_bancarias.id, id),
        eq(contas_bancarias.tenant_id, tenant_id),
        eq(contas_bancarias.agent_id, agent_id),
      ),
    )
    .returning();
  if (rows.length !== 1) {
    throw new Error(
      `contasRepo.addToBalance matched ${rows.length} rows for conta ${id} ` +
        `under ${tenant_id}/${agent_id} — expected 1 (tenant/agent context does ` +
        `not match the target account; the balance update would have been ` +
        `silently lost while its transaction already committed — corrupted money)`,
    );
  }
  return rows[0] ?? null;
}

export const transacoesRepo = {
  async byScope(
    scope: EntityScope,
    filter?: {
      date_from?: string;
      date_to?: string;
      categoria_id?: string;
      natureza?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<Transacao[]> {
    if (scope.entidades.length === 0) throw new EmptyScopeError();
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const conds = [
      eq(transacoes.tenant_id, tenant_id),
      eq(transacoes.agent_id, agent_id),
      inArray(transacoes.entidade_id, scope.entidades),
    ];
    if (filter?.date_from) conds.push(sql`data_competencia >= ${filter.date_from}`);
    if (filter?.date_to) conds.push(sql`data_competencia <= ${filter.date_to}`);
    if (filter?.categoria_id) conds.push(eq(transacoes.categoria_id, filter.categoria_id));
    if (filter?.natureza) conds.push(eq(transacoes.natureza, filter.natureza));
    return db
      .select()
      .from(transacoes)
      .where(and(...conds))
      .orderBy(desc(transacoes.data_competencia))
      .limit(filter?.limit ?? 50)
      .offset(filter?.offset ?? 0);
  },
  async create(input: Omit<Transacao, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<Transacao> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(transacoes).values(guarded).returning();
    return rows[0]!;
  },
  /**
   * Flip-readiness (#323, H3 of #355 — PR #364 review blocker 2) — tx-aware
   * INSERT of the ledger row, so a caller can commit it ATOMICALLY with the
   * paired `contasRepo.addToBalanceTx` balance credit inside one `withTx`.
   *
   * `register-transaction.ts` previously committed `create` (ledger row) and
   * THEN called the now-fail-loud `addToBalance`; a 0-row throw there (a
   * cross-tenant misroute the scoped predicate catches) left a committed
   * transaction with NO matching balance credit — the ledger and `saldo_atual`
   * diverge permanently (corrupted money). Running both writes through the SAME
   * `tx` means the `addToBalanceTx` throw rolls the INSERT back too.
   *
   * Identical write to `create` (same `applyTenantGuard` → tenant/agent stamped
   * from ALS) but issued on the caller's in-tx handle. Mirrors the `*Tx`
   * convention used by `pendingQuestionsRepo.resolveTx` /
   * `procedureExecutionsRepo.updateStateTx`. The caller MUST already be inside
   * `withTx`.
   */
  async createTx(
    tx: typeof db,
    input: Omit<Transacao, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>,
  ): Promise<Transacao> {
    const guarded = applyTenantGuard(input);
    const rows = await tx.insert(transacoes).values(guarded).returning();
    return rows[0]!;
  },
  async listRecent(limit = 50): Promise<Transacao[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(transacoes)
      .where(and(eq(transacoes.tenant_id, tenant_id), eq(transacoes.agent_id, agent_id)))
      .orderBy(desc(transacoes.created_at))
      .limit(limit);
  },
  /**
   * Issue #363 — tenant-scoped read of PENDING (unconfirmed) transações for a
   * set of entidades, for the `list_pending` LLM tool (whose result, incl.
   * `descricao`/`valor`, is injected back into the prompt context). `entidade_id`
   * is a GLOBAL uuid, so the tool's old inline `inArray(transacoes.entidade_id, …)`
   * did NOT scope by tenant — another tenant's pending transação for a
   * shared/guessed entidade would leak into the LLM context (R2 contamination).
   * Bind tenant+agent from ALS (both NOT NULL) so the read returns ONLY the
   * running tuple's rows. Same `status='pendente' AND confirmada_em IS NULL`
   * filter the tool used.
   */
  async listPendingForEntidades(entidades: string[], limit: number): Promise<Transacao[]> {
    if (entidades.length === 0) return [];
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(transacoes)
      .where(
        and(
          eq(transacoes.tenant_id, tenant_id),
          eq(transacoes.agent_id, agent_id),
          inArray(transacoes.entidade_id, entidades),
          eq(transacoes.status, 'pendente'),
          isNull(transacoes.confirmada_em),
        ),
      )
      .orderBy(desc(transacoes.data_competencia))
      .limit(limit);
  },
  async findRecentSimilar(params: {
    entidade_id: string;
    valor: string;
    descricao: string;
    registrado_por: string;
    sinceMs: number;
  }): Promise<Transacao[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const since = new Date(Date.now() - params.sinceMs);
    return db
      .select()
      .from(transacoes)
      .where(
        and(
          eq(transacoes.tenant_id, tenant_id),
          eq(transacoes.agent_id, agent_id),
          eq(transacoes.entidade_id, params.entidade_id),
          eq(transacoes.valor, params.valor),
          eq(transacoes.registrado_por, params.registrado_por),
          sql`created_at >= ${since.toISOString()}`,
        ),
      );
  },
  async byId(id: string): Promise<Transacao | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(transacoes)
      .where(
        and(
          eq(transacoes.tenant_id, tenant_id),
          eq(transacoes.agent_id, agent_id),
          eq(transacoes.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async update(id: string, patch: Partial<Transacao>): Promise<void> {
    await updateTransacaoWith(db, id, patch);
  },
  /**
   * Issue #366 — TRANSACTIONAL variant of `update`. Same scoped + FAIL-LOUD
   * core (`updateTransacaoWith`) but on the passed `tx` handle, so the cancel
   * UPDATE commits/rolls back together with its audit row (`auditTx`) inside
   * one `withTx` (cancel-transaction). A failed audit insert aborts the cancel
   * — the transaction can never flip to 'cancelada' without its audit row.
   */
  async updateTx(tx: typeof db, id: string, patch: Partial<Transacao>): Promise<void> {
    await updateTransacaoWith(tx, id, patch);
  },
};

/**
 * Shared scoped + FAIL-LOUD core for `transacoesRepo.update` / `updateTx`. Kept
 * as ONE function so the tenant/agent predicate and the 0-row guard can never
 * drift between the pooled-`db` and the in-`tx` paths — mirroring the
 * `addToBalanceWith` precedent for the paired FINANCIAL balance write.
 *
 * Flip-readiness (#323, H3 of #355) — FINANCIAL mutation: tenant+agent scope
 * the WHERE (bound from ALS), mirroring the already-scoped `transacoesRepo.byId`
 * / `byScope`. Both columns are NOT NULL (schema `transacoes`). The sole live
 * caller (`tools/cancel-transaction.ts`) runs inside the agent turn's
 * `runWithTenantContext({tenant_id, agent_id})` (agent/core.ts) and patches the
 * exact `tx` it loaded via the ALREADY tenant+agent-scoped
 * `transacoesRepo.byId(transacao_id)`, after asserting `tx.entidade_id ===
 * args.entidade_id` AND `scope.entidades.includes(tx.entidade_id)` — so the row
 * provably belongs to the running (tenant_id, agent_id) and the predicate
 * matches it.
 *
 * FAIL-LOUD (throw on !=1): this stamps a single, known-present transaction's
 * lifecycle (the cancel path sets `status='cancelada'`). The id-only WHERE
 * always matched, so a 0-row result under the new predicate can ONLY be a
 * tenant/agent mismatch (cross-tenant misroute) — never a benign no-op. The
 * caller short-circuits the idempotent retry BEFORE reaching here (it returns
 * early when `tx.status==='cancelada'`), so there is no legitimate 0-row path:
 * a silent miss would report the cancel as succeeded while the transaction
 * stayed active (and, if a balance reversal is ever added, would desync the
 * ledger) — so surface it loudly. Same `.returning({id})` + `.length` idiom as
 * `mensagensRepo.markProcessed` / `pendingQuestionsRepo.resolve`.
 */
async function updateTransacaoWith(
  executor: typeof db,
  id: string,
  patch: Partial<Transacao>,
): Promise<void> {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  const updated = await executor
    .update(transacoes)
    .set(patch)
    .where(
      and(
        eq(transacoes.id, id),
        eq(transacoes.tenant_id, tenant_id),
        eq(transacoes.agent_id, agent_id),
      ),
    )
    .returning({ id: transacoes.id });
  if (updated.length !== 1) {
    throw new Error(
      `transacoesRepo.update matched ${updated.length} rows for transacao ${id} ` +
        `under ${tenant_id}/${agent_id} — expected 1 (tenant/agent context does ` +
        `not match the target transaction; the update would have been silently ` +
        `lost while reported as applied)`,
    );
  }
}

export const categoriasRepo = {
  async list(scope?: EntityScope): Promise<Categoria[]> {
    if (!scope) return db.select().from(categorias);
    return db
      .select()
      .from(categorias)
      .where(
        sql`(${categorias.entidade_id} IS NULL OR ${inArray(categorias.entidade_id, scope.entidades)})`,
      );
  },
  async byId(id: string): Promise<Categoria | null> {
    const rows = await db.select().from(categorias).where(eq(categorias.id, id)).limit(1);
    return rows[0] ?? null;
  },
  async byIds(ids: string[]): Promise<Categoria[]> {
    if (ids.length === 0) return [];
    return db.select().from(categorias).where(inArray(categorias.id, ids));
  },
  async byNomeNatureza(nome: string, natureza: string): Promise<Categoria | null> {
    const rows = await db
      .select()
      .from(categorias)
      .where(and(eq(categorias.nome, nome), eq(categorias.natureza, natureza), isNull(categorias.entidade_id)))
      .limit(1);
    return rows[0] ?? null;
  },
};

export const contrapartesRepo = {
  async byScope(scope: EntityScope): Promise<Contraparte[]> {
    if (scope.entidades.length === 0) throw new EmptyScopeError();
    return db
      .select()
      .from(contrapartes)
      .where(inArray(contrapartes.entidade_id, scope.entidades));
  },
  async byId(id: string): Promise<Contraparte | null> {
    const rows = await db.select().from(contrapartes).where(eq(contrapartes.id, id)).limit(1);
    return rows[0] ?? null;
  },
  async create(input: Omit<Contraparte, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<Contraparte> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(contrapartes).values(guarded).returning();
    return rows[0]!;
  },
  // ----------------------------------------------------------------------
  // Issue #431 — search surface for the boleto proposal adapters
  // (`company_search` / `company_identity_resolver`). These methods did not
  // exist; the pre-existing read path is NOT tenant-pinned (`byId` filters by
  // `id` only; `byScope` by `entidade_id` only). SECURITY (invariant #1): a
  // CNPJ/name lookup over a non-unique `documento`/`nome` MUST add explicit
  // `tenant_id + agent_id` predicates (from the ALS context) on top of the
  // entidade scope, or it would read across tenants. Mirrors the
  // `mensagensRepo`/`pessoasRepo` ALS-pinning pattern. Covered by a DB-free
  // WHERE-clause leak assertion (tests/unit/contrapartes-repo-scope.spec.ts).
  // ----------------------------------------------------------------------
  /**
   * Exact-document lookup, scoped. `documento` has no unique index, so an
   * unscoped `eq(documento, …)` could return another tenant's counterparty;
   * we pin `tenant_id + agent_id` (ALS) AND the caller's entidade scope.
   * `documento` is compared on its normalized (digits-only) form so a stored
   * `12.345.678/0001-90` matches a `12345678000190` query and vice-versa.
   */
  async byDocumento(scope: EntityScope, documento: string): Promise<Contraparte[]> {
    if (scope.entidades.length === 0) throw new EmptyScopeError();
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const digits = documento.replace(/\D/g, '');
    if (digits.length === 0) return [];
    return db
      .select()
      .from(contrapartes)
      .where(
        and(
          eq(contrapartes.tenant_id, tenant_id),
          eq(contrapartes.agent_id, agent_id),
          inArray(contrapartes.entidade_id, scope.entidades),
          sql`regexp_replace(coalesce(${contrapartes.documento}, ''), '\\D', '', 'g') = ${digits}`,
        ),
      );
  },
  /**
   * All counterparties visible to the caller, scoped — the candidate set the
   * tool layer fuzzy-ranks by name (the trigram scoring lives in
   * `fuzzyMatchByName`, not in SQL, to share the ambiguity gate with
   * `identify_entity`). Same tenant+agent+entidade pinning as `byDocumento`.
   * `limit` bounds the candidate pull so a large book can't be dragged into
   * memory; default 200.
   */
  async searchByName(scope: EntityScope, opts: { limit?: number } = {}): Promise<Contraparte[]> {
    if (scope.entidades.length === 0) throw new EmptyScopeError();
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(contrapartes)
      .where(
        and(
          eq(contrapartes.tenant_id, tenant_id),
          eq(contrapartes.agent_id, agent_id),
          inArray(contrapartes.entidade_id, scope.entidades),
        ),
      )
      .limit(opts.limit ?? 200);
  },
  /**
   * Single-row fetch by id, but tenant+agent+entidade pinned (unlike the
   * unscoped `byId` above, kept for back-compat with existing callers). The
   * boleto adapters resolve a `company_id` through THIS method so a guessed/
   * leaked id from another tenant or out-of-scope entidade returns null.
   */
  async byIdScoped(scope: EntityScope, id: string): Promise<Contraparte | null> {
    if (scope.entidades.length === 0) throw new EmptyScopeError();
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(contrapartes)
      .where(
        and(
          eq(contrapartes.id, id),
          eq(contrapartes.tenant_id, tenant_id),
          eq(contrapartes.agent_id, agent_id),
          inArray(contrapartes.entidade_id, scope.entidades),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
};

export const entityStatesRepo = {
  // Flip-readiness (#323, H4 of #355) — READ half of a read-then-write PAIR.
  // `entity_states` carries NOT NULL `tenant_id` + `agent_id` (schema). The PK
  // is `entidade_id` ALONE, so an id-only WHERE returns whatever single row owns
  // that id REGARDLESS of tenant — a cross-tenant read. Worse, `lockdown.ts`
  // feeds this row's `flags` straight back into `upsert` (read-then-write): an
  // unscoped read there would let one tenant's lockdown snapshot be merged onto
  // and re-written over another tenant's row. Scope the WHERE by tenant+agent
  // (bound from ALS) so the read returns the row ONLY when it belongs to the
  // running tuple. Returns null (not throw) on no-match: a missing/foreign
  // entity is a legitimate not-found for a READ, and the live caller
  // (`prompt-builder.ts` entityStateBlocks loop) already `continue`s on null.
  // Caller audit (both run inside the agent turn's
  // `runWithTenantContext({tenant_id, agent_id})`, except lockdown — see below):
  //   - `agent/prompt-builder.ts` (entityStateBlocks): tenant-scoped. SAFE.
  //   - `governance/lockdown.ts` (activate/liftLockdown): legacy emergency
  //     governance with NO live entrypoint (no tRPC/CLI/worker wiring; only doc
  //     references). It ORIGINALLY ran UNSCOPED raw `db` queries over ALL
  //     `entity_states` (a latent cross-tenant sweep). Rescoped per-tenant in
  //     #355: it now binds `tenant_id`/`agent_id` from ALS and scopes every
  //     query/mutation to the running tuple, failing loud (rejecting the
  //     `'default'` literal under the flag) instead of sweeping all tenants. So
  //     the dead path is now both flip-safe and correct if ever wired up — a
  //     cross-tenant `entity_states` write (the bug H4 closes) is no longer
  //     reachable from it.
  async byId(entidade_id: string): Promise<EntityState | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(entity_states)
      .where(
        and(
          eq(entity_states.entidade_id, entidade_id),
          eq(entity_states.tenant_id, tenant_id),
          eq(entity_states.agent_id, agent_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  /**
   * Issue #511 — batch sibling of `byId`, replacing the per-entity loop that
   * built `entityStateBlocks` in `src/agent/prompt-builder.ts`. That loop was
   * the dominant N+1 of the turn: a tenant with 100 entities in scope paid 100
   * round-trips on the fixed 10-connection pool (`src/db/client.ts`) before the
   * first LLM token, and every other tenant waited behind it.
   *
   * Carries the SAME (tenant_id, agent_id) predicate as `byId` — see the long
   * note above on why the `entidade_id`-only PK makes that predicate load
   * bearing rather than decorative. Entities not owned by the running tuple are
   * simply absent from the result, exactly as `byId` returns null for them.
   *
   * Deterministic ordering by `entidade_id` so the rendered "## Estado atual"
   * block is byte-stable for the same scope across turns (a reordered prompt is
   * a different prompt to the model, and to the prompt cache). The caller
   * re-sorts into scope order; ordering here just removes DB nondeterminism.
   */
  async byIds(entidade_ids: string[], limit = 500): Promise<EntityState[]> {
    if (entidade_ids.length === 0) return [];
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(entity_states)
      .where(
        and(
          inArray(entity_states.entidade_id, Array.from(new Set(entidade_ids))),
          eq(entity_states.tenant_id, tenant_id),
          eq(entity_states.agent_id, agent_id),
        ),
      )
      .orderBy(entity_states.entidade_id)
      .limit(limit);
  },
  // Flip-readiness (#323, H4 of #355) — WRITE half of the read-then-write PAIR.
  // The conflict target is the `entidade_id` PK only, and the OLD SET
  // (`{ ...input, updated_at }`) did NOT re-stamp tenant/agent NOR gate the
  // conflict on ownership. So if tenant-B already owns the row for a colliding
  // `entidade_id`, a tenant-A `upsert` would conflict on the PK and DO UPDATE
  // would OVERWRITE tenant-B's `contexto`/`flags` — a cross-tenant write. (PK
  // global-uniqueness makes the collision improbable, but the isolation
  // invariant is STRUCTURAL, not probabilistic — cf. procedureExecutionsRepo.findById.)
  // FIX (two parts):
  //   (1) INSERT stamps tenant_id+agent_id from ALS via `applyTenantGuard`
  //       (throws on a tenant-mismatched explicit input; both columns NOT NULL).
  //   (2) `onConflictDoUpdate.where` gates the UPDATE on tenant+agent so a
  //       conflicting row owned by ANOTHER tenant is left untouched — it can
  //       never overwrite a foreign row. The SET stays tenant-agnostic on
  //       purpose: the WHERE already pins ownership, and the row's identity
  //       columns must not move.
  // FAIL-LOUD on 0 returned rows: with the INSERT now stamped, a 0-row result
  // can ONLY mean the conflict fired AND the ownership WHERE rejected it — i.e.
  // the `entidade_id` is already owned by a different tenant/agent. That is a
  // cross-tenant collision the caller MUST see, not a silent no-op that would
  // make it believe the state was persisted.
  // Caller audit: `prompt-builder.ts` does NOT call upsert (read-only there).
  // `governance/lockdown.ts` is the only upsert caller — same legacy-no-context
  // caveat as `byId` above (REPORTED; not changed).
  async upsert(input: Partial<EntityState> & { entidade_id: string }): Promise<EntityState> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const guarded = applyTenantGuard({
      ...input,
      contexto: input.contexto ?? {},
    });
    // The conflict-arm SET must NEVER move the row's identity columns
    // (`tenant_id`/`agent_id`/`entidade_id`). `applyTenantGuard` already
    // validates them for the INSERT path; here we strip them from the SET so a
    // (future) caller that passes `tenant_id` in `input` cannot re-stamp the
    // running tenant's own row onto another tenant via the UPDATE branch.
    const { tenant_id: _t, agent_id: _a, entidade_id: _e, ...updatable } = input as Record<string, unknown>;
    void _t;
    void _a;
    void _e;
    const rows = await db
      .insert(entity_states)
      .values(guarded as typeof entity_states.$inferInsert)
      .onConflictDoUpdate({
        target: entity_states.entidade_id,
        set: { ...updatable, updated_at: new Date() },
        where: and(
          eq(entity_states.tenant_id, tenant_id),
          eq(entity_states.agent_id, agent_id),
        ),
      })
      .returning();
    if (rows.length !== 1) {
      throw new Error(
        `entityStatesRepo.upsert matched ${rows.length} rows for entidade ${input.entidade_id} ` +
          `under ${tenant_id}/${agent_id} — expected 1 (the entidade_id is already owned by a ` +
          `different tenant/agent; the upsert would have either overwritten a foreign tenant's ` +
          `entity_state or been silently dropped while reported as persisted)`,
      );
    }
    return rows[0]!;
  },
};
