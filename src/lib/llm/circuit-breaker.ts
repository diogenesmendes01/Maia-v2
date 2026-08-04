/**
 * Disjuntor (circuit breaker) por `(provider, workload)` — issue #534.
 *
 * Critério de DoD da #508 que a PR #531 não entregou. Sem ele, uma
 * indisponibilidade do provider é AMPLIFICADA pelo próprio gateway: cada
 * request continua gastando todas as tentativas do workload mais o fallback
 * contra um provider que já está doente, e o backoff exponencial só atrasa o
 * martelo — não o reduz. Com `CLAUDE_MAX_RETRIES=3` e fallback ligado, 100
 * requests viram até 400 requisições contra um provider em queda.
 *
 * O disjuntor troca esse comportamento por: aprende UMA vez que o provider
 * está fora, recusa rápido enquanto ele estiver fora, e paga o custo de uma
 * janela pequena de sondas por cooldown para descobrir que voltou.
 *
 * Medido com `scripts/llm-benchmark.ts` (200 requests, queda total, workload
 * `reasoner`): 800 requisições ao provider sem disjuntor, 10 com.
 *
 * ## Chave de escopo — por que NÃO é por tenant
 *
 * O invariante 1 do `AGENTS.md` ("toda fronteira com estado é escopada por
 * `tenant_id + agent_id`") existe para impedir que o estado de um tenant seja
 * lido, escrito ou inferido por outro. Este estado não é de tenant nenhum: ele
 * mede a saúde de uma dependência EXTERNA e COMPARTILHADA (a API do provider,
 * atrás de uma única chave de processo). Escopar por tenant seria errado em
 * três direções ao mesmo tempo:
 *
 *  1. **Destrói o sinal.** A taxa de erro precisa de amostra. Um tenant com 3
 *     chamadas por minuto nunca acumularia amostra suficiente para abrir o
 *     disjuntor — a proteção existiria só para o maior tenant.
 *  2. **Recria a amplificação.** Cada tenant redescobriria a queda queimando
 *     as PRÓPRIAS tentativas contra o provider morto. A carga que o disjuntor
 *     existe para cortar voltaria multiplicada pelo número de tenants.
 *  3. **Cardinalidade sem teto.** Estado por tenant × workload cresce sem
 *     limite; `provider × workload` tem teto conhecido (2 × 20 hoje).
 *
 * O que o isolamento exige de fato é que a DECISÃO seja atribuível: toda
 * recusa é emitida em `maia_llm_requests_total{status="circuit_open"}` com
 * `tenant_id + agent_id` do ALS (ver `telemetry.ts`), então o operador
 * continua enxergando quem foi recusado. O estado é global; a evidência é
 * escopada.
 *
 * Contrapartida aceita e explícita: durante uma queda do provider, as falhas
 * de um tenant fazem o gateway recusar chamadas de outro. É o comportamento
 * correto quando a dependência é genuinamente compartilhada — mas para que
 * essa transferência seja legítima, só contam falhas ATRIBUÍVEIS AO PROVIDER
 * (ver `PROVIDER_FAULT_KINDS`). Um tenant não consegue abrir o disjuntor de
 * ninguém mandando payload inválido, estourando a própria cota ou cancelando
 * turnos.
 *
 * ## Por que `workload` na chave, e não só `provider`
 *
 * Workloads distintos resolvem tiers distintos (`workloads.ts`) e portanto
 * modelos distintos. Uma indisponibilidade de UM modelo (deprecação, fila
 * cheia) não deve cegar o gateway inteiro. E abrir por workload preserva o
 * tráfego que ainda funciona, que é a diferença entre degradar e cair.
 *
 * ## Onde o estado mora — em processo, por réplica
 *
 * Deliberado. Um disjuntor compartilhado (Redis) colocaria um round-trip de
 * rede na frente de TODA chamada de LLM e faria o caminho de LLM depender da
 * saúde do Redis — exatamente a falha correlacionada que o disjuntor existe
 * para sobreviver. O preço de manter em memória é que N réplicas descobrem a
 * queda N vezes; o preço é O(N) sondas, não O(N × requests × tentativas), e é
 * o lado certo do trade.
 *
 * Consequência aceita: reinício de processo zera o disjuntor. A primeira
 * janela reabre e reaprende em poucos requests.
 *
 * ## Métrica
 *
 * `maia_llm_circuit_state{provider,workload}` — gauge documentada no runbook
 * operacional (§8) desde antes desta issue e que, até aqui, NADA emitia.
 * `0 = closed`, `1 = half_open`, `2 = open`.
 */
