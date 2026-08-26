/**
 * Issue #628 (fatia E da #505) — O VARREDOR DO DEBOUNCE.
 *
 * ─── O que ele substitui, e por que a substituição é o ponto ──────────────
 *
 * Antes desta fatia, quem acordava a rajada era um job ATRASADO da BullMQ,
 * armado por `scheduleDebouncedAgent` com o prazo em `delay` e o estado da
 * janela numa chave do Redis. Isso tinha duas falhas que a issue nomeia:
 *
 *   1. o prazo era um `setTimeout` do lado do Redis. Duas réplicas com relógios
 *      levemente diferentes — ou duas que reprogramassem o job em corrida —
 *      podiam disparar sobre o MESMO conjunto de mensagens ou sobre conjuntos
 *      SOBREPOSTOS, porque não havia um ponto único onde "este batch fechou"
 *      pudesse ser afirmado uma vez só;
 *   2. um reinício entre o `add` e o disparo perdia a janela inteira: nada no
 *      PostgreSQL sabia que existia uma.
 *
 * Aqui o prazo é uma COLUNA e o fechamento é um compare-and-swap sob o mutex da
 * stream (ver `closeDueDebounceBatchTx`). Este worker é apenas o RELÓGIO DE
 * PAREDE: ele pergunta ao banco "quais janelas venceram?" e manda fechar. Ele
 * não decide nada. Duas instâncias dele rodando ao mesmo tempo não produzem
 * batch sobreposto — produzem `stream_locked` numa delas —, e uma instância que
 * morre não perde janela nenhuma: a próxima acha as mesmas linhas.
 *
 * ─── Por que DRENA DENTRO DO TICK ─────────────────────────────────────────
 *
 * O cron mais fino do node-cron é 1/min, e uma janela de debounce típica é de
 * 5 segundos: fechar só no tick tornaria a resposta até 60s mais lenta, o que
 * seria trocar uma correção de concorrência por uma regressão de produto.
 * Então o tick DRENA por ~50s, sondando a cada `IDLE_POLL_MS` quando não há
 * nada — o mesmo padrão de `playground_turn_drain` e de `outbox_drain`, e pela
 * mesma razão.
 *
 * O custo da sondagem é uma consulta ao índice parcial
 * `agent_turns_debounce_due_idx` (migration 130), que contém APENAS as janelas
 * abertas — dezenas de linhas, não o histórico. Ociosa, ela devolve zero linhas
 * lendo uma página de índice.
 *
 * ─── Por que ele é um DISPATCHER cross-tenant ─────────────────────────────
 *
 * `listDueDebounceStreams` roda FORA de contexto de tenant (é ele que descobre
 * QUEM tem trabalho), e cada fechamento roda DENTRO de
 * `runWithTenantContext` com o par da própria linha. É o mesmo desenho de
 * `message-recovery` desde a #345, e pela mesma razão: um worker que abrisse um
 * contexto fixo só varreria um tenant, e o defeito seria invisível numa
 * instalação single-tenant.
 *
 * Falha ISOLADA por stream: um erro numa não pode abortar as outras.
 */
import { agentTurnsRepo } from '@/db/repositories.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import { reportDebounceClose, transactionalDebounceEnabled } from '@/runtime/turns/index.js';

/**
 * Quanto tempo o tick drena. Abaixo do intervalo do cron (60s) de propósito: o
 * `running` já impede empilhamento, mas deixar folga garante que um tick que
 * estoure o orçamento por pouco não colida com o seguinte.
 */
const DRAIN_BUDGET_MS = 50_000;

/**
 * Sondagem quando não há janela vencida. 500ms é o ATRASO MÁXIMO que a fatia
 * acrescenta ao fechamento — o preço de tirar o prazo do Redis.
 *
 * Não é configurável de propósito: seria a quinta variável a governar o
 * debounce (`MESSAGE_DEBOUNCE_MS`, `MESSAGE_DEBOUNCE_MAX_MS`, a flag e o cron
 * já são quatro), e o número certo aqui não depende do negócio — depende do
 * custo de uma leitura de índice, que é o mesmo em toda instalação. Ver
 * `STUCK_AFTER_MS` em `message-recovery.ts`, constante pela mesma razão.
 */
