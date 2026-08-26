/**
 * Issue #629 (fatia F da #505) — o COLETOR DE FAIRNESS do escalonamento por
 * stream.
 *
 * ─── As três métricas que a issue-mãe pediu e ninguém tinha implementado ──
 *
 * `maia_stream_head_age_seconds`, `maia_stream_turn_wait_seconds` e
 * `maia_stream_starvation_total` estão na lista de séries sugeridas da #505
 * desde o primeiro dia. As fatias B–E não as entregaram porque nenhuma delas
 * tinha "fairness" no critério de pronto — e a #629 tem: *"uma conversa lenta
 * não serializa o tenant nem o agente inteiro"* e *"fairness demonstrada com
 * percentis e nenhum starvation persistente"*.
 *
 * Duas moram aqui e uma não, e a divisão não é arbitrária:
 *
 *  - `maia_stream_turn_wait_seconds` é um EVENTO (um turno começou; esperou
 *    tanto), então é histograma observado no claim — `src/runtime/turns/lease.ts`
 *    a emite a partir de `claim.wait_seconds`, medido pelo relógio do banco;
 *  - `head_age` e `active_total` são ESTADO (quantas conversas estão paradas
 *    AGORA, e há quanto tempo), então são gauges lidos no SCRAPE, do banco.
 *    Publicá-las a partir do worker as congelaria no último valor quando o
 *    worker parasse — e "o worker parou" é precisamente a falha que elas
 *    existem para pegar.
 *
 * ─── `starvation_total`: o contador que não pode contar scrapes ──────────
 *
 * Um contador incrementado a cada coleta por cada stream acima do limiar não
 * mede starvation: mede a frequência do Prometheus. Uma conversa parada há uma
 * hora com scrape de 15s produziria 240 "eventos de starvation" que são um só.
 *
 * A deduplicação é por TOKEN OPACO (`md5(tenant:agent:stream_key)`), num
 * conjunto em MEMÓRIA. O token nunca vira label, log nem saída de CLI — ele
 * existe unicamente para responder "esta é a mesma conversa da coleta
 * passada?". A `stream_key` já é um hash; este é um segundo hash cujo único
 * propósito é ser um token de igualdade que não identifica ninguém.
 *
 * ─── As duas imprecisões conhecidas, ditas em voz alta ───────────────────
 *
 *  1. **O conjunto morre com o processo.** Depois de um restart, uma conversa
 *     ainda faminta é contada de novo. É recontagem, não invenção: a conversa
 *     ESTÁ faminta. Fechar isso exigiria persistir o estado da métrica no
 *     banco — trocar uma imprecisão de contagem por uma escrita a cada scrape,
 *     numa tabela quente, para uma série que se lê como taxa.
 *  2. **Uma conversa que sai e volta a ficar faminta conta duas vezes.** É o
 *     comportamento desejado: são dois episódios.
 *
 * O conjunto é PODADO a cada coleta para os tokens ainda famintos. Sem a poda
 * ele cresceria com a cardinalidade histórica de conversas do processo — um
 * vazamento de memória lento, do tipo que só aparece em produção.
 */
import { logger } from '@/lib/logger.js';
import { incCounter, setGaugeProvider } from '@/lib/metrics.js';
import { METRIC } from './taxonomy.js';
import { declararBaldesDeEspera } from '@/runtime/turns/stream-metrics.js';

/**
 * Estado do coletor. Módulo-nível e não global do processo: o coletor é
 * registrado uma vez por processo (`registerRuntimeObservability`), e um estado
 * em closure tornaria impossível reinicializá-lo num teste sem recarregar o
 * módulo inteiro.
 */
let famintosConhecidos = new Set<string>();
let cache: Cache | null = null;
let voando: Promise<Cache> | null = null;

/**
 * Só para teste: esquece os tokens já contados E o retrato em cache.
 *
 * Os dois juntos, e não só o conjunto: o cache de coalescência é módulo-nível e
 * sobrevive entre casos, então uma spec que resetasse apenas os tokens leria o
 * retrato do caso ANTERIOR e afirmaria sobre ele — uma asserção verde sobre um
 * estado que o caso não produziu, que é a forma mais silenciosa de um teste
 * mentir.
 */
export function _resetStarvationStateForTests(): void {
  famintosConhecidos = new Set<string>();
  cache = null;
  voando = null;
}

/** O que o coletor precisa do mundo. Injetado para ser testável sem banco. */
export type StreamFairnessSource = {
  snapshot: (starvation_after_ms: number) => Promise<{
    live_streams: number;
    active_streams: number;
    max_backlog: number;
    max_head_age_s: number;
    p95_head_age_s: number;
    starving_tokens: readonly string[];
  }>;
  countBlocked: () => Promise<number>;
  starvationAfterMs: () => number;
};

type Cache = {
  at: number;
  live_streams: number;
  active_streams: number;
  max_backlog: number;
  max_head_age_s: number;
  p95_head_age_s: number;
  blocked_streams: number;
};

