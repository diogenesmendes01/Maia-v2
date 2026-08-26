/**
 * Postura do disjuntor de LLM: `off | shadow | enforce` — decisão do owner na
 * revisão da issue #534.
 *
 * ## O problema que isto resolve
 *
 * A #534 entregou o disjuntor já valendo para todo o tráfego, em todas as
 * réplicas, de uma vez. O owner rejeitou EXPLICITAMENTE um canário por
 * tenant/agente — o disjuntor protege uma dependência GLOBAL e compartilhada, e
 * fragmentar a decisão por tenant destruiria a amostra que dá sentido ao
 * controle (o argumento longo está em `circuit-breaker.ts`, seção "Chave de
 * escopo"). Mas rollout global sem alavanca também foi rejeitado: um controle
 * de degradação que só tem "ligado" só pode ser desligado por deploy, e deploy
 * durante incidente é a coisa que a gente menos quer estar fazendo.
 *
 * A alavanca, então, não é por tenant — é por POSTURA:
 *
 *  - **`off`** — o disjuntor não existe. Nenhum estado é guardado, nenhuma
 *    série de estado é publicada, nenhuma chamada é recusada. É o rollback.
 *  - **`shadow`** (default) — a máquina de estados roda INTEIRA e idêntica ao
 *    `enforce`: mesma janela, mesmo limiar, mesmo cooldown, mesma contabilidade
 *    de sondas. A única diferença é que a recusa não acontece: ela vira
 *    `maia_llm_circuit_would_reject_total`. É o que permite responder "quanta
 *    carga isso teria cortado, e teria aberto quando não devia?" ANTES de
 *    ligar.
 *  - **`enforce`** — o comportamento da #534.
 *
 * O default é `shadow`, não `enforce`. Promover é uma decisão tomada com número
 * na mão depois de uma passagem por staging — ver `docs/runbooks/operational.md`
 * §3.1.
 *
 * ## Duas alavancas, deliberadamente diferentes
 *
 * | | `LLM_CIRCUIT_MODE` | override por Redis |
 * |---|---|---|
 * | O que é | postura BASE, versionada | alavanca de INCIDENTE |
 * | Como muda | editar env + restart | `SET` + `PUBLISH`, sem restart |
 * | Quanto dura | até o próximo deploy | TTL explícito, expira sozinha |
 * | Quem pode | quem faz deploy | quem tem acesso ao Redis de produção |
 *
 * A env var é marcada `restartRequired: true` no contrato porque é a verdade:
 * `config` é congelado no boot. Vender como quente algo que exige restart é
 * exatamente o erro que faz um operador achar que já desligou o controle
 * enquanto ele continua recusando tráfego.
 *
 * ## A tensão, registrada e não escondida
 *
 * A #534 argumentou, por escrito, que política de degradação é código
 * versionado e não toggle de runtime que alguém vira às 3h da manhã sem deixar
 * rastro. O owner passou por cima disso ao exigir um kill switch, e a razão é
 * boa: o argumento vale para AJUSTAR a política (limiar, cooldown, fallback) e
 * não vale para DESLIGAR um controle que está causando o incidente em vez de
 * conter. Um controle sem freio de mão é um risco novo, não uma proteção a
 * mais.
 *
 * A objeção original continua válida no que ela tinha de certo — "sem deixar
 * rastro" —, e é por isso que esta implementação a resolve em vez de ignorar:
 *
 *  1. **Um override anônimo é RECUSADO.** `actor` e `reason` são obrigatórios e
 *     não-vazios. Não existe caminho para virar a chave sem se identificar.
 *  2. **Todo uso é contado, logado e AUDITADO**:
 *     `maia_llm_circuit_mode_overrides_total` +
 *     `llm_gateway.circuit_mode_override` com ator, motivo e validade, mais uma
 *     linha durável em `audit_log` (`llm_circuit_mode_override_*`). Contador e
 *     log expiram na retenção do coletor; a trilha, não — e mudar a postura de
 *     um controle de degradação é decisão de governança (invariante 4).
 *  3. **A postura efetiva é uma série**: `maia_llm_circuit_mode{state}`. Não dá
 *     para o controle ficar desligado em silêncio — o dashboard mostra.
 *  4. **Expira sozinho.** TTL obrigatório, teto de 24h. Um kill switch que
 *     ninguém lembra de desligar é como um controle morre de vez; este volta
 *     para a postura versionada por conta própria, e o retorno também é um
 *     evento contado.
 *
 * ## Por que Redis, e o que acontece quando ele cai
 *
 * O disjuntor NÃO consulta o Redis no hot path — isso continua valendo e é o
 * ponto de `circuit-breaker.ts` ("um disjuntor em Redis faria o caminho de LLM
 * depender da saúde do Redis"). O que anda por Redis é só a NOTIFICAÇÃO: um
 * pub/sub empurra a postura para dentro da memória de cada réplica, e o hot
 * path lê uma variável local. Mesmo padrão, mesma conexão e mesmo passo de
 * drain do subscriber de settings (`cache-invalidation.ts`).
 *
 * Redis fora do ar ⇒ o override não propaga. Degradação documentada, com
 * segunda alavanca explícita no runbook: subir com `LLM_CIRCUIT_MODE=off` (aí
 * sim, com restart). Duas alavancas com custos diferentes é melhor que uma
 * alavanca que promete o que não cumpre.
 */
