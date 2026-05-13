import { mensagensRepo, selfStateRepo } from '@/db/repositories.js';
import { writeMemory } from '@/memory/vector.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
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
      logger.info(
        { rule_id: persistResult.id, tipo: classified.tipo },
        'reflection.rule_created',
      );
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
  const escopo = input.scope_entidades.length > 0 ? `entidade:${input.scope_entidades[0]}` : 'global';
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
