/**
 * A/B de overhead do trace OTLP LIGADO sob carga — issue #535, critério 4.
 *
 * ## A decisão do dono (2026-09-03)
 *
 * > "#535: o micro-benchmark atual não fecha o critério de overhead. Preciso de
 * > A/B com OTLP ligado, cobrindo serialização, batching, collector/rede e hot
 * > path sob carga. Depois disso, tráfego real serve como gatilho de validação
 * > de cardinalidade, não como substituto da prova pré-canário."
 *
 * Margem ratificada para gates de desempenho (#736): **10 % relativo, tratado
 * como orçamento de regressão, não como medida do ruído**. O ruído é tratado
 * por PROTOCOLO — mesma janela, mesma massa, braços alternados no mesmo
 * processo — e não afrouxando a margem.
 *
 * ## O que este harness mede
 *
 * Turnos REAIS: o mesmo entry point que o worker BullMQ chama
 * (`runAgentForMensagem`, `src/agent/core.ts`), envelopado nas MESMAS três
 * camadas de `src/gateway/queue.ts` — `runWithCorrelation` → `withSpan(turn)` →
 * `runWithSystemContext` —, contra um Postgres real. Entre uma ponta e outra é
 * código de produção intocado: resolução de escopo, pré-turno, prompt, ReAct,
 * commit durável de saída, conclusão do turno. Tudo o que o spec de integração
 * `tests/integration/turn-span-tree-hot-path.spec.ts` dirige, este arquivo
 * dirige também — seed, limpeza e envelope do turno são copiados de lá.
 *
 * Três braços, no MESMO processo, sobre a MESMA massa, na MESMA janela,
 * ALTERNADOS por rodada (quadrado latino: cada rodada começa por um braço
 * diferente, então nenhum braço paga sempre o custo de "ir primeiro"):
 *
 *  - **`off`** — o caminho de produção de hoje: `tracingEnabled() === false`.
 *    O harness PROVA o curto-circuito em vez de presumi-lo: durante o braço,
 *    `tracingEnabled()` é lido e tem que ser `false`, o sink recebe zero spans
 *    e o collector recebe zero bytes (critério nomeado no veredicto).
 *  - **`on-local`** — exporter OTLP real (`OtlpSpanExporter`, o de produção,
 *    com os MESMOS limites: fila 2048, batch 256, tick 5 s) apontando para um
 *    collector HTTP que aceita `/v1/traces`, conta spans/bytes/batches e
 *    responde 200. Cobre serialização protobuf-JSON, batching e a rede de
 *    loopback, com `MAIA_OTLP_SAMPLE_RATIO=1` — o PIOR caso (produção usa
 *    0,05, §9.1 do runbook).
 *  - **`on-slow`** — o mesmo collector com latência artificial
 *    (`--collector-delay-ms`, default 200) e uma fração de batches recusados
 *    com 503 (`--collector-fail-ratio`, default 0,2). Prova que o hot path NÃO
 *    é afetado por collector lento ou caído: latência do turno inalterada,
 *    perda CONTADA por `reason` (nenhum span sem destino conhecido) e fila
 *    que nunca passa do teto.
 *
 * Por braço: p50/p95/p99 de latência do turno (relógio FORA do envelope, como
 * o worker vê), throughput (turnos/s), erros, spans emitidos pelo tracer vs
 * recebidos pelo collector, bytes serializados, batches, p50/p95 de
 * `maia_otlp_export_duration_ms` (relógio do transporte real), descartes por
 * `reason`, profundidade máxima da fila, e a CARDINALIDADE REAL: delta de
 * linhas na exposição `/metrics` (`renderPrometheus`) antes e depois de cada
 * braço, e séries `maia_*` por família. É isso que tira "orçamento de
 * cardinalidade" do plano teórico.
 *
 * ## O que ele NÃO mede
 *
 *  - **Latência do LLM.** O provider é sintético (`SyntheticProvider`,
 *    injetado por `_injectProviderForTests()` — o seam que
 *    `scripts/llm-benchmark.ts` já usa) e responde em `--llm-latency-ms`
 *    (default 0). Isso torna o turno o mais SENSÍVEL possível ao custo da
 *    instrumentação: em produção o modelo domina o turno e o mesmo overhead
 *    absoluto é uma fração menor. Os números aqui são **piso, não produção**.
 *  - **Entrega física no canal.** A saída passa pela fronteira única de
 *    produção (`src/gateway/line-output.ts`) até o commit durável e o
 *    `sendText`, mas o canal semeado é `is_synthetic = true`, então
 *    `buildOutput` o roteia para o sink fisicamente inerte que a plataforma já
 *    tem (`buildSyntheticSink`) — carregado por `loadSyntheticChannelIds`, a
 *    mesma função que o boot chama. Nenhum seam novo em `src/`.
 *  - **Cardinalidade sob tráfego REAL de produção.** Continua sendo gatilho
 *    pós-canário, como o dono disse. O que se mede aqui é a cardinalidade que
 *    ESTE tráfego (owner, texto, canal único) produz.
 *  - **`queue.wait`** — só existe quando o job veio pela fila BullMQ; aqui o
 *    turno é aberto direto, como no spec de integração.
 *  - **`llm.request`** — o emissor (`emitUsage`, `src/lib/llm/telemetry.ts`)
 *    está ABAIXO do seam do provider, então o span É emitido aqui — ao contrário
 *    do spec, que mocka `@/lib/claude.js` acima dele.
 *
 * O collector roda EM-PROCESSO (`node:http`), disputando o event loop com os
 * turnos. Isso é um viés CONSERVADOR: um collector fora do processo custaria
 * menos ao hot path, não mais.
 *
 * ## Como o endpoint entra com o `config` congelado
 *
 * `config` (`src/config/env.ts`) é lido uma vez e congelado. O caminho honesto
 * num script é: subir o collector ANTES de qualquer import de `@/`, gravar
 * `MAIA_OTLP_TRACES_ENDPOINT`/`MAIA_OTLP_SAMPLE_RATIO=1` em `process.env`, e
 * SÓ ENTÃO importar o projeto (todos os imports de `@/` abaixo são dinâmicos).
 * O harness confere que `config.MAIA_OTLP_TRACES_ENDPOINT` é o collector.
 *
 * Com o endpoint fixo no processo, o braço `off` é `setSpanSink(null)`:
 * `tracingEnabled()` é `sink !== null && !!config.MAIA_OTLP_TRACES_ENDPOINT`,
 * e com o sink nulo ele curto-circuita na PRIMEIRA comparação — o mesmo
 * boolean único do caminho de produção sem endpoint. Os braços ligados
 * instanciam `new OtlpSpanExporter({ endpoint, transport })` por braço e o
 * instalam com `setSpanSink`; o transporte é o `fetchTransport` real embrulhado
 * num relógio. `startOtlpExporter()` não é usado porque é idempotente por
 * processo (um exporter por vida do processo), e aqui há três.
 *
 * ## Cenários (`--scenario`)
 *
 *  - `text` (default): o turno responde em texto e NÃO abre `tool.dispatch`
 *    nem os quatro portões abaixo dele. É o caminho de todo turno de texto.
 *  - `tool`: o provider sintético pede `explain_limitation` (tool
 *    `side_effect: 'none'`, baseline.core) na primeira chamada com tools e
 *    responde em texto depois do `tool_result`. Cobre `tool.dispatch`,
 *    `constitutional.check`, `permission.check`, `idempotency.claim` e
 *    `handler.execute` — a contagem por nome de span sai no relatório.
 *
 * ## Uso
 *
 *   npm run otlp:bench                                   # gate, 3 rodadas × 200 turnos por braço
 *   npm run otlp:bench -- --mode measure --rounds 5 --turns 400
 *   npm run otlp:bench -- --scenario tool
 *   npm run otlp:bench -- --self-test                     # gate verde sobre números sintéticos
 *   npm run otlp:bench -- --self-test --inject on-local.p95_ms=900        # prova que o gate reprova
 *   npm run otlp:bench -- --self-test --inject on-local.spans_received=10 # perda com collector saudável
 *   npm run otlp:bench -- --self-test --inject on-slow.queue_depth_max=4096
 *   npm run otlp:bench -- --self-test --inject off.sink_calls=1           # `off` deixou de curto-circuitar
 *   npm run otlp:bench -- --json
 *
 * | Flag | Default | O que faz |
 * |---|---|---|
 * | `--mode` | `gate` | `gate` (veredicto, exit 1 se reprovar) · `measure` (só mede, exit 0, sem veredicto) · `self-test` |
 * | `--rounds` | `3` | Rodadas; em cada uma os três braços rodam alternados |
 * | `--turns` | `200` | Turnos por braço POR rodada |
 * | `--concurrency` | `4` | Turnos simultâneos (uma pessoa/conversa por slot) |
 * | `--warmup-turns` | `20` | Turnos descartados POR BRAÇO antes da 1ª rodada (JIT, conexões, caches — inclusive os do caminho de export) |
 * | `--scenario` | `text` | `text` · `tool` |
 * | `--arms` | `off,on-local,on-slow` | Subconjunto; o gate exige os três |
 * | `--collector-delay-ms` | `200` | Latência artificial do collector no braço `on-slow` |
 * | `--collector-fail-ratio` | `0.2` | Fração de batches recusados com 503 no braço `on-slow` |
 * | `--llm-latency-ms` | `0` | Latência do provider sintético |
 * | `--queue-size` | `2048` | Teto da fila do exporter (o mesmo de produção); é também o teto do critério |
 * | `--relative-margin` | `0.10` | p95/p99 ≤ off × (1+m); throughput ≥ off × (1−m) |
 * | `--self-test` | — | Apelido de `--mode self-test`. Não toca no banco |
 * | `--inject` | — | `braço.campo=valor[,…]` (exige `--self-test`) |
 * | `--json` | — | Saída em JSON em vez de markdown |
 */
