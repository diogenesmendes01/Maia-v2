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
import { safeFailure } from '@/lib/safe-failure.js';

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
/**
 * Instante da última TENTATIVA — não da última leitura bem-sucedida.
 *
 * Review da PR #560: enquanto a janela era `snapshot !== null && ...`, ela só
 * valia no caminho feliz. Com o Postgres fora, o primeiro provider deixava
 * `snapshot = null`, e como `renderPrometheus()` avalia as gauges em
 * sequência, o segundo provider caía direto em `refresh()` e consultava o
 * banco DE NOVO no mesmo scrape — duas queries que já se sabiam condenadas,
 * amplificando pressão exatamente durante o incidente. A tentativa é o que
 * conta para a janela; o desfecho dela é outra coisa.
 *
 * A janela vale para os DOIS desfechos, e é isso que dá o comportamento
 * correto: uma falha segura `NaN` por 15s (fail-closed continua valendo — ver
 * "Postura de falha") em vez de virar tempestade de retry por scrape.
 */
let lastAttemptAt = 0;
let inFlight: Promise<void> | null = null;
let registered = false;
let source: OnboardingExpiryBacklogSource | null = null;

async function refresh(): Promise<void> {
  // A ORDEM destas duas guardas é o single-flight, e ela estava invertida
  // (round 2 do review da PR #560). Com o TTL primeiro: o scrape A entra,
  // carimba `lastAttemptAt` e deixa a consulta pendente; o scrape B que chega
  // durante essa janela vê o TTL FRESCO e volta na hora, sem esperar — e
  // publica o snapshot anterior, ou `NaN` se for a primeira leitura, enquanto
  // a leitura corrente ainda está em curso. Dois `/metrics` simultâneos
  // discordavam, e um deles podia afirmar "desconhecido" ou "saudável" sem
  // base.
  //
  // Com `inFlight` primeiro, todo consumidor concorrente recebe A MESMA
  // promise e enxerga o mesmo resultado novo. O TTL volta a valer depois que
  // ela assenta (`inFlight` volta a `null` no `finally`).
  if (inFlight) return inFlight;
  if (Date.now() - lastAttemptAt < SNAPSHOT_TTL_MS) return;
  lastAttemptAt = Date.now();
  inFlight = (async () => {
    try {
      snapshot = (await source?.()) ?? null;
    } catch (err) {
      // DERRUBA o snapshot — ver "Postura de falha" no cabeçalho.
      snapshot = null;
      // #533 / review da PR #560: a mensagem crua de uma falha de conexão
      // carrega a DSN inteira, e habilitar debug para investigar Postgres é
      // exatamente quando ela seria escrita. Mesmo recorte sanitizado e
      // bounded do worker desta área, agora compartilhado — sem `cause`.
      logger.debug(
        { err: safeFailure(err) },
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
  lastAttemptAt = 0;
  inFlight = null;
  registered = false;
  source = null;
}
