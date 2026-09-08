/**
 * Semeadura das séries do debounce transacional — issue #628, extraída em #726.
 *
 * Este módulo existe para ser BARATO de importar. Ele era parte de
 * `./stream-debounce.ts`, que precisa de `@/governance/audit.js` e, por ele,
 * do barrel `@/db/repositories.js` — 84 arquivos de `src/` (1,8 MB de TS),
 * 1,4 s sob o vitest. O único chamador da semeadura fora do fluxo do turno é
 * `src/observability/register.ts`, no boot, e ele não precisa de nada disso:
 * a semeadura é métricas + taxonomia, sem I/O. `stream-debounce.ts` continua
 * reexportando `registrarSeriesDeDebounce` / `_resetSeedForTests`, então os
 * chamadores existentes não mudam.
 */
import { incCounter, registerHistogramBuckets } from '@/lib/metrics.js';
import { METRIC, STREAM_DEBOUNCE_CLOSE_RESULTS } from '@/observability/taxonomy.js';

/**
 * Os baldes de `maia_stream_debounce_batch_size`.
 *
 * Um batch tem entre 1 e uma dezena de mensagens. Os baldes padrão de
 * `src/lib/metrics.ts` são de MILISSEGUNDOS (50, 100, 250, …), então sem esta
 * declaração toda amostra cairia em `le="50"` e a série pareceria uma
 * distribuição sem separar nada — um `histogram_quantile()` devolveria um
 * número que parece medido e não é.
 *
 * O `1` como primeiro balde não é decoração: `le="1"` sobre o total é a fração
 * de rodadas em que o debounce NÃO agrupou nada, que é a única leitura que
 * responde "esta fatia está pagando por si?".
 */
const BALDES_DO_BATCH: readonly number[] = [1, 2, 3, 5, 10, 25, 50];

let semeado = false;

/**
 * Semeia as séries em zero e declara os baldes. Idempotente e sem I/O.
 *
 * Pela mesma razão de `registrarSeriesDeStream` (#626): `src/lib/metrics.ts`
 * cria a série na PRIMEIRA incrementação, então uma métrica que ainda não
 * aconteceu simplesmente não aparece em `/metrics` — e um alerta escrito contra
 * ela nunca dispara, não por estar tudo bem, mas por não haver série. É a forma
 * mais silenciosa de um alerta falhar, e ela se parece exatamente com sucesso.
 *
 * Exportada (e não um efeito de topo) porque `_resetForTests()` apaga o mapa
 * inteiro: uma spec que reseta e depois afirma "a série existe" precisa semear
 * de novo. E porque um módulo alcançado pelo grafo do repositório não pode ter
 * efeito no import — foi o que quebrou três specs alheias em #626.
 */
export function registrarSeriesDeDebounce(): void {
  registerHistogramBuckets(METRIC.STREAM_DEBOUNCE_BATCH_SIZE, BALDES_DO_BATCH);
  if (semeado) return;
  semeado = true;
  for (const result of STREAM_DEBOUNCE_CLOSE_RESULTS) {
    incCounter(METRIC.STREAM_DEBOUNCE_CLOSE, { result }, 0);
  }
}

/** Só para teste: permite semear de novo depois de `_resetForTests()`. */
export function _resetSeedForTests(): void {
  semeado = false;
}
