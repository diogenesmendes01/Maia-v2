/**
 * Issue #503 — gauges da máquina de estados do turno.
 *
 *   `maia_turns_current{status}`          — quantos turnos VIVOS em cada estado;
 *   `maia_turn_state_age_seconds{status}` — idade do turno mais ANTIGO ali.
 *
 * São os dois sinais que tornam visíveis os riscos centrais desta mudança:
 * turno preso e envelhecimento por estado. Um `maia_turns_current{status="running"}`
 * que não desce, ou um `maia_turn_state_age_seconds{status="outbound_pending"}`
 * que cresce, É o incidente — e sem eles o operador só descobre pelo usuário.
 *
 * Por que um coletor com snapshot em cache, e não uma query por scrape:
 * `src/lib/metrics.ts` expõe gauge SEM label — o label vive no NOME registrado
 * (`maia_turns_current{status="received"}`), então são 12 providers. Se cada um
 * consultasse o banco, um scrape faria 12 queries. O snapshot compartilhado com
 * TTL curto reduz isso a uma query por janela, independente do número de
 * providers ou da taxa de scrape.
 *
 * Falha do banco NUNCA derruba o `/metrics`: o refresh engole o erro e os
 * providers devolvem o último snapshot conhecido (ou zero). Um gauge parado é
 * um problema menor que um endpoint de observabilidade em 500 durante o
 * incidente que ele deveria estar ajudando a diagnosticar.
 */
import { config } from '@/config/env.js';
import { setGaugeProvider } from '@/lib/metrics.js';
import { logger } from '@/lib/logger.js';
import type { TurnStatus } from '@/runtime/turns/contract.js';

/** Estados VIVOS — terminais são volume histórico, não sinal de saúde. */
const LIVE_STATUSES: readonly TurnStatus[] = [
  'received',
  'queued',
  'claimed',
  'running',
  'outbound_pending',
  'retryable',
] as const;

/** Janela do snapshot. Curta o bastante para alerta, longa o bastante para não pesar. */
const SNAPSHOT_TTL_MS = 15_000;

type Entry = { total: number; oldest_age_seconds: number };

let snapshot = new Map<string, Entry>();
let lastRefreshAt = 0;
let inFlight: Promise<void> | null = null;
let gaugesRegistered = false;

/**
 * Atualiza o snapshot no máximo uma vez por janela. Chamadas concorrentes
 * (os 12 providers de um mesmo scrape) compartilham a MESMA promise — sem isso
 * o primeiro scrape após a expiração dispararia 12 queries simultâneas.
 */
async function refresh(): Promise<void> {
  if (Date.now() - lastRefreshAt < SNAPSHOT_TTL_MS) return;
  if (inFlight) return inFlight;
  lastRefreshAt = Date.now();
  inFlight = (async () => {
    try {
      const { agentTurnsRepo } = await import('@/db/repositories/turn-repos.js');
      const rows = await agentTurnsRepo.snapshotLiveTurnStates();
      const next = new Map<string, Entry>();
      for (const r of rows) {
        next.set(r.status, { total: r.total, oldest_age_seconds: r.oldest_age_seconds });
      }
      snapshot = next;
    } catch (err) {
      // Mantém o snapshot anterior — ver cabeçalho.
      logger.debug({ err: (err as Error).message }, 'turn_state_collector.refresh_failed');
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function read(status: TurnStatus, field: keyof Entry): () => Promise<number> {
  return async () => {
    if (!config.FEATURE_TURN_STATE_MACHINE) return 0;
    await refresh();
    return snapshot.get(status)?.[field] ?? 0;
  };
}

/**
 * Registra os gauges. Idempotente. Inerte enquanto
 * `FEATURE_TURN_STATE_MACHINE` estiver off — os providers existem e devolvem 0,
 * de modo que a série aparece no scrape (ausência de série é ambígua: "zero" e
 * "não instrumentado" ficariam indistinguíveis) sem tocar o banco.
 */
export function registerTurnStateGauges(): void {
  if (gaugesRegistered) return;
  for (const status of LIVE_STATUSES) {
    setGaugeProvider(`maia_turns_current{status="${status}"}`, read(status, 'total'));
    setGaugeProvider(
      `maia_turn_state_age_seconds{status="${status}"}`,
      read(status, 'oldest_age_seconds'),
    );
  }
  gaugesRegistered = true;
}

/** Reset para testes — o estado de módulo persiste entre casos. */
export function _resetTurnStateCollectorForTests(): void {
  snapshot = new Map();
  lastRefreshAt = 0;
  inFlight = null;
  gaugesRegistered = false;
}
