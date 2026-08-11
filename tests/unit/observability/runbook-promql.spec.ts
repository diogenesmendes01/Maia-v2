/**
 * Guarda de deriva entre a PromQL dos RUNBOOKS e as séries que o código de
 * fato emite — achado 6 (Medium) da re-review do owner na PR #541.
 *
 * ## O defeito que esta suíte trava
 *
 * `docs/runbooks/operational.md` mandava o operador agrupar
 * `maia_llm_calls_total` por `workload`. Essa métrica legada carrega apenas
 * `provider`, `model` e `status` (`src/lib/llm/telemetry.ts`): a consulta
 * **não roda** — devolve um grupo com tudo somado, ou nada. E o mesmo runbook
 * usava `status="error"` como "a falha que abre o disjuntor", quando `timeout`
 * é um status PRÓPRIO e é um dos três `PROVIDER_FAULT_KINDS`. Os critérios de
 * promoção `shadow` → `enforce` — a decisão de começar a recusar tráfego de
 * verdade — estavam apoiados em duas consultas que ninguém tinha executado.
 *
 * Uma consulta errada num runbook é pior que nenhuma: ela PARECE cobertura, o
 * plantão a cola no Prometheus no meio do incidente, vê "no data", e conclui a
 * coisa errada.
 *
 * ## Por que os rótulos vêm do RUNTIME, e não de uma lista escrita à mão
 *
 * `slo-rules.spec.ts` e `dashboards.spec.ts` já checam NOMES de métrica contra
 * a taxonomia. Isso não bastaria aqui: `maia_llm_calls_total` existe, o nome
 * está certo, e a consulta continua quebrada — o defeito está no RÓTULO. Uma
 * lista de rótulos por métrica escrita à mão neste arquivo teria exatamente o
 * mesmo problema que ela existe para pegar: derivar do runbook, em silêncio.
 *
 * Então os emissores são EXERCITADOS de verdade (telemetria do gateway,
 * disjuntor, postura, kill switch), com `@/lib/metrics.js` — o transporte, onde
 * TODA emissão desemboca, inclusive depois do gate de rótulos da #514 — trocado
 * por espiões. O conjunto de rótulos de cada série é o que chegou lá.
 *
 * ## O que NÃO se afirma aqui
 *
 * Que a consulta devolve o número certo: para isso é preciso um Prometheus com
 * dados. O que se afirma é que ela é EXECUTÁVEL contra as séries reais — nome
 * que existe, rótulo que existe naquela série, valor que aquele rótulo assume.
 * É a classe inteira de defeito do achado 6.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { resolve } from 'node:path';
import { METRIC_NAMES, ALLOWED_LABEL_KEYS } from '../../../src/observability/taxonomy.js';

const {
  anthropicCreateMock,
  getSettingsMock,
  recordCostMock,
  incCounterMock,
  observeHistogramMock,
  setGaugeProviderMock,
  recordCircuitAuditMock,
} = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(),
  getSettingsMock: vi.fn(),
  recordCostMock: vi.fn(async () => undefined),
  incCounterMock: vi.fn(),
  observeHistogramMock: vi.fn(),
  setGaugeProviderMock: vi.fn(),
  recordCircuitAuditMock: vi.fn(),
}));

/** A trilha durável puxa `@/db/client.js`, que abre pool. Spec de unidade. */
vi.mock('@/lib/llm/circuit-audit.js', () => ({
  recordCircuitAudit: recordCircuitAuditMock,
  drainCircuitAudits: vi.fn(async () => undefined),
  REPLICA_METADATA_KEY: 'replica',
  _internal: { pendingCount: () => 0, replicaIdentity: () => 'test:0#0' },
}));

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn(function (this: unknown) {
    return { messages: { create: anthropicCreateMock } };
  });
  return { default: Anthropic };
});

vi.mock('openai', () => {
  const OpenAI = vi.fn(function (this: unknown) {
    return { chat: { completions: { create: vi.fn() } } };
  });
  return { default: OpenAI };
});

vi.mock('@/lib/llm-settings.js', () => ({
  getCurrentLLMSettings: getSettingsMock,
  getCurrentMainModel: vi.fn(),
  getCurrentFastModel: vi.fn(),
}));