import { config } from '@/config/env.js';
import { counter, gauge, METRIC } from '@/observability/metrics.js';
import { logger } from '@/lib/logger.js';
import { recordCircuitAudit } from './circuit-audit.js';
import type { CircuitAuditAction } from './circuit-audit.js';

export type CircuitMode = 'off' | 'shadow' | 'enforce';

/** As três posturas, da mais permissiva para a mais restritiva. */
export const CIRCUIT_MODES: readonly CircuitMode[] = ['off', 'shadow', 'enforce'];

function isCircuitMode(v: unknown): v is CircuitMode {
  return typeof v === 'string' && (CIRCUIT_MODES as readonly string[]).includes(v);
}

/**
 * Teto do arrendamento do kill switch. 24h é longo o bastante para atravessar
 * um incidente e curto o bastante para que ninguém consiga desligar o disjuntor
 * "para sempre" sem passar por um deploy — que é onde a decisão deve morar.
 */
export const MAX_OVERRIDE_MS = 24 * 60 * 60 * 1000;

/** Validade default quando o operador não declara uma. */
export const DEFAULT_OVERRIDE_MS = 30 * 60 * 1000;

/** Canal de pub/sub e chave durável do override. */
export const LLM_CIRCUIT_OVERRIDE_CHANNEL = 'maia:llm:circuit:override';
export const LLM_CIRCUIT_OVERRIDE_KEY = 'maia:llm:circuit:override';

/**
 * Um override em vigor. `expires_at` é ABSOLUTO e vem de quem publicou, não do
 * relógio de quem recebe: é o que faz uma réplica que subiu no meio do
 * incidente herdar o resto do arrendamento em vez de reiniciar a contagem.
 */
export type CircuitOverride = {
  mode: CircuitMode;
  expires_at: number;
  actor: string;
  reason: string;
};

/** Payload aceito no canal e na chave durável. */
export type CircuitOverrideMessage = {
  mode?: unknown;
  actor?: unknown;
  reason?: unknown;
  /** Instante absoluto (epoch ms). Vence `ttl_ms` quando os dois vêm. */
  expires_at?: unknown;
  /**
   * Alternativa a `expires_at`, resolvida contra o relógio local. Só vale na
   * ENTRADA (canal, ou argumento de `publishCircuitOverride`): a chave durável
   * guarda sempre o absoluto já normalizado. Validade relativa numa chave
   * durável é a receita da ressurreição — cada réplica que sobe recomeçaria a
   * contagem e o kill switch não morreria nunca. Ver `adoptPersistedOverride`.
   */
  ttl_ms?: unknown;
  /** `true` limpa o override e volta para a postura do contrato. */
  clear?: unknown;
};

/** Resultado da normalização de validade: instante ABSOLUTO ou o porquê da recusa. */
export type ResolvedExpiry = { expires_at: number } | { error: string };

