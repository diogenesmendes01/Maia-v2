/**
 * Gate de desempenho da carga de contexto do turno — issue #525.
 *
 * ## O que este arquivo é
 *
 * A #525 fechou com o orçamento de round-trips em **13** e a meta em **8**
 * (`TURN_ROUND_TRIP_TARGET`), e o dono condicionou o aceite a uma MEDIÇÃO, não
 * a uma opinião:
 *
 * > "Para #525, 13 ainda não vira orçamento definitivo. O gate deve usar
 * > Postgres real, pool 10, pelo menos 10 tenants concorrentes, braços
 * > cold/warm, zero erros/timeouts, pico por turno ≤6 e p95 de carga de
 * > contexto ≤600 ms e ≤baseline+20%."
 *
 * e, antes disso:
 *
 * > "Para o pool de 10 conexões, o gate será: 50 pares tenant/agente,
 * > concorrência 20, carga representativa com 1/10/100 entidades,
 * > `maia_turn_context_load_duration_ms{phase="loader"}` p95 ≤600 ms, p99 ≤1 s,
 * > zero timeouts e nenhuma saturação contínua do pool por 60 s."
 *
 * Os dois enunciados divergem (10 × 50 pares; o segundo acrescenta
 * concorrência 20 e p99). Este harness implementa o **superconjunto**: 50 pares
 * tenant/agente, concorrência 20, 1/10/100 entidades, braços cold e warm, e
 * mede — em vez de assumir — quantos tenants estiveram DE FATO concorrentes.
 *
 * ## O que ele mede, e o que ele NÃO mede
 *
 *  - **É medição real.** Cada turno chama `buildPrompt` (`src/agent/
 *    prompt-builder.ts`), que é o call site de produção: ele abre o frame do
 *    contador de queries, chama `loadTurnContext` e publica
 *    `maia_turn_context_load_duration_ms{phase="loader"}`. Toda leitura vai ao
 *    Postgres de verdade, pelo pool de verdade (`src/db/client.ts`, `max: 10`),
 *    contra linhas de verdade. Nenhum repositório é substituído por fake — eles
 *    são apenas ENVOLVIDOS por um contador (ver `instrument`), que é o que
 *    permite atribuir cada leitura ao seu turno e medir o pico instantâneo.
 *  - **NÃO é medição de produção.** É um host só, com um Postgres local, sem
 *    latência de rede entre app e banco e sem a carga que o resto do processo
 *    (workers, /metrics, gateway) impõe ao mesmo pool. Os números daqui são o
 *    PISO: em produção a mesma carga custa mais. É por isso que o veredicto
 *    contra o baseline é relativo (+20%) e não só absoluto.
 *
 * Quem citar um número deste harness, cite junto o braço (`cold`/`warm`), a
 * cardinalidade e o host.
 *
 * ## Braços
 *
 * | braço | `FEATURE_TURN_CONTEXT_CACHE` | identidade |
 * |---|---|---|
 * | `cold` | desligado (o default de produção — ver `src/config/generated/fixtures/*.env`) | lida do Postgres em TODO turno |
 * | `warm` | ligado, cache pré-aquecido por par | servida da memória do processo |
 *
 * O braço `cold` é o que o gate defende: é a configuração que roda hoje, e é o
 * pior caso de round-trips. O `warm` existe para quantificar o que o cache vale
 * (exatamente uma query — só o ramo do perfil operacional v2 é cacheável) e
 * para provar que ligá-lo não introduz erro nem estica a cauda.
 *
 * ## Ritmo da carga (`--think-ms`) — e por que ele decide um dos critérios
 *
 * O gerador é de malha FECHADA: `--concurrency` workers, cada um começando o
 * próximo turno assim que o anterior termina. Com `--think-ms 0` isso mantém
 * 20 turnos SEMPRE em voo; como cada turno pode segurar até
 * `TURN_CONTEXT_MAX_CONCURRENT_READS` (6) conexões de um pool de 10, a fila do
 * pool nunca esvazia — por aritmética, não por defeito. Medido neste host
 * (4 vCPU, Postgres local), concorrência 20, braço `cold`:
 *
 * | `--think-ms` | turnos/s | p50 | p95 | amostras do pool saturadas | maior sequência |
 * |---|---|---|---|---|---|
 * | 0   | 90,7  | 187,7 ms | 386,8 ms | 142/142 (100%) | toda a corrida |
 * | 50  | 110,8 | 119,3 ms | 163,0 ms | 143/143 (100%) | toda a corrida |
 * | 150 | 102,1 | 28,8 ms  | 108,7 ms | 99/145 (68%)   | 1,3 s |
 * | 300 | 60,0  | 14,5 ms  | 87,1 ms  | 27/149 (18%)   | 0,3 s |
 * | 600 | 30,9  | 12,7 ms  | 169,8 ms | 18/152 (12%)   | 0,3 s |
 *
 * Duas leituras saem daí. A primeira: o martelo (`0`) entrega MENOS vazão que o
 * ritmo de 150 ms (90,7 contra 102,1 turnos/s) e um p50 6,5× pior — passado o
 * joelho da capacidade, a fila só acrescenta espera. A segunda: o critério
 * "nenhuma saturação contínua do pool por 60 s" NÃO é falsificável em malha
 * fechada sem ritmo, e o default de 150 ms existe para que ele meça o pool em
 * vez de medir a ausência de pausa. Rodar com `--think-ms 0` continua sendo
 * válido — é o perfil de ESTRESSE, e o relatório o traz — mas ali esse
 * veredicto sai vermelho por construção.
 *
 * ## Veredicto legível por máquina
 *
 * Exit code 0 = gate passou; 1 = reprovou; 2 = erro de uso/infra. A tabela de
 * veredictos sai em markdown (ou `--json`) com o número medido ao lado do
 * limite, para que a reprovação diga QUAL critério caiu e por quanto.
 *
 * ## Baseline
 *
 * `scripts/turn-context-baseline.json` guarda o p95 por braço. Não havendo
 * arquivo, o harness DIZ que não há baseline registrado, reporta o critério
 * relativo como `n/a` e grava a corrida atual como baseline inicial quando
 * chamado com `--write-baseline`. Uma corrida de gate NUNCA grava baseline
 * sozinha: baseline é decisão, não efeito colateral.
 *
 * ## Uso
 *
 *   npm run turn:bench                       # medição completa (cold + warm)
 *   npm run turn:bench -- --json
 *   npm run turn:bench -- --sustain-s 60     # perfil de gate (ver runbook)
 *   npm run turn:bench -- --write-baseline
 *   npm run turn:bench -- --self-test --inject p95_ms=900   # prova que o gate reprova
 *   npm run turn:bench -- --cleanup-only     # remove massa órfã de uma corrida abortada
 *
 * | Flag | Default | O que faz |
 * |---|---|---|
 * | `--pairs` | `50` | Pares tenant/agente distintos |
 * | `--concurrency` | `20` | Turnos simultâneos |
 * | `--turns` | `600` | Turnos por braço (mínimo; ver `--sustain-s`) |
 * | `--sustain-s` | `0` | Mantém a carga por N segundos além de `--turns`. O critério "sem saturação contínua do pool por 60 s" só é falsificável com `--sustain-s 60` |
 * | `--think-ms` | `150` | Pausa entre turnos do mesmo worker. **Não é cosmético** — ver "Ritmo da carga" abaixo |
 * | `--arm` | `all` | `cold` · `warm` · `all` |
 * | `--identity` | `profile` | `profile` (perfil v2 ativo) · `legacy` (fallback `self_state`, um round-trip a mais) |
 * | `--timeout-ms` | `5000` | Orçamento por turno. Casa com `connectionTimeoutMillis` do pool |
 * | `--sample-ms` | `100` | Período de amostragem do pool |
 * | `--p95-ms` / `--p99-ms` | `600` / `1000` | Limites do gate |
 * | `--baseline-tolerance` | `0.20` | Folga sobre o p95 do baseline |
 * | `--write-baseline` | — | Grava o p95 medido como novo baseline |
 * | `--self-test` | — | Não toca no banco: avalia o gate sobre valores injetados |
 * | `--inject` | — | `p95_ms=900`, `warm.peak_reads=8`, `cold.errors=1`, … (exige `--self-test`) |
 * | `--json` | — | Saída JSON |
 * | `--cleanup-only` | — | Só remove a massa `bench525-*` e sai |
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// O contrato de config é fail-closed no boot (issue #515). Os valores abaixo
// são os MESMOS de `tests/setup.ts` e só preenchem o que já não veio do
// ambiente — um `.env` real continua vencendo. Precisam existir ANTES do
// primeiro import de `@/config/env.js`, que é por isso que todos os imports do
// projeto abaixo são dinâmicos.
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
  // O cache é ligado/desligado POR BRAÇO em tempo de execução; ligar aqui é o
  // que permite `startTurnContextCacheInvalidationSubscriber()` armar o
  // subscriber antes do braço `warm`.
  FEATURE_TURN_CONTEXT_CACHE: 'true',
  // `llm_gateway.call` e `turn_context.degraded` saem uma vez por turno; em
  // carga, serializar log domina o relógio da medição.
  LOG_LEVEL: 'error',
};
for (const [k, v] of Object.entries(ENV_DEFAULTS)) process.env[k] ??= v;

// ============================================================================
// Opções
// ============================================================================

export type ArmName = 'cold' | 'warm';
const ALL_ARMS: ArmName[] = ['cold', 'warm'];

/** Cardinalidades de escopo que o enunciado do dono fixa. */
export const CARDINALITIES = [1, 10, 100] as const;