vi.mock('@/lib/cost-ledger.js', () => ({
  recordLLMCost: recordCostMock,
  estimateLLMCostUsd: vi.fn(async () => 0),
  readDailyLLMUsd: vi.fn(async () => 0),
}));

/**
 * O ponto de captura. `src/observability/metrics.ts` (o gate de rótulos) e
 * `src/lib/llm/telemetry.ts` (emissão direta) desembocam os dois AQUI, então
 * um espião neste módulo vê o conjunto final de rótulos de toda série — já
 * depois de `ALLOWED_LABEL_KEYS` ter descartado o que não passa.
 */
vi.mock('@/lib/metrics.js', () => ({
  incCounter: incCounterMock,
  observeHistogram: observeHistogramMock,
  setGaugeProvider: setGaugeProviderMock,
}));

vi.mock('@/config/env.js', async () => {
  const actual = await vi.importActual<typeof import('@/config/env.js')>('@/config/env.js');
  return {
    ...actual,
    config: {
      ...actual.config,
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test-placeholder',
      CLAUDE_MAX_RETRIES: 2,
      CLAUDE_TIMEOUT_MS: 30000,
      CLAUDE_MODEL_MAIN: 'env-main',
      CLAUDE_MODEL_FAST: 'env-fast',
      LLM_DAILY_BUDGET_USD: 0,
    },
  };
});

import { executeLLM as executeLLMRaw } from '@/lib/llm/gateway.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { invalidateModelCache } from '@/lib/llm/model-resolver.js';
import { _internal as breakerInternal } from '@/lib/llm/circuit-breaker.js';
import { applyCircuitOverride, _internal as modeInternal } from '@/lib/llm/circuit-mode.js';
import { emitUsage, statusForKind } from '@/lib/llm/telemetry.js';
import type { LLMCallStatus } from '@/lib/llm/telemetry.js';

const ROOT = resolve(__dirname, '../../..');
const RUNBOOKS = ['docs/runbooks/operational.md', 'docs/runbooks/observability-slo.md'];

/**
 * Todo desfecho observável de uma chamada. Fixo aqui de propósito: é a lista
 * que os runbooks têm direito de usar num seletor `status=`, e um valor novo em
 * `LLMCallStatus` que não apareça aqui derruba o caso "todo status citado
 * existe" na próxima vez que alguém o citar.
 */
const STATUSES: readonly LLMCallStatus[] = [
  'ok',
  'error',
  'timeout',
  'rate_limit',
  'cancelled',
  'budget_exhausted',
  'circuit_open',
];

/** metric → chaves de rótulo observadas / valores observados por chave. */
type Observed = Map<string, { keys: Set<string>; values: Map<string, Set<string>> }>;
const observed: Observed = new Map();

function record(metric: string, labels: Record<string, unknown> | undefined): void {
  let e = observed.get(metric);
  if (!e) {
    e = { keys: new Set(), values: new Map() };
    observed.set(metric, e);
  }
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (v === undefined || v === null) continue;
    e.keys.add(k);
    let vs = e.values.get(k);
    if (!vs) {
      vs = new Set();
      e.values.set(k, vs);
    }
    vs.add(String(v));
  }
}

/** Gauges chegam com os rótulos já embutidos no nome (`gaugeName`). */
function recordGaugeName(name: string): void {
  const i = name.indexOf('{');
  if (i === -1) {
    record(name, {});
    return;
  }
  const labels: Record<string, string> = {};
  for (const m of name.slice(i + 1, -1).matchAll(/([a-z_][a-z0-9_]*)="([^"]*)"/g)) {
    labels[m[1]!] = m[2]!;
  }
  record(name.slice(0, i), labels);
}

function okReply(): unknown {
  return {
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
    model: 'env-main',
    stop_reason: 'end_turn',
  };
}

function outage(): Error {
  return Object.assign(new Error('upstream 503'), {
    status: 503,
    headers: { 'retry-after': '0.01' },
  });
}

/**
 * O gateway roda DENTRO do escopo do caller: sem contexto ALS a chamada morre
 * em `missing_tenant_context` antes de chegar ao disjuntor, e nenhuma série de
 * circuito nasce — o harness ficaria verde por vazio.
 */
function call(): Promise<unknown> {
  return runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () =>
    executeLLMRaw({
      workload: 'reasoner',
      system: 'sys',
      messages: [{ role: 'user', content: 'oi' }],
    }),
  ).catch(() => undefined);
}

