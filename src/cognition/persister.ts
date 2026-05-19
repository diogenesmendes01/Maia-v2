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
import { initialFactConfidence, initialRuleConfidence } from './confidence.js';
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';
import { KnowledgeStateMachine } from '@/control-plane/knowledge-state-machine/index.js';
import {
  getCurrentTenant,
  getCurrentAgent,
} from '@/db/tenant-context.js';

/**
 * Origin of a `persistCandidate` call. Codex round-2 finding 1:
 * legacy reflection paths could create active knowledge by hitting
 * the table-default `lifecycle_status='active'`, bypassing the new
 * risk scorer + pending_review gate.
 *
 *   - `llm`    → reflector/classifier/react-loop (LLM-derived).
 *                MUST route through KSM when the flag is on, MUST refuse
 *                an `active` initial status.
 *   - `worker` → batch/pattern-detector/conversation-summarizer.
 *                Same constraints as `llm`.
 *   - `user`   → explicit human-driven write from a tool handler.
 *                Routes through KSM with `origin='user_explicit'` —
 *                eligible for ephemeral when conf>=0.6 but never `active`.
 *   - `admin`  → human-approved promotion. Only origin allowed to write
 *                `active` rows directly through legacy repos (e.g. the
 *                Admin UI approve action).
 */
export type PersistOrigin = 'llm' | 'worker' | 'user' | 'admin';

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
 *
 * Codex round-2 finding 1: when the KSM feature flag is enabled and
 * `origin` is `'llm'` or `'worker'`, fato/regra writes are routed
 * through `KnowledgeStateMachine.propose()` so they're risk-scored and
 * land in `pending_review`/`ephemeral` instead of bypassing review with
 * the DB's `lifecycle_status='active'` default. `origin` defaults to
 * `'llm'` because every existing caller is a reflection path.
 */
export async function persistCandidate(
  candidate: ClassifiedCandidate,
  event: CognitiveEvent,
  origin: PersistOrigin = 'llm',
): Promise<{ persisted_to: string; id?: string }> {
  const ksmEnabled = featureFlags.isEnabled(
    FeatureFlagName.KNOWLEDGE_STATE_MACHINE_V1,
  );

  // Codex round-2 finding 1: LLM/worker writes that reach legacy repos
  // (which insert with `lifecycle_status='active'` by DB default) are
  // exactly the silent-corruption path the review flagged. When the
  // flag is enabled, route fact/rule proposals through the state
  // machine so risk scoring + pending_review apply.
  if (
    ksmEnabled &&
    (origin === 'llm' || origin === 'worker') &&
    (candidate.type === 'fato' || candidate.type === 'regra')
  ) {
    return persistViaKSM(candidate, event, origin);
  }

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
            // P10a: lifecycle columns (lifecycle_status/evidence_count/
            // confidence/lifecycle_transitions/last_recall_at) are populated
            // by DB defaults — the repo signature Omits them.
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
                    // P10a: lifecycle columns populated by DB defaults.
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
        // P10a: lifecycle columns populated by DB defaults.
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

/**
 * Codex round-2 finding 1 — KSM-routed persistence for `fato`/`regra`
 * candidates originating from the LLM or background workers. The
 * proposal lands in pending_review/ephemeral via the state machine, so
 * it CANNOT silently bypass review by hitting the DB-default
 * `lifecycle_status='active'`. We also assert here that the returned
 * initial status is never 'active' — fail loudly is safer than silent
 * corruption.
 */
async function persistViaKSM(
  candidate: ClassifiedCandidate,
  event: CognitiveEvent,
  origin: 'llm' | 'worker',
): Promise<{ persisted_to: string; id?: string }> {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  const conversa_id = 'conversa_id' in event ? event.conversa_id : undefined;
  // KSM expects an explicit KnowledgeOrigin — 'llm'/'worker' both map
  // to llm_inference (worker writes are still LLM-derived insights
  // produced offline).
  const ksm_origin = 'llm_inference' as const;
  const trace_id = `persister:${event.type}:${conversa_id ?? 'n/a'}`;

  if (candidate.type === 'fato') {
    // FatoCandidate.scope is 'agent'|'role'|'conversation'. Map to KSM
    // scope + preserve the legacy escopo string for the table-native
    // column so factsRepo reads can find the row after approval.
    const subject = candidate.subject_id ?? null;
    const ksmScope =
      candidate.scope === 'agent'
        ? 'agent'
        : candidate.scope === 'role'
          ? 'agent'
          : 'session';
    const legacyEscopo =
      candidate.scope === 'agent'
        ? subject
          ? `entidade:${subject}`
          : 'global'
        : candidate.scope;
    const chave = slugKey(candidate.content);

    const result = await KnowledgeStateMachine.propose({
      trace_id,
      tenant_id,
      agent_id,
      kind: 'fact',
      scope: ksmScope,
      ...(subject ? { scope_value: subject } : {}),
      key: chave,
      content: { content: candidate.content, subject_id: subject },
      content_text: candidate.content,
      confidence: initialFactConfidence(),
      origin: ksm_origin,
      source: `persister:${origin}`,
      native: {
        fact_escopo: legacyEscopo,
        fact_chave: chave,
      },
    });

    if (result.initial_status === 'active') {
      // Defensive — decideInitialStatus never returns 'active', but if
      // a future change accidentally let one through we refuse to honor
      // it. Bypass detection is the whole point of finding 1.
      throw new Error(
        `persister.ksm_returned_active_status_for_${origin}_origin`,
      );
    }

    logger.info(
      {
        kind: 'fact',
        proposal_id: result.proposal_id,
        initial_status: result.initial_status,
        origin,
      },
      'persister.ksm_routed',
    );

    return {
      persisted_to: `ksm:${result.initial_status}`,
      id: result.proposal_id,
    };
  }

  // The persistViaKSM gate filters to 'fato'|'regra'; the if-block
  // above handles 'fato', so this branch is exclusively RegraCandidate.
  if (candidate.type !== 'regra') {
    // Exhaustive — should be unreachable.
    throw new Error(
      `persister.persistViaKSM_unexpected_candidate_type:${String(candidate.type)}`,
    );
  }
  const regra = candidate;
  const result = await KnowledgeStateMachine.propose({
    trace_id,
    tenant_id,
    agent_id,
    kind: 'rule',
    scope: 'agent',
    key: regra.tipo,
    content: {
      tipo: regra.tipo,
      contexto: regra.contexto,
      acao: regra.acao,
    },
    content_text: `[${regra.tipo}] ${regra.contexto} -> ${regra.acao}`,
    confidence: initialRuleConfidence(),
    origin: ksm_origin,
    source: `persister:${origin}`,
    native: {
      rule_tipo: regra.tipo,
      rule_contexto: regra.contexto,
      rule_acao: regra.acao,
    },
  });

  if (result.initial_status === 'active') {
    throw new Error(
      `persister.ksm_returned_active_status_for_${origin}_origin`,
    );
  }

  // Rules always land in pending_review per master §2.6 — assert it so
  // any rule-policy regression surfaces immediately.
  if (result.initial_status !== 'pending_review') {
    logger.warn(
      {
        proposal_id: result.proposal_id,
        initial_status: result.initial_status,
      },
      'persister.rule_not_pending_review',
    );
  }

  logger.info(
    {
      kind: 'rule',
      proposal_id: result.proposal_id,
      initial_status: result.initial_status,
      tipo: regra.tipo,
      origin,
    },
    'persister.ksm_routed',
  );

  return {
    persisted_to: `ksm:${result.initial_status}`,
    id: result.proposal_id,
  };
}
