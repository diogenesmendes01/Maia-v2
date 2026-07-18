import { eq, and, ne, desc, sql } from 'drizzle-orm';
import { db, withTx, pgErrorCode } from '../client.js';
import {
  channels,
  roles,
  channel_policies,
  role_selector_decisions,
  admin_audit_log,
} from '../schema.js';
import { TypedError } from '@/lib/utils.js';
import { applyTenantGuard } from '../tenant-guard.js';
import {
  getCurrentTenant,
  getCurrentAgent,
  PRIMARY_TENANT_ID,
  PRIMARY_AGENT_ID,
} from '../tenant-context.js';
import type {
  SwitchBehavior,
  AnnounceMode,
  SuggestedBy,
  DecidedBy,
  RoleSelectorStrength,
  RoleDecisionAction,
} from '@/types/enums.js';
import type {
  Channel,
  Role,
  ChannelPolicy,
  NewChannelPolicy,
  RoleSelectorDecisionRow,
} from '../schema.js';

/**
 * §1.5/§2 (spec roteamento v4) — E.164 canônico COM `+` para linhas whatsapp.
 * Aceita variantes (`+55…`, `55…`) e devolve `+<dígitos>`; null para valores
 * que não são uma linha (o legado `default-channel` semeado pré-data a regra
 * e nunca passa por CREATE de novo).
 */
export const WHATSAPP_LINE_RE = /^\+[1-9][0-9]{6,14}$/;
export function normalizeWhatsappLine(raw: string): string | null {
  const candidate = raw.startsWith('+') ? raw : `+${raw}`;
  return WHATSAPP_LINE_RE.test(candidate) ? candidate : null;
}

