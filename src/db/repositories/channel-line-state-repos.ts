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
import { channels, channel_line_state, admin_audit_log } from '../schema.js';
import type { ChannelLineStateRow } from '../schema.js';

/** Handle de transação, como `withTx` o entrega. */
type Tx = Parameters<Parameters<typeof withTx>[0]>[0];

export interface RequestCommandArgs {
  scope: LineScope;
  command: LineCommand;
  method?: PairingMethod;
  command_id: string;
  actor_id: string;
  actor_role: string;
  correlation_id: string;
  /** TTL da tentativa de pareamento (default 15 min, igual à PairingSession). */
  pairing_ttl_ms?: number;
}

export type RequestCommandResult =
  | { ok: true; row: ChannelLineStateRow; idempotent: boolean }
  | { ok: false; reason: 'channel_not_found' | 'pairing_in_progress' };

/**
 * Trilha administrativa que acompanha o comando na MESMA transação
 * (review PR #528, P2).
 */
export interface LineCommandAudit {
  actor_id: string;
  actor_role: string;
  action: string;
  change_summary: Record<string, unknown>;
}

export type LineState =
  | 'declared'
  | 'pairing'
  /** Abort pedido, aguardando o runtime confirmar que a sessão morreu. */
  | 'aborting'
  | 'verified_offline'
  | 'connected'
  | 'recovering'
  | 'logged_out'
  | 'failed'
  | 'disabled';

export type LineCommand = 'start_pairing' | 'abort_pairing' | 'repair' | 'stop_line';
export type PairingMethod = 'qr' | 'code';

/**
 * Validade da LEASE de posse (review PR #528, P1). Precisa ser
 * confortavelmente maior que a cadência do heartbeat (o worker roda a cada 5s)
 * para não expirar por um tick perdido, e pequena o bastante para que um
 * processo morto libere o canal em menos de um minuto.
 */
export const OWNER_LEASE_MS = 60_000;

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


/**
 * Corpo do enfileiramento, parametrizado pela TRANSACAO. Extraido para que
 * comando, estado e admin_audit_log caiam no MESMO commit (review PR #528, P2)
 * e para que disableLineWithAudit reaproveite exatamente a mesma logica de
 * concorrencia em vez de duplica-la.
 */
async function requestCommandInTx(
  tx: Tx,
  args: RequestCommandArgs,
): Promise<RequestCommandResult> {
    const ttl = args.pairing_ttl_ms ?? 15 * 60_000;
    {
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

      // Abort é IDEMPOTENTE de verdade: um segundo pedido enquanto o primeiro
      // ainda não foi consumido devolve a mesma operação em vez de trocar o
      // `command_id` — trocar quebraria o CAS que o worker usa para confirmar
      // o abort (review PR #528, P1).
      if (args.command === 'abort_pairing' && current?.command === 'abort_pairing') {
        return { ok: true as const, row: current, idempotent: true };
      }

      if (args.command === 'start_pairing') {
        const alive =
          current?.state === 'pairing' &&
          current.pairing_expires_at !== null &&
          current.pairing_expires_at.getTime() > now.getTime();
        // Review PR #528 (P1): `aborting` também BLOQUEIA um novo start. A
        // sequência start → cancelar → tentar de novo (antes do tick) fazia o
        // novo comando sobrescrever o abort pendente: a sessão antiga nunca
        // era abortada, seguia viva e podia concluir e ATIVAR a linha. O
        // estado só reabre depois que o runtime CONFIRMA o abort.
        if (alive || current?.state === 'aborting') {
          return { ok: false as const, reason: 'pairing_in_progress' as const };
        }
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
                // Havia pareamento em curso ⇒ vai para `aborting`, NÃO para
                // `declared`: a linha só reabre para um novo start quando o
                // runtime confirmar que a sessão morreu. Um abort sobre uma
                // linha conectada não muda estado (não é um "desconectar").
                ...(current === null || current.state === 'pairing'
                  ? {
                      state: 'aborting' as const,
                      reason_code: 'operator_abort',
                    }
                  : {}),
              }
            : args.command === 'repair'
              ? { ...base, reason_code: 'operator_repair_requested' }
              : // `stop_line`: só a ORDEM de derrubar o socket. O estado
                // (`disabled`) já foi decidido por quem pediu — este comando
                // não redefine estado nem reason code.
                base;

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
    }
}