import { createServer, type Server } from 'node:http';
import { hostname, loadavg, cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// ============================================================================
// Opções
// ============================================================================

export type ArmName = 'off' | 'on-local' | 'on-slow';
export const ALL_ARMS: readonly ArmName[] = ['off', 'on-local', 'on-slow'];

export type RunMode = 'gate' | 'measure' | 'self-test';
export type Scenario = 'text' | 'tool';

/**
 * A margem dos critérios RELATIVOS ligado-vs-desligado: p95 e p99 ≤ off ×
 * (1 + margem); throughput ≥ off × (1 − margem). 10 % é a margem ratificada
 * para gates de desempenho (#736) — orçamento de regressão, não medida do
 * ruído. Quem vê flake aqui aperta o protocolo (mais rodadas, mais turnos,
 * janela mais quieta), não a margem.
 */
export const MARGEM_RELATIVA_DEFAULT = 0.1;

/** O teto de produção da fila do exporter (`MAX_QUEUE_SIZE` em `otlp-exporter.ts`). */
export const QUEUE_SIZE_DEFAULT = 2048;

export type Options = {
  mode: RunMode;
  rounds: number;
  turns: number;
  concurrency: number;
  warmup_turns: number;
  scenario: Scenario;
  arms: ArmName[];
  collector_delay_ms: number;
  collector_fail_ratio: number;
  llm_latency_ms: number;
  queue_size: number;
  relative_margin: number;
  inject: Record<string, number>;
  json: boolean;
};

function parseInject(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) throw new Error(`--inject inválido: "${part}" (esperado chave=valor)`);
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--inject inválido: "${part}" (valor não numérico)`);
    out[k.trim()] = n;
  }
  return out;
}

export function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (name: string, fallback: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`--${name} precisa de um número`);
    return parsed;
  };
  const int = (name: string, fallback: number, min: number): number => {
    const v = num(name, fallback);
    if (!Number.isInteger(v) || v < min) throw new Error(`--${name} precisa ser inteiro ≥ ${min}`);
    return v;
  };

  const modeRaw = get('mode') ?? 'gate';
  if (!['gate', 'measure', 'self-test'].includes(modeRaw)) {
    throw new Error(`--mode inválido: ${modeRaw} (esperado gate | measure | self-test)`);
  }
  const selfTestFlag = argv.includes('--self-test');
  if (selfTestFlag && modeRaw !== 'gate' && modeRaw !== 'self-test') {
    throw new Error(`--self-test conflita com --mode ${modeRaw}`);
  }
  const mode: RunMode = selfTestFlag ? 'self-test' : (modeRaw as RunMode);

  const inject = parseInject(get('inject'));
  if (Object.keys(inject).length > 0 && mode !== 'self-test') {
    // Injetar num braço MEDIDO transformaria o gate num carimbo.
    throw new Error('--inject só é aceito junto de --self-test (é a prova do gate, não uma medição)');
  }

  const scenarioRaw = get('scenario') ?? 'text';
  if (scenarioRaw !== 'text' && scenarioRaw !== 'tool') {
    throw new Error(`--scenario inválido: ${scenarioRaw} (esperado text | tool)`);
  }

  const armsRaw = get('arms');
  const arms: ArmName[] = armsRaw
    ? (armsRaw.split(',').map((a) => a.trim()) as ArmName[])
    : [...ALL_ARMS];
  for (const a of arms) {
    if (!ALL_ARMS.includes(a)) throw new Error(`--arms inválido: ${a} (esperado ${ALL_ARMS.join(' | ')})`);
  }
  if (new Set(arms).size !== arms.length) throw new Error('--arms repete um braço');

  const failRatio = num('collector-fail-ratio', 0.2);
  if (failRatio < 0 || failRatio > 1) throw new Error('--collector-fail-ratio precisa estar em [0,1]');
  const margin = num('relative-margin', MARGEM_RELATIVA_DEFAULT);
  if (margin < 0 || margin >= 1) throw new Error('--relative-margin precisa estar em [0,1)');

  return {
    mode,
    rounds: int('rounds', 3, 1),
    turns: int('turns', 200, 1),
    concurrency: int('concurrency', 4, 1),
    warmup_turns: int('warmup-turns', 20, 0),
    scenario: scenarioRaw,
    arms,
    collector_delay_ms: int('collector-delay-ms', 200, 0),
    collector_fail_ratio: failRatio,
    llm_latency_ms: int('llm-latency-ms', 0, 0),
    queue_size: int('queue-size', QUEUE_SIZE_DEFAULT, 1),
    relative_margin: margin,
    inject,
    json: argv.includes('--json'),
  };
}

// ============================================================================
// Estatística e leitura da exposição Prometheus
// ============================================================================

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

/**
 * O collector `on-slow` recusa EXATAMENTE a fração pedida dos batches, por
 * cota (Bresenham) e a partir do PRIMEIRO batch de cada braço — não por
 * sorteio. A primeira versão sorteava por hash do índice e, numa corrida curta
 * de 4 batches, recusou zero: o critério "collector degradado de fato" ficou
 * vermelho por sorte, não por defeito. Com cota, `ceil(batches × ratio)`
 * batches são recusados em qualquer tamanho de corrida, e o n-ésimo batch tem
 * o mesmo destino em toda rodada.
 */
export function shouldRejectBatch(index: number, ratio: number): boolean {
  if (ratio <= 0) return false;
  if (ratio >= 1) return true;
  const phase = 1 - ratio;
  return Math.floor((index + 1) * ratio + phase) > Math.floor(index * ratio + phase);
}

/** Linhas não vazias da exposição — cada uma é UMA série (ou bucket). */
export function metricLines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim().length > 0);
}

/**
 * Séries por FAMÍLIA `maia_*`. `_bucket`/`_sum`/`_count` de um histograma são
 * dobrados na família base, então "família" aqui é o que um dashboard chama de
 * métrica, e a contagem é o que o Prometheus chama de cardinalidade.
 */
export function seriesPorFamilia(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of metricLines(text)) {
    const brace = line.indexOf('{');
    const space = line.indexOf(' ');
    const end = brace >= 0 && (space < 0 || brace < space) ? brace : space;
    let name = end >= 0 ? line.slice(0, end) : line;
    if (!name.startsWith('maia_')) continue;
    name = name.replace(/_(bucket|sum|count)$/, '');
    out[name] = (out[name] ?? 0) + 1;
  }
  return out;
}

/** Soma de um contador POR VALOR de um label (`reason`, `status`, …). */
export function counterByLabel(text: string, metric: string, label: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of metricLines(text)) {
    if (!line.startsWith(metric)) continue;
    const rest = line.slice(metric.length);
    if (!rest.startsWith('{') && !rest.startsWith(' ')) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (!Number.isFinite(value)) continue;
    const m = new RegExp(`${label}="([^"]*)"`).exec(rest);
    const key = m ? m[1]! : '';
    out[key] = (out[key] ?? 0) + value;
  }
  return out;
}

