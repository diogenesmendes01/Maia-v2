/**
 * Issue #518 — repositório do estado operacional das LINHAS whatsapp e da
 * fila durável de comandos Admin→runtime (migration 103).
 *
 * Duas fronteiras, dois contratos:
 *
 *  1. CONSOLE (admin-ui). Todos os métodos recebem `{ tenant_id, agent_id,
 *     channel_id }` EXPLÍCITOS e carregam o triplete no WHERE. Não usam ALS de
 *     propósito: o contrato é validar o escopo COMO RECEBIDO — um channel_id
 *     estrangeiro plantado por bug não pode ser legitimado pelo contexto
 *     corrente (mesmo racional de `channelsRepo.channelBelongsToScopeActive`).
 *     Fail-closed: linha de outro tenant simplesmente não existe.
 *
 *  2. RUNTIME (worker de pareamento). `claimNextCommand` e as transições são
 *     EXPLICITAMENTE cross-tenant, pelo padrão sancionado de entry-point
 *     (`findByExternalCrossTenant`): o worker roda antes de qualquer contexto
 *     e a própria row diz a qual (tenant, agent) a linha pertence — ele abre
 *     `runWithTenantContext` com o que leu.
 *
 * Material de pareamento (QR/código) só entra aqui CIFRADO — ver
 * `src/setup/pairing-material.ts`. Este repo nunca loga o envelope.
 */
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { db, withTx } from '../client.js';
import { channels, channel_line_state } from '../schema.js';
import type { ChannelLineStateRow } from '../schema.js';

export type LineState =
  | 'declared'
  | 'pairing'
  | 'verified_offline'
  | 'connected'
  | 'recovering'
  | 'logged_out'
  | 'failed'
  | 'disabled';

export type LineCommand = 'start_pairing' | 'abort_pairing' | 'repair';
export type PairingMethod = 'qr' | 'code';

export interface LineScope {
  tenant_id: string;
  agent_id: string;
  channel_id: string;
}

/** Uma linha como o console a enxerga: canal + estado operacional. */
export interface LineOverviewRow {
  channel_id: string;
  tenant_id: string;
  agent_id: string;
  external_id: string;
  channel_type: string;
  display_name: string | null;
  /** Roteamento (channels.active) — NÃO é estado de conexão. */
  active: boolean;
  is_synthetic: boolean;
  state: LineState;
  pairing_method: PairingMethod | null;
  pairing_started_at: Date | null;
  pairing_expires_at: Date | null;
  pairing_attempts: number;
  reason_code: string | null;
  verified_at: Date | null;
  connected_at: Date | null;
  disconnected_at: Date | null;
  last_transition_at: Date | null;
  command: LineCommand | null;
}

/**
 * Projeção do JOIN canal×estado. É uma FUNÇÃO, não uma constante de módulo,
 * de propósito: dezenas de specs fazem `vi.mock('@/db/schema.js')` PARCIAL, e
 * tocar `channels.id` no topo do arquivo quebraria a importação inteira de
 * `db/repositories.js` nesses testes. Avaliar na hora da query mantém o
 * módulo importável sem o schema real.
 */
function overviewColumns() {
  return {
    channel_id: channels.id,
    tenant_id: channels.tenant_id,
    agent_id: channels.agent_id,
    external_id: channels.external_id,
    channel_type: channels.channel_type,
    display_name: channels.display_name,
    active: channels.active,
    is_synthetic: channels.is_synthetic,
    state: channel_line_state.state,
    pairing_method: channel_line_state.pairing_method,
    pairing_started_at: channel_line_state.pairing_started_at,
    pairing_expires_at: channel_line_state.pairing_expires_at,
    pairing_attempts: channel_line_state.pairing_attempts,
    reason_code: channel_line_state.reason_code,
    verified_at: channel_line_state.verified_at,
    connected_at: channel_line_state.connected_at,
    disconnected_at: channel_line_state.disconnected_at,
    last_transition_at: channel_line_state.last_transition_at,
    command: channel_line_state.command,
  };
}

/**
 * Um canal sem row em `channel_line_state` (criado antes da 103 ou de outro
 * channel_type) é apresentado com o estado DERIVADO do roteamento — nunca
 * `connected`, que exige prova de socket vivo.
 */
