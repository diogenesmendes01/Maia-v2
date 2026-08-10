/**
 * Harness de carga do LLM Gateway — issue #534.
 *
 * A #508 pediu tabela de p50/p95/p99 e custo, antes e depois. A telemetria que
 * torna isso mensurável já existe desde a PR #531 (`src/lib/llm/telemetry.ts`
 * emite duração, tentativas, tokens, custo e fallback com escopo por
 * tenant/agent) — o que faltava era a MEDIÇÃO. Este arquivo é a medição, e é
 * versionado justamente para que o número possa ser refeito por outra pessoa
 * em vez de acreditado.
 *
 * ## O que ele mede, e o que ele NÃO mede
 *
 * Ele exercita o gateway INTEIRO — resolução de modelo, deadline compartilhado,
 * retry único, fallback, disjuntor, telemetria — contra um provider SINTÉTICO
 * (`SyntheticProvider` abaixo), injetado pelo seam
 * `_injectProviderForTests()`. Isso significa:
 *
 *  - **É medição real** de: quantas requisições o gateway JOGA no provider por
 *    request de entrada (amplificação), latência vista pelo caller, desfechos,
 *    tokens e custo pela mesma tabela de preços do ledger
 *    (`estimateLLMCostUsd`).
 *  - **NÃO é medição** da latência do provider real. O `--latency-ms` é um
 *    parâmetro, não uma observação. Números de p50/p95/p99 contra a Anthropic
 *    ou o OpenRouter exigem chave, rede e dinheiro, e não saem daqui.
 *
 * Quem for citar um número deste harness, cite junto o que ele é: comparação
 * A/B do MESMO gateway em posturas diferentes do disjuntor, sob a mesma carga
 * sintética, no mesmo processo.
 *
 * ## O que a postura `shadow` acrescentou aqui (revisão do owner da #534)
 *
 * O harness passou a rodar TRÊS braços em vez de dois, e a comparação que
 * importa não é mais só "off × enforce". É:
 *
 *  - **`off` × `shadow`** — a prova de que a sombra não muda NADA do que o
 *    caller vê. A sorte de cada requisição é função pura do índice dela (ver
 *    `hashUnit`), então `sucesso`, `erro do provider` e `requisições ao
 *    provider` têm que bater EXATAMENTE nos cenários determinísticos. Qualquer
 *    divergência aí é o bug imperdoável do shadow (transformar chamada boa em
 *    erro), e o harness sai com código 1 em vez de imprimir a tabela e seguir.
 *  - **`shadow.would_reject` × `enforce.recusado`** — a prova de que a sombra
 *    MEDE o que ela promete: o que ela contou como "eu teria recusado" tem que
 *    ser da mesma ordem do que o enforce recusou de verdade.
 *  - **carga que seria cortada** — `off.requisições − enforce.requisições`, que
 *    é a resposta numérica a "quanto isso teria aliviado o provider".
 *
 * E a seção `custo por chamada no hot path`, que mede direto o par
 * `acquireCircuit`/`releaseCircuit` em ns/op nas três posturas — o requisito de
 * "em shadow o disjuntor custa aproximadamente nada" vira número, não promessa.
 *
 * ## Uso
 *
 *   npm run llm:bench
 *   npm run llm:bench -- --scenario outage --requests 300 --concurrency 20
 *   npm run llm:bench -- --scenario recovery --json
 *   npm run llm:bench -- --mode shadow            # um braço só
 *
 * | Flag | Default | O que faz |
 * |---|---|---|
 * | `--scenario` | `outage` | `healthy` · `outage` · `brownout` · `recovery` |
 * | `--requests` | `200` | Requests de ENTRADA (não requisições ao provider) |
 * | `--concurrency` | `10` | Requests simultâneos |
 * | `--workload` | `reasoner` | Qualquer `LLMWorkload`; define retry e fallback |
 * | `--latency-ms` | `25` | Latência base do provider sintético |
 * | `--failure-rate` | `0.6` | Taxa de erro no cenário `brownout` |
 * | `--outage-ms` | `12000` | Duração da queda no cenário `recovery` |
 * | `--tenants` | `3` | Tenants distintos girando na carga |
 * | `--think-ms` | `0` | Pausa entre requests do mesmo worker. Necessário no cenário `recovery`: sem espaçar a carga, os 200 requests terminam antes de a queda acabar e a sonda nunca chega a rodar |
 * | `--mode` | `all` | `off` · `shadow` · `enforce` · `all` |
 * | `--breaker` | — | Alias legado: `off`→`off`, `on`→`enforce`, `both`→`off,enforce` |
 * | `--micro-iterations` | `200000` | Iterações do micro-benchmark de hot path |
 * | `--json` | — | Saída em JSON em vez da tabela markdown |
 */

