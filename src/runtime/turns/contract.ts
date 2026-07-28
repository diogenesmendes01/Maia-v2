/**
 * Issue #503 — contrato PÚBLICO da máquina de estados durável do turno inbound.
 *
 * Este módulo é a INTERFACE consumida pelas issues seguintes da Fase 1
 * (#504 claim/lease/fencing, #505 FIFO por conversa, #506 outbox, #507
 * deadline/cancelamento, #510 fault injection). É deliberadamente PURO: sem
 * import de `db`, sem I/O, sem ALS — só vocabulário, tabela de transições e
 * predicados. Isso o torna unit-testável sem Postgres e permite que o
 * repositório (`src/db/repositories/turn-repos.ts`) seja a ÚNICA porta de
 * escrita.
 *
 * Modelo: o estado descreve o CICLO OPERACIONAL do turno; o outcome descreve o
 * RESULTADO DE NEGÓCIO. Um turno terminal SEMPRE carrega outcome; um turno
 * não-terminal NUNCA carrega. A incompatibilidade é rejeitada em três camadas:
 * CHECK constraint (migration 097), este contrato e o repositório.
 *
 * Um turno é LÓGICO: agrega N mensagens inbound (debounce). A mensagem
 * representativa é a que disparou a execução; as demais entram como inputs.
 */

/** Estados do ciclo operacional do turno (issue #503 §2). */
export const TURN_STATUSES = [
  /** Inbound + turno persistidos na MESMA transação; enqueue ainda não confirmado. */
  'received',
  /** Wake-up do BullMQ confirmado. */
  'queued',
  /** Um worker possui a lease (fencing completo chega em #504). */
  'claimed',
  /** Execução efetivamente iniciada. */
  'running',
  /** Resposta comprometida no outbox — o ReAct NÃO pode ser reexecutado (#506). */
  'outbound_pending',
  /** Tentativa falhou ANTES de efeito irreversível; pode ser refeita. */
  'retryable',
  /** Término bem-sucedido ou conclusão determinística. TERMINAL. */
  'completed',
  /** Descarte intencional por regra explícita. TERMINAL. */
  'ignored',
  /** Turno incorporado a outro pelo debounce. TERMINAL. */
  'superseded',
  /** Tentativas esgotadas ou estado que exige intervenção. TERMINAL. */
  'dead_letter',
] as const;

export type TurnStatus = (typeof TURN_STATUSES)[number];

/**
 * Estados TERMINais. Nenhuma transição AUTOMÁTICA sai daqui — o replay de
 * `dead_letter` é operação manual explícita e auditada (`MANUAL_TRANSITIONS`).
 */
export const TERMINAL_TURN_STATUSES = [
  'completed',
  'ignored',
  'superseded',
  'dead_letter',
] as const;

export type TerminalTurnStatus = (typeof TERMINAL_TURN_STATUSES)[number];

/**
 * Estados a partir dos quais o recovery pode rearmar trabalho. `outbound_pending`
 * está DELIBERADAMENTE fora: a resposta já foi comprometida e quem finaliza é o
 * delivery worker (#506), nunca uma nova execução do reasoner.
 */
export const RECOVERABLE_TURN_STATUSES = [
  'received',
  'queued',
  'claimed',
  'running',
  'retryable',
] as const;

export type RecoverableTurnStatus = (typeof RECOVERABLE_TURN_STATUSES)[number];

/** Resultados de negócio (issue #503 §3). */
export const TURN_OUTCOMES = [
  'reply_delivered',
  'reply_delivery_unknown',
  'fallback_delivered',
  'no_reply_produced',
  'pending_action_resolved',
  'legacy_processed',
  'blocked_by_policy',
  'identity_unknown',
  'identity_blocked',
  'quarantined',
  'rate_limited_silent',
  'operator_cancelled',
  'merged_into_turn',
  'retry_exhausted',
  'unsafe_to_retry',
] as const;

export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