/** Trilha administrativa, na transacao do chamador. */
async function appendLineAudit(
  tx: Tx,
  scope: LineScope,
  entry: LineCommandAudit,
): Promise<void> {
  await tx.insert(admin_audit_log).values({
    tenant_id: scope.tenant_id,
    actor_id: entry.actor_id,
    actor_role: entry.actor_role,
    action: entry.action,
    resource_type: 'channel',
    resource_id: scope.channel_id,
    change_summary: entry.change_summary,
  });
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
  async requestCommand(args: RequestCommandArgs): Promise<RequestCommandResult> {
    return withTx((tx) => requestCommandInTx(tx, args));
  },

  /**
   * Idem, mas o comando e a linha de `admin_audit_log` caem no MESMO commit
   * (review PR #528, P2).
   *
   * Antes eram duas transações: se o processo ou o banco caísse entre elas, o
   * comando sobrevivia e era EXECUTADO sem trilha — violação direta da
   * invariante 4 do AGENTS.md ("audit every decision"). Mesmo contrato de
   * `channelsRepo.createWithAudit`: uma falha no insert de auditoria desfaz o
   * comando, nunca o contrário.
   *
   * Um replay idempotente não gera audit novo (a operação não aconteceu de
   * novo) — e, como nada é escrito, não há o que desfazer.
   */
  async requestCommandWithAudit(
    args: RequestCommandArgs & { audit: LineCommandAudit },
  ): Promise<RequestCommandResult> {
    return withTx(async (tx) => {
      const result = await requestCommandInTx(tx, args);
      if (result.ok && !result.idempotent) {
        await appendLineAudit(tx, args.scope, {
          ...args.audit,
          change_summary: {
            ...args.audit.change_summary,
            // Número da tentativa: só existe depois da escrita, e vale a pena
            // na trilha ("3ª tentativa desta linha").
            attempt: result.row.pairing_attempts,
          },
        });
      }
      return result;
    });
  },

  /**
   * Desabilita a linha: para o roteamento, marca o estado, enfileira a
   * derrubada do socket e audita — TUDO no mesmo commit (review PR #528, P2).
   * Eram quatro escritas soltas; uma queda no meio deixava a linha desativada
   * sem trilha, ou com trilha e sem o comando de parada.
   */
  async disableLineWithAudit(args: {
    scope: LineScope;
    reason_code: string;
    stop_command_id: string;
    actor_id: string;
    actor_role: string;
    correlation_id: string;
    audit: LineCommandAudit;
  }): Promise<{ ok: true } | { ok: false; reason: 'channel_not_found' }> {
    return withTx(async (tx) => {
      const now = new Date();
      // Escopo EXPLÍCITO no WHERE (não ALS): o contrato é validar o triplete
      // como recebido.
      const deactivated = await tx
        .update(channels)
        .set({ active: false, updated_at: now })
        .where(
          and(
            eq(channels.tenant_id, args.scope.tenant_id),
            eq(channels.agent_id, args.scope.agent_id),
            eq(channels.id, args.scope.channel_id),
          ),
        )
        .returning({ id: channels.id });
      if (deactivated.length === 0) {
        return { ok: false as const, reason: 'channel_not_found' as const };
      }

      await tx
        .insert(channel_line_state)
        .values({
          channel_id: args.scope.channel_id,
          tenant_id: args.scope.tenant_id,
          agent_id: args.scope.agent_id,
          state: 'disabled',
          reason_code: args.reason_code,
          last_transition_at: now,
          disconnected_at: now,
        })
        .onConflictDoUpdate({
          target: channel_line_state.channel_id,
          set: {
            state: 'disabled',
            reason_code: args.reason_code,
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

      // O socket vive no runtime — desativar a row não o encerra (P1).
      await requestCommandInTx(tx, {
        scope: args.scope,
        command: 'stop_line',
        command_id: args.stop_command_id,
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        correlation_id: args.correlation_id,
      });

      await appendLineAudit(tx, args.scope, args.audit);
      return { ok: true as const };
    });
  },


  /**
   * Marca a linha como desabilitada pelo operador, sem transação composta.
   * O caminho do console é `disableLineWithAudit`; este fica para chamadores
   * que já provaram o escopo e não precisam do commit único.
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
  async claimNextCommand(
    owner_instance: string,
    lease_ms: number = OWNER_LEASE_MS,
  ): Promise<
    | (ChannelLineStateRow & {
        external_id: string;
        channel_type: string;
        channel_active: boolean;
      })
    | null
  > {
    return withTx(async (tx) => {
      const now = new Date();
      // Review PR #528 (P1): o candidato precisa estar NÃO-REIVINDICADO ou com
      // a LEASE VENCIDA. Antes, qualquer `command IS NOT NULL` era elegível —
      // `FOR UPDATE SKIP LOCKED` só protege a janela da transação, então assim
      // que ela commitava a mesma row voltava ao pool e uma segunda réplica
      // executava o MESMO `command_id`.
      const candidates = await tx
        .select({ channel_id: channel_line_state.channel_id })
        .from(channel_line_state)
        .where(
          and(
            isNotNull(channel_line_state.command),
            sql`(${channel_line_state.command_claimed_at} IS NULL
                  OR ${channel_line_state.owner_lease_expires_at} IS NULL
                  OR ${channel_line_state.owner_lease_expires_at} < ${now})`,
          ),
        )
        .orderBy(channel_line_state.command_requested_at)
        .limit(1)
        .for('update', { skipLocked: true });
      const target = candidates[0];
      if (!target) return null;

      const claimed = await tx
        .update(channel_line_state)
        .set({
          command_claimed_at: now,
          owner_instance,
          owner_lease_expires_at: new Date(now.getTime() + lease_ms),
        })
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

  /**
   * Heartbeat: o dono renova a lease das rows que está tocando AGORA — as que
   * têm comando reivindicado por ele e as que estão com um pareamento vivo em
   * memória (comando já consumido, PairingSession rodando).
   *
   * É isto que distingue "dono morto" de "dono vivo e lento". Sem o heartbeat
   * a única forma de detectar o dono morto seria comparar `owner_instance`, e
   * era exatamente essa comparação que fazia a réplica B derrubar a sessão
   * viva da réplica A (review PR #528, P1).
   */
  async renewOwnerLeases(
    owner_instance: string,
    lease_ms: number = OWNER_LEASE_MS,
  ): Promise<number> {
    const now = new Date();
    const rows = await db
      .update(channel_line_state)
      .set({ owner_lease_expires_at: new Date(now.getTime() + lease_ms) })
      .where(
        and(
          eq(channel_line_state.owner_instance, owner_instance),
          sql`(${channel_line_state.command} IS NOT NULL
                OR ${channel_line_state.state} = 'pairing')`,
        ),
      )
      .returning({ channel_id: channel_line_state.channel_id });
    return rows.length;
  },

  /**
   * Limpa o comando executado. CAS por `(channel_id, command_id,
   * owner_instance)`: um `finally` atrasado de uma execução ANTIGA não pode
   * apagar o comando NOVO que o operador acabou de enfileirar (review PR #528,
   * P1). Devolve `false` quando o comando já não é o desta execução.
   *
   * A LEASE é renovada, não zerada: o comando acabou, mas a PairingSession que
   * ele abriu continua viva NESTA instância — zerar a lease aqui faria o
   * próprio sweep matar a sessão que acabamos de abrir.
   */
  async clearCommand(args: {
    channel_id: string;
    command_id: string | null;
    owner_instance: string;
    lease_ms?: number;
  }): Promise<boolean> {
    const now = new Date();
    const rows = await db
      .update(channel_line_state)
      .set({
        command: null,
        command_method: null,
        command_claimed_at: null,
        owner_lease_expires_at: new Date(now.getTime() + (args.lease_ms ?? OWNER_LEASE_MS)),
        updated_at: now,
      })
      .where(
        and(
          eq(channel_line_state.channel_id, args.channel_id),
          eq(channel_line_state.owner_instance, args.owner_instance),
          args.command_id === null
            ? sql`${channel_line_state.command_id} IS NULL`
            : eq(channel_line_state.command_id, args.command_id),
        ),
      )
      .returning({ channel_id: channel_line_state.channel_id });
    return rows.length > 0;
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
    /**
     * Solta a posse: o trabalho terminou, esta instância não tem mais nada
     * rodando em memória para este canal. Sem isto a lease continuaria sendo
     * renovada pelo heartbeat de um dono que já não faz nada.
     */
    release_owner?: boolean;
  }): Promise<boolean> {
    const now = new Date();
    const rows = await db
      .update(channel_line_state)
      .set({
        state: args.state,
        ...(args.release_owner
          ? { owner_instance: null, owner_lease_expires_at: null }
          : {}),
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
        // Review PR #528 (P1): uma linha DESABILITADA pelo operador não volta
        // sozinha. Sem este guard, um `connection.update` atrasado do socket
        // que ainda não morreu regravava `connected` por cima do `disabled` —
        // a tela passava a mentir sobre uma linha que o operador desligou.
        setWhere: sql`${channel_line_state.state} <> 'disabled'`,
      });
  },

  /**
   * Restart no meio do pareamento (§7): a PairingSession vivia em memória, e
   * essa memória morreu. Toda row presa em `pairing` cujo TTL já passou —
   * ou que pertencia a OUTRA instância — vira `failed/retryable`, NUNCA
   * `verified`. O material é destruído junto.
   */
  async failStalePairings(args: {
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
        owner_lease_expires_at: null,
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
          // console que nenhum worker reivindicou — varrê-la aqui mataria o
          // pareamento antes de ele começar.
          sql`${channel_line_state.command} IS NULL`,
          // Review PR #528 (P1): o critério é a LEASE, NUNCA a identidade do
          // dono. A versão anterior tinha `owner_instance <> :me`, e com duas
          // réplicas isso significava que B derrubava a sessão VIVA de A a
          // cada tick. Agora só cai quem parou de renovar (processo morto) ou
          // quem estourou o TTL da própria tentativa.
          sql`(${channel_line_state.owner_instance} IS NULL
                OR ${channel_line_state.owner_lease_expires_at} IS NULL
                OR ${channel_line_state.owner_lease_expires_at} < ${now}
                OR ${channel_line_state.pairing_expires_at} < ${now})`,
        ),
      )
      .returning({
        channel_id: channel_line_state.channel_id,
        tenant_id: channel_line_state.tenant_id,
        agent_id: channel_line_state.agent_id,
      });
  },

  /**
   * Resgata aborts órfãos. Se o processo que detinha a PairingSession morreu
   * ANTES de confirmar o abort, a row ficaria presa em `aborting` para sempre
   * e a linha nunca mais poderia ser pareada. A morte do processo já cumpriu o
   * efeito do abort (o socket foi junto), então a row volta para `declared`.
   *
   * O critério é a LEASE, não a identidade do dono — mesmo racional de
   * `failStalePairings`.
   */
  async releaseStaleAborts(): Promise<Array<{ channel_id: string }>> {
    const now = new Date();
    return db
      .update(channel_line_state)
      .set({
        state: 'declared',
        reason_code: 'operator_abort',
        command: null,
        command_method: null,
        command_claimed_at: null,
        owner_instance: null,
        owner_lease_expires_at: null,
        pairing_expires_at: null,
        pairing_material: null,
        pairing_material_key_id: null,
        pairing_material_kind: null,
        pairing_material_expires_at: null,
        last_transition_at: now,
        updated_at: now,
      })
      .where(
        and(
          eq(channel_line_state.state, 'aborting'),
          sql`${channel_line_state.command} IS NULL`,
          sql`(${channel_line_state.owner_instance} IS NULL
                OR ${channel_line_state.owner_lease_expires_at} IS NULL
                OR ${channel_line_state.owner_lease_expires_at} < ${now})`,
        ),
      )
      .returning({ channel_id: channel_line_state.channel_id });
  },

  /**
   * Linhas com POSSE PROVADA que ainda NÃO roteiam (issue #518 §4).
   *
   * O gate de readiness deixa o canal inativo quando a política não está
   * pronta. Esta consulta alimenta a revalidação periódica: assim que o
   * operador criar a política, o backend ativa sozinho — sem exigir um novo
   * pareamento. Cross-tenant pelo mesmo padrão sancionado do boot multi-linha;
   * a própria row diz a qual (tenant, agent) a linha pertence.
   */
  async listVerifiedAwaitingActivation(
    limit = 50,
  ): Promise<
    Array<{ channel_id: string; tenant_id: string; agent_id: string; external_id: string }>
  > {
    return db
      .select({
        channel_id: channel_line_state.channel_id,
        tenant_id: channel_line_state.tenant_id,
        agent_id: channel_line_state.agent_id,
        external_id: channels.external_id,
      })
      .from(channel_line_state)
      .innerJoin(channels, eq(channels.id, channel_line_state.channel_id))
      .where(
        and(
          eq(channel_line_state.state, 'verified_offline'),
          eq(channels.active, false),
          eq(channels.channel_type, 'whatsapp'),
          eq(channels.is_synthetic, false),
        ),
      )
      .limit(limit);
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
