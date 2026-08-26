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
  // Emitted by the pre-#520 `cloud_backup_rotation` worker. The worker was
  // replaced by `backup_retention` (manifest-driven, hold-aware, conclusive
  // outcome) in the #520 round-1 fix, so nothing emits these any more — they
  // stay in the enum because HISTORICAL audit rows carry them and the watcher
  // must keep resolving the label.
  'backup_cloud_rotation_completed',
  'backup_cloud_rotation_failed',
  'restore_test_passed',
  'restore_test_failed',
  // Issue #520 — backup/restore/retention verificáveis. As ações `backup_*`
  // legadas acima continuam existindo (a trilha histórica não é reescrita),
  // mas o lifecycle novo emite as ações abaixo, que distinguem o que o
  // baseline não distinguia: uma run que terminou COM cópia off-site
  // verificada (`backup_run_completed`) de uma que terminou local-only ou com
  // upload falhado (`backup_run_degraded`). O baseline auditava
  // `backup_completed` nos dois casos.
  //  - backup_run_started/completed/degraded/failed: ciclo de uma execução.
  //  - backup_artifact_verified: checksum conferido (local ou no destino).
  //  - backup_artifact_deleted: retenção removeu um artefato — ação
  //    destrutiva, registra política/escopo/contagem, nunca conteúdo.
  //  - restore_drill_*: drill automatizado; `completed` carrega a duração que
  //    alimenta o RTO medido. `unsafe_residue` é uma ação SEPARADA de `failed`
  //    de propósito: ela não diz "o backup não presta", diz "uma cópia completa
  //    da produção ficou no host e alguém precisa removê-la à mão" — duas
  //    remediações diferentes, e a segunda pode acontecer junto com um drill
  //    que provou o restore (issue #536, revisão da PR #541).
  //  - retention_run_*: passe de retenção (inclusive dry-run) por classe de
  //    dado e tenant.
  //  - legal_hold_created/released: §11 exige papel e auditoria append-only.
  //  - privacy_request_*: workflow LGPD. `denied` guarda CÓDIGO de motivo.
  //  - post_restore_reconciliation_*: gate anti-ressurreição do §13. `failed`
  //    significa que o runtime NÃO pode voltar a produção.
  'backup_run_started',
  'backup_run_completed',
  'backup_run_degraded',
  'backup_run_failed',
  'backup_artifact_verified',
  'backup_artifact_deleted',
  'restore_drill_started',
  'restore_drill_completed',
  'restore_drill_failed',
  'restore_drill_unsafe_residue',
  'retention_run_started',
  'retention_run_completed',
  'retention_run_failed',
  'legal_hold_created',
  'legal_hold_released',
  'legal_hold_blocked_purge',
  'privacy_request_created',
  'privacy_request_identity_verified',
  'privacy_request_approved',
  'privacy_request_completed',
  'privacy_request_denied',
  // Issue #536 §2 — `denied` e `failed` NÃO são a mesma coisa e conflatá-los
  // tornaria irrespondível a única pergunta que importa depois: "este pedido
  // foi RECUSADO por fundamento jurídico (hold ativo) ou QUEBROU no meio?".
  // A primeira é uma decisão defensável perante a ANPD; a segunda é um
  // incidente com dado possivelmente meio apagado.
  'privacy_request_failed',
  // Issue #536 (decisão do dono sobre o TTL do export). O prazo do export
  // deixou de ser só um carimbo em `export_expires_at` e passou a ter execução:
  // um varredor remove o `.enc` vencido. Remoção de arquivo é efeito colateral
  // irreversível, então cada uma tem linha própria — quem, quando, qual pedido,
  // qual locator, qual resultado.
  //  - privacy_export_purged: o artefato foi removido e a ausência foi
  //    PROVADA. `already_absent: true` distingue a retomada de um passe que
  //    caiu (arquivo já não estava lá) de uma remoção efetiva; as duas
  //    concluem o TTL, mas só a segunda destruiu bytes nesta execução.
  //  - privacy_export_purge_refused: o guarda de path/locator RECUSOU, ou a
  //    remoção não pôde ser confirmada. NADA foi apagado. É deliberadamente uma
  //    ação separada de `_purged`: "o TTL foi cumprido" e "um locator
  //    irreconhecível apareceu apontando para fora da árvore de exports" pedem
  //    remediações opostas, e conflatá-las esconderia a segunda dentro do
  //    volume normal da primeira.
  'privacy_export_purged',
  'privacy_export_purge_refused',
  'post_restore_reconciliation_completed',
  'post_restore_reconciliation_failed',
  'whatsapp_connected',
  'whatsapp_disconnected',
  // Disjuntor de LLM (issue #534). `opened`/`closed` são o PAR que a regra
  // `llm_circuit_long_open` do `src/workers/audit-watcher.ts` consome para
  // alertar "circuito aberto há mais de 5 min". Até a revisão da PR #541 as
  // duas ações existiam SEM produtor — o watcher era um consumidor de eventos
  // que ninguém emitia, e o alerta nunca podia disparar. O produtor é
  // `src/lib/llm/circuit-audit.ts`, chamado por `circuit-breaker.ts` em toda
  // transição para `open`/`closed`. Escritas no contexto sintético `system`
  // (ADR 0002): o estado mede uma dependência externa compartilhada, não dado
  // de tenant. `half_open` NÃO audita — é etapa interna da recuperação, não
  // mudança de postura observável, e auditá-la duplicaria o par sem
  // acrescentar decisão governável.
  'llm_circuit_opened',
  'llm_circuit_closed',
  // Kill switch do disjuntor (`src/lib/llm/circuit-mode.ts`). A objeção
  // original da #534 a um toggle de runtime era "alguém vira a chave às 3h da
  // manhã sem deixar rastro"; a resposta foi exigir `actor` + `reason` e
  // contar/logar todo uso. Log estruturado, porém, tem retenção curta e cai
  // junto com o coletor — mudança de POSTURA de um controle de degradação é
  // decisão de governança e pertence à trilha durável (invariante 4 do
  // `AGENTS.md`). Cada linha carrega actor, reason, modo e validade.
  //  - applied: override em vigor. `metadata.source='adopted'` distingue a
  //    adoção da chave durável no boot da réplica de uma virada ao vivo — é o
  //    MESMO desfecho de governança (a postura mudou), com procedência
  //    diferente, então é metadado e não ação separada.
  //  - cleared: operador devolveu a postura ao contrato.
  //  - expired: o arrendamento venceu sozinho e a postura voltou ao baseline.
  //  - rejected: override RECUSADO (anônimo, sem motivo, modo inválido,
  //    validade vencida/acima do teto). Auditar a recusa é o que separa
  //    "ninguém tentou" de "alguém tentou e o fail-closed segurou".
  'llm_circuit_mode_override_applied',
  'llm_circuit_mode_override_cleared',
  'llm_circuit_mode_override_expired',
  'llm_circuit_mode_override_rejected',
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
  // Issue #504 — ownership distribuído. A régua de "o que vira audit_log" é a
  // mesma de #503: só entra o que um humano precisa RECONSTRUIR depois. O claim
  // rotineiro e a renovação de lease NÃO entram (seriam uma row por batida, e a
  // pergunta que respondem já é respondida por `maia_turn_claim_total` /
  // `maia_turn_lease_heartbeat_total`). Entram as duas anomalias:
  //   - `turn_lease_lost`: alguém estava executando e PERDEU a posse. É o
  //     evento a partir do qual se explica "por que este turno rodou duas
  //     vezes?" ou "por que esta tentativa parou no meio?".
  //   - `turn_fence_rejected`: uma gravação chegou ao banco com token velho e
  //     foi RECUSADA. É a evidência de que o fence trabalhou — sem ela, o
  //     incidente aparece só como um turno que "não concluiu".
  // Nenhum dos dois carrega texto, prompt, telefone ou JID.
  'turn_lease_lost',
  'turn_fence_rejected',
  // Issue #504 §Contrato do job — o RESOLVEDOR de escopo do payload V2 recusou
  // um job. Vira audit_log (e não só métrica) porque é uma decisão de FRONTEIRA
  // de confiança: um turno que não rodou porque o par (tenant, agent) não pôde
  // ser reconciliado com a linha persistida. O caso `scope_mismatch` é a
  // evidência durável de um ponteiro turno->mensagem cruzando tenants, que é
  // exatamente o que a invariante nº 1 proíbe. A row carrega só o id do turno e
  // o motivo de vocabulário fechado — nada vindo do payload.
  'turn_job_scope_rejected',
  // Issue #505 (fases 1–2, shadow) — identidade de STREAM no ingresso. Dois
  // fatos, e só dois, entram em `audit_log`:
  //   - `stream_ingress_rejected`: a plataforma RECUSOU uma mensagem de usuário
  //     porque não soube a que conversa ela pertence. É a decisão governável por
  //     excelência — alguém escreveu e não foi atendido —, e é a evidência de que
  //     o sistema falhou FECHADO em vez de agrupar o ingresso numa stream
  //     genérica (a `default` que a invariante MUST nº 8 proíbe).
  //   - `stream_ingress_sequenced`: uma stream NASCEU (`ingress_seq = 1`). É o
  //     marco a partir do qual a ordem daquela conversa passa a existir, com a
  //     versão do algoritmo que a mintou. Ingressos subsequentes NÃO entram —
  //     seriam uma row por mensagem, e a reconstrução de
  //     `first_ingress_seq`/`last_ingress_seq` sai do log estruturado
  //     `stream.ingress_sequenced`, que é onde ela pertence.
  // Nenhuma das duas carrega texto, prompt, telefone ou JID: a `stream_key` é
  // um hash e o motivo tem vocabulário fechado.
  'stream_ingress_rejected',
  'stream_ingress_sequenced',
  // Issue #625 (fatia B da #505) — EXCLUSÃO de no máximo um turno ativo por
  // stream. Duas rows, e só duas, pela mesma régua de #503/#504: entra o que um
  // humano precisa RECONSTRUIR depois.
  //   - `turn_stream_busy`: o banco RECUSOU um segundo turno ativo da mesma
  //     conversa (`agent_turns_stream_active_uq`, migration 124). É a evidência
  //     durável de que a exclusão AGIU — sem ela, o incidente aparece só como
  //     "esta conversa parou", e "o índice barrou" e "ninguém reivindicou" são
  //     indistinguíveis, apesar de terem remediações opostas.
  //   - `turn_stream_claim_recovered`: um claim EXPIRADO da stream foi
  //     recuperado dentro da transação do claim (a metade temporal da
  //     exclusão). Vira audit porque o estado final — turno de volta em
  //     `retryable` — é IDÊNTICO ao que o varredor de recovery produz, e sem a
  //     row não há como saber que a stream chegou a ficar presa por um dono
  //     morto. Não é rotina: em operação saudável ela nunca aparece.
  // Nenhuma das duas carrega `stream_key`, texto, prompt, telefone ou JID —
  // só ids de turno e um motivo de vocabulário fechado.
  'turn_stream_busy',
  'turn_stream_claim_recovered',
  // Issue #626 (fatia C da #505) — HEAD-OF-LINE como condição do claim. Duas
  // rows, pela mesma régua, e elas dizem coisas de gravidade oposta:
  //   - `turn_stream_blocked`: o claim foi recusado porque existe turno
  //     ANTERIOR não terminal na conversa. É a ação `stream.blocked` que a
  //     issue-mãe pede na auditoria mínima, e é ROTINA saudável — a fila
  //     funcionando. O `metadata.reason` separa `not_head` ("o anterior avança
  //     sozinho; espere") de `stream_blocked` ("o anterior está no outbox e
  //     nenhum claim o move; vá ao runbook do outbox"), duas leituras com
  //     remediações opostas. `metadata.blocked_by_turn_id` é o que permite
  //     reconstruir a fila depois sem recorrer à `stream_key`.
  //   - `turn_stream_fifo_violation`: o canário do claim detectou que um turno
  //     foi reivindicado COM turno anterior vivo na stream — isto é, a ordem
  //     foi furada. NUNCA deveria aparecer: a issue-mãe lista
  //     `fifo_violation_total > 0` entre os critérios de ABORTAR o rollout, ao
  //     lado de violação de isolamento. Vira audit porque o contador agregado
  //     não diz QUAL turno furou nem quantos estavam na frente, e sem isso a
  //     investigação depois do incidente é impossível.
  // Nenhuma das duas carrega `stream_key`, texto, prompt, telefone ou JID.
  'turn_stream_blocked',
  'turn_stream_fifo_violation',
  // Issue #627 (fatia D da #505) — PROMOÇÃO do sucessor. Duas rows, e elas
  // respondem às duas perguntas que um incidente de ordem faz:
  //   - `turn_promoted`: a plataforma DECIDIU que este turno é quem avança, e
  //     sinalizou a fila. É a ação `stream.turn_promoted` da auditoria mínima da
  //     issue-mãe. Ela existe porque a decisão vive no BANCO e o sinal vive no
  //     Redis: sem a row, um job que aparece na fila não tem procedência, e
  //     "quem mandou este turno rodar?" só teria como resposta uma inferência.
  //     `metadata.source` separa os três produtores — conclusão terminal do
  //     predecessor, recuperação de claim expirado da stream, e reconciliação
  //     do varredor —, que têm leituras operacionais diferentes: o primeiro é
  //     rotina, o segundo diz que um worker morreu, o terceiro diz que um sinal
  //     se perdeu. `metadata.promoted_by_turn_id` reconstrói a fila sem
  //     recorrer à `stream_key`.
  //   - `turn_promotion_rejected`: uma tentativa STALE tentou concluir o turno
  //     e, com isso, liberar o sucessor — e foi recusada pelo fence. É a falha
  //     nº 9 da issue-mãe ("takeover após lease expirado permite ao worker
  //     antigo liberar o sucessor") registrada no momento em que ela NÃO
  //     acontece. Sem a row, um zumbi barrado e uma stream sem sucessor
  //     produziriam o mesmo silêncio.
  // Nenhuma das duas carrega `stream_key`, texto, prompt, telefone ou JID.
  'turn_promoted',
  'turn_promotion_rejected',
  // Issue #514: a MANDATORY runtime-trace envelope could not be written, so the
  // turn was aborted before any side effect and the job was failed for retry /
  // dead-letter. The audit row is the durable record that the platform refused
  // to act — the evidence write failed, so the trace itself cannot carry it.
  'runtime_trace_envelope_blocked_turn',
  // Issue #514: a replay reused an existing trace_id with DIVERGENT content.
  // Never expected; means an id collision or tampering.
  'runtime_trace_envelope_divergent_replay',
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
  // #636 (fatia A da épica #471) — a Maia PEDIU uma ferramenta que não existe.
  // Registra a decisão de gerar o pedido (nome proposto, ocorrências usadas,
  // quantas situações têm trace resolvido). NADA sobre instalação: o pedido é
  // um documento inerte, e o guardrail é que só humano implementa e instala.
  'tool_request_proposed',
  // #637 (fatia B da épica #471) — DOIS pedidos parecidos viraram UM.
  // `tool_request_aggregated` registra a fusão com o número que a justificou
  // (similaridade, limiar, métrica, versão da assinatura) e o estado em que o
  // contrato ficou; `tool_request_aggregate_detached` registra o desfazimento.
  // Um agrupamento automático sobre dado de governança sem o score que o
  // produziu é um fato sem prova — e sem o par de ações, desfazer seria
  // indistinguível de nunca ter agrupado.
  'tool_request_aggregated',
  'tool_request_aggregate_detached',
  // #638 (fatia C da épica #471) — a TRIAGEM. Cinco ações, e cada uma existe
  // porque o fato que ela registra é distinguível dos outros:
  //
  //   · `tool_request_accepted` — o dono decidiu abrir issue para o pedido. A
  //     linha diz o que foi aceito, com que chave de idempotência e para qual
  //     repositório, e declara `instalou_tool: false` / `concedeu_capability:
  //     false` — porque aceitar é criar uma issue, e nada mais.
  //   · `tool_request_accept_duplicado` — o segundo clique, que NÃO abriu uma
  //     segunda issue. É a prova de que a idempotência mordeu; sem ela, um
  //     aceite sem efeito seria indistinguível de um aceite que nunca chegou.
  //   · `tool_request_issue_created` — o efeito EXTERNO consumado, com o número
  //     da issue. `adopted:true` distingue "criei agora" de "reconheci pelo
  //     marcador uma issue que eu já tinha aberto antes de um crash".
  //   · `tool_request_issue_failed` — a chamada externa falhou de forma
  //     TERMINAL (credencial, permissão, destino inexistente). Falha
  //     recuperável NÃO gera ação: ela volta para a fila e auditá-la a cada
  //     tentativa transformaria a auditoria em log de retentativa.
  //   · `tool_request_gap_closed` / `tool_request_agent_notified` — o gap
  //     fechou porque a ferramenta EXISTE e ESTÁ CONCEDIDA (a evidência da
  //     verificação vai no metadata), e o agente foi avisado. São dois fatos e
  //     duas linhas: um gap pode fechar sem aviso novo (já havia um), e ler as
  //     duas juntas é o que permite auditar o laço inteiro da épica.
  'tool_request_accepted',
  'tool_request_accept_duplicado',
  'tool_request_issue_created',
  'tool_request_issue_failed',
  'tool_request_gap_closed',
  'tool_request_agent_notified',
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
  // Issue #518 — o pareamento passa a ser pedido pelo Admin AUTENTICADO. O
  // ator administrativo (`actor_id`/`actor_role`) e o `correlation_id` viajam
  // do console até estas ações, então uma linha pareada tem trilha ponta a
  // ponta. NUNCA carregam QR, código, token ou auth state em metadata.
  //  - channel_pairing_requested: o console enfileirou o comando.
  //  - pairing_session_aborted: o operador cancelou (idempotente).
  //  - pairing_session_expired: TTL estourou; ou o restart matou a tentativa
  //    em memória e ela foi para `failed/retryable` (nunca `verified`).
  //  - channel_disabled / channel_repair_requested: desativação e pedido de
  //    re-pareamento (recovery de linha) partindo do console.
  'channel_pairing_requested',
  'pairing_session_aborted',
  'pairing_session_expired',
  'channel_disabled',
  'channel_repair_requested',
  // Issue #518 §4 / review PR #528 — posse provada NÃO é permissão de rotear.
  //  - channel_activation_deferred: a linha foi VERIFICADA mas o canal segue
  //    inativo por readiness (sem política, ou papel padrão desativado).
  //  - channel_activated: o backend revalidou a readiness e ativou o
  //    roteamento — no fim do pareamento ou depois, quando a política ficou
  //    pronta.
  'channel_activation_deferred',
  'channel_activated',
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
  // Onboarding (issue #519) — as decisões de governança AGENTE-ESCOPADAS da
  // saga. A trilha administrativa completa (todo passo, todo ator, todo
  // correlation id) vai atomicamente para `admin_audit_log` dentro da mesma
  // transação do passo; estas três entram TAMBÉM em `audit_log` porque são
  // decisões sobre o AGENTE e pertencem à trilha do agente (invariante 4).
  // `agent_readiness_evaluated` registra o veredito canônico do backend (com
  // os fingerprints de configuração e schema); os dois de ativação registram
  // a decisão explícita de deixar — ou não deixar — o agente operar.
  'agent_readiness_evaluated',
  'agent_activation_approved',
  'agent_activation_denied',
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
