import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { callLLM } from '@/lib/claude.js';
import { pendingQuestionsRepo } from '@/db/repositories.js';
import { withTx } from '@/db/client.js';
import { audit } from '@/governance/audit.js';
import { resolveAndDispatch } from './pending-resolver.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';

export type GateResult =
  | { kind: 'no_pending' }
  | { kind: 'resolved' }
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

  return await applyTx(snapshot.id, snapshot, resolution, input);
}

async function applyTx(
  snapshot_id: string,
  snapshot: { acao_proposta: unknown; opcoes_validas: unknown },
  resolution: ClassifyOut,
  input: { pessoa: Pessoa; conversa: Conversa; inbound: Mensagem },
): Promise<GateResult> {
  // Topic change / explicit cancellation short-circuit without touching
  // resolveAndDispatch — that helper is for SUCCESSFUL resolutions only.
  // Both audit actions (pending_cancelled, pending_unresolved_topic_change)
  // already exist in the closed taxonomy from prior PRs.
  if (resolution.is_topic_change || resolution.is_cancellation) {
    const reason = resolution.is_cancellation ? 'cancelled' : 'topic_change';
    const cancel_reason = resolution.is_cancellation ? 'user_cancelled' : 'topic_change';
    const audit_acao =
      resolution.is_cancellation ? 'pending_cancelled' : 'pending_unresolved_topic_change';
    return await withTx(async (tx) => {
      const locked = await pendingQuestionsRepo.findActiveForUpdate(tx, input.conversa.id);
      if (!locked || locked.id !== snapshot_id) return { kind: 'no_pending' };
      await pendingQuestionsRepo.cancelTx(tx, snapshot_id, cancel_reason);
      await audit({
        acao: audit_acao as never,
        pessoa_id: input.pessoa.id,
        conversa_id: input.conversa.id,
        mensagem_id: input.inbound.id,
        alvo_id: snapshot_id,
      });
      return { kind: 'unresolved', reason };
    });
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
    return { kind: 'unresolved', reason: 'low_confidence' };
  }

  const result = await resolveAndDispatch({
    pessoa: input.pessoa,
    conversa: input.conversa,
    mensagem_id: input.inbound.id,
    expected_pending_id: snapshot_id,
    option_chosen: resolution.option_chosen!,
    confidence: resolution.confidence,
    source: 'gate',
  });

  if (!result.resolved) return { kind: 'no_pending' };
  return { kind: 'resolved' };
}
