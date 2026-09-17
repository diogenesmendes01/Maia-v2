/**
 * P06 (spec §9.2, §6.10; gate G-COST; T56, T57, T59) — a CONTABILIDADE de uso
 * como dobra PURA e idempotente.
 *
 * ─── As frases que este arquivo torna executáveis ──────────────────────────
 *
 * §9.2, `engine_usage_events`: "evento idempotente ligado ao request/run,
 * `reported|estimated|reconciled|adjustment`, delta/unidade, fonte e dedupe;
 * **nenhum overwrite silencioso de custo anterior**".
 *
 * §9.2, liquidação: "contabilizar request uma única vez... Nova evidência pode
 * ajustar o valor com evento compensatório, **não apagar a cobrança original**.
 * **`cost=null` não é zero**."
 *
 * ─── Por que uma DOBRA, e não um acumulador ────────────────────────────────
 *
 * Porque a pergunta que o T57 faz é sobre REPETIÇÃO: webhook e poll entregam o
 * mesmo fato mais de uma vez, e um acumulador que soma "o que chegou" soma duas
 * vezes por construção. Uma dobra sobre eventos identificados responde a mesma
 * pergunta de forma estável — reprocessar a lista inteira dá o mesmo número, que
 * é o teste que o §9.2 pede ("testar retry, timeout, reprocessamento do evento").
 *
 * ─── Por que PURO ──────────────────────────────────────────────────────────
 *
 * Sem `db`, sem Redis, sem config, sem relógio. O estado durável é das tabelas
 * do §9.2; aqui mora só a aritmética e o julgamento sobre o que se SABE. Manter
 * isso puro é o que torna T56/T57/T59 verificáveis sem banco e sem provider.
 *
 * ─── Dinheiro é inteiro ────────────────────────────────────────────────────
 *
 * `microusd` em string decimal, somado em `BigInt` (§5.3.1: "dinheiro nunca em
 * float"; §9.2: "unidades `microusd` inteiras não negativas"). Um `Number`
 * aqui perderia centavos acima de 2^53 — e perder dinheiro no arredondamento é
 * exatamente o defeito que um ledger existe para não ter.
 */

/** Tipos de evento do §9.2, e somente eles. */
export const USAGE_EVENT_KINDS = ['reported', 'estimated', 'reconciled', 'adjustment'] as const;

export type UsageEventKind = (typeof USAGE_EVENT_KINDS)[number];

/**
 * De onde veio o número. `unavailable` é um valor de primeira classe: é o que
 * o §9.1 item 9 chama de "erros após envio não equivalem a custo zero".
 */
export const USAGE_SOURCES = [
  'provider_accounted',
  'engine_reported',
  'gateway_estimated',
  'unavailable',
] as const;

export type UsageSource = (typeof USAGE_SOURCES)[number];

/**
 * O que a conta SABE sobre si mesma. Estados VISÍVEIS, nunca inferidos de um
 * total igual a zero.
 *
 *  - `reserved` — nada foi observado ainda. Note que NÃO é `settled` com zero:
 *    "não observei" e "custou zero" são fatos diferentes, e colapsá-los é a
 *    falha que o T59 existe para impedir;
 *  - `estimated` — há exposição calculada pelo gateway, sem confirmação;
 *  - `settled` — há evidência (`reported`/`reconciled`) e nada pendente;
 *  - `unknown` — algum evento veio sem valor. Domina todos os outros.
 */
export const ACCOUNTING_STATUSES = ['reserved', 'estimated', 'settled', 'unknown'] as const;

export type AccountingStatus = (typeof ACCOUNTING_STATUSES)[number];

export interface UsageEventV1 {
  /** Chave de DEDUPE. Redelivery repete este id; fato novo cria outro. */
  event_id: string;
  attempt_id: string;
  kind: UsageEventKind;
  /**
   * Delta em `microusd`. `null` = DESCONHECIDO, e nunca zero (§9.2). Negativo
   * só faz sentido em `adjustment`, o evento compensatório.
   */
  delta_microusd: string | null;
  source: UsageSource;
}

export interface AccountingFoldV1 {
  total_microusd: string;
  status: AccountingStatus;
  /** Ids contados, na ordem da primeira ocorrência. */
  counted_event_ids: string[];
  duplicates_ignored: number;
  unknown_events: number;
}

/**
 * Mesmo `event_id`, conteúdo diferente.
 *
 * Isso NÃO é redelivery: é o mesmo identificador afirmando duas coisas. O §9.2
 * proíbe "overwrite silencioso de custo anterior", e silenciosamente escolher um
 * dos dois valores seria exatamente isso. Falhar alto é o que faz a divergência
 * virar investigação em vez de um número errado no painel.
 */
