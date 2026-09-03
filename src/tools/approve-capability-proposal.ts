/**
 * approve_capability_proposal — P5 closure tool genérica. Delega ao
 * dispatcher por capability_type. Para holiday: cria holiday + invalida cache.
 *
 * Codex review #105 (high, round 1): materializa ANTES de transicionar. A
 * ordem antiga (transition → dispatch) deixava o proposal preso em
 * `approved` se o dispatch falhasse (payload malformado, INSERT duplicado,
 * erro DB, cross-tenant link, etc.). Como `approved` é terminal para o
 * tool (linha 36 bloqueia retry pelo path normal), isso deixava aprovações
 * órfãs sem materialização e sem caminho de recuperação.
 *
 * Nova ordem:
 *   1) Validar payload (holiday-handler usa `findByProposalId` p/ idempotência).
 *   2) Dispatch (materialização + cache invalidation).
 *   3) Transition submitted → approved.
 *
 * Se a materialização falhar, proposal permanece em `submitted` → tool
 * continua disponível para retry. Idempotência do handler garante que
 * uma materialização parcial bem-sucedida + falha tardia (ex.: depois do
 * INSERT, antes do link) seja recuperável: o segundo run reusa a row
 * existente via findByProposalId.
 *
 * Codex review #105 round-2 (high): autorização não pode ser entity-scoped
 * `manage_calendar`. O input só carrega `proposal_id`; o dispatcher resolve
 * `entity_id` via `args.entidade_id ?? scope.entidades[0]`, então um usuário
 * com `manage_calendar` em UMA entidade conseguia aprovar:
 *   (a) proposals tenant-level (tool/knowledge/procedure/integration/other)
 *   (b) holiday proposals para entidades FORA do seu escopo
 * desde que conhecesse o UUID. Fix: required_actions agora exige
 * `manage_capabilities` (global, separado de `manage_calendar`), e o handler
 * faz uma segunda checagem CADA proposal: para holiday, autoriza contra
 * `proposed_spec.entidade_id` com `manage_calendar`; para tenant-level
 * (sem entidade alvo), só passa quem tem `manage_capabilities` (que já foi
 * checado pelo dispatcher).
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { capabilityProposalsRepo } from '@/db/repositories.js';
import { dispatchApproval } from '@/cognition/proposal-approval-handler.js';
import { canAct } from '@/governance/permissions.js';
import type { HolidayDescriptorPayload } from '@/cognition/holiday-descriptor.js';

const inputSchema = z.object({
  proposal_id: z.string().uuid(),
  decision_reason: z.string().optional(),
});

const outputSchema = z.object({
  proposal_id: z.string(),
  status: z.string(),
  capability_type: z.string(),
  holiday_id: z.number().nullable(),
});

export const approveCapabilityProposalTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'approve_capability_proposal',
  description:
    'Aprova uma capability proposal pendente. Para holiday: cria o feriado na tabela. Para outros tipos: marca como aprovada (entrega depende do tipo).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['manage_capabilities'],
  side_effect: 'write',
  effect_class: 'idempotent',
  redis_required: false,
  operation_type: 'update_meta',
  audit_action: 'capability_proposal_approved',
  handler: async (args, ctx) => {
    const proposal = await capabilityProposalsRepo.getById(args.proposal_id);
    if (!proposal) throw new Error(`proposal not found: ${args.proposal_id}`);
    if (proposal.status !== 'submitted') {
      throw new Error(`proposal status is '${proposal.status}', cannot approve`);
    }

    // Codex review #105 round-2 (high): segunda checagem por proposta.
    // Para holiday com entidade alvo (entity_custom / holding_recess), o
    // approver precisa ter `manage_calendar` SOBRE essa entidade — não basta
    // o `manage_capabilities` checado pelo dispatcher contra `scope.entidades[0]`.
    if (proposal.capability_type === 'holiday') {
      const payload = proposal.proposed_spec as unknown as Partial<HolidayDescriptorPayload>;
      const targetEntidadeId = payload?.entidade_id;
      if (
        targetEntidadeId &&
        targetEntidadeId !== 'global' &&
        (payload?.type === 'entity_custom' || payload?.type === 'holding_recess')
      ) {
        if (!ctx.scope.entidades.includes(targetEntidadeId)) {
          throw new Error(
            `entidade alvo do proposal fora do escopo: ${targetEntidadeId}`,
          );
        }
        const resolved = ctx.scope.byEntity.get(targetEntidadeId);
        const allow = canAct({
          pessoa: ctx.pessoa,
          resolved: resolved ?? null,
          action: 'manage_calendar',
        });
        if (!allow.allowed) {
          throw new Error(
            `sem permissão manage_calendar na entidade alvo ${targetEntidadeId}: ${allow.reason}`,
          );
        }
      }
      // Para holiday national/state/municipal (sem entidade específica) ou
      // entidade_id="global", `manage_capabilities` (já checado pelo dispatcher)
      // é suficiente. Estes são tipos tenant-wide que afetam toda a base.
    }
    // Para tool/knowledge/procedure/integration/other (tenant-level capabilities)
    // a checagem `manage_capabilities` no dispatcher já é a autoridade — não
    // existe entidade alvo a refinar.

    const approverId = ctx.pessoa?.id ?? 'owner';

    // 1) Materializa primeiro. Se falhar, proposal segue 'submitted' e o
    // owner pode reaprovar. O handler é idempotente (findByProposalId).
    const result = await dispatchApproval(proposal, { approverId });

    // 2) Só transita para approved depois que a materialização sucedeu.
    const t = await capabilityProposalsRepo.transition({
      id: args.proposal_id,
      to: 'approved',
      decided_by: approverId,
      decision_reason: args.decision_reason,
    });
    if (!t.ok) {
      // Edge case: materialização ok mas transição falha (race com outro
      // approver, status mudou). Logamos via throw — o holiday já existe e
      // findByProposalId garante que o próximo retry vai retornar idempotent.
      throw new Error(`transition failed after materialization: ${t.reason}`);
    }

    return {
      proposal_id: args.proposal_id,
      status: 'approved',
      capability_type: proposal.capability_type,
      holiday_id: 'holiday_id' in result ? result.holiday_id : null,
    };
  },
};
