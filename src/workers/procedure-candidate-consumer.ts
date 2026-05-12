import { runWithTenantContext } from '@/db/tenant-context.js';
import { cognitiveCandidatesRepo, procedureDefinitionsRepo } from '@/db/repositories.js';
import { teachProcedure } from '@/cognition/procedure-builder.js';
import { logger } from '@/lib/logger.js';

/**
 * Consome cognitive_candidates tipo 'procedimento' e gera drafts em procedure_definitions.
 * P0-era single-tenant shim: roda em escopo do tenant 'default'.
 * P6 introduz iteração por tenant.
 */
export async function runProcedureCandidateConsumer(): Promise<void> {
  await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
    const candidates = await cognitiveCandidatesRepo.listPending('procedimento', 50);
    if (candidates.length === 0) {
      logger.info('procedure_candidate_consumer.idle');
      return;
    }

    let drafted = 0;
    let failed = 0;

    for (const candidate of candidates) {
      try {
        const payload = candidate.payload as {
          nome?: string;
          intencao?: string;
          passos_draft?: string[];
        };

        if (!payload?.nome || !payload?.passos_draft || payload.passos_draft.length === 0) {
          logger.warn({ candidate_id: candidate.id }, 'procedure_consumer.invalid_payload');
          await cognitiveCandidatesRepo.markConsumed(candidate.id, 'p3a-skipped-invalid');
          failed++;
          continue;
        }

        const descricao_livre = [
          payload.intencao ? `Intenção: ${payload.intencao}` : '',
          'Passos sugeridos:',
          ...payload.passos_draft.map((p, i) => `${i + 1}. ${p}`),
        ]
          .filter(Boolean)
          .join('\n');

        const draft = await teachProcedure({
          nome: payload.nome,
          descricao_livre,
          scope: 'agent',
          source: 'pratica',
        });

        if (!draft) {
          logger.warn({ candidate_id: candidate.id }, 'procedure_consumer.teach_returned_null');
          failed++;
          continue;
        }

        await procedureDefinitionsRepo.create({
          scope: draft.scope,
          owner_agent_id: 'default',
          nome: draft.nome,
          version_number: 1,
          status: 'draft',
          intencao: draft.intencao,
          when_apply: draft.when_apply as Record<string, unknown>,
          when_not_apply: draft.when_not_apply as Record<string, unknown>,
          steps: draft.steps as unknown as Record<string, unknown>,
          success_criteria: draft.success_criteria as unknown as Record<string, unknown>,
          failure_modes: draft.failure_modes as unknown as Record<string, unknown>,
          tools_referenced: draft.tools_referenced as unknown as Record<string, unknown>,
          source: 'pratica',
          proposed_by: null,
          approved_by: null,
          approved_at: null,
          activated_at: null,
          deactivated_at: null,
          source_candidate_id: candidate.id,
        } as any);

        await cognitiveCandidatesRepo.markConsumed(candidate.id, 'p3a-procedure-builder');
        drafted++;
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, candidate_id: candidate.id },
          'procedure_consumer.failed',
        );
        failed++;
      }
    }

    logger.info(
      { drafted, failed, total: candidates.length },
      'procedure_candidate_consumer.done',
    );
  });
}
