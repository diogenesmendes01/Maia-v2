/**
 * Issue #626 (fatia C da #505) — as séries do escalonamento por stream existem
 * ANTES da primeira ocorrência.
 *
 * O critério de pronto da issue é "`maia_stream_fifo_violation_total` existe e é
 * sempre zero". As duas metades são independentes, e a primeira é a que quase
 * ninguém testa: `src/lib/metrics.ts` cria a série na PRIMEIRA incrementação,
 * então uma métrica que (corretamente) nunca é incrementada **não aparece** em
 * `/metrics`. Um alerta escrito contra ela nunca dispara — e não por estar tudo
 * bem, mas por não haver série. É a forma mais silenciosa de um alerta falhar, e
 * ela se parece exatamente com sucesso.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registrarSeriesDeStream,
  recordStreamBlocked,
  recordStreamFifoViolation,
  _resetSeedForTests,
} from '../../../src/runtime/turns/stream-metrics.js';
import {
  STREAM_BLOCKED_REASONS,
  STREAM_FIFO_VIOLATION_STAGES,
  STREAM_PROMOTION_RESULTS,
} from '../../../src/runtime/turns/claim.js';
import { renderPrometheus, _resetForTests as resetMetrics } from '../../../src/lib/metrics.js';

describe('#626 — séries do escalonamento por stream', () => {
  beforeEach(() => {
    resetMetrics();
    _resetSeedForTests();
  });

  it('semeia TODAS as combinações de label em zero', async () => {
    registrarSeriesDeStream();
    const body = await renderPrometheus();
    for (const stage of STREAM_FIFO_VIOLATION_STAGES) {
      expect(body).toContain(`maia_stream_fifo_violation_total{stage="${stage}"} 0`);
    }
    for (const reason of STREAM_BLOCKED_REASONS) {
      expect(body).toContain(`maia_stream_blocked_total{reason="${reason}"} 0`);
    }
    // #627 — e aqui a semeadura importa MAIS do que nas outras: numa instalação
    // saudável `fence_rejected` e `recovered` podem passar semanas em zero, e
    // uma série ausente é indistinguível de "nunca aconteceu" para o alerta.
    for (const result of STREAM_PROMOTION_RESULTS) {
      expect(body).toContain(`maia_stream_promotion_total{result="${result}"} 0`);
    }
  });

  it('semear duas vezes não duplica nem soma', async () => {
    // A semeadura roda no boot e é exportada para as specs. Se ela SOMASSE, um
    // segundo boot (ou uma spec que a chamasse de novo) publicaria uma violação
    // que nunca aconteceu — e a série que a issue manda vigiar em zero passaria
    // a mentir na direção mais cara possível.
    registrarSeriesDeStream();
    _resetSeedForTests();
    registrarSeriesDeStream();
    const body = await renderPrometheus();
    expect(body).toContain('maia_stream_fifo_violation_total{stage="claim"} 0');
  });

  it('a incrementação real sobe a série já existente, sem criar uma paralela', async () => {
    registrarSeriesDeStream();
    recordStreamFifoViolation('recovery');
    recordStreamBlocked('not_head');
    const body = await renderPrometheus();
    expect(body).toContain('maia_stream_fifo_violation_total{stage="recovery"} 1');
    expect(body).toContain('maia_stream_fifo_violation_total{stage="claim"} 0');
    expect(body).toContain('maia_stream_blocked_total{reason="not_head"} 1');
    // Uma linha por combinação — não duas.
    const linhas = body.split('\n').filter((l) => l.startsWith('maia_stream_fifo_violation_total'));
    expect(linhas).toHaveLength(STREAM_FIFO_VIOLATION_STAGES.length);
  });

  it('o registrador é IDEMPOTENTE mesmo sem reset — chamar de novo não zera o contado', async () => {
    // `registrarSeriesDeStream` é chamada por `recordStreamFifoViolation` como
    // rede. Se ela reescrevesse a série em zero, a própria violação apagaria a
    // evidência dela.
    registrarSeriesDeStream();
    recordStreamFifoViolation('claim');
    registrarSeriesDeStream();
    const body = await renderPrometheus();
    expect(body).toContain('maia_stream_fifo_violation_total{stage="claim"} 1');
  });

  /**
   * ANTI-ARMADILHA-DO-ESPELHO. Os casos acima chamam a semeadura eles mesmos,
   * então continuariam verdes com a fiação de produção deletada. Este passa por
   * `registerRuntimeObservability()` — o único ponto que o boot chama — e
   * afirma que as séries existem depois. Remova a chamada de
   * `src/observability/register.ts` e este caso reprova.
   */
  it('é fiado a partir de registerRuntimeObservability, o ponto de registro do boot', async () => {
    resetMetrics();
    _resetSeedForTests();
    const { registerRuntimeObservability } = await import(
      '../../../src/observability/register.js'
    );
    await registerRuntimeObservability();
    const body = await renderPrometheus();
    expect(body).toContain('maia_stream_fifo_violation_total{stage="claim"} 0');
    expect(body).toContain('maia_stream_fifo_violation_total{stage="recovery"} 0');
    expect(body).toContain('maia_stream_blocked_total{reason="not_head"} 0');
    expect(body).toContain('maia_stream_promotion_total{result="promoted"} 0');
    expect(body).toContain('maia_stream_promotion_total{result="fence_rejected"} 0');
    expect(body).toContain('maia_stream_promotion_total{result="recovered"} 0');
  }, 30_000);
});
