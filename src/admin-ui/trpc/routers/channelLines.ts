/**
 * Admin UI — LINHAS de canal (issue #518).
 *
 * Superfície autenticada por NextAuth para declarar, parear, abortar,
 * desabilitar e pedir re-pareamento de uma linha WhatsApp. O que ela
 * substitui: os endpoints `/setup/channels/:id/pair*` do runtime, que
 * autenticavam por `?token=` — bootstrap token em query string, ou seja,
 * gravado por browser, proxy e access log.
 *
 * Contrato de segurança de CADA procedure:
 *   - sessão NextAuth obrigatória (`protectedProcedure`);
 *   - papel `owner|founder` (o QR de uma linha é credencial: quem o lê conecta
 *     um aparelho — viewer/analyst/compliance recebem FORBIDDEN);
 *   - tenant resolvido pela SESSÃO (`resolveTenantId`), nunca pelo body;
 *   - canal buscado por `(tenant_id, agent_id, channel_id)` — lookup
 *     cross-tenant não é autorização; linha de outro tenant simplesmente não
 *     existe (NOT_FOUND, fail-closed);
 *   - toda mutação exige `comment` (motivo auditado) e gera `correlation_id`;
 *   - toda mutação é rate-limited e auditada em `admin_audit_log` com o ATOR;
 *   - o browser NUNCA recebe o bootstrap token — ele não participa deste fluxo.
 *
 * O QR/código nunca aparecem em URL: `getPairingStatus` os devolve no CORPO
 * de uma resposta `no-store`, decifrados aqui a partir do envelope AES-GCM
 * que o runtime gravou.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { assertRateLimit } from '../rate-limit.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';
import {
  openPairingMaterial,
  isPairingMaterialConfigured,
} from '../../../setup/pairing-material.js';

const MethodSchema = z.enum(['qr', 'code']);

const ScopeInputSchema = z.object({
  tenantId: z.string().optional(),
  agentId: z.string(),
});

const LineInputSchema = ScopeInputSchema.extend({
  channelId: z.string().uuid(),
});

const StartPairingInputSchema = LineInputSchema.extend({
  method: MethodSchema,
  /**
   * Chave de idempotência da TENTATIVA (§7 da issue). Repetir o start com a
   * mesma chave devolve a sessão existente; uma chave diferente com pairing
   * vivo recebe CONFLICT.
   */
  idempotencyKey: z.string().uuid(),
  comment: z.string().min(10).max(1000),
});

const MutationInputSchema = LineInputSchema.extend({
  comment: z.string().min(10).max(1000),
});

/** Limites: pareamento abre socket WhatsApp — poucos, e por canal. */
const START_RULE = { max: 5, windowMs: 5 * 60_000 };
const MUTATION_RULE = { max: 20, windowMs: 5 * 60_000 };
/** Leitura é POLLING (a UI acompanha o QR): generosa, mas não infinita. */
const STATUS_RULE = { max: 240, windowMs: 60_000 };