function normalizeOverview(raw: {
  channel_id: string;
  tenant_id: string;
  agent_id: string;
  external_id: string;
  channel_type: string;
  display_name: string | null;
  active: boolean;
  is_synthetic: boolean;
  state: string | null;
  pairing_method: string | null;
  pairing_started_at: Date | null;
  pairing_expires_at: Date | null;
  pairing_attempts: number | null;
  reason_code: string | null;
  verified_at: Date | null;
  connected_at: Date | null;
  disconnected_at: Date | null;
  last_transition_at: Date | null;
  command: string | null;
}): LineOverviewRow {
  return {
    channel_id: raw.channel_id,
    tenant_id: raw.tenant_id,
    agent_id: raw.agent_id,
    external_id: raw.external_id,
    channel_type: raw.channel_type,
    display_name: raw.display_name,
    active: raw.active,
    is_synthetic: raw.is_synthetic,
    state: (raw.state ?? (raw.active ? 'verified_offline' : 'declared')) as LineState,
    pairing_method: (raw.pairing_method as PairingMethod | null) ?? null,
    pairing_started_at: raw.pairing_started_at,
    pairing_expires_at: raw.pairing_expires_at,
    pairing_attempts: raw.pairing_attempts ?? 0,
    reason_code: raw.reason_code,
    verified_at: raw.verified_at,
    connected_at: raw.connected_at,
    disconnected_at: raw.disconnected_at,
    last_transition_at: raw.last_transition_at,
    command: (raw.command as LineCommand | null) ?? null,
  };
}

