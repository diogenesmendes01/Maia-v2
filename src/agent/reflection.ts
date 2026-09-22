import { mensagensRepo, selfStateRepo } from '@/db/repositories.js';
import { writeMemory } from '@/memory/vector.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
import { recordFailure } from '@/cognition/capability-tracker.js';
import { CognitiveEventType } from '@/types/enums.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';

const CORRECTION_HINTS = [
  /\bn[ãa]o\b/i,
  /\berrad/i,
  /\bcorrige/i,
  /\bn[ãa]o foi\b/i,
  /\b[ée] outr/i,
  /\bcancela\b/i,
];

export function detectCorrection(message: string): boolean {
  return CORRECTION_HINTS.some((re) => re.test(message));
}

/**
 * Reflete sobre uma correção do usuário.
 *
 * Em P1, esta função roteia pelo pipeline cognitivo novo:
 *   Reflector (gera insight bruto) → Classifier (tipa em 6 destinos) → Persister
 *   (grava no destino certo: facts/rules/candidates queue).
 *
 * O cognitive_module_log é emitido automaticamente pelo `runCognitiveModule`
 * dentro de Reflector e Classifier — não duplicamos aqui.
 *
 * Audit `rule_learned` é preservado quando o Classifier tipa como 'regra' e o
 * Persister grava em `learned_rules` (backward-compat com auditoria existente).
 *
 * `writeMemory` (vetorização) NÃO é chamado aqui — apenas em
 * `reflectOnWorkflowCompletion`, que continua intacto.
 */
export async function reflectOnCorrection(input: {
  pessoa: Pessoa;
  conversa: Conversa;
  inbound: Mensagem;
  previousAssistant: Mensagem | null;
}): Promise<void> {
  if (!input.previousAssistant) return;

  const event = {
    type: CognitiveEventType.USER_CORRECTION,
    conversa_id: input.conversa.id,
    inbound_mensagem_id: input.inbound.id,
    previous_assistant_mensagem_id: input.previousAssistant.id,
    correction_text: input.inbound.conteudo ?? '',
    previous_response_text: input.previousAssistant.conteudo ?? '',
  } as const;

  try {
    const reflected = await reflect(event, { pessoa_id: input.pessoa.id });
    if (!reflected || !reflected.insight) return;

    const classified = await classify(reflected.insight);
    if (!classified) return;

    const persistResult = await persistCandidate(classified, event);

    // Preserva audit existente quando uma regra é criada (compat retroativa).
    if (
      classified.type === 'regra' &&
      persistResult.persisted_to === 'learned_rules' &&
      persistResult.id
    ) {
      await audit({
        acao: 'rule_learned',
        pessoa_id: input.pessoa.id,
        conversa_id: input.conversa.id,
        mensagem_id: input.inbound.id,
        alvo_id: persistResult.id,
        metadata: { tipo: classified.tipo },
      });
      logger.info({ rule_id: persistResult.id, tipo: classified.tipo }, 'reflection.rule_created');
    }

    // P2 Task 14: update self-model on user correction. Domain extraction is
    // naive in P2 (default 'general'); P3+ refines via procedure context.
    // recordFailure swallows its own errors, but we still try/catch here so
    // even a thrown-from-import path can't break the reflection pipeline.
    try {
      await recordFailure({ domain: 'general', failure_mode: 'user_correction' });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'reflection.capability_tracker_failed');
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'reflection.failed');
  }
}

export async function reflectOnWorkflowCompletion(input: {
  workflow_id: string;
  pessoa_id: string;
  summary: string;
  scope_entidades: string[];
}): Promise<void> {
  // Append to self_state.resumo_aprendizados
  await selfStateRepo.appendLearning(input.summary).catch(() => undefined);
  // Vectorize for recall
  const escopo =
    input.scope_entidades.length > 0 ? `entidade:${input.scope_entidades[0]}` : 'global';
  // PR #775 finding 1 — DELIBERATELY unlinked, and this is the "report, don't
  // force" branch of that finding.
  //
  // `writeMemory` now accepts `memory_entry_id` so a vector can be joined to
  // its canonical `memory_entry` row (migration 146; enforced by the JOIN
  // fence in `recallAuthorized`, src/memory/recall-authorized.ts). This call
  // site is the only one left WITHOUT it, because this function has no
  // canonical item to link: it never creates a `memory_entry` row — the
  // workflow summary is written ONLY to `self_state.resumo_aprendizados`
  // (line above) and, here, straight to `agent_memories`. There's no
  // "write the vector after the canonical row" fix available without first
  // deciding whether workflow-completion summaries SHOULD become first-class
  // `memory_entry` items (own lifecycle_status, review gate, KSM routing,
  // etc.) — that's a product/architecture decision, not a plumbing fix, so
  // it's called out here instead of forced.
  //
  // Practically: this vector is written orphaned (`memory_entry_id` stays
  // NULL) and, like the pre-146 legacy rows, is permanently ineligible for
  // `recallAuthorized`. As of this PR, `reflectOnWorkflowCompletion` also has
  // no caller anywhere in `src/` (grep confirms), so nothing observable
  // regresses today — but wiring a caller later would silently reproduce the
  // "recall stays empty" bug finding 1 described unless this gap is closed
  // first.
  await writeMemory({
    conteudo: input.summary,
    tipo: 'reflexao',
    escopo,
    metadata: { workflow_id: input.workflow_id },
  }).catch((err) => logger.warn({ err: (err as Error).message }, 'reflection.vector_write_failed'));
  await audit({
    acao: 'reflection_completed',
    pessoa_id: input.pessoa_id,
    alvo_id: input.workflow_id,
  });
}

export async function findPreviousAssistantMessage(
  conversa_id: string,
  before_id: string,
): Promise<Mensagem | null> {
  // Window of 15 (was 5): a chunked-typing correction may follow ≥4 inbound
  // pieces, so the real previous-assistant message can sit further back.
  // Without enough lookback `reflectOnCorrection` exits early
  // (`if (!input.previousAssistant) return`) and the learning is lost.
  const recent = await mensagensRepo.recentInConversation(conversa_id, 15);
  for (const m of recent) {
    if (m.id === before_id) continue;
    if (m.direcao === 'out') return m;
  }
  return null;
}