// O contrato de config é fail-closed no boot (issue #515) e este harness não
// tem `.env` de produção nem deve ter: ele não fala com nada externo. Os
// valores abaixo são os MESMOS de `tests/setup.ts` e só preenchem o que já não
// veio do ambiente — um `.env` real continua vencendo.
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
  // Quota desligada: o harness mede o gateway, não o orçamento — e assim não
  // depende de um Redis de verdade.
  LLM_DAILY_BUDGET_USD: '0',
  // Abaixa o log estruturado: `llm_gateway.call` sai uma vez por request e, em
  // carga, o custo de serializar domina o relógio da medição.
  LOG_LEVEL: 'error',
};
for (const [k, v] of Object.entries(ENV_DEFAULTS)) process.env[k] ??= v;

const { executeLLM } = await import('@/lib/llm/gateway.js');
const { _injectProviderForTests } = await import('@/lib/llm/providers/index.js');
const {
  _internal: circuitInternal,
  acquireCircuit,
  circuitState,
  releaseCircuit,
} = await import('@/lib/llm/circuit-breaker.js');
const { runWithTenantContext } = await import('@/db/tenant-context.js');
const { estimateLLMCostUsd } = await import('@/lib/cost-ledger.js');
const { renderPrometheus, _resetForTests: resetMetrics } = await import('@/lib/metrics.js');
type LLMWorkload = import('@/lib/llm/types.js').LLMWorkload;
type LLMProvider = import('@/lib/llm/types.js').LLMProvider;
type LLMTier = import('@/lib/llm/types.js').LLMTier;
type LLMResponse = import('@/lib/llm/types.js').LLMResponse;
type CircuitMode = import('@/lib/llm/circuit-mode.js').CircuitMode;

type Scenario = 'healthy' | 'outage' | 'brownout' | 'recovery';

type Options = {
  scenario: Scenario;
  requests: number;
  concurrency: number;
  workload: LLMWorkload;
  latency_ms: number;
  failure_rate: number;
  outage_ms: number;
  tenants: number;
  think_ms: number;
  modes: CircuitMode[];
  micro_iterations: number;
  json: boolean;
};

const ALL_MODES: CircuitMode[] = ['off', 'shadow', 'enforce'];

/**
 * `--mode`, com o `--breaker` da #534 preservado como alias.
 *
 * O alias não é cortesia: `--breaker both` está citado em `lib.md` e no runbook,
 * e um harness que quebra a linha de comando documentada obriga quem for
 * reproduzir o número antigo a arqueologia de git.
 */
function parseModes(mode: string | undefined, breaker: string | undefined): CircuitMode[] {
  if (mode !== undefined) {
    if (mode === 'all') return [...ALL_MODES];
    const parts = mode.split(',').map((m) => m.trim());
    for (const p of parts) {
      if (!ALL_MODES.includes(p as CircuitMode)) {
        throw new Error(`--mode inválido: ${p} (esperado ${ALL_MODES.join(' | ')} | all)`);
      }
    }
    return parts as CircuitMode[];
  }
  if (breaker === 'on') return ['enforce'];
  if (breaker === 'off') return ['off'];
  if (breaker === 'both') return ['off', 'enforce'];
  if (breaker !== undefined) throw new Error(`--breaker inválido: ${breaker}`);
  return [...ALL_MODES];
}

