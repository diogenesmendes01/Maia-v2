import type { ClassifiedCandidate, CognitiveEvent } from './types.js';
import {
  factsRepo,
  rulesRepo,
  cognitiveCandidatesRepo,
  memoryEntryRepo,
  behavioralHintRepo,
  capabilityGapsRepo,
} from '@/db/repositories.js';
import { logger } from '@/lib/logger.js';
import { classifyMemory } from './memory-classifier.js';
import { deriveBehavioralHint } from './behavioral-hint-deriver.js';
import { validateBehavioralHint } from '@/workers/behavioral-hint-validator.js';

/**
 * Persister — roteia ClassifiedCandidate para o destino correto:
 *
 *  - `fato`        → agent_facts (legacy upsert) + memory_entry (P2: classifica e
 *                    aplica 6 controls; se sensitive, deriva behavioral_hint
 *                    validado anti-vazamento)
 *  - `regra`       → learned_rules (create)
 *  - `procedimento`, `tool_request` → cognitive_candidates (fila)
 *  - `lacuna`      → cognitive_candidates (fila) + agent_capability_gaps (P2:
 *                    upsert que acumula frequency_score por descrição)
 *  - `descarte`    → log apenas
 *
 * Tenant/agent são preenchidos automaticamente pelo tenant-guard nos
 * repositories. Confianca de fato/regra usa default sensato quando ausente.
 *
 * Novos paths P2 (memory_entry / behavioral_hint / capability_gaps) são
 * aditivos e try/catch wrapped — falha neles NUNCA derruba o path legado.
 */
export async function persistCandidate(
  candidate: ClassifiedCandidate,
  event: CognitiveEvent,
): Promise<{ persisted_to: string; id?: string }> {
  switch (candidate.type) {
    case 'fato': {
      // Legacy: agent_facts (upsert por escopo+chave)
      // FatoCandidate scope: 'agent' | 'role' | 'conversation'.
      // agent_facts.escopo é text; mantemos o literal do candidato como escopo.
      const escopo = candidate.scope;
      const chave = slugKey(candidate.content);
      const fact = await factsRepo.upsert({
        escopo,
        chave,
        valor: { content: candidate.content, subject_id: candidate.subject_id ?? null },
        fonte: 'aprendido',
        // Deterministic — never from the LLM. P2+ will recompute from evidence.
        confianca: initialFactConfidence(),
      });

      // P2: classifica e persiste em memory_entry com 6 controls.
      // Try/catch wrapper — falha aqui não derruba o agent_facts.
      let memoryEntryId: string | undefined;
      try {
        const classified = await classifyMemory(candidate.content);
        if (classified) {
          const memEntry = await memoryEntryRepo.create({
            interlocutor_id: null,
            conversa_id: 'conversa_id' in event ? event.conversa_id : null,
            content: candidate.content,
            memory_type: classified.memory_type,
            scope_type: classified.scope_type,
            subject_id: candidate.subject_id ?? null,
            sensitivity: classified.sensitivity,
            proactive_use: classified.proactive_use,
            mention_allowed: classified.mention_allowed,
            ttl_days: classified.ttl_days,
            needs_review: false,
            source_event_id: null,
            expires_at: classified.ttl_days
              ? new Date(Date.now() + classified.ttl_days * 24 * 60 * 60 * 1000)
              : null,
          });
          memoryEntryId = memEntry.id;

          // Se sensível: deriva hint comportamental, valida anti-vazamento e
          // só persiste se validator aprovar. Tudo isolado em try/catch.
          if (classified.memory_type === 'sensitive') {
            try {
              const derived = await deriveBehavioralHint(candidate.content);
              if (derived) {
                const validation = await validateBehavioralHint(
                  derived.hint_text,
                  candidate.content,
                );
                if (validation.approved) {
                  await behavioralHintRepo.create({
                    scope_type: classified.scope_type,
                    subject_id: candidate.subject_id ?? null,
                    hint_text: derived.hint_text,
                    derived_from_memory_id: memEntry.id,
                    derived_sensitivity: derived.derived_sensitivity,
                    ttl_days: classified.ttl_days,
                    extension_reason: null,
                    extension_approved_by: null,
                    extension_approved_at: null,
                    expires_at: classified.ttl_days
                      ? new Date(Date.now() + classified.ttl_days * 24 * 60 * 60 * 1000)
                      : null,
                    revoked_at: null,
                  });
                } else {
                  logger.info(
                    { reason: validation.reason, memory_id: memEntry.id },
                    'persister.hint_rejected_by_validator',
                  );
                }
              }
            } catch (err) {
              logger.warn(
                { err: (err as Error).message },
                'persister.hint_derivation_failed',
              );
            }
          }
        }
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          'persister.memory_entry_persist_failed',
        );
      }

      return {
        persisted_to: memoryEntryId ? 'agent_facts+memory_entry' : 'agent_facts',
        id: fact?.id,
      };
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
    case 'lacuna': {
      // Legacy: enfileira em cognitive_candidates pra revisão.
      const row = await cognitiveCandidatesRepo.create({
        conversa_id: 'conversa_id' in event ? event.conversa_id : null,
        source_event_type: event.type,
        source_event_id: null,
        candidate_type: candidate.type,
        payload: candidate as unknown as Record<string, unknown>,
      });

      // P2: upsert em agent_capability_gaps acumulando frequency_score
      // por descrição. Falha aqui não derruba o cognitive_candidates.
      let gapPersisted = false;
      try {
        await capabilityGapsRepo.upsert({
          capability_description: candidate.capability_description,
          tipo: candidate.tipo,
          contexto: candidate.contexto,
          source_candidate_id: row.id,
        });
        gapPersisted = true;
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          'persister.capability_gap_upsert_failed',
        );
      }

      return {
        persisted_to: gapPersisted
          ? 'cognitive_candidates+capability_gaps'
          : 'cognitive_candidates',
        id: row.id,
      };
    }
    case 'procedimento':
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
 * NOTA: é um slug (lowercase + ASCII) truncado em 80 chars, NÃO um hash
 * criptográfico. Duas frases longas com prefixo idêntico podem colidir e
 * cair no mesmo upsert — comportamento esperado para fatos "morais"
 * equivalentes em P1. Se P2+ precisar de unicidade exata, trocar por sha256.
 * Prefixa com `p1.` pra distinguir da knowledge curada manualmente.
 */
function slugKey(content: string): string {
  const slug = content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return `p1.${slug || 'fact'}`;
}