// P6: channels — instâncias de entrada de mensagem (1+ por agent). Tenant-
// scoped via applyTenantGuard; findByExternalCrossTenant é o único método que
// bypassa o guard (usado pelo resolver de entrada, antes do contexto existir).
export const channelsRepo = {
  async create(input: {
    external_id: string;
    channel_type: 'whatsapp' | 'telegram' | 'email' | 'sms' | 'web' | 'api' | 'other';
    display_name?: string;
    metadata?: unknown;
  }): Promise<Channel> {
    // §1.5 — canais whatsapp NOVOS são linhas: E.164 com `+`, validado no
    // repo (além do Zod da superfície). Fail-loud: um external_id que não é
    // linha quebraria o exact-match do roteamento silenciosamente.
    let external_id = input.external_id;
    if (input.channel_type === 'whatsapp') {
      const normalized = normalizeWhatsappLine(input.external_id);
      if (!normalized) {
        throw new TypedError(
          'invalid_whatsapp_line',
          `whatsapp channel external_id must be E.164 with '+' (got '${input.external_id}')`,
          { external_id: input.external_id },
        );
      }
      external_id = normalized;
    }
    const guarded = applyTenantGuard({
      external_id,
      channel_type: input.channel_type,
      display_name: input.display_name ?? null,
      metadata: (input.metadata as object) ?? {},
    });
    const [row] = await db
      .insert(channels)
      .values(guarded as typeof channels.$inferInsert)
      .returning();
    return row!;
  },

  async getById(id: string): Promise<Channel | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.tenant_id, tenant_id),
          eq(channels.agent_id, agent_id),
          eq(channels.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async findByExternal(
    channel_type: string,
    external_id: string,
  ): Promise<Channel | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.tenant_id, tenant_id),
          eq(channels.agent_id, agent_id),
          eq(channels.channel_type, channel_type),
          eq(channels.external_id, external_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  // EXPLICITLY bypasses applyTenantGuard — used by resolver (entry point,
  // before context exists). The (channel_type, external_id) lookup discovers
  // which tenant/agent owns the inbound message.
  //
  // [Codex review #277] UNIQUE in `migrations/031_p6_channels.sql` is
  // `(tenant_id, channel_type, external_id)` — same (channel_type, external_id)
  // CAN coexist across distinct tenants (e.g., a number switching providers,
  // or a tenant deactivating an old channel before another tenant claims it).
  // A naive `limit(1)` would arbitrarily pick one row, and if the resolver
  // landed on the inactive one it would reject a message belonging to the
  // active tenant — silently dropping legitimate traffic.
  //
  // Strategy: fetch ALL matches, then collapse:
  //   - 0 active rows → return any inactive (resolver will throw with
  //     found:true, active:false → unknown_or_inactive_channel audit).
  //   - 1 active row  → return it (the only sensible owner).
  //   - 2+ active rows → cross-tenant ambiguity. Surface explicitly via
  //     TypedError so the channel ownership conflict is visible in
  //     audit/triage rather than being masked by a non-deterministic pick.
  //     The PROPER fix is an operator deactivating one side; the resolver
  //     refusing to choose is the fail-loud counterpart of the rate-limit
  //     bucket collapse that issue #268 closed.
  //
  // Cardinality is bounded by `channels_external_idx` and in practice expected
  // to be ≤ 2 (one prior, one current); fetching all rows is O(few).
  async findByExternalCrossTenant(args: {
    channel_type: string;
    external_id: string;
  }): Promise<Channel | null> {
    const rows = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.channel_type, args.channel_type),
          eq(channels.external_id, args.external_id),
        ),
      );
    if (rows.length === 0) return null;

    const activeRows = rows.filter((r) => r.active);
    if (activeRows.length === 0) {
      // No active owner — return any inactive to preserve the (found:true,
      // active:false) audit signature the resolver expects.
      return rows[0]!;
    }
    if (activeRows.length > 1) {
      // Multiple active tenants claim the same external_id — refuse to choose.
      // Caller (resolveChannel) wraps this in the standard fail-loud path.
      throw new TypedError(
        'channel_resolution_failed',
        'channel ownership ambiguous: multiple active channels match (channel_type, external_id)',
        {
          channel_type: args.channel_type,
          external_id: args.external_id,
          resolver_path: 'ambiguous_active_channels',
          conflicting_tenant_ids: activeRows.map((r) => r.tenant_id),
        },
      );
    }
    return activeRows[0]!;
  },

  // [Issue #411] Single-tenant catch-all for the channel resolver. EXPLICITLY
  // bypasses applyTenantGuard for the same sanctioned reason as
  // `findByExternalCrossTenant` — the entry point runs BEFORE a tenant context
  // exists.
  //
  // Contract: given a channel_type whose `(channel_type, external_id)` exact
  // lookup missed, decide whether the deployment is a genuine single-tenant
  // runtime (one tenant: the seeded `default/default`) or a real multi-tenant
  // config, and (when single-tenant) hand back the seeded `default/default`
  // catch-all channel so the resolver can map ANY inbound sender to
  // (default, default). This is what makes the bot answer arbitrary senders
  // without dropping messages.
  //
  // ── [🔴 CRITICAL fix — PR #417 review] cross-`channel_type` isolation leak ──
  // The discriminator "is this deployment multi-tenant?" MUST be GLOBAL — it
  // looks at EVERY active channel owned by a non-`default` tenant, regardless
  // of `channel_type`. The previous implementation scoped the discriminator to
  // the inbound's `channel_type`, so a real tenant whose only channel was a
  // DIFFERENT type (e.g. a `telegram` tenant while the inbound is `whatsapp`)
  // was invisible → `hasRealTenant` stayed false → the resolver handed
  // `default/default` to a deployment that HAS a real tenant. That collapses
  // distinct tenants onto the shared `maia:ratelimit:default:default:*` bucket
  // — the exact cross-tenant leak issue #268 closed. The fix splits the logic:
  //   1. GLOBAL discriminator (NO channel_type filter): ANY active channel with
  //      tenant_id != 'primary' ⇒ real multi-tenant deployment → fail-closed
  //      (`multi_tenant:true`, NO channel) so the resolver throws
  //      `channel_resolution_failed`.
  //   2. ONLY IF none exists: use `channel_type` to locate the seeded active
  //      `primary/primary` catch-all channel (issue #323: the single-tenant home
  //      is now `primary`, re-homed from the legacy `default/default` by 081).
  //
  // ── [🟠 HIGH fix — PR #417 review] TOCTOU vs a concurrent activation ──
  // Both reads run inside ONE transaction (`withTx` → a single `BEGIN…COMMIT`
  // on one pooled connection) so the discriminator and the catch-all fetch
  // observe a CONSISTENT snapshot. A tenant activating its first channel
  // between the two reads can no longer slip through the window and let an
  // in-flight message hit `default/default` after the deployment became
  // multi-tenant. Residual risk: a concurrent activation that COMMITS before
  // this transaction's snapshot is taken is (correctly) not yet visible — the
  // in-flight message races the activation, which is inherent and bounded; the
  // very next inbound observes the new tenant and fails closed. Eliminating
  // even that would require locking the whole `channels` table on every inbound
  // (rejected: it serialises the hot path for no isolation gain — the next
  // message already fails closed).
  //
  // Cardinality: the `channels` table is small (one row per registered line);
  // the discriminator is a `LIMIT 1` existence probe and the catch-all fetch is
  // a single-row lookup, both O(1)-ish.
  async findPrimaryCatchAllChannel(args: {
    channel_type: string;
  }): Promise<
    | { multi_tenant: true; channel: null }
    | { multi_tenant: false; channel: Channel | null }
  > {
    return withTx(async (tx) => {
      // 1. GLOBAL discriminator — any ACTIVE channel owned by a tenant OTHER
      //    than the single-tenant home (`primary`), across ALL channel_types.
      //    Its mere existence proves a real multi-tenant deployment. Fail-closed:
      //    do NOT hand back the catch-all. `LIMIT 1` — existence only.
      const realTenantProbe = await tx
        .select({ one: sql<number>`1` })
        .from(channels)
        .where(and(eq(channels.active, true), ne(channels.tenant_id, PRIMARY_TENANT_ID)))
        .limit(1);
      if (realTenantProbe.length > 0) {
        return { multi_tenant: true, channel: null };
      }

      // 2. Single-tenant runtime: surface the seeded active `primary/primary`
      //    catch-all channel for this channel_type (if present). Scoped by
      //    channel_type so e.g. a whatsapp inbound gets the whatsapp catch-all.
      const fallbackRows = await tx
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.channel_type, args.channel_type),
            eq(channels.active, true),
            eq(channels.tenant_id, PRIMARY_TENANT_ID),
            eq(channels.agent_id, PRIMARY_AGENT_ID),
          ),
        )
        .limit(1);
      return { multi_tenant: false, channel: fallbackRows[0] ?? null };
    });
  },

  async listActive(): Promise<Channel[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.tenant_id, tenant_id),
          eq(channels.agent_id, agent_id),
          eq(channels.active, true),
        ),
      );
  },

  /**
   * Fase 0 (spec roteamento v4 §1.6) — prova do TRIPLETE para a fronteira de
   * saída: o canal pertence ao (tenant, agent) informado E está ativo? Args
   * EXPLÍCITOS (sem ALS) porque o contrato de `forChannel` é validar o escopo
   * COMO RECEBIDO — um channel_id estrangeiro plantado por bug não pode ser
   * legitimado pelo contexto corrente. Não bypassa guard: o WHERE carrega o
   * escopo completo por construção.
   */
  async channelBelongsToScopeActive(scope: {
    tenant_id: string;
    agent_id: string;
    channel_id: string;
  }): Promise<boolean> {
    const rows = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.tenant_id, scope.tenant_id),
          eq(channels.agent_id, scope.agent_id),
          eq(channels.id, scope.channel_id),
          eq(channels.active, true),
        ),
      )
      .limit(1);
    return rows.length > 0;
  },

  /**
   * 090/fase 0 (spec roteamento v4 §1.6) — resolução do canal ÚNICO ativo do
   * agente corrente (ALS). Serve os chamadores que não carregam `channel_id`
   * (conversas legadas, envio proativo, enqueue do outbox): com exatamente UM
   * canal ativo a escolha é unívoca; zero ou 2+ é fail-closed no CHAMADOR —
   * aqui só reportamos, sem lançar, para cada boundary aplicar seu próprio
   * erro tipado/retry. NUNCA escolhe "o primário" entre vários (invariante do
   * backfill fail-closed).
   */
  async findSoleActiveForCurrentAgent(): Promise<
    { kind: 'one'; id: string } | { kind: 'none' } | { kind: 'many' }
  > {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.tenant_id, tenant_id),
          eq(channels.agent_id, agent_id),
          eq(channels.active, true),
        ),
      )
      .limit(2);
    if (rows.length === 1) return { kind: 'one', id: rows[0]!.id };
    return rows.length === 0 ? { kind: 'none' } : { kind: 'many' };
  },

  /**
   * Create a channel AND append its admin_audit_log row in ONE transaction.
   * "Audit every decision" — a failed audit insert rolls the channel back,
   * so a governance change can never land without its trail. Mirrors
   * `agentsRepo.createWithSeedAndAudit`: explicit tenant/agent args (no ALS),
   * and the UNIQUE (tenant_id, channel_type, external_id) 23505 is caught
   * inside and surfaced as a typed reason instead of a raw pg error.
   */
  async createWithAudit(args: {
    tenant_id: string;
    agent_id: string;
    channel: {
      external_id: string;
      channel_type: 'whatsapp' | 'telegram' | 'email' | 'sms' | 'web' | 'api' | 'other';
      display_name?: string;
      metadata?: unknown;
    };
    audit: { actor_id: string; actor_role: string; reason: string };
  }): Promise<
    | { ok: true; channel: Channel }
    | { ok: false; reason: 'duplicate' | 'invalid_line' }
  > {
    // §2 (spec roteamento v4) — declarado→verificado: um canal whatsapp NOVO
    // nasce INATIVO ('declarado'); só a PairingSession (§2.5), ao provar a
    // posse da linha, ativa (activateVerified). Digitar um número nunca dá
    // posse. Outros channel_types mantêm o default do schema (ativo).
    const isWhatsapp = args.channel.channel_type === 'whatsapp';
    let external_id = args.channel.external_id;
    if (isWhatsapp) {
      const normalized = normalizeWhatsappLine(args.channel.external_id);
      if (!normalized) return { ok: false, reason: 'invalid_line' };
      external_id = normalized;
    }
    try {
      return await withTx(async (tx) => {
        const [row] = await tx
          .insert(channels)
          .values({
            tenant_id: args.tenant_id,
            agent_id: args.agent_id,
            external_id,
            channel_type: args.channel.channel_type,
            display_name: args.channel.display_name ?? null,
            metadata: (args.channel.metadata as object) ?? {},
            ...(isWhatsapp ? { active: false } : {}),
          })
          .returning();
        if (!row) {
          throw new Error('channel_create_with_audit_insert_failed: returning() empty');
        }
        await tx.insert(admin_audit_log).values({
          tenant_id: args.tenant_id,
          actor_id: args.audit.actor_id,
          actor_role: args.audit.actor_role,
          action: 'channel_create',
          resource_type: 'channel',
          resource_id: row.id,
          change_summary: {
            agent_id: args.agent_id,
            channel_type: row.channel_type,
            external_id: row.external_id,
            display_name: row.display_name,
            declared_inactive: isWhatsapp,
            reason: args.audit.reason,
          },
        });
        return { ok: true as const, channel: row };
      });
    } catch (err) {
      if (pgErrorCode(err) === '23505') {
        return { ok: false, reason: 'duplicate' };
      }
      throw err;
    }
  },

  /**
   * §2.5 (spec roteamento v4) — leitura do canal por id SEM tenant guard,
   * pelo padrão sancionado de entry-point (`findByExternalCrossTenant`): a
   * superfície /setup (token de operador, processo backend) orquestra o
   * pareamento ANTES de qualquer contexto de tenant — o canal declarado é
   * justamente o que diz a qual (tenant, agent) a linha pertencerá.
   */
  async getByIdCrossTenant(id: string): Promise<Channel | null> {
    const rows = await db.select().from(channels).where(eq(channels.id, id)).limit(1);
    return rows[0] ?? null;
  },

  /**
   * Fase 3 (spec roteamento v4 §1.5) — enumeração das LINHAS a subir no boot
   * multi-linha. EXPLICITAMENTE cross-tenant (bypassa o guard) pelo mesmo
   * padrão sancionado de `findByExternalCrossTenant`: o runtime v1 hospeda as
   * sessões de TODOS os tenants em um processo, e o boot precisa descobrir
   * quais linhas existem antes de qualquer contexto. Só linhas E.164 contam —
   * o catch-all legado (`default-channel`) não é uma linha.
   */
  async listActiveWhatsappLinesCrossTenant(): Promise<
    Array<{ id: string; tenant_id: string; agent_id: string; external_id: string }>
  > {
    const rows = await db
      .select({
        id: channels.id,
        tenant_id: channels.tenant_id,
        agent_id: channels.agent_id,
        external_id: channels.external_id,
      })
      .from(channels)
      .where(
        and(
          eq(channels.channel_type, 'whatsapp'),
          eq(channels.active, true),
          // Canais SINTÉTICOS (sonda) nunca sobem uma sessão real: o inbound é
          // injetado sinteticamente e o outbound é interceptado pelo sink. A
          // linha placeholder (+999...) não tem auth pareado e não deve gerar
          // QR nem warn de "pair first" no boot (correção do review — alta).
          eq(channels.is_synthetic, false),
          sql`${channels.external_id} ~ '^\\+[1-9][0-9]{6,14}$'`,
        ),
      );
    return rows;
  },

  /**
   * §2.4/§2.5 (spec roteamento v4) — ativação por posse VERIFICADA: chamado
   * exclusivamente após a PairingSession confirmar que o número real da
   * sessão casa a linha declarada. O índice global
   * `channels_active_line_uq (channel_type, external_id) WHERE active AND
   * channel_type='whatsapp'` (091) é o juiz: 23505 aqui significa que a
   * linha JÁ pertence a outro workspace ⇒ `line_owned_elsewhere` (a defesa
   * de ambiguidade do resolver permanece como segunda linha).
   */
  async activateVerified(args: {
    tenant_id: string;
    agent_id: string;
    channel_id: string;
  }): Promise<
    | { ok: true; channel: Channel }
    | { ok: false; reason: 'not_found' | 'line_owned_elsewhere' }
  > {
    try {
      const rows = await db
        .update(channels)
        .set({ active: true, updated_at: new Date() })
        .where(
          and(
            eq(channels.tenant_id, args.tenant_id),
            eq(channels.agent_id, args.agent_id),
            eq(channels.id, args.channel_id),
          ),
        )
        .returning();
      if (rows.length === 0) return { ok: false, reason: 'not_found' };
      return { ok: true, channel: rows[0]! };
    } catch (err) {
      if (pgErrorCode(err) === '23505') {
        return { ok: false, reason: 'line_owned_elsewhere' };
      }
      throw err;
    }
  },

  // [P88-C3] Tenant-scoped: write paths MUST enforce isolation. Without
  // tenant/agent predicates, any caller with another tenant's channel UUID
  // could disable that channel (cross-tenant DoS). Read-side filters here
  // were already tenant-scoped — this aligns the destructive path.
  async deactivate(id: string): Promise<{ rowCount: number }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db
      .update(channels)
      .set({ active: false, updated_at: new Date() })
      .where(
        and(
          eq(channels.tenant_id, tenant_id),
          eq(channels.agent_id, agent_id),
          eq(channels.id, id),
        ),
      )
      .returning({ id: channels.id });
    return { rowCount: result.length };
  },
};