/**
 * Converte a validade declarada (absoluta ou relativa) num instante ABSOLUTO e
 * valida os limites — UMA vez, num lugar só.
 *
 * Fonte única de verdade para `applyCircuitOverride` (que aplica localmente) e
 * para `publishCircuitOverride` (que grava a chave durável e o `PX`). Os dois
 * caminhos precisam concordar sobre o instante de vencimento: se o `PX` do
 * Redis e o `expires_at` do payload divergissem, a chave sobreviveria ao
 * arrendamento (ou morreria antes dele) e as réplicas discordariam sobre até
 * quando o kill switch vale.
 *
 * ## Relógio: o que se assume e por quê é aceitável
 *
 * `expires_at` é resolvido no relógio de QUEM PUBLICA e comparado no relógio de
 * QUEM RECEBE. Assume-se skew NTP de ordem de segundos entre réplicas — a
 * mesma premissa que já sustenta `exp` de JWT e comparações com `now()` do
 * Postgres neste repo. Contra o arrendamento mínimo sancionado (30min default)
 * isso é ruído; contra o teto (24h), ainda mais.
 *
 * O dano é limitado nas DUAS direções, o que é o que importa:
 *
 *  - relógio da réplica ADIANTADO ⇒ o override vence cedo e ela volta para a
 *    postura VERSIONADA (`shadow` por default). Direção segura: a réplica cai
 *    para o contrato, nunca para um estado que ninguém pediu.
 *  - relógio da réplica ATRASADO ⇒ o override dura o skew a mais, e só nela. O
 *    `PX` da chave é uma DURAÇÃO medida e imposta pelo próprio Redis, então
 *    nenhuma réplica nova adota depois do vencimento real.
 *  - skew grosseiro (minutos, horas) NÃO é adivinhado: `expires_at <= now`
 *    vira `rejected` ("já vencido na chegada") e `expires_at - now >
 *    MAX_OVERRIDE_MS` vira `rejected` pelo teto. Ou seja, uma réplica com
 *    relógio quebrado recusa o override, contado e logado — ela falha para o
 *    baseline, jamais para um arrendamento sem fim.
 */
export function resolveOverrideExpiry(msg: CircuitOverrideMessage, now: number): ResolvedExpiry {
  const absolute =
    typeof msg.expires_at === 'number' && Number.isFinite(msg.expires_at) ? msg.expires_at : null;
  const relative =
    typeof msg.ttl_ms === 'number' && Number.isFinite(msg.ttl_ms) ? msg.ttl_ms : DEFAULT_OVERRIDE_MS;
  const expiresAt = absolute ?? now + relative;

  if (expiresAt <= now) return { error: 'override já vencido na chegada' };
  if (expiresAt - now > MAX_OVERRIDE_MS) {
    // Teto duro: desligar o disjuntor por mais de um dia é decisão de deploy,
    // não de plantão. Recusar é melhor que truncar em silêncio — o operador
    // precisa saber que o arrendamento que ele pediu não é o que ficou.
    return { error: `validade acima do teto de ${MAX_OVERRIDE_MS}ms` };
  }
  return { expires_at: expiresAt };
}

let override: CircuitOverride | null = null;

/**
 * Contador MONOTÔNICO de mudanças do override vindas de FORA (canal, chave
 * durável, reset de teste). Existe por causa de uma corrida específica, e é a
 * resposta explícita ao item 3 do gate 4 da #534 — o desenho não tinha
 * mecanismo de versão/geração, então este é ele.
 *
 * ## A corrida
 *
 * A releitura de reconexão (`resyncAuthoritativeState`, em
 * `cache-invalidation.ts`) faz um `GET` na conexão COMPARTILHADA, enquanto as
 * mensagens do canal chegam pela conexão do SUBSCRIBER. São dois sockets: o
 * Redis serializa os comandos numa ordem total, mas as RESPOSTAS chegam ao
 * processo em ordens independentes. Logo é possível o processo tratar uma
 * mensagem do canal (estado B) e só depois receber a resposta do `GET` que o
 * Redis atendeu ANTES do `SET` de B (estado A) — a releitura sobrescreveria B,
 * mais novo, por A, mais velho. O estado final seria o da corrida, não o do
 * Redis.
 *
 * ## A resolução
 *
 * A releitura captura a geração antes de emitir o `GET` e desiste se ela mudou
 * quando a resposta chega: quem passou pelo canal no meio do voo é sempre pelo
 * menos tão novo quanto o que o `GET` leu, então CEDER é a escolha correta — e
 * é convergente mesmo no caso em que a mensagem tratada era a mais velha,
 * porque o `PUBLISH` do valor mais novo também é entregue à inscrição (ativa,
 * confirmada) logo em seguida.
 *
 * A expiração natural (`resolve`) NÃO conta como mudança externa: ela é local,
 * determinística e re-derivável do próprio `expires_at`. Bumpá-la faria uma
 * releitura legítima ser descartada por um relógio que virou no meio do voo.
 */
let generation = 0;

/** Geração atual do override local. Ver o bloco em `generation`. */
export function overrideGeneration(): number {
  return generation;
}