import { config } from '@/config/env.js';
import { incCounter, setGaugeProvider } from '@/lib/metrics.js';
import { logger } from '@/lib/logger.js';
import { workloadPolicy } from './workloads.js';
import type { LLMErrorKind } from './errors.js';
import type { LLMWorkload } from './types.js';

export type CircuitState = 'closed' | 'half_open' | 'open';

/** Valor numérico exposto no gauge. Ordem = gravidade crescente. */
const STATE_GAUGE: Record<CircuitState, number> = { closed: 0, half_open: 1, open: 2 };

/**
 * Janela deslizante de observação. Curta de propósito: o disjuntor precisa
 * responder à saúde de AGORA, não à média da última hora.
 */
const WINDOW_MS = 30_000;

/**
 * Amostra mínima antes de qualquer abertura. Sem piso, duas falhas às 3h da
 * manhã (quando o tráfego é baixo) abririam o disjuntor com 100% de "taxa de
 * erro" sobre uma amostra de 2 — e recusariam o tráfego que viesse depois.
 */
const MIN_SAMPLES = 10;

/**
 * Taxa de erro por CHAMADA (não por tentativa) a partir da qual abrir passa a
 * valer a pena. O limiar por TENTATIVA é derivado dela — ver `failureThreshold`.
 */
const TARGET_CALL_FAILURE_RATE = 0.5;

/**
 * Cooldown inicial antes da primeira sonda.
 *
 * Escolhido a partir da medição, não do gosto: no cenário `recovery` do
 * `scripts/llm-benchmark.ts`, o cooldown é exatamente o tempo em que o gateway
 * continua recusando DEPOIS de o provider já ter voltado — o custo direto do
 * disjuntor. Com 10s, uma queda de 5s custava ~63 requests recusados a mais
 * que o necessário numa corrida de 200; com 5s o prejuízo cai pela metade e o
 * backoff geométrico abaixo continua protegendo a queda longa, que é o caso em
 * que sondar de novo não adianta.
 */
const OPEN_MS = 5_000;

/**
 * Teto do cooldown. Cada JANELA de sondas que falha inteira dobra a espera, até
 * este teto: uma queda de duas horas gera ~algumas dezenas de janelas de sonda,
 * não uma a cada 5s indefinidamente.
 */
const MAX_OPEN_MS = 60_000;

/** Teto de amostras guardadas por chave (memória limitada). */
const MAX_SAMPLES = 200;

/**
 * Quantas sondas uma janela de half-open admite antes de reabrir. Fecha na
 * PRIMEIRA que passar; só reabre quando todas falharem.
 *
 * `1` é o valor "de livro" e é frágil na recuperação PARCIAL: se o provider
 * voltou mas ainda erra parte das requisições, uma sonda única tem a mesma
 * chance de falhar, e cada falha dobra o cooldown — o disjuntor demora a
 * reconhecer uma recuperação que já aconteceu. Com 3 sondas, a probabilidade de
 * uma janela inteira falhar num provider parcialmente saudável cai ao cubo.
 *
 * Custo numa queda de verdade (100% de erro): 3 requisições por janela em vez
 * de 1 — irrelevante perto das centenas que o disjuntor evita, e o teste de
 * carga mede exatamente isso.
 *
 * Histórico, porque o número saiu de uma medição: com o limiar de abertura
 * fixo em 50% por tentativa, o cenário `brownout` do harness derrubava a
 * disponibilidade de 156/200 para 6/200 justamente por ficar preso neste
 * ciclo de sonda-única-que-falha. A correção principal daquele caso foi o
 * limiar derivado (`failureThreshold`), que impede o disjuntor de abrir ali;
 * esta constante é o cinto de segurança do mesmo problema na recuperação.
 */
const HALF_OPEN_MAX_PROBES = 3;

/**
 * Kinds ATRIBUÍVEIS AO PROVIDER — os únicos que contam como falha.
 *
 * Fora da lista, e por quê:
 *  - `authentication` / `permission` / `configuration`: erro de operação
 *    nossa. O disjuntor não conserta chave errada, e abrir esconderia a causa.
 *  - `invalid_request` / `response_invalid`: erro de payload/parse, atribuível
 *    ao caller. Deixar um caller abrir o disjuntor de todo mundo seria um
 *    vetor de negação de serviço entre tenants.
 *  - `budget_exhausted` / `missing_tenant_context`: decisões NOSSAS, tomadas
 *    antes de qualquer I/O. Não são evidência sobre o provider.
 *  - `aborted`: cancelamento do caller.
 *  - `timeout`: ambíguo por construção. O `timeout` do gateway é dominado pelo
 *    deadline do TURNO (`LLM_TURN_DEADLINE_MS`, ou o valor mais apertado que o
 *    caller declarou), então um caller com orçamento curto produziria
 *    "falhas de provider" que não existem. O gateway distingue os dois casos
 *    na origem (`link.deadlineFired()`) e só o timeout vindo do SDK — que é
 *    provider pendurado de verdade — chega aqui como `network`/`timeout` via
 *    `classifyProviderError`. Ver `circuitOutcomeFor`.
 *  - `rate_limit`: 429 é sinal de CAPACIDADE, não de queda, e vem com
 *    `Retry-After` — o provider já está dizendo quando voltar. Substituir essa
 *    instrução pelo nosso cooldown transforma throttling em indisponibilidade.
 */