// P6: roles — modos operacionais por agent (comercial, suporte, default, etc).
// Exatamente 1 default por (tenant, agent), garantido por partial unique index.
export const rolesRepo = {
  async create(input: {
    role_key: string;
    display_name: string;
    description?: string;
    prompt_addendum?: string;
    is_default?: boolean;
  }): Promise<Role> {
    const guarded = applyTenantGuard({
      role_key: input.role_key,
      display_name: input.display_name,
      description: input.description ?? null,
      prompt_addendum: input.prompt_addendum ?? null,
      is_default: input.is_default ?? false,
    });
    const [row] = await db
      .insert(roles)
      .values(guarded as typeof roles.$inferInsert)
      .returning();
    return row!;
  },

  async getById(id: string): Promise<Role | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.tenant_id, tenant_id),
          eq(roles.agent_id, agent_id),
          eq(roles.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async getByKey(role_key: string): Promise<Role | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.tenant_id, tenant_id),
          eq(roles.agent_id, agent_id),
          eq(roles.role_key, role_key),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async getDefault(): Promise<Role | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.tenant_id, tenant_id),
          eq(roles.agent_id, agent_id),
          eq(roles.is_default, true),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listActive(): Promise<Role[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.tenant_id, tenant_id),
          eq(roles.agent_id, agent_id),
          eq(roles.active, true),
        ),
      );
  },

  /**
   * Create a role AND append its admin_audit_log row in ONE transaction —
   * same contract as `channelsRepo.createWithAudit` (audit failure rolls the
   * role back; 23505 → typed 'duplicate').
   *
   * `is_default` omitted ⇒ resolved INSIDE the tx: the agent's first active
   * role becomes the default. Two concurrent "first role" creates can both
   * see zero rows, but the partial unique index (one default per
   * tenant/agent) breaks the tie — the loser lands on 23505 → 'duplicate'.
   */
  async createWithAudit(args: {
    tenant_id: string;
    agent_id: string;
    role: {
      role_key: string;
      display_name: string;
      description?: string;
      prompt_addendum?: string;
      is_default?: boolean;
    };
    audit: { actor_id: string; actor_role: string; reason: string };
  }): Promise<{ ok: true; role: Role } | { ok: false; reason: 'duplicate' }> {
    try {
      return await withTx(async (tx) => {
        let isDefault = args.role.is_default;
        if (isDefault === undefined) {
          const existing = await tx
            .select({ one: sql<number>`1` })
            .from(roles)
            .where(
              and(
                eq(roles.tenant_id, args.tenant_id),
                eq(roles.agent_id, args.agent_id),
                eq(roles.active, true),
              ),
            )
            .limit(1);
          isDefault = existing.length === 0;
        }
        const [row] = await tx
          .insert(roles)
          .values({
            tenant_id: args.tenant_id,
            agent_id: args.agent_id,
            role_key: args.role.role_key,
            display_name: args.role.display_name,
            description: args.role.description ?? null,
            prompt_addendum: args.role.prompt_addendum ?? null,
            is_default: isDefault,
          })
          .returning();
        if (!row) {
          throw new Error('role_create_with_audit_insert_failed: returning() empty');
        }
        await tx.insert(admin_audit_log).values({
          tenant_id: args.tenant_id,
          actor_id: args.audit.actor_id,
          actor_role: args.audit.actor_role,
          action: 'role_create',
          resource_type: 'role',
          resource_id: row.id,
          change_summary: {
            agent_id: args.agent_id,
            role_key: row.role_key,
            display_name: row.display_name,
            is_default: row.is_default,
            reason: args.audit.reason,
          },
        });
        return { ok: true as const, role: row };
      });
    } catch (err) {
      if (pgErrorCode(err) === '23505') {
        return { ok: false, reason: 'duplicate' };
      }
      throw err;
    }
  },

  // [P88-C3] Tenant-scoped: same justification as channelsRepo.deactivate.
  // Cross-tenant deactivation would break the inviolable isolation invariant.
  async deactivate(id: string): Promise<{ rowCount: number }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db
      .update(roles)
      .set({ active: false, updated_at: new Date() })
      .where(
        and(
          eq(roles.tenant_id, tenant_id),
          eq(roles.agent_id, agent_id),
          eq(roles.id, id),
        ),
      )
      .returning({ id: roles.id });
    return { rowCount: result.length };
  },
};

