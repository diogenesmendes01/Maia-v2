/**
 * P5 Task 9 — `gap-escalation-monitor` worker (a cada 30 min — cron a cada 30 minutos).
 *
 * Para cada par (tenant_id, agent_id) com gaps em níveis abertos, abre tenant
 * context, carrega as regras de escalada
 * (`gapEscalationRulesRepo.getForCurrentAgent`) com fallback para `DEFAULT_RULES`,
 * busca todos os gaps em níveis abertos (silent/dashboard/mentionable) e, para
 * cada um, consulta o engine determinístico (`decideEscalation` — Task 6).
 *
 * Issue #323 (Phase 3) — per-agent fan-out, NÃO mais `agent_id:'default'`.
 *
 * BEFORE: o worker iterava `tenantsRepo.list()` e abria
 * `runWithTenantContext({ tenant_id, agent_id:'default' })` fixo. Dois
 * problemas: (1) no flip de `MAIA_REJECT_DEFAULT_LITERAL` o `getCurrentAgent()`
 * (chamado dentro de `getForCurrentAgent`/`listByLevels`) lançaria; e (2) só os
 * gaps do agent 'default' de cada tenant eram escalados — gaps de OUTROS agents
 * do tenant nunca subiam de nível nem disparavam o proposer (bug latente de
 * cobertura per-agent). `tenantsRepo.list()` ainda incluía `system`+`default`,
 * que sob o flip também lançariam.
 *
 * AFTER: enumera tuplas (tenant_id, agent_id) DISTINCT que têm pelo menos um
 * gap em nível aberto (silent/dashboard/mentionable) em `agent_capability_gaps`
 * (work-table fan-out — mesmo padrão de reflection-batch/outbound-messages-
 * sweeper, #240/#251/#292). Cada agent real com gaps abertos ganha seu próprio
 * pass; agents sem gaps abertos não aparecem (nada a escalar). `system`/
 * `default` não têm gaps seeded, então caem fora sem caso especial.
 * Fail-isolated por tupla: erro em um (tenant, agent) não derruba os demais.
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
import { inArray } from 'drizzle-orm';
import { logger } from '@/lib/logger.js';
import { db } from '@/db/client.js';
import { runWithTenantContext, getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import {
  capabilityGapsRepo,
  gapEscalationRulesRepo,
} from '@/db/repositories.js';
import { decideEscalation } from '@/cognition/gap-escalation/engine.js';
import { DEFAULT_RULES } from '@/cognition/gap-escalation/types.js';
import { proposeCapabilityForGap } from '@/cognition/capability-proposer.js';
import { GapLevel } from '@/types/enums.js';
import { agent_capability_gaps, type GapEscalationRule } from '@/db/schema.js';

type TenantAgentRow = { tenant_id: string; agent_id: string };

// Open levels the escalation engine can act on. A (tenant, agent) only has
// work if it owns at least one gap in one of these levels.
const OPEN_LEVELS = [GapLevel.SILENT, GapLevel.DASHBOARD, GapLevel.MENTIONABLE] as const;

/**
 * Issue #323 (Phase 3) — enumera tuplas (tenant_id, agent_id) DISTINCT que
 * têm pelo menos um gap em nível aberto. Roda OUTSIDE de qualquer tenant
 * context — é o dispatcher que decide em quais escopos rodar a escalada.
 *
 * Work-table fan-out (mesmo padrão de reflection-batch #240/#251 e
 * outbound-messages-sweeper #292): só agents com gaps abertos aparecem —
 * exatamente os que têm trabalho a fazer. `system`/`default` não têm gaps
 * seeded, então não entram no loop sem caso especial.
 *
 * Espelha o idioma `selectDistinct` de
 * `cognitiveCandidatesRepo.listPendingTenantPairsForType` (P83-C2). Usa o
 * índice `caps_gaps_level_idx (tenant_id, agent_id, current_level)`.
 */
async function listAgentsWithOpenGaps(): Promise<TenantAgentRow[]> {
  return db
    .selectDistinct({
      tenant_id: agent_capability_gaps.tenant_id,
      agent_id: agent_capability_gaps.agent_id,
    })
    .from(agent_capability_gaps)
    .where(inArray(agent_capability_gaps.current_level, [...OPEN_LEVELS]));
}

export async function runGapEscalationMonitor(): Promise<void> {
  const tuples = await listAgentsWithOpenGaps();
  let total_changed = 0;
  let total_proposed_triggered = 0;
  let agents_processed = 0;
  let agents_failed = 0;

  for (const { tenant_id, agent_id } of tuples) {
    try {
      await runWithTenantContext({ tenant_id, agent_id }, async () => {
        const customRules = await gapEscalationRulesRepo.getForCurrentAgent();
        const rules: GapEscalationRule =
          customRules ??
          ({
            id: '',
            tenant_id: getCurrentTenant(),
            agent_id: getCurrentAgent(),
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
              tenant_id,
              agent_id,
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
      agents_processed++;
    } catch (err) {
      // Fail-isolated por (tenant, agent): erro de um agent não interrompe o
      // loop — mirrors reflection-batch (#251) / outbound-messages-sweeper
      // (#292). Telemetria distingue via agents_failed/agents_processed.
      agents_failed++;
      logger.warn(
        {
          tenant_id,
          agent_id,
          err: (err as Error).message,
          stack: (err as Error).stack,
        },
        'gap_escalation_monitor.agent_failed',
      );
    }
  }

  logger.info(
    {
      tuples: tuples.length,
      agents_processed,
      agents_failed,
      total_changed,
      total_proposed_triggered,
    },
    'gap_escalation_monitor.done',
  );
}