export type Thresholds = {
  p95_ms: number;
  p99_ms: number;
  /** `TURN_CONTEXT_MAX_CONCURRENT_READS`. Lido do código, não digitado aqui. */
  max_peak_reads: number;
  min_concurrent_tenants: number;
  /** Saturação contínua do pool que reprova, em ms. */
  saturation_ms: number;
  baseline_tolerance: number;
  pairs: number;
  concurrency: number;
};

type Options = {
  pairs: number;
  concurrency: number;
  turns: number;
  sustain_s: number;
  think_ms: number;
  arms: ArmName[];
  identity: 'profile' | 'legacy';
  timeout_ms: number;
  sample_ms: number;
  thresholds: Thresholds;
  write_baseline: boolean;
  self_test: boolean;
  inject: Record<string, number>;
  json: boolean;
  cleanup_only: boolean;
};

const HERE = dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = join(HERE, 'turn-context-baseline.json');

export type BaselineFile = {
  /** Como o baseline foi obtido — texto livre, escrito por quem gravou. */
  recorded_at: string;
  recorded_by: string;
  host: string;
  note: string;
  options: { pairs: number; concurrency: number; turns: number; identity: string };
  arms: Record<string, { p95_ms: number; p99_ms: number }>;
};

function parseInject(raw: string | undefined): Record<string, number> {
  if (!raw) return {};
  const out: Record<string, number> = {};
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) throw new Error(`--inject inválido: "${part}" (esperado chave=valor)`);
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--inject inválido: "${part}" (valor não numérico)`);
    out[k.trim()] = n;
  }
  return out;
}

export function parseArgs(argv: string[], maxPeakReads: number): Options {
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
  const armRaw = get('arm') ?? 'all';
  const arms =
    armRaw === 'all'
      ? [...ALL_ARMS]
      : armRaw.split(',').map((a) => {
          const t = a.trim();
          if (!ALL_ARMS.includes(t as ArmName)) {
            throw new Error(`--arm inválido: ${t} (esperado ${ALL_ARMS.join(' | ')} | all)`);
          }
          return t as ArmName;
        });
  const identityRaw = get('identity') ?? 'profile';
  if (identityRaw !== 'profile' && identityRaw !== 'legacy') {
    throw new Error(`--identity inválido: ${identityRaw} (esperado profile | legacy)`);
  }
  const self_test = argv.includes('--self-test');
  const inject = parseInject(get('inject'));
  if (Object.keys(inject).length > 0 && !self_test) {
    // Injeção existe para PROVAR que o gate reprova. Deixá-la disponível numa
    // corrida de medição transformaria o gate num carimbo: `--inject p95_ms=1`
    // faria qualquer regressão passar.
    throw new Error('--inject só é aceito junto de --self-test (é a prova do gate, não uma medição)');
  }
  return {
    pairs: num('pairs', 50),
    concurrency: num('concurrency', 20),
    turns: num('turns', 600),
    sustain_s: num('sustain-s', 0),
    think_ms: num('think-ms', 150),
    arms,
    identity: identityRaw,
    timeout_ms: num('timeout-ms', 5_000),
    sample_ms: num('sample-ms', 100),
    thresholds: {
      p95_ms: num('p95-ms', 600),
      p99_ms: num('p99-ms', 1_000),
      max_peak_reads: maxPeakReads,
      min_concurrent_tenants: num('min-tenants', 10),
      saturation_ms: num('saturation-ms', 60_000),
      baseline_tolerance: num('baseline-tolerance', 0.2),
      // A FORMA da carga exigida vem do enunciado do dono, NÃO de `--pairs` /
      // `--concurrency`. Derivá-la das flags tornaria o critério circular:
      // `--pairs 4` aprovaria uma corrida de quatro tenants como se fosse o
      // gate. Quem quiser rodar menor roda — e o gate reprova, dizendo por quê.
      pairs: num('required-pairs', 50),
      concurrency: num('required-concurrency', 20),
    },
    write_baseline: argv.includes('--write-baseline'),
    self_test,
    inject,
    json: argv.includes('--json'),
    cleanup_only: argv.includes('--cleanup-only'),
  };
}

// ============================================================================
// Estatística
// ============================================================================

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

/**
 * Makespan de uma lista de leituras sob um semáforo FIFO de `permits`.
 *
 * É o modelo do `ReadGate` (`src/agent/turn-context/concurrency.ts`): a próxima
 * tarefa começa assim que UM permit vaga. Serve para responder à pergunta do
 * aceite — "quanto valeriam 8 round-trips em vez de 10?" — sem precisar
 * implementar as fusões de tabela: basta re-agendar as MESMAS durações medidas
 * com dois itens a menos.
 */
export function gateMakespan(durations: number[], permits: number): number {
  if (durations.length === 0) return 0;
  const finish = new Array<number>(Math.max(1, permits)).fill(0);
  for (const d of durations) {
    let i = 0;
    for (let j = 1; j < finish.length; j++) if (finish[j]! < finish[i]!) i = j;
    finish[i] = finish[i]! + d;
  }
  return Math.max(...finish);
}

/**
 * Funde os pares de leituras que a #525 lista como candidatos a `UNION ALL`
 * (`docs/architecture/modules/agent.md`): `capabilities ∪ gaps` e
 * `facts ∪ rules`. O custo de uma união sobre duas tabelas indexadas pelo mesmo
 * par (tenant, agent) é modelado como o MAIOR dos dois — otimista de
 * propósito, porque um modelo pessimista responderia a pergunta sozinho.
 */
export function mergeTwoPairs(reads: Array<{ section: string; ms: number }>): number[] {
  const MERGES: Array<[string, string]> = [
    ['capabilities', 'gaps'],
    ['facts', 'rules'],
  ];
  const remaining = reads.map((r) => ({ ...r }));
  for (const [a, b] of MERGES) {
    const ia = remaining.findIndex((r) => r.section === a);
    const ib = remaining.findIndex((r) => r.section === b);
    if (ia === -1 || ib === -1) continue;
    // A leitura fundida FICA NA POSIÇÃO DA PRIMEIRA das duas. Jogá-la para o
    // fim da lista mudaria a ordem FIFO do semáforo e o modelo passaria a medir
    // a reordenação em vez da fusão — foi o que produziu "ganho negativo" na
    // primeira versão deste harness.
    const keep = Math.min(ia, ib);
    const drop = Math.max(ia, ib);
    remaining[keep]!.ms = Math.max(remaining[ia]!.ms, remaining[ib]!.ms);
    remaining.splice(drop, 1);
  }
  return remaining.map((r) => r.ms);
}

// ============================================================================
// Resultado de um braço + veredictos (PUROS — testáveis sem Postgres)
// ============================================================================

export type CardinalityStats = {
  entities: number;
  turns: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
};

export type SectionLatency = {
  section: string;
  reads: number;
  p50_ms: number;
  p95_ms: number;
};

export type ArmResult = {
  arm: ArmName;
  turns: number;
  wall_ms: number;
  concurrency: number;
  pairs_exercised: number;
  /** Máximo de tenants DISTINTOS com turno em voo ao mesmo tempo. */
  max_concurrent_tenants: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  /** p95 estimado pelos buckets do histograma — o que o Grafana vai mostrar. */
  p95_from_histogram_ms: number;
  errors: number;
  timeouts: number;
  error_samples: string[];
  /** Pico de leituras simultâneas DE UM MESMO TURNO. O teto é 6. */
  peak_reads_per_turn: number;
  reads_per_turn_min: number;
  reads_per_turn_max: number;
  pool_max: number;
  pool_saturation_max_streak_ms: number;
  pool_saturated_samples: number;
  pool_samples: number;
  identity_cache: Record<string, number>;
  /** `maia_turn_context_load_duration_ms{phase="loader"}` — count e sum reais. */
  metric_count: number;
  metric_sum_ms: number;
  by_cardinality: CardinalityStats[];
  by_section: SectionLatency[];
  /** Modelo: p95 do makespan das leituras com 10 e com 8 round-trips. */
  modelled_makespan_p95_now_ms: number;
  modelled_makespan_p95_at_8_ms: number;
};

export type Verdict = {
  label: string;
  passed: boolean;
  /** `true` quando o critério não pôde ser avaliado (não reprova, mas avisa). */
  skipped?: boolean;
  detail: string;
};

/**
 * O gate. Função PURA sobre os resultados dos braços — é isto que
 * `tests/unit/turn-context-gate.spec.ts` alimenta com valores sintéticos para
 * provar que ele REPROVA quando deve.
 */
export function evaluateGate(
  arms: ArmResult[],
  th: Thresholds,
  baseline: BaselineFile | null,
): Verdict[] {
  const out: Verdict[] = [];

  for (const a of arms) {
    out.push({
      label: `[${a.arm}] p95 da carga de contexto ≤ ${th.p95_ms} ms`,
      passed: a.p95_ms <= th.p95_ms,
      detail: `p95=${a.p95_ms.toFixed(1)} ms (p50=${a.p50_ms.toFixed(1)} · máx=${a.max_ms.toFixed(1)})`,
    });
    out.push({
      label: `[${a.arm}] p99 da carga de contexto ≤ ${th.p99_ms} ms`,
      passed: a.p99_ms <= th.p99_ms,
      detail: `p99=${a.p99_ms.toFixed(1)} ms`,
    });
    out.push({
      label: `[${a.arm}] zero erros e zero timeouts`,
      passed: a.errors === 0 && a.timeouts === 0,
      detail:
        `erros=${a.errors} · timeouts=${a.timeouts} (orçamento por turno)` +
        (a.error_samples.length ? ` · ex.: ${a.error_samples.slice(0, 2).join(' | ')}` : ''),
    });
    out.push({
      label: `[${a.arm}] pico de leituras simultâneas por turno ≤ ${th.max_peak_reads}`,
      passed: a.peak_reads_per_turn <= th.max_peak_reads,
      detail:
        `pico=${a.peak_reads_per_turn} de um pool de ${a.pool_max} · ` +
        `leituras por turno ${a.reads_per_turn_min}–${a.reads_per_turn_max}`,
    });
    // O outro lado da mesma moeda: baixar o pico serializando passaria no
    // critério acima e jogaria fora tudo o que a #525 comprou. O gate exige que
    // o pico ALCANCE o teto quando há trabalho suficiente para isso.
    out.push({
      label: `[${a.arm}] o gate satura (pico alcança ${th.max_peak_reads}) — não foi "consertado" serializando`,
      passed: a.reads_per_turn_max < th.max_peak_reads || a.peak_reads_per_turn === th.max_peak_reads,
      detail: `pico=${a.peak_reads_per_turn} · leituras por turno até ${a.reads_per_turn_max}`,
    });
    out.push({
      label: `[${a.arm}] ≥ ${th.min_concurrent_tenants} tenants concorrentes de fato`,
      passed: a.max_concurrent_tenants >= th.min_concurrent_tenants,
      detail: `máximo simultâneo=${a.max_concurrent_tenants} · pares exercitados=${a.pairs_exercised}`,
    });

    // "Nenhuma saturação contínua do pool por 60 s".
    //
    // Comparar a maior SEQUÊNCIA com 60 s e mais nada é um falso verde à espera
    // de acontecer, e a primeira corrida deste harness o produziu: numa corrida
    // de 60,1 s o pool ficou saturado em 572 das 572 amostras — 100% do tempo —
    // e a sequência bateu 57,2 s, portanto "< 60 s", portanto verde. A sequência
    // é limitada pela DURAÇÃO da corrida, então esse teste sozinho só pergunta
    // se a corrida foi curta.
    //
    // O critério é, então, o que a frase quer dizer: **o pool tem que DRENAR** —
    // a fila precisa esvaziar pelo menos uma vez — e nunca ficar saturado por
    // 60 s seguidos. Um pool que jamais drena reprova em qualquer duração de
    // corrida; não conseguir observar uma janela inteira de 60 s só é motivo de
    // "não avaliado" quando NADA de errado apareceu.
    const observedFullWindow = a.wall_ms >= th.saturation_ms;
    // "Drenou" é uma contagem EXATA, não uma heurística sobre a duração: se
    // toda amostra viu a fila cheia, a fila nunca esvaziou. Comparar a
    // sequência com uma fração do relógio de parede erra justamente o caso que
    // motivou este critério (57,2 s de sequência em 60,1 s de corrida com
    // 572/572 amostras saturadas passaria por uma folga de 2%).
    const drained = a.pool_samples === 0 || a.pool_saturated_samples < a.pool_samples;
    out.push({
      label: `[${a.arm}] o pool drena (fila esvazia) e nunca fica saturado por ${(th.saturation_ms / 1000).toFixed(0)} s seguidos`,
      passed: drained && a.pool_saturation_max_streak_ms < th.saturation_ms,
      skipped: !observedFullWindow && drained,
      detail:
        `maior sequência saturada=${(a.pool_saturation_max_streak_ms / 1000).toFixed(1)} s de ` +
        `${(a.wall_ms / 1000).toFixed(1)} s · ${a.pool_saturated_samples}/${a.pool_samples} amostras saturadas` +
        (drained ? '' : ' · A FILA NUNCA ESVAZIOU') +
        (observedFullWindow
          ? ''
          : ` · janela de ${(th.saturation_ms / 1000).toFixed(0)} s não observada (use --sustain-s ${(th.saturation_ms / 1000).toFixed(0)})`),
    });

    // A métrica que o enunciado nomeia tem que estar SAINDO. Um harness que
    // medisse com relógio próprio e não olhasse a métrica provaria o
    // desempenho e não provaria o observável — e é o observável que o operador
    // vai ler no Grafana.
    out.push({
      label: `[${a.arm}] \`maia_turn_context_load_duration_ms{phase="loader"}\` observou todos os turnos`,
      passed: a.metric_count === a.turns && a.turns > 0,
      detail: `count=${a.metric_count} · turnos=${a.turns} · p95 pelos buckets≈${a.p95_from_histogram_ms.toFixed(0)} ms`,
    });

    const base = baseline?.arms[a.arm];
    if (!base) {
      out.push({
        label: `[${a.arm}] p95 ≤ baseline + ${(th.baseline_tolerance * 100).toFixed(0)}%`,
        passed: true,
        skipped: true,
        detail:
          'NÃO AVALIADO — NÃO HÁ BASELINE REGISTRADO para este braço. ' +
          'Esta corrida pode ser gravada como baseline inicial com --write-baseline.',
      });
    } else {
      const ceiling = base.p95_ms * (1 + th.baseline_tolerance);
      out.push({
        label: `[${a.arm}] p95 ≤ baseline + ${(th.baseline_tolerance * 100).toFixed(0)}%`,
        passed: a.p95_ms <= ceiling,
        detail:
          `p95=${a.p95_ms.toFixed(1)} ms · baseline=${base.p95_ms.toFixed(1)} ms · ` +
          `teto=${ceiling.toFixed(1)} ms · delta=${(((a.p95_ms - base.p95_ms) / base.p95_ms) * 100).toFixed(1)}%`,
      });
    }
  }

  // Forma da carga: o gate não vale nada se a corrida não exercitou o que o
  // enunciado pediu.
  const worst = arms.reduce<ArmResult | null>((acc, a) => (acc && acc.pairs_exercised <= a.pairs_exercised ? acc : a), null);
  if (worst) {
    out.push({
      label: `carga conforme o enunciado: ${th.pairs} pares tenant/agente, concorrência ${th.concurrency}, entidades ${CARDINALITIES.join('/')}`,
      passed:
        worst.pairs_exercised >= th.pairs &&
        worst.concurrency >= th.concurrency &&
        worst.by_cardinality.length === CARDINALITIES.length &&
        worst.by_cardinality.every((c) => c.turns > 0),
      detail:
        `pares=${worst.pairs_exercised} · concorrência=${worst.concurrency} · ` +
        `cardinalidades=${worst.by_cardinality.map((c) => `${c.entities}:${c.turns}`).join(' ')}`,
    });
  }

  return out;
}