function parseArgs(argv: string[]): Options {
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
  return {
    scenario: (get('scenario') ?? 'outage') as Scenario,
    requests: num('requests', 200),
    concurrency: num('concurrency', 10),
    workload: (get('workload') ?? 'reasoner') as LLMWorkload,
    latency_ms: num('latency-ms', 25),
    failure_rate: num('failure-rate', 0.6),
    outage_ms: num('outage-ms', 12_000),
    tenants: num('tenants', 3),
    think_ms: num('think-ms', 0),
    modes: parseModes(get('mode'), get('breaker')),
    micro_iterations: num('micro-iterations', 200_000),
    json: argv.includes('--json'),
  };
}

/**
 * Soma TODAS as séries de um contador, lendo a exposição Prometheus de verdade.
 *
 * Ler a métrica renderizada em vez de um contador próprio do harness é
 * deliberado: prova, de quebra, que a métrica está sendo emitida e passou pelo
 * gate de label da #514. Um número que o harness calculasse sozinho não provaria
 * nada sobre o que o operador vai ver no Grafana.
 */
async function counterTotal(metric: string): Promise<number> {
  const text = await renderPrometheus();
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(metric)) continue;
    const rest = line.slice(metric.length);
    if (rest !== '' && !rest.startsWith('{') && !rest.startsWith(' ')) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Erro no formato dos SDKs (status + headers).
 *
 * O `retry-after` curto é deliberado e não altera NADA do que está sendo
 * medido: `classifyProviderError` lê o header em qualquer status, então o
 * desfecho continua sendo `provider_5xx` retentável e continua alimentando o
 * disjuntor — só o relógio do backoff encurta, para que a corrida termine em
 * segundos em vez de dezenas de minutos. A amplificação (requisições por
 * request) é EXATAMENTE a mesma.
 */
function providerOutage(): Error {
  const err = new Error('synthetic upstream failure') as Error & {
    status: number;
    headers: Record<string, string>;
  };
  err.status = 503;
  err.headers = { 'retry-after': '0.01' };
  return err;
}

/**
 * Provider sintético: mesma interface dos adapters reais, sem rede e sem
 * custo. Conta cada requisição que o gateway manda — que é a variável
 * dependente do experimento.
 */
class SyntheticProvider implements LLMProvider {
  name = 'anthropic' as const;
  calls = 0;
  tokens_input = 0;
  tokens_output = 0;
  private started_at = Date.now();

  constructor(private readonly opts: Options) {}

  isConfigured(): boolean {
    return true;
  }

  /**
   * Slugs REAIS da tabela de preços do ledger — é o que faz o custo reportado
   * ser calculado com a mesma aritmética que o `cost-ledger.ts` usaria.
   */
  envDefault(tier: LLMTier): string {
    return tier === 'main' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
  }

  private failing(index: number): boolean {
    switch (this.opts.scenario) {
      case 'healthy':
        return false;
      case 'outage':
        return true;
      case 'brownout':
        return hashUnit(index, 0x5eed) < this.opts.failure_rate;
      case 'recovery':
        return Date.now() - this.started_at < this.opts.outage_ms;
    }
  }

  async call(params: { model: string }): Promise<LLMResponse> {
    const index = this.calls++;
    // Jitter de ±20% para que os percentis não sejam um único valor.
    await sleep(Math.round(this.opts.latency_ms * (0.8 + hashUnit(index, 0xbeef) * 0.4)));
    if (this.failing(index)) throw providerOutage();
    const usage = { input_tokens: 900, output_tokens: 180 };
    this.tokens_input += usage.input_tokens;
    this.tokens_output += usage.output_tokens;
    return {
      content: 'ok',
      tool_uses: [],
      stop_reason: 'end_turn',
      usage,
      model: params.model,
    };
  }
}

