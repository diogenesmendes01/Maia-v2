/**
 * Dispatcher genérico de aprovação por capability_type. P5 fechou o data model
 * e o classifier-side; este dispatcher fecha o owner-side: dado um
 * CapabilityProposal aprovado, roteia para o handler específico do tipo.
 *
 * holiday → cria row em holidays + invalidação de cache.
 * tool/knowledge/procedure/integration/other → stub (logger.warn) até P5 fechar.
 */
import { approveHoliday } from './proposal-approval-handlers/holiday.js';
import { logger } from '@/lib/logger.js';
import type { CapabilityProposal } from '@/db/schema.js';

export type ApprovalResult =
  | { status: 'approved'; holiday_id: number; idempotent?: boolean }
  | { status: 'approved_no_op'; capability_type: string };

export async function dispatchApproval(
  proposal: CapabilityProposal,
  args: { approverId: string },
): Promise<ApprovalResult> {
  switch (proposal.capability_type) {
    case 'holiday':
      return await approveHoliday(proposal, args);
    case 'tool':
    case 'knowledge':
    case 'procedure':
    case 'integration':
    case 'other':
      logger.warn(
        { proposal_id: proposal.id, capability_type: proposal.capability_type },
        'proposal_approval.handler_not_implemented',
      );
      return { status: 'approved_no_op', capability_type: proposal.capability_type };
    default:
      throw new Error(`unknown capability_type: ${proposal.capability_type}`);
  }
}