export function gateExitCode(verdicts: Verdict[]): number {
  return verdicts.every((v) => v.passed) ? 0 : 1;
}

/**
 * Aplica `--inject` sobre os resultados ANTES da avaliação. Só existe para o
 * `--self-test`: é assim que se demonstra que o gate reprova sem esperar uma
 * degradação real acontecer.
 */
export function applyInjection(arms: ArmResult[], inject: Record<string, number>): string[] {
  const applied: string[] = [];
  const FIELDS = new Set([
    'p95_ms',
    'p99_ms',
    'errors',
    'timeouts',
    'peak_reads_per_turn',
    'max_concurrent_tenants',
    'pool_saturation_max_streak_ms',
    'pool_samples',
    'pool_saturated_samples',
    'wall_ms',
    'metric_count',
    'pairs_exercised',
    'reads_per_turn_max',
  ]);
  for (const [rawKey, value] of Object.entries(inject)) {
    const dot = rawKey.indexOf('.');
    const armFilter = dot === -1 ? null : rawKey.slice(0, dot);
    const field = dot === -1 ? rawKey : rawKey.slice(dot + 1);
    if (!FIELDS.has(field)) {
      throw new Error(`--inject: campo desconhecido "${field}" (conhecidos: ${[...FIELDS].join(', ')})`);
    }
    let hit = 0;
    for (const a of arms) {
      if (armFilter && a.arm !== armFilter) continue;
      (a as unknown as Record<string, number>)[field] = value;
      hit++;
    }
    if (hit === 0) throw new Error(`--inject: nenhum braço casa com "${armFilter ?? ''}"`);
    applied.push(`${armFilter ?? '*'}.${field}=${value}`);
  }
  return applied;
}