const IDLE_POLL_MS = 500;

/** Quantas streams por rodada de enumeração. */
const MAX_STREAMS_POR_RODADA = 200;

let running = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param opts.budget_ms quanto tempo drenar. Omitido = `DRAIN_BUDGET_MS`.
 *
 * Existe como PARÂMETRO, e não como constante, por duas razões — e a segunda é
 * a que justifica: (a) o tick sempre faz PELO MENOS UMA passada, então
 * `budget_ms: 0` é "drene uma vez e volte", que é uma operação legítima
 * (o operador que quer fechar o backlog agora, sem segurar um processo por 50s);
 * (b) sem ela, a única forma de um teste exercer ESTE laço — o de produção —
 * seria esperar 50 segundos, e a alternativa (o teste chamar
 * `listDueDebounceStreams` + `closeDueDebounceBatch` à mão) provaria o harness,
 * não o worker.
 */
export async function runStreamDebounceCloser(opts: { budget_ms?: number } = {}): Promise<void> {
  // A flag é lida A CADA TICK, e não no import: um kill switch que só vale no
  // boot não é kill switch. Com ela OFF o worker é um no-op barato — nem sequer
  // consulta o banco —, e o debounce em memória volta a ser quem fecha.
  if (!transactionalDebounceEnabled()) return;
  if (running) return; // tick anterior ainda drenando — pular, nunca empilhar
  running = true;
  const deadline = Date.now() + (opts.budget_ms ?? DRAIN_BUDGET_MS);
  let fechados = 0;
  let visitadas = 0;
  // `do…while`: o tick faz PELO MENOS UMA passada, sempre. Com `while` puro e
  // orçamento zero (ou um relógio que já passou do prazo entre a entrada e a
  // primeira avaliação) o tick voltaria sem ter olhado o banco — um varredor
  // que às vezes não varre, e o "às vezes" seria invisível.
  try {
    do {
      const streams = await agentTurnsRepo.listDueDebounceStreams(MAX_STREAMS_POR_RODADA);
      if (streams.length === 0) {
        if (Date.now() >= deadline) break;
        await sleep(IDLE_POLL_MS);
        continue;
      }
      for (const { tenant_id, agent_id, stream_key } of streams) {
        visitadas++;
        try {
          // O RELATO roda DENTRO do mesmo contexto de tenant do fechamento, e
          // não depois dele: `audit()` deriva `tenant_id`/`agent_id` do ALS, e
          // uma `audit_log` escrita fora do contexto sairia atribuída a
          // `system` — isto é, a decisão de agrupar as mensagens de um cliente
          // ficaria invisível na trilha DELE, que é justamente onde alguém vai
          // procurá-la. O `enqueueAgent` segue junto pela mesma razão.
          const result = await runWithTenantContext({ tenant_id, agent_id }, async () => {
            const fechamento = await agentTurnsRepo.closeDueDebounceBatch({ stream_key });
            // Mede, audita e sinaliza o head. NUNCA lança — ver
            // `reportDebounceClose`.
            await reportDebounceClose(fechamento);
            return fechamento;
          });
          if (result.closed) fechados++;
        } catch (err) {
          // Fail-isolated por stream: um erro numa conversa não pode parar as
          // outras. A janela continua ABERTA e vencida, então a próxima rodada
          // tenta de novo — nada se perde, e um defeito persistente aparece
          // como esta linha repetindo, não como silêncio.
          logger.warn(
            {
              tenant_id,
              agent_id,
              err: (err as Error).message,
              stack: (err as Error).stack,
            },
            'stream_debounce_closer.stream_failed',
          );
        }
        if (Date.now() >= deadline) break;
      }
    } while (Date.now() < deadline);
  } finally {
    running = false;
  }
  if (visitadas > 0) {
    logger.info({ fechados, visitadas }, 'stream_debounce_closer.done');
  }
}
