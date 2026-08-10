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
 * ## Postura: `off | shadow | enforce`
 *
 * Tudo acima descreve o `enforce`. A postura em vigor vem de
 * `circuit-mode.ts` (env `LLM_CIRCUIT_MODE`, default `shadow`, mais o override
 * de incidente por Redis) e muda DUAS coisas, nunca mais que isso:
 *
 *  - `off` — nada acontece e nada é guardado. Sai antes de tocar no mapa.
 *  - `shadow` — a máquina roda IDÊNTICA ao `enforce`, e o único ponto do
 *    arquivo que devolve `allowed: false` (`refuse()`) devolve `allowed: true`
 *    com `would_reject`. Ver `refuse()` para a prova estrutural.
 *
 * A fidelidade do shadow depende de uma regra que não é óbvia: quando o shadow
 * deixa passar uma chamada que o `enforce` teria recusado, o DESFECHO dessa
 * chamada não entra na janela de observação. Um disjuntor que estivesse
 * recusando nunca teria tido aquela amostra; alimentá-la faria a trajetória
 * simulada divergir justamente daquilo que ela existe para prever. Ver
 * `releaseCircuit`.
 *
 * ## Métrica
 *
 * `maia_llm_circuit_state{provider,workload,state}` — gauge documentada no
 * runbook operacional (§8) desde antes desta issue e que, até aqui, NADA
 * emitia. UMA série por estado, exatamente uma valendo `1`.
 *
 * O formato é o de `maia_lifecycle_state{role,state}` e
 * `maia_whatsapp_sessions{state}`, e pelo mesmo motivo: um gauge único
 * codificando `0/1/2` não se lê em PromQL sem legenda, e torna "nunca
 * exercitado" indistinguível de "fechado".
 *
 * ## Trilha durável
 *
 * Além da métrica e do log, toda transição para `open`/`closed` vira linha em
 * `audit_log` (`llm_circuit_opened` / `llm_circuit_closed`), no contexto
 * sintético `system`. É o produtor que faltava para a regra
 * `llm_circuit_long_open` do `src/workers/audit-watcher.ts` — ver
 * `circuit-audit.ts` para o porquê do `system`, da armadilha do `alvo_id` e do
 * import dinâmico.
 *
 * A emissão passa por `@/observability/metrics.js`, não por `@/lib/metrics.js`:
 * é lá que mora o gate de label (allowlist, deny list e orçamento de
 * cardinalidade da #514). Emitir direto na camada de baixo fura o gate.
 *
 * Em `shadow` somam-se `maia_llm_circuit_would_open_total{provider,workload,reason}`
 * e `maia_llm_circuit_would_reject_total{provider,workload,state}` — os gêmeos
 * de sombra da transição para `open` e da recusa. O segundo é emitido pelo
 * GATEWAY, uma vez por chamada e dentro do escopo do caller, para casar 1:1 com
 * `maia_llm_requests_total{status="circuit_open"}` e carregar a mesma atribuição
 * de `tenant_id + agent_id`: o estado é global, a evidência é escopada — em
 * sombra também.
 */
import { config } from '@/config/env.js';
import { counter, gauge, METRIC } from '@/observability/metrics.js';
import { logger } from '@/lib/logger.js';
import { recordCircuitAudit } from './circuit-audit.js';
import { effectiveMode, onModeChange, _internal as modeInternal } from './circuit-mode.js';
import type { CircuitMode } from './circuit-mode.js';
import { workloadPolicy } from './workloads.js';
import { isRetryableKind } from './errors.js';
import type { LLMErrorKind } from './errors.js';
import type { LLMWorkload } from './types.js';

export type CircuitState = 'closed' | 'half_open' | 'open';

/** Os três estados, na ordem de gravidade crescente. */
const CIRCUIT_STATES: readonly CircuitState[] = ['closed', 'half_open', 'open'];

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

/**
 * Desfecho de UMA tentativa, do ponto de vista do disjuntor.
 *
 * `fault` e `terminal_fault` são AMBOS falha do provider e alimentam a mesma
 * janela; a diferença é quanto orçamento de tentativas a falha consome, e isso
 * muda a matemática do limiar (ver `estimatedCallFailureRate`):
 *
 *  - `fault` — a chamada CONTINUA: o gateway retenta e, se a política permitir,
 *    cai no fallback. Uma tentativa dessas é 1 de N; a chamada só se perde
 *    quando as N falham.
 *  - `terminal_fault` — a chamada MORRE nesta tentativa. Uma tentativa dessas
 *    é a chamada inteira.
 */
export type CircuitOutcome = 'ok' | 'fault' | 'terminal_fault' | 'ignored';

/**
 * Traduz o kind do erro para o desfecho do disjuntor.
 *
 * `ignored` não é "sucesso": a amostra simplesmente não entra na janela,
 * porque não diz nada sobre a saúde do provider.
 *
 * A separação `fault` × `terminal_fault` é DERIVADA de `isRetryableKind` — a
 * mesma função que o gateway usa para decidir se retenta (`err.retryable` em
 * `gateway.ts`) e que governa `canFallback`. Derivar em vez de listar à mão é
 * o que impede as duas de divergirem: se um kind deixar de ser retentável, ele
 * vira terminal aqui no mesmo commit, sem ninguém precisar lembrar.
 *
 * Hoje isso significa: `provider_5xx` e `network` percorrem o orçamento;
 * `timeout` (o do SDK — provider pendurado) é terminal, porque
 * `gateway.ts` faz `if (err.kind === 'timeout') { await fail(...); throw err; }`
 * na PRIMEIRA tentativa. Ver o achado 1 da revisão da PR #541.
 */
export function circuitOutcomeFor(kind: LLMErrorKind): CircuitOutcome {
  if (!PROVIDER_FAULT_KINDS.has(kind)) return 'ignored';
  return isRetryableKind(kind) ? 'fault' : 'terminal_fault';
}

/**
 * Quantas TENTATIVAS uma chamada deste workload gasta antes de se perder —
 * quando a falha é do tipo que percorre o orçamento (`fault`, retentável).
 *
 * `max_attempts` do workload (ou `CLAUDE_MAX_RETRIES`), mais uma pelo fallback
 * quando a política permite. É o mesmo número que o gateway usa: `maxAttempts`
 * no laço + o `acquireCircuit` do bloco de fallback.
 */
function triesPerCall(workload: LLMWorkload): number {
  const policy = workloadPolicy(workload);
  const attempts = Math.max(1, policy.max_attempts ?? config.CLAUDE_MAX_RETRIES);
  return attempts + (policy.allow_fast_fallback ? 1 : 0);
}

/**
 * Limiar de falha POR TENTATIVA, para faults que PERCORREM o orçamento de
 * tentativas do workload.
 *
 * Os 50% "de livro" estão errados para esse tipo de falha, e o harness mostrou
 * por quê: a janela é alimentada por TENTATIVA, mas o caller só perde a chamada
 * quando TODAS as tentativas E o fallback falham. Com `reasoner` (3 tentativas
 * + fallback), uma taxa de 70% por tentativa ainda entrega ~76% das chamadas —
 * e abrir o disjuntor ali derrubava a disponibilidade de 161/200 para 9/200 em
 * troca de poupar carga de um provider que ainda estava servindo. Trocar um
 * incidente por outro.
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
 *
 * ## O que esta derivação NÃO cobre — achado 1 da revisão da PR #541
 *
 * Tudo acima continua valendo, e a medição 161/200 → 9/200 continua sendo o
 * motivo de o limiar não ser 50% fixo. Mas a inferência "p por tentativa ⇒
 * p^N por chamada" só é VÁLIDA para falhas que de fato consomem as N
 * tentativas. Havia um kind na janela que não consome: `timeout`.
 *
 * No gateway o timeout do SDK é TERMINAL —
 * `if (err.kind === 'timeout') { await fail(primary, err); throw err; }` —
 * sem retry e sem fallback, a chamada morre na primeira tentativa. Medi-lo com
 * a matemática de 4 tentativas produzia o pior erro possível de um disjuntor:
 * numa tempestade de timeouts terminais a 70%, ~70% das CHAMADAS se perdiam —
 * cada uma depois de esperar o timeout inteiro — e o disjuntor não abria,
 * porque 70% < ~84%. O controle ficava calado exatamente no incidente mais
 * caro que ele existe para cortar.
 *
 * A correção NÃO é mudar a política de retry (isso mudaria comportamento de
 * produção e é decisão do owner). É calcular o limiar POR DESFECHO DE CHAMADA:
 * cada classe de falha usa o expoente que corresponde ao orçamento que ela
 * realmente gasta. Ver `estimatedCallFailureRate` — é lá que a janela mista
 * vira uma taxa de perda de CHAMADAS, e é ela que a decisão de abrir compara
 * contra `TARGET_CALL_FAILURE_RATE`. Esta função continua existindo como o
 * termo dessa conta que corresponde às falhas retentáveis.
 */
function failureThreshold(workload: LLMWorkload): number {
  return TARGET_CALL_FAILURE_RATE ** (1 / triesPerCall(workload));
}

/**
 * Fração ESTIMADA de CHAMADAS perdidas, a partir de uma janela de tentativas.
 *
 * A janela guarda tentativas de duas classes; cada uma se traduz em perda de
 * chamada com um expoente diferente, e é essa a correção do achado 1:
 *
 *   perda ≈ (terminais / total) + (retentáveis / total) ^ tentativas_por_chamada
 *
 *  - **terminais** (`terminal_fault`): a chamada morre na tentativa. Expoente
 *    1 — uma tentativa perdida é uma chamada perdida.
 *  - **retentáveis** (`fault`): a chamada só se perde quando todas as
 *    tentativas E o fallback falham. Expoente `triesPerCall`, que é
 *    exatamente a derivação original de `failureThreshold`.
 *
 * Os dois casos puros reduzem ao que já estava certo, o que é o teste de
 * sanidade desta fórmula:
 *
 *  - só retentáveis ⇒ abre quando `r/total >= failureThreshold(workload)`
 *    (o brownout de `reasoner` a 70% continua NÃO abrindo: 0.7³ ≈ 0.34);
 *  - só terminais ⇒ abre quando `t/total >= 0.5`, o clássico de livro
 *    (a tempestade de timeout a 70% passa a abrir, que é o defeito corrigido);
 *  - workload single-shot ⇒ `triesPerCall = 1` e as duas classes coincidem
 *    em 50%, como sempre foram.
 *
 * A soma é uma ESTIMATIVA, e deliberadamente CONSERVADORA: `total` conta
 * tentativas, e numa janela mista as retentáveis inflam o denominador (uma
 * chamada gera várias), então `terminais/total` SUBESTIMA a fração de chamadas
 * perdidas por falha terminal. O erro empurra para NÃO abrir — a direção certa
 * para um controle cujo custo de abrir errado foi medido em 161/200 → 9/200.
 */
function estimatedCallFailureRate(
  workload: LLMWorkload,
  stats: { total: number; faults: number; terminal: number },
): number {
  if (stats.total === 0) return 0;
  const terminalRate = stats.terminal / stats.total;
  const retryableRate = (stats.faults - stats.terminal) / stats.total;
  return terminalRate + retryableRate ** triesPerCall(workload);
}

export type CircuitKey = { provider: string; workload: LLMWorkload };

/**
 * `terminal` só faz sentido quando `fault` é true: marca a falha que MATOU a
 * chamada em vez de consumir uma tentativa dela. É o que permite a
 * `estimatedCallFailureRate` usar o expoente certo para cada classe.
 */
type Sample = { at: number; fault: boolean; terminal: boolean };

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
 * Permissão para UMA tentativa.
 *
 *  - `probe: true` — esta chamada é a sonda de half-open e carrega a decisão de
 *    fechar ou reabrir o disjuntor.
 *  - `would_reject: true` — SÓ em `shadow`: o `enforce` teria recusado esta
 *    chamada. Ela vai acontecer mesmo assim, e o desfecho dela é descartado
 *    (ver `releaseCircuit`).
 *  - `entry: null` — postura `off`: não há estado a atualizar.
 */
export type CircuitPermit =
  | {
      allowed: true;
      entry: Entry | null;
      probe: boolean;
      state: CircuitState;
      would_reject: boolean;
    }
  | { allowed: false; state: CircuitState; retry_after_ms: number };

/** Leitura não destrutiva do disjuntor. */
export type CircuitPeek = {
  allowed: boolean;
  state: CircuitState;
  retry_after_ms: number;
  would_reject: boolean;
};

const circuits = new Map<string, Entry>();

/**
 * Permissão constante da postura `off`. Compartilhada de propósito: em `off` o
 * disjuntor precisa custar zero, e alocar um objeto por tentativa não é zero.
 * É só leitura — `releaseCircuit` sai na primeira linha ao ver `entry: null`.
 */
const OFF_PERMIT: CircuitPermit = Object.freeze({
  allowed: true,
  entry: null,
  probe: false,
  state: 'closed' as CircuitState,
  would_reject: false,
});

/**
 * `off` significa "nenhum estado guardado". Estado que sobrevive ao
 * desligamento é estado que volta errado quando religa: um disjuntor que ficou
 * `open` por uma queda de ontem recusaria (ou, em shadow, contaria) tráfego
 * saudável no instante em que o operador reverte o kill switch.
 */
onModeChange((next) => {
  if (next === 'off') circuits.clear();
});

function keyOf(key: CircuitKey): string {
  // JSON array pelo mesmo motivo de `budget.ts` e `model-resolver.ts`: um
  // separador escolhido à mão pode aparecer dentro de um valor e colidir duas
  // tuplas distintas na mesma entrada.
  return JSON.stringify([key.provider, key.workload]);
}

/**
 * Registra as TRÊS séries do par para este `(provider, workload)`. Cada uma
 * responde `1` quando o disjuntor está naquele estado e `0` caso contrário, de
 * modo que a soma das três é sempre 1 enquanto a combinação existir.
 */
function registerStateGauges(entry: Entry): void {
  for (const state of CIRCUIT_STATES) {
    gauge(
      METRIC.LLM_CIRCUIT_STATE,
      () =>
        // `off` não tem estado: NaN, não `0`. O `gauge()` da #514 já usa NaN
        // para "não pôde ser lido" justamente porque o Prometheus o trata como
        // amostra ausente — e `0` aqui mentiria dizendo "fechado e saudável"
        // sobre um disjuntor que não está observando nada. O registro do gauge
        // não pode ser desfeito (não há `unset` em `lib/metrics.ts`), então a
        // série some pelo valor.
        effectiveMode() === 'off' ? Number.NaN : entry.state === state ? 1 : 0,
      {
        provider: entry.provider,
        workload: entry.workload,
        state,
      },
    );
  }
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
  registerStateGauges(created);
  return created;
}

function transition(
  entry: Entry,
  to: CircuitState,
  reason: string,
  /**
   * Evidência da janela que produziu a transição. Vai para o log e para a
   * trilha durável — nunca para label: `total`/`faults` são números abertos e
   * `ALLOWED_LABEL_KEYS` (#514) descartaria em silêncio.
   */
  window?: { total: number; faults: number; terminal: number },
): void {
  const from = entry.state;
  if (from === to) return;
  entry.state = to;
  const mode = effectiveMode();
  // `state` é o estado ENTRADO e `reason` o porquê. `from`/`to` não estão em
  // ALLOWED_LABEL_KEYS e seriam descartados em silêncio pelo gate — a transição
  // completa fica no log estruturado logo abaixo, que não tem cardinalidade.
  counter(METRIC.LLM_CIRCUIT_TRANSITIONS, {
    provider: entry.provider,
    workload: entry.workload,
    state: to,
    reason,
  });
  // O gêmeo de sombra da abertura. `transitions_total{state="open"}` dispara
  // igual nas duas posturas — é a mesma máquina rodando —, então numa frota
  // mista ele não responde "teria aberto quando não devia?", que é exatamente a
  // pergunta que a passagem por staging precisa responder antes da promoção.
  // `mode` não está em ALLOWED_LABEL_KEYS e ampliar a allowlist é decisão de
  // governança à parte: a distinção vira NOME de métrica, não label.
  if (to === 'open' && mode === 'shadow') {
    counter(METRIC.LLM_CIRCUIT_WOULD_OPEN, {
      provider: entry.provider,
      workload: entry.workload,
      reason,
    });
  }
  // Governança: mudança de estado do disjuntor é decisão do backend que altera
  // o comportamento observável do sistema. Vai para o log estruturado com
  // motivo — sem prompt, sem resposta, sem tenant (o estado não é de tenant).
  const detail = {
    provider: entry.provider,
    workload: entry.workload,
    from,
    to,
    reason,
    mode,
    cooldown_ms: entry.cooldown_ms,
    failed_windows: entry.failed_windows,
    ...(window
      ? {
          window_total: window.total,
          window_faults: window.faults,
          window_terminal_faults: window.terminal,
        }
      : {}),
  };
  logger.warn(detail, 'llm_gateway.circuit_transition');

  /**
   * …e para a trilha DURÁVEL (achado 2 da revisão da PR #541).
   *
   * O log acima tem retenção curta e cai junto com o coletor; a regra
   * `llm_circuit_long_open` do `src/workers/audit-watcher.ts` consome
   * `audit_log`, e sem estas duas linhas ela era um alerta sem produtor — nunca
   * disparava. Só o PAR `open`/`closed` audita: `half_open` é etapa interna da
   * recuperação, não mudança de postura, e emiti-la quebraria o casamento
   * open→closed que a regra de "stuck" faz.
   *
   * Fire-and-forget, sob contexto `system`: ver `circuit-audit.ts`.
   */
  if (to === 'open' || to === 'closed') {
    recordCircuitAudit(to === 'open' ? 'llm_circuit_opened' : 'llm_circuit_closed', detail);
  }
}

/** Remove amostras fora da janela e devolve o resumo. */
function windowStats(
  entry: Entry,
  now: number,
): { total: number; faults: number; terminal: number } {
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < entry.samples.length && entry.samples[i]!.at < cutoff) i++;
  if (i > 0) entry.samples.splice(0, i);
  let faults = 0;
  let terminal = 0;
  for (const s of entry.samples) {
    if (!s.fault) continue;
    faults++;
    if (s.terminal) terminal++;
  }
  return { total: entry.samples.length, faults, terminal };
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
export function peekCircuit(key: CircuitKey, now = Date.now()): CircuitPeek {
  const mode = effectiveMode(now);
  if (mode === 'off') {
    return { allowed: true, state: 'closed', retry_after_ms: 0, would_reject: false };
  }
  const entry = circuits.get(keyOf(key));
  if (!entry || entry.state === 'closed') {
    return {
      allowed: true,
      state: entry?.state ?? 'closed',
      retry_after_ms: 0,
      would_reject: false,
    };
  }

  let allowed: boolean;
  let retry_after_ms: number;
  if (entry.state === 'open') {
    retry_after_ms = cooldownRemaining(entry, now);
    allowed = retry_after_ms <= 0;
  } else {
    // half_open: passa enquanto a janela ainda tiver vaga de sonda.
    const hasSlot = entry.probes_started < HALF_OPEN_MAX_PROBES;
    allowed = hasSlot;
    retry_after_ms = hasSlot ? 0 : entry.cooldown_ms;
  }

  if (allowed) return { allowed: true, state: entry.state, retry_after_ms, would_reject: false };
  // Em `shadow` a chamada passa. `would_reject` é o que o gateway conta — uma
  // vez por CHAMADA, no escopo do caller — para casar com a recusa real.
  if (mode === 'shadow') {
    return { allowed: true, state: entry.state, retry_after_ms, would_reject: true };
  }
  return { allowed: false, state: entry.state, retry_after_ms, would_reject: false };
}

/**
 * Pede permissão para UMA tentativa contra o provider.
 *
 * Toda requisição que sai do gateway passa por aqui — tentativa primária,
 * retry e fallback. É o que garante que uma chamada em voo quando o disjuntor
 * abre não continua gastando as tentativas que sobraram.
 */
export function acquireCircuit(key: CircuitKey, now = Date.now()): CircuitPermit {
  const mode = effectiveMode(now);
  // `off`: nem entrada no mapa, nem gauge, nem alocação.
  if (mode === 'off') return OFF_PERMIT;

  const entry = getEntry(key);
  const shadow = mode === 'shadow';

  if (entry.state === 'closed') {
    return { allowed: true, entry, probe: false, state: 'closed', would_reject: false };
  }

  if (entry.state === 'open') {
    const remaining = cooldownRemaining(entry, now);
    if (remaining > 0) return refuse(entry, 'open', remaining, shadow);
    entry.probes_started = 0;
    entry.probes_failed = 0;
    transition(entry, 'half_open', 'cooldown_elapsed');
  }

  // half_open — no máximo `HALF_OPEN_MAX_PROBES` sondas por janela. A sonda é
  // concedida IGUAL nas duas posturas: é ela que decide fechar ou reabrir, e é
  // por isso que a trajetória do shadow é a mesma do enforce.
  if (entry.probes_started >= HALF_OPEN_MAX_PROBES) {
    return refuse(entry, 'half_open', entry.cooldown_ms, shadow);
  }
  entry.probes_started++;
  return { allowed: true, entry, probe: true, state: 'half_open', would_reject: false };
}

/**
 * O ÚNICO ponto do arquivo que pode devolver `allowed: false`.
 *
 * Concentrar a recusa aqui é a prova estrutural do requisito mais importante do
 * shadow: com `shadow === true` esta função devolve `allowed: true` em todos os
 * caminhos, então nenhuma postura de sombra consegue transformar uma chamada
 * que teria dado certo num erro. Não é uma promessa espalhada por condicionais
 * — é uma função com uma saída só, coberta por
 * `tests/unit/lib/llm-circuit-mode.spec.ts`.
 */
function refuse(
  entry: Entry,
  state: CircuitState,
  retry_after_ms: number,
  shadow: boolean,
): CircuitPermit {
  if (shadow) {
    // `short_circuited_total` conta carga REALMENTE cortada; em sombra nada foi
    // cortado. O gêmeo é `would_reject`, contado no gateway.
    return { allowed: true, entry, probe: false, state, would_reject: true };
  }
  shed(entry);
  return { allowed: false, state, retry_after_ms };
}

function shed(entry: Entry): void {
  counter(METRIC.LLM_CIRCUIT_SHORT_CIRCUITED, {
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
  // `off`, ou postura que virou `off` com a permissão em voo: não há estado.
  const entry = permit.entry;
  if (entry === null || effectiveMode(now) === 'off') return;
  /**
   * O ponto que faz o shadow ser uma SIMULAÇÃO e não outro experimento.
   *
   * Esta chamada só aconteceu porque a gente estava em sombra; o disjuntor que
   * estamos medindo teria recusado, e portanto NUNCA teria visto este desfecho.
   * Colocá-lo na janela contaminaria a trajetória simulada com evidência que o
   * original não teria — e num incidente longo isso muda o resultado inteiro:
   * as falhas que continuam chegando durante o `open` manteriam a janela cheia
   * e o disjuntor nunca ensaiaria a recuperação, ou o contrário, sucessos
   * durante o `open` "curariam" um disjuntor que na vida real estaria recusando
   * e não teria como saber disso.
   *
   * A sonda de half-open é o caso oposto e por isso NÃO cai aqui
   * (`would_reject` é sempre `false` num permit de sonda): ela é concedida nas
   * duas posturas, e é o desfecho dela que decide fechar ou reabrir.
   */
  if (permit.would_reject) return;

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
    // Na SONDA a distinção terminal × retentável não existe: a sonda é uma
    // pergunta única ("o provider voltou?") e qualquer falha atribuível ao
    // provider é um "não". O expoente do orçamento só importa para inferir
    // perda de CHAMADA a partir de tentativas, e a sonda não tem orçamento.
    if (outcome === 'fault' || outcome === 'terminal_fault') {
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
  entry.samples.push({
    at: now,
    fault: outcome !== 'ok',
    terminal: outcome === 'terminal_fault',
  });

  if (entry.state !== 'closed') return;
  const stats = windowStats(entry, now);
  if (stats.total < MIN_SAMPLES) return;
  // Abre pela taxa de perda de CHAMADAS, não pela taxa de falha por tentativa:
  // cada classe de falha entra com o expoente do orçamento que ela realmente
  // gasta. Ver `estimatedCallFailureRate` (achado 1 da revisão da PR #541).
  if (estimatedCallFailureRate(entry.workload, stats) < TARGET_CALL_FAILURE_RATE) return;

  entry.opened_at = now;
  entry.failed_windows = 0;
  entry.cooldown_ms = OPEN_MS;
  transition(entry, 'open', 'error_rate_exceeded', stats);
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
  triesPerCall,
  estimatedCallFailureRate,
  OPEN_MS,
  MAX_OPEN_MS,
  HALF_OPEN_MAX_PROBES,
  CIRCUIT_STATES,
  PROVIDER_FAULT_KINDS,
  circuits,
  /** Test seam: zera disjuntores E postura entre casos. */
  reset(): void {
    circuits.clear();
    modeInternal.reset();
  },
  /**
   * Seam de teste e do harness de benchmark: fixa a postura no MESMO processo,
   * por cima do contrato e de qualquer override.
   *
   * Substitui o antigo `setEnabled(boolean)`. O booleano respondia a mesma
   * pergunta que a postura ("o disjuntor está valendo?") por um segundo
   * caminho, e dois caminhos para a mesma pergunta acabam discordando. Passar
   * `null` devolve o controle ao contrato.
   */
  setMode(next: CircuitMode | null): void {
    modeInternal.setMode(next);
  },
  effectiveMode,
};