/** Um braço sintético que PASSA em tudo — o ponto de partida do `--self-test`. */
export function syntheticPassingArm(arm: ArmName, th: Thresholds): ArmResult {
  return {
    arm,
    turns: 600,
    wall_ms: 61_000,
    concurrency: th.concurrency,
    pairs_exercised: th.pairs,
    max_concurrent_tenants: th.concurrency,
    p50_ms: 12,
    p95_ms: 40,
    p99_ms: 70,
    max_ms: 120,
    p95_from_histogram_ms: 50,
    errors: 0,
    timeouts: 0,
    error_samples: [],
    peak_reads_per_turn: th.max_peak_reads,
    reads_per_turn_min: 10,
    reads_per_turn_max: 10,
    pool_max: 10,
    pool_saturation_max_streak_ms: 0,
    pool_saturated_samples: 0,
    pool_samples: 610,
    identity_cache: {},
    metric_count: 600,
    metric_sum_ms: 7_200,
    by_cardinality: CARDINALITIES.map((entities) => ({
      entities,
      turns: 200,
      p50_ms: 12,
      p95_ms: 40,
      p99_ms: 70,
      max_ms: 120,
    })),
    by_section: [],
    modelled_makespan_p95_now_ms: 30,
    modelled_makespan_p95_at_8_ms: 29,
  };
}

// ============================================================================
// Instrumentação: quem leu, quando, por qual turno
// ============================================================================

type TurnFrame = {
  id: number;
  tenant: string;
  entities: number;
  inflight: number;
  peak: number;
  reads: Array<{ section: string; ms: number }>;
};

const turnALS = new AsyncLocalStorage<TurnFrame>();

/**
 * Envolve UM método de repositório mantendo a implementação real.
 *
 * Isto não é um mock: `orig.apply` é a query de verdade contra o Postgres de
 * verdade. O wrapper só marca início e fim, para que "pico de leituras
 * simultâneas deste turno" seja uma MEDIÇÃO e não uma dedução a partir do
 * código do gate. Um harness que contasse permits olhando o `ReadGate` provaria
 * que o semáforo conta certo; este prova que o TURNO não passa de seis
 * statements em voo.
 */
function instrument<T extends object>(obj: T, key: keyof T & string, section: string): void {
  const orig = obj[key];
  if (typeof orig !== 'function') return;
  const fn = orig as unknown as (...args: unknown[]) => Promise<unknown>;
  const wrapped = async function wrappedRead(...args: unknown[]): Promise<unknown> {
    const frame = turnALS.getStore();
    if (!frame) return fn.apply(obj, args);
    frame.inflight++;
    if (frame.inflight > frame.peak) frame.peak = frame.inflight;
    // A entrada é registrada no INÍCIO, não no fim: `reads` precisa estar na
    // ordem de ENFILEIRAMENTO para o modelo de makespan reagendar as mesmas
    // tarefas na mesma ordem FIFO que o `ReadGate` usou. Registrar no
    // `finally` daria a ordem de CONCLUSÃO, que é outra coisa.
    const entry = { section, ms: 0 };
    frame.reads.push(entry);
    const t0 = performance.now();
    try {
      return await fn.apply(obj, args);
    } finally {
      frame.inflight--;
      entry.ms = performance.now() - t0;
    }
  };
  (obj as unknown as Record<string, unknown>)[key] = wrapped;
}

// ============================================================================
// Massa de teste
// ============================================================================

/** Prefixo de TUDO que este harness cria. `--cleanup-only` apaga por ele. */
const PREFIX = 'bench525';

type Pair = {
  tenant_id: string;
  agent_id: string;
  pessoa_id: string;
  conversa_id: string;
  entidade_ids: string[];
  /** Linhas REAIS, lidas de volta do banco — o `PromptContext` do turno usa
   *  exatamente o que `core.ts` teria em mãos, não um literal inventado. */
  pessoa: Record<string, unknown>;
  conversa: Record<string, unknown>;
  inbound: Record<string, unknown>;
};

const ENTITIES_PER_PAIR = Math.max(...CARDINALITIES);

/**
 * Tabelas que o harness escreve, na ORDEM DE REMOÇÃO (filhas antes de pais).
 * `entity_states` sai por cascade de `entidades`; `mensagens` sai por cascade
 * de `conversas` — mas removê-las explicitamente torna a limpeza independente
 * do `ON DELETE` e é o que impede que uma corrida abortada deixe massa no banco
 * COMPARTILHADO.
 */
const SEEDED_TABLES = [
  'mensagens',
  'memory_entry',
  'behavioral_hint',
  'agent_facts',
  'learned_rules',
  'agent_capabilities_skill',
  'agent_capability_gaps',
  'agent_operational_profile_versions',
  'self_state',
  'entity_states',
  'entidades',
  'conversas',
  'pessoas',
  'agents',
] as const;

type PgPool = import('pg').Pool;
type PgClient = import('pg').PoolClient;

async function cleanup(c: PgClient): Promise<number> {
  let removed = 0;
  for (const table of SEEDED_TABLES) {
    const r = await c.query(`DELETE FROM ${table} WHERE tenant_id LIKE $1`, [`${PREFIX}-%`]);
    removed += r.rowCount ?? 0;
  }
  const r = await c.query(`DELETE FROM tenants WHERE id LIKE $1`, [`${PREFIX}-%`]);
  removed += r.rowCount ?? 0;
  return removed;
}

/**
 * Semeia UM par tenant/agente com uma carga representativa.
 *
 * "Representativa" aqui significa: mais linhas do que qualquer `LIMIT` do
 * caminho de leitura, para que os budgets (`SECTION_BUDGETS`) realmente cortem
 * e a query pague ordenação em vez de devolver a tabela inteira. Um par com
 * três fatos mede o custo de um índice vazio, não o do turno.
 *
 * Deliberadamente SEM `ANALYZE`: este banco é compartilhado com a suíte, e
 * `ANALYZE` não é desfeito por `ROLLBACK` — reescrever as estatísticas de
 * `entidades` aqui envenenaria o plano de todos os outros specs.
 */
