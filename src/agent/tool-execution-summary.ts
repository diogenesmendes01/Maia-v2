/**
 * Tool execution summary persistence — issue #73, Repro 2.
 *
 * The bug: the LLM denies a tool result it produced one turn ago, because
 * by the next turn the raw tool_result is gone (history rebuilds from
 * `mensagens` which only keeps the final assistant text).
 *
 * The fix: persist a STRUCTURED summary of each tool execution in
 * `mensagens.ferramentas_chamadas` (already-jsonb, formerly always `[]`).
 * On the next turn, prompt-builder reidrates these into a system block
 * called "## Eventos confirmados pelo backend" — separate from the
 * conversation, with higher authority than assistant history per the
 * evidence hierarchy.
 *
 * result_keys is allowlist-typed (primitives + flat arrays of primitives)
 * to prevent accidental PII leakage or large payload bloat.
 */

import type { Tool } from '@/tools/_registry.js';

export type ResultKeyValue = string | number | boolean | string[] | number[];
export type ResultKeys = Record<string, ResultKeyValue>;

export type ToolSideEffect = 'none' | 'read' | 'write' | 'communication';

export type ToolExecutionSummary = {
  tool_call_id: string;
  tool_name: string;
  status: 'success' | 'error';
  side_effect: 'read' | 'write' | 'communication' | null;
  result_summary: string;
  error_summary?: string;
  result_keys?: ResultKeys;
  occurred_at: string;
};