/**
 * Roda os emissores de verdade. Nada aqui é decorativo: cada bloco existe
 * porque alguma série que os runbooks citam só nasce por aquele caminho.
 */
async function exerciseEmitters(): Promise<void> {
  getSettingsMock.mockResolvedValue({
    main: { value: 'settings-main', source: 'global' },
    fast: { value: 'settings-fast', source: 'global' },
  });
  invalidateModelCache();

  // 1. Telemetria por desfecho — `maia_llm_requests_total`, a legada
  //    `maia_llm_calls_total`, duração, timeouts, cancelamentos, tokens.
  for (const status of STATUSES) {
    await emitUsage(
      {
        workload: 'reasoner',
        tier: 'reasoner',
        provider: 'anthropic',
        model: 'env-main',
        status,
        attempts: 1,
        duration_ms: 5,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      { tenant_id: 't1', agent_id: 'a1' },
    );
  }

  // 2. Sombra sob queda total — `would_open`, `would_reject`, transições e o
  //    par de séries de estado. `would_reject` SÓ nasce no gateway (uma vez
  //    por CHAMADA, não por tentativa), então tem que passar por `executeLLM`.
  breakerInternal.reset();
  breakerInternal.setMode('shadow');
  anthropicCreateMock.mockRejectedValue(outage());
  for (let i = 0; i < 20; i++) await call();

  // 3. Enforce sob a mesma queda — recusa real (`short_circuited`,
  //    `requests_total{status="circuit_open"}`).
  breakerInternal.reset();
  breakerInternal.setMode('enforce');
  for (let i = 0; i < 20; i++) await call();

  // 4. Recuperação — o gauge de estado precisa ter existido em `closed`.
  anthropicCreateMock.mockResolvedValue(okReply());
  breakerInternal.reset();
  breakerInternal.setMode('shadow');
  await call();

  // 5. Kill switch — `maia_llm_circuit_mode`, `..._mode_overrides_total`.
  modeInternal.reset();
  applyCircuitOverride({ mode: 'off', actor: 'sre:spec', reason: 'runbook', ttl_ms: 60_000 });
  modeInternal.reset();
  breakerInternal.setMode(null);
}

// ---------------------------------------------------------------------------
// Extração da PromQL dos runbooks
// ---------------------------------------------------------------------------

type Block = { file: string; query: string };

/**
 * Só cercas ```promql. Blocos ```bash/```sql/```promql-em-prosa não são
 * consultas e arrastá-los para cá produziria falso vermelho — o `grep
 * maia_llm_circuit_mode` de um `curl` é texto, não seletor.
 *
 * Linhas de comentário (`#`) são descartadas: o runbook explica a consulta
 * acima dela em português, e prosa não é PromQL.
 */
/**
 * As expressões do arquivo de REGRAS (`monitoring/alerts/slo.rules.yml`) entram
 * na mesma guarda que as dos runbooks, e por um motivo concreto: o achado 6 da
 * rodada 3 encontrou `MaiaLlmRateLimited` casando
 * `maia_llm_calls_total{status="error",reason="rate_limit"}` — série que nunca
 * teve `reason` e cujo `status="error"` exclui rate limit. O alerta não
 * disparava desde que foi escrito, e `slo-rules.spec.ts` não pegou porque
 * valida NOMES de métrica, não rótulos.
 *
 * Um alerta que não casa nada é pior que alerta ausente: ele ocupa o lugar de
 * um que funcionaria.
 */
const RULE_FILES = ['monitoring/alerts/slo.rules.yml'];

/**
 * ESCOPO, e por que ele é estreito de propósito.
 *
 * Este harness exercita os emissores de LLM/disjuntor — é o que a fatia #534
 * toca. As outras famílias do arquivo de regras (audit, trace durável, filas,
 * SLO sintético) não são exercitadas aqui, e as recording rules
 * (`maia:...:rate5m`) são séries DERIVADAS que não existem em emissor nenhum.
 *
 * Validar essas expressões contra `observed` produziria falso positivo, que é a
 * pior falha possível num drift guard: some no ruído e some junto com ele o
 * achado verdadeiro. Então só entram as expressões cujas métricas TODAS foram
 * observadas de fato.
 *
 * Estender às demais famílias exige exercitar os emissores delas — follow-up
 * real, não uma linha de regex. Enquanto isso, `expressoesCobertas` abaixo é o
 * que impede a cobertura de encolher em silêncio.
 */
function ruleExpressions(): Block[] {
  const out: Block[] = [];
  for (const file of RULE_FILES) {
    // Parser de YAML de verdade, e não regex. A primeira tentativa usou
    // `/^\s*expr:\s*.../m` e falhou silenciosamente: `\s` casa `\n` e o `|`
    // do block scalar entrou na classe de caracteres, então UMA "expressão"
    // engoliu o arquivo inteiro. Guarda que erra assim não fica vermelha — ela
    // fica vazia, que é o modo de falha mais caro que um drift guard tem.
    const doc = parseYaml(readFileSync(resolve(ROOT, file), 'utf8')) as {
      groups?: Array<{ rules?: Array<{ expr?: unknown }> }>;
    };
    for (const group of doc.groups ?? []) {
      for (const rule of group.rules ?? []) {
        const query = typeof rule.expr === 'string' ? rule.expr.trim() : '';
        if (!query) continue;
        const metrics = [...query.matchAll(/\b(maia_[a-z0-9_]+)/g)].map((x) =>
          x[1]!.replace(/_(bucket|sum|count)$/, ''),
        );
        if (metrics.length > 0 && metrics.every((x) => observed.has(x))) out.push({ file, query });
      }
    }
  }
  return out;
}

function promqlBlocks(): Block[] {
  const out: Block[] = [...ruleExpressions()];
  for (const file of RUNBOOKS) {
    const text = readFileSync(resolve(ROOT, file), 'utf8');
    for (const m of text.matchAll(/```promql\n([\s\S]*?)```/g)) {
      const query = m[1]!
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
      if (query.trim()) out.push({ file, query });
    }
  }
  return out;
}

function metricsIn(query: string): string[] {
  return [
    ...new Set(
      [...query.matchAll(/\bmaia_[a-z0-9_]+/g)].map((m) =>
        m[0]!.replace(/_(bucket|sum|count)$/, ''),
      ),
    ),
  ];
}

/** `metric{k="v",k2=~"a|b"}` → pares (chave, valores literais). */
function selectorsIn(query: string): Array<{ metric: string; key: string; values: string[] }> {
  const out: Array<{ metric: string; key: string; values: string[] }> = [];
  for (const m of query.matchAll(/\b(maia_[a-z0-9_]+)\{([^}]*)\}/g)) {
    const metric = m[1]!.replace(/_(bucket|sum|count)$/, '');
    for (const sel of m[2]!.matchAll(/([a-z_][a-z0-9_]*)\s*(=~|!~|!=|=)\s*"([^"]*)"/g)) {
      out.push({ metric, key: sel[1]!, values: sel[3]!.split('|').filter(Boolean) });
    }
  }
  return out;
}

