/**
 * P9a — Skill proposer detector.
 *
 * Detector dialógico (similar `procedure-builder` em P3) que escaneia
 * `cognitive_module_log` e propõe novos Skill Contracts via
 * `capability_proposals` (capability_type='skill'). Roda em batch async.
 *
 * Fluxo:
 *  1. (removido) PR #406: Skill Registry sempre habilitado — flag
 *     FEATURE_SKILL_REGISTRY_V1 removida, sem gate de feature flag.
 *  2. Determinístico — query agrupando registros por (module_name, status,
 *     output_summary_hash) nos últimos N dias. Pattern: ≥3 ocorrências do
 *     mesmo módulo + status=success + sem skill ativa correspondente.
 *  3. Para cada pattern detectado, gera draft via LLM e persiste como
 *     capability_proposal (status='draft').
 *
 * Princípios da master spec:
 *  - Determinístico antes do LLM (sem spam de calls)
 *  - Skill nasce em capability_proposals → owner approval → activate
 *  - Tenant guard implícito via repos
 */
import { runCognitiveModule } from './runner.js';
import { capabilityProposalsRepo, skillsRepo } from '@/db/repositories.js';
import { db } from '@/db/client.js';
import { cognitive_module_log } from '@/db/schema.js';
import { sql, and, eq, gte } from 'drizzle-orm';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';

export interface SkillProposerResult {
  proposed: number;
  skipped: number;
  patterns_found: number;
}

export interface SkillPattern {
  module_name: string;
  occurrences: number;
  suggested_descriptor: string;
  evidence_summary: string;
}

const MIN_PATTERN_OCCURRENCES = 3;

export async function detectAndProposeSkill(args: {
  window_days?: number;
}): Promise<SkillProposerResult> {
  const result = await runCognitiveModule<SkillProposerResult>(
    {
      name: 'skill_proposer_detector',
      triggered_by: 'async_event',
      timeoutMs: 60_000,
      fallback: { proposed: 0, skipped: 0, patterns_found: 0 },
    },
    async () => {
      const patterns = await scanForSkillPatterns({ window_days: args.window_days ?? 7 });
      let proposed = 0;
      let skipped = 0;

      for (const pattern of patterns) {
        // Skip if there's already an active skill matching the descriptor
        let existing = null;
        try {
          existing = await skillsRepo.findActive(pattern.suggested_descriptor);
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, descriptor: pattern.suggested_descriptor },
            'p9a.proposer.findActive_failed',
          );
        }
        if (existing) {
          skipped++;
          continue;
        }

        // Generate a minimal draft (LLM-generated specs come in P9a Phase 4 +
        // capability-proposer extension). For now, draft a stub that owner
        // refines in Admin UI.
        const draft = generateMinimalDraft(pattern);

        try {
          await capabilityProposalsRepo.create({
            capability_type: 'skill',
            title: draft.skill_descriptor,
            description: draft.goal,
            proposed_spec: draft as unknown as Record<string, unknown>,
            motivation: pattern.evidence_summary,
            expected_impact: draft.when_to_use,
            test_scenarios: [],
          });
          proposed++;
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, descriptor: draft.skill_descriptor },
            'p9a.proposer.persist_failed',
          );
          skipped++;
        }
      }

      return { proposed, skipped, patterns_found: patterns.length };
    },
  );

  return result.output ?? { proposed: 0, skipped: 0, patterns_found: 0 };
}

/**
 * Scan determinístico do `cognitive_module_log` em busca de módulos
 * recorrentes que poderiam virar skills. Retorna patterns ordenados por
 * `occurrences DESC`.
 *
 * Heurística simples: agrupa por module_name nos últimos N dias com
 * status='success'; descarta module_names que já são "skill:..." (já
 * são skills); mantém apenas grupos com ≥ MIN_PATTERN_OCCURRENCES.
 */
export async function scanForSkillPatterns(args: {
  window_days: number;
}): Promise<SkillPattern[]> {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  const cutoff = new Date(Date.now() - args.window_days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      module_name: cognitive_module_log.module_name,
      occurrences: sql<number>`COUNT(*)::int`,
    })
    .from(cognitive_module_log)
    .where(
      and(
        eq(cognitive_module_log.tenant_id, tenant_id),
        eq(cognitive_module_log.agent_id, agent_id),
        eq(cognitive_module_log.status, 'success'),
        gte(cognitive_module_log.created_at, cutoff),
      ),
    )
    .groupBy(cognitive_module_log.module_name);

  return rows
    .filter((r) => r.occurrences >= MIN_PATTERN_OCCURRENCES && !r.module_name.startsWith('skill:'))
    .map((r) => ({
      module_name: r.module_name,
      occurrences: r.occurrences,
      suggested_descriptor: r.module_name.replace(/[^a-z0-9_]/gi, '_').toLowerCase(),
      evidence_summary: `module ${r.module_name} executed ${r.occurrences}x in last ${args.window_days}d`,
    }))
    .sort((a, b) => b.occurrences - a.occurrences);
}

interface MinimalSkillDraft {
  skill_descriptor: string;
  category: string;
  execution_mode: string;
  goal: string;
  when_to_use: string;
  procedure: Record<string, unknown>;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
}

function generateMinimalDraft(pattern: SkillPattern): MinimalSkillDraft {
  return {
    skill_descriptor: pattern.suggested_descriptor,
    category: 'classify',
    execution_mode: 'prompt_only',
    goal: `Generated draft for repeating module ${pattern.module_name}`,
    when_to_use: `When the system would otherwise invoke ${pattern.module_name}`,
    procedure: { system_prompt: 'TODO: refined by owner via Admin UI' },
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  };
}
