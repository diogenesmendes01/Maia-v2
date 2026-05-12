/**
 * Spec 18 — Scheduling domain types.
 *
 * The four DB tables (series / occurrences / tasks / outbox_messages) are
 * the canonical types from `@/db/schema.js`. This module narrows the
 * string-typed enum columns (status, kind, policies) to typed unions so
 * callers don't repeat the same literal lists in every switch.
 */

export type SeriesTipo = 'one_shot_reminder' | 'recurring_outreach' | 'recurring_payment';

export type SeriesStatus = 'active' | 'paused' | 'cancelled';

export type MonthEndPolicy =
  | 'skip_invalid_month'
  | 'last_day_of_month'
  | 'nearest_previous'
  | 'nearest_next';

export type MissedRunPolicy =
  | 'fire_all'
  | 'fire_latest_only'
  | 'skip_all'
  | 'escalate_to_owner';

export type OccurrenceStatus =
  | 'pending'
  | 'claimed'
  | 'in_progress'
  | 'awaiting_third_party'
  | 'awaiting_owner'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'aged_out'
  | 'cancelled';

export type OccurrenceOutcome =
  | 'sim'
  | 'nao'
  | 'adiar'
  | 'no_response'
  | 'fired'
  | 'forwarded'
  | 'aged_out'
  | 'cancelled'
  | null;

export type TaskKind =
  | 'fire_reminder'
  | 'send_outreach'
  | 'await_response'
  | 'forward'
  | 'propose_payment'
  | 'await_decision'
  | 'execute_or_skip';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';

export type OutboxKind =
  | 'whatsapp_text'
  | 'whatsapp_pending_question'
  | 'whatsapp_alert'
  | 'email_alert';

export type OutboxStatus = 'pending' | 'claimed' | 'sent' | 'failed' | 'dead';

export interface OneShotReminderContexto {
  texto: string;
  canal: 'whatsapp';
}

export interface RecurringOutreachContexto {
  destinatario_pessoa_id: string;
  forward_to_pessoa_id?: string | null;
  message_template: string;
  forward_template?: string | null;
  wait_response_hours: number;
}

export interface RecurringPaymentContexto {
  conta_id: string;
  valor: number;
  descricao: string;
  categoria_id?: string | null;
  contraparte_id?: string | null;
  escalate_after_hours: number;
}

export type SeriesContexto =
  | OneShotReminderContexto
  | RecurringOutreachContexto
  | RecurringPaymentContexto;

export interface WhatsappTextPayload {
  jid: string;
  text: string;
}

export interface WhatsappPendingQuestionPayload {
  pessoa_id: string;
  conversa_id: string;
  tipo: string;
  pergunta: string;
  opcoes_validas: Array<{ key: string; label: string }>;
  acao_proposta: Record<string, unknown>;
  expira_em: string; // ISO
}

export interface WhatsappAlertPayload {
  jid: string;
  text: string;
}

export interface EmailAlertPayload {
  subject: string;
  body: string;
}

export type OutboxPayload =
  | WhatsappTextPayload
  | WhatsappPendingQuestionPayload
  | WhatsappAlertPayload
  | EmailAlertPayload;
