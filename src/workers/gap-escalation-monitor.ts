/**
 * P5 Task 9 — `gap-escalation-monitor` worker (a cada 30 min — cron a cada 30 minutos).
 *
 * Para cada tenant, abre tenant context, carrega as regras de escalada
 * (`gapEscalationRulesRepo.getForCurrentAgent`) com fallback para `DEFAULT_RULES`,
 * busca todos os gaps em níveis abertos (silent/dashboard/mentionable) e, para
 * cada um, consulta o engine determinístico (`decideEscalation` — Task 6).
 * Sempre que o engine devolve `changed:true`, persiste o novo nível via
 * `capabilityGapsRepo.updateLevel` e — só na transição para `proposed` —
 * dispara o `proposeCapabilityForGap` (Task 7) em fire-and-forget para não
 * bloquear o worker no LLM (Sonnet pode levar até 15s).
 *
 * Invariantes:
 *   - O engine continua sendo a ÚNICA fonte de decisão de escalada (sem LLM
 *     aqui — o LLM só roda DEPOIS, no proposer, em background).
 *   - Cooldown e contagem de distinct_contexts entram como input ao engine
 *     (worker NÃO toma decisão; só fornece os dados).
 *   - `distinct_contexts_count` neste P5 simplifica para 2 se `gap.contexto`
 *     existe, 1 caso contrário. (TODO P5.x: agregar de fato distinct contexts
 *     observados nas reflexões de origem; por ora gap.contexto é proxy.)
 *   - Erros do proposer NÃO derrubam o worker — capturados no .catch da
 *     promise fire-and-forget.
 */
import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  tenantsRepo,
  capabilityGapsRepo,
  gapEscalationRulesRepo,
} from '@/db/repositories.js';
import { decideEscalation } from '@/cognition/gap-escalation/engine.js';
import { DEFAULT_RULES } from '@/cognition/gap-escalation/types.js';
import { proposeCapabilityForGap } from '@/cognition/capability-proposer.js';
import { GapLevel } from '@/types/enums.js';
import type { GapEscalationRule } from '@/db/schema.js';

export async function runGapEscalationMonitor(): Promise<void> {
  const tenants = await tenantsRepo.list();
  let total_changed = 0;
  let total_proposed_triggered = 0;

  for (const t of tenants) {
    await runWithTenantContext({ tenant_id: t.id, agent_id: 'default' }, async () => {
      const customRules = await gapEscalationRulesRepo.getForCurrentAgent();
      const rules: GapEscalationRule =
        customRules ??
        ({
          id: '',
          tenant_id: t.id,
          agent_id: 'default',
          ...DEFAULT_RULES,
          created_at: new Date(),
          updated_at: new Date(),
        } as GapEscalationRule);

      const gaps = await capabilityGapsRepo.listByLevels([
        GapLevel.SILENT,
        GapLevel.DASHBOARD,
        GapLevel.MENTIONABLE,
      ]);
      const daysSinceLastProposed = await capabilityGapsRepo.daysSinceLastProposed();

      for (const gap of gaps) {
        // P5 simplification: distinct_contexts_count proxy = 2 if contexto present, else 1.
        // O engine usa esse valor apenas na transição mentionable -> proposed; antes
        // disso (silent/dashboard) o valor é irrelevante.
        const distinct_contexts_count =
          gap.contexto && gap.contexto.length > 0 ? 2 : 1;

        const decision = decideEscalation({
          gap,
          rules,
          distinct_contexts_count,
          days_since_last_proposed_in_tenant: daysSinceLastProposed,
        });

        if (!decision.changed) continue;

        await capabilityGapsRepo.updateLevel({
          id: gap.id,
          new_level: decision.new_level,
        });
        total_changed++;

        logger.info(
          {
            tenant_id: t.id,
            gap_id: gap.id,
            from: decision.current_level,
            to: decision.new_level,
            reason: decision.reason,
          },
          'gap_escalation.changed',
        );

        if (decision.new_level === GapLevel.PROPOSED) {
          // Fire-and-forget proposer — Sonnet pode demorar; o worker não bloqueia.
          // Eventuais erros são logados mas não propagam para a iteração.
          void proposeCapabilityForGap({
            gap: { ...gap, current_level: decision.new_level },
          })
            .then((r) => {
              if (r.ok) {
                logger.info(
                  { proposal_id: r.proposal_id, gap_id: gap.id },
                  'gap_escalation.proposal_created',
                );
              } else {
                logger.warn(
                  { gap_id: gap.id, reason: r.reason },
                  'gap_escalation.proposal_failed',
                );
              }
            })
            .catch((err) => {
              logger.error({ gap_id: gap.id, err }, 'gap_escalation.proposer_threw');
            });
          total_proposed_triggered++;
        }
      }
    });
  }

  logger.info({ total_changed, total_proposed_triggered }, 'gap_escalation_monitor.done');
}