function groupKeysIn(query: string): string[] {
  const out: string[] = [];
  for (const m of query.matchAll(/\b(?:by|without)\s*\(([^)]*)\)/g)) {
    for (const k of m[1]!.split(',')) {
      const key = k.trim();
      if (key) out.push(key);
    }
  }
  return [...new Set(out)];
}

let blocks: Block[] = [];

beforeAll(async () => {
  incCounterMock.mockImplementation((name: string, labels?: Record<string, unknown>) =>
    record(name, labels),
  );
  observeHistogramMock.mockImplementation(
    (name: string, _v: number, labels?: Record<string, unknown>) => record(name, labels),
  );
  setGaugeProviderMock.mockImplementation((name: string) => recordGaugeName(name));
  await exerciseEmitters();
  blocks = promqlBlocks();
}, 30_000);

describe('achado 6 — a PromQL dos runbooks executa contra as séries reais', () => {
  it('os emissores foram de fato exercitados (senão tudo abaixo passa por vazio)', () => {
    // Sem esta âncora, um erro no harness transformaria a suíte inteira num
    // verde vazio — a falha mais cara que um drift guard pode ter.
    for (const m of [
      'maia_llm_requests_total',
      'maia_llm_calls_total',
      'maia_llm_circuit_would_open_total',
      'maia_llm_circuit_would_reject_total',
      'maia_llm_circuit_state',
      'maia_llm_circuit_mode',
      'maia_llm_attempts_total',
    ]) {
      expect(observed.has(m), `emissor de ${m} não rodou`).toBe(true);
    }
    expect(blocks.length).toBeGreaterThanOrEqual(5);
  });

  it('nenhuma consulta cita uma série que ninguém emite', () => {
    const known = new Set<string>([...METRIC_NAMES, ...observed.keys()]);
    const unknown: string[] = [];
    for (const b of blocks) {
      for (const m of metricsIn(b.query)) if (!known.has(m)) unknown.push(`${b.file}: ${m}`);
    }
    expect(unknown, 'runbook cita métrica inexistente').toEqual([]);
  });

  it('todo rótulo de SELETOR existe naquela série', () => {
    const bad: string[] = [];
    for (const b of blocks) {
      for (const s of selectorsIn(b.query)) {
        const e = observed.get(s.metric);
        if (!e) continue; // série fora do escopo LLM — coberta pelo caso acima
        if (!e.keys.has(s.key)) {
          bad.push(`${b.file}: ${s.metric}{${s.key}=…} — rótulos reais: ${[...e.keys].join(',')}`);
        }
      }
    }
    expect(bad, 'seletor por rótulo que a série não tem').toEqual([]);
  });

  it('todo rótulo de `by (...)` existe em TODAS as séries da mesma consulta', () => {
    // Agrupar por um rótulo que só uma das séries tem colapsa a outra num
    // grupo só — o defeito exato do achado 6 (`calls_total` by `workload`).
    const bad: string[] = [];
    for (const b of blocks) {
      const metrics = metricsIn(b.query).filter((m) => observed.has(m));
      if (metrics.length === 0) continue;
      for (const key of groupKeysIn(b.query)) {
        const missing = metrics.filter((m) => !observed.get(m)!.keys.has(key));
        if (missing.length > 0) {
          bad.push(`${b.file}: by (${key}) — ausente em ${missing.join(', ')}`);
        }
      }
    }
    expect(bad, 'agrupamento por rótulo que a série não carrega').toEqual([]);
  });

  it('todo valor literal de `status`/`state` citado é um valor que a série assume', () => {
    const bad: string[] = [];
    for (const b of blocks) {
      for (const s of selectorsIn(b.query)) {
        if (s.key !== 'status' && s.key !== 'state') continue;
        const seen = observed.get(s.metric)?.values.get(s.key);
        if (!seen) continue;
        for (const v of s.values) {
          if (!seen.has(v)) bad.push(`${b.file}: ${s.metric}{${s.key}="${v}"} — reais: ${[...seen].join(',')}`);
        }
      }
    }
    expect(bad, 'seletor por valor que a série nunca assume').toEqual([]);
  });

  it('todo rótulo citado está na allowlist da taxonomia', () => {
    // Rede de segurança: um rótulo fora de `ALLOWED_LABEL_KEYS` é DESCARTADO em
    // silêncio por `labels.ts`, então citá-lo num runbook é sempre defeito —
    // mesmo que por acaso ele apareça numa série legada.
    const bad: string[] = [];
    for (const b of blocks) {
      for (const key of [...groupKeysIn(b.query), ...selectorsIn(b.query).map((s) => s.key)]) {
        if (!ALLOWED_LABEL_KEYS.has(key)) bad.push(`${b.file}: ${key}`);
      }
    }
    expect(bad, 'runbook cita rótulo fora de ALLOWED_LABEL_KEYS').toEqual([]);
  });
});