// P6: channel_policies — governance que define default role + switch_behavior
// + travas anti-oscilação para by_context. UNIQUE (channel_id) garante 1
// policy por canal.
export const channelPoliciesRepo = {
  async create(input: {
    channel_id: string;
    default_role_id: string;
    switch_behavior: SwitchBehavior;
    announce_mode?: AnnounceMode;
    by_context_guards?: unknown;
    allowed_role_ids?: string[];
  }): Promise<ChannelPolicy> {
    const guarded = applyTenantGuard({
      channel_id: input.channel_id,
      default_role_id: input.default_role_id,
      switch_behavior: input.switch_behavior,
      ...(input.announce_mode !== undefined
        ? { announce_mode: input.announce_mode }
        : {}),
      ...(input.by_context_guards !== undefined
        ? { by_context_guards: input.by_context_guards as object }
        : {}),
      ...(input.allowed_role_ids !== undefined
        ? { allowed_role_ids: input.allowed_role_ids as unknown as object }
        : {}),
    });
    const [row] = await db
      .insert(channel_policies)
      .values(guarded as typeof channel_policies.$inferInsert)
      .returning();
    return row!;
  },

  async getByChannelId(channel_id: string): Promise<ChannelPolicy | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(channel_policies)
      .where(
        and(
          eq(channel_policies.tenant_id, tenant_id),
          eq(channel_policies.agent_id, agent_id),
          eq(channel_policies.channel_id, channel_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async update(
    id: string,
    patch: Partial<NewChannelPolicy>,
  ): Promise<ChannelPolicy> {
    // Strip any tenant/agent the caller might have supplied — context wins.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const { tenant_id: inTenant, agent_id: inAgent, ...rest } = patch;
    if (inTenant && inTenant !== tenant_id) {
      throw new Error(`tenant mismatch: input ${inTenant} vs context ${tenant_id}`);
    }
    if (inAgent && inAgent !== agent_id) {
      throw new Error(`agent mismatch: input ${inAgent} vs context ${agent_id}`);
    }
    const [row] = await db
      .update(channel_policies)
      .set({
        ...rest,
        updated_at: new Date(),
      } as Partial<typeof channel_policies.$inferInsert>)
      .where(
        and(
          eq(channel_policies.tenant_id, tenant_id),
          eq(channel_policies.agent_id, agent_id),
          eq(channel_policies.id, id),
        ),
      )
      .returning();
    return row!;
  },
};

// P6: role_selector_decisions — log append-only de TODA decisão do role
// selector (mesmo "keep_current"). decided_by NUNCA pode ser llm_classifier:
// CHECK constraint no DB + runtime guard aqui (defense in depth). LLM
// sugere (suggested_by), policy decide (decided_by).
export const roleSelectorDecisionsRepo = {
  async record(input: {
    conversa_id?: string;
    turno_id?: string;
    channel_id?: string;
    policy_id?: string;
    current_role_id?: string;
    suggested_role_id?: string;
    decided_role_id: string;
    action: RoleDecisionAction;
    candidates: unknown[];
    conflicts: unknown[];
    suggested_by: SuggestedBy;
    decided_by: DecidedBy;
    suggested_strength?: RoleSelectorStrength;
    suggested_confidence?: number;
    reason?: string;
    switch_count_in_conversation?: number;
  }): Promise<RoleSelectorDecisionRow> {
    // CRITICAL runtime guard — defense in depth. DB has CHECK constraint,
    // but app validates too. LLM sugere; policy/owner/fallback decide.
    if ((input.decided_by as string) === 'llm_classifier') {
      throw new Error('decided_by_cannot_be_llm_classifier');
    }
    const guarded = applyTenantGuard({
      conversa_id: input.conversa_id ?? null,
      turno_id: input.turno_id ?? null,
      channel_id: input.channel_id ?? null,
      policy_id: input.policy_id ?? null,
      current_role_id: input.current_role_id ?? null,
      suggested_role_id: input.suggested_role_id ?? null,
      decided_role_id: input.decided_role_id,
      action: input.action,
      candidates: input.candidates as unknown as object,
      conflicts: input.conflicts as unknown as object,
      suggested_by: input.suggested_by,
      decided_by: input.decided_by,
      suggested_strength: input.suggested_strength ?? null,
      suggested_confidence:
        input.suggested_confidence !== undefined
          ? String(input.suggested_confidence)
          : null,
      reason: input.reason ?? null,
      switch_count_in_conversation: input.switch_count_in_conversation ?? 0,
    });
    const [row] = await db
      .insert(role_selector_decisions)
      .values(guarded as typeof role_selector_decisions.$inferInsert)
      .returning();
    return row!;
  },

  async listByConversation(
    conversa_id: string,
  ): Promise<RoleSelectorDecisionRow[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(role_selector_decisions)
      .where(
        and(
          eq(role_selector_decisions.tenant_id, tenant_id),
          eq(role_selector_decisions.agent_id, agent_id),
          eq(role_selector_decisions.conversa_id, conversa_id),
        ),
      )
      .orderBy(desc(role_selector_decisions.decided_at));
  },

  // [P88-C2] Returns the most recently DECIDED role for this conversation
  // (across all turns). Used by the role selector to rehydrate the current
  // role each turn — without this, `current_role` resets to policy.default
  // every turn, breaking the `by_context` anti-osc lock (it would punish
  // consistency by counting three same-context turns as three switches).
  async getLastDecidedRoleId(conversa_id: string): Promise<string | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select({ decided_role_id: role_selector_decisions.decided_role_id })
      .from(role_selector_decisions)
      .where(
        and(
          eq(role_selector_decisions.tenant_id, tenant_id),
          eq(role_selector_decisions.agent_id, agent_id),
          eq(role_selector_decisions.conversa_id, conversa_id),
        ),
      )
      .orderBy(desc(role_selector_decisions.decided_at))
      .limit(1);
    return rows[0]?.decided_role_id ?? null;
  },

  // [P88-H4 cooldown_turns] Counts decisions in this conversation in the
  // last N turns (i.e., the N most recent decisions). Used by the policy
  // decider to enforce `cooldown_turns` — require N turns between switches.
  async countSwitchesInLastNTurns(args: {
    conversa_id: string;
    n: number;
  }): Promise<number> {
    if (args.n <= 0) return 0;
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select({ action: role_selector_decisions.action })
      .from(role_selector_decisions)
      .where(
        and(
          eq(role_selector_decisions.tenant_id, tenant_id),
          eq(role_selector_decisions.agent_id, agent_id),
          eq(role_selector_decisions.conversa_id, args.conversa_id),
        ),
      )
      .orderBy(desc(role_selector_decisions.decided_at))
      .limit(args.n);
    return rows.filter((r) => r.action === 'switch').length;
  },

  async countSwitchesInConversation(conversa_id: string): Promise<number> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute<{ count: number | string }>(sql`
      SELECT COUNT(*)::int AS count
        FROM role_selector_decisions
       WHERE tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
         AND conversa_id = ${conversa_id}
         AND action = 'switch'
    `);
    const raw = result.rows[0]?.count ?? 0;
    return typeof raw === 'string' ? Number(raw) : raw;
  },
};
