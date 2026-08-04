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
 * A/B do MESMO gateway com o disjuntor ligado e desligado, sob a mesma carga
 * sintética, no mesmo processo.
 *
 * ## Uso
 *
 *   npm run llm:bench
 *   npm run llm:bench -- --scenario outage --requests 300 --concurrency 20
 *   npm run llm:bench -- --scenario recovery --json
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
 * | `--breaker` | `both` | `on` · `off` · `both` (both = a tabela antes/depois) |
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
const { _internal: circuitInternal, circuitState } = await import('@/lib/llm/circuit-breaker.js');
const { runWithTenantContext } = await import('@/db/tenant-context.js');
const { estimateLLMCostUsd } = await import('@/lib/cost-ledger.js');
type LLMWorkload = import('@/lib/llm/types.js').LLMWorkload;
type LLMProvider = import('@/lib/llm/types.js').LLMProvider;
type LLMTier = import('@/lib/llm/types.js').LLMTier;
type LLMResponse = import('@/lib/llm/types.js').LLMResponse;

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
  breaker: 'on' | 'off' | 'both';
  json: boolean;
};

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
    breaker: (get('breaker') ?? 'both') as 'on' | 'off' | 'both',
    json: argv.includes('--json'),
  };
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

  constructor(
    private readonly opts: Options,
    private readonly rng: () => number,
  ) {}

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

  private failing(): boolean {
    switch (this.opts.scenario) {
      case 'healthy':
        return false;
      case 'outage':
        return true;
      case 'brownout':
        return this.rng() < this.opts.failure_rate;
      case 'recovery':
        return Date.now() - this.started_at < this.opts.outage_ms;
    }
  }

  async call(params: { model: string }): Promise<LLMResponse> {
    this.calls++;
    // Jitter de ±20% para que os percentis não sejam um único valor.
    await sleep(Math.round(this.opts.latency_ms * (0.8 + this.rng() * 0.4)));
    if (this.failing()) throw providerOutage();
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

/** PRNG com semente: duas execuções do harness comparam a mesma carga. */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

type ArmResult = {
  breaker: 'on' | 'off';
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
};

async function runArm(opts: Options, breaker: 'on' | 'off'): Promise<ArmResult> {
  circuitInternal.reset();
  circuitInternal.setEnabled(breaker === 'on');

  const provider = new SyntheticProvider(opts, seededRng(42));
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
    breaker,
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
  };
}

function fmt(n: number, digits = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function renderTable(opts: Options, arms: ArmResult[]): string {
  const rows = [
    ['Métrica', ...arms.map((a) => `disjuntor ${a.breaker}`)],
    ['---', ...arms.map(() => '---')],
    ['requests de entrada', ...arms.map((a) => String(a.requests))],
    ['**requisições ao provider**', ...arms.map((a) => `**${a.provider_calls}**`)],
    ['amplificação (req/request)', ...arms.map((a) => fmt(a.amplification))],
    ['sucesso', ...arms.map((a) => String(a.ok))],
    ['recusado pelo disjuntor', ...arms.map((a) => String(a.refused))],
    ['erro do provider', ...arms.map((a) => String(a.failed))],
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
  const tenantLine = arms
    .filter((a) => Object.keys(a.refused_by_tenant).length > 0)
    .map(
      (a) =>
        `\nRecusas por tenant (disjuntor ${a.breaker}): ` +
        Object.entries(a.refused_by_tenant)
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([t, n]) => `${t}=${n}`)
          .join(' · ') +
        ' — o estado do disjuntor é por `(provider, workload)`, então a recusa ' +
        'atinge todos os tenants que compartilham o provider. Trade-off documentado ' +
        'em `src/lib/llm/circuit-breaker.ts`.',
    )
    .join('');
  return `${header}\n\n${table}\n${tenantLine}\n`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const arms: ArmResult[] = [];
  const which: Array<'on' | 'off'> =
    opts.breaker === 'both' ? ['off', 'on'] : [opts.breaker];
  for (const breaker of which) arms.push(await runArm(opts, breaker));

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ options: opts, arms }, null, 2)}\n`);
    return;
  }
  process.stdout.write(renderTable(opts, arms));
}

await main();
// O gateway abre pool de Postgres pelo ledger de custo (que falha fechado e
// segue). Nada a drenar aqui: o harness não deixa trabalho pendente.
process.exit(0);
