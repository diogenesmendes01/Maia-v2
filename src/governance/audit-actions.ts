export const AUDIT_ACTIONS = [
  'person_created',
  'person_activated',
  'permission_preview_generated',
  'permission_confirmed',
  'permission_changed',
  'permission_revoked',
  'permission_suspended_inactivity',
  'first_contact_received',
  'owner_confirmed_identity',
  'transaction_created',
  'transaction_corrected',
  'transaction_cancelled',
  'classification_suggested',
  'reminder_scheduled',
  'boleto_parsed',
  'receipt_parsed',
  'image_parsed',
  'audio_transcribed',
  'rule_learned',
  'rule_promoted',
  'rule_demoted',
  'rule_banned',
  'fact_saved',
  'memory_recalled',
  'reflection_completed',
  'dual_approval_requested',
  'dual_approval_granted',
  'dual_approval_denied',
  'dual_approval_timeout',
  'dual_approval_executed',
  // Fase 0 cap. 2/3 — store backend de evidência de aprovação (migration 095).
  // Cobre tanto confirmação simples quanto 4-eyes; o ciclo completo é
  // requested → decision_recorded* → granted|denied|expired → claimed →
  // consumed | execution_failed. replay_blocked/payload_mismatch são os
  // bloqueios de reuso/adulteração.
  'approval_requested',
  'approval_decision_recorded',
  'approval_granted',
  'approval_denied',
  'approval_expired',
  'approval_claimed',
  'approval_consumed',
  'approval_execution_failed',
  'approval_payload_mismatch',
  'approval_replay_blocked',
  'audit_mode_activated',
  'audit_mode_deactivated',
  'audit_mode_deactivated_auto',
  'emergency_lockdown_activated',
  'emergency_lockdown_lifted',
  'unauthorized_access_attempt',
  'rate_limit_exceeded',
  'unknown_number_message_received',
  'group_message_ignored',
  'duplicate_message_dropped',
  'auto_blocked_anomalous_volume',
  'system_started',
  'system_stopped',
  // Issue #512 — explicit lifecycle outcomes. `system_started` now lands only
  // AFTER every mandatory dependency for the process role was verified; these
  // two cover the paths that used to be invisible: a boot aborted fail-closed
  // on an unavailable dependency, and an operator-forced exit (second stop
  // signal, or a drain deadline that expired with work still in flight).
  'system_start_failed',
  'system_shutdown_forced',
  'config_loaded',
  'backup_completed',
  'backup_failed',
  'backup_s3_upload_failed',
  'backup_cloud_rotation_completed',
  'backup_cloud_rotation_failed',
  'restore_test_passed',
  'restore_test_failed',
  'whatsapp_connected',
  'whatsapp_disconnected',
  'llm_circuit_opened',
  'llm_circuit_closed',
  'dashboard_session_started',
  'dashboard_session_ended',
  'dlq_job_added',
  'dlq_job_resolved',
  'dlq_alert_emitted',
  // Issue #503 — máquina de estados durável do turno inbound. Auditamos apenas
  // o que a issue exige (§ "Auditoria obrigatória"): descarte por política,
  // dead letter, replay manual, conclusão SEM resposta e detecção de
  // inconsistência entre a máquina de estados e a projeção legada
  // `processada_em`. Transições rotineiras (received→queued→claimed→running)
  // ficam em métrica/log estruturado — auditá-las inflaria `audit_logs` sem
  // acrescentar decisão governável. NENHUM desses registros carrega texto,
  // prompt, telefone ou JID.
  'turn_ignored_by_policy',
  'turn_dead_lettered',
  'turn_replayed',
  'turn_completed_without_reply',
  'turn_state_inconsistency_detected',
  'pending_resolved',
  'pending_cancelled',
  'pending_expired',
  'balance_queried',
  'workflow_rolled_back',
  'workflow_compensation_required',
  'pending_created',
  'pending_resolved_by_gate',
  'pending_unresolved_topic_change',
  'pending_unresolved_cancelled',
  'pending_unresolved_low_confidence',
  'pending_substituted',
  'pending_action_dispatched',
  'pending_race_lost',
  'pending_resolved_by_reaction',
  'pending_resolved_by_poll',
  'reaction_ignored_unmapped_emoji',
  'one_tap_no_pending_anchor',
  'one_tap_dispatch_error',
  'mensagem_edited',
  'mensagem_revoked',
  'mensagem_edited_after_side_effect',
  'mensagem_revoked_after_side_effect',
  'edit_review_resolved',
  'pending_substituted_by_edit_review',
  'pending_reminder_sent',
  'pending_reminder_skipped_no_outbound',
  'pending_reminder_skipped_already_marked',
  'pending_reminder_skipped_stale',
  'outbound_sent_view_once',
  'outbound_view_once_skipped_by_preference',
  'outbound_sent_document',
  'outbound_sent_voice',
  'outbound_dispatch_failed',
  'pairing_qr_displayed',
  'pairing_code_requested',
  'pairing_completed',
  'pairing_logged_out',
  'pairing_recovery_started',
  'pairing_recovery_completed',
  'setup_token_rotated',
  'setup_unauthorized_access',
  'setup_csrf_mismatch',
  'llm_model_changed',
  // `interlocutor_timezone_set`: set_interlocutor_timezone persisted the
  // person's IANA zone into `pessoas.preferencias.timezone` (used by the prompt
  // temporal block + schedule_reminder). Self-scoped per-pessoa write.
  'interlocutor_timezone_set',
  // Spec 18 — Scheduling V2 (series → occurrence → task → outbox)
  'series_created',
  'series_cancelled',
  'series_cancelled_during_advance',
  'occurrence_scheduled',
  'occurrence_claimed',
  'occurrence_aged_skipped',
  'occurrence_completed',
  'occurrence_failed',
  'occurrence_cancelled',
  'occurrence_rejected_limit',
  'outbox_enqueued',
  'outbox_sent',
  'outbox_failed',
  'outbox_dead',
  'reminder_fired',
  'outreach_sent',
  'outreach_response_captured',
  'outreach_response_disambiguation_required',
  'outreach_response_dropped_no_match',
  'outreach_no_response',
  'payment_due_proposed',
  'payment_due_confirmed',
  'payment_due_skipped',
  'payment_due_postponed',
  'payment_due_unanswered',
  // Calendar v2
  'calendar_query',
  'manage_calendar',
  'capability_proposal_approved',
  'capability_proposal_rejected',
  // Issue #268 — channel resolver fail-loud: emitted when channel resolution
  // fails (legacy fallback removed). Surfaces previously-masked failures and
  // prevents cross-tenant rate-limit bucket collapse via default/default.
  'channel_resolution_failed',
  // `@lid` ingress fix — emitted by the Baileys ingress when a WhatsApp `@lid`
  // (Linked ID) event cannot be mapped to a real phone: `senderPn`/
  // `participantPn` were absent AND the signal LID mapping store missed. Split
  // from `channel_resolution_failed` so operators can alert on real cross-tenant
  // ownership misses / garbage JIDs WITHOUT the benign WhatsApp sync/peer noise
  // that arrives as unmapped `@lid`. The message is still DROPPED fail-closed —
  // this action is the canary for real `@lid` message loss as WhatsApp migrates
  // its addressing to LID. Triage detail lives in `metadata.resolver_details`.
  'channel_resolution_skipped_lid_unmapped',
  // Roteamento multi-linha (spec 2026-07-09 Draft v4 §1.2/§1.6/§2.5/§3.6):
  //  - shadow_divergence: modo shadow — o exact-match pela LINHA do bot
  //    divergiu do resultado legado (gate da fase 2→3 do rollout).
  //  - legacy_catch_all: modo exact_first — miss no exact e a resolução caiu
  //    no caminho legado (gate da fase 3→4: 7 dias sem esta ação).
  //  - channel_scope_mismatch: `forChannel` recusou um triplete inconsistente
  //    (canal não pertence ao tenant/agent ou inativo) — invariante 2.
  //  - line_session_transition: sessão de linha mudou de estado (connected/
  //    recovering/closed) — invariante 6.
  //  - pairing_session_*: ciclo §2.5 (declarado→verificado); `verified` ativa
  //    o canal; `failed` cobre mismatch de número, TTL e 23505 do índice
  //    global (linha já pertence a outro workspace).
  //  - message_update_channel_unresolved: em MAIA_MULTI_LINE, um
  //    messages.update chegou por uma sessão SEM canal resolvido (registro
  //    da primária pendente/falho) — o lote é DESCARTADO fail-closed em vez
  //    de cair no lookup global cross-tenant (review #498 crítico 1).
  'shadow_divergence',
  'legacy_catch_all',
  'channel_scope_mismatch',
  'line_session_transition',
  'pairing_session_started',
  'pairing_session_verified',
  'pairing_session_failed',
  'message_update_channel_unresolved',
  // Staging de inbound não-roteado (§1.4, modo strict): staged na chegada sem
  // rota; handed_off quando o replay entrega na pipeline normal (dedup por
  // canal); expired no TTL de 72h (sweeper).
  'inbound_staged',
  'inbound_unrouted_handed_off',
  'inbound_unrouted_expired',
  // Sonda sintética (spec 2026-07-17 §1.2): emitido quando o worker roda com a
  // flag on mas o modo de roteamento é `shadow` — o exact-match por linha não
  // resolve o canal da sonda, então o worker FALHA FECHADO (no-op) e NUNCA
  // ativa o canal (um canal ativo derrubaria o ingresso real).
  'synthetic_probe_prereq_unmet',
  // Ativação/desativação do canal de sonda (review P1-B): TODA mudança de
  // estado de roteamento/governança audita (metadata.active). Escrita sob o
  // contexto do tenant/agente da sonda.
  'synthetic_probe_channel_activation',
  // Issue #289 — emitted by scripts/embeddings-rebuild.ts when the embedding
  // provider returns a vector with the wrong dimension (or no vector at all)
  // for a row. We skip the UPDATE so the previous run's re-detection
  // predicate keeps the row pending for the next execution, and the audit
  // event makes the silent corruption visible to ops.
  'embeddings_rebuild_skip_invalid',
  // Issue #407 — per-agent AudienceContext resolution. `audience_resolved`:
  // a known pessoa with an ACTIVE per-agent audience profile → AudienceContext
  // built. `audience_blocked_no_profile`: known pessoa but NO audience profile
  // row for this agent → fail-closed (treated as quarantined).
  // `audience_quarantined`: pessoa HAS a profile but it is not `active`
  // (inactive/quarantined/blocked) → fail-closed. `audience_ambiguous`:
  // reserved for the multi-profile case (a #410+ concern; never emitted today
  // because the 1:1 unique guarantees at most one profile).
  'audience_resolved',
  'audience_blocked_no_profile',
  'audience_ambiguous',
  'audience_quarantined',
  // Issue #410 — baseline.core tools. Conservative capabilities every runtime
  // agent gets by default (no domain side effects). Each baseline tool audits
  // its own action label so the decision trail (invariant #4) records that the
  // agent understood context / asked / escalated / remembered a safe fact —
  // exactly the behaviours the baseline contract promises.
  // `turn_context_read`: read_turn_context inspected the current turn/scope.
  // `safe_fact_remembered`: remember_safe_fact persisted a policy-permitted
  // safe fact (side_effect=write, but only within the caller's own scope).
  // `confirmation_requested`: request_confirmation asked the human to confirm
  // (it never acts — LLM proposes, backend disposes, invariant #2).
  // `owner_handoff_requested`: handoff_to_owner raised an INTERNAL escalation
  // to the owner (NOT an arbitrary external send).
  // `decision_audited`: audit_decision recorded an explicit decision rationale.
  // `limitation_explained`: explain_limitation told the user what it cannot do.
  'turn_context_read',
  'safe_fact_remembered',
  'confirmation_requested',
  'owner_handoff_requested',
  'decision_audited',
  'limitation_explained',
  // Issue #408 — Runtime Tool Filter provenance. Emitted once per turn when the
  // backend computes the LLM-visible tool set, recording WHICH grant packs /
  // granted tools / denied tools / skill scope produced the visible set
  // (criterion: "auditoria registra quais grants/packs/skills produziram o
  // conjunto visível"). This is the visibility decision; the dispatcher still
  // audits an actual refused execution via `unauthorized_access_attempt`.
  'tool_visibility_resolved',
  // Issue #408 — dispatcher fail-closed defense. Emitted when the dispatcher
  // refuses a tool that is NOT in the agent's effective grant (a tool the LLM
  // should never have seen). Distinct from `unauthorized_access_attempt` (the
  // human-permission/constitutional refusal) so the audit trail tells "the
  // agent never had this tool" apart from "the person can't do this".
  'tool_not_granted',
  // Issue #409 — SkillUsagePolicy admission decisions (the FIRST runtime audit
  // of a skill DECISION, aligned with invariant #4 — audit every decision).
  // Emitted at BOTH enforcement points: the candidate filter (skill-selector,
  // early) and the execution gate (skill-runner gate 4.6, late). `skill_allowed`
  // records that a skill's usage policy admitted the resolved AudienceContext;
  // the `skill_blocked_by_*` actions record WHY a skill was removed/refused —
  // by audience, channel, data_scope, risk ceiling, or insufficient auth level.
  // These let the audit trail explain "the agent never offered this skill to
  // this audience" with the exact governing reason (the daily_business_summary
  // → customer block, the customer skill limited to own_customer_data_only, an
  // unauthorized channel, etc.).
  'skill_allowed',
  'skill_blocked_by_audience',
  'skill_blocked_by_channel',
  'skill_blocked_by_data_scope',
  'skill_blocked_by_risk',
  'skill_blocked_by_auth_level',
  // Issue #416 — boleto proposal vertical tools. Each domain tool audits its
  // own action label so the decision trail (invariant #4) records the read /
  // write / analysis the agent performed for the WhatsApp boleto-proposta role.
  // The three WRITE tools (boleto_cancelled / company_campaign_removed /
  // refund_created) flow through the dispatcher guard + `constitutionalCheck`
  // and are governed by `confirm_before_write_policy` (migration 078) — they do
  // NOT decide confirmation themselves (taxonomy §3/§6). The read/analysis tools
  // are conservative (no real external integration in this issue — handlers are
  // contract-honouring stubs per the "out of scope: real integrations" note).
  'company_identity_resolved',
  'company_searched',
  'company_history_looked_up',
  'company_blacklist_checked',
  'boleto_searched',
  'boleto_cancelled',
  'dda_looked_up',
  'payment_verified',
  'campaign_status_looked_up',
  'company_campaign_removed',
  'conversation_attachment_looked_up',
  'receipt_validated',
  'bank_account_validated',
  'refund_created',
  'refund_looked_up',
  'conversation_summary_generated',
  'legal_intent_detected',
  'case_risk_classified',
  'operational_ticket_created',
  // Issue #433 — baseline.core gap tools. Append-only. Each is auto-audited by
  // the dispatcher from the tool's `audit_action` (no hand-rolled audit()).
  // `risk_signal_classified`: risk_signal_classify scored the turn's risk
  //   (level + recommended action) via the shared scorer — a decision the trail
  //   should record (invariant #4), even though it is side-effect-free.
  // `conversation_summary_composed`: conversation_summary_compose produced a
  //   structured recap of the conversation (read-only).
  // `conversation_state_updated`: conversation_state_update merged a lightweight,
  //   self-scoped, non-gate patch into the conversation metadata (the one
  //   baseline write beyond remember_safe_fact).
  'risk_signal_classified',
  'conversation_summary_composed',
  'conversation_state_updated',
  // MCP externo (issue #478): registro/estado de servers, sync de tools,
  //   decisão por tool, concessão de pack por agente e cada chamada — todo o
  //   ciclo de vida de uma tool externa fica na trilha (invariante #4).
  'mcp_server_registered',
  'mcp_server_status_changed',
  'mcp_tools_synced',
  'mcp_tool_decided',
  'mcp_pack_grant_changed',
  'mcp_tool_call',
  // `objective_task_executed`: work-loop task processed by the
  //   objective_execute worker (issue #469) — records kind + transition so
  //   the trail shows every autonomous work unit (invariant #4).
  'objective_task_executed',
  // `playground_turn`: sandbox turn executed from the admin console
  //   (issue #464). Side-effect-free by contract (no outbox, no memory,
  //   no learning), but every sandbox interaction stays on the audit trail
  //   (invariant #4) — marked so forensics can separate test traffic.
  'playground_turn',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const ACTION_KEYS = [
  'read_balance',
  'read_transactions',
  'read_reports',
  'read_recurrences',
  'read_pending_questions',
  'read_audit',
  'create_transaction',
  'correct_transaction',
  'cancel_transaction',
  'schedule_reminder',
  'create_pessoa',
  'update_pessoa',
  'change_permission',
  'create_conta_bancaria',
  'update_conta_bancaria',
  'create_contraparte',
  'update_contraparte',
  'send_proactive_message',
  'activate_audit_mode',
  'deactivate_audit_mode',
  'emergency_lockdown',
  'emergency_unlock',
  'mark_rule_firm',
  'ban_rule',
  // Calendar v2
  'manage_calendar',
  // Codex review #105 round-2 (high): capability proposal management
  // (approve/reject) é genérico — vale para holiday, tool, knowledge,
  // procedure, integration, other. Separado de `manage_calendar` para
  // que `manage_calendar` em uma entidade NÃO autorize aprovação de
  // proposals tenant-level ou de entidades fora do escopo.
  'manage_capabilities',
  // Issue #410 — baseline.core action keys for the two baseline tools that
  // have a side effect beyond `none`/`read`.
  // `save_safe_fact`: granular permission for `remember_safe_fact` (write).
  //   Deliberately distinct from `create_transaction` / financial writes — a
  //   baseline agent may persist a SAFE fact about the conversation WITHOUT
  //   carrying any domain mutation grant.
  // `escalate_to_owner`: granular permission for `handoff_to_owner`
  //   (communication). This is an INTERNAL escalation to the agent's owner,
  //   NOT `send_proactive_message` (arbitrary external send) — kept separate so
  //   the baseline can grant escalation without granting external messaging.
  'save_safe_fact',
  'escalate_to_owner',
  // Issue #416 — boleto proposal vertical action keys. The three sensitive
  // WRITE tools each carry a GRANULAR permission key (distinct from the finance
  // `create_transaction` / `cancel_transaction` keys) so the boleto-proposta
  // role can be authorised for boleto/campaign/refund writes WITHOUT inheriting
  // generic financial-transaction grants. `canAct` checks these in the
  // dispatcher; `confirm_before_write_policy` (migration 078) composes on top.
  // Read/analysis boleto tools require no action key (universal reads, like the
  // baseline reads) — visibility is governed by pack grant + skill scope.
  'cancel_boleto',
  'remove_company_campaign',
  'create_refund',
  // `create_ticket`: granular permission for `operational_ticket_create`, an
  // INTERNAL escalation (side_effect 'communication', like handoff_to_owner — it
  // persists a ticket / hands off to a human queue). Kept distinct from the three
  // customer-facing writes so the role can open escalation tickets, and so it is
  // NOT captured by `confirm_before_write_policy` (scoped by tool name).
  'create_ticket',
] as const;

export type ActionKey = (typeof ACTION_KEYS)[number];
