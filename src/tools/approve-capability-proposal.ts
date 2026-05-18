/**
 * approve_capability_proposal — P5 closure tool genérica. Delega ao
 * dispatcher por capability_type. Para holiday: cria holiday + invalida cache.
 *
 * Codex review #105 (high): materializa ANTES de transicionar. A ordem
 * antiga (transition → dispatch) deixava o proposal preso em `approved` se
 * o dispatch falhasse (payload malformado, INSERT duplicado, erro DB,
 * cross-tenant link, etc.). Como `approved` é terminal para o tool (linha
 * 36 bloqueia retry pelo path normal), isso deixava aprovações órfãs sem
 * materialização e sem caminho de recuperação.
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
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { capabilityProposalsRepo } from '@/db/repositories.js';
import { dispatchApproval } from '@/cognition/proposal-approval-handler.js';
import { FeatureFlagName } from '@/types/enums.js';

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
  required_actions: ['manage_calendar'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'update_meta',
  audit_action: 'capability_proposal_approved',
  feature_flag: FeatureFlagName.CALENDAR_V2,
  handler: async (args, ctx) => {
    const proposal = await capabilityProposalsRepo.getById(args.proposal_id);
    if (!proposal) throw new Error(`proposal not found: ${args.proposal_id}`);
    if (proposal.status !== 'submitted') {
      throw new Error(`proposal status is '${proposal.status}', cannot approve`);
    }

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
