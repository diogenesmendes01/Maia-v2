import type { ClassifiedCandidate, CognitiveEvent } from './types.js';
import { factsRepo, rulesRepo, cognitiveCandidatesRepo } from '@/db/repositories.js';
import { initialFactConfidence, initialRuleConfidence } from './confidence.js';
import { logger } from '@/lib/logger.js';

/**
 * Persister — roteia ClassifiedCandidate para o destino correto:
 *
 *  - `fato`        → agent_facts (upsert por escopo+chave)
 *  - `regra`       → learned_rules (create)
 *  - `procedimento`, `lacuna`, `tool_request` → cognitive_candidates (fila)
 *  - `descarte`    → log apenas
 *
 * Tenant/agent são preenchidos automaticamente pelo tenant-guard nos
 * repositories.
 *
 * Invariante north-star: `confianca` para fato e regra é SEMPRE derivada
 * deterministicamente de evidência observável (ver `confidence.ts`).
 * NUNCA é lida do LLM. O classifier pode emitir `confianca_sugerida_llm`
 * mas é tratada como metadata e descartada aqui.
 */
export async function persistCandidate(
  candidate: ClassifiedCandidate,
  event: CognitiveEvent,
): Promise<{ persisted_to: string; id?: string }> {
  switch (candidate.type) {
    case 'fato': {
      // FatoCandidate scope: 'agent' | 'role' | 'conversation'.
      // agent_facts.escopo é text; mantemos o literal do candidato como escopo.
      const escopo = candidate.scope;
      const chave = hashKey(candidate.content);
      const fact = await factsRepo.upsert({
        escopo,
        chave,
        valor: { content: candidate.content, subject_id: candidate.subject_id ?? null },
        fonte: 'aprendido',
        // Deterministic — never from the LLM. P2+ will recompute from evidence.
        confianca: initialFactConfidence(),
      });
      return { persisted_to: 'agent_facts', id: fact?.id };
    }
    case 'regra': {
      // numeric() em Drizzle exige string; demais campos jsonb ganham default {}.
      // `candidate.confianca_sugerida_llm` is intentionally IGNORED here —
      // confidence comes from `confidence.ts` (deterministic, evidence-driven).
      const rule = await rulesRepo.create({
        tipo: candidate.tipo,
        contexto: candidate.contexto,
        acao: candidate.acao,
        contexto_jsonb: {},
        acoes_jsonb: {},
        confianca: String(initialRuleConfidence()),
        acertos: 0,
        erros: 0,
        ativa: true,
        exemplo_origem_id: null,
      });
      return { persisted_to: 'learned_rules', id: rule?.id };
    }
    case 'procedimento':
    case 'lacuna':
    case 'tool_request': {
      const row = await cognitiveCandidatesRepo.create({
        conversa_id: 'conversa_id' in event ? event.conversa_id : null,
        source_event_type: event.type,
        source_event_id: null,
        candidate_type: candidate.type,
        payload: candidate as unknown as Record<string, unknown>,
      });
      return { persisted_to: 'cognitive_candidates', id: row.id };
    }
    case 'descarte': {
      logger.info(
        { reason: candidate.reason, event_type: event.type },
        'persister.discarded',
      );
      return { persisted_to: 'log_only' };
    }
  }
}

/**
 * Gera uma chave determinística e curta a partir do conteúdo do fato.
 * Prefixa com `p1.` pra distinguir da knowledge curada manualmente.
 */
function hashKey(content: string): string {
  const slug = content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return `p1.${slug || 'fact'}`;
}
