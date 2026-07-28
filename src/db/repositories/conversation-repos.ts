import { eq, and, inArray, desc, isNull, sql } from 'drizzle-orm';
import { db, withTx, pgErrorCode } from '../client.js';
import {
  conversas,
  mensagens,
  pending_questions,
  outbound_messages,
  workflows,
  } from '../schema.js';
import { applyTenantGuard } from '../tenant-guard.js';
import {
  getCurrentTenant,
  getCurrentAgent,
  PRIMARY_TENANT_ID,
  PRIMARY_AGENT_ID,
} from '../tenant-context.js';
import type { AgentTurn, Conversa, Mensagem, PendingQuestion } from '../schema.js';
// Issue #503 — ingresso atômico (mensagem + turno na mesma transação). Import
// unidirecional: `turn-repos` NÃO importa este módulo, então não há ciclo.
import { agentTurnsRepo } from './turn-repos.js';

export const conversasRepo = {
  /**
   * 090 (spec roteamento v4 §1.6) — a identidade da conversa inclui o CANAL:
   * com um agente em N linhas, a mesma pessoa em duas linhas são DUAS
   * conversas (sem isso a resposta sairia pela linha da conversa anterior).
   * `channel_id` informado ⇒ casa a conversa daquele canal OU uma legada
   * (channel_id NULL — janela de transição; preferência para o match exato).
   * `channel_id` omitido ⇒ comportamento legado (chamadores proativos).
   */
  async findActive(pessoa_id: string, channel_id?: string | null): Promise<Conversa | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(conversas)
      .where(
        and(
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
          eq(conversas.pessoa_id, pessoa_id),
          eq(conversas.status, 'ativa'),
          ...(channel_id
            ? [sql`(${conversas.channel_id} = ${channel_id} OR ${conversas.channel_id} IS NULL)`]
            : []),
        ),
      )
      .orderBy(
        ...(channel_id ? [desc(sql`${conversas.channel_id} IS NOT NULL`)] : []),
        desc(conversas.ultima_atividade_em),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async byId(id: string): Promise<Conversa | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(conversas)
      .where(
        and(
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
          eq(conversas.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async create(input: {
    pessoa_id: string;
    escopo_entidades: string[];
    /** 090 — conversas novas do caminho resolvido nascem COM canal. */
    channel_id?: string | null;
  }): Promise<Conversa> {
    const guarded = applyTenantGuard({
      pessoa_id: input.pessoa_id,
      escopo_entidades: input.escopo_entidades,
      channel_id: input.channel_id ?? null,
    });
    const rows = await db.insert(conversas).values(guarded).returning();
    return rows[0]!;
  },
  /**
   * Review PR #496 (alto 6) — vincula ATOMICAMENTE uma conversa LEGADA
   * (channel_id NULL) ao primeiro canal resolvido que a reencontra. Sem o
   * vínculo, a conversa legada casa qualquer linha no `findActive` mas a
   * saída (`forCurrentAgentChannel(null)`) exige canal único do agente —
   * com 2+ linhas ativas toda resposta lançaria `channel_ambiguous` e a
   * conversa ficaria MUDA até encerrar.
   *
   * O predicado `channel_id IS NULL` faz do UPDATE um CAS: na corrida entre
   * duas linhas, a primeira vence e a segunda recebe `false` (o caller
   * reencontra/cria a conversa da própria linha). Nunca sobrescreve um
   * vínculo existente.
   */
  async bindChannelIfNull(id: string, channel_id: string): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .update(conversas)
      .set({ channel_id })
      .where(
        and(
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
          eq(conversas.id, id),
          isNull(conversas.channel_id),
        ),
      )
      .returning({ id: conversas.id });
    return rows.length > 0;
  },
  async touch(id: string): Promise<void> {
    // Flip-readiness (#323): scope the last-activity bump to the current
    // (tenant_id, agent_id) — bound from ALS — mirroring the hardened `close`
    // above. Both columns are NOT NULL; every caller runs inside
    // `runWithTenantContext` with a real pair (the agent core's
    // `runAgentForMensagemInner`, wrapped at core.ts via
    // `runWithTenantContext({tenant_id, agent_id})`, plus `identity/resolver`
    // which reaches `touch` only after the agent-scoped `findActive`/`create`
    // resolved `c` under the SAME context — so `c.agent_id === getCurrentAgent()`).
    // Deliberately NO row-count assertion: `touch` is a best-effort
    // last-activity bump on the hot path; a 0-row no-op (e.g. a future legacy
    // default/default path) must NEVER crash message processing. Predicate
    // only — defense-in-depth without a hot-path failure mode.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(conversas)
      .set({ ultima_atividade_em: new Date() })
      .where(
        and(
          eq(conversas.id, id),
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
        ),
      );
  },
  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    // Flip-readiness (#323): tenant+agent scope the WHERE (bound from ALS), as
    // with the sibling metadata writers below. PREDICATE-ONLY (no row-count
    // assertion): this full-object setter currently has NO live caller in
    // `src/` (the lightweight-pending flow that used it was deprecated in favour
    // of the atomic `mergeMetadata`/`unsetMetadataKey` jsonb variants), so there
    // is no caller whose "row must exist" expectation we can confirm — per the
    // brief's "if unsure, scope without the throw" guidance we add the predicate
    // and stop short of fail-loud.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(conversas)
      .set({ metadata })
      .where(
        and(
          eq(conversas.id, id),
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
        ),
      );
  },
  /**
   * Atomic partial merge into conversas.metadata via the jsonb `||`
   * operator. Issue #73: avoids losing concurrent keys (e.g. pending_question)
   * when two workers race to write metadata. Existing keys in `patch`
   * overwrite existing keys in metadata; everything else is preserved.
   */
  async mergeMetadata(id: string, patch: Record<string, unknown>): Promise<boolean> {
    // Flip-readiness (#323): tenant+agent scope the WHERE (bound from ALS). One
    // LIVE caller is the agent core's post-turn scope-hash persist (core.ts),
    // which runs inside `runWithTenantContext({tenant_id, agent_id})` on a
    // conversa `c` it already resolved under the SAME context — so
    // `c.agent_id === getCurrentAgent()` and the predicate matches.
    // PREDICATE-ONLY (no throw): the best-effort callers (core.ts scope-hash,
    // pending-questions) wrap this and treat a 0-row no-op as benign
    // ("last-writer-wins ... is fine"), so a fail-loud assertion would only ever
    // degrade to a swallowed warning while risking the hot path.
    //
    // Review fix (MÉDIO): the `conversation_state_update` tool MUST be able to
    // tell a real write apart from a silent no-op (stale/divergent conversa), so
    // it doesn't audit a fake success. We add `RETURNING id` and report whether a
    // row actually matched. The best-effort callers simply ignore the boolean.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(conversas)
      .set({ metadata: sql`${conversas.metadata} || ${JSON.stringify(patch)}::jsonb` })
      .where(
        and(
          eq(conversas.id, id),
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
        ),
      )
      .returning({ id: conversas.id });
    return updated.length > 0;
  },
  /**
   * Atomic, namespaced partial merge: deep-merge `patch` into the single nested
   * object `metadata.<namespace>` (one level), leaving every OTHER top-level
   * metadata key untouched. Implemented with `jsonb_set(... , COALESCE(existing,
   * '{}') || patch, true)` so:
   *   - sibling top-level keys (pending_question, last_scope_hash, telefone, …)
   *     are NEVER touched — only `metadata.<namespace>.*` changes;
   *   - keys ALREADY inside the namespace are preserved (last-writer-wins per
   *     key), like the top-level `mergeMetadata`.
   *
   * Issue #433 review fix (MÉDIO): the `conversation_state_update` tool writes
   * the agent's lightweight state under a dedicated `agent_state` namespace
   * instead of a reserved-key denylist, so a baseline write can never clobber a
   * governed top-level metadata key (current OR future). Returns whether a row
   * matched (same ALS-scoped predicate + RETURNING as `mergeMetadata`).
   */
  async mergeMetadataNamespace(
    id: string,
    namespace: string,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(conversas)
      .set({
        // `namespace` is a BOUND parameter (ARRAY[...]::text[] path + `->`
        // operand), never string-interpolated SQL — no injection surface even if
        // a future caller passes a non-constant namespace.
        metadata: sql`jsonb_set(
          ${conversas.metadata},
          ARRAY[${namespace}]::text[],
          COALESCE(${conversas.metadata} -> ${namespace}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
          true
        )`,
      })
      .where(
        and(
          eq(conversas.id, id),
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
        ),
      )
      .returning({ id: conversas.id });
    return updated.length > 0;
  },
  /**
   * Atomic key removal from conversas.metadata via the jsonb `-` operator.
   * Superpowers I3 (PR #74): paired with `mergeMetadata` for the deprecated
   * lightweight-pending-question flow so a clear-pending operation no
   * longer races with concurrent `mergeMetadata` writes (e.g.
   * `last_scope_hash`) — the previous `updateMetadata` full-object set
   * would silently drop concurrent keys.
   */
  async unsetMetadataKey(id: string, key: string): Promise<void> {
    // Flip-readiness (#323): tenant+agent scope the WHERE (bound from ALS),
    // mirroring `mergeMetadata`. PREDICATE-ONLY (no throw): this is reachable
    // only through the deprecated lightweight-pending chain
    // (`clearLightweightPending` ← `applyResolution`), which has NO live caller
    // in `src/` — so there is no caller whose row-existence expectation we can
    // confirm. Per "if unsure, scope without the throw", predicate only.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(conversas)
      .set({ metadata: sql`${conversas.metadata} - ${key}` })
      .where(
        and(
          eq(conversas.id, id),
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
        ),
      );
  },
  async close(id: string, contexto_resumido: string): Promise<void> {
    // Issue #345 (Phase 4 review): `conversation-summarizer` runs PER enumerated
    // (tenant_id, agent_id) tuple and calls this to close stale conversations.
    // Scope the UPDATE to the current (tenant_id, agent_id) — bound from ALS —
    // as defense-in-depth so a per-tuple run can never close a conversation
    // owned by another tenant even if a caller passed a foreign `id` (the
    // inviolable cross-tenant isolation invariant). Both columns are NOT NULL
    // and the enumeration partitions on the same pair.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(conversas)
      .set({ status: 'encerrada', contexto_resumido })
      .where(
        and(
          eq(conversas.id, id),
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
        ),
      );
  },
  async invalidateScopeForPessoa(pessoa_id: string): Promise<void> {
    // Flip-readiness (#323): bulk UPDATE by pessoa_id — tenant+agent scope the
    // WHERE (bound from ALS) so a pessoa shared across tenants can never have
    // another tenant's conversa scope invalidated. NO row-count assertion: this
    // is a bulk write (a pessoa may own 0..N conversas) where a variable/0 row
    // count is legitimate. (Currently no live caller in `src/`; predicate added
    // proactively for the flip per the audit.)
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(conversas)
      .set({ escopo_entidades: [] })
      .where(
        and(
          eq(conversas.pessoa_id, pessoa_id),
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
        ),
      );
  },

  /**
   * Issue #345 (Phase 4) — dispatcher enumeration for `conversation-summarizer`.
   *
   * Returns the DISTINCT (tenant_id, agent_id) tuples that own at least one
   * stale conversation needing a summary — i.e. exactly the tuples whose
   * `runConversationSummarizerInner` SELECT would return rows. The predicate
   * mirrors the inner's filter EXACTLY (`status='ativa' AND ultima_atividade_em
   * < now() - interval '7 days'`) so a tuple is enumerated iff the inner has at
   * least one conversation to summarize. (The inner additionally caps at 10 rows
   * per pass; that LIMIT only bounds work volume, not which tuples have work, so
   * it is intentionally not part of the enumeration predicate.)
   *
   * Runs OUTSIDE tenant context (it IS the dispatcher); no tenant guard
   * (cross-tenant iteration is the worker's contract). Belt-and-suspenders
   * NOT NULL predicate mirrors #251/#292.
   */
  async listTenantAgentPairsWithStaleConversations(): Promise<
    Array<{ tenant_id: string; agent_id: string }>
  > {
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT tenant_id, agent_id
      FROM ${conversas}
      WHERE tenant_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND status = 'ativa'
        AND ${conversas.ultima_atividade_em} < now() - interval '7 days'
    `);
    return Array.from(
      result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>,
    );
  },
};

// 090 — `channel_id` (linha) é opcional na escrita: rows novas do caminho
// resolvido DEVEM passá-lo (dedup por canal); legado/proativo sem canal grava
// NULL (coberto pela partial unique legada por tenant+agent).
type MensagemInsertInput = Omit<
  Mensagem,
  'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'channel_id'
> & { channel_id?: string | null };

export const mensagensRepo = {
  async create(input: MensagemInsertInput): Promise<Mensagem> {
    const guarded = applyTenantGuard({ ...input, channel_id: input.channel_id ?? null });
    const rows = await db.insert(mensagens).values(guarded).returning();
    return rows[0]!;
  },
  /**
   * Issue #503 — `opts.withTurn` faz a persistência do inbound e a criação do
   * turno `received` acontecerem na MESMA transação PostgreSQL (delegado a
   * `agentTurnsRepo.createReceivedTurnTx`). Sem a opção o comportamento é
   * idêntico ao anterior: só a row de mensagem. O caminho de dedup (pre-check +
   * retry no 23505) é o mesmo nos dois modos — uma duplicata nunca chega a
   * abrir transação, então nunca cria turno órfão.
   */
  async createInbound(
    input: MensagemInsertInput,
    opts?: { withTurn?: boolean },
  ): Promise<{ row: Mensagem; duplicate: boolean; turn?: AgentTurn }> {
    const wid = (input.metadata as Record<string, unknown> | null)?.['whatsapp_id'];
    // 090 (spec roteamento v4 §1.7) — o pre-check espelha as partial uniques:
    // com canal conhecido, um retry NA MESMA linha (ou de uma row legada sem
    // canal, janela de transição) é duplicata; o MESMO whatsapp_id vindo de
    // OUTRA linha do agente NÃO é (invariante 3 — nunca descartar por colisão
    // cross-linha). Sem canal (legado), comportamento anterior por tenant.
    const findExisting = async (): Promise<Mensagem | null> => {
      if (typeof wid !== 'string' || wid.length === 0) return null;
      return this.findByWhatsappId(wid, input.channel_id ?? undefined);
    };
    const preExisting = await findExisting();
    if (preExisting) return { row: preExisting, duplicate: true };
    try {
      if (opts?.withTurn) {
        const created = await agentTurnsRepo.createReceivedTurnTx({
          mensagem: { ...input, channel_id: input.channel_id ?? null },
          channel_id: input.channel_id ?? null,
        });
        return { row: created.mensagem, duplicate: false, turn: created.turn };
      }
      const guarded = applyTenantGuard({ ...input, channel_id: input.channel_id ?? null });
      const rows = await db.insert(mensagens).values(guarded).returning();
      return { row: rows[0]!, duplicate: false };
    } catch (err) {
      // Unique-violation race: re-fetch and treat as duplicate.
      // pgErrorCode unwraps Drizzle's DrizzleQueryError so the underlying pg
      // SQLSTATE (on `.cause`) is read, not the wrapper's undefined code.
      if (typeof wid === 'string' && pgErrorCode(err) === '23505') {
        const existing = await findExisting();
        if (existing) return { row: existing, duplicate: true };
      }
      throw err;
    }
  },
  async listUnprocessedOlderThan(ms: number, limit = 100): Promise<Mensagem[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const cutoff = new Date(Date.now() - ms);
    return db
      .select()
      .from(mensagens)
      .where(
        and(
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
          isNull(mensagens.processada_em),
          eq(mensagens.direcao, 'in'),
          sql`created_at < ${cutoff.toISOString()}`,
        ),
      )
      .orderBy(mensagens.created_at)
      .limit(limit);
  },
  /**
   * Issue #345 (Phase 4 of #323) — dispatcher enumeration for `message-recovery`.
   *
   * Returns the DISTINCT (tenant_id, agent_id) tuples that own at least one
   * stuck inbound message — i.e. exactly the tuples whose `listUnprocessedOlderThan`
   * inner has rows to re-enqueue. The predicate mirrors that inner's filter
   * EXACTLY (`processada_em IS NULL AND direcao = 'in' AND created_at < cutoff`)
   * so a tuple is enumerated iff the inner would find work for it. `ms` is the
   * same `STUCK_AFTER_MS` the worker passes to the inner, applied here as the
   * cutoff so the dispatcher and inner agree on staleness.
   *
   * Runs OUTSIDE tenant context (it IS the dispatcher); no tenant guard
   * (cross-tenant iteration is the worker's contract). Belt-and-suspenders
   * `tenant_id/agent_id IS NOT NULL` mirrors #251/#292. Before this fix the
   * worker ran the inner under a hardcoded `default/default` context, so only
   * the default agent's stranded messages were ever re-enqueued.
   */
  async listTenantAgentPairsWithUnprocessedOlderThan(
    ms: number,
  ): Promise<Array<{ tenant_id: string; agent_id: string }>> {
    const cutoff = new Date(Date.now() - ms);
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT tenant_id, agent_id
      FROM ${mensagens}
      WHERE tenant_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND processada_em IS NULL
        AND direcao = 'in'
        AND created_at < ${cutoff.toISOString()}
    `);
    return Array.from(
      result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>,
    );
  },
  async findById(id: string): Promise<Mensagem | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(mensagens)
      .where(
        and(
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
          eq(mensagens.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  /**
   * 090 (spec roteamento v4 §1.7) — `channel_id` opcional escopa o lookup à
   * LINHA: match do canal OU row legada (channel NULL, janela de transição).
   * Omitido ⇒ comportamento anterior (qualquer canal do tenant/agent), usado
   * pelos consumidores que não conhecem a linha (edits/gap-detector).
   */
  async findByWhatsappId(
    whatsapp_id: string,
    channel_id?: string | null,
  ): Promise<Mensagem | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(mensagens)
      .where(
        and(
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
          sql`metadata->>'whatsapp_id' = ${whatsapp_id}`,
          ...(channel_id
            ? [sql`(${mensagens.channel_id} = ${channel_id} OR ${mensagens.channel_id} IS NULL)`]
            : []),
        ),
      )
      .orderBy(...(channel_id ? [desc(sql`${mensagens.channel_id} IS NOT NULL`)] : []))
      .limit(1);
    return rows[0] ?? null;
  },
  async recentInConversation(conversa_id: string, n = 20): Promise<Mensagem[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(mensagens)
      .where(
        and(
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
          eq(mensagens.conversa_id, conversa_id),
        ),
      )
      .orderBy(desc(mensagens.created_at))
      .limit(n);
  },
  /**
   * Inbound messages from a given telefone (`metadata->>'telefone'`) that
   * haven't been processed yet, in chronological order (oldest first).
   *
   * Keyed off telefone — NOT conversa_id — because at the moment the
   * debounce worker fires, only the target message has had its
   * conversa_id resolved by the agent. Earlier chunks from the same
   * burst still carry `conversa_id IS NULL` (baileys saves all inbounds
   * with null conversa_id; resolution happens in `runAgentForMensagem`).
   * Querying by conversa_id would silently miss them.
   *
   * `excludeId` lets the caller skip the "target" message that triggered
   * the run. The result includes orphans (`conversa_id IS NULL`) and
   * messages already attached to a conversa — caller filters by
   * conversa_id == target's OR null to avoid cross-conversation leakage
   * (defensive: telefone is 1:1 with pessoa, so leakage is theoretical).
   */
  async listUnprocessedByTelefone(
    telefone: string,
    opts?: { excludeId?: string; limit?: number },
  ): Promise<Mensagem[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const limit = opts?.limit ?? 50;
    const rows = await db
      .select()
      .from(mensagens)
      .where(
        and(
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
          eq(mensagens.direcao, 'in'),
          isNull(mensagens.processada_em),
          sql`metadata->>'telefone' = ${telefone}`,
        ),
      )
      .orderBy(mensagens.created_at)
      .limit(limit);
    if (opts?.excludeId) return rows.filter((r) => r.id !== opts.excludeId);
    return rows;
  },
  async setConversaId(id: string, conversa_id: string): Promise<void> {
    // Flip-readiness (#323): tenant+agent scope the WHERE (bound from ALS),
    // mirroring `mensagensRepo.findById` which gates on the same pair. Both
    // columns are NOT NULL. The two live callers (agent core, core.ts) both run
    // inside `runWithTenantContext({tenant_id, agent_id})` and act on the
    // `inbound` row that `findById(mensagem_id)` ALREADY resolved under the SAME
    // (tenant_id, agent_id) — so `inbound.agent_id === getCurrentAgent()` and
    // the predicate matches the exact row.
    // FAIL-LOUD (throw on !=1): this targets one specific, known-present row
    // (the inbound just loaded by the agent-scoped findById) and is NOT a
    // best-effort path — a 0-row no-op would silently fail to attach the message
    // to its conversation, corrupting history/recovery linkage. The previous
    // id-only WHERE always matched, so a silent miss under the new predicate
    // would be a regression; turn it into a loud failure. Same
    // `.returning({id})` + `.length` idiom as `updateStateTx` /
    // `adoptToResolvedTenantCrossTenant`.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(mensagens)
      .set({ conversa_id })
      .where(
        and(
          eq(mensagens.id, id),
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
        ),
      )
      .returning({ id: mensagens.id });
    if (updated.length !== 1) {
      throw new Error(
        `mensagensRepo.setConversaId matched ${updated.length} rows for mensagem ` +
          `${id} under ${tenant_id}/${agent_id} — expected 1 (tenant/agent ` +
          `context does not match the target row; the conversa linkage would ` +
          `have been silently lost)`,
      );
    }
  },
  /**
   * Bulk variant for the debounce aggregation path: adopts orphan
   * inbound rows (conversa_id null) into the conversation that the
   * target message resolved to. One UPDATE round-trip instead of N.
   */
  async setConversaIdMany(ids: string[], conversa_id: string): Promise<void> {
    if (ids.length === 0) return;
    // Flip-readiness (#323): bulk UPDATE over `inArray(id, ids)` — tenant+agent
    // scope the WHERE (bound from ALS) so the debounce-adoption pass can only
    // re-home THIS tenant/agent's orphan inbound rows. The sole live caller
    // (agent core, core.ts) runs inside `runWithTenantContext({tenant_id,
    // agent_id})` and passes ids drawn from `aggregateUnprocessedTexts`, which
    // selects via the agent-scoped `listUnprocessedByTelefone` — so every id
    // already belongs to the running pair. NO row-count assertion: this is a
    // bulk write whose matched count is intentionally variable (the method is a
    // documented no-op for ids already attached to the conversa), so an exact-N
    // assertion would be wrong; the caller also treats it as best-effort.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(mensagens)
      .set({ conversa_id })
      .where(
        and(
          inArray(mensagens.id, ids),
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
        ),
      );
  },
  async markProcessed(id: string, tokens: number | null): Promise<void> {
    // Flip-readiness (#323): tenant+agent scope the WHERE (bound from ALS),
    // mirroring `mensagensRepo.findById`. Both columns are NOT NULL. Every live
    // caller is the agent core (core.ts), inside
    // `runWithTenantContext({tenant_id, agent_id})`, marking either the `inbound`
    // row that the agent-scoped `findById` resolved under the SAME pair, or its
    // debounce siblings (selected via the agent-scoped
    // `listUnprocessedByTelefone`) — so every targeted row carries the running
    // (tenant_id, agent_id) and the predicate matches.
    // FAIL-LOUD (throw on !=1): this stamps `processada_em` on one specific,
    // known-present row to mark a turn done. A silent 0-row no-op would leave
    // the row unprocessed and the recovery worker would requeue it forever
    // (or, for the unknown/blocked/quarantined drop paths, re-deliver to the
    // LLM) — a real bug, not a benign miss. The id-only WHERE always matched, so
    // a silent miss under the new predicate is a regression worth surfacing
    // loudly. (Where a caller treats marking as best-effort — the
    // `markAllProcessed` per-row loop in core.ts — it already wraps this in
    // try/catch, so the throw degrades to a logged warning there rather than
    // crashing the turn; the strict paths (unknown/blocked/quarantined drops)
    // get the loud failure.) Same `.returning({id})` + `.length` idiom as the
    // sibling compare-and-swap writes.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(mensagens)
      .set({ processada_em: new Date(), tokens_usados: tokens ?? null })
      .where(
        and(
          eq(mensagens.id, id),
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
        ),
      )
      .returning({ id: mensagens.id });
    if (updated.length !== 1) {
      throw new Error(
        `mensagensRepo.markProcessed matched ${updated.length} rows for mensagem ` +
          `${id} under ${tenant_id}/${agent_id} — expected 1 (tenant/agent ` +
          `context does not match the target row; the message would have been ` +
          `left unprocessed and requeued indefinitely)`,
      );
    }
  },

  // [P88-C1] EXPLICITLY bypasses applyTenantGuard — the channel resolver
  // runs BEFORE tenant context exists (it's the entry point that DISCOVERS
  // which tenant owns the inbound). If a non-default channel resolves to
  // (tenantX, agentX) but the gateway persisted the row under (default,
  // default), the post-resolution tenant-scoped findById would return null
  // and the turn would be silently dropped. This method atomically adopts
  // the row to the resolved triplet so the inner tenant-scoped read finds
  // it. Same sanctioned-bypass pattern as channelsRepo.findByExternalCrossTenant.
  //
  // [Codex review #311 — CRITICAL P0 cross-tenant adoption race]
  // The UPDATE re-asserts `tenant_id='default' AND agent_id='default'` in its
  // WHERE clause. This is the load-bearing safety property, not a cosmetic
  // guard:
  //   - The inbound row is first persisted by the gateway under the legacy
  //     `default/default` context, then ADOPTED into the resolved tenant by
  //     this method. Keying the UPDATE by `id` ALONE meant any caller holding
  //     that id could rewrite `(tenant_id, agent_id)` to an ARBITRARY triplet
  //     at any time — including AFTER the row had already been adopted into
  //     tenant-A. A concurrent worker that re-resolved the same row to
  //     tenant-B (stale resolver cache, mis-seeded channel, BullMQ retry
  //     racing a fresh enqueue) would silently steal the row across the
  //     tenant boundary — a direct violation of the inviolable isolation
  //     contract.
  //   - Re-asserting `default/default` in the WHERE makes adoption a
  //     COMPARE-AND-SWAP: a row can be adopted out of `default/default`
  //     exactly ONCE. Once it belongs to tenant-A, no later call (for any
  //     other tenant, or a duplicate for the same one) can match the WHERE,
  //     so the row can never be re-homed. The single UPDATE is atomic at the
  //     Postgres level (row lock for the duration of the statement), so two
  //     concurrent adoptions cannot both win — exactly one observes
  //     rowCount=1, the loser observes rowCount=0.
  //   - Idempotency for BullMQ retries is preserved: re-running adoption for
  //     the SAME target tenant after the row already moved is simply a
  //     rowCount=0 no-op (the row no longer matches `default/default`), which
  //     the caller treats as "already adopted by me" — see the post-adoption
  //     ownership re-check in agent/core.ts.
  //
  // Returns `true` when THIS call performed the adoption (row was still
  // `default/default` and is now the resolved triplet), `false` when the row
  // was already adopted (by a prior call / concurrent winner) or no longer
  // exists. Callers MUST treat `false` as "I did not win — verify the row's
  // current owner before proceeding" rather than assuming success.
  async adoptToResolvedTenantCrossTenant(args: {
    id: string;
    tenant_id: string;
    agent_id: string;
    /**
     * 090 (spec roteamento v4 §1.7) — canal resolvido para o inbound. Na fase
     * 0 a sessão global não conhece o canal na PERSISTÊNCIA (o resolver roda
     * depois), então o carimbo acontece aqui, na adoção — a FK composta
     * (tenant, agent, channel) é satisfeita por construção: o canal veio de
     * `resolveChannel` sob o MESMO (tenant, agent) que este UPDATE grava.
     * Nas fases 1+ (multi-linha) o `createInbound` da sessão da linha carimba
     * direto e este parâmetro vira redundância inofensiva (COALESCE mantém).
     */
    channel_id?: string | null;
  }): Promise<boolean> {
    const updated = await db
      .update(mensagens)
      .set({
        tenant_id: args.tenant_id,
        agent_id: args.agent_id,
        ...(args.channel_id
          ? { channel_id: sql`COALESCE(${mensagens.channel_id}, ${args.channel_id})` }
          : {}),
      })
      .where(
        and(
          eq(mensagens.id, args.id),
          eq(mensagens.tenant_id, PRIMARY_TENANT_ID),
          eq(mensagens.agent_id, PRIMARY_AGENT_ID),
        ),
      )
      .returning({ id: mensagens.id });
    return updated.length > 0;
  },

  // [Codex review #311 — CRITICAL P0] EXPLICITLY bypasses applyTenantGuard —
  // same sanctioned-entry-point pattern as `adoptToResolvedTenantCrossTenant`.
  // Returns ONLY the owning `(tenant_id, agent_id)` of a row by id, with NO
  // tenant scoping. Sole consumer is the post-adoption ownership re-check in
  // `runAgentForMensagem`: when the compare-and-swap adoption returns `false`
  // (the row was NOT still `default/default`), the caller must learn WHO owns
  // the row now before deciding whether it may proceed. If the row already
  // belongs to the tenant we resolved, we won an earlier idempotent retry and
  // proceed; if it belongs to a DIFFERENT tenant, a concurrent worker adopted
  // it cross-tenant and we MUST abort rather than process it under our context
  // (that would re-introduce the very cross-tenant leak this review closed).
  // Projecting only the two scope columns keeps the leak surface minimal — the
  // caller never sees another tenant's message body via this path.
  async findOwnerByIdCrossTenant(
    id: string,
  ): Promise<{ tenant_id: string; agent_id: string } | null> {
    const rows = await db
      .select({ tenant_id: mensagens.tenant_id, agent_id: mensagens.agent_id })
      .from(mensagens)
      .where(eq(mensagens.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  // [Codex review #277 v2] EXPLICITLY bypasses applyTenantGuard — same
  // sanctioned-entry-point pattern as `adoptToResolvedTenantCrossTenant`
  // and `channelsRepo.findByExternalCrossTenant`. Used by the Baileys
  // `messages.update` listener (edits + revokes), which runs BEFORE any
  // tenant context exists (Baileys is the inbound entry point — the
  // tenant of the original message is exactly what we need to DISCOVER
  // here so the dispatch can re-enter inside the correct ALS context).
  //
  // Necessity: `runAgentForMensagem` adopts inbound rows from
  // (default, default) into the resolved tenant via
  // `adoptToResolvedTenantCrossTenant`. A subsequent edit/revoke arrives
  // via `messages.update` with NO tenant context — running the tenant-
  // scoped `findByWhatsappId` under `default/default` would miss the
  // (now-adopted) original and the edit/revoke would be silently dropped
  // (Codex BLOQUEADO iteração 2: edit_unknown_original / revoke_unknown_original).
  //
  // Safety (ATUALIZADO em 090 — spec roteamento v4 §1.7): a unicidade de
  // whatsapp_id deixou de ser GLOBAL (colidiria entre linhas/tenants com
  // N sessões). Rows novas dedupam por (channel_id, whatsapp_id); legadas por
  // (tenant, agent, whatsapp_id). Por isso este lookup passa a receber o
  // CANAL da sessão que entregou o evento (review v4, bloqueante 1) e resolve
  // DENTRO desse escopo: `channel_id` informado ⇒ match do canal OU row
  // legada (channel NULL) que pertença ao MESMO (tenant, agent) DONO do
  // canal — review #498 crítico 1: sem essa exigência, uma row legada de
  // OUTRO tenant com o mesmo whatsapp_id era elegível e o edit/revoke
  // atravessava tenants. Omitido (sessão sem canal registrado — janela
  // mono-linha) ⇒ comportamento anterior, preferindo a row mais recente
  // para desempate determinístico.
  // O caller (gateway/baileys.ts) re-entra `runWithTenantContext` do dono da
  // row antes de rotear, restaurando o escopo pleno.
  async findByWhatsappIdCrossTenant(
    whatsapp_id: string,
    channel_id?: string | null,
  ): Promise<Mensagem | null> {
    const rows = await db
      .select()
      .from(mensagens)
      .where(
        and(
          sql`metadata->>'whatsapp_id' = ${whatsapp_id}`,
          ...(channel_id
            ? [
                sql`(${mensagens.channel_id} = ${channel_id} OR (${mensagens.channel_id} IS NULL AND EXISTS (
                  SELECT 1 FROM channels c
                   WHERE c.id = ${channel_id}
                     AND c.tenant_id = ${mensagens.tenant_id}
                     AND c.agent_id = ${mensagens.agent_id}
                )))`,
              ]
            : []),
        ),
      )
      .orderBy(desc(sql`${mensagens.channel_id} IS NOT NULL`), desc(mensagens.created_at))
      .limit(1);
    return rows[0] ?? null;
  },
};

// `metadata` is `notNull()` in the schema (with `default '{}'::jsonb`) which
// makes it required on the inferred select type. Existing callers (e.g.
// src/identity/quarantine.ts) that predate the column don't pass metadata —
// the DB default is what they want. We strip metadata from the Omit and
// add it back as optional so those call sites keep typechecking.
type PendingQuestionInsert = Omit<
  PendingQuestion,
  'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'resolvida_em' | 'resposta' | 'metadata'
> & { metadata?: object };

export const pendingQuestionsRepo = {
  async create(input: PendingQuestionInsert): Promise<PendingQuestion> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(pending_questions).values(guarded).returning();
    return rows[0]!;
  },
  async findOpen(conversa_id: string): Promise<PendingQuestion | null> {
    const rows = await db
      .select()
      .from(pending_questions)
      .where(and(eq(pending_questions.conversa_id, conversa_id), eq(pending_questions.status, 'aberta')))
      .orderBy(desc(pending_questions.created_at))
      .limit(1);
    return rows[0] ?? null;
  },
  async findOpenByPessoaAndType(pessoa_id: string, tipo: string): Promise<PendingQuestion | null> {
    const rows = await db
      .select()
      .from(pending_questions)
      .where(
        and(
          eq(pending_questions.pessoa_id, pessoa_id),
          eq(pending_questions.tipo, tipo),
          eq(pending_questions.status, 'aberta'),
          sql`(${pending_questions.expira_em} IS NULL OR ${pending_questions.expira_em} > NOW())`,
        ),
      )
      .orderBy(desc(pending_questions.created_at))
      .limit(1);
    return rows[0] ?? null;
  },
  /**
   * Issue #363 — tenant-scoped read of OPEN pending questions for one pessoa,
   * for the `list_pending` LLM tool (whose result `q.pergunta` is injected back
   * into the prompt context). `pessoa_id` is a GLOBAL uuid, so filtering by it
   * alone (as the tool's old inline `db.select` did) does NOT scope by tenant —
   * another tenant's open question for a shared/guessed pessoa_id would leak
   * into the LLM context (R2 contamination, same class as #357). Bind tenant+agent
   * from ALS (both columns NOT NULL) so the read returns ONLY the running tuple's
   * rows. Read-only `list*` shape mirrors `transacoesRepo.listRecent`/`byScope`.
   */
  async listOpenForPessoa(pessoa_id: string, limit: number): Promise<PendingQuestion[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(pending_questions)
      .where(
        and(
          eq(pending_questions.tenant_id, tenant_id),
          eq(pending_questions.agent_id, agent_id),
          eq(pending_questions.pessoa_id, pessoa_id),
          eq(pending_questions.status, 'aberta'),
        ),
      )
      .orderBy(desc(pending_questions.created_at))
      .limit(limit);
  },
  async resolve(id: string, resposta: unknown): Promise<void> {
    // Flip-readiness (#323, H2 of #355): tenant+agent scope the WHERE (bound
    // from ALS), mirroring the already-hardened `expireDue` and
    // `conversasRepo.close`. Both columns are NOT NULL. The two live callers
    // (identity/quarantine.ts → `handleOwnerIdentityReply`) run inside
    // `runWithTenantContext({tenant_id, agent_id})` (the agent core wraps the
    // whole turn — agent/core.ts `runAgentForMensagem`), resolving the `open`
    // row via `findOpenByPessoaAndType(owner.id, …)` under the SAME pair — and
    // the owner pessoa + its pending_question were both created under that pair
    // (`create` → `applyTenantGuard`), so the predicate matches the exact row.
    // FAIL-LOUD (throw on !=1): this targets one specific, known-present row
    // (the open identity_confirmation just resolved under this tenant/agent) to
    // close out the owner's confirmation decision. The WHERE has NO status gate
    // (it overwrites by id regardless of current status), so the ONLY way to
    // match 0 rows under the new predicate is a tenant/agent mismatch — a real
    // cross-tenant misroute, not a benign idempotent retry. A silent 0-row
    // no-op would leave the confirmation `aberta` forever (the contact never
    // gets unblocked/blocked and the owner's reply is lost). Same
    // `.returning({id})` + `.length` idiom as `mensagensRepo.markProcessed`.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(pending_questions)
      .set({
        status: 'respondida',
        resposta: resposta as object,
        resolvida_em: new Date(),
      })
      .where(
        and(
          eq(pending_questions.id, id),
          eq(pending_questions.tenant_id, tenant_id),
          eq(pending_questions.agent_id, agent_id),
        ),
      )
      .returning({ id: pending_questions.id });
    if (updated.length !== 1) {
      throw new Error(
        `pendingQuestionsRepo.resolve matched ${updated.length} rows for ` +
          `pending_question ${id} under ${tenant_id}/${agent_id} — expected 1 ` +
          `(tenant/agent context does not match the target row; the ` +
          `confirmation would have been left unresolved)`,
      );
    }
  },
  async expireDue(): Promise<number> {
    // Issue #345 (Phase 4 review): the `pending-expirer` worker now runs this
    // inner ONCE PER enumerated (tenant_id, agent_id) tuple
    // (`listTenantAgentPairsWithDueExpirations` selects DISTINCT (tenant_id,
    // agent_id)). Without an explicit tenant predicate the UPDATE would expire
    // EVERY tenant's due pending_questions on the first tuple's pass —
    // violating the inviolable cross-tenant isolation invariant. Bind the same
    // (tenant_id, agent_id) the enumeration partitions on, so a per-tuple run
    // only touches ITS OWN rows.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .update(pending_questions)
      .set({ status: 'expirada' })
      .where(
        and(
          eq(pending_questions.tenant_id, tenant_id),
          eq(pending_questions.agent_id, agent_id),
          eq(pending_questions.status, 'aberta'),
          sql`expira_em < now()`,
        ),
      )
      .returning({ id: pending_questions.id });
    return rows.length;
  },

  /**
   * Issue #345 (Phase 4) — dispatcher enumeration for `pending-expirer`.
   *
   * The worker's inner does TWO things per tenant: expire due `pending_questions`
   * (`expireAll()` → `expireDue()`) AND expire due dual-approval `workflows`
   * (`expireDueDualApprovals()`). So the dispatcher must enumerate the UNION of
   * the (tenant_id, agent_id) tuples that have EITHER kind of due work:
   *
   *   - a `pending_questions` row with `status='aberta' AND expira_em < now()`
   *     (matches `expireDue`'s WHERE), OR
   *   - a `workflows` row with `tipo='dual_approval'`, in a still-open status,
   *     and `proxima_acao_em < now()` (matches `expireDueDualApprovals`'s
   *     filter, which iterates `workflowsRepo.listPending()` — the open-status
   *     set `pendente/em_andamento/aguardando_humano/aguardando_terceiro` — and
   *     keeps only past-due `dual_approval` rows).
   *
   * Including the dual-approval arm is LOAD-BEARING: a tenant whose ONLY due
   * work is an expired dual-approval (no due pending_question) must still be
   * enumerated, otherwise its timed-out approval would never be cancelled.
   * Same shape as the relayer's `listTenantsWithWork` two-arm union (#316).
   *
   * Runs OUTSIDE tenant context (it IS the dispatcher); no tenant guard
   * (cross-tenant iteration is the worker's contract). Belt-and-suspenders
   * NOT NULL predicate on both arms mirrors #251/#292.
   */
  async listTenantAgentPairsWithDueExpirations(): Promise<
    Array<{ tenant_id: string; agent_id: string }>
  > {
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT tenant_id, agent_id FROM ${pending_questions}
        WHERE tenant_id IS NOT NULL
          AND agent_id IS NOT NULL
          AND status = 'aberta'
          AND expira_em < now()
      UNION
      SELECT DISTINCT tenant_id, agent_id FROM ${workflows}
        WHERE tenant_id IS NOT NULL
          AND agent_id IS NOT NULL
          AND tipo = 'dual_approval'
          AND status IN ('pendente', 'em_andamento', 'aguardando_humano', 'aguardando_terceiro')
          AND proxima_acao_em IS NOT NULL
          AND proxima_acao_em < now()
    `);
    return Array.from(
      result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>,
    );
  },

  /**
   * Issue #345 (Phase 4 of #323) — dispatcher enumeration for `pending-reminder`.
   *
   * Returns the DISTINCT (tenant_id, agent_id) tuples that own at least one
   * pending_question due for a reminder. The predicate mirrors EXACTLY the
   * reminder-eligibility filter in `runPendingReminderInner`'s SELECT
   * (`status='aberta' AND expira_em > now() AND tipo != 'edit_review' AND
   * created_at < now() - interval '1 hour' AND reminder_count < MAX AND
   * (last_reminder_at IS NULL OR last_reminder_at < now() - interval '1 hour')`)
   * so a tuple is enumerated iff the inner would find at least one row to remind.
   * `maxReminders` is the worker's `MAX_REMINDERS` constant, threaded through so
   * the cap stays in lockstep with the inner.
   *
   * NOTE: this enumeration scans only `pending_questions` (it does NOT join
   * `pessoas`/`mensagens`). The inner's JOIN to `mensagens` (for the quoted
   * outbound parent) is an additional eligibility gate the inner applies
   * per-row (a row whose outbound parent is missing is skipped+audited), so a
   * tuple can be enumerated yet send no reminder — a cheap no-op, never a
   * cross-tenant read (the inner SELECT is now tenant-scoped — see worker).
   *
   * Runs OUTSIDE tenant context (it IS the dispatcher); no tenant guard
   * (cross-tenant iteration is the worker's contract). Belt-and-suspenders
   * `tenant_id/agent_id IS NOT NULL` mirrors #251/#292. Before this fix the
   * worker ran the inner under a hardcoded `default/default` context, so only
   * the default agent's pending questions ever got reminders.
   */
  async listTenantAgentPairsWithRemindableQuestions(
    maxReminders: number,
  ): Promise<Array<{ tenant_id: string; agent_id: string }>> {
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT tenant_id, agent_id
      FROM ${pending_questions}
      WHERE tenant_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND status = 'aberta'
        AND expira_em > now()
        AND tipo != 'edit_review'
        AND created_at < now() - interval '1 hour'
        AND COALESCE((metadata->>'reminder_count')::int, 0) < ${maxReminders}
        AND (
          metadata->>'last_reminder_at' IS NULL
          OR (metadata->>'last_reminder_at')::timestamptz < now() - interval '1 hour'
        )
    `);
    return Array.from(
      result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>,
    );
  },

  // === B0 tx-aware additions ===

  async findActiveSnapshot(conversa_id: string): Promise<PendingQuestion | null> {
    const rows = await db
      .select()
      .from(pending_questions)
      .where(
        and(
          eq(pending_questions.conversa_id, conversa_id),
          eq(pending_questions.status, 'aberta'),
          sql`expira_em > now()`,
        ),
      )
      .orderBy(desc(pending_questions.created_at))
      .limit(1);
    return rows[0] ?? null;
  },

  async findActiveForUpdate(
    tx: typeof db,
    conversa_id: string,
  ): Promise<PendingQuestion | null> {
    const rows = await tx
      .select()
      .from(pending_questions)
      .where(
        and(
          eq(pending_questions.conversa_id, conversa_id),
          eq(pending_questions.status, 'aberta'),
          sql`expira_em > now()`,
        ),
      )
      .orderBy(desc(pending_questions.created_at))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  },

  async resolveTx(tx: typeof db, id: string, resposta: unknown): Promise<void> {
    // Flip-readiness (#323, H2 of #355): tenant+agent scope the WHERE (bound
    // from ALS), mirroring `expireDue`. Both columns are NOT NULL. The sole
    // live caller (agent/pending-resolver.ts → `resolveAndDispatch`) runs
    // inside `runWithTenantContext` (entered by the gate/one-tap ingress paths
    // — pending-gate.ts, one-tap.ts via baileys `runWithTenantContext`) and
    // calls this ONLY after `findActiveForUpdate(tx, conversa_id)` has
    // SELECT…FOR UPDATE-locked the row AND verified `locked.id === id` in the
    // SAME tx — so the targeted row is present, locked, and (post-flip) owned
    // by the running pair (it was created under that pair via `createTx` →
    // `applyTenantGuard`).
    // FAIL-LOUD (throw on !=1): the row was just locked FOR UPDATE in this tx,
    // so a 0-row UPDATE can only mean the tenant/agent predicate does not match
    // the locked row — a cross-tenant misroute, never a benign race (the lock
    // already serialized concurrent resolvers). A silent miss would commit the
    // dispatch side-effects (tool execution) while leaving the question
    // `aberta`, so the next inbound would re-resolve and double-dispatch. Same
    // `.returning({id})` + `.length` idiom as `mensagensRepo.markProcessed`.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await tx
      .update(pending_questions)
      .set({
        status: 'respondida',
        resposta: resposta as object,
        resolvida_em: new Date(),
      })
      .where(
        and(
          eq(pending_questions.id, id),
          eq(pending_questions.tenant_id, tenant_id),
          eq(pending_questions.agent_id, agent_id),
        ),
      )
      .returning({ id: pending_questions.id });
    if (updated.length !== 1) {
      throw new Error(
        `pendingQuestionsRepo.resolveTx matched ${updated.length} rows for ` +
          `pending_question ${id} under ${tenant_id}/${agent_id} — expected 1 ` +
          `(tenant/agent context does not match the FOR-UPDATE-locked row; the ` +
          `dispatch would have committed while the question stayed open)`,
      );
    }
  },

  async cancelTx(tx: typeof db, id: string, reason: string): Promise<void> {
    // Flip-readiness (#323, H2 of #355): tenant+agent scope the WHERE (bound
    // from ALS, parameterized into the raw SQL exactly like the existing `${id}`
    // bind). Both columns are NOT NULL. The sole live caller
    // (agent/pending-gate.ts → `applyTx`, topic-change/cancellation arm) runs
    // inside `runWithTenantContext` (the gate ingress path) and calls this ONLY
    // after `findActiveForUpdate(tx, conversa_id)` has FOR UPDATE-locked the row
    // AND verified `locked.id === id` in the SAME tx — so the row is present,
    // locked, and (post-flip) owned by the running pair.
    // FAIL-LOUD (throw on !=1): the row was just locked FOR UPDATE in this tx, so
    // a 0-row UPDATE can only mean the tenant/agent predicate does not match the
    // locked row — a cross-tenant misroute, never a benign race. A silent miss
    // would leave the question `aberta` while the gate reports it cancelled,
    // stranding the user mid-flow.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const res = await tx.execute<{ id: string }>(sql`
      UPDATE pending_questions
         SET status = 'cancelada',
             metadata = metadata || ${JSON.stringify({ cancel_reason: reason })}::jsonb
       WHERE id = ${id}
         AND tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
       RETURNING id::text
    `);
    if (res.rows.length !== 1) {
      throw new Error(
        `pendingQuestionsRepo.cancelTx matched ${res.rows.length} rows for ` +
          `pending_question ${id} under ${tenant_id}/${agent_id} — expected 1 ` +
          `(tenant/agent context does not match the FOR-UPDATE-locked row; the ` +
          `question would have stayed open despite a reported cancellation)`,
      );
    }
  },

  async cancelOpenForConversaTx(
    tx: typeof db,
    conversa_id: string,
    reason: string,
  ): Promise<{ cancelled_ids: string[] }> {
    // Flip-readiness (#323, H2 of #355): tenant+agent scope the WHERE (bound
    // from ALS, parameterized into the raw SQL like the existing `${conversa_id}`
    // bind). Both columns are NOT NULL. The two live callers
    // (agent/message-update.ts → `createEditReviewPending`; tools/
    // ask-pending-question.ts handler) both run inside `runWithTenantContext` —
    // the edit/revoke listener wraps `routeMessageUpdate` in the resolved
    // tenant context (baileys `messages.update`), and the tool handler runs
    // inside the agent turn / `resolveAndDispatch`, both tenant-scoped. So a
    // conversa shared by a foreign tenant can never have ITS open questions
    // cancelled by another tenant's edit/substitution.
    // PREDICATE-ONLY (NO row-count assertion): this is a BULK cancel that clears
    // ALL open questions on the conversa (0..N), and a 0-row outcome is the
    // documented common case (no question was open). Both callers branch on
    // `cancelled_ids.length > 0` and treat an empty result as a no-op, so an
    // exact-N throw would be wrong here — the tenant+agent predicate is the only
    // change.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE pending_questions
         SET status = 'cancelada',
             metadata = metadata || ${JSON.stringify({ cancel_reason: reason })}::jsonb
       WHERE conversa_id = ${conversa_id}
         AND tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
         AND status = 'aberta'
       RETURNING id::text
    `);
    return { cancelled_ids: result.rows.map((r) => (r as { id: string }).id) };
  },

  async createTx(
    tx: typeof db,
    input: PendingQuestionInsert,
  ): Promise<PendingQuestion> {
    // Insert inside the same tx as the cancel — required by the partial unique
    // index `(conversa_id) WHERE status='aberta'` from migration 004. Doing
    // the insert on the global pool would race with the in-flight cancel and
    // hit a duplicate-key error.
    const guarded = applyTenantGuard(input);
    const rows = await tx.insert(pending_questions).values(guarded).returning();
    return rows[0]!;
  },
};

// Issue #227: outbound delivery idempotency ledger. Migration 063 schema.
export type OutboundMessageRow = typeof outbound_messages.$inferSelect;
export type OutboundChannel = 'text' | 'voice' | 'document' | 'poll';
export type OutboundStatus = 'pending' | 'sent' | 'failed' | 'unknown';

export const outboundMessagesRepo = {
  /**
   * Pre-send optimistic claim. Returns the current row and a `skip` flag:
   *   - skip=false: we claimed this turn (inserted a new pending row OR took
   *     over a prior 'failed' row by resetting it to pending). Caller proceeds
   *     with the gateway send, then markSent/markFailed.
   *   - skip=true: a prior attempt is already in-flight or terminal — i.e. an
   *     existing row has status 'pending' (another worker owns it), 'sent'
   *     (already delivered), or 'unknown' (could-be-delivered). The user has
   *     received (or might have received) this turn's reply, OR another worker
   *     is sending it RIGHT NOW. Caller MUST NOT send again. The returned row's
   *     provider_message_id is the prior ack (NULL when status='pending' or
   *     'unknown').
   *
   * Race-safety:
   *   1. The tx acquires `pg_advisory_xact_lock(hashtext(<scope>))` BEFORE the
   *      INSERT. All concurrent claimers for the same (tenant, agent, key)
   *      serialize on this lock — guarantees only ONE worker gets skip=false.
   *      Lock auto-releases on tx commit/rollback (xact_lock).
   *   2. ON CONFLICT DO UPDATE … WHERE `status = 'failed'` — only a prior
   *      'failed' row is reclaimable. 'pending' rows are now in-flight markers
   *      (the previous "reclaim pending" behavior allowed two workers to BOTH
   *      get skip=false: worker A INSERTed pending → worker B's ON CONFLICT
   *      hit the WHERE and also got skip=false → DOUBLE-SEND).
   *
   * Stale-pending recovery (issue #292, follow-up de #227): the
   * `outbound_messages_sweeper` worker (src/workers/outbound-messages-sweeper.ts,
   * runs every 5 minutes) promotes pending rows older than
   * OUTBOUND_SWEEPER_STALE_PENDING_SEC (default 5min) to 'unknown' — the
   * conservative terminal status that the boundary guard treats as
   * sent_no_persist (NO re-send, trades silence risk for zero double-send).
   * Under normal flow each turn's idempotency_key is unique per inbound, so
   * stale pending rarely affects user-visible behaviour — the sweeper is
   * defense-in-depth + housekeeping (it also runs retention cleanup on
   * terminal rows older than OUTBOUND_SWEEPER_RETENTION_DAYS, default 30d).
   */
  async upsertPending(input: {
    idempotency_key: string;
    conversa_id: string;
    in_reply_to: string;
    channel: OutboundChannel;
    tenant_id?: string;
    agent_id?: string;
  }): Promise<{ row: OutboundMessageRow; skip: boolean }> {
    // Tenant/agent isolation: the dedupe namespace is per (tenant, agent), not
    // a global string. Reads pull from the tenant context (set by webhook
    // routes via runWithTenantContext) unless the caller explicitly overrides
    // — call sites in output-dispatch.ts always run inside such a context.
    const tenant_id = input.tenant_id ?? getCurrentTenant();
    const agent_id = input.agent_id ?? getCurrentAgent();
    // Lock partition matches the UNIQUE: tenant + agent + key. hashtext is
    // 32-bit, so collisions across distinct keys are possible but harmless
    // (worst case: brief serialization of two unrelated turns).
    const lockKey = `${tenant_id}:${agent_id}:${input.idempotency_key}`;
    return withTx(async (tx) => {
      // (1) Serialize concurrent claimers for the same scope. Auto-released
      //     when the tx commits/rolls back.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      // (2) INSERT … ON CONFLICT DO UPDATE … WHERE status = 'failed'. Only
      //     'failed' rows are reclaimable; 'pending' is now in-flight.
      const claimed = await tx
        .insert(outbound_messages)
        .values({
          idempotency_key: input.idempotency_key,
          conversa_id: input.conversa_id,
          in_reply_to: input.in_reply_to,
          channel: input.channel,
          tenant_id,
          agent_id,
          status: 'pending',
        })
        .onConflictDoUpdate({
          target: [
            outbound_messages.tenant_id,
            outbound_messages.agent_id,
            outbound_messages.idempotency_key,
          ],
          set: {
            status: 'pending',
            channel: input.channel,
            error: null,
            sent_at: null,
          },
          // STRICT pending: only reclaim 'failed' rows. Race-safe — see method
          // doc. Without this, the prior WHERE `IN ('pending','failed')` let
          // two concurrent workers both come back with skip=false.
          where: sql`${outbound_messages.status} = 'failed'`,
        })
        .returning();
      if (claimed.length > 0) {
        return { row: claimed[0]!, skip: false };
      }
      // ON CONFLICT WHERE rejected: existing row is 'pending' (in-flight),
      // 'sent', or 'unknown'. All three are skip=true — re-sending would either
      // double-send (sent) or race the in-flight worker (pending).
      const [existing] = await tx
        .select()
        .from(outbound_messages)
        .where(
          and(
            eq(outbound_messages.tenant_id, tenant_id),
            eq(outbound_messages.agent_id, agent_id),
            eq(outbound_messages.idempotency_key, input.idempotency_key),
          ),
        )
        .limit(1);
      return { row: existing!, skip: true };
    });
  },
  /**
   * Record a successful send. `provider_message_id` may be NULL when the
   * gateway returned no key.id but isBaileysConnected() confirmed the send
   * happened (the 'sent without id' case dispatchOutput tags delivered:true).
   *
   * CAS guard: only transition from non-terminal statuses ('pending'/'failed').
   * A pre-existing 'sent' or 'unknown' row stays as-is — protects against
   * double-marking that could clobber the original provider_message_id, and
   * defensively guards against programming errors that would mark sent after
   * markFailed.
   */
  async markSent(key: string, provider_message_id: string | null): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(outbound_messages)
      .set({ status: 'sent', provider_message_id, sent_at: sql`now()` })
      .where(
        and(
          eq(outbound_messages.tenant_id, tenant_id),
          eq(outbound_messages.agent_id, agent_id),
          eq(outbound_messages.idempotency_key, key),
          inArray(outbound_messages.status, ['pending', 'failed']),
        ),
      );
  },
  /**
   * Record a failed attempt. `ambiguous=true` (the crux) means "could have
   * been delivered" — record 'unknown' so the per-turn guard treats it as sent
   * (no re-send), trading a sliver of silence risk for zero double-send.
   * `ambiguous=false` means "definitely not delivered" (pre-send disconnect /
   * throw before the wire) — record 'failed', a retry is safe.
   *
   * CAS guard: only transition from non-terminal statuses ('pending'/'failed').
   * A LATE markFailed against an already-'sent' row would otherwise degrade
   * 'sent' → 'failed', re-opening the row to reclaim → DOUBLE-SEND. The CAS
   * makes the call a no-op when a terminal status already won the race.
   */
  async markFailed(
    key: string,
    error: string,
    ambiguous: boolean,
  ): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(outbound_messages)
      .set({ status: ambiguous ? 'unknown' : 'failed', error })
      .where(
        and(
          eq(outbound_messages.tenant_id, tenant_id),
          eq(outbound_messages.agent_id, agent_id),
          eq(outbound_messages.idempotency_key, key),
          inArray(outbound_messages.status, ['pending', 'failed']),
        ),
      );
  },
  /** Convenience for tests / ops. Scoped to current tenant/agent. */
  async findByKey(key: string): Promise<OutboundMessageRow | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(outbound_messages)
      .where(
        and(
          eq(outbound_messages.tenant_id, tenant_id),
          eq(outbound_messages.agent_id, agent_id),
          eq(outbound_messages.idempotency_key, key),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
};