/**
 * Seam de teste e do harness de benchmark. Vence tudo, e NUNCA é setado em
 * produção — não há caminho de env, de Redis ou de HTTP que chegue aqui.
 *
 * Substitui o antigo `_internal.setEnabled()`, que era um booleano paralelo à
 * postura: dois eixos para a mesma pergunta ("o disjuntor está valendo?") é
 * como se produz o bug de um dizer sim e o outro não.
 */
let forced: CircuitMode | null = null;

/** Postura do contrato, lida uma vez. `config` é congelado no boot. */
let baseline: CircuitMode | null = null;

type ModeListener = (next: CircuitMode, previous: CircuitMode) => void;
const listeners = new Set<ModeListener>();

/** Última postura observada, para detectar a borda e notificar os listeners. */
let lastSeen: CircuitMode | null = null;

function baselineMode(): CircuitMode {
  if (baseline === null) {
    const raw: unknown = (config as Record<string, unknown>).LLM_CIRCUIT_MODE;
    // Fail-SAFE, não fail-closed: o contrato já valida o enum no boot, então
    // isto só dispara em teste com `config` mockado parcialmente. Cair em
    // `shadow` é a escolha certa — a postura que observa sem mudar
    // comportamento nunca é a errada para se cair dentro por acidente.
    baseline = isCircuitMode(raw) ? raw : 'shadow';
  }
  return baseline;
}

function auditOverride(
  action: 'applied' | 'expired' | 'cleared' | 'rejected' | 'adopted',
  detail: {
    mode: CircuitMode | 'invalid';
    actor?: string;
    reason?: string;
    expires_at?: number;
    error?: string;
    /**
     * PROCEDÊNCIA, quando ela não coincide com o desfecho. Uma releitura de
     * reconexão (`resynced`) tem o mesmo desfecho de governança que a adoção de
     * boot (a postura mudou porque a chave durável disse isso), então ela NÃO
     * ganha ação nova na taxonomia — ganha uma procedência distinta no log e no
     * `metadata.source` da trilha. É o que permite responder "esta réplica
     * mudou de postura porque reconectou?" sem somar duas ações em toda query.
     */
    via?: string;
  },
): void {
  // `attribute: false`: mudar a postura é evento de FROTA. O `tenant_id` do ALS
  // que por acaso estava ativo quando a mensagem do pub/sub chegou não diz nada
  // sobre quem virou a chave — quem virou está em `actor`, no log. Atribuição
  // errada é pior que atribuição nenhuma.
  counter(METRIC.LLM_CIRCUIT_MODE_OVERRIDES, { state: detail.mode, reason: action }, 1, {
    attribute: false,
  });
  // WARN, não INFO: mexer no kill switch de um controle de degradação é evento
  // de plantão. `actor` e `reason` são texto livre do operador e por isso vivem
  // no log (sem cardinalidade), nunca em label.
  const record = {
    action,
    source: detail.via ?? action,
    mode: detail.mode,
    actor: detail.actor,
    reason: detail.reason,
    expires_at: detail.expires_at ? new Date(detail.expires_at).toISOString() : undefined,
    error: detail.error,
    baseline: baselineMode(),
  };
  logger.warn(record, 'llm_gateway.circuit_mode_override');

  /**
   * …e a trilha DURÁVEL (achado 2 da revisão da PR #541).
   *
   * A objeção original da #534 a um toggle de runtime era "alguém vira a chave
   * às 3h da manhã sem deixar rastro". Exigir `actor` + `reason` responde
   * metade; a outra metade é o rastro SOBREVIVER. Contador some na retenção do
   * Prometheus, log some na do coletor — e mudança de postura de um controle
   * de degradação é decisão de governança, que o invariante 4 do `AGENTS.md`
   * manda persistir em `audit_log`.
   *
   * `adopted` NÃO tem ação própria: adotar a chave durável no boot da réplica é
   * o mesmo desfecho de governança de aplicar ao vivo (a postura mudou), com
   * procedência diferente. A procedência é metadado (`source`); inventar uma
   * quinta ação faria toda consulta da trilha ter que lembrar de somar as duas.
   */
  recordCircuitAudit(OVERRIDE_AUDIT_ACTION[action], record);
}

/**
 * Mapa ação-interna → ação da taxonomia. Explícito (e não string interpolada)
 * para que o typecheck recuse um desfecho novo sem entrada correspondente em
 * `AUDIT_ACTIONS` — foi assim que a #541 nasceu com um watcher sem produtor.
 */
