/**
 * P5 Task 9 — `gap-escalation-monitor` worker (a cada 30 min — cron a cada 30 minutos).
 *
 * Para cada tenant, abre tenant context, carrega as regras de escalada
 * (`gapEscalationRulesRepo.getForCurrentAgent`) com fallback para `DEFAULT_RULES`,
 * busca todos os gaps em níveis abertos (silent/dashboard/mentionable) e, para
 * cada um, consulta o engine determinístico (`decideEscalation` — Task 6).
 * Sempre que o engine devolve `changed:true`, persiste o novo nível via
 * `capabilityGapsRepo.updateLevel`. Para silent/dashboard/mentionable a
 * promoção é imediata; para a transição para `proposed`, o worker invoca o
 * `proposeCapabilityForGap` PRIMEIRO e só promove o gap se o proposer
 * retornar ok:true (atomicidade artifact-first, P87-C2 do review do PR #87).
 *
 * Invariantes:
 *   - O engine continua sendo a ÚNICA fonte de decisão de escalada (sem LLM
 *     aqui — o LLM só roda DEPOIS, no proposer).
 *   - Cooldown e contagem de distinct_contexts entram como input ao engine
 *     (worker NÃO toma decisão; só fornece os dados).
 *   - `distinct_contexts_count` neste P5 simplifica para 2 se `gap.contexto`
 *     existe, 1 caso contrário. (TODO P5.x: agregar de fato distinct contexts
 *     observados nas reflexões de origem; por ora gap.contexto é proxy.)
 *   - Erros do proposer NÃO derrubam o worker — runCognitiveModule absorve
 *     timeout/throw retornando { ok:false, reason }; o catch externo é
 *     defesa adicional.
 *   - Cooldown tenant-wide: a query DB é feita uma vez por tenant; após cada
 *     promoção bem-sucedida a `proposed` na mesma rodada, o sentinel local
 *     é forçado a 0 para impedir burst (P87-C4 do review).
 *   - Atomicidade artifact-first: gap só vira `proposed` quando já existe
 *     uma row em `capability_proposals`. Failures transient (repo_failed,
 *     parse_failed, llm_unavailable, throw) mantêm o gap em `mentionable`
 *     para retry no próximo tick — sem gaps órfãos em proposed sem artifact
 *     (P87-C2).
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
      let daysSinceLastProposed = await capabilityGapsRepo.daysSinceLastProposed();

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

        // P87-C2 + P87-C4 — split path por destino:
        //  * Para silent→dashboard e dashboard→mentionable: flip imediato
        //    (sem side-effect downstream).
        //  * Para mentionable→proposed: invoca o proposer ANTES do flip.
        //    Só se o proposer retornar ok:true (artifact persistido) é que o
        //    gap vira `proposed`. Em transient failure (repo_failed,
        //    parse_failed, llm_unavailable, throw), o gap permanece em
        //    `mentionable` e o próximo tick do worker re-tenta — sem órfão
        //    em proposed sem artifact.
        //  * Cooldown: ao confirmar uma promoção a `proposed`, força o
        //    daysSinceLastProposed local para 0 — defeito o burst em
        //    múltiplos gaps elegíveis na mesma rodada (P87-C4). Cooldown
        //    real é tenant-wide e a consulta DB foi feita uma vez no início
        //    da rodada; atualizar o sentinel local é a forma idiomática
        //    sem precisar de UPDATE atômico.
        if (decision.new_level !== GapLevel.PROPOSED) {
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
          continue;
        }

        // mentionable → proposed: tenta o proposer primeiro, espera o resultado.
        // Sonnet timeout/throw são absorvidos pelo runCognitiveModule (fallback=null)
        // dentro do proposer; aqui só observamos { ok, reason } estruturado.
        let proposeResult;
        try {
          proposeResult = await proposeCapabilityForGap({
            gap: { ...gap, current_level: decision.new_level },
          });
        } catch (err) {
          // Defesa adicional: mesmo que algo escape do runCognitiveModule,
          // não queremos derrubar a iteração do worker (continua com próximo gap).
          logger.error({ gap_id: gap.id, err }, 'gap_escalation.proposer_threw');
          proposeResult = { ok: false as const, reason: 'parse_failed' as const };
        }

        if (!proposeResult.ok) {
          // Sem artifact → não promove (gap permanece em mentionable e será
          // re-tentado no próximo tick). Cooldown NÃO é debitado porque
          // nenhuma proposal foi criada.
          logger.warn(
            { gap_id: gap.id, reason: proposeResult.reason },
            'gap_escalation.proposal_failed',
          );
          continue;
        }

        // Sucesso — agora sim promove o gap (atomic w.r.t. o artifact: já existe
        // a row em capability_proposals quando o nível vira proposed).
        await capabilityGapsRepo.updateLevel({
          id: gap.id,
          new_level: decision.new_level,
        });
        total_changed++;
        total_proposed_triggered++;

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
        logger.info(
          { proposal_id: proposeResult.proposal_id, gap_id: gap.id },
          'gap_escalation.proposal_created',
        );

        // P87-C4 — debit local cooldown so demais mentionable gaps deste tick
        // não atravessam a barreira proposed→proposed na mesma rodada.
        daysSinceLastProposed = 0;
      }
    });
  }

  logger.info({ total_changed, total_proposed_triggered }, 'gap_escalation_monitor.done');
}