export const channelLineStateRepo = {
  /**
   * Listagem do console: TODOS os canais do (tenant, agent) — ativos E
   * inativos. O canal whatsapp nasce inativo ("declarado"); a listagem antiga
   * (`listActive`) o fazia desaparecer logo após ser criado.
   */
  async listLinesForScope(scope: {
    tenant_id: string;
    agent_id: string;
  }): Promise<LineOverviewRow[]> {
    const rows = await db
      .select(overviewColumns())
      .from(channels)
      .leftJoin(channel_line_state, eq(channel_line_state.channel_id, channels.id))
      .where(
        and(eq(channels.tenant_id, scope.tenant_id), eq(channels.agent_id, scope.agent_id)),
      )
      .orderBy(channels.channel_type, channels.external_id);
    return rows.map(normalizeOverview);
  },

  /** Uma linha, provando o triplete. `null` = não existe NESTE escopo. */
  async getForScope(scope: LineScope): Promise<LineOverviewRow | null> {
    const rows = await db
      .select(overviewColumns())
      .from(channels)
      .leftJoin(channel_line_state, eq(channel_line_state.channel_id, channels.id))
      .where(
        and(
          eq(channels.tenant_id, scope.tenant_id),
          eq(channels.agent_id, scope.agent_id),
          eq(channels.id, scope.channel_id),
        ),
      )
      .limit(1);
    return rows[0] ? normalizeOverview(rows[0]) : null;
  },

  /**
   * Estado + material cifrado de UMA linha, provando o triplete. Usado só
   * pelo `getPairingStatus` do console; devolve o envelope como está (a
   * decifra acontece na camada que renderiza, nunca no log).
   */
  async getStateForScope(scope: LineScope): Promise<ChannelLineStateRow | null> {
    const rows = await db
      .select()
      .from(channel_line_state)
      .where(
        and(
          eq(channel_line_state.tenant_id, scope.tenant_id),
          eq(channel_line_state.agent_id, scope.agent_id),
          eq(channel_line_state.channel_id, scope.channel_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Enfileira um comando do console para o runtime, com as regras de
   * concorrência da issue (§7):
   *   - mesma `command_id` ⇒ IDEMPOTENTE (devolve a sessão existente);
   *   - `start_pairing` com pairing vivo de OUTRA chave ⇒ `pairing_in_progress`;
   *   - `abort_pairing` é sempre aceito (idempotente);
   *   - a row é criada on-demand (canais anteriores à 103).
   *
   * Tudo em UMA transação com `SELECT … FOR UPDATE` na row do canal: duas
   * requisições concorrentes serializam e a segunda vê o pairing da primeira.
   */
  async requestCommand(args: {
    scope: LineScope;
    command: LineCommand;
    method?: PairingMethod;
    command_id: string;
    actor_id: string;
    actor_role: string;
    correlation_id: string;
    /** TTL da tentativa de pareamento (default 15 min, igual à PairingSession). */
    pairing_ttl_ms?: number;
  }): Promise<
    | { ok: true; row: ChannelLineStateRow; idempotent: boolean }
    | { ok: false; reason: 'channel_not_found' | 'pairing_in_progress' }
  > {
    const ttl = args.pairing_ttl_ms ?? 15 * 60_000;
    return withTx(async (tx) => {
      // O canal precisa existir NESTE escopo — a checagem vive dentro da tx
      // para não abrir janela TOCTOU com um DELETE concorrente.
      const chan = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.tenant_id, args.scope.tenant_id),
            eq(channels.agent_id, args.scope.agent_id),
            eq(channels.id, args.scope.channel_id),
          ),
        )
        .limit(1);
      if (chan.length === 0) return { ok: false as const, reason: 'channel_not_found' as const };

      const locked = await tx
        .select()
        .from(channel_line_state)
        .where(eq(channel_line_state.channel_id, args.scope.channel_id))
        .limit(1)
        .for('update');
      const current = locked[0] ?? null;
      const now = new Date();

      if (current && current.command_id === args.command_id) {
        return { ok: true as const, row: current, idempotent: true };
      }

      if (args.command === 'start_pairing') {
        const alive =
          current?.state === 'pairing' &&
          current.pairing_expires_at !== null &&
          current.pairing_expires_at.getTime() > now.getTime();
        if (alive) return { ok: false as const, reason: 'pairing_in_progress' as const };
      }

      const base = {
        command: args.command,
        command_method: args.method ?? null,
        command_id: args.command_id,
        command_requested_at: now,
        command_claimed_at: null,
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        correlation_id: args.correlation_id,
        last_transition_at: now,
        updated_at: now,
        // Toda troca de comando invalida o material da tentativa anterior:
        // "abort/retry não reutilizam estado de tentativa anterior".
        pairing_material: null,
        pairing_material_key_id: null,
        pairing_material_kind: null,
        pairing_material_expires_at: null,
      };

      const patch =
        args.command === 'start_pairing'
          ? {
              ...base,
              state: 'pairing' as const,
              pairing_method: args.method ?? null,
              pairing_started_at: now,
              pairing_expires_at: new Date(now.getTime() + ttl),
              pairing_attempts: (current?.pairing_attempts ?? 0) + 1,
              reason_code: null,
              owner_instance: null,
            }
          : args.command === 'abort_pairing'
            ? {
                ...base,
                // Abortar volta para `declared` SÓ se havia pairing em curso —
                // um abort sobre uma linha conectada não pode "desconectá-la"
                // no modelo de estado.
                ...(current === null || current.state === 'pairing'
                  ? {
                      state: 'declared' as const,
                      reason_code: 'operator_abort',
                      pairing_expires_at: null,
                    }
                  : {}),
              }
            : { ...base, reason_code: 'operator_repair_requested' };

      if (current === null) {
        const inserted = await tx
          .insert(channel_line_state)
          .values({
            channel_id: args.scope.channel_id,
            tenant_id: args.scope.tenant_id,
            agent_id: args.scope.agent_id,
            state: 'declared',
            ...patch,
          })
          .returning();
        return { ok: true as const, row: inserted[0]!, idempotent: false };
      }

      const updated = await tx
        .update(channel_line_state)
        .set(patch)
        .where(eq(channel_line_state.channel_id, args.scope.channel_id))
        .returning();
      return { ok: true as const, row: updated[0]!, idempotent: false };
    });
  },

  /**
   * Marca a linha como desabilitada pelo operador. Chamado junto (mesma
   * transação lógica do router) com `channelsRepo.deactivate`.
   */
  async markDisabled(scope: LineScope, reason_code: string): Promise<void> {
    const now = new Date();
    await db
      .insert(channel_line_state)
      .values({
        channel_id: scope.channel_id,
        tenant_id: scope.tenant_id,
        agent_id: scope.agent_id,
        state: 'disabled',
        reason_code,
        last_transition_at: now,
        disconnected_at: now,
      })
      .onConflictDoUpdate({
        target: channel_line_state.channel_id,
        set: {
          state: 'disabled',
          reason_code,
          command: null,
          command_method: null,
          pairing_material: null,
          pairing_material_key_id: null,
          pairing_material_kind: null,
          pairing_material_expires_at: null,
          pairing_expires_at: null,
          disconnected_at: now,
          last_transition_at: now,
          updated_at: now,
        },
      });
  },

  // ── superfície do RUNTIME (explicitamente cross-tenant) ──────────────────

  /**
   * Reivindica o próximo comando pendente. `FOR UPDATE SKIP LOCKED` = duas
   * réplicas do runtime nunca pegam a mesma row.
   */
  async claimNextCommand(owner_instance: string): Promise<
    | (ChannelLineStateRow & {
        external_id: string;
        channel_type: string;
        channel_active: boolean;
      })
    | null
  > {
    return withTx(async (tx) => {
      const candidates = await tx
        .select({ channel_id: channel_line_state.channel_id })
        .from(channel_line_state)
        .where(isNotNull(channel_line_state.command))
        .orderBy(channel_line_state.command_requested_at)
        .limit(1)
        .for('update', { skipLocked: true });
      const target = candidates[0];
      if (!target) return null;

      const claimed = await tx
        .update(channel_line_state)
        .set({ command_claimed_at: new Date(), owner_instance })
        .where(eq(channel_line_state.channel_id, target.channel_id))
        .returning();
      const row = claimed[0]!;

      const chan = await tx
        .select({
          external_id: channels.external_id,
          channel_type: channels.channel_type,
          active: channels.active,
        })
        .from(channels)
        .where(eq(channels.id, row.channel_id))
        .limit(1);
      const c = chan[0];
      if (!c) return null;
      return {
        ...row,
        external_id: c.external_id,
        channel_type: c.channel_type,
        channel_active: c.active,
      };
    });
  },

  /** Limpa o comando reivindicado (executado ou descartado). */
  async clearCommand(channel_id: string): Promise<void> {
    await db
      .update(channel_line_state)
      .set({
        command: null,
        command_method: null,
        command_claimed_at: null,
        updated_at: new Date(),
      })
      .where(eq(channel_line_state.channel_id, channel_id));
  },

  /**
   * Guarda o material CIFRADO da tentativa corrente. O WHERE exige que a
   * `command_id` ainda seja a desta tentativa: um callback atrasado de uma
   * sessão abortada não pode reinjetar QR na tentativa nova (§7).
   */
  async putPairingMaterial(args: {
    channel_id: string;
    command_id: string | null;
    envelope: Buffer;
    key_id: string;
    kind: PairingMethod;
    expires_at: Date;
  }): Promise<boolean> {
    const rows = await db
      .update(channel_line_state)
      .set({
        pairing_material: args.envelope,
        pairing_material_key_id: args.key_id,
        pairing_material_kind: args.kind,
        pairing_material_expires_at: args.expires_at,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(channel_line_state.channel_id, args.channel_id),
          eq(channel_line_state.state, 'pairing'),
          args.command_id === null
            ? sql`${channel_line_state.command_id} IS NULL`
            : eq(channel_line_state.command_id, args.command_id),
        ),
      )
      .returning({ channel_id: channel_line_state.channel_id });
    return rows.length > 0;
  },

  /**
   * Transição de estado. `expected_command_id` implementa o mesmo guard de
   * identidade do `stillCurrent()` em memória: só escreve se a row ainda for
   * da tentativa que produziu o resultado.
   */
  async transition(args: {
    channel_id: string;
    state: LineState;
    reason_code?: string | null;
    expected_command_id?: string | null;
    verified_at?: Date;
    connected_at?: Date;
    disconnected_at?: Date;
    clear_material?: boolean;
  }): Promise<boolean> {
    const now = new Date();
    const rows = await db
      .update(channel_line_state)
      .set({
        state: args.state,
        ...(args.reason_code !== undefined ? { reason_code: args.reason_code } : {}),
        ...(args.verified_at ? { verified_at: args.verified_at } : {}),
        ...(args.connected_at ? { connected_at: args.connected_at } : {}),
        ...(args.disconnected_at ? { disconnected_at: args.disconnected_at } : {}),
        ...(args.clear_material !== false
          ? {
              pairing_material: null,
              pairing_material_key_id: null,
              pairing_material_kind: null,
              pairing_material_expires_at: null,
            }
          : {}),
        last_transition_at: now,
        updated_at: now,
      })
      .where(
        args.expected_command_id
          ? and(
              eq(channel_line_state.channel_id, args.channel_id),
              eq(channel_line_state.command_id, args.expected_command_id),
            )
          : eq(channel_line_state.channel_id, args.channel_id),
      )
      .returning({ channel_id: channel_line_state.channel_id });
    return rows.length > 0;
  },

  /**
   * Idem `transition`, mas cria a row se ela não existir. Usado pelas
   * transições de SESSÃO (connected/recovering/logged_out), que podem atingir
   * canais anteriores à 103.
   */
  async upsertTransition(args: {
    channel_id: string;
    tenant_id: string;
    agent_id: string;
    state: LineState;
    reason_code?: string | null;
    connected_at?: Date;
    disconnected_at?: Date;
  }): Promise<void> {
    const now = new Date();
    await db
      .insert(channel_line_state)
      .values({
        channel_id: args.channel_id,
        tenant_id: args.tenant_id,
        agent_id: args.agent_id,
        state: args.state,
        reason_code: args.reason_code ?? null,
        ...(args.connected_at ? { connected_at: args.connected_at } : {}),
        ...(args.disconnected_at ? { disconnected_at: args.disconnected_at } : {}),
        last_transition_at: now,
      })
      .onConflictDoUpdate({
        target: channel_line_state.channel_id,
        set: {
          state: args.state,
          reason_code: args.reason_code ?? null,
          ...(args.connected_at ? { connected_at: args.connected_at } : {}),
          ...(args.disconnected_at ? { disconnected_at: args.disconnected_at } : {}),
          // Uma sessão que abre/fecha nunca deve deixar material visível.
          pairing_material: null,
          pairing_material_key_id: null,
          pairing_material_kind: null,
          pairing_material_expires_at: null,
          last_transition_at: now,
          updated_at: now,
        },
      });
  },

  /**
   * Restart no meio do pareamento (§7): a PairingSession vivia em memória, e
   * essa memória morreu. Toda row presa em `pairing` cujo TTL já passou —
   * ou que pertencia a OUTRA instância — vira `failed/retryable`, NUNCA
   * `verified`. O material é destruído junto.
   */
  async failStalePairings(args: {
    owner_instance: string;
    reason_code: string;
  }): Promise<Array<{ channel_id: string; tenant_id: string; agent_id: string }>> {
    const now = new Date();
    return db
      .update(channel_line_state)
      .set({
        state: 'failed',
        reason_code: args.reason_code,
        command_claimed_at: null,
        owner_instance: null,
        pairing_material: null,
        pairing_material_key_id: null,
        pairing_material_kind: null,
        pairing_material_expires_at: null,
        last_transition_at: now,
        updated_at: now,
      })
      .where(
        and(
          eq(channel_line_state.state, 'pairing'),
          // Um comando AINDA PENDENTE é uma tentativa recém-pedida pelo
          // console que este worker ainda não reivindicou — varrê-la aqui
          // mataria o pareamento antes de ele começar.
          sql`${channel_line_state.command} IS NULL`,
          sql`(${channel_line_state.owner_instance} IS NULL
                OR ${channel_line_state.owner_instance} <> ${args.owner_instance}
                OR ${channel_line_state.pairing_expires_at} < ${now})`,
        ),
      )
      .returning({
        channel_id: channel_line_state.channel_id,
        tenant_id: channel_line_state.tenant_id,
        agent_id: channel_line_state.agent_id,
      });
  },

  /** Sweep barato do material vencido (o estado da tentativa continua). */
  async expireStaleMaterial(): Promise<number> {
    const rows = await db
      .update(channel_line_state)
      .set({
        pairing_material: null,
        pairing_material_key_id: null,
        pairing_material_kind: null,
        pairing_material_expires_at: null,
        updated_at: new Date(),
      })
      .where(
        and(
          isNotNull(channel_line_state.pairing_material),
          lt(channel_line_state.pairing_material_expires_at, new Date()),
        ),
      )
      .returning({ channel_id: channel_line_state.channel_id });
    return rows.length;
  },
};