/**
 * Tabela de transições AUTOMÁTICAS permitidas (issue #503 §2).
 *
 *   received -> queued -> claimed -> running -> outbound_pending -> completed
 *
 * Alternativas:
 *   received/queued/claimed/running -> retryable -> queued
 *   received/running                -> ignored
 *   received/queued                 -> superseded
 *   claimed/running/outbound_pending/retryable -> dead_letter
 *
 * Notas de projeto (divergências conscientes do texto da issue, documentadas
 * porque #504–#507 dependem delas):
 *
 *  1. `retryable -> dead_letter` NÃO consta do fluxo alternativo da issue, mas
 *     é obrigatório: o outcome `retry_exhausted` só pode nascer do estado que
 *     acumula tentativas. Sem essa aresta o esgotamento de retry seria
 *     inexprimível.
 *  2. `claimed -> dead_letter` é admitido para que um claim que não consegue
 *     nem iniciar (worker envenenado) tenha saída terminal auditada.
 *  3. `outbound_pending` NUNCA volta para `running` — invariante dura de #506.
 *  4. `running -> completed` existe (conclusão determinística sem outbound),
 *     restrita pela lista fechada de outcomes em `TERMINAL_OUTCOMES`.
 */
export const TURN_TRANSITIONS: Readonly<Record<TurnStatus, readonly TurnStatus[]>> = {
  received: ['queued', 'claimed', 'retryable', 'ignored', 'superseded'],
  queued: ['claimed', 'retryable', 'superseded'],
  claimed: ['running', 'retryable', 'dead_letter'],
  running: ['outbound_pending', 'completed', 'ignored', 'retryable', 'dead_letter'],
  outbound_pending: ['completed', 'dead_letter'],
  retryable: ['queued', 'dead_letter'],
  completed: [],
  ignored: [],
  superseded: [],
  dead_letter: [],
} as const;

/**
 * Transições MANUAIS — só acessíveis por operação explícita e auditada, nunca
 * pelo caminho automático. Hoje só o replay de dead letter, que precisa gerar
 * nova tentativa/token (#504).
 */
export const MANUAL_TRANSITIONS: Readonly<Record<string, readonly TurnStatus[]>> = {
  dead_letter: ['queued'],
} as const;

/**
 * Outcomes admitidos por estado terminal. Cada outcome pertence a EXATAMENTE um
 * estado — pares ambíguos tornariam impossível a invariante "estado e outcome
 * incompatíveis são impedidos".
 *
 * Divergência documentada: a issue §2 sugere `completed` para
 * `blocked`/`unknown_identity`/`no_reply_policy`. Aqui esses casos são
 * `ignored`, porque §2 define `ignored` como "descarte intencional por regra
 * explícita" — exatamente o que eles são. `completed` fica reservado a turnos
 * que EXECUTARAM até o fim (entregaram resposta ou concluíram determinismo de
 * negócio). Espelhado 1:1 no CHECK da migration 097.
 */
export const TERMINAL_OUTCOMES: Readonly<Record<TerminalTurnStatus, readonly TurnOutcome[]>> = {
  completed: [
    'reply_delivered',
    'reply_delivery_unknown',
    'fallback_delivered',
    'no_reply_produced',
    'pending_action_resolved',
    'legacy_processed',
  ],
  ignored: [
    'blocked_by_policy',
    'identity_unknown',
    'identity_blocked',
    'quarantined',
    'rate_limited_silent',
    'operator_cancelled',
  ],
  superseded: ['merged_into_turn'],
  // `unsafe_to_retry`: a tentativa falhou DEPOIS de uma tool com efeito externo
  // irreversível ter rodado. Retry duplicaria o efeito, então o turno para aqui
  // e exige decisão humana (replay manual auditado, ou encerramento).
  dead_letter: ['retry_exhausted', 'operator_cancelled', 'unsafe_to_retry'],
} as const;

/**
 * Outcomes de `completed` que NÃO implicam resposta entregue. Auditoria
 * obrigatória (issue #503 § "Auditoria obrigatória para: conclusão sem
 * resposta").
 */
export const COMPLETED_WITHOUT_REPLY_OUTCOMES: readonly TurnOutcome[] = [
  'no_reply_produced',
  'pending_action_resolved',
  'legacy_processed',
] as const;

/** Motivos pelos quais o recovery elege um turno (label de métrica). */
export const TURN_RECOVERY_REASONS = [
  'received_stale',
  'queued_unclaimed',
  'retry_due',
  'lease_expired',
] as const;

