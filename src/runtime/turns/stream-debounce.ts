/**
 * Issue #628 (fatia E da #505) — a ÚNICA porta por onde um batch de debounce é
 * fechado e sinalizado.
 *
 * ─── A frase que este módulo torna estrutural ─────────────────────────────
 *
 * "**Nenhum timer em memória é fonte de verdade.**" A decisão de quando a
 * rajada fecha é uma linha do PostgreSQL (`agent_turns.debounce_deadline_at`,
 * migration 130), comparada com `now()` do BANCO dentro da transação que fecha.
 * Este módulo faz três coisas depois disso: mede, audita e bate na fila. Se a
 * batida falhar, nada se perde — o head fechado carrega `promoted_at`, e o
 * varredor de `message-recovery` fecha o buraco pelo caminho que a fatia D já
 * construiu (§12 do runbook).
 *
 * ─── Por que um módulo separado, e não duas linhas no worker ──────────────
 *
 * A mesma razão de `stream-promotion.ts`: `src/gateway/queue.ts` abre a conexão
 * `ioredis` NO IMPORT, então o `import` da fila é dinâmico e mora aqui, num
 * módulo que só é carregado quando existe fechamento de verdade a sinalizar.
 * E a mesma razão de sempre para os três fatos saírem juntos: métrica, log e
 * `audit_log` do MESMO evento em três callers é como um deles acaba sem
 * auditoria — e o que falta é sempre o do caminho raro.
 *
 * ─── Por que `incCounter`/`observeHistogram` CRUS, e não a camada de política ─
 *
 * A regra da #601 é que métrica de produção sai por `src/observability/metrics.ts`,
 * que ATRIBUI `tenant_id`/`agent_id` do ALS. Aqui não, e é a mesma decisão que
 * `stream-metrics.ts` (#626) tomou nesta mesma épica:
 *
 *   1. as duas séries descrevem o VARREDOR, não a carga de um cliente —
 *      "quantas janelas fecharam" e "de que tamanho" são perguntas de
 *      escalonamento, e cortá-las por tenant multiplica a cardinalidade sem
 *      responder nada que alguém pergunte;
 *   2. a SEMEADURA em zero (`registrarSeriesDeDebounce`) roda no boot, FORA de
 *      qualquer contexto de tenant. Se a emissão atribuísse, a série semeada
 *      (`{result="closed"}`) e a série real (`{result="closed",tenant_id=…}`)
 *      seriam SÉRIES DIFERENTES — e a semeadura, que existe para que um alerta
 *      possa ser escrito contra um contador que passa semanas em zero, deixaria
 *      de servir para exatamente isso.
 *
 * QUEM foi agrupado com quem vive na `audit_log` `stream_batch_closed`, que é
 * escopada por tenant e é armazenamento protegido.
 *
 * ─── A ORDEM: auditar, depois sinalizar ───────────────────────────────────
 *
 * A `audit_log` é o registro durável de que a plataforma DECIDIU agrupar estas
 * mensagens. Auditar depois do enqueue deixaria a janela em que o job existe e
 * nenhuma trilha explica de onde ele veio — que é exatamente a pergunta feita
 * durante um incidente. Idêntico a `signalStreamPromotion`, de propósito.
 */
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { incCounter, observeHistogram, registerHistogramBuckets } from '@/lib/metrics.js';
import {
  METRIC,
  STREAM_DEBOUNCE_CLOSE_RESULTS,
  closedVocabulary,
} from '@/observability/taxonomy.js';
import type { DebounceCloseResult } from '@/db/repositories/turn-repos.js';
import { contractEnv } from '@/config/contract-env.js';

/**
 * O debounce TRANSACIONAL está ligado?
 *
 * ESPELHO EXATO de `debouncePersistidoAtivo()` (turn-repos.ts), e a duplicação
 * é deliberada e estreita: o repositório NÃO pode importar deste módulo (ele é
 * compartilhado com o console `admin-ui`, e este arquivo alcança
 * `@/observability/taxonomy.js` e, pelo import dinâmico, a fila), e este módulo
 * não pode importar o predicado do repositório sem arrastar `../client.js` — o
 * `pg.Pool` construído no import — para dentro do varredor antes da hora.
 *
 * O que impede a divergência é `tests/unit/runtime/stream-debounce-contract.spec.ts`,
 * que lê os DOIS arquivos como texto e exige a mesma conjunção das três flags.
 * Um teste, e não um import, porque a fronteira do console (#596) é uma
 * restrição de arquitetura mais cara de violar do que esta linha de repetição.
 *
 * As três flags, e por que cada uma:
 *   - `FEATURE_TURN_STREAM_DEBOUNCE` — o kill switch da fatia;
 *   - `FEATURE_MESSAGE_DEBOUNCE` — sem debounce não há rajada a agrupar;
 *   - `FEATURE_TURN_HEAD_OF_LINE` — SEGURANÇA: o fechamento absorve os irmãos
 *     sem fence, e só pode porque um turno que não é o head é INCLAIMÁVEL.
 */
export function transactionalDebounceEnabled(): boolean {
  return (
    contractEnv.FEATURE_TURN_STREAM_DEBOUNCE &&
    contractEnv.FEATURE_MESSAGE_DEBOUNCE &&
    contractEnv.FEATURE_TURN_HEAD_OF_LINE
  );
}