const PROVIDER_FAULT_KINDS: ReadonlySet<LLMErrorKind> = new Set<LLMErrorKind>([
  'provider_5xx',
  'network',
  'timeout',
]);

/** Desfecho de UMA tentativa, do ponto de vista do disjuntor. */
export type CircuitOutcome = 'ok' | 'fault' | 'ignored';

/**
 * Traduz o kind do erro para o desfecho do disjuntor.
 *
 * `ignored` não é "sucesso": a amostra simplesmente não entra na janela,
 * porque não diz nada sobre a saúde do provider.
 */
export function circuitOutcomeFor(kind: LLMErrorKind): CircuitOutcome {
  return PROVIDER_FAULT_KINDS.has(kind) ? 'fault' : 'ignored';
}

/**
 * Limiar de falha POR TENTATIVA que abre o disjuntor deste workload.
 *
 * Os 50% "de livro" estão errados aqui, e o harness mostrou por quê: a janela
 * é alimentada por TENTATIVA, mas o caller só perde a chamada quando TODAS as
 * tentativas E o fallback falham. Com `reasoner` (3 tentativas + fallback), uma
 * taxa de 70% por tentativa ainda entrega ~76% das chamadas — e abrir o
 * disjuntor ali derrubava a disponibilidade de 161/200 para 9/200 em troca de
 * poupar carga de um provider que ainda estava servindo. Trocar um incidente
 * por outro.
 *
 * Então o limiar é DERIVADO do orçamento de tentativas do workload: abrimos
 * quando a taxa por tentativa implica que metade das CHAMADAS já está se
 * perdendo, que é o ponto em que retentar deixou de resolver e só resta carga.
 *
 *   p_tentativa = TARGET_CALL_FAILURE_RATE ^ (1 / tentativas_por_chamada)
 *
 *  - single-shot (`role_selector`, `vision`, …): 1 tentativa → 50%, o clássico.
 *  - `reasoner` com `CLAUDE_MAX_RETRIES=3` + fallback: 4 tentativas → ~84%.
 *
 * Consequência aceita e deliberada: num brownout que a camada de retry ainda
 * absorve, o disjuntor NÃO abre e a amplificação continua. Quem trata brownout
 * é o retry; quem trata queda é o disjuntor. Confundir os dois papéis é o que
 * produzia a regressão de disponibilidade medida acima.
 */
function failureThreshold(workload: LLMWorkload): number {
  const policy = workloadPolicy(workload);
  const attempts = Math.max(1, policy.max_attempts ?? config.CLAUDE_MAX_RETRIES);
  const tries = attempts + (policy.allow_fast_fallback ? 1 : 0);
  return TARGET_CALL_FAILURE_RATE ** (1 / tries);
}

export type CircuitKey = { provider: string; workload: LLMWorkload };

type Sample = { at: number; fault: boolean };

type Entry = {
  provider: string;
  workload: LLMWorkload;
  state: CircuitState;
  samples: Sample[];
  opened_at: number;
  cooldown_ms: number;
  /** JANELAS de half-open consecutivas que falharam inteiras — alimenta o
   * cooldown geométrico. Zera quando uma sonda passa. */
  failed_windows: number;
  /** Sondas já concedidas na janela de half-open corrente. */
  probes_started: number;
  /** Sondas da janela corrente que voltaram com falha de provider. */
  probes_failed: number;
};

/**
 * Permissão para UMA tentativa. `probe: true` significa que esta chamada é a
 * sonda de half-open e carrega a decisão de fechar ou reabrir o disjuntor.
 */
export type CircuitPermit =
  | { allowed: true; entry: Entry; probe: boolean; state: CircuitState }
  | { allowed: false; state: CircuitState; retry_after_ms: number };

const circuits = new Map<string, Entry>();

