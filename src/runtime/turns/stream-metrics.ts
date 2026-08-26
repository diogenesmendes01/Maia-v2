/**
 * Issue #626 (fatia C da #505) — as séries do escalonamento por stream, e a
 * razão de existir um módulo para três contadores.
 *
 * ─── O problema: um contador que nunca sobe não existe ────────────────────
 *
 * O critério de pronto da issue é literal: "`maia_stream_fifo_violation_total`
 * existe e é sempre zero". `src/lib/metrics.ts` cria a série na PRIMEIRA
 * incrementação — então uma métrica que (corretamente) nunca é incrementada
 * simplesmente não aparece em `/metrics`. Um alerta escrito contra ela nunca
 * dispara, e não por estar tudo bem: por não haver série. É a forma mais
 * silenciosa de um alerta falhar, e ela se parece exatamente com sucesso.
 *
 * `registrarSeriesDeStream()` resolve isso semeando cada combinação de labels
 * em ZERO no import. Depois disso "0" é uma afirmação — "medimos, e não houve
 * violação" — em vez de uma ausência.
 *
 * ─── Por que aqui e não em `lease.ts` ─────────────────────────────────────
 *
 * Quem DETECTA a violação de FIFO é o repositório (o canário roda no
 * `RETURNING` do claim, dentro da transação), e `turn-repos.ts` é compartilhado
 * com o console: ele não pode alcançar `src/config/env.js` (#596). Este módulo
 * importa só `@/lib/metrics.js` e o vocabulário PURO de `claim.ts`, então serve
 * aos dois lados sem arrastar o boot de nenhum serviço.
 *
 * ─── Por que a semeadura NÃO é um efeito de topo ──────────────────────────
 *
 * A primeira versão chamava `registrarSeriesDeStream()` no escopo do módulo, e
 * isso quebrou TRÊS specs alheias — `turn-repos.ts` importa este arquivo, e um
 * `vi.mock('@/lib/metrics.js')` com fábrica hoisted vê o `incCounter` mockado
 * ser CHAMADO durante o próprio import, antes de a variável da fábrica existir
 * (`Cannot access 'incCounterMock' before initialization`). O arquivo inteiro
 * deixa de carregar, e o vermelho aponta para um teste que não tem nada a ver.
 *
 * A regra que isso ensina: um módulo importado por um repositório não pode ter
 * efeito no import. Quem semeia é o ponto de boot da observabilidade
 * (`registerRuntimeObservability`, src/observability/register.ts), como todo
 * coletor deste repositório.
 */
import { incCounter } from '@/lib/metrics.js';
import {
  STREAM_BLOCKED_REASONS,
  STREAM_FIFO_VIOLATION_STAGES,
  STREAM_PROMOTION_RESULTS,
  type StreamBlockedReason,
  type StreamFifoViolationStage,
  type StreamPromotionResult,
} from './claim.js';

/**
 * Violações de FIFO detectadas. **Sempre zero** — a issue-mãe lista
 * `fifo_violation_total > 0` entre os critérios de ABORTAR o rollout, ao lado
 * de violação de isolamento.
 */
export const STREAM_FIFO_VIOLATION_METRIC = 'maia_stream_fifo_violation_total';

/**
 * Quantas vezes a fila da conversa segurou um claim. **Não** é zero em operação
 * saudável: cada mensagem que chega enquanto a anterior é processada conta um
 * ponto, e isso é a exclusão funcionando. O que se vigia é a FORMA — um
 * `not_head` que cresce sem `eligible` correspondente é uma stream que parou.
 */
export const STREAM_BLOCKED_METRIC = 'maia_stream_blocked_total';

/**
 * #627 — desfechos da promoção do sucessor. A issue-mãe a lista entre as séries
 * sugeridas (`maia_stream_promotion_total{result}`) e a #627 a exige cobrindo
 * "promoção, rejeição por fence e recuperação".
 *
 * Semeada em zero como as demais, e aqui isso importa mais do que nas outras:
 * `fence_rejected` e `recovered` são séries que, numa instalação saudável,
 * podem passar semanas em zero — e uma série ausente é indistinguível de
 * "nunca aconteceu" para todo alerta escrito contra ela.
 */
export const STREAM_PROMOTION_METRIC = 'maia_stream_promotion_total';

let semeado = false;

/**
 * Semeia todas as séries em zero. Idempotente e sem I/O — pode ser chamada no
 * escopo de módulo.
 *
 * Não é "opcional para testes": `_resetForTests()` de `src/lib/metrics.ts` apaga
 * o mapa inteiro, então uma spec que reseta e depois afirma "a série existe"
 * precisa semear de novo. Por isso a função é exportada e idempotente em vez de
 * ser um efeito de topo anônimo.
 */
export function registrarSeriesDeStream(): void {
  if (semeado) return;
  semeado = true;
  for (const stage of STREAM_FIFO_VIOLATION_STAGES) {
    incCounter(STREAM_FIFO_VIOLATION_METRIC, { stage }, 0);
  }
  for (const reason of STREAM_BLOCKED_REASONS) {
    incCounter(STREAM_BLOCKED_METRIC, { reason }, 0);
  }
  for (const result of STREAM_PROMOTION_RESULTS) {
    incCounter(STREAM_PROMOTION_METRIC, { result }, 0);
  }
}

/** Só para teste: permite semear de novo depois de `_resetForTests()`. */
export function _resetSeedForTests(): void {
  semeado = false;
}

/**
 * Uma violação de FIFO foi DETECTADA. Nunca deveria acontecer; quando acontece,
 * o estágio diz onde a regra falhou (ver `STREAM_FIFO_VIOLATION_STAGES`).
 *
 * Sem `stream_key`, `turn_id` nem conteúdo como label — a issue-mãe proíbe
 * explicitamente, e `turn_id` derrubaria a cardinalidade do Prometheus antes de
 * dizer qualquer coisa. A identificação do turno vive no log estruturado.
 */
export function recordStreamFifoViolation(stage: StreamFifoViolationStage): void {
  registrarSeriesDeStream();
  incCounter(STREAM_FIFO_VIOLATION_METRIC, { stage });
}

/** A fila da stream segurou um claim, e por quê. */
export function recordStreamBlocked(reason: StreamBlockedReason): void {
  registrarSeriesDeStream();
  incCounter(STREAM_BLOCKED_METRIC, { reason });
}

/**
 * Um desfecho de PROMOÇÃO foi observado (#627).
 *
 * Sem `stream_key`, `turn_id` nem conteúdo como label — a issue-mãe proíbe, e
 * `turn_id` derrubaria a cardinalidade do Prometheus antes de dizer qualquer
 * coisa. QUEM foi promovido (e por quem) vive na `audit_log` `turn_promoted` e
 * no log estruturado, onde a cardinalidade não custa.
 */
export function recordStreamPromotion(result: StreamPromotionResult): void {
  registrarSeriesDeStream();
  incCounter(STREAM_PROMOTION_METRIC, { result });
}
