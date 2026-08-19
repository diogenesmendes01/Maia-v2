import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { callLLM } from '@/lib/claude.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import { pendingQuestionsRepo } from '@/db/repositories.js';
import { withTx } from '@/db/client.js';
import { audit } from '@/governance/audit.js';
import { resolveAndDispatch } from './pending-resolver.js';
import {
  getTurnExecutionContext,
  turnOwnershipLost,
} from '@/runtime/turns/execution-context.js';
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
  /**
   * TERMINAL, e por um motivo diferente de todos os outros: a TENTATIVA perdeu
   * a posse do turno (lease vencida / takeover) enquanto o gate rodava.
   *
   * Issue #507, achado 1 da revisão do dono. Até aqui este caminho colapsava em
   * `{ kind: 'unresolved', reason: 'low_confidence' }` — deliberadamente, sob o
   * argumento de que "o guard do topo do ReAct lança logo em seguida". O
   * argumento estava errado no ponto que importa: entre `checkPendingFirst`
   * (`core.ts:879`) e `runReActLoop` (`core.ts:1586`) há ~700 linhas de
   * pipeline que o guard do ReAct não alcança — `captureInboundForOutreach`,
   * o grafo pre-turn com suas gravações de decisão/execução, e o Decision
   * Engine, que pode inclusive RESPONDER ao usuário num bloqueio.
   *
   * `cancelled` não é um desfecho de pendência: é a constatação de que este
   * turno não é mais nosso. O core reage encerrando a tentativa (sem concluir,
   * sem retry, sem `processada_em`) — quem tem a lease vigente decide o
   * desfecho.
   */
  | { kind: 'cancelled' }
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
    {
      name: 'pending-gate',
      triggered_by: 'sync_conditional',
      timeoutMs: 5000,
      // Issue #507 — segundo call site de LLM DENTRO do turno reivindicado
      // (`core.ts:837`, dentro do escopo aberto em `core.ts:578`). Mesmo
      // defeito do reasoner, em escala menor: perdida a lease durante estes 5s,
      // a chamada seguia paga até o fim e a row de auditoria dizia `success`.
      signal: getTurnExecutionContext()?.signal,
    },
    (signal) =>
      callLLM({
        workload: 'pending_gate',
        system,
        messages: [{ role: 'user', content: user }],
        max_tokens: 200,
        temperature: 0,
        pessoa_id: ctx?.pessoa_id,
        signal,
      }),
  );
  const res = gateResult.output;
  if (!res) {
    // Timeout/erro do classificador — fallback de segurança: trata como
    // não-resolvido. Caller (checkPendingFirst) converte null em
    // { kind: 'unresolved', reason: 'low_confidence' }.
    //
    // Issue #507 — um `status: 'cancelled'` (perda de posse) também chega aqui
    // como `null`, e isso continua correto: o CLASSIFICADOR não tem o que
    // dizer sobre a pendência. Quem distingue cancelamento de falha é
    // `checkPendingFirst`, logo após o await, olhando a posse do turno — e o
    // desfecho é `{ kind: 'cancelled' }`, não `unresolved`.
    //
    // (A revisão do dono derrubou o argumento anterior, que mandava o turno
    // seguir para o ReAct "cujo guard lança na hora": o guard só existe dentro
    // de `runReActLoop`, ~700 linhas de pipeline depois.)
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

  /**
   * Issue #507 (achado 1) — GUARD DE BOUNDARY, logo após o await.
   *
   * A pergunta não é "o classificador falhou?", é "este turno ainda é nosso?".
   * Por isso o guard vem ANTES do teste de `resolution` e vale também para o
   * classificador que respondeu com sucesso: uma resolução calculada com a
   * lease já perdida não pode virar `applyTx` — que cancela pendência, audita e
   * DESPACHA a ação proposta.
   *
   * A checagem é da posse (`turnOwnershipLost`), não do retorno do
   * classificador, de propósito: o classificador é injetável (DI de teste) e
   * amarrar o desfecho ao valor que ele devolve deixaria o limite de efeito à
   * mercê de um dublê. Fora de um turno reivindicado é NO-OP.
   */
  if (turnOwnershipLost()) return { kind: 'cancelled' };

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