export type TurnRecoveryReason = (typeof TURN_RECOVERY_REASONS)[number];

const TERMINAL_SET: ReadonlySet<string> = new Set<string>(TERMINAL_TURN_STATUSES);
const RECOVERABLE_SET: ReadonlySet<string> = new Set<string>(RECOVERABLE_TURN_STATUSES);
const STATUS_SET: ReadonlySet<string> = new Set<string>(TURN_STATUSES);
const OUTCOME_SET: ReadonlySet<string> = new Set<string>(TURN_OUTCOMES);

export function isTurnStatus(value: unknown): value is TurnStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

export function isTurnOutcome(value: unknown): value is TurnOutcome {
  return typeof value === 'string' && OUTCOME_SET.has(value);
}

export function isTerminalTurnStatus(status: TurnStatus): status is TerminalTurnStatus {
  return TERMINAL_SET.has(status);
}

export function isRecoverableTurnStatus(status: TurnStatus): status is RecoverableTurnStatus {
  return RECOVERABLE_SET.has(status);
}

/**
 * Erro FAIL-LOUD de transição inválida. É erro de PROGRAMAÇÃO (par proibido
 * pela tabela, outcome incompatível, outcome ausente em terminal) — distinto de
 * um CONFLITO de concorrência, que é resultado TIPADO (`TurnTransitionResult`).
 */
export class InvalidTurnTransitionError extends Error {
  readonly code = 'INVALID_TURN_TRANSITION';
  readonly from: TurnStatus;
  readonly to: TurnStatus;
  readonly outcome: TurnOutcome | null;

  constructor(args: {
    from: TurnStatus;
    to: TurnStatus;
    outcome: TurnOutcome | null;
    reason: string;
  }) {
    super(
      `transição de turno inválida ${args.from} -> ${args.to}` +
        (args.outcome ? ` (outcome=${args.outcome})` : '') +
        `: ${args.reason}`,
    );
    this.name = 'InvalidTurnTransitionError';
    this.from = args.from;
    this.to = args.to;
    this.outcome = args.outcome;
  }
}

export type TransitionCheck =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'terminal_source'
        | 'not_in_transition_table'
        | 'missing_outcome'
        | 'outcome_on_non_terminal'
        | 'incompatible_outcome';
      detail: string;
    };

/**
 * Valida um par (from, to, outcome) contra a tabela de transições e a
 * compatibilidade estado/outcome. NÃO toca no banco — o CAS é responsabilidade
 * do repositório.
 *
 * @param opts.manual quando true, admite adicionalmente as arestas de
 *   `MANUAL_TRANSITIONS` (replay operacional auditado de dead letter).
 */
export function checkTurnTransition(
  from: TurnStatus,
  to: TurnStatus,
  outcome: TurnOutcome | null = null,
  opts: { manual?: boolean } = {},
): TransitionCheck {
  const automatic = TURN_TRANSITIONS[from] ?? [];
  const manual = opts.manual ? (MANUAL_TRANSITIONS[from] ?? []) : [];
  if (!automatic.includes(to) && !manual.includes(to)) {
    if (isTerminalTurnStatus(from)) {
      return {
        allowed: false,
        reason: 'terminal_source',
        detail: `'${from}' é terminal: nenhuma transição automática sai dele`,
      };
    }
    return {
      allowed: false,
      reason: 'not_in_transition_table',
      detail: `'${from}' -> '${to}' não consta da tabela de transições`,
    };
  }

  if (isTerminalTurnStatus(to)) {
    if (outcome === null) {
      return {
        allowed: false,
        reason: 'missing_outcome',
        detail: `estado terminal '${to}' exige outcome explícito`,
      };
    }
    if (!TERMINAL_OUTCOMES[to].includes(outcome)) {
      return {
        allowed: false,
        reason: 'incompatible_outcome',
        detail: `outcome '${outcome}' não é válido para o estado '${to}'`,
      };
    }
    return { allowed: true };
  }

  if (outcome !== null) {
    return {
      allowed: false,
      reason: 'outcome_on_non_terminal',
      detail: `estado não-terminal '${to}' não pode carregar outcome`,
    };
  }
  return { allowed: true };
}