async function seedPair(c: PgClient, index: number, identity: 'profile' | 'legacy'): Promise<Pair> {
  const tenant_id = `${PREFIX}-t${index}`;
  const agent_id = `${PREFIX}-a${index}`;
  await c.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [tenant_id]);
  await c.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [agent_id, tenant_id],
  );

  const pessoa = await c.query<{ id: string }>(
    `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo)
     VALUES ($1, $2, $3, $4, 'dono') RETURNING id`,
    [tenant_id, agent_id, `${PREFIX} Owner ${index}`, `+5511${String(900000000 + index)}`],
  );
  const pessoa_id = pessoa.rows[0]!.id;

  const ents = await c.query<{ id: string }>(
    `INSERT INTO entidades(tenant_id, agent_id, nome, tipo)
     SELECT $1, $2, '${PREFIX}-ent-' || lpad(g::text, 4, '0'), 'pj'
     FROM generate_series(1, $3) g
     RETURNING id`,
    [tenant_id, agent_id, ENTITIES_PER_PAIR],
  );
  const entidade_ids = ents.rows.map((r) => r.id);

  // Estados para um quinto das entidades: a projeção de estado tem cardinalidade
  // MENOR que a de entidades (é por isso que o LEFT JOIN existe), e medir com
  // 1:1 esconderia o `state: null` que o renderer trata.
  await c.query(
    `INSERT INTO entity_states(entidade_id, tenant_id, agent_id, saldo_consolidado, saldo_atualizado_em)
     SELECT unnest($1::uuid[]), $2, $3, '1234.56', now()`,
    [entidade_ids.slice(0, Math.ceil(ENTITIES_PER_PAIR / 5)), tenant_id, agent_id],
  );

  const conversa = await c.query<{ id: string }>(
    `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, escopo_entidades)
     VALUES ($1, $2, $3, $4::uuid[]) RETURNING id`,
    [tenant_id, agent_id, pessoa_id, entidade_ids],
  );
  const conversa_id = conversa.rows[0]!.id;

  // 24 mensagens contra um `SECTION_BUDGETS.history.max_items` de 10: o
  // `ORDER BY created_at DESC LIMIT 10` precisa ter o que descartar.
  await c.query(
    `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, created_at)
     SELECT $1, $2, $3,
            CASE WHEN g % 2 = 0 THEN 'in' ELSE 'out' END,
            'texto',
            '${PREFIX} mensagem de histórico número ' || g || ' com corpo suficiente para o orçamento de bytes da seção de histórico não ser trivial.',
            now() - (g || ' minutes')::interval
     FROM generate_series(1, 24) g`,
    [tenant_id, agent_id, conversa_id],
  );

  // Fatos nos TRÊS escopos que o loader monta: global, pessoa e entidade.
  await c.query(
    `INSERT INTO agent_facts(tenant_id, agent_id, escopo, chave, valor, confianca, fonte)
     SELECT $1, $2, 'global', '${PREFIX}-fato-global-' || g,
            jsonb_build_object('content', '${PREFIX} fato global ' || g), 0.9, 'aprendido'
     FROM generate_series(1, 12) g`,
    [tenant_id, agent_id],
  );
  await c.query(
    `INSERT INTO agent_facts(tenant_id, agent_id, escopo, chave, valor, confianca, fonte)
     SELECT $1, $2, 'pessoa:' || $3, '${PREFIX}-fato-pessoa-' || g,
            jsonb_build_object('content', '${PREFIX} fato de pessoa ' || g), 0.9, 'aprendido'
     FROM generate_series(1, 12) g`,
    [tenant_id, agent_id, pessoa_id],
  );
  await c.query(
    `INSERT INTO agent_facts(tenant_id, agent_id, escopo, chave, valor, confianca, fonte)
     SELECT $1, $2, 'entidade:' || $3, '${PREFIX}-fato-entidade-' || g,
            jsonb_build_object('content', '${PREFIX} fato de entidade ' || g), 0.9, 'aprendido'
     FROM generate_series(1, 8) g`,
    [tenant_id, agent_id, entidade_ids[0]],
  );

  await c.query(
    `INSERT INTO learned_rules(tenant_id, agent_id, tipo, contexto, acao, confianca)
     SELECT $1, $2, 'classificacao', '${PREFIX} contexto ' || g, '${PREFIX} acao ' || g, 0.5 + (g % 5) * 0.1
     FROM generate_series(1, 40) g`,
    [tenant_id, agent_id],
  );

  await c.query(
    `INSERT INTO memory_entry(tenant_id, agent_id, content, memory_type, scope_type, subject_id,
                              sensitivity, proactive_use, mention_allowed)
     SELECT $1, $2, '${PREFIX} memória de agente ' || g, 'preference', 'agent', NULL, 'low', true, true
     FROM generate_series(1, 25) g`,
    [tenant_id, agent_id],
  );
  await c.query(
    `INSERT INTO memory_entry(tenant_id, agent_id, content, memory_type, scope_type, subject_id,
                              sensitivity, proactive_use, mention_allowed)
     SELECT $1, $2, '${PREFIX} memória de interlocutor ' || g, 'preference', 'interlocutor', $3, 'low', true, true
     FROM generate_series(1, 15) g`,
    [tenant_id, agent_id, pessoa_id],
  );
  await c.query(
    `INSERT INTO memory_entry(tenant_id, agent_id, content, memory_type, scope_type, subject_id,
                              sensitivity, proactive_use, mention_allowed)
     SELECT $1, $2, '${PREFIX} memória de conversa ' || g, 'preference', 'conversation', $3, 'low', true, true
     FROM generate_series(1, 15) g`,
    [tenant_id, agent_id, conversa_id],
  );

  await c.query(
    `INSERT INTO behavioral_hint(tenant_id, agent_id, scope_type, subject_id, hint_text, derived_sensitivity)
     SELECT $1, $2, 'agent', NULL, '${PREFIX} hint de agente ' || g, 'low'
     FROM generate_series(1, 15) g`,
    [tenant_id, agent_id],
  );
  await c.query(
    `INSERT INTO behavioral_hint(tenant_id, agent_id, scope_type, subject_id, hint_text, derived_sensitivity)
     SELECT $1, $2, 'interlocutor', $3, '${PREFIX} hint de interlocutor ' || g, 'low'
     FROM generate_series(1, 10) g`,
    [tenant_id, agent_id, pessoa_id],
  );
  await c.query(
    `INSERT INTO behavioral_hint(tenant_id, agent_id, scope_type, subject_id, hint_text, derived_sensitivity)
     SELECT $1, $2, 'conversation', $3, '${PREFIX} hint de conversa ' || g, 'low'
     FROM generate_series(1, 10) g`,
    [tenant_id, agent_id, conversa_id],
  );

  await c.query(
    `INSERT INTO agent_capabilities_skill(tenant_id, agent_id, domain, skill_name, confidence, evidence_count, success_count)
     SELECT $1, $2, 'financeiro', '${PREFIX}-skill-' || g, 0.7, 10, 9
     FROM generate_series(1, 12) g`,
    [tenant_id, agent_id],
  );
  await c.query(
    `INSERT INTO agent_capability_gaps(tenant_id, agent_id, capability_description, tipo, current_level,
                                       frequency_score, severity_score)
     SELECT $1, $2, '${PREFIX} lacuna de capacidade ' || g, 'knowledge',
            CASE WHEN g % 2 = 0 THEN 'mentionable' ELSE 'proposed' END, 3, 3
     FROM generate_series(1, 10) g`,
    [tenant_id, agent_id],
  );

  if (identity === 'profile') {
    await c.query(
      `INSERT INTO agent_operational_profile_versions
         (tenant_id, agent_id, version, status, profile_body, proposed_by, activated_at)
       VALUES ($1, $2, 1, 'active', $3::jsonb, '${PREFIX}', now())`,
      [
        tenant_id,
        agent_id,
        JSON.stringify({
          core_immutable: {
            identity_block: `Você é a Maia do tenant ${tenant_id}.`,
            principles: ['Backend decide, LLM propõe.', 'Nunca invente saldo.'],
          },
          operational_profile: { voice_descriptor: 'Direta, curta, sem floreio.' },
          episodic_temp: { entries: [] },
          growth_backlog: { items: [] },
        }),
      ],
    );
  } else {
    // Sem perfil v2 ativo, `loadIdentity` cai no `self_state` — um round-trip
    // A MAIS por turno, e não cacheável (o publisher não existe).
    await c.query(
      `INSERT INTO self_state(tenant_id, agent_id, versao, system_prompt, resumo_aprendizados, ativa)
       VALUES ($1, $2, 1, $3, $4, true)`,
      [tenant_id, agent_id, `Você é a Maia do tenant ${tenant_id}.`, 'Aprendizados acumulados.'],
    );
  }

  const pessoaRow = await c.query(`SELECT * FROM pessoas WHERE id = $1`, [pessoa_id]);
  const conversaRow = await c.query(`SELECT * FROM conversas WHERE id = $1`, [conversa_id]);
  const inboundRow = await c.query(
    `SELECT * FROM mensagens WHERE conversa_id = $1 AND direcao = 'in'
     ORDER BY created_at DESC LIMIT 1`,
    [conversa_id],
  );

  return {
    tenant_id,
    agent_id,
    pessoa_id,
    conversa_id,
    entidade_ids,
    pessoa: pessoaRow.rows[0] as Record<string, unknown>,
    conversa: conversaRow.rows[0] as Record<string, unknown>,
    inbound: inboundRow.rows[0] as Record<string, unknown>,
  };
}

/**
 * O `PromptContext` do turno.
 *
 * Montado UMA vez por (par, cardinalidade) e reusado: o que está sendo medido é
 * a carga de contexto, e construir o mapa de permissões dentro do relógio
 * mediria o harness. `byEntity` é o que o renderer percorre para escrever o
 * bloco "## Escopo desta conversa" — sem ele o turno renderiza um escopo vazio
 * e a cardinalidade deixa de custar o que custa em produção.
 */