/**
 * Desligável só por código (`_internal.setEnabled`), usado pelo harness de
 * benchmark para medir o antes/depois no MESMO processo. Não existe env var
 * de propósito: como `allow_fast_fallback`, é postura de degradação —
 * versionada, revisável num diff, e não um toggle de runtime que alguém possa
 * virar às 3h da manhã sem deixar rastro.
 */
let enabled = true;

function keyOf(key: CircuitKey): string {
  // JSON array pelo mesmo motivo de `budget.ts` e `model-resolver.ts`: um
  // separador escolhido à mão pode aparecer dentro de um valor e colidir duas
  // tuplas distintas na mesma entrada.
  return JSON.stringify([key.provider, key.workload]);
}

function gaugeSeries(entry: Entry): string {
  return `maia_llm_circuit_state{provider="${entry.provider}",workload="${entry.workload}"}`;
}

function getEntry(key: CircuitKey): Entry {
  const k = keyOf(key);
  const hit = circuits.get(k);
  if (hit) return hit;
  const created: Entry = {
    provider: key.provider,
    workload: key.workload,
    state: 'closed',
    samples: [],
    opened_at: 0,
    cooldown_ms: OPEN_MS,
    failed_windows: 0,
    probes_started: 0,
    probes_failed: 0,
  };
  circuits.set(k, created);
  // O gauge existe a partir da PRIMEIRA chamada daquela combinação, mesmo que
  // o disjuntor nunca abra: uma série que só aparece durante o incidente é
  // inútil para alertar (não há linha de base para comparar).
  setGaugeProvider(gaugeSeries(created), () => STATE_GAUGE[created.state]);
  return created;
}

function transition(entry: Entry, to: CircuitState, reason: string): void {
  const from = entry.state;
  if (from === to) return;
  entry.state = to;
  incCounter('maia_llm_circuit_transitions_total', {
    provider: entry.provider,
    workload: entry.workload,
    from,
    to,
  });
  // Governança: mudança de estado do disjuntor é decisão do backend que altera
  // o comportamento observável do sistema. Vai para o log estruturado com
  // motivo — sem prompt, sem resposta, sem tenant (o estado não é de tenant).
  logger.warn(
    {
      provider: entry.provider,
      workload: entry.workload,
      from,
      to,
      reason,
      cooldown_ms: entry.cooldown_ms,
      failed_windows: entry.failed_windows,
    },
    'llm_gateway.circuit_transition',
  );
}

/** Remove amostras fora da janela e devolve o resumo. */
function windowStats(entry: Entry, now: number): { total: number; faults: number } {
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < entry.samples.length && entry.samples[i]!.at < cutoff) i++;
  if (i > 0) entry.samples.splice(0, i);
  let faults = 0;
  for (const s of entry.samples) if (s.fault) faults++;
  return { total: entry.samples.length, faults };
}

function cooldownRemaining(entry: Entry, now: number): number {
  return Math.max(0, entry.opened_at + entry.cooldown_ms - now);
}

/**
 * Leitura NÃO destrutiva: o disjuntor deixaria esta chamada passar agora?
 *
 * Usada pelo gateway para recusar ANTES de reservar cota e resolver modelo —
 * uma chamada que não vai acontecer não deve consumir I/O de Redis nem
 * carimbar reserva de orçamento. Não consome a sonda de half-open.
 */
export function peekCircuit(key: CircuitKey, now = Date.now()): { allowed: boolean; state: CircuitState; retry_after_ms: number } {
  if (!enabled) return { allowed: true, state: 'closed', retry_after_ms: 0 };
  const entry = circuits.get(keyOf(key));
  if (!entry || entry.state === 'closed') {
    return { allowed: true, state: entry?.state ?? 'closed', retry_after_ms: 0 };
  }
  if (entry.state === 'open') {
    const remaining = cooldownRemaining(entry, now);
    return { allowed: remaining <= 0, state: 'open', retry_after_ms: remaining };
  }
  // half_open: passa enquanto a janela ainda tiver vaga de sonda.
  const hasSlot = entry.probes_started < HALF_OPEN_MAX_PROBES;
  return {
    allowed: hasSlot,
    state: 'half_open',
    retry_after_ms: hasSlot ? 0 : entry.cooldown_ms,
  };
}

/**
 * Pede permissão para UMA tentativa contra o provider.
 *
 * Toda requisição que sai do gateway passa por aqui — tentativa primária,
 * retry e fallback. É o que garante que uma chamada em voo quando o disjuntor
 * abre não continua gastando as tentativas que sobraram.
 */