export const channelLinesRouter = router({
  /**
   * Todos os canais do agente — ATIVOS E INATIVOS. A tela antiga usava
   * `listActive`, e como um canal WhatsApp nasce inativo ("declarado"), ele
   * SUMIA da listagem logo após ser criado. Aqui ele permanece visível com o
   * seu estado operacional.
   */
  list: protectedProcedure.input(ScopeInputSchema).query(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const lines = await ctx.repos.channelLineStateRepo.listLinesForScope({
      tenant_id: tenantId,
      agent_id: input.agentId,
    });

    // Política por canal na MESMA resposta (mesmo contrato do
    // `channelsOverview`, mas cobrindo também os canais inativos, que são
    // justamente os que precisam de CTA). N é o número de linhas do agente —
    // uma unidade, não uma listagem paginada.
    const withPolicy = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => {
        const roles = await ctx.repos.rolesRepo.listActive();
        const roleKeyById = new Map(roles.map((r) => [r.id, r.role_key]));
        return Promise.all(
          lines.map(async (line) => {
            const policy = await ctx.repos.channelPoliciesRepo.getByChannelId(line.channel_id);
            // `roleKeyById` só tem papéis ATIVOS: uma política cujo papel
            // padrão foi desativado tem `has_policy` mas NÃO está pronta.
            const defaultRoleKey = policy
              ? (roleKeyById.get(policy.default_role_id) ?? null)
              : null;
            return {
              ...line,
              has_policy: policy !== null,
              default_role_key: defaultRoleKey,
              policy_ready: policy !== null && defaultRoleKey !== null,
            };
          }),
        );
      },
    );

    return {
      lines: withPolicy,
      /**
       * Sem keyring o pareamento pelo console não pode acontecer (o material
       * só trafega cifrado). A UI mostra o estado mesmo assim e explica o que
       * falta, em vez de estourar no meio da listagem.
       */
      pairing_available: isPairingMaterialConfigured(),
    };
  }),

  /**
   * Estado da tentativa corrente + material de pareamento DECIFRADO.
   *
   * O material sai daqui no corpo da resposta (a rota tRPC responde
   * `Cache-Control: no-store`) e nunca em URL. Se o envelope expirou ou não
   * abre, devolvemos `material: null` — jamais conteúdo parcial.
   */
  getPairingStatus: protectedProcedure
    .input(LineInputSchema)
    .query(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      const tenantId = resolveTenantId(ctx, input.tenantId);
      assertRateLimit(`lines:status:${ctx.userId}`, STATUS_RULE);

      const scope = {
        tenant_id: tenantId,
        agent_id: input.agentId,
        channel_id: input.channelId,
      };
      const line = await ctx.repos.channelLineStateRepo.getForScope(scope);
      if (!line) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Linha não encontrada neste tenant/agente' });
      }
      const state = await ctx.repos.channelLineStateRepo.getStateForScope(scope);

      let material: { kind: 'qr'; png_data_uri: string } | { kind: 'code'; code: string } | null =
        null;
      const notExpired =
        state?.pairing_material_expires_at !== null &&
        state?.pairing_material_expires_at !== undefined &&
        state.pairing_material_expires_at.getTime() > Date.now();
      if (state?.pairing_material && notExpired) {
        try {
          material = openPairingMaterial(state.pairing_material);
        } catch {
          // Chave rotacionada/removida ou envelope corrompido: a UI pede para
          // repetir o pareamento. Nada do envelope é logado.
          material = null;
        }
      }

      return {
        state: line.state,
        method: line.pairing_method,
        attempts: line.pairing_attempts,
        reason_code: line.reason_code,
        pairing_expires_at: line.pairing_expires_at,
        material_expires_at: notExpired ? (state?.pairing_material_expires_at ?? null) : null,
        pending_command: line.command,
        active: line.active,
        verified_at: line.verified_at,
        connected_at: line.connected_at,
        material,
      };
    }),

  /**
   * Pede ao runtime que abra a PairingSession (QR ou código). O console não
   * fala com o Baileys: enfileira o comando com o ATOR administrativo em
   * `channel_line_state` (103) e o worker `channel_pairing` executa.
   */
  startPairing: protectedProcedure
    .input(StartPairingInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      const tenantId = resolveTenantId(ctx, input.tenantId);
      assertRateLimit(`lines:start:${ctx.userId}:${input.channelId}`, START_RULE);

      if (!isPairingMaterialConfigured()) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'Pareamento pelo console indisponível: configure MAIA_STAGING_KEYRING e ' +
            'MAIA_STAGING_ACTIVE_KEY_ID (o QR/código só trafega cifrado).',
        });
      }

      const scope = {
        tenant_id: tenantId,
        agent_id: input.agentId,
        channel_id: input.channelId,
      };
      const line = await ctx.repos.channelLineStateRepo.getForScope(scope);
      if (!line) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Linha não encontrada neste tenant/agente' });
      }
      if (line.channel_type !== 'whatsapp') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Só canais WhatsApp são pareados por posse de linha',
        });
      }
      if (line.active) {
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            'A linha já está ativa. Peça re-pareamento (encerra a posse atual) antes de parear de novo.',
        });
      }

      const correlationId = randomUUID();
      const result = await ctx.repos.channelLineStateRepo.requestCommand({
        scope,
        command: 'start_pairing',
        method: input.method,
        command_id: input.idempotencyKey,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        correlation_id: correlationId,
      });
      if (!result.ok) {
        throw new TRPCError({
          code: result.reason === 'channel_not_found' ? 'NOT_FOUND' : 'CONFLICT',
          message:
            result.reason === 'pairing_in_progress'
              ? 'Já existe um pareamento em curso para esta linha. Cancele antes de repetir.'
              : 'Linha não encontrada neste tenant/agente',
        });
      }

      // Idempotente: o replay da MESMA chave não gera novo audit (a operação
      // não aconteceu de novo).
      if (!result.idempotent) {
        await ctx.repos.adminAuditLogRepo.append({
          tenant_id: tenantId,
          actor_id: ctx.userId,
          actor_role: ctx.userRole,
          action: 'channel_pairing_requested',
          resource_type: 'channel',
          resource_id: input.channelId,
          // NUNCA QR, código, token ou auth state — só metadata operacional.
          change_summary: {
            agent_id: input.agentId,
            method: input.method,
            correlation_id: correlationId,
            idempotency_key: input.idempotencyKey,
            attempt: result.row.pairing_attempts,
            reason: input.comment,
          },
        });
      }

      return {
        queued: true,
        idempotent: result.idempotent,
        correlation_id: correlationId,
        expires_at: result.row.pairing_expires_at,
      };
    }),

  /** Cancela o pareamento. Idempotente: repetir não é erro. */
  abortPairing: protectedProcedure
    .input(MutationInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      const tenantId = resolveTenantId(ctx, input.tenantId);
      assertRateLimit(`lines:mutate:${ctx.userId}`, MUTATION_RULE);

      const scope = {
        tenant_id: tenantId,
        agent_id: input.agentId,
        channel_id: input.channelId,
      };
      const result = await ctx.repos.channelLineStateRepo.requestCommand({
        scope,
        command: 'abort_pairing',
        command_id: randomUUID(),
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        correlation_id: randomUUID(),
      });
      if (!result.ok) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Linha não encontrada neste tenant/agente' });
      }

      await ctx.repos.adminAuditLogRepo.append({
        tenant_id: tenantId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        action: 'pairing_session_aborted',
        resource_type: 'channel',
        resource_id: input.channelId,
        change_summary: { agent_id: input.agentId, reason: input.comment },
      });
      return { aborted: true };
    }),

  /**
   * Desativa a linha: ela para de rotear imediatamente. Não apaga
   * credenciais — reativar exige re-pareamento explícito (`requestRepair` +
   * `startPairing`), que é o caminho auditado.
   */
  disable: protectedProcedure
    .input(MutationInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      const tenantId = resolveTenantId(ctx, input.tenantId);
      assertRateLimit(`lines:mutate:${ctx.userId}`, MUTATION_RULE);

      const scope = {
        tenant_id: tenantId,
        agent_id: input.agentId,
        channel_id: input.channelId,
      };
      const line = await ctx.repos.channelLineStateRepo.getForScope(scope);
      if (!line) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Linha não encontrada neste tenant/agente' });
      }

      // `channelsRepo.deactivate` é ALS-scoped por contrato; o triplete já foi
      // provado acima pelo `getForScope`.
      const deactivated = await runWithTenantContext(
        { tenant_id: tenantId, agent_id: input.agentId },
        async () => ctx.repos.channelsRepo.deactivate(input.channelId),
      );
      if (deactivated.rowCount === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Linha não encontrada neste tenant/agente' });
      }
      await ctx.repos.channelLineStateRepo.markDisabled(scope, 'operator_disabled');

      await ctx.repos.adminAuditLogRepo.append({
        tenant_id: tenantId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        action: 'channel_disabled',
        resource_type: 'channel',
        resource_id: input.channelId,
        change_summary: {
          agent_id: input.agentId,
          external_id: line.external_id,
          reason: input.comment,
        },
      });
      return { disabled: true };
    }),

  /**
   * Pede re-pareamento: o runtime encerra a posse da linha (desativa o canal
   * e remove APENAS `lines/<channel_id>`) e a devolve ao estado `declared`,
   * pronta para um novo `startPairing`. É o caminho para logout/recovery sem
   * shell.
   */
  requestRepair: protectedProcedure
    .input(MutationInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      const tenantId = resolveTenantId(ctx, input.tenantId);
      assertRateLimit(`lines:mutate:${ctx.userId}`, MUTATION_RULE);

      const scope = {
        tenant_id: tenantId,
        agent_id: input.agentId,
        channel_id: input.channelId,
      };
      const line = await ctx.repos.channelLineStateRepo.getForScope(scope);
      if (!line) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Linha não encontrada neste tenant/agente' });
      }
      if (line.channel_type !== 'whatsapp') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Re-pareamento só se aplica a linhas WhatsApp',
        });
      }

      const correlationId = randomUUID();
      const result = await ctx.repos.channelLineStateRepo.requestCommand({
        scope,
        command: 'repair',
        command_id: randomUUID(),
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        correlation_id: correlationId,
      });
      if (!result.ok) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Linha não encontrada neste tenant/agente' });
      }

      await ctx.repos.adminAuditLogRepo.append({
        tenant_id: tenantId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        action: 'channel_repair_requested',
        resource_type: 'channel',
        resource_id: input.channelId,
        change_summary: {
          agent_id: input.agentId,
          external_id: line.external_id,
          correlation_id: correlationId,
          reason: input.comment,
        },
      });
      return { queued: true, correlation_id: correlationId };
    }),
});