/**
 * Ruído determinístico em `[0,1)`, função pura do ÍNDICE da requisição.
 *
 * Um PRNG com estado mutável não serve aqui, e o `recovery` mostrou por quê: a
 * ordem em que os workers concorrentes consomem os sorteios muda entre braços,
 * então o mesmo índice de requisição pegava sorteios diferentes e os braços
 * deixavam de ser comparáveis. Indexando o ruído, a n-ésima requisição do braço
 * `off` e a n-ésima do braço `shadow` recebem exatamente a mesma sorte — que é
 * o que faz a igualdade de desfechos ser uma AFIRMAÇÃO sobre a sombra, e não
 * sobre o escalonador.
 */
function hashUnit(index: number, salt: number): number {
  let h = (index ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x1_0000_0000;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

type ArmResult = {
  mode: CircuitMode;
  requests: number;
  ok: number;
  refused: number;
  failed: number;
  provider_calls: number;
  amplification: number;
  wall_ms: number;
  p50: number;
  p95: number;
  p99: number;
  tokens_input: number;
  tokens_output: number;
  cost_usd: number;
  final_state: string;
  refused_by_tenant: Record<string, number>;
  /** `maia_llm_circuit_would_reject_total` — só existe em `shadow`. */
  would_reject: number;
  /** `maia_llm_circuit_would_open_total` — só existe em `shadow`. */
  would_open: number;
  /** `maia_llm_circuit_short_circuited_total` — só existe em `enforce`. */
  short_circuited: number;
};

async function runArm(opts: Options, mode: CircuitMode): Promise<ArmResult> {
  circuitInternal.reset();
  circuitInternal.setMode(mode);
  // Contadores zerados por braço: os totais lidos abaixo são DESTE braço.
  resetMetrics();

  const provider = new SyntheticProvider(opts);
  _injectProviderForTests('anthropic', provider);

  const latencies: number[] = [];
  const refusedByTenant: Record<string, number> = {};
  let ok = 0;
  let refused = 0;
  let failed = 0;
  let next = 0;

  const startedAt = Date.now();
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= opts.requests) return;
      const tenant = `tenant-${i % opts.tenants}`;
      const t0 = Date.now();
      try {
        await runWithTenantContext({ tenant_id: tenant, agent_id: 'bench' }, () =>
          executeLLM({
            workload: opts.workload,
            system: 'benchmark system prompt',
            messages: [{ role: 'user', content: 'benchmark turn' }],
          }),
        );
        ok++;
      } catch (err) {
        if ((err as { kind?: string }).kind === 'circuit_open') {
          refused++;
          refusedByTenant[tenant] = (refusedByTenant[tenant] ?? 0) + 1;
        } else {
          failed++;
        }
      } finally {
        latencies.push(Date.now() - t0);
      }
      if (opts.think_ms > 0) await sleep(opts.think_ms);
    }
  };

  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  const wall = Date.now() - startedAt;
  latencies.sort((a, b) => a - b);

  // Mesma tabela de preços que o ledger usa para registrar gasto real.
  const cost = await estimateLLMCostUsd({
    model: provider.envDefault('main'),
    tokens_input: provider.tokens_input,
    tokens_output: provider.tokens_output,
  });

  return {
    mode,
    requests: opts.requests,
    ok,
    refused,
    failed,
    provider_calls: provider.calls,
    amplification: provider.calls / opts.requests,
    wall_ms: wall,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    tokens_input: provider.tokens_input,
    tokens_output: provider.tokens_output,
    cost_usd: cost,
    final_state: circuitState({ provider: 'anthropic', workload: opts.workload }),
    refused_by_tenant: refusedByTenant,
    would_reject: await counterTotal('maia_llm_circuit_would_reject_total'),
    would_open: await counterTotal('maia_llm_circuit_would_open_total'),
    short_circuited: await counterTotal('maia_llm_circuit_short_circuited_total'),
  };
}