/**
 * Os baldes de `maia_stream_debounce_batch_size`.
 *
 * Um batch tem entre 1 e uma dezena de mensagens. Os baldes padrão de
 * `src/lib/metrics.ts` são de MILISSEGUNDOS (50, 100, 250, …), então sem esta
 * declaração toda amostra cairia em `le="50"` e a série pareceria uma
 * distribuição sem separar nada — um `histogram_quantile()` devolveria um
 * número que parece medido e não é.
 *
 * O `1` como primeiro balde não é decoração: `le="1"` sobre o total é a fração
 * de rodadas em que o debounce NÃO agrupou nada, que é a única leitura que
 * responde "esta fatia está pagando por si?".
 */
const BALDES_DO_BATCH: readonly number[] = [1, 2, 3, 5, 10, 25, 50];

let semeado = false;

/**
 * Semeia as séries em zero e declara os baldes. Idempotente e sem I/O.
 *
 * Pela mesma razão de `registrarSeriesDeStream` (#626): `src/lib/metrics.ts`
 * cria a série na PRIMEIRA incrementação, então uma métrica que ainda não
 * aconteceu simplesmente não aparece em `/metrics` — e um alerta escrito contra
 * ela nunca dispara, não por estar tudo bem, mas por não haver série. É a forma
 * mais silenciosa de um alerta falhar, e ela se parece exatamente com sucesso.
 *
 * Exportada (e não um efeito de topo) porque `_resetForTests()` apaga o mapa
 * inteiro: uma spec que reseta e depois afirma "a série existe" precisa semear
 * de novo. E porque um módulo alcançado pelo grafo do repositório não pode ter
 * efeito no import — foi o que quebrou três specs alheias em #626.
 */
export function registrarSeriesDeDebounce(): void {
  registerHistogramBuckets(METRIC.STREAM_DEBOUNCE_BATCH_SIZE, BALDES_DO_BATCH);
  if (semeado) return;
  semeado = true;
  for (const result of STREAM_DEBOUNCE_CLOSE_RESULTS) {
    incCounter(METRIC.STREAM_DEBOUNCE_CLOSE, { result }, 0);
  }
}

/** Só para teste: permite semear de novo depois de `_resetForTests()`. */
export function _resetSeedForTests(): void {
  semeado = false;
}

/**
 * Registra o desfecho de UMA tentativa de fechamento e, quando fechou,
 * SINALIZA o head.
 *
 * ─── Por que NUNCA lança ──────────────────────────────────────────────────
 *
 * O caller é o varredor, e ele visita N streams por tick. Propagar uma falha de
 * Redis daqui abortaria a varredura das streams SEGUINTES por causa de uma —
 * transformando "esta conversa vai demorar um tick" em "nenhuma conversa
 * avança". O preço é explícito e medido: o log
 * `stream.batch_close_enqueue_failed` mais a dívida de `promoted_at` que o
 * varredor de recovery reconcilia.
 *
 * ─── Por que o fechamento NÃO é desfeito quando o enqueue falha ───────────
 *
 * Porque desfazê-lo seria pior. O batch fechado é um fato COMITADO: os irmãos
 * já são `superseded` e seus inputs já pertencem ao head. Reabrir a janela
 * exigiria ressuscitar turnos terminais — uma transição que o contrato proíbe,
 * e com razão. O estado "fechado e não sinalizado" é NORMAL e transitório, é
 * exatamente o que `promoted_at` existe para marcar, e o varredor o resolve.
 */
export async function reportDebounceClose(result: DebounceCloseResult): Promise<void> {
  registrarSeriesDeDebounce();
  if (!result.closed) {
    incCounter(METRIC.STREAM_DEBOUNCE_CLOSE, {
      result: closedVocabulary(result.reason, STREAM_DEBOUNCE_CLOSE_RESULTS),
    });
    return;
  }

  incCounter(METRIC.STREAM_DEBOUNCE_CLOSE, { result: 'closed' });
  observeHistogram(METRIC.STREAM_DEBOUNCE_BATCH_SIZE, result.batch_size);

  await audit({
    acao: 'stream_batch_closed',
    ...(result.head.conversa_id ? { conversa_id: result.head.conversa_id } : {}),
    alvo_id: result.head.turn_id,
    metadata: {
      batch_size: result.batch_size,
      absorbed_turn_ids: result.absorbed_turn_ids,
      status_before: result.head.status_before,
      status_after: result.head.status_after,
    },
  }).catch((err) =>
    logger.warn({ err: (err as Error).message }, 'stream.batch_closed_audit_failed'),
  );

  try {
    // `await import` — ver o cabeçalho: `@/gateway/queue.js` conecta ao Redis no
    // import, e este módulo é alcançado pelo grafo dos workers.
    const { enqueueAgent } = await import('@/gateway/queue.js');
    // `turn_id` no payload é o que torna o `jobId` DETERMINÍSTICO (#504): o
    // wake-up do fechamento e o do varredor de recovery armam o MESMO job, e a
    // BullMQ ignora o segundo `add`. É o que faz "fechar de forma idempotente"
    // valer também no transporte, e não só no banco.
    await enqueueAgent({
      mensagem_id: result.head.representative_message_id,
      turn_id: result.head.turn_id,
    });
    logger.info(
      {
        turn_id: result.head.turn_id,
        batch_size: result.batch_size,
        absorbed: result.absorbed_turn_ids.length,
      },
      'stream.batch_closed',
    );
  } catch (err) {
    // `warn`, não `error`: a decisão está COMITADA e o varredor a reconcilia
    // por `promoted_at`. Um `ops_alert` aqui pediria intervenção humana para
    // algo que o sistema conserta sozinho em um ciclo — e alerta que se resolve
    // sozinho é como se ensina o plantão a ignorar alerta.
    logger.warn(
      { turn_id: result.head.turn_id, err: (err as Error).message },
      'stream.batch_close_enqueue_failed',
    );
  }
}
