/**
 * P5 Task 7 — capability-proposer (Sonnet-based, ÚNICO módulo LLM do P5).
 *
 * Disparado pelo worker (Task 9) APENAS depois que o engine determinístico
 * (Task 6) eleva um gap ao nível PROPOSED. Gera spec técnica formal e persiste
 * em `capability_proposals` (status='draft'). A Maia propõe; o owner decide.
 *
 * Gates obrigatórios:
 *  1. featureFlags.isEnabled(DIALOGICAL_ACQUISITION) — sem flag, sem spend.
 *     Retorno: { ok:false, reason:'llm_unavailable', message:'flag_off' }.
 *  2. runCognitiveModule wrapper — timeout 15s, fallback=null, audit log
 *     em cognitive_module_log via triggered_by='async_event'.
 *
 * Mapping de erros para reason:
 *   - Anthropic throw / timeout → output=null  → 'parse_failed'
 *   - LLM responde sem JSON ou sem campos obrigatórios → null → 'parse_failed'
 *   - Repo throw                                       → 'repo_failed' + message
 *
 * IMPORTANTE: o proposer NÃO julga prioridade; só gera spec. Aprovação e
 * delivery vivem no fluxo de capability_proposals (state machine no repo).
 */
import Anthropic from '@anthropic-ai/sdk';
import { runCognitiveModule } from './runner.js';
import { capabilityProposalsRepo } from '@/db/repositories.js';
import type { CapabilityProposalType } from '@/db/repositories.js';
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';
import type { AgentCapabilityGap } from '@/db/schema.js';

export type ProposalDraft = {
  // P9a: união estendida — 'skill' habilitado para o capability-proposer
  // gerar drafts de Skill Contract via mesma rota. Owner aprova no Admin UI.
  capability_type: CapabilityProposalType;
  title: string;
  description: string;
  proposed_spec: Record<string, unknown>;
  motivation: string;
  expected_impact: string;
  test_scenarios: Array<{ name: string; given: string; when: string; then: string }>;
};

export type ProposeResult =
  | { ok: true; proposal_id: string; draft: ProposalDraft }
  | { ok: false; reason: 'llm_unavailable' | 'parse_failed' | 'repo_failed'; message?: string };

const PROPOSER_MODEL = 'claude-sonnet-4-6';
const PROPOSER_TIMEOUT_MS = 15000;

export async function proposeCapabilityForGap(args: {
  gap: AgentCapabilityGap;
  recent_evidence?: Array<{ context: string; created_at: Date }>;
}): Promise<ProposeResult> {
  // Flag gate — no Sonnet spend without governance active
  if (!featureFlags.isEnabled(FeatureFlagName.DIALOGICAL_ACQUISITION)) {
    return { ok: false, reason: 'llm_unavailable', message: 'flag_off' };
  }

  const draft = await runCognitiveModule<ProposalDraft | null>(
    {
      name: 'capability_proposer',
      timeoutMs: PROPOSER_TIMEOUT_MS,
      triggered_by: 'async_event',
      fallback: null,
    },
    async () => {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
      const system = [
        'Você é o agente analisando uma lacuna recorrente na sua capacidade.',
        'Proponha uma especificação técnica para resolver. Você propõe; o owner decide.',
        'Devolva JSON estrito com {capability_type, title, description, proposed_spec, motivation, expected_impact, test_scenarios}.',
        'capability_type é um de: tool, knowledge, procedure, integration, other.',
        'test_scenarios é array de objetos {name, given, when, then} (BDD).',
        'IMPORTANTE: NÃO inclua julgamento de prioridade. Apenas a spec técnica.',
      ].join('\n');

      const evidenceBlock = args.recent_evidence && args.recent_evidence.length > 0
        ? `EVIDÊNCIAS RECENTES:\n${args.recent_evidence.slice(0, 5).map((e) => `- ${e.context}`).join('\n')}`
        : '';

      const userParts = [
        `LACUNA: ${args.gap.capability_description}`,
        `TIPO PROVÁVEL: ${args.gap.tipo}`,
        `CONTEXTO RECORRENTE: ${args.gap.contexto ?? '(sem detalhe)'}`,
        `FREQUÊNCIA: ${args.gap.frequency_score} ocorrências`,
        `SEVERIDADE: ${args.gap.severity_score}/10`,
        evidenceBlock,
        'Devolva JSON estrito conforme estrutura definida.',
      ].filter((s) => s.length > 0);
      const user = userParts.join('\n\n');

      const completion = await anthropic.messages.create({
        model: PROPOSER_MODEL,
        max_tokens: 1500,
        system,
        messages: [{ role: 'user', content: user }],
      });

      const text = (completion.content as Array<{ type: string; text?: string }>)
        .filter(
          (c): c is { type: 'text'; text: string } =>
            c.type === 'text' && typeof c.text === 'string',
        )
        .map((c) => c.text)
        .join('');

      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;

      let parsed: ProposalDraft;
      try {
        parsed = JSON.parse(match[0]) as ProposalDraft;
      } catch {
        return null;
      }

      // Light validation: required keys present.
      if (
        !parsed.title ||
        !parsed.description ||
        !parsed.motivation ||
        !parsed.capability_type
      ) {
        return null;
      }
      return parsed;
    },
  );

  if (!draft.output) {
    // runCognitiveModule maps thrown error → status='error', timeout → 'timeout'.
    // Em ambos os casos output=null por causa do fallback. Tratamos genericamente
    // como 'parse_failed' (LLM não produziu spec utilizável) exceto timeout puro.
    const reason = draft.status === 'timeout' ? 'llm_unavailable' : 'parse_failed';
    return { ok: false, reason };
  }

  try {
    const proposal = await capabilityProposalsRepo.create({
      gap_id: args.gap.id,
      capability_type: draft.output.capability_type,
      title: draft.output.title,
      description: draft.output.description,
      proposed_spec: draft.output.proposed_spec,
      motivation: draft.output.motivation,
      expected_impact: draft.output.expected_impact,
      test_scenarios: draft.output.test_scenarios,
    });
    return { ok: true, proposal_id: proposal.id, draft: draft.output };
  } catch (e) {
    return {
      ok: false,
      reason: 'repo_failed',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