const OVERRIDE_AUDIT_ACTION: Record<
  'applied' | 'expired' | 'cleared' | 'rejected' | 'adopted',
  CircuitAuditAction
> = {
  applied: 'llm_circuit_mode_override_applied',
  adopted: 'llm_circuit_mode_override_applied',
  cleared: 'llm_circuit_mode_override_cleared',
  expired: 'llm_circuit_mode_override_expired',
  rejected: 'llm_circuit_mode_override_rejected',
};

/**
 * As TRÊS séries da postura, uma por modo, exatamente uma valendo 1 — mesmo
 * formato de `maia_llm_circuit_state` e `maia_lifecycle_state`.
 *
 * Registradas na PRIMEIRA leitura da postura, não na importação do módulo.
 * Importar não pode ter efeito colateral: metade dos specs do repo mocka
 * `@/lib/metrics.js` parcialmente, e um `setGaugeProvider` disparado por um
 * import transitivo quebra suítes que não têm nada a ver com LLM. Na prática a
 * série aparece na primeira chamada de LLM do processo — mesma latência das
 * séries de estado do disjuntor, e pelo mesmo motivo.
 */
let gaugesRegistered = false;

function registerModeGauges(): void {
  if (gaugesRegistered) return;
  gaugesRegistered = true;
  for (const mode of CIRCUIT_MODES) {
    gauge(METRIC.LLM_CIRCUIT_MODE, () => (effectiveMode() === mode ? 1 : 0), { state: mode });
  }
}

/**
 * Postura em vigor AGORA. Hot path: no caso comum são três comparações e uma
 * leitura de variável de módulo — nenhum I/O, nenhuma alocação.
 */
export function effectiveMode(now = Date.now()): CircuitMode {
  if (!gaugesRegistered) registerModeGauges();
  const resolved = resolve(now);
  if (lastSeen !== resolved) {
    const previous = lastSeen ?? resolved;
    lastSeen = resolved;
    for (const l of listeners) l(resolved, previous);
  }
  return resolved;
}

function resolve(now: number): CircuitMode {
  if (forced !== null) return forced;
  if (override !== null) {
    if (now < override.expires_at) return override.mode;
    // Arrendamento vencido: volta sozinho para a postura versionada, e o
    // retorno é um evento contado — "o kill switch expirou" é informação de
    // plantão, não detalhe interno.
    const expired = override;
    override = null;
    auditOverride('expired', {
      mode: expired.mode,
      actor: expired.actor,
      reason: expired.reason,
      expires_at: expired.expires_at,
    });
  }
  return baselineMode();
}

/** Override em vigor, para diagnóstico (`/metrics` não carrega texto livre). */
export function currentOverride(now = Date.now()): CircuitOverride | null {
  if (override === null) return null;
  return now < override.expires_at ? override : null;
}

/**
 * Registra um observador da postura. `circuit-breaker.ts` usa para descartar o
 * estado ao entrar em `off` — a issue pede "off = nenhum estado guardado", e
 * estado que sobrevive ao desligamento é estado que volta errado quando religa.
 */
export function onModeChange(listener: ModeListener): void {
  listeners.add(listener);
}

export type OverrideResult = { applied: boolean; error?: string; mode: CircuitMode };

/**
 * Procedência de uma aplicação local:
 *
 *  - `applied`  — mensagem do canal, agora.
 *  - `adopted`  — `GET` da chave durável no BOOT do subscriber.
 *  - `resynced` — `GET` da chave durável depois de uma RECONEXÃO do subscriber
 *    (gate 4 da #534). Tem as mesmas exigências de `adopted` (a chave é a
 *    fonte, então a validade precisa ser absoluta) e o mesmo desfecho de
 *    governança; só a procedência muda.
 */
export type OverrideSource = 'applied' | 'adopted' | 'resynced';

/** Leitura da chave durável — as duas procedências que exigem validade absoluta. */
function fromDurableKey(source: OverrideSource): boolean {
  return source === 'adopted' || source === 'resynced';
}

/**
 * Aplica um override LOCALMENTE (nesta réplica). Chamado pelo handler de
 * pub/sub, pela adoção da chave durável no boot do subscriber, pela releitura
 * de reconexão e pelos testes.
 *
 * Fail-closed na governança: sem `actor` ou sem `reason` o override é
 * RECUSADO, contado e logado. Não é rigor decorativo — é a diferença entre um
 * kill switch auditável e uma flag silenciosa, que era a objeção original da
 * #534 ao toggle de runtime.
 */