/**
 * Janela de coalescência da coleta, em ms.
 *
 * Um scrape pede SEIS gauges, e `src/lib/metrics.ts` chama um provider por
 * série. Sem cache isso seriam seis varreduras de `agent_turns` por scrape —
 * seis vezes o custo para responder à MESMA pergunta, num intervalo em que a
 * resposta não pode ter mudado de forma interessante. 5s é curto o bastante
 * para não mentir num scrape de 15s e longo o bastante para colapsar as seis
 * leituras de um mesmo scrape numa só.
 */
const COALESCE_MS = 5_000;

async function coletar(source: StreamFairnessSource): Promise<Cache> {
  const agora = Date.now();
  if (cache && agora - cache.at < COALESCE_MS) return cache;
  // Uma coleta em voo é COMPARTILHADA: os seis providers de um mesmo scrape
  // chegam praticamente juntos, e sem isto o cache (que só é escrito no fim)
  // deixaria os seis dispararem consultas simultâneas.
  if (voando) return voando;

  const limiar = source.starvationAfterMs();
  voando = (async () => {
    const [snap, blocked] = await Promise.all([source.snapshot(limiar), source.countBlocked()]);

    // ─── STARVATION: só o que é NOVO desde a última coleta ────────────────
    const famintosAgora = new Set(snap.starving_tokens);
    let novos = 0;
    for (const token of famintosAgora) {
      if (!famintosConhecidos.has(token)) novos += 1;
    }
    if (novos > 0) {
      incCounter(METRIC.STREAM_STARVATION, undefined, novos);
      logger.warn(
        {
          novos,
          famintas_agora: famintosAgora.size,
          limiar_ms: limiar,
          max_head_age_s: Math.round(snap.max_head_age_s),
          ops_alert: true,
        },
        'stream.starvation_detected',
      );
    }
    // A PODA. Sem ela o conjunto cresceria com a cardinalidade histórica de
    // conversas deste processo — um vazamento lento, do tipo que só aparece em
    // produção.
    famintosConhecidos = famintosAgora;

    const fresco: Cache = {
      at: Date.now(),
      live_streams: snap.live_streams,
      active_streams: snap.active_streams,
      max_backlog: snap.max_backlog,
      max_head_age_s: snap.max_head_age_s,
      p95_head_age_s: snap.p95_head_age_s,
      blocked_streams: blocked,
    };
    cache = fresco;
    return fresco;
  })().finally(() => {
    voando = null;
  });
  return voando;
}

/**
 * Registra os gauges de fairness e declara os baldes do histograma de espera.
 *
 * Idempotente: `setGaugeProvider` é keyed por nome de série (re-registrar
 * substitui, nunca empilha), e `registerHistogramBuckets` é declarativo.
 *
 * Nenhum provider LANÇA: `renderPrometheus` engole erro de provider e omite a
 * série, e uma série omitida por falha de banco é indistinguível de uma série
 * que vale zero. Por isso o `catch` devolve o ÚLTIMO valor conhecido em vez de
 * zero — um head age que despenca a zero durante uma indisponibilidade do banco
 * é a leitura mais enganosa possível de uma métrica de fairness.
 */
export function registerStreamFairnessGauges(source: StreamFairnessSource): void {
  // Os baldes da espera são declarados por `stream-metrics.ts`, que também os
  // declara no ponto de OBSERVAÇÃO — ver `declararBaldesDeEspera`. Aqui só se
  // garante que eles existam mesmo num processo que nunca reivindica nada (o
  // servidor HTTP puro), para que a série apareça no `/metrics` com a forma
  // certa desde o primeiro scrape.
  declararBaldesDeEspera();
  // Semeia o contador de starvation em ZERO, pela mesma razão de
  // `registrarSeriesDeStream`: numa instalação saudável ele nunca é
  // incrementado, e uma série ausente é indistinguível de "nunca aconteceu"
  // para todo alerta escrito contra ela.
  incCounter(METRIC.STREAM_STARVATION, undefined, 0);

  const gauge = (nome: string, ler: (c: Cache) => number): void => {
    setGaugeProvider(nome, async () => {
      try {
        return ler(await coletar(source));
      } catch (err) {
        logger.debug({ err: (err as Error).message }, 'stream_fairness.collect_failed');
        return cache ? ler(cache) : 0;
      }
    });
  };

  gauge(METRIC.STREAM_HEAD_AGE, (c) => Math.round(c.max_head_age_s));
  gauge(METRIC.STREAM_HEAD_AGE_P95, (c) => Math.round(c.p95_head_age_s));
  gauge(METRIC.STREAM_ACTIVE, (c) => c.active_streams);
  gauge(METRIC.STREAM_LIVE, (c) => c.live_streams);
  gauge(METRIC.STREAM_BACKLOG_MAX, (c) => c.max_backlog);
  gauge(METRIC.STREAM_POISONED, (c) => c.blocked_streams);
}