describe('achado 6b — o alerta de rate limit não pode voltar a ser letra morta', () => {
  const rules = readFileSync(resolve(ROOT, 'monitoring/alerts/slo.rules.yml'), 'utf8');
  const expr = /- alert: MaiaLlmRateLimited\n\s*expr:\s*(.+)/.exec(rules)?.[1]?.trim() ?? '';

  it('a expressão do MaiaLlmRateLimited entra na guarda (não só o nome do alerta)', () => {
    // `slo-rules.spec.ts` já garantia que o NOME da métrica existe. Não bastou:
    // `maia_llm_calls_total{status="error",reason="rate_limit"}` tem nome
    // válido e não casa nada. A cobertura só vale se a expressão deste alerta
    // estiver entre as que a guarda de rótulos examina.
    expect(expr, 'o alerta sumiu do arquivo de regras').not.toBe('');
    const coberta = blocks.some(
      (b) => b.file.endsWith('slo.rules.yml') && b.query.includes('MaiaLlmRateLimited') === false && b.query === expr,
    );
    expect(coberta, `expressão fora da guarda: ${expr}`).toBe(true);
  });

  it('casa a série e o status que o código realmente emite', () => {
    expect(expr).toContain('maia_llm_requests_total');
    expect(expr).toContain('status="rate_limit"');
    // As duas metades do defeito original, cada uma explicitamente proibida.
    expect(expr, 'voltou para a série legada, que não carrega `reason`').not.toContain(
      'maia_llm_calls_total',
    );
    expect(expr, '`reason` nunca existiu nessa série').not.toContain('reason=');
  });

  it('`rate_limit` é valor que a série ASSUME — provado pelo emissor, não pela taxonomia', () => {
    const statuses = observed.get('maia_llm_requests_total')?.values.get('status');
    expect(statuses, 'o emissor de maia_llm_requests_total não rodou').toBeDefined();
    expect([...(statuses ?? [])]).toContain('rate_limit');
  });
});