function buildContext(pair: Pair, entities: number): unknown {
  const ids = pair.entidade_ids.slice(0, entities);
  const byEntity = new Map<string, unknown>();
  for (const id of ids) {
    byEntity.set(id, {
      permissao: { id: `${PREFIX}-perm-${id}`, entidade_id: id },
      profile: {
        id: `${PREFIX}-profile`,
        nome: `${PREFIX}-profile`,
        acoes: ['registrar_transacao'],
        limite_default: '100',
      },
      effective_limits: { valor_max: 100 },
    });
  }
  return {
    pessoa: pair.pessoa,
    conversa: pair.conversa,
    scope: { entidades: ids, byEntity },
    inbound: pair.inbound,
    activeRole: null,
    current_role_id: null,
    current_channel_id: null,
    // `undefined` (e não `null`) de propósito: é o caminho MAIS CARO, o que faz
    // o loader resolver a execução de procedimento por conta própria. Medir o
    // caminho barato e reportá-lo como o custo do turno seria escolher o
    // número em vez de medi-lo.
    activeExecution: undefined,
  };
}

// ============================================================================
// main
// ============================================================================

type Deps = Awaited<ReturnType<typeof loadDeps>>;

async function loadDeps() {
  const [
    clientMod,
    loaderMod,
    typesMod,
    promptMod,
    tenantMod,
    metricsMod,
    cacheMod,
    reposMod,
    configMod,
  ] = await Promise.all([
    import('@/db/client.js'),
    import('@/agent/turn-context/loader.js'),
    import('@/agent/turn-context/types.js'),
    import('@/agent/prompt-builder.js'),
    import('@/db/tenant-context.js'),
    import('@/lib/metrics.js'),
    import('@/agent/turn-context/cache.js'),
    import('@/db/repositories.js'),
    import('@/config/env.js'),
  ]);
  return {
    pool: clientMod.pool,
    // Não é o call site do turno (quem mede é `buildPrompt`), mas é importado
    // para o pré-aquecimento e para deixar explícito qual módulo está sob
    // medição.
    loadTurnContext: loaderMod.loadTurnContext,
    MAX_CONCURRENT_READS: typesMod.TURN_CONTEXT_MAX_CONCURRENT_READS,
    buildPrompt: promptMod.buildPrompt,
    runWithTenantContext: tenantMod.runWithTenantContext,
    renderPrometheus: metricsMod.renderPrometheus,
    resetMetrics: metricsMod._resetForTests,
    turnContextCache: cacheMod.turnContextCache,
    startSubscriber: cacheMod.startTurnContextCacheInvalidationSubscriber,
    stopSubscriber: cacheMod.stopTurnContextCacheInvalidationSubscriber,
    repos: reposMod,
    config: configMod.config,
  };
}

function instrumentAll(repos: Deps['repos']): void {
  instrument(repos.operationalProfileVersionsRepo, 'getActive', 'identity');
  instrument(repos.selfStateRepo, 'getActive', 'identity_self_state');
  instrument(repos.mensagensRepo, 'recentInConversation', 'history');
  instrument(repos.entidadesRepo, 'byIdsWithState', 'entities');
  instrument(repos.entityStatesRepo, 'byIds', 'entity_states');
  instrument(repos.factsRepo, 'listMentionableForScopes', 'facts');
  instrument(repos.rulesRepo, 'listActive', 'rules');
  instrument(repos.memoryEntryRepo, 'findRelevant', 'memories');
  instrument(repos.behavioralHintRepo, 'findActiveForScopes', 'hints');
  instrument(repos.capabilitiesSkillRepo, 'listAll', 'capabilities');
  instrument(repos.capabilityGapsRepo, 'listByLevels', 'gaps');
  instrument(repos.procedureExecutionsRepo, 'findActiveForConversa', 'procedure');
  instrument(repos.procedureDefinitionsRepo, 'findById', 'procedure_definition');
}

/**
 * Amostrador do pool. Saturado = alguém esperando por conexão, ou o pool cheio
 * sem nenhuma conexão ociosa. É a grandeza do critério "nenhuma saturação
 * contínua por 60 s" — que é sobre DURAÇÃO, não sobre um pico instantâneo, e
 * por isso o que se guarda é a maior SEQUÊNCIA.
 */
function startPoolSampler(pool: PgPool, periodMs: number): {
  stop: () => { max_streak_ms: number; saturated: number; samples: number };
} {
  let samples = 0;
  let saturated = 0;
  let streak = 0;
  let maxStreak = 0;
  const max = pool.options.max ?? 10;
  const timer = setInterval(() => {
    samples++;
    const isSaturated = pool.waitingCount > 0 || (pool.totalCount >= max && pool.idleCount === 0);
    if (isSaturated) {
      saturated++;
      streak += periodMs;
      if (streak > maxStreak) maxStreak = streak;
    } else {
      streak = 0;
    }
  }, periodMs);
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
      return { max_streak_ms: maxStreak, saturated, samples };
    },
  };
}

/** Lê `count`/`sum` e estima p95 pelos buckets da série nomeada no aceite. */
async function readLoaderHistogram(
  renderPrometheus: Deps['renderPrometheus'],
): Promise<{ count: number; sum: number; p95: number }> {
  const text = await renderPrometheus();
  const METRIC = 'maia_turn_context_load_duration_ms';
  let count = 0;
  let sum = 0;
  const buckets: Array<{ le: number; n: number }> = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith(METRIC)) continue;
    if (!line.includes('phase="loader"')) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (!Number.isFinite(value)) continue;
    if (line.startsWith(`${METRIC}_count`)) count += value;
    else if (line.startsWith(`${METRIC}_sum`)) sum += value;
    else if (line.startsWith(`${METRIC}_bucket`)) {
      const m = /le="([^"]+)"/.exec(line);
      if (!m) continue;
      const le = m[1] === '+Inf' ? Number.POSITIVE_INFINITY : Number(m[1]);
      const existing = buckets.find((b) => b.le === le);
      if (existing) existing.n += value;
      else buckets.push({ le, n: value });
    }
  }
  buckets.sort((a, b) => a.le - b.le);
  // Interpolação linear dentro do bucket, que é exatamente o que
  // `histogram_quantile` do Prometheus faz — é o número que o operador verá.
  const target = count * 0.95;
  let prevLe = 0;
  let prevN = 0;
  let p95 = 0;
  for (const b of buckets) {
    if (b.n >= target) {
      p95 = Number.isFinite(b.le)
        ? prevLe + ((target - prevN) / Math.max(1e-9, b.n - prevN)) * (b.le - prevLe)
        : prevLe;
      break;
    }
    prevLe = Number.isFinite(b.le) ? b.le : prevLe;
    prevN = b.n;
  }
  return { count, sum, p95 };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isTimeoutError(message: string): boolean {
  return /timeout|timed out|ETIMEDOUT/i.test(message);
}

type TurnSample = {
  ms: number;
  entities: number;
  peak: number;
  reads: Array<{ section: string; ms: number }>;
};

