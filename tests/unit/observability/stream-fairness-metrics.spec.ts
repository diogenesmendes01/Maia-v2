/**
 * Issue #629 (fatia F da #505) — as séries de FAIRNESS existem, têm a forma
 * certa, e não carregam label de alta cardinalidade.
 *
 * As três coisas que este arquivo cobra, e que nenhum teste de integração
 * cobriria de graça:
 *
 *   1. `maia_stream_starvation_total` conta EPISÓDIOS, não amostras. Um
 *      contador incrementado a cada coleta mede a frequência do Prometheus, e
 *      o sintoma é uma série que "prova" starvation onde não há;
 *   2. o conjunto de deduplicação é PODADO. Sem a poda ele cresceria com a
 *      cardinalidade histórica de conversas do processo — vazamento lento, do
 *      tipo que só aparece em produção;
 *   3. NENHUMA das séries carrega `stream_key`, `turn_id`, `tenant` ou o
 *      código de erro cru como label. A issue-mãe proíbe os dois primeiros por
 *      escrito, e o último é `[a-z0-9_]{1,64}` livre — a cardinalidade
 *      cresceria com o CÓDIGO da plataforma.
 *
 * Sem banco: a fonte do coletor é injetada.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerStreamFairnessGauges,
  _resetStarvationStateForTests,
  type StreamFairnessSource,
} from '../../../src/observability/stream-fairness-collector.js';
import {
  registrarSeriesDeStream,
  recordPoisonDecision,
  STREAM_TURN_WAIT_BUCKETS,
  _resetSeedForTests,
} from '../../../src/runtime/turns/stream-metrics.js';
import {
  POISON_CATEGORIES,
  POISON_DISPOSITIONS,
} from '../../../src/runtime/turns/poison-policy.js';
import {
  renderPrometheus,
  observeHistogram,
  _resetForTests as resetMetrics,
} from '../../../src/lib/metrics.js';

type Snapshot = Awaited<ReturnType<StreamFairnessSource['snapshot']>>;

const vazio: Snapshot = {
  live_streams: 0,
  active_streams: 0,
  max_backlog: 0,
  max_head_age_s: 0,
  p95_head_age_s: 0,
  starving_tokens: [],
};

function fonte(snaps: Snapshot[], blocked = 0): StreamFairnessSource {
  let i = 0;
  return {
    snapshot: async () => snaps[Math.min(i++, snaps.length - 1)] ?? vazio,
    countBlocked: async () => blocked,
    starvationAfterMs: () => 60_000,
  };
}

/** Força a próxima coleta: o coletor coalesce leituras dentro de 5s. */
function expirarCache(): void {
  vi.setSystemTime(Date.now() + 6_000);
}

async function starvation(): Promise<number> {
  const body = await renderPrometheus();
  const m = /^maia_stream_starvation_total (\d+)/m.exec(body);
  return m ? Number(m[1]) : -1;
}

