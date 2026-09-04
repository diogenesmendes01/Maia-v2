/**
 * Issue #535 critério 4 — o GATE do A/B de overhead OTLP tem que REPROVAR.
 *
 * `scripts/otlp-overhead-benchmark.ts` é uma ferramenta de MEDIÇÃO; o que
 * precisa de prova sem Postgres não é o número, é o VEREDICTO: cada critério
 * nomeado derruba o processo quando o valor correspondente estoura, e um
 * critério que não pôde ser avaliado (`skipped`) não é lido como aprovado.
 * `evaluateGate` é puro justamente para isto ser provável sem banco, sem
 * carga e sem relógio — a mesma divisão de `turn-context-gate.spec.ts`.
 *
 * Também cobre a linha de comando (`parseArgs`), a codificação do relatório
 * (JSON e markdown) e os leitores da exposição Prometheus que produzem a
 * cardinalidade real (`seriesPorFamilia`, `counterByLabel`) — porque um
 * relatório que somasse errado as séries provaria o oposto do que afirma.
 *
 * O que este arquivo NÃO prova: que os números medidos estão certos. Isso é
 * o harness rodando contra Postgres real (`npm run otlp:bench`).
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_ARMS,
  MARGEM_RELATIVA_DEFAULT,
  QUEUE_SIZE_DEFAULT,
  aggregateArm,
  applyInjection,
  armOrder,
  counterByLabel,
  countOtlpSpans,
  diffByLabel,
  encodeReport,
  evaluateGate,
  gateExitCode,
  hostInfo,
  isDirectInvocation,
  metricLines,
  parseArgs,
  percentile,
  renderReport,
  seriesPorFamilia,
  shouldRejectBatch,
  syntheticArms,
  type ArmResult,
  type Report,
  type RoundRun,
  type Thresholds,
} from '../../../scripts/otlp-overhead-benchmark.js';

const T: Thresholds = {
  relative_margin: MARGEM_RELATIVA_DEFAULT,
  queue_size: QUEUE_SIZE_DEFAULT,
  collector_delay_ms: 200,
  collector_fail_ratio: 0.2,
};

function failing(verdicts: ReturnType<typeof evaluateGate>): string[] {
  return verdicts.filter((v) => !v.passed).map((v) => v.label);
}

describe('otlp-overhead-benchmark — parseArgs', () => {
  it('defaults: gate, 3 rodadas, 200 turnos, três braços, on-slow com 200 ms e 20 % de 503', () => {
    const o = parseArgs([]);
    expect(o.mode).toBe('gate');
    expect(o.rounds).toBe(3);
    expect(o.turns).toBe(200);
    expect(o.arms).toEqual([...ALL_ARMS]);
    expect(o.collector_delay_ms).toBe(200);
    expect(o.collector_fail_ratio).toBe(0.2);
    expect(o.relative_margin).toBe(MARGEM_RELATIVA_DEFAULT);
    expect(o.queue_size).toBe(QUEUE_SIZE_DEFAULT);
    expect(o.scenario).toBe('text');
    expect(o.json).toBe(false);
  });

  it('--self-test é apelido de --mode self-test e aceita --inject', () => {
    const o = parseArgs(['--self-test', '--inject', 'on-local.p95_ms=900,on-slow.dropped.queue_full=5']);
    expect(o.mode).toBe('self-test');
    expect(o.inject).toEqual({ 'on-local.p95_ms': 900, 'on-slow.dropped.queue_full': 5 });
  });

  it('--inject fora do self-test é recusado — injetar numa medição vira carimbo', () => {
    expect(() => parseArgs(['--inject', 'on-local.p95_ms=1'])).toThrow(/--inject só é aceito junto de --self-test/);
    expect(() => parseArgs(['--mode', 'measure', '--inject', 'off.errors=0'])).toThrow(/--self-test/);
  });

  it('recusa valores inválidos com o nome da flag na mensagem', () => {
    expect(() => parseArgs(['--mode', 'loose'])).toThrow(/--mode inválido/);
    expect(() => parseArgs(['--rounds', '0'])).toThrow(/--rounds/);
    expect(() => parseArgs(['--turns', 'x'])).toThrow(/--turns/);
    expect(() => parseArgs(['--collector-fail-ratio', '1.5'])).toThrow(/--collector-fail-ratio/);
    expect(() => parseArgs(['--relative-margin', '1'])).toThrow(/--relative-margin/);
    expect(() => parseArgs(['--scenario', 'voice'])).toThrow(/--scenario inválido/);
    expect(() => parseArgs(['--arms', 'off,on-fast'])).toThrow(/--arms inválido/);
    expect(() => parseArgs(['--arms', 'off,off'])).toThrow(/repete/);
    expect(() => parseArgs(['--self-test', '--mode', 'measure'])).toThrow(/conflita/);
    expect(() => parseArgs(['--self-test', '--inject', 'semvalor'])).toThrow(/--inject inválido/);
  });

  it('--arms aceita um subconjunto (o gate então pula o que faltar)', () => {
    expect(parseArgs(['--arms', 'off,on-local']).arms).toEqual(['off', 'on-local']);
  });
});

describe('otlp-overhead-benchmark — o gate reprova', () => {
  it('sobre os braços sintéticos saudáveis, todo critério passa e o exit é 0', () => {
    const v = evaluateGate(syntheticArms(T), T);
    expect(failing(v)).toEqual([]);
    expect(v.some((x) => x.skipped)).toBe(false);
    expect(gateExitCode(v, 'gate')).toBe(0);
    expect(gateExitCode(v, 'self-test')).toBe(0);
  });

  const cases: Array<[string, Record<string, number>, RegExp]> = [
    ['p95 ligado acima de off × 1,10', { 'on-local.p95_ms': 900 }, /\[on-local\] p95 do turno/],
    ['p99 ligado acima de off × 1,10', { 'on-local.p99_ms': 100 }, /\[on-local\] p99 do turno/],
    ['throughput ligado abaixo de off × 0,90', { 'on-local.throughput_turns_per_s': 80 }, /\[on-local\] throughput/],
    ['erro novo no braço ligado', { 'on-local.errors': 1 }, /\[on-local\] erros novos/],
    ['turno que não chegou ao modelo', { 'on-local.provider_calls': 10 }, /alcançou o modelo/],
    ['tracing "ligado" sem span no sink', { 'on-local.sink_calls': 0 }, /tracing ligado de fato/],
    ['amostragem que descartou', { 'on-local.dropped.not_sampled': 3 }, /not_sampled = 0/],
    ['perda com collector saudável', { 'on-local.spans_received': 10 }, /sem perda/],
    ['descarte com collector saudável', { 'on-local.dropped.transport': 4 }, /descartes = 0/],
    ['on-slow degradando o hot path (p95)', { 'on-slow.p95_ms': 200 }, /\[on-slow\] p95 do turno/],
    ['on-slow degradando o hot path (p99)', { 'on-slow.p99_ms': 200 }, /\[on-slow\] p99 do turno/],
    ['on-slow derrubando o throughput', { 'on-slow.throughput_turns_per_s': 1 }, /\[on-slow\] throughput/],
    ['span sem destino conhecido', { 'on-slow.spans_received': 6000 }, /perda contabilizada/],
    ['http_5xx contado diferente do que o collector recusou', { 'on-slow.dropped.http_5xx': 1 }, /perda contabilizada/],
    ['fila acima do teto', { 'on-slow.queue_depth_max': 4096 }, /fila nunca acima de 2048/],
    ['collector que não foi lento de fato', { 'on-slow.export_p50_ms': 1 }, /collector degradado de fato/],
    ['collector que não recusou nada com fail-ratio > 0', { 'on-slow.spans_rejected': 0 }, /collector degradado de fato/],
    ['off que deixou de curto-circuitar (span no sink)', { 'off.sink_calls': 1 }, /\[off\] curto-circuito provado/],
    ['off com tracing ligado', { 'off.tracing_enabled': 1 }, /\[off\] curto-circuito provado/],
    ['off com bytes no collector', { 'off.bytes': 10 }, /\[off\] curto-circuito provado/],
    ['erro no braço off', { 'off.errors': 2 }, /\[off\] erros = 0/],
  ];

  for (const [name, inject, label] of cases) {
    it(`reprova: ${name}`, () => {
      const arms = syntheticArms(T);
      const applied = applyInjection(arms, inject);
      expect(applied).toHaveLength(Object.keys(inject).length);
      const v = evaluateGate(arms, T);
      const red = failing(v);
      expect(red.length, `esperava ao menos um critério vermelho: ${JSON.stringify(inject)}`).toBeGreaterThan(0);
      expect(red.some((l) => label.test(l)), `critério errado ficou vermelho: ${red.join(' | ')}`).toBe(true);
      expect(gateExitCode(v, 'gate')).toBe(1);
      expect(gateExitCode(v, 'self-test')).toBe(1);
    });
  }

  it('"erros novos" compara com o off: um erro que já existia em off não reprova o braço ligado', () => {
    const arms = syntheticArms(T);
    applyInjection(arms, { 'off.errors': 1, 'on-local.errors': 1 });
    const red = failing(evaluateGate(arms, T));
    expect(red).toContain('[off] erros = 0');
    expect(red.some((l) => l.startsWith('[on-local] erros novos'))).toBe(false);
  });

  it('com fail-ratio 0 o critério "degradado de fato" não exige recusa, só o atraso', () => {
    const t0: Thresholds = { ...T, collector_fail_ratio: 0 };
    const arms = syntheticArms(t0);
    applyInjection(arms, {
      'on-slow.spans_rejected': 0,
      'on-slow.dropped.http_5xx': 0,
      'on-slow.spans_received': 7_800,
      'on-slow.exported_ok': 7_800,
    });
    expect(failing(evaluateGate(arms, t0))).toEqual([]);
  });

  it('braço ausente ⇒ critérios `skipped`, e skipped ⇒ passed=false ⇒ gate reprova', () => {
    const arms = syntheticArms(T).filter((a) => a.arm !== 'on-slow');
    const v = evaluateGate(arms, T);
    const sk = v.filter((x) => x.skipped);
    expect(sk.length).toBeGreaterThan(0);
    for (const s of sk) {
      expect(s.passed).toBe(false);
      expect(s.label).toMatch(/\[on-slow\]/);
      expect(s.detail).toMatch(/não rodou/);
    }
    expect(gateExitCode(v, 'gate')).toBe(1);
  });

  it('sem o braço off nada é comparável: tudo que é relativo fica skipped', () => {
    const v = evaluateGate(syntheticArms(T).filter((a) => a.arm !== 'off'), T);
    expect(v.filter((x) => x.skipped).length).toBeGreaterThanOrEqual(14);
    expect(gateExitCode(v, 'gate')).toBe(1);
  });

  it('modo measure sai 0 mesmo com vermelho — e o relatório diz que não houve veredicto', () => {
    const arms = syntheticArms(T);
    applyInjection(arms, { 'on-local.p95_ms': 900 });
    const v = evaluateGate(arms, T);
    expect(gateExitCode(v, 'measure')).toBe(0);
    const md = renderReport(report(arms, v, 'measure'));
    expect(md).toContain('MODO MEASURE — NENHUM VEREDICTO DE GATE FOI EMITIDO');
  });

  it('--inject recusa braço e campo desconhecidos', () => {
    expect(() => applyInjection(syntheticArms(T), { 'on-fast.p95_ms': 1 })).toThrow(/braço desconhecido/);
    expect(() => applyInjection(syntheticArms(T), { 'on-local.nope': 1 })).toThrow(/campo desconhecido/);
  });

  it('cada critério carrega o número medido E o limiar no detalhe', () => {
    for (const v of evaluateGate(syntheticArms(T), T)) {
      expect(v.detail.length, v.label).toBeGreaterThan(0);
      if (/≤ off ×|≥ off ×/.test(v.label)) {
        expect(v.detail).toMatch(/medido=/);
        expect(v.detail).toMatch(/limiar=/);
      }
    }
  });
});

function report(arms: ArmResult[], verdicts: ReturnType<typeof evaluateGate>, mode: 'gate' | 'measure' | 'self-test'): Report {
  return {
    mode,
    self_test: mode === 'self-test',
    options: parseArgs(mode === 'self-test' ? ['--self-test'] : ['--mode', mode]),
    host: hostInfo(),
    injected: [],
    per_round: arms,
    arms,
    verdicts,
    exit_code: gateExitCode(verdicts, mode),
    gate_evaluated: mode !== 'measure',
  };
}

describe('otlp-overhead-benchmark — relatório', () => {
  it('JSON: carrega braços, veredictos, host e exit_code, e é parseável', () => {
    const arms = syntheticArms(T);
    const v = evaluateGate(arms, T);
    const parsed = JSON.parse(encodeReport(report(arms, v, 'gate'))) as Report;
    expect(parsed.arms.map((a) => a.arm)).toEqual(['off', 'on-local', 'on-slow']);
    expect(parsed.verdicts).toHaveLength(v.length);
    expect(parsed.exit_code).toBe(0);
    expect(parsed.host.node).toBe(process.version);
    expect(parsed.options.mode).toBe('gate');
  });

  it('markdown: a tabela tem uma linha por braço com as colunas que o dono pediu', () => {
    const arms = syntheticArms(T);
    const md = renderReport(report(arms, evaluateGate(arms, T), 'gate'));
    expect(md).toContain('| braço | turnos | erros | p50 ms | p95 ms | p99 ms |');
    for (const a of ALL_ARMS) expect(md).toContain(`| \`${a}\` |`);
    expect(md).toMatch(/spans emitidos \| recebidos \| recusados \| batches \| bytes/);
    expect(md).toContain('Δ linhas /metrics');
    expect(md).toContain('Cardinalidade real');
    expect(md).toContain('Piso, não produção');
    expect(md).toContain('MAIA_OTLP_SAMPLE_RATIO=1');
    expect(md).toMatch(/turnos executados=1800 falharam=0/);
    expect(md).toMatch(/aprovados=\d+ reprovados=0 pulados=0/);
  });

  it('markdown: self-test diz em caixa alta que nada foi medido e lista as injeções', () => {
    const arms = syntheticArms(T);
    const injected = applyInjection(arms, { 'on-local.p95_ms': 900 });
    const v = evaluateGate(arms, T);
    const md = renderReport({ ...report(arms, v, 'self-test'), injected });
    expect(md).toContain('SINTÉTICOS');
    expect(md).toContain('on-local.p95_ms=900');
    expect(md).toMatch(/FAIL — \[on-local\] p95 do turno/);
    expect(md).toMatch(/exit=1/);
  });

  it('markdown: critério pulado aparece como "SKIP (reprova)"', () => {
    const arms = syntheticArms(T).filter((a) => a.arm !== 'on-slow');
    const md = renderReport(report(arms, evaluateGate(arms, T), 'gate'));
    expect(md).toContain('SKIP (reprova)');
  });
});

describe('otlp-overhead-benchmark — leitores da exposição e agregação', () => {
  const expo = [
    'maia_otlp_spans_dropped_total{reason="http_5xx"} 64',
    'maia_otlp_spans_dropped_total{reason="not_sampled"} 2',
    'maia_otlp_spans_exported_total{status="ok"} 128',
    'maia_turn_duration_ms_bucket{le="50",result="ok"} 3',
    'maia_turn_duration_ms_bucket{le="+Inf",result="ok"} 4',
    'maia_turn_duration_ms_sum{result="ok"} 123',
    'maia_turn_duration_ms_count{result="ok"} 4',
    'maia_otlp_queue_depth 0',
    'nodejs_heap_bytes 1',
    '',
  ].join('\n');

  it('seriesPorFamilia dobra _bucket/_sum/_count na família e ignora o que não é maia_*', () => {
    expect(seriesPorFamilia(expo)).toEqual({
      maia_otlp_spans_dropped_total: 2,
      maia_otlp_spans_exported_total: 1,
      maia_turn_duration_ms: 4,
      maia_otlp_queue_depth: 1,
    });
    expect(metricLines(expo)).toHaveLength(9);
  });

  it('counterByLabel/diffByLabel dão o delta POR reason, sem confundir prefixos', () => {
    const before = counterByLabel(expo, 'maia_otlp_spans_dropped_total', 'reason');
    expect(before).toEqual({ http_5xx: 64, not_sampled: 2 });
    const after = { http_5xx: 100, not_sampled: 2, queue_full: 7 };
    expect(diffByLabel(before, after)).toEqual({ http_5xx: 36, queue_full: 7 });
    // `maia_otlp_spans_exported_total` não é lido como `maia_otlp_spans_exported_total_x`.
    expect(counterByLabel(expo, 'maia_otlp_spans_exported', 'status')).toEqual({});
  });

  it('countOtlpSpans conta os spans de um ExportTraceServiceRequest', () => {
    expect(countOtlpSpans({ resourceSpans: [{ scopeSpans: [{ spans: [{}, {}] }, { spans: [{}] }] }] })).toBe(3);
    expect(countOtlpSpans({})).toBe(0);
    expect(countOtlpSpans(null)).toBe(0);
  });

  it('percentile é o método do rank superior, como no harness irmão', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 50)).toBe(5);
    expect(percentile(s, 95)).toBe(10);
    expect(percentile(s, 99)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });

  it('armOrder é uma rotação: nenhum braço vai sempre primeiro', () => {
    expect(armOrder(ALL_ARMS, 0)).toEqual(['off', 'on-local', 'on-slow']);
    expect(armOrder(ALL_ARMS, 1)).toEqual(['on-local', 'on-slow', 'off']);
    expect(armOrder(ALL_ARMS, 2)).toEqual(['on-slow', 'off', 'on-local']);
    expect(armOrder(ALL_ARMS, 3)).toEqual(armOrder(ALL_ARMS, 0));
  });

  it('aggregateArm: percentis sobre a união das amostras, contadores somados, fila = máximo', () => {
    const [off] = syntheticArms(T);
    const r1: RoundRun = {
      result: { ...off!, rounds: [1], turns: 3, wall_ms: 300, sink_calls: 10, dropped: { http_5xx: 1 }, queue_depth_max: 5, metrics_lines_before: 10, metrics_lines_after: 12 },
      latencies: [10, 20, 30],
      export_samples: [1, 2],
    };
    const r2: RoundRun = {
      result: { ...off!, rounds: [2], turns: 3, wall_ms: 300, sink_calls: 12, dropped: { http_5xx: 2, queue_full: 1 }, queue_depth_max: 9, metrics_lines_before: 12, metrics_lines_after: 12 },
      latencies: [40, 50, 60],
      export_samples: [3, 400],
    };
    const agg = aggregateArm([r1, r2]);
    expect(agg.rounds).toEqual([1, 2]);
    expect(agg.turns).toBe(6);
    expect(agg.p50_ms).toBe(30);
    expect(agg.p99_ms).toBe(60);
    expect(agg.throughput_turns_per_s).toBeCloseTo(10, 5);
    expect(agg.sink_calls).toBe(22);
    expect(agg.dropped).toEqual({ http_5xx: 3, queue_full: 1 });
    expect(agg.queue_depth_max).toBe(9);
    expect(agg.export_p50_ms).toBe(2);
    expect(agg.export_max_ms).toBe(400);
    expect(agg.metrics_lines_before).toBe(10);
    expect(agg.metrics_lines_after).toBe(12);
  });

  it('shouldRejectBatch recusa EXATAMENTE a cota, a partir do primeiro batch — sem sorte', () => {
    const rejected = (n: number, ratio: number): number[] =>
      Array.from({ length: n }, (_, i) => i).filter((i) => shouldRejectBatch(i, ratio));
    expect(rejected(10, 0.2)).toEqual([0, 5]);
    expect(rejected(4, 0.2)).toEqual([0]);
    expect(rejected(100, 0.2)).toHaveLength(20);
    expect(rejected(7, 0.5)).toEqual([0, 2, 4, 6]);
    expect(rejected(10, 0)).toEqual([]);
    expect(rejected(3, 1)).toEqual([0, 1, 2]);
  });

  it('isDirectInvocation só é verdadeiro para o próprio entrypoint', () => {
    expect(isDirectInvocation(undefined, import.meta.url)).toBe(false);
    expect(isDirectInvocation('/x/outro.ts', import.meta.url)).toBe(false);
  });
});