type MicroResult = { mode: CircuitMode; ns_per_call: number };

/**
 * Custo do disjuntor no hot path, isolado do resto do gateway.
 *
 * A tabela de carga NÃO consegue responder isto: com 25ms de latência sintética
 * por requisição, a diferença entre as posturas some no ruído. Aqui roda-se só
 * o par `acquireCircuit`/`releaseCircuit` — que é literalmente tudo o que o
 * disjuntor acrescenta a uma chamada — contra um disjuntor FECHADO, que é o
 * estado em que ele passa 99,9% do tempo.
 */
function runMicro(opts: Options, mode: CircuitMode): MicroResult {
  const key = { provider: 'anthropic', workload: opts.workload };
  const round = (): number => {
    circuitInternal.reset();
    circuitInternal.setMode(mode);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < opts.micro_iterations; i++) {
      releaseCircuit(acquireCircuit(key), 'ok');
    }
    return Number(process.hrtime.bigint() - t0) / opts.micro_iterations;
  };

  // Aquecimento: o JIT precisa ver o caminho antes de a gente cronometrar.
  round();
  // MENOR de cinco rodadas, não a média: GC e escalonador só sabem somar tempo,
  // então o mínimo é a estimativa menos poluída do custo real. Sem isto, a
  // mesma postura variava ~15% entre execuções e o número não servia para
  // comparar nada.
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 5; i++) best = Math.min(best, round());
  circuitInternal.reset();
  return { mode, ns_per_call: best };
}

/**
 * Os veredictos que fazem deste harness uma PROVA e não um relatório.
 *
 * `passed: false` derruba o processo com exit code 1 — um harness que imprime
 * "shadow perdeu 3 chamadas" numa tabela bonita e sai com 0 não serve para
 * nada, porque é exatamente esse número que ninguém lê.
 */
type Verdict = { label: string; passed: boolean; detail: string };

/**
 * Onde a igualdade byte a byte entre braços é exigível — e por que não é em
 * todo lugar.
 *
 * Em `healthy` e `outage` o veredicto do provider é o mesmo para TODA
 * requisição, então não importa qual worker pegou qual índice: os braços são
 * comparáveis exatamente. Nos outros dois a sorte depende de qual requisição
 * recebeu qual índice (`brownout`) ou de que lado da fronteira da queda ela
 * caiu (`recovery`), e sob concorrência real isso não se repete — o backoff do
 * gateway usa `Math.random()` e o event loop não promete ordem. Exigir
 * igualdade ali seria exigir que a sombra consertasse o escalonador; a folga
 * abaixo é a medida honesta.
 *
 * Consequência prática: quem quiser a prova FORTE de que a sombra não muda
 * desfecho, rode `--scenario outage` (é o default) — que também é o cenário em
 * que a sombra tem mais chance de errar, porque é onde ela fica aberta o tempo
 * todo.
 */
const DETERMINISTIC_SCENARIOS: readonly Scenario[] = ['healthy', 'outage'];

