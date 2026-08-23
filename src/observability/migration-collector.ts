/**
 * Issue #516 §Observabilidade — o estado do schema como sinal raspado.
 *
 * `getSchemaReadiness()` é o veredito canônico de "esta build pode servir
 * tráfego contra este banco?" desde a #516, e até aqui ele só era consumido por
 * quem PERGUNTA no momento: `/readyz`, `maia doctor`, `migrate status`. Nada o
 * publicava. Consequência prática: nenhum dashboard, nenhuma regra de alerta e
 * nenhuma série histórica sabiam dizer que um banco ficou dez horas com uma
 * migration `dirty` — a evidência existia e não saía do processo. Este coletor
 * é a publicação.
 *
 * ## Por que raspado no scrape, e não publicado pelo migrator
 *
 * O mesmo argumento de `backup-readiness-collector.ts`, e aqui ele é ainda mais
 * forte. O migrator é um job ONE-SHOT (`docker-compose.yml`, serviço
 * `migrate`): ele roda, sai, e o container morre. Um gauge que ELE publicasse
 * nunca seria raspado por ninguém. Lendo o veredito no scrape, a série descreve
 * o banco como ele está agora — inclusive quando o migrator nunca rodou, que é
 * precisamente o estado que precisa aparecer vermelho.
 *
 * ## O que NÃO está aqui: o tempo esperando o lock
 *
 * A #516 pede cinco sinais e este módulo publica quatro. O quinto — quanto o
 * migrator esperou pelo advisory lock — é conhecido só DENTRO do processo que
 * migrou (`MigrationRunResult.lock_waited_ms`), e esse processo é o job
 * one-shot que ninguém raspa. Publicá-lo como gauge no runtime produziria uma
 * série permanentemente sem medição, que é pior que ausência: parece um sinal.
 * Ele continua onde é observável — os eventos estruturados
 * `migration.lock_wait` / `migration.lock_acquired` que a CLI imprime e o
 * `docker compose logs migrate` carrega. O que a métrica cobre é a CONSEQUÊNCIA
 * de alguém segurar o lock demais: `pending` que não cai.
 *
 * ## Atribuição
 *
 * Séries globais, sem `tenant_id`/`agent_id`, pelo caminho sancionado
 * (`./metrics.js::gauge`, que aplica allowlist, guard de PII e teto de
 * cardinalidade). A justificativa completa está em `taxonomy.ts`, junto dos
 * nomes: DDL de schema não é trabalho de tenant, e o lock que a serializa é um
 * só para o database inteiro.
 */
import { gauge, gaugeName } from './metrics.js';
import { METRIC } from './taxonomy.js';
import { logger } from '@/lib/logger.js';
import type { SchemaReadiness } from '@/migrations/types.js';

/**
 * Janela do snapshot. As quatro famílias compartilham UMA leitura, então um
 * scrape custa um veredito, não cinco — mesmo motivo pelo qual
 * `turn-state-collector.ts` e `backup-readiness-collector.ts` cacheiam.
 *
 * Curto de propósito: a fonte injetada em produção
 * (`checkSchemaReadiness()`) já tem o próprio TTL de 10s com single-flight, e
 * duplicar aquele número aqui criaria dois prazos para a mesma verdade. Esta
 * janela existe só para colapsar os providers de um mesmo scrape.
 */
const SNAPSHOT_TTL_MS = 5_000;

export interface MigrationCollectorDeps {
  /** Veredito canônico de schema. NUNCA lança (contrato de `readiness.ts`). */
  readonly readVerdict: () => Promise<SchemaReadiness>;
  readonly now?: () => number;
}

/**
 * Números que os providers servem. `null` = a leitura não pôde ser feita, e
 * todo provider devolve `NaN` nesse caso.
 *
 * `NaN` e não `0`: a doutrina da #514 que este repositório repete em todo
 * coletor — "métrica ausente não é interpretada como zero saudável". Aqui a
 * regra tem dentes de verdade, porque `0` é uma leitura VÁLIDA e desejável de
 * `pending` e de `dirty`. Um coletor que devolvesse 0 ao falhar reportaria
 * "schema no head, nada sujo" exatamente durante a indisponibilidade do banco.
 */
interface Snapshot {
  readonly expected_head_ordinal: number;
  readonly applied_head_ordinal: number;
  readonly pending: number;
  readonly dirty: number;
  readonly last_duration_ms: number;
}

let snapshot: Snapshot | null = null;
let lastRefreshAt = 0;
let inFlight: Promise<void> | null = null;
let registered = false;

/**
 * Posição (1-based) de um id na lista ordenada de migrations conhecidas.
 *
 * `null` (id ausente) devolve `0` — "nenhuma", que é a leitura verdadeira de um
 * banco virgem. Um id que existe mas não está na lista devolve `NaN`: é o banco
 * que rodou uma migration que esta build não conhece, e fingir uma posição para
 * ele seria inventar ordem onde não há.
 */
function ordinalOf(id: string | null, ids: readonly string[]): number {
  if (id === null) return 0;
  const idx = ids.indexOf(id);
  return idx < 0 ? Number.NaN : idx + 1;
}

/**
 * Duração da migration aplicada MAIS RECENTEMENTE, em ms.
 *
 * "Mais recente" é por `applied_at`, não pela ordem do arquivo: uma migration
 * de branch antiga pode ser aplicada depois de uma de número maior
 * (`out_of_order` no relatório de status), e é a última execução no relógio que
 * interessa para tendência de duração.
 */