/** Variante fail-loud de `checkTurnTransition` — lança em par inválido. */
export function assertTurnTransition(
  from: TurnStatus,
  to: TurnStatus,
  outcome: TurnOutcome | null = null,
  opts: { manual?: boolean } = {},
): void {
  const check = checkTurnTransition(from, to, outcome, opts);
  if (!check.allowed) {
    throw new InvalidTurnTransitionError({ from, to, outcome, reason: check.detail });
  }
}

/** Estados de origem admissíveis para chegar a `to` (usado no CAS `status = ANY($1)`). */
export function sourceStatusesFor(to: TurnStatus, opts: { manual?: boolean } = {}): TurnStatus[] {
  const sources: TurnStatus[] = [];
  for (const from of TURN_STATUSES) {
    if ((TURN_TRANSITIONS[from] ?? []).includes(to)) sources.push(from);
    else if (opts.manual && (MANUAL_TRANSITIONS[from] ?? []).includes(to)) sources.push(from);
  }
  return sources;
}

// ─── Sanitização de erro persistido ───────────────────────────────────────
//
// Invariante da issue: "Payload, texto da mensagem, prompt ou PII não entram em
// logs de transição". `last_error_summary` é gravado no banco e sai em logs, então
// passa por aqui SEMPRE. A regra é conservadora: redige antes de truncar, e
// trunca duro.

/** Limite duro do resumo persistido (espelhado no CHECK da migration 097). */
export const TURN_ERROR_SUMMARY_MAX = 240;

/** Limite do código de erro normalizado. */
export const TURN_ERROR_CODE_MAX = 64;

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // JIDs do WhatsApp (…@s.whatsapp.net, …@lid, …@g.us) antes de qualquer outra regra.
  [/[\w.+-]+@(?:s\.whatsapp\.net|lid|g\.us|c\.us|broadcast)/gi, '[JID]'],
  // E-mails.
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]'],
  // Telefones / sequências longas de dígitos (>=6), inclusive com +, -, espaço, ().
  [/\+?\d[\d\s().-]{5,}\d/g, '[NUM]'],
  // UUIDs — identificam rows, não são PII, mas inflam o resumo e vazam ids de
  // payload; o turn_id já vai em campo próprio.
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[UUID]'],
];

export type SanitizedTurnError = {
  /** Código estável `[a-z0-9_]{1,64}` — seguro como label de métrica. */
  code: string;
  /** Resumo redigido e truncado, ou null quando não há mensagem utilizável. */
  summary: string | null;
};

/**
 * Normaliza + redige um erro para persistência em `agent_turns`.
 *
 * O `code` NUNCA vem de texto livre do erro: ou é fornecido pelo chamador (é
 * ele quem conhece o estágio), ou lido de `err.code` quando já é um símbolo
 * estável, ou cai em `unknown_error`. Isso mantém a cardinalidade das métricas
 * limitada — requisito explícito da issue.
 */
export function sanitizeTurnError(input: {
  code?: string | null;
  error?: unknown;
}): SanitizedTurnError {
  const raw =
    input.code ??
    (typeof (input.error as { code?: unknown } | null | undefined)?.code === 'string'
      ? ((input.error as { code: string }).code)
      : null);
  const code = normalizeTurnErrorCode(raw);

  const message =
    input.error instanceof Error
      ? input.error.message
      : typeof input.error === 'string'
        ? input.error
        : null;
  if (message === null) return { code, summary: null };

  let summary = message;
  for (const [pattern, replacement] of REDACTIONS) summary = summary.replace(pattern, replacement);
  summary = summary.replace(/\s+/g, ' ').trim();
  if (summary.length === 0) return { code, summary: null };
  if (summary.length > TURN_ERROR_SUMMARY_MAX) {
    summary = summary.slice(0, TURN_ERROR_SUMMARY_MAX - 1) + '…';
  }
  return { code, summary };
}

/** `[a-z0-9_]{1,64}`; qualquer outra coisa vira `unknown_error`. */
export function normalizeTurnErrorCode(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return 'unknown_error';
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, TURN_ERROR_CODE_MAX);
  return normalized.length > 0 ? normalized : 'unknown_error';
}