function verdicts(opts: Options, arms: ArmResult[]): Verdict[] {
  const by = (m: CircuitMode): ArmResult | undefined => arms.find((a) => a.mode === m);
  const off = by('off');
  const shadow = by('shadow');
  const enforce = by('enforce');
  const out: Verdict[] = [];

  if (off && shadow) {
    const deterministic = DETERMINISTIC_SCENARIOS.includes(opts.scenario);
    // O requisito imperdoável: mesma carga, mesma sorte, mesmos desfechos.
    const exact =
      off.ok === shadow.ok &&
      off.failed === shadow.failed &&
      off.provider_calls === shadow.provider_calls;
    // Fora dos determinísticos, 5% de folga sobre a grandeza medida — a
    // divergência de requisições ao provider é a de CHAMADAS multiplicada pelo
    // orçamento de tentativas, então ela precisa da própria escala.
    const outTol = Math.max(2, Math.ceil(off.requests * 0.05));
    const callTol = Math.max(2, Math.ceil(off.provider_calls * 0.05));
    const close =
      Math.abs(off.ok - shadow.ok) <= outTol &&
      Math.abs(off.failed - shadow.failed) <= outTol &&
      Math.abs(off.provider_calls - shadow.provider_calls) <= callTol;
    out.push({
      label: deterministic
        ? 'shadow não altera NENHUM desfecho visível ao caller (vs `off`)'
        : `shadow não altera desfecho além do ruído do cenário (±${outTol} chamadas, ±${callTol} requisições)`,
      passed: off.refused === 0 && shadow.refused === 0 && (deterministic ? exact : close),
      detail:
        `sucesso ${off.ok}→${shadow.ok} · erro ${off.failed}→${shadow.failed} · ` +
        `recusado ${off.refused}→${shadow.refused} · ` +
        `requisições ao provider ${off.provider_calls}→${shadow.provider_calls}` +
        (deterministic
          ? ''
          : ' — cenário não reproduzível chamada a chamada, ver DETERMINISTIC_SCENARIOS'),
    });
  }

  if (shadow) {
    out.push({
      label: 'shadow nunca recusa',
      passed: shadow.refused === 0 && shadow.short_circuited === 0,
      detail: `recusas=${shadow.refused} · short_circuited=${shadow.short_circuited}`,
    });
  }

  if (shadow && enforce) {
    // Fidelidade: a sombra tem que chegar ao MESMO estado final, e o que ela
    // contou como "eu teria recusado" tem que ser da ordem do que o enforce
    // recusou. Não exigimos igualdade exata: o enforce recusa em ~0ms e por
    // isso escoa a fila mais rápido, então a carga que chega no mesmo relógio
    // não é idêntica. Exigir igualdade aqui seria exigir que a sombra mentisse.
    const ratio = enforce.refused === 0 ? 1 : shadow.would_reject / enforce.refused;
    out.push({
      label: 'shadow MEDE o que o enforce faria (would_reject ≈ recusas reais)',
      passed: enforce.refused === 0 ? shadow.would_reject === 0 : ratio >= 0.5 && ratio <= 1.5,
      detail:
        `would_reject=${shadow.would_reject} · recusas em enforce=${enforce.refused} · ` +
        `razão=${ratio.toFixed(2)} · estado final ${shadow.final_state}/${enforce.final_state}`,
    });
  }

  if (off && enforce) {
    const shed = off.provider_calls - enforce.provider_calls;
    // Este veredicto é a MEDIDA que a issue pede ("quanta carga isso teria
    // shed"), não um limiar de qualidade: num brownout o disjuntor não abre de
    // propósito e o corte é ~0, com o sinal indo para qualquer lado dentro do
    // ruído. O que ele reprova é o disjuntor ADICIONANDO carga, que seria bug.
    const tol = Math.max(2, Math.ceil(off.provider_calls * 0.05));
    out.push({
      label: 'carga que o enforce corta do provider',
      passed: shed >= -tol,
      detail:
        `${shed} requisições (${off.provider_calls} → ${enforce.provider_calls}, ` +
        `${((-shed / Math.max(1, off.provider_calls)) * 100).toFixed(1)}%)`,
    });
  }

  return out;
}

