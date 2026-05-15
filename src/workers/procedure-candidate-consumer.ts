import { runWithTenantContext } from '@/db/tenant-context.js';
import { cognitiveCandidatesRepo, procedureDefinitionsRepo } from '@/db/repositories.js';
import { teachProcedureSafe } from '@/cognition/procedure-builder.js';
import { logger } from '@/lib/logger.js';

/**
 * Consome cognitive_candidates tipo 'procedimento' e gera drafts em
 * procedure_definitions.
 *
 * P83-C2 fix: iterates per (tenant_id, agent_id) pair that has pending
 * candidates and wraps each iteration in `runWithTenantContext`. The
 * previous shim ran in a fixed `default/default` context, which silently
 * stranded any tenant other than `default` and violated the tenant-isolation
 * invariant the moment a second tenant existed.
 */
export async function runProcedureCandidateConsumer(): Promise<void> {
  // Enumerate tenants/agents with pending procedure candidates. This call
  // intentionally runs outside of tenant context — it's the dispatcher.
  const pairs = await cognitiveCandidatesRepo.listPendingTenantPairsForType('procedimento');

  if (pairs.length === 0) {
    logger.info('procedure_candidate_consumer.idle');
    return;
  }

  let totalDrafted = 0;
  let totalFailed = 0;
  let totalCandidates = 0;

  for (const { tenant_id, agent_id } of pairs) {
    await runWithTenantContext({ tenant_id, agent_id }, async () => {
      const candidates = await cognitiveCandidatesRepo.listPending('procedimento', 50);
      if (candidates.length === 0) return;
      totalCandidates += candidates.length;

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
            logger.warn(
              { candidate_id: candidate.id, tenant_id, agent_id },
              'procedure_consumer.invalid_payload',
            );
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

          const result = await teachProcedureSafe({
            nome: payload.nome,
            descricao_livre,
            scope: 'agent',
            source: 'pratica',
          });

          if (!result.ok) {
            logger.warn(
              {
                candidate_id: candidate.id,
                tenant_id,
                agent_id,
                reason: result.reason,
                detail: result.detail,
              },
              'procedure_consumer.teach_failed',
            );
            failed++;
            continue;
          }

          const draft = result.draft;
          await procedureDefinitionsRepo.create({
            scope: draft.scope,
            owner_agent_id: agent_id,
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
          } as Parameters<typeof procedureDefinitionsRepo.create>[0]);

          await cognitiveCandidatesRepo.markConsumed(candidate.id, 'p3a-procedure-builder');
          drafted++;
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, candidate_id: candidate.id, tenant_id, agent_id },
            'procedure_consumer.failed',
          );
          failed++;
        }
      }

      totalDrafted += drafted;
      totalFailed += failed;

      logger.info(
        { drafted, failed, total: candidates.length, tenant_id, agent_id },
        'procedure_candidate_consumer.tenant_done',
      );
    });
  }

  logger.info(
    { drafted: totalDrafted, failed: totalFailed, total: totalCandidates, tenants: pairs.length },
    'procedure_candidate_consumer.done',
  );
}
