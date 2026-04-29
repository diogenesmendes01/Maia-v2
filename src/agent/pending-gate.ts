import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { callLLM } from '@/lib/claude.js';
import { pendingQuestionsRepo } from '@/db/repositories.js';
import { withTx } from '@/db/client.js';
import { audit } from '@/governance/audit.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';

export type GateResult =
  | { kind: 'no_pending' }
  | {
      kind: 'resolved';
      action?: { tool: string; args: Record<string, unknown> };
      option_chosen: string;
      pending_question_id: string;
    }
  | { kind: 'unresolved'; reason: 'low_confidence' | 'topic_change' | 'cancelled' };

const CONFIDENCE_THRESHOLD = 0.7;

type ClassifyOut = {
  resolves_pending: boolean;
  option_chosen?: string;
  confidence: number;
  is_topic_change?: boolean;
  is_cancellation?: boolean;
};

/**
 * Classifier dependency-injection. Default = Haiku-backed implementation.
 * Tests override via setClassifierForTesting() to make resolution deterministic.
 */
export type Classifier = (
  snapshot: { pergunta: string; opcoes_validas: unknown },
  inbound: Mensagem,
) => Promise<ClassifyOut | null>;

let _classifier: Classifier;

async function haikuClassifier(
  snapshot: { pergunta: string; opcoes_validas: unknown },
  inbound: Mensagem,
): Promise<ClassifyOut | null> {
  const opts = snapshot.opcoes_validas as Array<{ key: string; label: string }>;
  const system =
    'Você classifica uma resposta do usuário a uma pergunta pendente. ' +
    'Retorne APENAS JSON: {"resolves_pending":bool,"option_chosen":string|null,"confidence":number,' +
    '"is_topic_change":bool,"is_cancellation":bool}. ' +
    'option_chosen deve ser uma das KEYS abaixo (não a label).';
  const user =
    `Pergunta: ${snapshot.pergunta}\n` +
    `Opções: ${opts.map((o) => `${o.key} (${o.label})`).join(', ')}\n` +
    `Resposta do usuário: ${inbound.conteudo ?? ''}`;
  try {
    const res = await callLLM({
      system,
      messages: [{ role: 'user', content: user }],
      max_tokens: 200,
      temperature: 0,
    });
    const text = res.content?.trim() ?? '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]) as ClassifyOut;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'pending_gate.classify_failed');
    return null;
  }
}

_classifier = haikuClassifier;

export function setClassifierForTesting(c: Classifier | null): void {
  _classifier = c ?? haikuClassifier;
}

export async function checkPendingFirst(input: {
  pessoa: Pessoa;
  conversa: Conversa;
  inbound: Mensagem;
}): Promise<GateResult> {
  if (!config.FEATURE_PENDING_GATE) return { kind: 'no_pending' };

  // Step 1: snapshot read (no lock, no tx)
  let snapshot;
  try {
    snapshot = await pendingQuestionsRepo.findActiveSnapshot(input.conversa.id);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'pending_gate.snapshot_failed');
    return { kind: 'no_pending' };
  }
  if (!snapshot) return { kind: 'no_pending' };

  // Step 2: classify (OUTSIDE the lock)
  const resolution = await _classifier(snapshot, input.inbound);
  if (!resolution) return { kind: 'unresolved', reason: 'low_confidence' };

  // Step 3 + 4 (Task 9 fills this in)
  return await applyTx(snapshot.id, snapshot, resolution, input);
}

async function applyTx(
  snapshot_id: string,
  snapshot: { acao_proposta: unknown; opcoes_validas: unknown },
  resolution: ClassifyOut,
  input: { pessoa: Pessoa; conversa: Conversa; inbound: Mensagem },
): Promise<GateResult> {
  return await withTx(async (tx) => {
    const locked = await pendingQuestionsRepo.findActiveForUpdate(tx, input.conversa.id);
    if (!locked || locked.id !== snapshot_id) {
      // Race lost — someone else resolved or cancelled while Haiku was running.
      await audit({
        acao: 'pending_race_lost',
        pessoa_id: input.pessoa.id,
        conversa_id: input.conversa.id,
        mensagem_id: input.inbound.id,
        metadata: { pending_question_id: snapshot_id },
      });
      return { kind: 'no_pending' as const };
    }

    // Explicit cancellation and "user moved to a different topic" are both
    // reasons to drop the pending, but they're product-distinct: cancellation
    // is intentional ("não, deixa pra lá"), topic change is implicit ("ah,
    // outra coisa: …"). Use distinct cancel reasons + audit actions so the
    // log can answer "was this question abandoned or cancelled?" later.
    if (resolution.is_cancellation) {
      await pendingQuestionsRepo.cancelTx(tx, snapshot_id, 'cancelled');
      await audit({
        acao: 'pending_unresolved_cancelled',
        pessoa_id: input.pessoa.id,
        conversa_id: input.conversa.id,
        mensagem_id: input.inbound.id,
        alvo_id: snapshot_id,
      });
      return { kind: 'unresolved' as const, reason: 'cancelled' as const };
    }
    if (resolution.is_topic_change) {
      await pendingQuestionsRepo.cancelTx(tx, snapshot_id, 'topic_change');
      await audit({
        acao: 'pending_unresolved_topic_change',
        pessoa_id: input.pessoa.id,
        conversa_id: input.conversa.id,
        mensagem_id: input.inbound.id,
        alvo_id: snapshot_id,
      });
      return { kind: 'unresolved' as const, reason: 'topic_change' as const };
    }

    const opts = snapshot.opcoes_validas as Array<{ key: string; label: string }>;
    const validKeys = new Set(opts.map((o) => o.key));
    const isResolved =
      resolution.resolves_pending &&
      resolution.confidence >= CONFIDENCE_THRESHOLD &&
      typeof resolution.option_chosen === 'string' &&
      validKeys.has(resolution.option_chosen);

    if (!isResolved) {
      await audit({
        acao: 'pending_unresolved_low_confidence',
        pessoa_id: input.pessoa.id,
        conversa_id: input.conversa.id,
        mensagem_id: input.inbound.id,
        alvo_id: snapshot_id,
        metadata: { confidence: resolution.confidence ?? null },
      });
      return { kind: 'unresolved' as const, reason: 'low_confidence' as const };
    }

    await pendingQuestionsRepo.resolveTx(tx, snapshot_id, {
      option_chosen: resolution.option_chosen,
      confidence: resolution.confidence,
    });
    await audit({
      acao: 'pending_resolved_by_gate',
      pessoa_id: input.pessoa.id,
      conversa_id: input.conversa.id,
      mensagem_id: input.inbound.id,
      alvo_id: snapshot_id,
      metadata: { option_chosen: resolution.option_chosen },
    });

    const action = (snapshot.acao_proposta ?? {}) as {
      tool?: string;
      args?: Record<string, unknown>;
    };
    return {
      kind: 'resolved' as const,
      action: action.tool ? { tool: action.tool, args: action.args ?? {} } : undefined,
      option_chosen: resolution.option_chosen!,
      pending_question_id: snapshot_id,
    };
  });
}
