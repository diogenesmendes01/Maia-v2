/**
 * Dispatcher genérico de aprovação por capability_type. P5 fechou o data model
 * e o classifier-side; este dispatcher fecha o owner-side: dado um
 * CapabilityProposal aprovado, roteia para o handler específico do tipo.
 *
 * holiday → cria row em holidays + invalidação de cache.
 * tool/knowledge/procedure/integration/other → stub (logger.warn) até P5 fechar.
 *
 * #636 — `tool_request` NÃO é um stub à espera de implementação: ele é
 * TERMINAL por desenho. Aprovar um pedido de ferramenta significa "o dono
 * concorda que isto deveria virar uma tool" e mais nada. O guardrail da fatia A
 * da épica #471 é inegociável — **o agente especifica; humano implementa e
 * instala** —, então não existe, e não deve passar a existir, um handler que
 * transforme a aprovação em tool registrada, grant concedida ou código
 * executado. Tool nova segue o caminho normal: código revisado, contrato Zod,
 * classe de risco, aprovação. O `case` explícito abaixo existe para que isso
 * seja uma DECISÃO visível no dispatcher, e não o silêncio de cair no `default`.
 */
import { approveHoliday } from './proposal-approval-handlers/holiday.js';
import { logger } from '@/lib/logger.js';
import type { CapabilityProposal } from '@/db/schema.js';

export type ApprovalResult =
  | { status: 'approved'; holiday_id: number; idempotent?: boolean }
  | { status: 'approved_no_op'; capability_type: string }
  /**
   * #636 — o pedido de ferramenta aprovado. Estado distinto de
   * `approved_no_op` de propósito: `approved_no_op` quer dizer "ainda não há
   * handler"; este quer dizer "não HAVERÁ handler, e isso é o desenho".
   * Colapsar os dois faria alguém, um dia, implementar o handler que falta.
   */
  | { status: 'acknowledged_for_humans'; capability_type: 'tool_request' };

export async function dispatchApproval(
  proposal: CapabilityProposal,
  args: { approverId: string },
): Promise<ApprovalResult> {
  switch (proposal.capability_type) {
    case 'holiday':
      return await approveHoliday(proposal, args);
    case 'tool_request':
      // NADA é instalado, registrado ou executado aqui. Ver o cabeçalho.
      logger.info(
        { proposal_id: proposal.id, approved_by: args.approverId },
        'proposal_approval.tool_request_acknowledged',
      );
      return { status: 'acknowledged_for_humans', capability_type: 'tool_request' };
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
