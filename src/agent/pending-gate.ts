import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { callLLM } from '@/lib/claude.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import { pendingQuestionsRepo } from '@/db/repositories.js';
import { withTx } from '@/db/client.js';
import { audit } from '@/governance/audit.js';
import { resolveAndDispatch } from './pending-resolver.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';

export type GateResult =
  /** Não havia pendência aberta (ou o gate está desligado). O turno segue normal. */
  | { kind: 'no_pending' }
  /** A pendência foi resolvida por esta mensagem e a ação já foi despachada. */
  | { kind: 'resolved' }
  /**
   * TERMINAL. Esta mensagem já foi classificada como RESPOSTA à pendência e
   * perdeu a corrida para outra resposta que resolveu a mesma pendência.
   *
   * Por que não `{ kind: 'no_pending' }` — que é o que este caminho devolvia:
   * `no_pending` faz o core rodar o turno normal do agente, ou seja,
   * reinterpretar a mensagem como comando novo. Um "sim" que significava
   * "opção sim da pergunta X" vira entrada livre para o LLM, com significado
   * completamente diferente do que ela tinha — e só sob concorrência, que é
   * raro e difícil de reproduzir. O core conclui/marca o turno sem executar
   * ReAct (`concludeTurn(..., 'pending_race_lost')`).
   *
   * Reaproveitar a mensagem no futuro é possível, mas exige REAVALIAÇÃO
   * EXPLÍCITA contra o estado novo — nunca por colapso em `no_pending`.
   *
   * `stage` diz em qual das duas travessias do lock a corrida foi perdida:
   *   - `resolution`   — `resolveAndDispatch` recusou (a pendência esperada já
   *                      não é a ativa);
   *   - `cancellation` — a mensagem era um cancelamento explícito da pendência
   *                      e ela já tinha sumido.
   */
  | { kind: 'race_lost'; stage: 'resolution' | 'cancellation' }
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
  ctx?: { pessoa_id?: string },
) => Promise<ClassifyOut | null>;

let _classifier: Classifier;

async function haikuClassifier(
  snapshot: { pergunta: string; opcoes_validas: unknown },
  inbound: Mensagem,
  ctx?: { pessoa_id?: string },
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
  const gateResult = await runCognitiveModule(
    { name: 'pending-gate', triggered_by: 'sync_conditional', timeoutMs: 5000 },
    () =>
      callLLM({
        workload: 'pending_gate',
        system,
        messages: [{ role: 'user', content: user }],
        max_tokens: 200,
        temperature: 0,
        pessoa_id: ctx?.pessoa_id,
      }),
  );
  const res = gateResult.output;
  if (!res) {
    // Timeout/erro do classificador — fallback de segurança: trata como
    // não-resolvido. Caller (checkPendingFirst) converte null em
    // { kind: 'unresolved', reason: 'low_confidence' }.
    logger.warn(
      { status: gateResult.status },
      'pending_gate.classify_failed',
    );
    return null;
  }
  try {
    const text = res.content?.trim() ?? '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]) as ClassifyOut;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'pending_gate.parse_failed');
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
  const resolution = await _classifier(snapshot, input.inbound, { pessoa_id: input.pessoa.id });
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
    return await withTx(async (tx): Promise<GateResult> => {
      const locked = await pendingQuestionsRepo.findActiveForUpdate(tx, input.conversa.id);
      if (!locked || locked.id !== snapshot_id) {
        // Race PERDIDA também aqui: entre o snapshot e este lock, outra perna
        // resolveu/cancelou a mesma pendência (ou uma nova nasceu). Antes isto
        // colapsava em `{ kind: 'no_pending' }` — a mesma mentira do caminho de
        // resolução, e sem NENHUMA linha de auditoria: o gate tomava uma decisão
        // e não deixava rastro (invariante #4 do ARCHITECTURE.md).
        //
        // A auditoria é a mesma ação (`pending_race_lost`) do resolver, com
        // `stage` distinguindo por qual travessia do lock se passou. Não se
        // escreve `pending_cancelled`/`pending_unresolved_topic_change`: nada
        // foi cancelado, porque não havia mais o que cancelar.
        await audit({
          acao: 'pending_race_lost',
          pessoa_id: input.pessoa.id,
          conversa_id: input.conversa.id,
          mensagem_id: input.inbound.id,
          metadata: {
            pending_question_id: snapshot_id,
            source: 'gate',
            stage: resolution.is_cancellation ? 'cancellation' : 'topic_change',
            observed_id: locked?.id ?? null,
          },
        });
        // Cancelamento e mudança de assunto divergem AQUI, de propósito.
        //
        // `cancellation` é terminal pelo mesmo motivo da resolução: a mensagem
        // ("cancela", "deixa pra lá") só significa alguma coisa AMARRADA à
        // pendência que já não existe. Solta, ela é um comando de cancelamento
        // sem alvo — e dar isso ao LLM é o risco que esta mudança fecha.
        //
        // `topic_change` NÃO é terminal, e não é omissão: o classificador
        // declarou que esta mensagem NÃO é resposta à pendência, é assunto
        // novo. O significado dela não muda com a race — não há reinterpretação
        // a evitar — e o caminho SEM race já devolve `unresolved/topic_change`,
        // que o core deixa seguir para o ReAct. Torná-la terminal faria a mesma
        // pergunta do usuário ser respondida ou descartada conforme um sorteio
        // de timing, e perderia em silêncio um pedido legítimo. O que estava
        // errado aqui era o `no_pending` (que mente sobre ter havido pendência)
        // e a ausência de auditoria — os dois corrigidos acima.
        return resolution.is_cancellation
          ? { kind: 'race_lost', stage: 'cancellation' }
          : { kind: 'unresolved', reason: 'topic_change' };
      }
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

  // `resolveAndDispatch` recusou: a pendência esperada já não é a ativa. Ele já
  // auditou `pending_race_lost` DENTRO da transação que segurava o lock — este
  // retorno só propaga o desfecho para o core, que conclui o turno sem ReAct.
  if (!result.resolved) return { kind: 'race_lost', stage: 'resolution' };
  return { kind: 'resolved' };
}
