/**
 * P5 Task 10 — notification adapter para gaps de capacidade.
 *
 * Aplica a invariante de §9 P5 do spec: o canal por onde o owner é (ou não)
 * notificado depende EXCLUSIVAMENTE do GapLevel atual. Em particular, gaps em
 * nível SILENT NUNCA notificam o owner — esse é o critério de aceitação
 * número 1 da fase P5 e a defesa explícita aqui é checada pelo gate #7
 * (grep por 'silent' neste arquivo).
 *
 * Mapa de níveis -> canais:
 *   - silent      -> none                 (apenas log de detector; sem visibilidade)
 *   - dashboard   -> dashboard            (lista visível no painel do owner)
 *   - mentionable -> dashboard            (idem; a Maia pode mencionar em resposta)
 *   - proposed    -> dashboard_plus_queue (idem + spec técnica enfileirada)
 *
 * O caso `proposed` enfileira via cognitive runner para que o evento async
 * seja auditado em cognitive_module_log (rastreabilidade).
 */
import { GapLevel } from '@/types/enums.js';
import { logger } from '@/lib/logger.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import type { AgentCapabilityGap } from '@/db/schema.js';

export type NotifyResult = {
  channel: 'none' | 'dashboard' | 'dashboard_plus_queue';
  notified: boolean;
};

export async function notifyOwnerForGap(args: {
  gap: AgentCapabilityGap;
}): Promise<NotifyResult> {
  const level = args.gap.current_level as GapLevel;

  // INVARIANTE P5 §9 (gate #7): silent JAMAIS notifica o owner.
  if (level === GapLevel.SILENT) {
    return { channel: 'none', notified: false };
  }

  if (level === GapLevel.DASHBOARD) {
    return { channel: 'dashboard', notified: true };
  }

  if (level === GapLevel.MENTIONABLE) {
    return { channel: 'dashboard', notified: true };
  }

  if (level === GapLevel.PROPOSED) {
    await runCognitiveModule(
      {
        name: 'owner_notification_proposed',
        triggered_by: 'async_event',
        timeoutMs: 1000,
        fallback: null,
      },
      async () => {
        logger.info(
          {
            gap_id: args.gap.id,
            capability_description: args.gap.capability_description,
            frequency_score: args.gap.frequency_score,
            severity_score: args.gap.severity_score,
          },
          'owner_notification.queued_for_proposed_gap',
        );
        return { queued: true };
      },
    );
    return { channel: 'dashboard_plus_queue', notified: true };
  }

  // Defesa: nível desconhecido cai como `none` (não vaza notificação).
  return { channel: 'none', notified: false };
}