export function diffByLabel(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] ?? 0) - (before[k] ?? 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

// ============================================================================
// Resultado por braço e veredicto
// ============================================================================

export type ArmResult = {
  arm: ArmName;
  /** Rodadas agregadas neste resultado (uma, ou todas no agregado). */
  rounds: number[];
  turns: number;
  errors: number;
  /** Chamadas ao provider sintético — a prova de que o turno chegou ao reasoner. */
  provider_calls: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  mean_ms: number;
  wall_ms: number;
  throughput_turns_per_s: number;
  /** `tracingEnabled()` lido DURANTE o braço. */
  tracing_enabled: boolean;
  /** Spans entregues ao sink (o exporter) pelo tracer. */
  sink_calls: number;
  /** Aceitos pelo collector (200) e recusados (5xx), contados no collector. */
  spans_received: number;
  spans_rejected: number;
  batches: number;
  bytes: number;
  export_p50_ms: number;
  export_p95_ms: number;
  export_max_ms: number;
  /** Delta de `maia_otlp_spans_exported_total{status="ok"}` no braço. */
  exported_ok: number;
  /** Delta de `maia_otlp_spans_dropped_total` por `reason` no braço. */
  dropped: Record<string, number>;
  queue_depth_max: number;
  /** Spans por nome — é como o cenário `tool` prova que abriu os portões. */
  span_counts: Record<string, number>;
  metrics_lines_before: number;
  metrics_lines_after: number;
  /** Séries `maia_*` por família DEPOIS do braço. */
  families: Record<string, number>;
};

export type Verdict = {
  label: string;
  /** INVARIANTE: `skipped === true` implica `passed === false`. */
  passed: boolean;
  skipped?: boolean;
  detail: string;
};

export type Thresholds = {
  relative_margin: number;
  queue_size: number;
  collector_delay_ms: number;
  collector_fail_ratio: number;
};

function droppedExceptNotSampled(a: ArmResult): number {
  return Object.entries(a.dropped)
    .filter(([reason]) => reason !== 'not_sampled')
    .reduce((s, [, v]) => s + v, 0);
}

function relative(
  label: string,
  measured: number,
  base: number,
  factor: number,
  direction: 'max' | 'min',
  unit: string,
): Verdict {
  const limit = base * factor;
  const ok = direction === 'max' ? measured <= limit : measured >= limit;
  return {
    label,
    passed: ok,
    detail:
      `medido=${measured.toFixed(2)} ${unit} · off=${base.toFixed(2)} ${unit} · ` +
      `limiar=${limit.toFixed(2)} ${unit} (× ${factor.toFixed(2)})${ok ? '' : ' ✗'}`,
  };
}

function skipped(label: string, why: string): Verdict {
  return { label, passed: false, skipped: true, detail: why };
}

/**
 * O gate. PURO: só lê os `ArmResult`, para que o `--self-test` e o spec
 * unitário possam prová-lo sem Postgres, sem carga e sem relógio.
 */
export function evaluateGate(arms: readonly ArmResult[], t: Thresholds): Verdict[] {
  const v: Verdict[] = [];
  const by = new Map(arms.map((a) => [a.arm, a]));
  const off = by.get('off');
  const sobe = 1 + t.relative_margin;
  const desce = 1 - t.relative_margin;

  // --- off: o curto-circuito é PROVADO, não presumido -----------------------
  if (!off) {
    v.push(skipped('[off] curto-circuito provado', 'o braço `off` não rodou'));
    v.push(skipped('[off] erros = 0', 'o braço `off` não rodou'));
  } else {
    const ok =
      !off.tracing_enabled && off.sink_calls === 0 && off.spans_received === 0 && off.bytes === 0;
    v.push({
      label: '[off] curto-circuito provado (tracingEnabled=false, 0 spans no sink, 0 bytes no collector)',
      passed: ok,
      detail:
        `tracingEnabled=${off.tracing_enabled} · sink=${off.sink_calls} · ` +
        `collector=${off.spans_received} spans/${off.bytes} bytes${ok ? '' : ' ✗'}`,
    });
    v.push({
      label: '[off] erros = 0',
      passed: off.errors === 0,
      detail: `erros=${off.errors} em ${off.turns} turnos${off.errors === 0 ? '' : ' ✗'}`,
    });
  }

  for (const arm of ['on-local', 'on-slow'] as const) {
    const a = by.get(arm);
    const labels = [
      `[${arm}] p95 do turno ≤ off × ${sobe.toFixed(2)}`,
      `[${arm}] p99 do turno ≤ off × ${sobe.toFixed(2)}`,
      `[${arm}] throughput ≥ off × ${desce.toFixed(2)}`,
      `[${arm}] erros novos = 0`,
      `[${arm}] cada turno alcançou o modelo (chamadas ao provider ≥ turnos)`,
      `[${arm}] tracing ligado de fato (tracingEnabled=true, spans no sink > 0)`,
      `[${arm}] amostragem 1: not_sampled = 0`,
    ];
    if (!a || !off) {
      const why = !a ? `o braço \`${arm}\` não rodou` : 'o braço `off` não rodou — sem referência';
      for (const l of labels) v.push(skipped(l, why));
    } else {
      v.push(relative(labels[0]!, a.p95_ms, off.p95_ms, sobe, 'max', 'ms'));
      v.push(relative(labels[1]!, a.p99_ms, off.p99_ms, sobe, 'max', 'ms'));
      v.push(
        relative(labels[2]!, a.throughput_turns_per_s, off.throughput_turns_per_s, desce, 'min', 'turnos/s'),
      );
      const novos = a.errors - off.errors;
      v.push({
        label: labels[3]!,
        passed: novos <= 0,
        detail: `erros=${a.errors} · off=${off.errors} · novos=${Math.max(0, novos)}${novos <= 0 ? '' : ' ✗'}`,
      });
      const reached = a.provider_calls >= a.turns;
      v.push({
        label: labels[4]!,
        passed: reached,
        detail: `provider=${a.provider_calls} · turnos=${a.turns}${reached ? '' : ' ✗'}`,
      });
      const live = a.tracing_enabled && a.sink_calls > 0;
      v.push({
        label: labels[5]!,
        passed: live,
        detail: `tracingEnabled=${a.tracing_enabled} · sink=${a.sink_calls}${live ? '' : ' ✗'}`,
      });
      const ns = a.dropped.not_sampled ?? 0;
      v.push({
        label: labels[6]!,
        passed: ns === 0,
        detail: `not_sampled=${ns}${ns === 0 ? '' : ' ✗'}`,
      });
    }
  }

  // --- on-local: collector saudável ⇒ sem perda -----------------------------
  {
    const a = by.get('on-local');
    const l1 = '[on-local] spans recebidos pelo collector = emitidos − not_sampled (sem perda)';
    const l2 = '[on-local] descartes = 0 (collector saudável)';
    if (!a) {
      v.push(skipped(l1, 'o braço `on-local` não rodou'));
      v.push(skipped(l2, 'o braço `on-local` não rodou'));
    } else {
      const expected = a.sink_calls - (a.dropped.not_sampled ?? 0);
      const ok = a.spans_received === expected && a.exported_ok === a.spans_received;
      v.push({
        label: l1,
        passed: ok,
        detail:
          `recebidos=${a.spans_received} · emitidos=${a.sink_calls} · not_sampled=${a.dropped.not_sampled ?? 0} · ` +
          `exported_ok(métrica)=${a.exported_ok}${ok ? '' : ' ✗'}`,
      });
      const d = droppedExceptNotSampled(a);
      v.push({
        label: l2,
        passed: d === 0,
        detail: `descartados=${d} ${JSON.stringify(a.dropped)}${d === 0 ? '' : ' ✗'}`,
      });
    }
  }

  // --- on-slow: perda CONTADA, fila limitada, e o collector foi lento MESMO ---
  {
    const a = by.get('on-slow');
    const l1 = '[on-slow] perda contabilizada: emitidos = recebidos + descartados(por reason) e http_5xx = recusados pelo collector';
    const l2 = `[on-slow] fila nunca acima de ${t.queue_size}`;
    const l3 = `[on-slow] collector degradado de fato (export p50 ≥ ${t.collector_delay_ms} ms${t.collector_fail_ratio > 0 ? ', batches recusados > 0' : ''})`;
    if (!a) {
      v.push(skipped(l1, 'o braço `on-slow` não rodou'));
      v.push(skipped(l2, 'o braço `on-slow` não rodou'));
      v.push(skipped(l3, 'o braço `on-slow` não rodou'));
    } else {
      const d = droppedExceptNotSampled(a);
      const accounted = a.sink_calls - (a.dropped.not_sampled ?? 0) === a.spans_received + d;
      const rejectedMatch = (a.dropped.http_5xx ?? 0) === a.spans_rejected;
      const ok = accounted && rejectedMatch && a.exported_ok === a.spans_received;
      v.push({
        label: l1,
        passed: ok,
        detail:
          `emitidos=${a.sink_calls} · recebidos=${a.spans_received} · descartados=${d} ${JSON.stringify(a.dropped)} · ` +
          `recusados(collector)=${a.spans_rejected}${ok ? '' : ' ✗'}`,
      });
      const q = a.queue_depth_max <= t.queue_size;
      v.push({
        label: l2,
        passed: q,
        detail: `profundidade máxima=${a.queue_depth_max} · teto=${t.queue_size}${q ? '' : ' ✗'}`,
      });
      const slow =
        a.batches > 0 &&
        a.export_p50_ms >= t.collector_delay_ms &&
        (t.collector_fail_ratio === 0 || a.spans_rejected > 0);
      v.push({
        label: l3,
        passed: slow,
        detail:
          `batches=${a.batches} · export p50=${a.export_p50_ms.toFixed(1)} ms · ` +
          `recusados=${a.spans_rejected} spans${slow ? '' : ' ✗'}`,
      });
    }
  }

  return v;
}

/**
 * O exit code, POR MODO — a mesma regra de `turn-context-benchmark.ts`:
 * `gate`/`self-test` só são 0 quando TODO critério foi avaliado e passou
 * (`skipped` implica `passed === false`); `measure` é 0 porque a medição
 * aconteceu e o relatório diz em caixa alta que não houve veredicto.
 */
export function gateExitCode(verdicts: readonly Verdict[], mode: RunMode = 'gate'): number {
  if (mode === 'measure') return 0;
  return verdicts.every((v) => v.passed) ? 0 : 1;
}

/**
 * Aplica `--inject` ANTES da avaliação. Chave: `braço.campo=valor`, com
 * `braço.dropped.reason=valor` para os descartes. Só existe para o
 * `--self-test`.
 */
export function applyInjection(arms: ArmResult[], inject: Record<string, number>): string[] {
  const applied: string[] = [];
  const NUMERIC = new Set<keyof ArmResult>([
    'turns',
    'errors',
    'provider_calls',
    'p50_ms',
    'p95_ms',
    'p99_ms',
    'max_ms',
    'mean_ms',
    'wall_ms',
    'throughput_turns_per_s',
    'sink_calls',
    'spans_received',
    'spans_rejected',
    'batches',
    'bytes',
    'export_p50_ms',
    'export_p95_ms',
    'export_max_ms',
    'exported_ok',
    'queue_depth_max',
    'metrics_lines_before',
    'metrics_lines_after',
  ]);
  for (const [key, value] of Object.entries(inject)) {
    const [armName, ...rest] = key.split('.');
    const arm = arms.find((a) => a.arm === armName);
    if (!arm) throw new Error(`--inject: braço desconhecido em "${key}"`);
    if (rest[0] === 'dropped' && rest[1]) {
      arm.dropped[rest[1]] = value;
    } else if (rest[0] === 'tracing_enabled') {
      arm.tracing_enabled = value !== 0;
    } else if (rest.length === 1 && NUMERIC.has(rest[0] as keyof ArmResult)) {
      (arm as unknown as Record<string, number>)[rest[0]!] = value;
    } else {
      throw new Error(`--inject: campo desconhecido em "${key}"`);
    }
    applied.push(`${key}=${value}`);
  }
  return applied;
}

/** Braços SINTÉTICOS e saudáveis para o `--self-test`. */
export function syntheticArms(t: Thresholds): ArmResult[] {
  const base = (arm: ArmName): ArmResult => ({
    arm,
    rounds: [1, 2, 3],
    turns: 600,
    errors: 0,
    provider_calls: 1200,
    p50_ms: 40,
    p95_ms: 70,
    p99_ms: 90,
    max_ms: 120,
    mean_ms: 42,
    wall_ms: 6_000,
    throughput_turns_per_s: 100,
    tracing_enabled: arm !== 'off',
    sink_calls: arm === 'off' ? 0 : 7_800,
    spans_received: 0,
    spans_rejected: 0,
    batches: 0,
    bytes: 0,
    export_p50_ms: 0,
    export_p95_ms: 0,
    export_max_ms: 0,
    exported_ok: 0,
    dropped: {},
    queue_depth_max: 0,
    span_counts: {},
    metrics_lines_before: 300,
    metrics_lines_after: 300,
    families: { maia_turn_duration_ms: 12 },
  });
  const off = base('off');
  const local = {
    ...base('on-local'),
    p95_ms: 72,
    p99_ms: 93,
    throughput_turns_per_s: 98,
    spans_received: 7_800,
    exported_ok: 7_800,
    batches: 31,
    bytes: 3_900_000,
    export_p50_ms: 4,
    export_p95_ms: 9,
    export_max_ms: 14,
    queue_depth_max: 256,
  };
  const slow = {
    ...base('on-slow'),
    p95_ms: 71,
    p99_ms: 94,
    throughput_turns_per_s: 99,
    spans_received: 6_400,
    spans_rejected: 1_400,
    exported_ok: 6_400,
    dropped: { http_5xx: 1_400 },
    batches: 31,
    bytes: 3_900_000,
    export_p50_ms: t.collector_delay_ms + 3,
    export_p95_ms: t.collector_delay_ms + 8,
    export_max_ms: t.collector_delay_ms + 15,
    queue_depth_max: 512,
  };
  return [off, local, slow];
}

// ============================================================================
// Relatório
// ============================================================================

export type HostInfo = {
  host: string;
  node: string;
  platform: string;
  cpus: number;
  loadavg_1m: number;
  date: string;
};

export function hostInfo(): HostInfo {
  return {
    host: hostname(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpus: cpus().length,
    loadavg_1m: Number(loadavg()[0]!.toFixed(2)),
    date: new Date().toISOString(),
  };
}

export type Report = {
  mode: RunMode;
  self_test: boolean;
  options: Options;
  host: HostInfo;
  injected: string[];
  per_round: ArmResult[];
  arms: ArmResult[];
  verdicts: Verdict[];
  exit_code: number;
  gate_evaluated: boolean;
};

export function encodeReport(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function fmt(n: number, d = 1): string {
  return n.toFixed(d);
}

function droppedText(d: Record<string, number>): string {
  const entries = Object.entries(d);
  return entries.length === 0 ? '0' : entries.map(([k, v]) => `${k}=${v}`).join(' ');
}

export function renderReport(report: Report): string {
  const { options: o, host: h } = report;
  const out: string[] = [];
  out.push('# A/B de overhead do trace OTLP sob carga — issue #535 critério 4');
  out.push('');
  out.push(
    `Modo: **${report.mode}**${report.self_test ? ' (números SINTÉTICOS — nada foi medido)' : ''} · ` +
      `cenário: \`${o.scenario}\` · rodadas: ${o.rounds} · turnos/braço/rodada: ${o.turns} · ` +
      `concorrência: ${o.concurrency} · aquecimento: ${o.warmup_turns} turnos`,
  );
  out.push(
    `Collector \`on-slow\`: atraso ${o.collector_delay_ms} ms, ${(o.collector_fail_ratio * 100).toFixed(0)} % dos batches com 503 · ` +
      `fila ${o.queue_size} · LLM sintético ${o.llm_latency_ms} ms · \`MAIA_OTLP_SAMPLE_RATIO=1\` (produção: 0,05)`,
  );
  out.push(
    `Host: ${h.host} · Node ${h.node} · ${h.platform} · ${h.cpus} cpus · load 1m ${h.loadavg_1m} · ${h.date}`,
  );
  out.push('');
  out.push('**Piso, não produção**: provider sintético, canal sintético, collector em-processo (viés conservador).');
  out.push('');
  if (report.injected.length > 0) {
    out.push(`Injeções (\`--inject\`): ${report.injected.join(', ')}`);
    out.push('');
  }

  out.push('## Por braço (agregado das rodadas, braços alternados)');
  out.push('');
  out.push(
    '| braço | turnos | erros | p50 ms | p95 ms | p99 ms | max ms | turnos/s | spans emitidos | recebidos | recusados | batches | bytes | export p50/p95 ms | descartes | fila max | Δ linhas /metrics |',
  );
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of report.arms) {
    out.push(
      `| \`${a.arm}\` | ${a.turns} | ${a.errors} | ${fmt(a.p50_ms)} | ${fmt(a.p95_ms)} | ${fmt(a.p99_ms)} | ${fmt(a.max_ms)} | ` +
        `${fmt(a.throughput_turns_per_s)} | ${a.sink_calls} | ${a.spans_received} | ${a.spans_rejected} | ${a.batches} | ${a.bytes} | ` +
        `${fmt(a.export_p50_ms)}/${fmt(a.export_p95_ms)} | ${droppedText(a.dropped)} | ${a.queue_depth_max} | ` +
        `${a.metrics_lines_after - a.metrics_lines_before} (${a.metrics_lines_before}→${a.metrics_lines_after}) |`,
    );
  }
  out.push('');

  if (report.per_round.length > 0) {
    out.push('## Por rodada (ordem de execução)');
    out.push('');
    out.push('| rodada | braço | turnos | erros | p50 ms | p95 ms | p99 ms | turnos/s | spans emitidos | recebidos | Δ linhas /metrics |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const a of report.per_round) {
      out.push(
        `| ${a.rounds.join(',')} | \`${a.arm}\` | ${a.turns} | ${a.errors} | ${fmt(a.p50_ms)} | ${fmt(a.p95_ms)} | ${fmt(a.p99_ms)} | ` +
          `${fmt(a.throughput_turns_per_s)} | ${a.sink_calls} | ${a.spans_received} | ${a.metrics_lines_after - a.metrics_lines_before} |`,
      );
    }
    out.push('');
  }

  const last = report.arms[report.arms.length - 1];
  if (last) {
    out.push('## Cardinalidade real — séries `maia_*` por família (após o último braço)');
    out.push('');
    const fam = Object.entries(last.families).sort((x, y) => y[1] - x[1]);
    const total = fam.reduce((s, [, n]) => s + n, 0);
    const otlp = fam.filter(([name]) => name.startsWith('maia_otlp_') || name === 'maia_span_attribute_rejected_total');
    const otlpTotal = otlp.reduce((s, [, n]) => s + n, 0);
    out.push(`Total: ${total} séries em ${fam.length} famílias.`);
    out.push(
      `Séries do próprio caminho de export (\`maia_otlp_*\`, \`maia_span_attribute_rejected_total\`): ${otlpTotal} em ${otlp.length} famílias — ` +
        'cunhadas UMA vez por processo (o aquecimento já as cunha; o Δ por braço mostra se algum turno cunhou série nova).',
    );
    out.push('');
    out.push('| família | séries |');
    out.push('|---|---|');
    for (const [name, n] of fam.slice(0, 25)) out.push(`| \`${name}\` | ${n} |`);
    if (fam.length > 25) out.push(`| … | +${fam.length - 25} famílias |`);
    out.push('');
  }

  const withSpans = report.arms.find((a) => Object.keys(a.span_counts).length > 0);
  if (withSpans) {
    out.push(`## Spans por nome (braço \`${withSpans.arm}\`)`);
    out.push('');
    out.push('| span | emitidos |');
    out.push('|---|---|');
    for (const [name, n] of Object.entries(withSpans.span_counts).sort((x, y) => y[1] - x[1])) {
      out.push(`| \`${name}\` | ${n} |`);
    }
    out.push('');
  }

  out.push('## Veredicto');
  out.push('');
  if (!report.gate_evaluated) {
    out.push('**MODO MEASURE — NENHUM VEREDICTO DE GATE FOI EMITIDO.** Os critérios abaixo são informativos; o exit code 0 significa "mediu", não "aprovou".');
    out.push('');
  }
  for (const v of report.verdicts) {
    const mark = v.passed ? 'PASS' : v.skipped ? 'SKIP (reprova)' : 'FAIL';
    out.push(`- ${mark} — ${v.label}: ${v.detail}`);
  }
  out.push('');
  const executados = report.arms.reduce((s, a) => s + a.turns, 0);
  const falharam = report.arms.reduce((s, a) => s + a.errors, 0);
  out.push(
    `turnos executados=${executados} falharam=${falharam} · critérios=${report.verdicts.length} ` +
      `aprovados=${report.verdicts.filter((v) => v.passed).length} ` +
      `reprovados=${report.verdicts.filter((v) => !v.passed && !v.skipped).length} ` +
      `pulados=${report.verdicts.filter((v) => v.skipped).length} · exit=${report.exit_code}`,
  );
  out.push('');
  return out.join('\n');
}

// ============================================================================
// Collector HTTP em-processo
// ============================================================================

export type CollectorMode = { delay_ms: number; fail_ratio: number };

export type CollectorCounters = {
  requests: number;
  accepted_requests: number;
  rejected_requests: number;
  spans_accepted: number;
  spans_rejected: number;
  bytes: number;
  parse_errors: number;
};

export type Collector = {
  url: string;
  setMode(mode: CollectorMode): void;
  reset(): void;
  snapshot(): CollectorCounters;
  close(): Promise<void>;
};

function emptyCounters(): CollectorCounters {
  return {
    requests: 0,
    accepted_requests: 0,
    rejected_requests: 0,
    spans_accepted: 0,
    spans_rejected: 0,
    bytes: 0,
    parse_errors: 0,
  };
}

/** Conta os spans de um `ExportTraceServiceRequest` em protobuf-JSON. */
export function countOtlpSpans(body: unknown): number {
  const rs = (body as { resourceSpans?: unknown[] })?.resourceSpans;
  if (!Array.isArray(rs)) return 0;
  let n = 0;
  for (const r of rs) {
    const ss = (r as { scopeSpans?: unknown[] })?.scopeSpans;
    if (!Array.isArray(ss)) continue;
    for (const s of ss) {
      const spans = (s as { spans?: unknown[] })?.spans;
      if (Array.isArray(spans)) n += spans.length;
    }
  }
  return n;
}

export async function startCollector(): Promise<Collector> {
  let mode: CollectorMode = { delay_ms: 0, fail_ratio: 0 };
  let counters = emptyCounters();
  let requestIndex = 0;
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/traces') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const index = requestIndex++;
      counters.requests++;
      counters.bytes += raw.length;
      let spans = 0;
      try {
        spans = countOtlpSpans(JSON.parse(raw.toString('utf8')));
      } catch {
        counters.parse_errors++;
      }
      const reject = shouldRejectBatch(index, mode.fail_ratio);
      const respond = (): void => {
        if (reject) {
          counters.rejected_requests++;
          counters.spans_rejected += spans;
          res.statusCode = 503;
          res.end();
        } else {
          counters.accepted_requests++;
          counters.spans_accepted += spans;
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end('{}');
        }
      };
      if (mode.delay_ms > 0) setTimeout(respond, mode.delay_ms);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('collector sem porta');
  return {
    url: `http://127.0.0.1:${addr.port}/v1/traces`,
    setMode: (m) => {
      mode = m;
    },
    reset: () => {
      counters = emptyCounters();
      requestIndex = 0;
    },
    snapshot: () => ({ ...counters }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ============================================================================
// Ambiente e dependências (imports dinâmicos — ver cabeçalho)
// ============================================================================

const ENV_DEFAULTS: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://maia_test:test1234@localhost:5432/maia_test',
  POSTGRES_USER: 'maia_test',
  POSTGRES_PASSWORD: 'test1234',
  POSTGRES_DB: 'maia_test',
  REDIS_URL: 'redis://localhost:6379',
  ANTHROPIC_API_KEY: 'sk-ant-benchmark-placeholder',
  OPENROUTER_API_KEY: 'sk-or-benchmark-placeholder',
  WHATSAPP_NUMBER_MAIA: '+5500000000000',
  OWNER_TELEFONE_WHATSAPP: '+5511111111111',
  OWNER_NOME: 'Benchmark Owner',
  VOYAGE_API_KEY: 'benchmark-voyage-key',
  ALERT_CHANNELS: 'log',
  LLM_DAILY_BUDGET_USD: '0',
  // Em carga, serializar log domina o relógio da medição.
  LOG_LEVEL: 'error',
};

/**
 * Preenche o ambiente ANTES do primeiro import de `@/config/env.js`. Vive
 * dentro de `main()` — e não no topo do módulo — para que importar este
 * arquivo num spec unitário não deixe efeito colateral em `process.env`.
 */
function prepareEnv(collectorUrl: string): void {
  for (const [k, v] of Object.entries(ENV_DEFAULTS)) process.env[k] ??= v;
  process.env.MAIA_OTLP_TRACES_ENDPOINT = collectorUrl;
  process.env.MAIA_OTLP_SAMPLE_RATIO = '1';
  process.env.MAIA_OTLP_SERVICE_NAME ??= 'maia-otlp-bench';
}

type LLMProvider = import('@/lib/llm/types.js').LLMProvider;
type LLMResponse = import('@/lib/llm/types.js').LLMResponse;
type LLMTier = import('@/lib/llm/types.js').LLMTier;
type LLMMessage = import('@/lib/llm/types.js').LLMMessage;
type ToolSchema = import('@/lib/llm/types.js').ToolSchema;

const TOOL_NAME = 'explain_limitation';

/**
 * Provider sintético: mesma interface dos adapters reais, sem rede e sem
 * custo. No cenário `tool` pede `explain_limitation` na primeira chamada que
 * expõe essa tool e ainda não trouxe `tool_result`; responde texto no resto.
 */
class SyntheticProvider implements LLMProvider {
  name = 'anthropic' as const;
  calls = 0;
  constructor(
    private readonly scenario: Scenario,
    private readonly latencyMs: number,
  ) {}
  isConfigured(): boolean {
    return true;
  }
  envDefault(tier: LLMTier): string {
    return tier === 'main' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
  }
  async call(params: { model: string; messages: LLMMessage[]; tools?: ToolSchema[] }): Promise<LLMResponse> {
    this.calls++;
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const usage = { input_tokens: 900, output_tokens: 180 };
    if (this.scenario === 'tool' && params.tools?.some((t) => t.name === TOOL_NAME)) {
      const hasResult = params.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
      );
      if (!hasResult) {
        return {
          content: null,
          tool_uses: [
            {
              id: `toolu_bench_${this.calls}`,
              tool: TOOL_NAME,
              // Args ÚNICOS por chamada: com args iguais o segundo dispatch da
              // mesma pessoa acerta o cache de idempotência (correto em
              // produção) e `idempotency.claim`/`handler.execute` só abrem no
              // primeiro turno de cada slot — o cenário cobriria menos do que
              // promete.
              args: {
                requested: `benchmark ${this.calls}`,
                reason: 'turno sintético do benchmark de overhead',
              },
            },
          ],
          stop_reason: 'tool_use',
          usage,
          model: params.model,
        };
      }
    }
    return { content: 'ok', tool_uses: [], stop_reason: 'end_turn', usage, model: params.model };
  }
}

async function loadDeps() {
  const [core, tenant, correlation, tracer, taxonomy, exporterMod, providers, sink, metrics, config, client] =
    await Promise.all([
      import('@/agent/core.js'),
      import('@/db/tenant-context.js'),
      import('@/observability/correlation.js'),
      import('@/observability/tracer.js'),
      import('@/observability/taxonomy.js'),
      import('@/observability/otlp-exporter.js'),
      import('@/lib/llm/providers/index.js'),
      import('@/probe/sink-guard.js'),
      import('@/lib/metrics.js'),
      import('@/config/env.js'),
      import('@/db/client.js'),
    ]);
  return {
    runAgentForMensagem: core.runAgentForMensagem,
    runWithSystemContext: tenant.runWithSystemContext,
    runWithCorrelation: correlation.runWithCorrelation,
    withSpan: tracer.withSpan,
    setSpanSink: tracer.setSpanSink,
    tracingEnabled: tracer.tracingEnabled,
    SPAN: taxonomy.SPAN,
    METRIC: taxonomy.METRIC,
    OtlpSpanExporter: exporterMod.OtlpSpanExporter,
    fetchTransport: exporterMod.fetchTransport,
    stopOtlpExporter: exporterMod.stopOtlpExporter,
    injectProvider: providers._injectProviderForTests,
    loadSyntheticChannelIds: sink.loadSyntheticChannelIds,
    renderPrometheus: metrics.renderPrometheus,
    config: config.config,
    pool: client.pool,
  };
}
type Deps = Awaited<ReturnType<typeof loadDeps>>;

// ============================================================================
// Massa — copiada de tests/integration/turn-span-tree-hot-path.spec.ts
// ============================================================================

const TENANT = 'primary';
const AGENT = 'primary';

type Slot = {
  pessoa_id: string;
  conversa_id: string;
  channel_id: string;
  entidade_id: string;
  telefone: string;
};

/**
 * Uma pessoa `dono` (isenta do rate limiter, que é fail-closed sem Redis para
 * não-owners), com perfil de audiência ATIVO (pré-condição fail-closed de
 * `resolveIdentity`, #407), conversa própria, canal PRÓPRIO casado por
 * exact-match no telefone (evita o flake de ordem do catch-all, ver o spec) e
 * marcado `is_synthetic = true` — o que faz `buildOutput` roteá-lo para o
 * sink inerte da plataforma —, e a política de canal que o `role-selector`
 * exige. `conversas.channel_id` fica vinculado para que `sendOutbound` nunca
 * caia na resolução de "canal único" (ambígua com vários slots).
 *
 * E UMA entidade com permissão `dono` (`profile_id = 'dono_total'`, o perfil
 * que a migração 002 dá ao papel): sem entidade em escopo o dispatcher devolve
 * `no_entity_in_scope` ANTES do primeiro portão, e o cenário `tool` abriria
 * `tool.dispatch` sem nunca chegar a `constitutional.check`. Foi exatamente o
 * que a primeira corrida deste harness mostrou.
 */
async function seedSlot(pool: Deps['pool'], n: number): Promise<Slot> {
  const c = await pool.connect();
  try {
    const telefone = `+55119${String(Date.now()).slice(-6)}${String(n).padStart(2, '0')}`;
    const p = await c.query<{ id: string }>(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1, $2, $3, $4, 'dono', 'ativa') RETURNING id`,
      [TENANT, AGENT, `Dono bench ${n}`, telefone],
    );
    const pessoa_id = p.rows[0]!.id;
    await c.query(
      `INSERT INTO agent_audience_profiles(tenant_id, agent_id, pessoa_id, audience_type, trust_level, status)
       VALUES ($1, $2, $3, 'owner', 'trusted_internal', 'active') ON CONFLICT DO NOTHING`,
      [TENANT, AGENT, pessoa_id],
    );
    const ch = await c.query<{ id: string }>(
      `INSERT INTO channels(tenant_id, agent_id, channel_type, external_id, display_name, active, is_synthetic)
       VALUES ($1, $2, 'whatsapp', $3, $4, true, true) RETURNING id`,
      [TENANT, AGENT, telefone, `Linha bench ${n}`],
    );
    const channel_id = ch.rows[0]!.id;
    const role = await c.query<{ id: string }>(
      `SELECT id FROM roles WHERE tenant_id = $1 AND agent_id = $2 AND active LIMIT 1`,
      [TENANT, AGENT],
    );
    if (role.rows.length === 0) throw new Error('nenhum role ativo semeado — seed do banco mudou');
    await c.query(
      `INSERT INTO channel_policies(tenant_id, agent_id, channel_id, default_role_id, switch_behavior)
       VALUES ($1, $2, $3, $4, 'free_with_trigger')`,
      [TENANT, AGENT, channel_id, role.rows[0]!.id],
    );
    const conv = await c.query<{ id: string }>(
      `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, status, channel_id)
       VALUES ($1, $2, $3, 'ativa', $4) RETURNING id`,
      [TENANT, AGENT, pessoa_id, channel_id],
    );
    const ent = await c.query<{ id: string }>(
      `INSERT INTO entidades(tenant_id, agent_id, nome, tipo) VALUES ($1, $2, $3, 'pf') RETURNING id`,
      [TENANT, AGENT, `Entidade bench ${n}`],
    );
    const entidade_id = ent.rows[0]!.id;
    await c.query(
      `INSERT INTO permissoes(tenant_id, agent_id, pessoa_id, entidade_id, papel, profile_id,
                              acoes_permitidas, limites, status)
       VALUES ($1, $2, $3, $4, 'dono', 'dono_total', ARRAY[]::text[], '{}'::jsonb, 'ativa')`,
      [TENANT, AGENT, pessoa_id, entidade_id],
    );
    return { pessoa_id, conversa_id: conv.rows[0]!.id, channel_id, entidade_id, telefone };
  } finally {
    c.release();
  }
}

/** Insere `count` inbounds distribuídos pelos slots — FORA do relógio. */
async function seedInbounds(pool: Deps['pool'], slots: Slot[], count: number): Promise<string[][]> {
  const perSlot: string[][] = slots.map(() => []);
  const c = await pool.connect();
  try {
    for (let i = 0; i < count; i++) {
      const s = i % slots.length;
      const slot = slots[s]!;
      const m = await c.query<{ id: string }>(
        `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
         VALUES ($1, $2, $3, 'in', 'texto', $4, $5::jsonb) RETURNING id`,
        [TENANT, AGENT, slot.conversa_id, `me da um resumo do mes (${i})`, JSON.stringify({ telefone: slot.telefone })],
      );
      perSlot[s]!.push(m.rows[0]!.id);
    }
  } finally {
    c.release();
  }
  return perSlot;
}

/**
 * Remove os ARTEFATOS de turno (mensagens, turns, outbound, audit…) mantendo
 * pessoas/conversas/canais, para que todo braço parta do MESMO estado de
 * banco. Ordem = ordem das FKs, copiada do spec.
 */
async function cleanupArtifacts(pool: Deps['pool'], slots: Slot[]): Promise<void> {
  if (slots.length === 0) return;
  const pessoas = slots.map((s) => s.pessoa_id);
  const channels = slots.map((s) => s.channel_id);
  const c = await pool.connect();
  try {
    const doPessoa = `(SELECT id FROM conversas WHERE pessoa_id = ANY($1::uuid[]))`;
    await c.query(
      `DELETE FROM audit_log WHERE pessoa_id = ANY($1::uuid[]) OR conversa_id IN ${doPessoa}`,
      [pessoas],
    );
    await c.query(
      `DELETE FROM agent_turn_inputs WHERE mensagem_id IN (SELECT id FROM mensagens WHERE conversa_id IN ${doPessoa})`,
      [pessoas],
    );
    await c.query(`DELETE FROM outbound_messages WHERE conversa_id IN ${doPessoa}`, [pessoas]);
    await c.query(`DELETE FROM agent_turns WHERE conversa_id IN ${doPessoa}`, [pessoas]);
    await c.query(`DELETE FROM mensagens WHERE conversa_id IN ${doPessoa}`, [pessoas]);
    await c.query(`DELETE FROM pending_questions WHERE conversa_id IN ${doPessoa}`, [pessoas]);
    await c.query(`DELETE FROM role_selector_decisions WHERE channel_id = ANY($1::uuid[])`, [channels]);
    // O cenário `tool` reserva uma chave por dispatch (`idempotency.claim`).
    await c.query(`DELETE FROM idempotency_keys WHERE pessoa_id = ANY($1::uuid[])`, [pessoas]);
  } finally {
    c.release();
  }
}

async function cleanupAll(pool: Deps['pool'], slots: Slot[]): Promise<void> {
  if (slots.length === 0) return;
  await cleanupArtifacts(pool, slots);
  const pessoas = slots.map((s) => s.pessoa_id);
  const channels = slots.map((s) => s.channel_id);
  const c = await pool.connect();
  try {
    await c.query(`DELETE FROM conversas WHERE pessoa_id = ANY($1::uuid[])`, [pessoas]);
    await c.query(`DELETE FROM permissoes WHERE pessoa_id = ANY($1::uuid[])`, [pessoas]);
    await c.query(`DELETE FROM agent_audience_profiles WHERE pessoa_id = ANY($1::uuid[])`, [pessoas]);
    await c.query(`DELETE FROM pessoas WHERE id = ANY($1::uuid[])`, [pessoas]);
    await c.query(`DELETE FROM entidades WHERE id = ANY($1::uuid[])`, [slots.map((s) => s.entidade_id)]);
    await c.query(`DELETE FROM channel_policies WHERE channel_id = ANY($1::uuid[])`, [channels]);
    await c.query(`DELETE FROM channels WHERE id = ANY($1::uuid[])`, [channels]);
  } finally {
    c.release();
  }
}

// ============================================================================
// Um braço
// ============================================================================

type ArmSetup = {
  /** Lê os contadores acumulados durante o braço e desmonta o exporter. */
  teardown(): Promise<{
    sink_calls: number;
    span_counts: Record<string, number>;
    queue_depth_max: number;
    batches: number;
    bytes: number;
    export_samples: number[];
  }>;
};

function setupArm(deps: Deps, arm: ArmName, opts: Options, collector: Collector): ArmSetup {
  collector.reset();
  if (arm === 'off') {
    // O caminho de produção sem endpoint: `tracingEnabled()` curto-circuita no
    // `sink !== null`. Nada é alocado por span.
    deps.setSpanSink(null);
    collector.setMode({ delay_ms: 0, fail_ratio: 0 });
    return {
      teardown: async () => ({
        sink_calls: 0,
        span_counts: {},
        queue_depth_max: 0,
        batches: 0,
        bytes: 0,
        export_samples: [],
      }),
    };
  }
  collector.setMode(
    arm === 'on-slow'
      ? { delay_ms: opts.collector_delay_ms, fail_ratio: opts.collector_fail_ratio }
      : { delay_ms: 0, fail_ratio: 0 },
  );
  let batches = 0;
  let bytes = 0;
  const exportSamples: number[] = [];
  // O transporte REAL (fetch de loopback), embrulhado só num relógio.
  const timed: typeof deps.fetchTransport = async (endpoint, headers, body, signal) => {
    batches++;
    bytes += Buffer.byteLength(body);
    const t0 = performance.now();
    try {
      return await deps.fetchTransport(endpoint, headers, body, signal);
    } finally {
      exportSamples.push(performance.now() - t0);
    }
  };
  const exporter = new deps.OtlpSpanExporter({
    endpoint: deps.config.MAIA_OTLP_TRACES_ENDPOINT!,
    transport: timed,
    maxQueueSize: opts.queue_size,
    serviceName: deps.config.MAIA_OTLP_SERVICE_NAME,
  });
  exporter.start();
  let sinkCalls = 0;
  let queueMax = 0;
  const spanCounts: Record<string, number> = {};
  deps.setSpanSink((span) => {
    sinkCalls++;
    spanCounts[span.name] = (spanCounts[span.name] ?? 0) + 1;
    if (span.name === deps.SPAN.TOOL_DISPATCH) {
      // O desfecho do dispatch vai para o relatório: um `tool.dispatch` que
      // saiu como `error` sem abrir portão nenhum é o cenário `tool` provando
      // menos do que promete, não mais.
      const k = `${span.name}{result=${String(span.attributes.result ?? '?')}}`;
      spanCounts[k] = (spanCounts[k] ?? 0) + 1;
    }
    exporter.enqueue(span);
    if (exporter.pending > queueMax) queueMax = exporter.pending;
  });
  return {
    teardown: async () => {
      deps.setSpanSink(null);
      await exporter.shutdown();
      return {
        sink_calls: sinkCalls,
        span_counts: spanCounts,
        queue_depth_max: queueMax,
        batches,
        bytes,
        export_samples: exportSamples,
      };
    },
  };
}

/**
 * Um turno como o worker o executa: correlação → span raiz `turn` → contexto
 * `system` sancionado → `runAgentForMensagem`. As três camadas são as de
 * `src/gateway/queue.ts`; o `trace_id` é o id da mensagem, como
 * `deriveTraceId` faz com um inbound persistido.
 */
function runTurnLikeTheWorker(deps: Deps, mensagemId: string): Promise<void> {
  return deps.runWithCorrelation({ trace_id: mensagemId }, () =>
    deps.withSpan(
      deps.SPAN.TURN,
      () => deps.runWithSystemContext(() => deps.runAgentForMensagem(mensagemId)),
      { attributes: { queue: 'agent', phase: 'first' } },
    ),
  );
}

/** Um braço numa rodada: o resultado E as amostras brutas (só para o agregado). */
export type RoundRun = { result: ArmResult; latencies: number[]; export_samples: number[] };

async function runArm(
  deps: Deps,
  arm: ArmName,
  round: number,
  opts: Options,
  collector: Collector,
  slots: Slot[],
  provider: SyntheticProvider,
): Promise<RoundRun> {
  await cleanupArtifacts(deps.pool, slots);
  const perSlot = await seedInbounds(deps.pool, slots, opts.turns);

  const metricsBefore = await deps.renderPrometheus();
  const setup = setupArm(deps, arm, opts, collector);
  const tracingEnabled = deps.tracingEnabled();
  const callsBefore = provider.calls;

  const latencies: number[] = [];
  let errors = 0;
  const t0 = performance.now();
  await Promise.all(
    perSlot.map(async (ids) => {
      for (const id of ids) {
        const s = performance.now();
        try {
          await runTurnLikeTheWorker(deps, id);
        } catch {
          errors++;
        }
        latencies.push(performance.now() - s);
      }
    }),
  );
  const wall = performance.now() - t0;

  const tail = await setup.teardown();
  const metricsAfter = await deps.renderPrometheus();
  const col = collector.snapshot();

  latencies.sort((a, b) => a - b);
  const exp = [...tail.export_samples].sort((a, b) => a - b);
  const droppedBefore = counterByLabel(metricsBefore, deps.METRIC.OTLP_SPANS_DROPPED, 'reason');
  const droppedAfter = counterByLabel(metricsAfter, deps.METRIC.OTLP_SPANS_DROPPED, 'reason');
  const exportedBefore = counterByLabel(metricsBefore, deps.METRIC.OTLP_SPANS_EXPORTED, 'status');
  const exportedAfter = counterByLabel(metricsAfter, deps.METRIC.OTLP_SPANS_EXPORTED, 'status');

  const result: ArmResult = {
    arm,
    rounds: [round],
    turns: opts.turns,
    errors,
    provider_calls: provider.calls - callsBefore,
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    p99_ms: percentile(latencies, 99),
    max_ms: latencies[latencies.length - 1] ?? 0,
    mean_ms: latencies.reduce((s, x) => s + x, 0) / Math.max(1, latencies.length),
    wall_ms: wall,
    throughput_turns_per_s: (opts.turns * 1000) / wall,
    tracing_enabled: tracingEnabled,
    sink_calls: tail.sink_calls,
    spans_received: col.spans_accepted,
    spans_rejected: col.spans_rejected,
    batches: tail.batches,
    bytes: tail.bytes,
    export_p50_ms: percentile(exp, 50),
    export_p95_ms: percentile(exp, 95),
    export_max_ms: exp[exp.length - 1] ?? 0,
    exported_ok: diffByLabel(exportedBefore, exportedAfter).ok ?? 0,
    dropped: diffByLabel(droppedBefore, droppedAfter),
    queue_depth_max: tail.queue_depth_max,
    span_counts: tail.span_counts,
    metrics_lines_before: metricLines(metricsBefore).length,
    metrics_lines_after: metricLines(metricsAfter).length,
    families: seriesPorFamilia(metricsAfter),
  };
  return { result, latencies, export_samples: exp };
}

/**
 * Agrega as rodadas de um braço. Percentis sobre a UNIÃO das amostras (mesma
 * janela, alternadas), throughput = turnos totais / soma das paredes. Os
 * contadores somam; a fila máxima é o máximo; `/metrics` vai do primeiro
 * "antes" ao último "depois".
 */
export function aggregateArm(runs: readonly RoundRun[]): ArmResult {
  const results = runs.map((r) => r.result);
  const first = results[0]!;
  const all = runs.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const exp = runs.flatMap((r) => r.export_samples).sort((a, b) => a - b);
  const sum = (f: (a: ArmResult) => number): number => results.reduce((s, a) => s + f(a), 0);
  const dropped: Record<string, number> = {};
  for (const r of results) for (const [k, v] of Object.entries(r.dropped)) dropped[k] = (dropped[k] ?? 0) + v;
  const spanCounts: Record<string, number> = {};
  for (const r of results) for (const [k, v] of Object.entries(r.span_counts)) spanCounts[k] = (spanCounts[k] ?? 0) + v;
  const wall = sum((a) => a.wall_ms);
  const turns = sum((a) => a.turns);
  return {
    ...first,
    rounds: results.flatMap((r) => r.rounds),
    turns,
    errors: sum((a) => a.errors),
    provider_calls: sum((a) => a.provider_calls),
    p50_ms: percentile(all, 50),
    p95_ms: percentile(all, 95),
    p99_ms: percentile(all, 99),
    max_ms: all[all.length - 1] ?? 0,
    mean_ms: all.reduce((s, x) => s + x, 0) / Math.max(1, all.length),
    wall_ms: wall,
    throughput_turns_per_s: (turns * 1000) / Math.max(1, wall),
    tracing_enabled: results.every((r) => r.tracing_enabled),
    sink_calls: sum((a) => a.sink_calls),
    spans_received: sum((a) => a.spans_received),
    spans_rejected: sum((a) => a.spans_rejected),
    batches: sum((a) => a.batches),
    bytes: sum((a) => a.bytes),
    export_p50_ms: percentile(exp, 50),
    export_p95_ms: percentile(exp, 95),
    export_max_ms: exp[exp.length - 1] ?? 0,
    exported_ok: sum((a) => a.exported_ok),
    dropped,
    queue_depth_max: Math.max(0, ...results.map((r) => r.queue_depth_max)),
    span_counts: spanCounts,
    metrics_lines_before: first.metrics_lines_before,
    metrics_lines_after: results[results.length - 1]!.metrics_lines_after,
    families: results[results.length - 1]!.families,
  };
}

/** Ordem dos braços na rodada `r` (0-based): rotação — quadrado latino. */
export function armOrder(arms: readonly ArmName[], round: number): ArmName[] {
  const k = round % arms.length;
  return [...arms.slice(k), ...arms.slice(0, k)];
}

// ============================================================================
// main
// ============================================================================

function thresholdsOf(opts: Options): Thresholds {
  return {
    relative_margin: opts.relative_margin,
    queue_size: opts.queue_size,
    collector_delay_ms: opts.collector_delay_ms,
    collector_fail_ratio: opts.collector_fail_ratio,
  };
}

function emit(opts: Options, report: Report): void {
  process.stdout.write(opts.json ? encodeReport(report) : renderReport(report));
}

export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const t = thresholdsOf(opts);

  if (opts.mode === 'self-test') {
    const arms = syntheticArms(t);
    const injected = applyInjection(arms, opts.inject);
    const verdicts = evaluateGate(arms, t);
    const code = gateExitCode(verdicts, 'self-test');
    emit(opts, {
      mode: 'self-test',
      self_test: true,
      options: opts,
      host: hostInfo(),
      injected,
      per_round: [],
      arms,
      verdicts,
      exit_code: code,
      gate_evaluated: true,
    });
    return code;
  }

  const collector = await startCollector();
  prepareEnv(collector.url);
  const deps = await loadDeps();
  if (deps.config.MAIA_OTLP_TRACES_ENDPOINT !== collector.url) {
    throw new Error(
      `config congelou antes do endpoint: MAIA_OTLP_TRACES_ENDPOINT=${deps.config.MAIA_OTLP_TRACES_ENDPOINT} ≠ ${collector.url}`,
    );
  }
  if (deps.config.MAIA_OTLP_SAMPLE_RATIO !== 1) {
    throw new Error(`MAIA_OTLP_SAMPLE_RATIO=${deps.config.MAIA_OTLP_SAMPLE_RATIO} (esperado 1: pior caso)`);
  }
  // Garante que nenhum exporter de boot está instalado: cada braço instala o seu.
  await deps.stopOtlpExporter();

  const provider = new SyntheticProvider(opts.scenario, opts.llm_latency_ms);
  deps.injectProvider('anthropic', provider);
  deps.injectProvider('openrouter', provider);

  const slots: Slot[] = [];
  try {
    for (let i = 0; i < opts.concurrency; i++) slots.push(await seedSlot(deps.pool, i));
    deps.loadSyntheticChannelIds(slots.map((s) => s.channel_id));

    if (opts.warmup_turns > 0) {
      // O aquecimento percorre TODOS os braços, não só `off`. A primeira
      // corrida deste harness aqueceu só o `off` e o `on-local` da rodada 1
      // pagou sozinho o custo de estrear o caminho de export (JIT de
      // `encodeSpans`/`JSON.stringify`, primeira conexão do `fetch`): p99 de
      // 338 ms contra 203–226 ms nas rodadas seguintes, e o gate reprovou por
      // 4 ms. Mesmas condições para todos os braços é o protocolo; a margem
      // não se mexe.
      const warm = { ...opts, turns: opts.warmup_turns };
      for (const arm of armOrder(opts.arms, 0)) {
        const { result: w } = await runArm(deps, arm, 0, warm, collector, slots, provider);
        if (w.errors === w.turns) {
          throw new Error(
            `aquecimento [${arm}]: TODOS os ${w.turns} turnos falharam — o turno não está chegando ao entry point (banco migrado? seed de roles?)`,
          );
        }
      }
    }

    const runs: RoundRun[] = [];
    for (let r = 0; r < opts.rounds; r++) {
      for (const arm of armOrder(opts.arms, r)) {
        runs.push(await runArm(deps, arm, r + 1, opts, collector, slots, provider));
      }
    }
    const perRound = runs.map((r) => r.result);
    const arms = opts.arms.map((arm) => aggregateArm(runs.filter((r) => r.result.arm === arm)));
    const verdicts = evaluateGate(arms, t);
    const code = gateExitCode(verdicts, opts.mode);
    emit(opts, {
      mode: opts.mode,
      self_test: false,
      options: opts,
      host: hostInfo(),
      injected: [],
      per_round: perRound,
      arms,
      verdicts,
      exit_code: code,
      gate_evaluated: opts.mode !== 'measure',
    });
    return code;
  } finally {
    deps.setSpanSink(null);
    await cleanupAll(deps.pool, slots).catch((err: unknown) => {
      process.stderr.write(`limpeza falhou: ${(err as Error).message}\n`);
    });
    await collector.close().catch(() => undefined);
    await deps.pool.end().catch(() => undefined);
    const { redis } = await import('@/lib/redis.js');
    await redis.quit().catch(() => undefined);
  }
}

/**
 * Só roda `main()` quando este arquivo É o entrypoint — não quando o spec
 * unitário o importa para exercitar `parseArgs`/`evaluateGate`.
 */
export function isDirectInvocation(entry: string | undefined, metaUrl: string): boolean {
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === metaUrl;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(`otlp-overhead-benchmark falhou: ${(err as Error)?.message ?? String(err)}\n`);
      process.exit(2);
    },
  );
}