async function runArm(
  arm: ArmName,
  opts: Options,
  pairs: Pair[],
  deps: Deps,
): Promise<ArmResult> {
  // `FEATURE_TURN_CONTEXT_CACHE` é lido a CADA `readCached`, então virar a
  // chave entre braços no mesmo processo é suficiente e evita subir dois
  // processos só para trocar um booleano. A mutação é local ao harness e está
  // aqui, à vista, em vez de escondida num `.env` de benchmark.
  (deps.config as unknown as Record<string, boolean>).FEATURE_TURN_CONTEXT_CACHE = arm === 'warm';
  deps.turnContextCache.resetForTests();
  deps.resetMetrics();

  // Um `PromptContext` por (par, cardinalidade), pronto antes do relógio.
  const contexts = new Map<string, unknown>();
  for (let i = 0; i < pairs.length; i++) {
    for (const n of CARDINALITIES) contexts.set(`${i}:${n}`, buildContext(pairs[i]!, n));
  }

  /**
   * UM turno. Chama `buildPrompt` — o call site de PRODUÇÃO (`src/agent/
   * prompt-builder.ts`), que abre o frame do contador de queries, chama
   * `loadTurnContext` e publica `maia_turn_context_load_duration_ms
   * {phase="loader"}`. Medir por aqui, e não chamando o loader direto, é o que
   * faz o número deste harness ser a MESMA grandeza que o gate nomeia: um
   * harness que chamasse o loader e emitisse a métrica por conta própria
   * continuaria verde no dia em que `buildPrompt` parasse de chamar o loader.
   */
  const runTurn = (pairIndex: number, entities: number): Promise<unknown> => {
    const pair = pairs[pairIndex]!;
    const ctx = contexts.get(`${pairIndex}:${entities}`);
    return deps.runWithTenantContext(
      { tenant_id: pair.tenant_id, agent_id: pair.agent_id },
      () => deps.buildPrompt(ctx as Parameters<Deps['buildPrompt']>[0]),
    );
  };

  if (arm === 'warm') {
    // Pré-aquecimento: uma passada por par para popular o cache de identidade.
    // Sem isto o braço "warm" mediria 50 misses no meio da carga e a diferença
    // entre os braços viraria ruído.
    for (let i = 0; i < pairs.length; i++) await runTurn(i, 1);
    deps.resetMetrics();
  }

  const samples: TurnSample[] = [];
  const errorSamples: string[] = [];
  let errors = 0;
  let timeouts = 0;
  let issued = 0;
  let maxConcurrentTenants = 0;
  const inFlightTenants = new Map<string, number>();
  const exercisedPairs = new Set<string>();

  const sampler = startPoolSampler(deps.pool, opts.sample_ms);
  const startedAt = performance.now();
  const sustainMs = opts.sustain_s * 1000;

  const worker = async (): Promise<void> => {
    for (;;) {
      const elapsed = performance.now() - startedAt;
      if (issued >= opts.turns && elapsed >= sustainMs) return;
      const index = issued++;
      const pairIndex = index % pairs.length;
      const pair = pairs[pairIndex]!;
      const entities = CARDINALITIES[index % CARDINALITIES.length]!;
      exercisedPairs.add(pair.tenant_id);

      inFlightTenants.set(pair.tenant_id, (inFlightTenants.get(pair.tenant_id) ?? 0) + 1);
      if (inFlightTenants.size > maxConcurrentTenants) maxConcurrentTenants = inFlightTenants.size;

      const frame: TurnFrame = {
        id: index,
        tenant: pair.tenant_id,
        entities,
        inflight: 0,
        peak: 0,
        reads: [],
      };
      const t0 = performance.now();
      try {
        await turnALS.run(frame, () => runTurn(pairIndex, entities));
        const ms = performance.now() - t0;
        samples.push({ ms, entities, peak: frame.peak, reads: frame.reads });
        if (ms > opts.timeout_ms) timeouts++;
      } catch (err) {
        errors++;
        const message = (err as Error)?.message ?? String(err);
        if (isTimeoutError(message)) timeouts++;
        if (errorSamples.length < 5) errorSamples.push(message);
      } finally {
        const n = (inFlightTenants.get(pair.tenant_id) ?? 1) - 1;
        if (n <= 0) inFlightTenants.delete(pair.tenant_id);
        else inFlightTenants.set(pair.tenant_id, n);
      }
      if (opts.think_ms > 0) await sleep(opts.think_ms);
    }
  };

  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  const wall_ms = performance.now() - startedAt;
  const pool = sampler.stop();

  const all = samples.map((s) => s.ms).sort((a, b) => a - b);
  const hist = await readLoaderHistogram(deps.renderPrometheus);

  const by_cardinality: CardinalityStats[] = CARDINALITIES.map((entities) => {
    const arr = samples.filter((s) => s.entities === entities).map((s) => s.ms).sort((a, b) => a - b);
    return {
      entities,
      turns: arr.length,
      p50_ms: percentile(arr, 50),
      p95_ms: percentile(arr, 95),
      p99_ms: percentile(arr, 99),
      max_ms: arr.length ? arr[arr.length - 1]! : 0,
    };
  });

  const bySection = new Map<string, number[]>();
  for (const s of samples) {
    for (const r of s.reads) {
      const arr = bySection.get(r.section) ?? [];
      arr.push(r.ms);
      bySection.set(r.section, arr);
    }
  }
  const by_section: SectionLatency[] = [...bySection.entries()]
    .map(([section, arr]) => {
      arr.sort((a, b) => a - b);
      return { section, reads: arr.length, p50_ms: percentile(arr, 50), p95_ms: percentile(arr, 95) };
    })
    .sort((a, b) => b.p95_ms - a.p95_ms);

  const makespanNow = samples
    .map((s) => gateMakespan(s.reads.map((r) => r.ms), 6))
    .sort((a, b) => a - b);
  const makespanAt8 = samples
    .map((s) => gateMakespan(mergeTwoPairs(s.reads), 6))
    .sort((a, b) => a - b);

  const readsPerTurn = samples.map((s) => s.reads.length);
  const identity_cache = await readCacheOutcomes(deps.renderPrometheus);

  return {
    arm,
    turns: samples.length,
    wall_ms,
    concurrency: opts.concurrency,
    pairs_exercised: exercisedPairs.size,
    max_concurrent_tenants: maxConcurrentTenants,
    p50_ms: percentile(all, 50),
    p95_ms: percentile(all, 95),
    p99_ms: percentile(all, 99),
    max_ms: all.length ? all[all.length - 1]! : 0,
    p95_from_histogram_ms: hist.p95,
    errors,
    timeouts,
    error_samples: errorSamples,
    peak_reads_per_turn: samples.reduce((m, s) => Math.max(m, s.peak), 0),
    reads_per_turn_min: readsPerTurn.length ? Math.min(...readsPerTurn) : 0,
    reads_per_turn_max: readsPerTurn.length ? Math.max(...readsPerTurn) : 0,
    pool_max: deps.pool.options.max ?? 10,
    pool_saturation_max_streak_ms: pool.max_streak_ms,
    pool_saturated_samples: pool.saturated,
    pool_samples: pool.samples,
    identity_cache,
    metric_count: hist.count,
    metric_sum_ms: hist.sum,
    by_cardinality,
    by_section,
    modelled_makespan_p95_now_ms: percentile(makespanNow, 95),
    modelled_makespan_p95_at_8_ms: percentile(makespanAt8, 95),
  };
}

async function readCacheOutcomes(
  renderPrometheus: Deps['renderPrometheus'],
): Promise<Record<string, number>> {
  const text = await renderPrometheus();
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (!line.startsWith('maia_turn_context_cache_total')) continue;
    const m = /result="([^"]+)"/.exec(line);
    if (!m) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) out[m[1]!] = (out[m[1]!] ?? 0) + value;
  }
  return out;
}

// ============================================================================
// Relatório
// ============================================================================

