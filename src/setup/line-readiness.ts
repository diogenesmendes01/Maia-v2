/**
 * Issue #518 §4 / review PR #528 (P1) — READINESS de roteamento de uma linha.
 *
 * Provar POSSE e estar PRONTA PARA ROTEAR são coisas diferentes, e o critério
 * de aceite da issue é explícito: "linha verificada só roteia após readiness".
 * Antes deste módulo, `startChannelPairing` chamava `activateVerified`
 * incondicionalmente: parear a linha de um agente sem política/papel deixava
 * `channels.active = true` e, com `MAIA_MULTI_LINE`, a sessão de roteamento
 * subia na hora — uma linha respondendo sem governança configurada.
 *
 * A regra é DETERMINÍSTICA e decidida no backend (invariante 3 do AGENTS.md),
 * e é a MESMA que o console já mostra como `policy_ready`:
 *
 *   1. o canal tem uma `channel_policy`;
 *   2. o `default_role_id` dessa política resolve para um papel ATIVO do
 *      mesmo (tenant, agent).
 *
 * Um papel padrão desativado é o caso sutil que o `has_policy` sozinho não
 * pega: a política existe, mas o canal não tem como escolher um papel — não
 * está pronto.
 *
 * O que NÃO é avaliado aqui, de propósito: perfil operacional ativo. Ele é
 * SoT de outro módulo, e a linha que já tem política + papel entrega uma
 * resposta governada. Ampliar o critério é uma decisão de produto, não uma
 * correção de bug — fica registrado como o próximo passo natural.
 */
import { runWithTenantContext } from '@/db/tenant-context.js';
import { channelPoliciesRepo, rolesRepo } from '@/db/repositories/channel-repos.js';

export type LineReadiness =
  | { ready: true }
  | { ready: false; reason_code: 'missing_policy' | 'default_role_inactive' };

export async function evaluateLineReadiness(channel: {
  id: string;
  tenant_id: string;
  agent_id: string;
}): Promise<LineReadiness> {
  return runWithTenantContext(
    { tenant_id: channel.tenant_id, agent_id: channel.agent_id },
    async () => {
      const policy = await channelPoliciesRepo.getByChannelId(channel.id);
      if (!policy) return { ready: false as const, reason_code: 'missing_policy' as const };
      const role = await rolesRepo.getById(policy.default_role_id);
      if (!role || !role.active) {
        return { ready: false as const, reason_code: 'default_role_inactive' as const };
      }
      return { ready: true as const };
    },
  );
}