type Summarizer = (args: unknown, result: unknown) => {
  result_summary: string;
  result_keys?: ResultKeys;
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function asString(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}

function asNumber(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '?';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // YYYY-MM-DD HH:mm — keep it minimal, the LLM doesn't need seconds
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

const SCHEDULE_REMINDER: Summarizer = (_args, result) => {
  if (!isRecord(result)) return { result_summary: 'schedule_reminder: ok (resultado opaco)' };
  const scheduled_for = asString(result.scheduled_for);
  const series_id = asString(result.series_id);
  const occurrence_id = asString(result.occurrence_id);
  const result_keys: ResultKeys = {};
  if (series_id) result_keys.series_id = series_id;
  if (occurrence_id) result_keys.occurrence_id = occurrence_id;
  if (scheduled_for) result_keys.scheduled_for = scheduled_for;
  return {
    result_summary: `lembrete agendado para ${fmtDate(scheduled_for)} (occurrence pending)`,
    result_keys,
  };
};

const REGISTER_TRANSACTION: Summarizer = (_args, result) => {
  if (!isRecord(result)) return { result_summary: 'register_transaction: ok (resultado opaco)' };
  if (result.duplicate_suspected === true) {
    return {
      result_summary: 'transação suspeita de duplicata — não criou nova; existente já encontrada',
    };
  }
  // Codex C2 (PR #74): do NOT persist `saldo_apos` in result_keys.
  // `register_transaction` is not flagged sensitive in the tool registry, so
  // any follow-up answered from a persisted balance would bypass the
  // view-once / sensitive-output controls reserved for `query_balance`.
  // The next turn must re-query through `query_balance` to surface a balance.
  const transacao_id = asString(result.transacao_id);
  const result_keys: ResultKeys = {};
  if (transacao_id) result_keys.transacao_id = transacao_id;
  return {
    result_summary: `transação registrada (id ${transacao_id ?? '?'})`,
    result_keys,
  };
};

const CANCEL_REMINDER: Summarizer = (_args, result) => {
  if (!isRecord(result)) return { result_summary: 'cancel_reminder: ok' };
  const cancelled = result.cancelled === true;
  const cancelled_occurrence_count = asNumber(result.cancelled_occurrence_count) ?? 0;
  const reason = asString(result.reason);
  if (!cancelled) {
    const keys: ResultKeys = { cancelled: false };
    if (reason) keys.reason = reason;
    return {
      result_summary: `cancel_reminder: não cancelou (${reason ?? 'desconhecido'})`,
      result_keys: keys,
    };
  }
  return {
    result_summary: `série cancelada (${cancelled_occurrence_count} ocorrência(s) encerradas)`,
    result_keys: { cancelled: true, cancelled_occurrence_count },
  };
};

const CANCEL_TRANSACTION: Summarizer = (_args, result) => {
  if (!isRecord(result)) return { result_summary: 'cancel_transaction: ok' };
  const transacao_id = asString(result.transacao_id);
  return {
    result_summary: `transação cancelada (id ${transacao_id ?? '?'})`,
    ...(transacao_id ? { result_keys: { transacao_id } } : {}),
  };
};

const CLASSIFY_TRANSACTION: Summarizer = (_args, result) => {
  if (!isRecord(result)) return { result_summary: 'classify_transaction: ok' };
  const categoria_id = asString(result.categoria_id);
  return {
    result_summary: `transação classificada${categoria_id ? ` (categoria ${categoria_id})` : ''}`,
    ...(categoria_id ? { result_keys: { categoria_id } } : {}),
  };
};

const START_RECURRING_OUTREACH: Summarizer = (_args, result) => {
  if (!isRecord(result)) return { result_summary: 'start_recurring_outreach: ok' };
  const series_id = asString(result.series_id);
  const next_scheduled_for = asString(result.next_scheduled_for);
  return {
    result_summary: `série recorrente iniciada (próximo envio: ${fmtDate(next_scheduled_for)})`,
    result_keys: {
      ...(series_id ? { series_id } : {}),
      ...(next_scheduled_for ? { next_scheduled_for } : {}),
    },
  };
};

const START_RECURRING_PAYMENT: Summarizer = (_args, result) => {
  if (!isRecord(result)) return { result_summary: 'start_recurring_payment: ok' };
  const series_id = asString(result.series_id);
  return {
    result_summary: `pagamento recorrente iniciado`,
    ...(series_id ? { result_keys: { series_id } } : {}),
  };
};

const SEND_PROACTIVE_MESSAGE: Summarizer = (_args, _result) => ({
  result_summary: 'mensagem proativa enviada',
});

const ASK_PENDING_QUESTION: Summarizer = (_args, result) => {
  if (!isRecord(result)) return { result_summary: 'pergunta pendente registrada' };
  const pending_question_id = asString(result.pending_question_id);
  return {
    result_summary: 'pergunta de confirmação criada e enviada',
    ...(pending_question_id ? { result_keys: { pending_question_id } } : {}),
  };
};

const GENERATE_REPORT: Summarizer = (_args, result) => {
  if (!isRecord(result)) return { result_summary: 'generate_report: ok' };
  const tipo = asString(result.tipo);
  const fileName = asString(result.fileName);
  return {
    result_summary: `relatório PDF gerado${tipo ? ` (${tipo})` : ''}`,
    result_keys: {
      ...(tipo ? { tipo } : {}),
      ...(fileName ? { fileName } : {}),
    },
  };
};

const SAVE_FACT: Summarizer = (_args, _result) => ({
  result_summary: 'fato salvo na memória do agente',
});

const SAVE_RULE: Summarizer = (_args, _result) => ({
  result_summary: 'regra aprendida salva',
});

const SUMMARIZERS: Record<string, Summarizer | undefined> = {
  schedule_reminder: SCHEDULE_REMINDER,
  register_transaction: REGISTER_TRANSACTION,
  cancel_reminder: CANCEL_REMINDER,
  cancel_transaction: CANCEL_TRANSACTION,
  classify_transaction: CLASSIFY_TRANSACTION,
  start_recurring_outreach: START_RECURRING_OUTREACH,
  start_recurring_payment: START_RECURRING_PAYMENT,
  send_proactive_message: SEND_PROACTIVE_MESSAGE,
  ask_pending_question: ASK_PENDING_QUESTION,
  generate_report: GENERATE_REPORT,
  save_fact: SAVE_FACT,
  save_rule: SAVE_RULE,
};

/**
 * Domain keywords used by prompt-builder's contradiction-overlay heuristic.
 * If a prior assistant message text contains a failure phrase AND a domain
 * keyword for a tool that succeeded in the same turn, we emit a "claim
 * invalidated" overlay in the system prompt. read-only tools intentionally
 * omitted — a failure phrase next to "saldo" / "extrato" doesn't usually
 * mean the LLM is denying a side effect.
 */
export const DOMAIN_KEYWORDS: Record<string, string[] | undefined> = {
  schedule_reminder: ['agendar', 'lembrete', 'lembretes', 'agendamento'],
  start_recurring_outreach: ['agendar', 'recorrente', 'recorrência', 'lembrete'],
  start_recurring_payment: ['agendar', 'pagamento', 'recorrente'],
  cancel_reminder: ['cancelar', 'remover lembrete', 'desativar'],
  cancel_transaction: ['cancelar', 'estornar', 'remover transação'],
  register_transaction: ['registrar', 'lançamento', 'transação', 'lançar'],
  classify_transaction: ['classificar', 'categorizar'],
  generate_report: ['relatório', 'extrato', 'report'],
  save_fact: ['salvar', 'memorizar', 'anotar', 'lembrar'],
  save_rule: ['salvar', 'regra'],
  send_proactive_message: ['avisar', 'enviar mensagem', 'comunicar'],
  ask_pending_question: ['confirmação', 'confirmar', 'perguntar'],
};

function normalizeSideEffect(se: ToolSideEffect): 'read' | 'write' | 'communication' | null {
  return se === 'none' ? null : se;
}

function genericErrorSummary(toolName: string, result: unknown): string {
  if (isRecord(result)) {
    const errKey = asString(result.error);
    if (errKey) return `${toolName}: erro (${errKey})`;
    const msg = asString(result.message);
    if (msg) return `${toolName}: erro (${msg.slice(0, 120)})`;
  }
  return `${toolName}: erro`;
}

export function buildToolSummary(input: {
  tool_call_id: string;
  tool_name: string;
  side_effect: ToolSideEffect;
  args: unknown;
  result: unknown;
  status: 'success' | 'error';
  /**
   * Superpowers I4 (PR #74): `occurred_at` semantics.
   *
   * Pass the dispatch START timestamp (captured BEFORE `dispatchTool` returns)
   * so the events-block 24h window-filter uses the user's reference frame
   * (when the side effect was REQUESTED), not the post-completion wall clock.
   * Matters for long-running tools (PDF gen, external APIs) where dispatch
   * and completion straddle the window boundary.
   *
   * When omitted, falls back to `Date.now()` (completion time) for backwards
   * compatibility with any caller that doesn't have a dispatch timestamp.
   */
  dispatched_at?: number;
}): ToolExecutionSummary {
  const occurred_at = new Date(input.dispatched_at ?? Date.now()).toISOString();
  const side_effect = normalizeSideEffect(input.side_effect);

  if (input.status === 'error') {
    return {
      tool_call_id: input.tool_call_id,
      tool_name: input.tool_name,
      status: 'error',
      side_effect,
      result_summary: `${input.tool_name}: erro`,
      error_summary: genericErrorSummary(input.tool_name, input.result),
      occurred_at,
    };
  }

  const summarizer = SUMMARIZERS[input.tool_name];
  if (summarizer) {
    const { result_summary, result_keys } = summarizer(input.args, input.result);
    return {
      tool_call_id: input.tool_call_id,
      tool_name: input.tool_name,
      status: 'success',
      side_effect,
      result_summary,
      ...(result_keys && Object.keys(result_keys).length > 0 ? { result_keys } : {}),
      occurred_at,
    };
  }

  return {
    tool_call_id: input.tool_call_id,
    tool_name: input.tool_name,
    status: 'success',
    side_effect,
    result_summary: `${input.tool_name}: ok`,
    occurred_at,
  };
}

/**
 * Build a summary from a Tool definition + execution result. Convenience
 * wrapper used by the react-loop to avoid repeating side_effect plumbing.
 */
export function buildToolSummaryFromTool(input: {
  tool: Pick<Tool<never, never>, 'name' | 'side_effect'>;
  tool_call_id: string;
  args: unknown;
  result: unknown;
  status: 'success' | 'error';
}): ToolExecutionSummary {
  return buildToolSummary({
    tool_call_id: input.tool_call_id,
    tool_name: input.tool.name,
    side_effect: input.tool.side_effect,
    args: input.args,
    result: input.result,
    status: input.status,
  });
}