function lastDurationMs(verdict: SchemaReadiness): number {
  let bestAt = -Infinity;
  let bestMs = Number.NaN;
  for (const entry of verdict.status?.entries ?? []) {
    if (entry.state !== 'applied' || entry.applied_at === null) continue;
    const at = Date.parse(entry.applied_at);
    if (!Number.isFinite(at) || at < bestAt) continue;
    bestAt = at;
    bestMs = typeof entry.execution_ms === 'number' ? entry.execution_ms : Number.NaN;
  }
  return bestMs;
}

function toSnapshot(verdict: SchemaReadiness): Snapshot | null {
  // `status === null` é o estado `unknown`: nada foi legível. Sem snapshot ⇒
  // NaN em todas as séries, que é o que fail-closed significa numa métrica.
  if (verdict.status === null) return null;
  const ids = verdict.status.entries.map((e) => e.id);
  return {
    expected_head_ordinal: ordinalOf(verdict.expected_head, ids),
    applied_head_ordinal: ordinalOf(verdict.applied_head, ids),
    pending: verdict.pending_count,
    dirty: verdict.dirty_count,
    last_duration_ms: lastDurationMs(verdict),
  };
}

/**
 * Recalcula o snapshot, no máximo uma vez por janela.
 *
 * FAIL-CLOSED, como no coletor de backup e pelo mesmo motivo: o snapshot É um
 * veredito de segurança. Manter o último valor bom reportaria "schema
 * verificado, nada pendente" apoiado numa leitura que não aconteceu. Uma
 * atualização que falha DERRUBA o snapshot.
 */
async function refresh(deps: MigrationCollectorDeps): Promise<void> {
  const nowMs = (deps.now ?? Date.now)();
  if (snapshot !== null && nowMs - lastRefreshAt < SNAPSHOT_TTL_MS) return;
  if (inFlight) return inFlight;
  lastRefreshAt = nowMs;
  inFlight = (async () => {
    try {
      snapshot = toSnapshot(await deps.readVerdict());
    } catch (err) {
      snapshot = null;
      // CLASSE apenas: a mensagem de um erro do driver embute o DSN com a
      // senha. `getSchemaReadiness()` já garante isso, mas a fonte é injetada
      // e este catch é o que mantém a garantia independente dela.
      logger.debug(
        { error_class: (err as Error)?.constructor?.name ?? 'UnknownError' },
        'migration_collector.refresh_failed',
      );
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Nome das duas séries de head, EXATAMENTE como saem no `/metrics`.
 *
 * Exportado porque o snapshot abaixo é chaveado por ele: quem inspeciona sem
 * registrar (teste, `maia doctor`) lê a mesma chave que apareceria na raspagem,
 * em vez de uma convenção paralela que pode divergir da série de verdade.
 */
export const HEAD_SERIES = {
  expected: gaugeName(METRIC.SCHEMA_MIGRATION_HEAD, { kind: 'expected' }),
  applied: gaugeName(METRIC.SCHEMA_MIGRATION_HEAD, { kind: 'applied' }),
} as const;

/** Calcula as séries sem registrar nada (testes, inspeção). */
export async function migrationGaugeSnapshot(
  deps: MigrationCollectorDeps,
): Promise<Record<string, number>> {
  await refresh(deps);
  const s = snapshot;
  return {
    [HEAD_SERIES.expected]: s?.expected_head_ordinal ?? Number.NaN,
    [HEAD_SERIES.applied]: s?.applied_head_ordinal ?? Number.NaN,
    [METRIC.SCHEMA_MIGRATIONS_PENDING]: s?.pending ?? Number.NaN,
    [METRIC.SCHEMA_MIGRATIONS_DIRTY]: s?.dirty ?? Number.NaN,
    [METRIC.SCHEMA_MIGRATION_LAST_DURATION_MS]: s?.last_duration_ms ?? Number.NaN,
  };
}

/**
 * Registra os gauges de migration. Idempotente (os providers são chaveados por
 * nome de série, então um segundo registro substituiria em vez de empilhar; a
 * flag evita reler a configuração a cada `buildServer()` nos testes).
 */
export function registerMigrationGauges(deps: MigrationCollectorDeps): void {
  if (registered) return;
  const read = (pick: (s: Snapshot) => number) => async (): Promise<number> => {
    await refresh(deps);
    return snapshot ? pick(snapshot) : Number.NaN;
  };
  gauge(METRIC.SCHEMA_MIGRATION_HEAD, read((s) => s.expected_head_ordinal), { kind: 'expected' });
  gauge(METRIC.SCHEMA_MIGRATION_HEAD, read((s) => s.applied_head_ordinal), { kind: 'applied' });
  gauge(METRIC.SCHEMA_MIGRATIONS_PENDING, read((s) => s.pending));
  gauge(METRIC.SCHEMA_MIGRATIONS_DIRTY, read((s) => s.dirty));
  gauge(METRIC.SCHEMA_MIGRATION_LAST_DURATION_MS, read((s) => s.last_duration_ms));
  registered = true;
}

/** Reset para testes — o estado de módulo sobrevive entre casos. */
export function _resetMigrationCollectorForTests(): void {
  snapshot = null;
  lastRefreshAt = 0;
  inFlight = null;
  registered = false;
}