function fmt(n: number, digits = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function renderTable(
  opts: Options,
  arms: ArmResult[],
  micro: MicroResult[],
  checks: Verdict[],
): string {
  const rows = [
    ['Métrica', ...arms.map((a) => `\`${a.mode}\``)],
    ['---', ...arms.map(() => '---')],
    ['requests de entrada', ...arms.map((a) => String(a.requests))],
    ['**requisições ao provider**', ...arms.map((a) => `**${a.provider_calls}**`)],
    ['amplificação (req/request)', ...arms.map((a) => fmt(a.amplification))],
    ['sucesso', ...arms.map((a) => String(a.ok))],
    ['recusado pelo disjuntor', ...arms.map((a) => String(a.refused))],
    ['erro do provider', ...arms.map((a) => String(a.failed))],
    ['`would_reject` (sombra)', ...arms.map((a) => String(a.would_reject))],
    ['`would_open` (sombra)', ...arms.map((a) => String(a.would_open))],
    ['`short_circuited` (real)', ...arms.map((a) => String(a.short_circuited))],
    ['p50 (ms)', ...arms.map((a) => String(a.p50))],
    ['p95 (ms)', ...arms.map((a) => String(a.p95))],
    ['p99 (ms)', ...arms.map((a) => String(a.p99))],
    ['duração total (ms)', ...arms.map((a) => String(a.wall_ms))],
    ['tokens in/out', ...arms.map((a) => `${a.tokens_input}/${a.tokens_output}`)],
    ['custo (USD)', ...arms.map((a) => fmt(a.cost_usd, 4))],
    ['estado final do disjuntor', ...arms.map((a) => a.final_state)],
  ];
  const table = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  const header =
    `### LLM Gateway — cenário \`${opts.scenario}\`, workload \`${opts.workload}\`\n\n` +
    `${opts.requests} requests · concorrência ${opts.concurrency} · ${opts.tenants} tenants · ` +
    `latência sintética ${opts.latency_ms}ms` +
    (opts.scenario === 'brownout' ? ` · falha ${opts.failure_rate}` : '') +
    (opts.scenario === 'recovery' ? ` · queda de ${opts.outage_ms}ms` : '') +
    (opts.think_ms > 0 ? ` · pausa de ${opts.think_ms}ms entre requests` : '');

  const microTable = [
    `\n#### Custo por chamada no hot path (${opts.micro_iterations.toLocaleString('en-US')} iterações, disjuntor fechado)\n`,
    '| postura | ns por chamada |',
    '| --- | --- |',
    ...micro.map((m) => `| \`${m.mode}\` | ${fmt(m.ns_per_call, 1)} |`),
  ].join('\n');

  const verdictBlock = checks.length
    ? '\n\n#### Veredictos\n\n' +
      checks.map((c) => `- ${c.passed ? 'OK' : 'FALHOU'} — ${c.label}: ${c.detail}`).join('\n')
    : '';

  const tenantLine = arms
    .filter((a) => Object.keys(a.refused_by_tenant).length > 0)
    .map(
      (a) =>
        `\nRecusas por tenant (postura \`${a.mode}\`): ` +
        Object.entries(a.refused_by_tenant)
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([t, n]) => `${t}=${n}`)
          .join(' · ') +
        ' — o estado do disjuntor é por `(provider, workload)`, então a recusa ' +
        'atinge todos os tenants que compartilham o provider. Trade-off documentado ' +
        'em `src/lib/llm/circuit-breaker.ts`.',
    )
    .join('');

  return `${header}\n\n${table}\n${microTable}${verdictBlock}\n${tenantLine}\n`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // O micro-benchmark roda ANTES dos braços de carga, de propósito: 200 requests
  // com concorrência 10 deixam o heap sujo e o GC entra no meio da medição de
  // nanossegundos. Medir primeiro é a diferença entre um número comparável entre
  // posturas e um número que só descreve o coletor de lixo.
  const micro = opts.modes.map((mode) => runMicro(opts, mode));

  const arms: ArmResult[] = [];
  for (const mode of opts.modes) arms.push(await runArm(opts, mode));
  const checks = verdicts(opts, arms);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ options: opts, arms, micro, checks }, null, 2)}\n`);
  } else {
    process.stdout.write(renderTable(opts, arms, micro, checks));
  }
  // Exit code é parte do contrato: `npm run llm:bench` numa esteira precisa
  // falhar quando a sombra deixou de ser sombra.
  process.exit(checks.every((c) => c.passed) ? 0 : 1);
}

await main();
// O gateway abre pool de Postgres pelo ledger de custo (que falha fechado e
// segue). Nada a drenar aqui: o harness não deixa trabalho pendente.
process.exit(0);
