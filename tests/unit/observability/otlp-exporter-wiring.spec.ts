/**
 * Issue #535 §1 — a FIAÇÃO do exporter OTLP, não o exporter.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A lacuna que este arquivo fecha
 * ─────────────────────────────────────────────────────────────────────────
 * `tests/unit/observability/otlp-exporter.spec.ts` exercita `OtlpSpanExporter`
 * diretamente: encoding OTLP, fila limitada, perda contada. Tudo isso continua
 * verde com a ÚNICA linha que liga o exporter em produção — `startOtlpExporter()`
 * no fim de `registerRuntimeObservability()` (`src/observability/register.ts`) —
 * apagada. Medido: sem essa linha, `Test Files 656 passed`, `executados=8426
 * falharam=0`, nenhum recuperado por retry. O exporter existia, era bom, e
 * ninguém garantia que ele SOBE.
 *
 * É a mesma falha com que a #535 abre, uma camada abaixo: quem lê a taxonomia
 * (ou a suíte do exporter) conclui que a cobertura é maior do que é.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que estes casos passam por `registerRuntimeObservability()`
 * ─────────────────────────────────────────────────────────────────────────
 * Chamar `startOtlpExporter()` aqui seria o MESMO espelho que deixou a lacuna
 * passar. O caminho de produção é `server.ts:76` → `registerRuntimeObservability()`
 * → `startOtlpExporter()`, e é por ele que estes casos entram. A única coisa
 * que este arquivo importa de `otlp-exporter.js` é `stopOtlpExporter()`, e só
 * como TEARDOWN: o módulo guarda a instância ativa num singleton (`active`), e
 * sem zerá-lo entre casos a segunda chamada seria no-op — o que transformaria
 * uma invariante absoluta numa asserção sobre estado herdado.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Invariantes ABSOLUTAS, nunca delta
 * ─────────────────────────────────────────────────────────────────────────
 * `vitest.config.ts:130` tem `retry: 1`, e a segunda tentativa herda o estado
 * de módulo da primeira. Uma asserção do tipo "a profundidade da fila CRESCEU"
 * ficaria verde na retry sem que nada tivesse sido fiado. Então cada caso zera
 * TUDO o que vai medir (registry de métricas, sink do tracer, singleton do
 * exporter) e afirma o valor absoluto: sink armado, e `maia_otlp_queue_depth`
 * EXATAMENTE 1 depois de exatamente um span.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * O exporter é inerte sem endpoint — é o estado "off" suportado, e é o estado
 * em que a suíte unitária inteira roda. Um teste da fiação precisa do estado
 * LIGADO, então o contrato é lido por um Proxy que sobrepõe só as duas chaves
 * que importam e delega o resto ao `config` real (mesmo padrão de
 * `otlp-exporter.spec.ts`).
 *
 * `127.0.0.1:1` nunca tem ouvinte: o flush do teardown falha com ECONNREFUSED
 * na hora (e `fetchTransport` engole), em vez de pendurar o teste numa
 * resolução de DNS. Ratio 1 porque a amostragem é derivada do trace id — com o
 * default de 0.05 o span do caso seria descartado em ~95% das rodadas, o que é
 * um flake, não um teste.
 */
vi.mock('@/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env.js')>();
  const OVERRIDES: Readonly<Record<string, unknown>> = {
    MAIA_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:1/v1/traces',
    MAIA_OTLP_SAMPLE_RATIO: 1,
  };
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, prop, receiver) =>
        typeof prop === 'string' && prop in OVERRIDES
          ? OVERRIDES[prop]
          : Reflect.get(target, prop, receiver),
    }),
  };
});

import { _resetForTests as resetMetrics, renderPrometheus } from '@/lib/metrics.js';
import { _resetLabelGuardForTests } from '@/observability/labels.js';
import { stopOtlpExporter } from '@/observability/otlp-exporter.js';
import { METRIC, SPAN } from '@/observability/taxonomy.js';
import { _resetTracerForTests, tracingEnabled, withSpan } from '@/observability/tracer.js';
import { moduloDeProducao } from '../../helpers/modulo-de-producao.js';

const registrador = moduloDeProducao(() => import('@/observability/register.js'));

/**
 * `registerRuntimeObservability()` importa LAZY o grafo pesado (`db/client`,
 * `gateway/baileys`) — 2s a 7s a frio, medido na #545. Pagar isso uma vez no
 * `beforeAll` (que tem orçamento próprio) mantém o corpo dos casos medindo os
 * casos, e o `stopOtlpExporter()` logo em seguida devolve o singleton ao estado
 * "nada fiado" com que cada caso precisa começar.
 */
beforeAll(async () => {
  await registrador().registerRuntimeObservability();
  await stopOtlpExporter();
}, 40_000);

beforeEach(async () => {
  await stopOtlpExporter();
  _resetTracerForTests();
  resetMetrics();
  _resetLabelGuardForTests();
});

afterEach(async () => {
  await stopOtlpExporter();
  _resetTracerForTests();
});

describe('issue #535 — o boot ARMA o exporter OTLP (fiação, não espelho)', () => {
  /**
   * Apague `startOtlpExporter();` de `src/observability/register.ts` e este
   * caso reprova: sem sink, `tracingEnabled()` é `false` e todo o caminho de
   * span curto-circuita antes de alocar qualquer coisa.
   */
  it('depois de registerRuntimeObservability, o tracer tem destino', async () => {
    expect(tracingEnabled()).toBe(false);

    await registrador().registerRuntimeObservability();

    expect(tracingEnabled()).toBe(true);
  }, 30_000);

  /**
   * A prova ponta a ponta, e a que não aceita substituto: um span aberto pelo
   * tracer REAL depois do boot tem de chegar na fila do exporter REAL. O
   * gauge `maia_otlp_queue_depth` é publicado por `OtlpSpanExporter.start()`,
   * então ele só existe se o exporter subiu — a AUSÊNCIA da série já reprova,
   * e o valor absoluto `1` prova que o span atravessou.
   */
  it('um span aberto depois do boot aterrissa na fila do exporter', async () => {
    await registrador().registerRuntimeObservability();

    await withSpan(SPAN.TURN, async () => undefined);

    const body = await renderPrometheus();
    expect(body).toMatch(new RegExp(`^${METRIC.OTLP_QUEUE_DEPTH} 1$`, 'm'));
  }, 30_000);

  /**
   * Sem o boot não há série NENHUMA — o contrapositivo do caso acima, e o que
   * torna a ausência acima significativa em vez de acidental.
   */
  it('sem o boot, nem a série da fila nem o span existem', async () => {
    await withSpan(SPAN.TURN, async () => undefined);

    const body = await renderPrometheus();
    expect(body).not.toContain(METRIC.OTLP_QUEUE_DEPTH);
  });
});