export function acquireCircuit(key: CircuitKey, now = Date.now()): CircuitPermit {
  if (!enabled) {
    return { allowed: true, entry: getEntry(key), probe: false, state: 'closed' };
  }
  const entry = getEntry(key);

  if (entry.state === 'closed') {
    return { allowed: true, entry, probe: false, state: 'closed' };
  }

  if (entry.state === 'open') {
    const remaining = cooldownRemaining(entry, now);
    if (remaining > 0) {
      shed(entry);
      return { allowed: false, state: 'open', retry_after_ms: remaining };
    }
    entry.probes_started = 0;
    entry.probes_failed = 0;
    transition(entry, 'half_open', 'cooldown_elapsed');
  }

  // half_open — no máximo `HALF_OPEN_MAX_PROBES` sondas por janela.
  if (entry.probes_started >= HALF_OPEN_MAX_PROBES) {
    shed(entry);
    return { allowed: false, state: 'half_open', retry_after_ms: entry.cooldown_ms };
  }
  entry.probes_started++;
  return { allowed: true, entry, probe: true, state: 'half_open' };
}

function shed(entry: Entry): void {
  incCounter('maia_llm_circuit_short_circuited_total', {
    provider: entry.provider,
    workload: entry.workload,
    state: entry.state,
  });
}

/**
 * Devolve a permissão com o desfecho da tentativa.
 *
 * Chamar exatamente uma vez por permissão concedida — inclusive quando a
 * tentativa morre por cancelamento ou deadline (`'ignored'`), senão a sonda de
 * half-open fica presa e o disjuntor nunca mais fecha.
 */
export function releaseCircuit(permit: CircuitPermit, outcome: CircuitOutcome, now = Date.now()): void {
  if (!permit.allowed) return;
  const entry = permit.entry;

  if (permit.probe) {
    if (outcome === 'ok') {
      // Provider respondeu: fecha na PRIMEIRA sonda que passa. Zera janela e
      // cooldown — não herdar a janela antiga é o que impede o disjuntor de
      // reabrir na primeira falha isolada depois da recuperação.
      entry.samples.length = 0;
      entry.failed_windows = 0;
      entry.probes_started = 0;
      entry.probes_failed = 0;
      entry.cooldown_ms = OPEN_MS;
      transition(entry, 'closed', 'probe_succeeded');
      return;
    }
    if (outcome === 'fault') {
      entry.probes_failed++;
      // A janela só reabre quando TODAS as sondas dela falharam. Ver
      // `HALF_OPEN_MAX_PROBES`: com uma sonda só, um provider parcialmente
      // saudável ficava preso em aberto.
      if (entry.probes_failed < HALF_OPEN_MAX_PROBES) return;
      entry.failed_windows++;
      entry.cooldown_ms = Math.min(OPEN_MS * 2 ** entry.failed_windows, MAX_OPEN_MS);
      entry.opened_at = now;
      transition(entry, 'open', 'probe_window_failed');
      return;
    }
    // `ignored`: sonda inconclusiva (cancelamento, deadline, payload inválido).
    // Não fecha nem reabre — devolve a vaga para a próxima sonda, senão a
    // janela se esgota sem nunca ter testado o provider.
    entry.probes_started = Math.max(0, entry.probes_started - 1);
    return;
  }

  if (outcome === 'ignored') return;
  if (entry.samples.length >= MAX_SAMPLES) entry.samples.shift();
  entry.samples.push({ at: now, fault: outcome === 'fault' });

  if (entry.state !== 'closed') return;
  const { total, faults } = windowStats(entry, now);
  if (total < MIN_SAMPLES) return;
  if (faults / total < failureThreshold(entry.workload)) return;

  entry.opened_at = now;
  entry.failed_windows = 0;
  entry.cooldown_ms = OPEN_MS;
  transition(entry, 'open', 'error_rate_exceeded');
}

/** Estado atual — só leitura, para teste e para o harness de benchmark. */
export function circuitState(key: CircuitKey): CircuitState {
  return circuits.get(keyOf(key))?.state ?? 'closed';
}

export const _internal = {
  WINDOW_MS,
  MIN_SAMPLES,
  TARGET_CALL_FAILURE_RATE,
  failureThreshold,
  OPEN_MS,
  MAX_OPEN_MS,
  HALF_OPEN_MAX_PROBES,
  STATE_GAUGE,
  PROVIDER_FAULT_KINDS,
  circuits,
  /** Test seam: zera todos os disjuntores entre casos. */
  reset(): void {
    circuits.clear();
    enabled = true;
  },
  /** Seam do harness de benchmark: mede o antes/depois no mesmo processo. */
  setEnabled(next: boolean): void {
    enabled = next;
  },
  isEnabled(): boolean {
    return enabled;
  },
};