export class UsageEventConflictError extends Error {
  constructor(readonly event_id: string) {
    // Sem os valores na mensagem: ela pode ir para log, e custo de tenant é
    // dado do operador.
    super(`evento de uso ${event_id} reapresentado com conteúdo divergente`);
    this.name = 'UsageEventConflictError';
  }
}

/** Inteiro decimal com sinal opcional. Recusa `007`, `+1`, `1.5`, `1e3`, espaços. */
const DECIMAL_INT_RE = /^-?(0|[1-9][0-9]*)$/;

function parseDelta(ev: UsageEventV1): bigint | null {
  if (ev.delta_microusd === null) return null;
  if (!DECIMAL_INT_RE.test(ev.delta_microusd)) {
    throw new TypeError(
      `evento ${ev.event_id}: delta_microusd precisa ser inteiro decimal em string (§5.3.1)`,
    );
  }
  const valor = BigInt(ev.delta_microusd);
  if (valor < 0n && ev.kind !== 'adjustment') {
    // Só o evento compensatório pode ser negativo. Um `reported` negativo seria
    // um estorno disfarçado de cobrança, e o §9.2 quer o estorno explícito.
    throw new RangeError(
      `evento ${ev.event_id}: só \`adjustment\` pode ter delta negativo (§9.2)`,
    );
  }
  return valor;
}

/** Assinatura do conteúdo, para distinguir redelivery de conflito. */
function assinatura(ev: UsageEventV1): string {
  return JSON.stringify([ev.attempt_id, ev.kind, ev.delta_microusd, ev.source]);
}

/**
 * Dobra os eventos numa posição financeira. Função TOTAL sobre entradas válidas;
 * lança em entradas que representam DEFEITO (conflito, delta malformado,
 * negativo indevido, total negativo).
 *
 * ─── Por que `unknown` DOMINA ──────────────────────────────────────────────
 *
 * Um evento sem valor significa que a plataforma não sabe o que aquela tentativa
 * custou. Deixar o status `settled` porque os OUTROS eventos têm valor afirmaria
 * conhecer a fatura inteira — e é assim que uma cobrança some do painel sem que
 * ninguém tenha decidido descartá-la (§9.1 item 9).
 *
 * ─── Por que zero SEM evidência não liquida ────────────────────────────────
 *
 * A régua é a EVIDÊNCIA, não o número. Zero reportado pelo provider é um fato e
 * liquida; zero por ausência de eventos é `reserved`. São estados diferentes
 * porque levam a ações diferentes: um fecha a conta, o outro manda reconciliar.
 */
export function foldUsageEvents(events: readonly UsageEventV1[]): AccountingFoldV1 {
  const vistos = new Map<string, string>();
  const counted_event_ids: string[] = [];
  const kinds: UsageEventKind[] = [];
  let total = 0n;
  let duplicates_ignored = 0;
  let unknown_events = 0;

  for (const ev of events) {
    const assinaturaAtual = assinatura(ev);
    const anterior = vistos.get(ev.event_id);
    if (anterior !== undefined) {
      if (anterior !== assinaturaAtual) throw new UsageEventConflictError(ev.event_id);
      duplicates_ignored++;
      continue;
    }
    // Valida ANTES de registrar: um evento malformado não entra na trilha.
    const delta = parseDelta(ev);
    vistos.set(ev.event_id, assinaturaAtual);
    counted_event_ids.push(ev.event_id);
    kinds.push(ev.kind);
    if (delta === null) unknown_events++;
    else total += delta;
  }

  if (total < 0n) {
    // §9.2: as unidades da conta são "inteiras não negativas". Um ajuste que
    // leva o total abaixo de zero não é saldo a favor — é evidência
    // inconsistente, e devolver um número negativo o esconderia.
    throw new RangeError(
      'contabilidade de uso ficou negativa: ajuste compensatório maior que a cobrança (§9.2)',
    );
  }

  return {
    total_microusd: total.toString(),
    status: derivarStatus(counted_event_ids.length, unknown_events, kinds),
    counted_event_ids,
    duplicates_ignored,
    unknown_events,
  };
}

function derivarStatus(
  contados: number,
  desconhecidos: number,
  kinds: readonly UsageEventKind[],
): AccountingStatus {
  if (contados === 0) return 'reserved';
  if (desconhecidos > 0) return 'unknown';
  if (kinds.includes('estimated')) return 'estimated';
  return 'settled';
}
