/**
 * Issue #519 — o BACKLOG do `onboarding_expirer` como sinal de scrape.
 *
 * O worker (`src/workers/onboarding-expirer.ts`) expira um lote limitado por
 * tick e conta o que fez. O que ele NÃO consegue dizer é se o lote está dando
 * conta: drenando 1.200 runs/hora com 3.000 vencidas na fila, todas as séries
 * do worker ficam verdes enquanto o atraso cresce. Estas duas gauges são a
 * outra metade — quantas esperam e há quanto tempo espera a mais atrasada.
 *
 * ## Por que no SCRAPE, e não publicado pelo worker
 *
 * Uma métrica de fila que o worker publica CONGELA no último valor se o worker
 * parar — que é justamente a falha que ela deveria pegar. Um `onboarding_expirer`
 * desagendado, quebrado, ou implantado num papel que não roda cron deixaria
 * `maia_onboarding_expiry_backlog` parado no último número saudável enquanto a
 * fila cresce. Lendo o banco no scrape, o backlog sobe sozinho, não importa
 * POR QUE nada o drenou. É o mesmo argumento — e o mesmo desenho — de
 * `backup-readiness-collector.ts` (#536).
 *
 * ## Postura de falha
 *
 * Um refresh que falha derruba o snapshot e as duas séries viram `NaN`, não
 * `0`. Zero seria "a fila está vazia", que é a leitura mais perigosa possível
 * de uma leitura que não aconteceu — a regra "métrica ausente não é
 * interpretada como zero saudável" da #514. É a mesma escolha de
 * `registerSchedulerLagGauges` e a diferença deliberada em relação a
 * `turn-state-collector.ts` (onde uma CONTAGEM velha é só velha; aqui um
 * backlog velho afirma ativamente que está tudo bem).
 */
import { gauge, METRIC } from './metrics.js';
import { logger } from '@/lib/logger.js';

/** Uma leitura do backlog. Só números — nenhum id de run, nenhum tenant. */
export interface OnboardingExpiryBacklog {
  /** Runs vencidas e ainda não terminais. */
  readonly backlog: number;
  /** Idade da mais atrasada, em segundos. 0 quando não há fila. */
  readonly oldest_age_seconds: number;
}

export type OnboardingExpiryBacklogSource = () => Promise<OnboardingExpiryBacklog>;

/**
 * Janela do snapshot. As duas gauges de um mesmo scrape compartilham UMA
 * leitura — mesma razão de `turn-state-collector.ts`: um provider por série não
 * pode virar uma query por série.
 */
const SNAPSHOT_TTL_MS = 15_000;

let snapshot: OnboardingExpiryBacklog | null = null;
let lastRefreshAt = 0;
let inFlight: Promise<void> | null = null;
let registered = false;
let source: OnboardingExpiryBacklogSource | null = null;

async function refresh(): Promise<void> {
  if (snapshot !== null && Date.now() - lastRefreshAt < SNAPSHOT_TTL_MS) return;
  if (inFlight) return inFlight;
  lastRefreshAt = Date.now();
  inFlight = (async () => {
    try {
      snapshot = (await source?.()) ?? null;
    } catch (err) {
      // DERRUBA o snapshot — ver "Postura de falha" no cabeçalho.
      snapshot = null;
      logger.debug(
        { err: (err as Error).message },
        'onboarding_expiry_collector.refresh_failed',
      );
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function read(field: keyof OnboardingExpiryBacklog): () => Promise<number> {
  return async () => {
    await refresh();
    const current = snapshot;
    if (!current) return Number.NaN;
    const v = current[field];
    return Number.isFinite(v) ? v : Number.NaN;
  };
}

/**
 * Registra `maia_onboarding_expiry_backlog` e
 * `maia_onboarding_expiry_oldest_age_seconds`.
 *
 * Idempotente: os providers são chaveados pelo nome da série (registrar de novo
 * substituiria, nunca empilharia), e a flag impede que ciclos repetidos de
 * `buildServer()` em teste troquem a fonte por baixo de um snapshot vivo.
 */
export function registerOnboardingExpiryGauges(
  backlogSource: OnboardingExpiryBacklogSource,
): void {
  source = backlogSource;
  if (registered) return;
  gauge(METRIC.ONBOARDING_EXPIRY_BACKLOG, read('backlog'));
  gauge(METRIC.ONBOARDING_EXPIRY_OLDEST_AGE_SECONDS, read('oldest_age_seconds'));
  registered = true;
}

/** Test-only: o estado de módulo sobrevive entre specs. */
export function _resetOnboardingExpiryCollectorForTests(): void {
  snapshot = null;
  lastRefreshAt = 0;
  inFlight = null;
  registered = false;
  source = null;
}