describe('achado 6 — os fatos que motivaram a reescrita continuam valendo', () => {
  it('`maia_llm_calls_total` NÃO carrega `workload` — a consulta antiga não rodava', () => {
    const e = observed.get('maia_llm_calls_total')!;
    expect([...e.keys].sort()).toEqual(['model', 'provider', 'status']);
    expect(e.keys.has('workload')).toBe(false);
  });

  it('`maia_llm_requests_total` carrega o par provider/workload — é a série certa', () => {
    const e = observed.get('maia_llm_requests_total')!;
    for (const k of ['provider', 'workload', 'status', 'tenant_id', 'agent_id']) {
      expect(e.keys.has(k), `falta ${k}`).toBe(true);
    }
  });

  it('`status="error"` NÃO inclui timeout — daí o `=~"error|timeout"`', () => {
    // `timeout` é status PRÓPRIO e é um dos três `PROVIDER_FAULT_KINDS`: um
    // critério de promoção que só olhasse `error` ignoraria a falha que mais
    // abre o disjuntor.
    expect(statusForKind('timeout')).toBe('timeout');
    expect(statusForKind('timeout')).not.toBe('error');
    expect(observed.get('maia_llm_requests_total')!.values.get('status')).toContain('timeout');
  });

  it('nenhum runbook agrupa a série legada por workload (regressão do achado 6)', () => {
    for (const b of blocks) {
      const metrics = metricsIn(b.query);
      if (!metrics.includes('maia_llm_calls_total')) continue;
      expect(
        groupKeysIn(b.query),
        `${b.file}: agrupa maia_llm_calls_total por workload — não roda`,
      ).not.toContain('workload');
    }
  });

  it('a seção de promoção declara a postura GLOBAL e o pré-requisito do pub/sub', () => {
    const text = readFileSync(resolve(ROOT, 'docs/runbooks/operational.md'), 'utf8');
    const section = text.slice(
      text.indexOf('### Promoção `shadow` → `enforce`'),
      text.indexOf('### Rollback da promoção'),
    );
    expect(section.length).toBeGreaterThan(1000);
    // A postura não é por workload — promover é decisão de frota.
    expect(section).toContain('A postura é GLOBAL');
    expect(section).toContain('Não existe promoção seletiva por workload');
    // A lacuna de reconexão do pub/sub era o pré-requisito BLOQUEANTE da
    // promoção; ela foi fechada no gate 4 da #534. A seção não pode voltar a
    // ser silenciosa sobre isso: quem promove precisa achar aqui o mecanismo
    // (releitura na reconexão), a semântica das duas pontas e COMO verificar
    // que a réplica ressincronizou — que é o que substitui o bloqueio.
    expect(section).toMatch(/reconect/i);
    expect(section).toContain('resyncAuthoritativeState');
    expect(section).toContain('arrendamento restante');
    expect(section).toContain('limpa o override local');
    expect(section).toContain('reason="resynced"');
    // Os números que o owner fixou.
    expect(section).toContain('7 dias completos');
    expect(section).toContain('1.000 chamadas');
    expect(section).toMatch(/30 s \/ 10 amostras/);
    expect(section).toMatch(/60 s/);
    expect(section).toMatch(/90%/);
  });
});