describe('#629 — séries de fairness do escalonamento por stream', () => {
  beforeEach(() => {
    resetMetrics();
    _resetSeedForTests();
    _resetStarvationStateForTests();
    vi.useRealTimers();
  });

  it('publica os gauges e semeia o contador de starvation em zero', async () => {
    registerStreamFairnessGauges(fonte([vazio]));
    const body = await renderPrometheus();
    // Numa instalação saudável o contador nunca é incrementado — e uma série
    // ausente é indistinguível de "nunca aconteceu" para todo alerta escrito
    // contra ela.
    expect(body).toMatch(/^maia_stream_starvation_total 0$/m);
    expect(body).toMatch(/^maia_stream_head_age_seconds 0$/m);
    expect(body).toMatch(/^maia_stream_head_age_p95_seconds 0$/m);
    expect(body).toMatch(/^maia_stream_active_total 0$/m);
    expect(body).toMatch(/^maia_stream_live_total 0$/m);
    expect(body).toMatch(/^maia_stream_backlog_max 0$/m);
    expect(body).toMatch(/^maia_stream_poisoned_streams 0$/m);
  });

  it('os gauges refletem o retrato do banco', async () => {
    registerStreamFairnessGauges(
      fonte(
        [
          {
            live_streams: 12,
            active_streams: 4,
            max_backlog: 7,
            max_head_age_s: 931.6,
            p95_head_age_s: 120.4,
            starving_tokens: [],
          },
        ],
        3,
      ),
    );
    const body = await renderPrometheus();
    expect(body).toMatch(/^maia_stream_live_total 12$/m);
    expect(body).toMatch(/^maia_stream_active_total 4$/m);
    expect(body).toMatch(/^maia_stream_backlog_max 7$/m);
    // Arredondado: um gauge de segundos com sete casas decimais só polui o
    // painel — a precisão útil da idade de um head é o segundo.
    expect(body).toMatch(/^maia_stream_head_age_seconds 932$/m);
    expect(body).toMatch(/^maia_stream_head_age_p95_seconds 120$/m);
    expect(body).toMatch(/^maia_stream_poisoned_streams 3$/m);
  });

  it('starvation conta EPISÓDIOS: a mesma conversa faminta não é recontada', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:00Z'));
    const faminta: Snapshot = { ...vazio, live_streams: 1, starving_tokens: ['tok-a'] };
    registerStreamFairnessGauges(fonte([faminta]));

    // `renderPrometheus` emite os CONTADORES antes de rodar os providers de
    // GAUGE, e quem detecta é o provider — então o scrape que DETECTA ainda
    // mostra o valor anterior. Documentado, e afirmado, para que ninguém
    // "conserte" o teste esperando 1 no primeiro.
    expect(await starvation()).toBe(0);
    expect(await starvation()).toBe(1);

    for (let i = 0; i < 4; i++) {
      expirarCache();
      expect(await starvation()).toBe(1);
    }
    vi.useRealTimers();
  });

  it('uma conversa NOVA faminta soma; a que saiu da fome não deixa resíduo', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:00Z'));
    const a: Snapshot = { ...vazio, starving_tokens: ['tok-a'] };
    const ab: Snapshot = { ...vazio, starving_tokens: ['tok-a', 'tok-b'] };
    const so_b: Snapshot = { ...vazio, starving_tokens: ['tok-b'] };
    const a_de_novo: Snapshot = { ...vazio, starving_tokens: ['tok-b', 'tok-a'] };
    registerStreamFairnessGauges(fonte([a, ab, so_b, a_de_novo]));

    await starvation();
    expect(await starvation()).toBe(1); // tok-a

    expirarCache();
    await starvation();
    expect(await starvation()).toBe(2); // + tok-b

    expirarCache();
    await starvation();
    expect(await starvation()).toBe(2); // tok-a saiu da fome: nada a somar

    // E VOLTOU a ficar faminta: é um EPISÓDIO NOVO, e conta. A poda do conjunto
    // é o que torna isso verdade — sem ela, `tok-a` continuaria "conhecido"
    // para sempre e o segundo episódio seria invisível.
    expirarCache();
    await starvation();
    expect(await starvation()).toBe(3);
    vi.useRealTimers();
  });

  it('uma falha da fonte NÃO derruba o scrape nem zera o gauge', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:00Z'));
    let falhar = false;
    const source: StreamFairnessSource = {
      snapshot: async () => {
        if (falhar) throw new Error('banco fora');
        return { ...vazio, live_streams: 9, max_head_age_s: 42 };
      },
      countBlocked: async () => 0,
      starvationAfterMs: () => 60_000,
    };
    registerStreamFairnessGauges(source);
    expect(await renderPrometheus()).toMatch(/^maia_stream_live_total 9$/m);

    falhar = true;
    expirarCache();
    const body = await renderPrometheus();
    // O ÚLTIMO valor conhecido, e não zero. Um head age que despenca a zero
    // durante uma indisponibilidade do banco é a leitura mais enganosa possível
    // de uma métrica de fairness — e é exatamente o que um `catch { return 0 }`
    // produziria.
    expect(body).toMatch(/^maia_stream_live_total 9$/m);
    expect(body).toMatch(/^maia_stream_head_age_seconds 42$/m);
    vi.useRealTimers();
  });

  it('os baldes da espera são os de SEGUNDOS, não os de milissegundos do default', async () => {
    // `src/lib/metrics.ts` CONGELA os baldes na primeira amostra. Com o padrão
    // (ms), toda espera abaixo de 10s cairia em `le="50"` e a série responderia
    // a `histogram_quantile()` com um número que parece medido.
    registrarSeriesDeStream();
    observeHistogram('maia_stream_turn_wait_seconds', 3.2);
    const body = await renderPrometheus();
    for (const b of STREAM_TURN_WAIT_BUCKETS) {
      expect(body).toContain(`maia_stream_turn_wait_seconds_bucket{le="${b}"}`);
    }
    expect(body).toMatch(/^maia_stream_turn_wait_seconds_count 1$/m);
    // 3.2s cai em `le="5"` e não em `le="2"`.
    expect(body).toMatch(/^maia_stream_turn_wait_seconds_bucket\{le="2"\} 0$/m);
    expect(body).toMatch(/^maia_stream_turn_wait_seconds_bucket\{le="5"\} 1$/m);
  });

  it('a política de poison é semeada em TODAS as 12 combinações', async () => {
    registrarSeriesDeStream();
    const body = await renderPrometheus();
    for (const category of POISON_CATEGORIES) {
      for (const disposition of POISON_DISPOSITIONS) {
        expect(body).toContain(
          `maia_stream_poison_total{category="${category}",disposition="${disposition}"} 0`,
        );
      }
    }
  });

  it('NENHUMA série de stream carrega label de alta cardinalidade', async () => {
    registrarSeriesDeStream();
    registerStreamFairnessGauges(
      fonte([{ ...vazio, live_streams: 1, starving_tokens: ['token-opaco-md5'] }]),
    );
    recordPoisonDecision('effect_committed', 'block_stream');
    observeHistogram('maia_stream_turn_wait_seconds', 1);
    const body = await renderPrometheus();
    await renderPrometheus();

    const linhas = body.split('\n').filter((l) => l.startsWith('maia_stream_'));
    expect(linhas.length).toBeGreaterThan(0);
    for (const linha of linhas) {
      const labels = /\{([^}]*)\}/.exec(linha)?.[1] ?? '';
      // Os proibidos por escrito na issue-mãe, mais o `turn_id`.
      expect(labels).not.toMatch(/stream_key|remote_jid|turn_id|conversa|tenant|agent_id/);
      // E o código de erro cru — `[a-z0-9_]{1,64}` livre — nunca. A CATEGORIA
      // existe exatamente para ser a projeção de cardinalidade fechada dele.
      expect(labels).not.toMatch(/error_code/);
    }
    // O token opaco da deduplicação de starvation NUNCA vaza para o corpo.
    expect(body).not.toContain('token-opaco-md5');
  });

  /**
   * ANTI-ARMADILHA-DO-ESPELHO. Os casos acima registram o coletor eles mesmos,
   * então continuariam verdes com a fiação de produção deletada. Este passa por
   * `registerRuntimeObservability()` — o único ponto que o boot chama — e
   * afirma que as séries existem depois. Remova a chamada de
   * `src/observability/register.ts` e este caso reprova.
   */
  it('é fiado a partir de registerRuntimeObservability, o ponto de registro do boot', async () => {
    resetMetrics();
    _resetSeedForTests();
    _resetStarvationStateForTests();
    const { registerRuntimeObservability } = await import(
      '../../../src/observability/register.js'
    );
    await registerRuntimeObservability();
    const body = await renderPrometheus();
    expect(body).toMatch(/^maia_stream_starvation_total 0$/m);
    // Os gauges saem do provider registrado: com o banco fora (o caso deste
    // teste unitário) o `catch` devolve 0, e a SÉRIE existindo é o que importa.
    expect(body).toMatch(/^maia_stream_head_age_seconds \d+$/m);
    expect(body).toMatch(/^maia_stream_active_total \d+$/m);
    expect(body).toMatch(/^maia_stream_live_total \d+$/m);
    expect(body).toMatch(/^maia_stream_backlog_max \d+$/m);
    expect(body).toMatch(/^maia_stream_poisoned_streams \d+$/m);
    expect(body).toContain(
      'maia_stream_poison_total{category="effect_committed",disposition="block_stream"} 0',
    );
  }, 30_000);
});