export function applyCircuitOverride(
  msg: CircuitOverrideMessage,
  now = Date.now(),
  source: OverrideSource = 'applied',
): OverrideResult {
  const actor = typeof msg.actor === 'string' ? msg.actor.trim() : '';
  const reason = typeof msg.reason === 'string' ? msg.reason.trim() : '';

  const reject = (error: string, mode: CircuitMode | 'invalid' = 'invalid'): OverrideResult => {
    // `via: source` também na RECUSA: sem ela, uma releitura de reconexão que
    // recusa a chave deixa na trilha um `rejected` indistinguível de uma
    // tentativa manual de virar o kill switch. A procedência é justamente o que
    // responde "esta réplica recusou o estado autoritativo depois de
    // reconectar?" (revisão do dono da #552).
    auditOverride('rejected', { mode, actor, reason, error, via: source });
    return { applied: false, error, mode: effectiveMode(now) };
  };

  if (actor === '') return reject('actor obrigatório: um kill switch anônimo não é auditável');
  if (reason === '') return reject('reason obrigatório: registre POR QUE o controle foi mexido');

  if (msg.clear === true) {
    override = null;
    generation++;
    auditOverride('cleared', { mode: baselineMode(), actor, reason, via: source });
    return { applied: true, mode: effectiveMode(now) };
  }

  if (!isCircuitMode(msg.mode)) {
    return reject(`mode inválido: esperado ${CIRCUIT_MODES.join(' | ')}`);
  }

  // Leitura da chave durável exige validade ABSOLUTA. Um payload persistido com
  // `ttl_ms` seria reinterpretado contra o relógio de cada boot (ou de cada
  // reconexão): a réplica ressuscita o arrendamento inteiro, e o kill switch
  // passa a ser impossível de esquecer — ele nunca expira. Recusar aqui é
  // fail-safe: a réplica fica na postura versionada, que é o estado auditável.
  if (
    fromDurableKey(source) &&
    !(typeof msg.expires_at === 'number' && Number.isFinite(msg.expires_at))
  ) {
    return reject(
      'adoção exige expires_at absoluto: validade relativa numa chave durável ressuscita o override a cada boot',
      msg.mode,
    );
  }

  const expiry = resolveOverrideExpiry(msg, now);
  if ('error' in expiry) return reject(expiry.error, msg.mode);
  const expiresAt = expiry.expires_at;

  override = { mode: msg.mode, expires_at: expiresAt, actor, reason };
  generation++;
  // `resynced` não vira ação nova na taxonomia: o desfecho de governança é o
  // mesmo de `adopted` (a chave durável mudou a postura desta réplica), e a
  // procedência vai em `source`. Ver o bloco de `via` em `auditOverride`.
  auditOverride(source === 'resynced' ? 'adopted' : source, {
    mode: msg.mode,
    actor,
    reason,
    expires_at: expiresAt,
    via: source,
  });
  return { applied: true, mode: effectiveMode(now) };
}

/** Parse + apply de uma mensagem crua do canal. Nunca lança. */
export function handleCircuitOverrideMessage(payload: string, now = Date.now()): OverrideResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    auditOverride('rejected', { mode: 'invalid', error: 'payload não é JSON' });
    return { applied: false, error: 'payload não é JSON', mode: effectiveMode(now) };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    auditOverride('rejected', { mode: 'invalid', error: 'payload não é objeto' });
    return { applied: false, error: 'payload não é objeto', mode: effectiveMode(now) };
  }
  return applyCircuitOverride(parsed as CircuitOverrideMessage, now, 'applied');
}

export const _internal = {
  /** Zera override, seam forçado e cache do baseline. */
  reset(): void {
    override = null;
    forced = null;
    baseline = null;
    lastSeen = null;
    // A geração NÃO volta a zero: ela é monotônica de propósito. Um `reset()`
    // entre a captura e a comparação tem que INVALIDAR a releitura em voo, e
    // zerar o contador poderia fazê-la casar de novo por acaso.
    generation++;
  },
  /** Seam de teste/benchmark. Vence override e contrato. */
  setMode(next: CircuitMode | null): void {
    forced = next;
  },
  forcedMode(): CircuitMode | null {
    return forced;
  },
  baselineMode,
  rawOverride(): CircuitOverride | null {
    return override;
  },
};
