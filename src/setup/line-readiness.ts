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
 * ─── Precondição ZERO: quem é o dono da ativação (re-review do PR #541) ──────
 * Antes de qualquer predicado de configuração, o gate pergunta se a ativação
 * desta linha pertence a ESTA máquina. Se houver uma run de onboarding VIVA
 * para o (tenant, agente), pertence à saga — o passo `activate` dela é o único
 * autorizado a ligar o canal, e o pareamento só prova posse. Ver
 * `line-activation-owner.ts` para o argumento completo.
 *
 * A regra é DETERMINÍSTICA e decidida no backend (invariante 3 do AGENTS.md),
 * e é a MESMA sequência que o go-live checklist do console já apresenta ao
 * operador — perfil ativo → canal registrado → papel + política prontos:
 *
 *   1. o AGENTE tem um perfil operacional ATIVO;
 *   2. o canal tem uma `channel_policy`;
 *   3. o `default_role_id` dessa política resolve para um papel ATIVO do
 *      mesmo (tenant, agent).
 *
 * Um papel padrão desativado é o caso sutil que o `has_policy` sozinho não
 * pega: a política existe, mas o canal não tem como escolher um papel — não
 * está pronto.
 *
 * O perfil operacional entrou na rodada 2 do review PR #528. O argumento
 * técnico é direto: a política escolhe o PAPEL, mas o perfil é quem define o
 * comportamento do agente; sem ele o slice de identidade devolve `null`
 * (`identity-slice-builder.ts`) e a linha entraria em roteamento para responder
 * sem identidade operacional aprovada. É a mesma precondição, e na mesma
 * ordem, que o console exige antes de declarar o agente pronto — o gate apenas
 * deixa de confiar em o operador ter seguido a lista.
 *
 * Tudo sob o ALS do (tenant, agent) DONO do canal: os três repos são
 * tenant-scoped e leriam o escopo errado sem o wrap.
 */
import { runWithTenantContext } from '@/db/tenant-context.js';
import { channelPoliciesRepo, rolesRepo } from '@/db/repositories/channel-repos.js';
import { operationalProfileVersionsRepo } from '@/db/repositories/profile-repos.js';
import { resolveLineActivationOwner } from './line-activation-owner.js';

export type LineReadiness =
  | { ready: true }
  | {
      ready: false;
      reason_code:
        | 'onboarding_saga_owns_activation'
        | 'missing_active_profile'
        | 'missing_policy'
        | 'default_role_inactive';
    };

export async function evaluateLineReadiness(channel: {
  id: string;
  tenant_id: string;
  agent_id: string;
}): Promise<LineReadiness> {
  return runWithTenantContext(
    { tenant_id: channel.tenant_id, agent_id: channel.agent_id },
    async () => {
      // (0) DONO DA ATIVAÇÃO — antes de qualquer predicado (re-review do
      // PR #541, achado 1).
      //
      // Este gate é a ÚNICA porta pela qual o maquinário de #518 ativa uma
      // linha: `startChannelPairing` o consulta no fim do pareamento e o
      // worker `channel_pairing` o consulta a cada minuto em
      // `promoteReadyVerifiedLines`. Pôr a pergunta aqui — e não só no
      // pareamento — é o que impede a segunda porta: sem isto, o pareamento
      // deixava de ativar e a varredura periódica ativava sessenta segundos
      // depois, com a run ainda em `channel_ready`.
      //
      // Não é `ready: false` por deficiência de configuração: a linha pode
      // estar impecável. É `ready: false` porque a DECISÃO não é desta
      // máquina. O reason_code diz isso em voz alta, e a UI de #518 já o
      // exibe como motivo de `channel_activation_deferred`.
      //
      // Não é beco sem saída: quando a saga chega em `activate`, ela ativa o
      // conjunto validado (`provisioning.ts`, `applyActivate`); se a run
      // terminar por cancelamento ou falha terminal, a posse volta para o
      // pareamento no tick seguinte, sem novo pareamento.
      const owner = await resolveLineActivationOwner({
        tenant_id: channel.tenant_id,
        agent_id: channel.agent_id,
      });
      if (owner.owner === 'onboarding_saga') {
        return {
          ready: false as const,
          reason_code: 'onboarding_saga_owns_activation' as const,
        };
      }

      // Ordem deliberada: o perfil é a precondição mais barata e a mais alta
      // na hierarquia — sem identidade operacional aprovada, discutir política
      // de canal é discutir o papel de um agente que não tem comportamento
      // definido. Re-checa `status` mesmo com `getActive` já filtrando, pelo
      // mesmo padrão defensivo de `identity-slice-builder.ts`.
      const profile = await operationalProfileVersionsRepo.getActive();
      if (!profile || profile.status !== 'active') {
        return { ready: false as const, reason_code: 'missing_active_profile' as const };
      }

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