function fmt(n: number, digits = 1): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function renderReport(
  opts: Options,
  arms: ArmResult[],
  verdicts: Verdict[],
  baseline: BaselineFile | null,
  injected: string[],
): string {
  const head =
    `### Gate de carga de contexto do turno — issue #525\n\n` +
    (injected.length
      ? `> **AUTOTESTE DO GATE — NÃO É MEDIÇÃO.** Valores injetados: \`${injected.join('`, `')}\`.\n` +
        `> Os números abaixo são sintéticos; servem apenas para provar que o gate reprova.\n\n`
      : '') +
    `${opts.pairs} pares tenant/agente · concorrência ${opts.concurrency} · ` +
    `${opts.turns} turnos por braço (mín.)` +
    (opts.sustain_s ? ` · carga sustentada por ${opts.sustain_s}s` : '') +
    ` · entidades ${CARDINALITIES.join('/')} · identidade \`${opts.identity}\`\n` +
    `Pool: \`max=${arms[0]?.pool_max ?? 10}\` (\`src/db/client.ts\`) · ` +
    `teto de leituras por turno: ${opts.thresholds.max_peak_reads} ` +
    `(\`TURN_CONTEXT_MAX_CONCURRENT_READS\`)\n`;

  const rows: string[][] = [
    ['Métrica', ...arms.map((a) => `\`${a.arm}\``)],
    ['---', ...arms.map(() => '---')],
    ['turnos medidos', ...arms.map((a) => String(a.turns))],
    ['duração do braço (s)', ...arms.map((a) => fmt(a.wall_ms / 1000))],
    ['p50 (ms)', ...arms.map((a) => fmt(a.p50_ms))],
    ['**p95 (ms)**', ...arms.map((a) => `**${fmt(a.p95_ms)}**`)],
    ['**p99 (ms)**', ...arms.map((a) => `**${fmt(a.p99_ms)}**`)],
    ['máx (ms)', ...arms.map((a) => fmt(a.max_ms))],
    ['p95 pelos buckets do histograma (ms)', ...arms.map((a) => fmt(a.p95_from_histogram_ms, 0))],
    ['erros', ...arms.map((a) => String(a.errors))],
    ['timeouts', ...arms.map((a) => String(a.timeouts))],
    ['**pico de leituras simultâneas por turno**', ...arms.map((a) => `**${a.peak_reads_per_turn}**`)],
    ['leituras por turno (mín–máx)', ...arms.map((a) => `${a.reads_per_turn_min}–${a.reads_per_turn_max}`)],
    ['tenants concorrentes (máx.)', ...arms.map((a) => String(a.max_concurrent_tenants))],
    ['pares exercitados', ...arms.map((a) => String(a.pairs_exercised))],
    [
      'maior sequência com pool saturado (s)',
      ...arms.map((a) => fmt(a.pool_saturation_max_streak_ms / 1000)),
    ],
    [
      'amostras do pool saturadas',
      ...arms.map((a) => `${a.pool_saturated_samples}/${a.pool_samples}`),
    ],
    [
      'cache de identidade',
      ...arms.map((a) =>
        Object.entries(a.identity_cache)
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([k, v]) => `${k}=${v}`)
          .join(' · ') || '—',
      ),
    ],
    [
      '`maia_turn_context_load_duration_ms{phase="loader"}`',
      ...arms.map((a) => `count=${a.metric_count} · sum=${fmt(a.metric_sum_ms, 0)}ms`),
    ],
  ];
  const table = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');

  const cardinality = [
    '\n#### Por cardinalidade de escopo\n',
    `| braço | entidades | turnos | p50 | p95 | p99 | máx |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
    ...arms.flatMap((a) =>
      a.by_cardinality.map(
        (c) =>
          `| \`${a.arm}\` | ${c.entities} | ${c.turns} | ${fmt(c.p50_ms)} | ${fmt(c.p95_ms)} | ${fmt(c.p99_ms)} | ${fmt(c.max_ms)} |`,
      ),
    ),
  ].join('\n');

  const sections = [
    '\n#### Latência por leitura (onde o tempo do turno mora)\n',
    `| braço | leitura | n | p50 (ms) | p95 (ms) |`,
    `| --- | --- | --- | --- | --- |`,
    ...arms.flatMap((a) =>
      a.by_section.map(
        (s) => `| \`${a.arm}\` | ${s.section} | ${s.reads} | ${fmt(s.p50_ms, 2)} | ${fmt(s.p95_ms, 2)} |`,
      ),
    ),
  ].join('\n');

  const target8 = [
    '\n#### O que ≤8 round-trips valeria (modelo sobre as durações medidas)\n',
    `| braço | makespan p95 hoje (ms) | makespan p95 com 8 leituras (ms) | ganho |`,
    `| --- | --- | --- | --- |`,
    ...arms.map((a) => {
      const gain = a.modelled_makespan_p95_now_ms - a.modelled_makespan_p95_at_8_ms;
      const pct = a.p95_ms > 0 ? (gain / a.p95_ms) * 100 : 0;
      return `| \`${a.arm}\` | ${fmt(a.modelled_makespan_p95_now_ms, 2)} | ${fmt(a.modelled_makespan_p95_at_8_ms, 2)} | ${fmt(gain, 2)} ms (${fmt(pct, 2)}% do p95) |`;
    }),
    '',
    'O modelo reagenda as MESMAS durações medidas sob o mesmo semáforo de 6 permits,',
    'fundindo `capabilities ∪ gaps` e `facts ∪ rules` (os candidatos listados em',
    '`docs/architecture/modules/agent.md`) ao custo do MAIOR dos dois — otimista de propósito.',
  ].join('\n');

  const baselineBlock = baseline
    ? `\n#### Baseline\n\nRegistrado em ${baseline.recorded_at} por \`${baseline.recorded_by}\` (${baseline.host}).\n` +
      `${baseline.note}\n\n` +
      `| braço | p95 do baseline (ms) | p99 do baseline (ms) |\n| --- | --- | --- |\n` +
      Object.entries(baseline.arms)
        .map(([k, v]) => `| \`${k}\` | ${fmt(v.p95_ms)} | ${fmt(v.p99_ms)} |`)
        .join('\n')
    : `\n#### Baseline\n\n**NÃO HÁ BASELINE REGISTRADO.** Nenhum \`${BASELINE_PATH}\` foi encontrado, ` +
      `então o critério "p95 ≤ baseline + ${(opts.thresholds.baseline_tolerance * 100).toFixed(0)}%" ` +
      `NÃO FOI AVALIADO nesta corrida — ele aparece como \`n/a\` na lista de veredictos. ` +
      `Para adotar ESTA corrida como baseline inicial, rode de novo com \`--write-baseline\`; ` +
      `o arquivo gravado diz explicitamente que é a primeira medição e não uma referência histórica.`;

  const verdictBlock =
    '\n\n#### Veredictos\n\n' +
    verdicts
      .map((v) => `- ${v.skipped ? 'n/a  ' : v.passed ? 'OK  ' : 'FALHOU'} — ${v.label}: ${v.detail}`)
      .join('\n');

  return `${head}\n${table}\n${cardinality}\n${sections}\n${target8}\n${baselineBlock}${verdictBlock}\n`;
}

// ============================================================================
// Entrypoint
// ============================================================================

function readBaseline(): BaselineFile | null {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as BaselineFile;
}

function writeBaseline(arms: ArmResult[], opts: Options, existing: BaselineFile | null): void {
  const file: BaselineFile = {
    recorded_at: new Date().toISOString(),
    recorded_by: process.env.USER ?? 'unknown',
    host: `${process.platform} node ${process.versions.node}`,
    note: existing
      ? 'Baseline re-medido. Substitui a referência anterior; o motivo pertence ao PR que fez esta troca.'
      : 'PRIMEIRA MEDIÇÃO — não havia baseline registrado antes desta corrida. ' +
        'Este arquivo não é uma referência histórica: é o ponto zero, e a folga de +20% ' +
        'sobre ele só passa a significar "não regrediu" a partir da PRÓXIMA corrida.',
    options: {
      pairs: opts.pairs,
      concurrency: opts.concurrency,
      turns: opts.turns,
      identity: opts.identity,
    },
    arms: Object.fromEntries(arms.map((a) => [a.arm, { p95_ms: a.p95_ms, p99_ms: a.p99_ms }])),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(file, null, 2)}\n`);
}

export async function main(argv: string[]): Promise<number> {
  // `TURN_CONTEXT_MAX_CONCURRENT_READS` vem do CÓDIGO. Digitar "6" aqui faria o
  // gate concordar consigo mesmo quando alguém mudasse a constante.
  const { TURN_CONTEXT_MAX_CONCURRENT_READS } = await import('@/agent/turn-context/types.js');
  const opts = parseArgs(argv, TURN_CONTEXT_MAX_CONCURRENT_READS);

  // --- autoteste: prova o GATE, não mede nada ------------------------------
  if (opts.self_test) {
    const arms = opts.arms.map((a) => syntheticPassingArm(a, opts.thresholds));
    const injected = applyInjection(arms, opts.inject);
    const baseline = readBaseline();
    const verdicts = evaluateGate(arms, opts.thresholds, baseline);
    const code = gateExitCode(verdicts);
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ self_test: true, injected, options: opts, arms, verdicts, exit_code: code }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(renderReport(opts, arms, verdicts, baseline, injected));
    }
    return code;
  }

  const pg = (await import('pg')).default;
  const seedPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

  if (opts.cleanup_only) {
    const c = await seedPool.connect();
    try {
      const removed = await cleanup(c);
      process.stdout.write(`removidas ${removed} linhas com tenant_id LIKE '${PREFIX}-%'\n`);
    } finally {
      c.release();
      await seedPool.end();
    }
    return 0;
  }

  const deps = await loadDeps();
  instrumentAll(deps.repos);
  deps.startSubscriber();

  let seeded = false;
  const onSignal = (): void => {
    // Um Ctrl-C no meio da carga não pode deixar 13 mil linhas no banco
    // COMPARTILHADO. A limpeza é síncrona-o-suficiente porque roda antes do
    // exit e o pool de seed tem conexões dedicadas.
    if (!seeded) process.exit(130);
    seedPool
      .connect()
      .then(async (c) => {
        try {
          await cleanup(c);
        } finally {
          c.release();
        }
      })
      .catch(() => undefined)
      .finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const c = await seedPool.connect();
    const pairs: Pair[] = [];
    try {
      // Massa órfã de uma corrida anterior abortada envenenaria os escopos.
      await cleanup(c);
      seeded = true;
      for (let i = 0; i < opts.pairs; i++) pairs.push(await seedPair(c, i, opts.identity));
    } finally {
      c.release();
    }

    const arms: ArmResult[] = [];
    for (const arm of opts.arms) arms.push(await runArm(arm, opts, pairs, deps));

    const baselineBefore = readBaseline();
    const verdicts = evaluateGate(arms, opts.thresholds, baselineBefore);
    const code = gateExitCode(verdicts);

    if (opts.write_baseline) writeBaseline(arms, opts, baselineBefore);

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ self_test: false, options: opts, arms, verdicts, exit_code: code }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(renderReport(opts, arms, verdicts, baselineBefore, []));
    }
    return code;
  } finally {
    const c = await seedPool.connect().catch(() => null);
    if (c) {
      try {
        await cleanup(c);
      } finally {
        c.release();
      }
    }
    await seedPool.end().catch(() => undefined);
    await deps.stopSubscriber().catch(() => undefined);
    await deps.pool.end().catch(() => undefined);
    const { redis } = await import('@/lib/redis.js');
    await redis.quit().catch(() => undefined);
  }
}

/**
 * Só roda `main()` quando este arquivo É o entrypoint — não quando um teste o
 * importa para exercitar `evaluateGate` (que é a parte que precisa ser provada
 * sem Postgres).
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
      process.stderr.write(`turn-context-benchmark falhou: ${(err as Error)?.message ?? String(err)}\n`);
      process.exit(2);
    },
  );
}
