import cron, { type ScheduledTask } from 'node-cron';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { incCounter, setGaugeProvider, _internal as metricsInternal } from '@/lib/metrics.js';
import {
  DEFAULT_JOB_GROUPS,
  describeJob,
  getJobGroupSpec,
  JOB_GROUPS,
  parseJobGroups,
  validateJobRegistry,
  type JobContract,
  type JobGroup,
} from './job-contract.js';
import { runHealthMonitor } from './health-monitor.js';
import { runPendingExpirer } from './pending-expirer.js';
import { runIdempotencyCleanup } from './idempotency-cleanup.js';
import { runAuditModeExpirer } from './audit-mode-expirer.js';
import { runOnboardingExpirer } from './onboarding-expirer.js';
import { runInactivitySweep } from './inactivity-sweep.js';
import { runConversationSummarizer } from './conversation-summarizer.js';
import { runReflectionBatch } from './reflection-batch.js';
import { runPatternDetector } from './pattern-detector.js';
import { runMessageRecovery } from './message-recovery.js';
import { runStreamDebounceCloser } from './stream-debounce-closer.js';
import { runPendingReminder } from './pending-reminder.js';
import { runScheduling } from './scheduling-tick.js';
import { runOutboxDrainWorker } from './outbox-drain-worker.js';
import { runUnroutedRecovery } from './unrouted-recovery.js';
import { runSeriesNextSchedulerWorker } from './series-next-scheduler.js';
import { runNightlyBackup, runBackupRetention, runScheduledRestoreDrill } from './backup.js';
import { runPrivacyExportSweepJob } from './privacy.js';
import { runCostMonitor } from './cost-monitor.js';
import { runAuditWatcher } from './audit-watcher.js';
import { runDlqMonitor } from './dlq-monitor.js';
import { runMorningBriefing, runEveningBriefing, runWeeklyBriefing } from './briefings.js';
import { runLegacyMemoryReclassifier } from './legacy-memory-reclassifier.js';
import { runConfidenceRecompute } from './confidence-recompute.js';
import { runProcedureCandidateConsumer } from './procedure-candidate-consumer.js';
import { runProcedureExecutionReaper } from './procedure-execution-reaper.js';
import { runProcedureMetricsRefresh } from './procedure-metrics-refresh.js';
import { runDriftMonitor } from './drift-monitor.js';
import { runGapEscalationMonitor } from './gap-escalation-monitor.js';
import {
  runToolRequestIssueRelayer,
  runToolRequestClosureMonitor,
} from './tool-request-triage.js';
import { runTraceBodyWriter } from './trace-body-writer.js';
import { runTraceBodyRecoverer } from './trace-body-recoverer.js';
import { runTraceMatviewRefresh } from './trace-matview-refresh.js';
import { runKnowledgeStatePromoter } from './knowledge-state-promoter.js';
import { runOutboundMessagesSweeper } from './outbound-messages-sweeper.js';
import { runOutboundRecovery } from './outbound-recovery.js';
import { runIdempotencyOutboxRelayer } from './idempotency-outbox-relayer.js';
import { runWorkflowEngineTick } from './workflow-engine-tick.js';
import { runPlaygroundTurnWorker } from './playground-turn-worker.js';
import { runObjectiveExecuteWorker, runObjectivePerceiveWorker } from './objective-execute-worker.js';
import { runMcpSyncWorker } from './mcp-sync-worker.js';
import { runChannelPairingWorker } from './channel-pairing-worker.js';
import { runSyntheticProbe } from './synthetic-probe.js';

export type Job = JobContract & {
  /** O corpo do job. Sem argumento: todo estado vem do banco. */
  fn: () => Promise<void>;
};

/**
 * O REGISTRO — issue #513 §9.
 *
 * Cada linha declara, além do nome e da cadência:
 *
 *   - `group`  — o grupo operacional que liga/desliga o job. SUBSTITUI `phase`
 *                como mecanismo (o porquê está em `./job-contract.ts`);
 *   - `effect` — o que acontece se duas réplicas rodarem o mesmo tick;
 *   - `guard`  — o que impede que isso seja um problema;
 *   - `module` — onde o job vive. É o que liga a declaração ao código: o teste
 *                de arquitetura abre este arquivo e confere que o namespace de
 *                lock declarado EXISTE nele;
 *   - `phase`  — metadado histórico. Nada no runtime lê.
 *
 * `tests/unit/workers/job-contract.spec.ts` reprova um job novo que nasça sem
 * classificação, que declare lock inexistente, ou que tenha efeito externo não
 * idempotente sem claim.
 */
export const JOBS: Job[] = [
  // ─── monitoring ─────────────────────────────────────────────────────────
  {
    name: 'health_monitor',
    cron: '*/1 * * * *',
    fn: runHealthMonitor,
    group: 'monitoring',
    effect: 'idempotent',
    guard: {
      kind: 'none',
      why: 'o snapshot em `system_health_events` é APPEND-ONLY de observação e o alerta é throttled em memória. Duas réplicas produzem duas linhas de histórico e, no pior caso, dois alertas — ruído, nunca estado corrompido.',
    },
    module: 'health-monitor.ts',
    phase: 1,
  },
  {
    name: 'audit_watcher',
    cron: '*/1 * * * *',
    fn: runAuditWatcher,
    group: 'monitoring',
    effect: 'read-only',
    guard: {
      kind: 'none',
      why: 'só LÊ `audit_log` e emite alerta com throttle de 30min por regra. Não escreve nada.',
    },
    module: 'audit-watcher.ts',
    phase: 1,
  },
  {
    name: 'dlq_monitor',
    cron: '*/5 * * * *',
    fn: runDlqMonitor,
    group: 'monitoring',
    effect: 'idempotent',
    guard: {
      kind: 'none',
      why: 'lê a contagem de `dead_letter_jobs` e faz dedup do alerta por chave Redis com TTL de 1h — compartilhada entre réplicas, então o throttle vale para o cluster, não para o processo.',
    },
    module: 'dlq-monitor.ts',
    phase: 1,
  },
  {
    name: 'cost_monitor',
    cron: '30 2 * * *',
    fn: runCostMonitor,
    group: 'monitoring',
    effect: 'read-only',
    guard: {
      kind: 'none',
      why: 'lê o ledger de custo do dia anterior (já fechado) e alerta. Nenhuma escrita.',
    },
    module: 'cost-monitor.ts',
    phase: 1,
  },
  // P10b — runtime trace: 3 workers (body writer, body recoverer, matview refresh).
  {
    name: 'trace_body_writer',
    cron: '* * * * *',
    fn: runTraceBodyWriter,
    group: 'monitoring',
    effect: 'idempotent',
    guard: {
      kind: 'row-claim',
      claim:
        'FOR UPDATE SKIP LOCKED no outbox durável; a escrita do corpo é `INSERT ... ON CONFLICT (trace_id) DO NOTHING`',
      tables: ['runtime_trace_body_outbox', 'runtime_trace_bodies'],
    },
    module: 'trace-body-writer.ts',
    phase: 1,
  },
  {
    name: 'trace_body_recoverer',
    cron: '*/5 * * * *',
    fn: runTraceBodyRecoverer,
    group: 'monitoring',
    effect: 'idempotent',
    guard: {
      kind: 'row-claim',
      claim:
        'FOR UPDATE SKIP LOCKED sobre os envelopes pendentes; a marcação de `orphaned` é convergente',
      tables: ['runtime_trace_envelopes'],
    },
    module: 'trace-body-recoverer.ts',
    phase: 1,
  },
  {
    name: 'trace_matview_refresh',
    cron: '*/5 * * * *',
    fn: runTraceMatviewRefresh,
    group: 'monitoring',
    effect: 'idempotent',
    guard: {
      kind: 'none',
      why: '`REFRESH MATERIALIZED VIEW CONCURRENTLY` é idempotente e o próprio Postgres serializa refreshes concorrentes da mesma view.',
    },
    module: 'trace-matview-refresh.ts',
    phase: 1,
  },

  // ─── turn-pipeline ──────────────────────────────────────────────────────
  {
    name: 'pending_expirer',
    cron: '*/1 * * * *',
    fn: runPendingExpirer,
    group: 'turn-pipeline',
    effect: 'side-effectful',
    guard: { kind: 'none', why: '' },
    unguarded: {
      tracked_in: '#513',
      duplicates:
        '`expireDueDualApprovals()` faz `setStatus(id, "cancelado")` SEM compare-and-swap sobre o status anterior e, logo depois, MANDA WhatsApp ao solicitante. Duas réplicas de scheduler cancelam a mesma aprovação e enviam dois avisos de expiração. Fechar isto é o CAS no `setStatus` (ou single-flight por tenant) — fatia própria, porque muda `src/workflows/dual-approval.ts` e os specs de isolamento que o cercam.',
    },
    module: 'pending-expirer.ts',
    phase: 1,
  },
  {
    name: 'message_recovery',
    cron: '*/2 * * * *',
    fn: runMessageRecovery,
    group: 'turn-pipeline',
    effect: 'idempotent',
    guard: {
      kind: 'none',
      why: 'o worker não escreve: só re-enfileira com `jobId` derivado do `turn_id`, e a dedup da BullMQ colapsa dois `add` da mesma mensagem em um job.',
    },
    module: 'message-recovery.ts',
    phase: 1,
  },
  // Issue #628 (fatia E da #505) — o RELÓGIO DE PAREDE do debounce
  // transacional. O cron é 1/min, mas o tick DRENA por ~50s sondando a cada
  // 500ms, porque uma janela de debounce é de segundos e fechar só no tick
  // acrescentaria até 60s à resposta. Com a flag ligada, este worker é o único
  // caminho pelo qual uma rajada de texto vira turno executável — se ele não
  // roda, a conversa espera o recovery por estado (STUCK_AFTER_MS). No-op
  // barato com FEATURE_TURN_STREAM_DEBOUNCE (ou FEATURE_MESSAGE_DEBOUNCE)
  // desligada: nem consulta o banco.
  {
    name: 'stream_debounce_closer',
    cron: '* * * * *',
    fn: runStreamDebounceCloser,
    group: 'turn-pipeline',
    effect: 'side-effectful',
    guard: {
      kind: 'row-claim',
      claim:
        'compare-and-swap sob o mutex da stream (`closeDueDebounceBatchTx`, FOR UPDATE SKIP LOCKED) — a réplica perdedora recebe `stream_locked`, nunca um batch sobreposto',
      tables: ['agent_turn_streams'],
    },
    module: 'stream-debounce-closer.ts',
    phase: 1,
  },
  {
    name: 'pending_reminder',
    cron: '*/30 * * * *',
    fn: runPendingReminder,
    group: 'turn-pipeline',
    effect: 'side-effectful',
    guard: {
      kind: 'row-claim',
      claim:
        'CAS de `reminder_count` no WHERE do UPDATE, executado ANTES do envio: a réplica perdedora atualiza zero linhas e não envia',
      tables: ['pending_questions'],
    },
    module: 'pending-reminder.ts',
    phase: 1,
  },
  // Spec roteamento v4 §1.4 — recovery sweep do staging de inbound
  // não-roteado (modo strict): expira TTL, re-arma jobs órfãos (jobId
  // estável ⇒ idempotente) e vigia o keyring. No-op barato sem rows.
  {
    name: 'unrouted_recovery',
    cron: '* * * * *',
    fn: runUnroutedRecovery,
    group: 'turn-pipeline',
    effect: 'idempotent',
    guard: {
      kind: 'none',
      why: 'o re-arme usa `jobId` estável por row (dois `add` ⇒ um job) e a expiração é um UPDATE por corte de TTL, que converge.',
    },
    module: 'unrouted-recovery.ts',
    phase: 1,
  },
  // Issue #345 Batch D — o corpo inline foi EXTRAÍDO para
  // `./workflow-engine-tick.ts` e convertido de shim `default/default` em
  // dispatcher por tenant. A FORMA do job não mudou.
  {
    name: 'workflow_engine_tick',
    cron: '*/30 * * * * *',
    fn: runWorkflowEngineTick,
    group: 'turn-pipeline',
    effect: 'side-effectful',
    guard: { kind: 'none', why: '' },
    unguarded: {
      tracked_in: '#513',
      duplicates:
        '`tickEngine()` expira aprovações e NOTIFICA o solicitante por WhatsApp; a expiração legada compartilha `expireDueDualApprovals()` com `pending_expirer`, sem CAS. Duas réplicas — ou até este job e o `pending_expirer` no mesmo processo — produzem dois avisos de expiração para a mesma aprovação.',
    },
    module: 'workflow-engine-tick.ts',
    phase: 1,
  },
  {
    name: 'audit_mode_expirer',
    cron: '*/15 * * * *',
    fn: runAuditModeExpirer,
    group: 'turn-pipeline',
    effect: 'idempotent',
    guard: {
      kind: 'none',
      why: 'zera a preferência de audit-mode vencida; reexecutar sobre a mesma pessoa produz o mesmo estado final e nada sai do processo.',
    },
    module: 'audit-mode-expirer.ts',
    phase: 1,
  },

  // ─── scheduling (spec 18 §10) ───────────────────────────────────────────
  //  - scheduling_tick: por minuto, reivindica ocorrências vencidas e avança
  //    estado (reclama leases expiradas no mesmo passe);
  //  - outbox_drain: por minuto, drena o outbox sob backpressure;
  //  - series_next_scheduler: a cada 10min, faz backfill do próximo ciclo das
  //    séries cuja cadeia quebrou entre a conclusão e o re-agendamento.
  // Issue #355: as tabelas carregam tenant_id/agent_id e cada worker é um
  // DISPATCHER por (tenant, agent), fail-isolado.
  {
    name: 'scheduling_tick',
    cron: '* * * * *',
    fn: runScheduling,
    group: 'scheduling',
    effect: 'side-effectful',
    guard: {
      kind: 'row-claim',
      claim:
        'CTEs de claim com FOR UPDATE SKIP LOCKED nos repos de scheduling — duas instâncias nunca reivindicam a mesma ocorrência',
      tables: ['schedule_occurrences', 'schedule_tasks'],
    },
    module: 'scheduling-tick.ts',
    phase: 1,
  },
  {
    name: 'outbox_drain',
    cron: '* * * * *',
    fn: runOutboxDrainWorker,
    group: 'scheduling',
    effect: 'side-effectful',
    guard: {
      kind: 'row-claim',
      claim:
        '`claimDue` com FOR UPDATE SKIP LOCKED + lease por linha; o rate gate é por passe, não global',
      tables: ['outbox_messages'],
    },
    module: 'outbox-drain-worker.ts',
    phase: 1,
  },
  {
    name: 'series_next_scheduler',
    cron: '*/10 * * * *',
    fn: runSeriesNextSchedulerWorker,
    group: 'scheduling',
    effect: 'idempotent',
    guard: {
      kind: 'none',
      why: 'o backfill insere a próxima ocorrência sob dedup do repo (uma ocorrência por série+instante); dois passes concorrentes convergem para uma ocorrência.',
    },
    module: 'series-next-scheduler.ts',
    phase: 1,
  },

  // ─── channel ────────────────────────────────────────────────────────────
  // Issue #478 — MCP: executa test/sync pedidos pelo console (ponte
  // Postgres-as-queue por flags; só o runtime tem rede para os servers).
  // A FLAG é o gate real: com FEATURE_MCP_TOOLS off o worker é no-op na
  // primeira linha (nenhuma rede, nenhum secret).
  {
    name: 'mcp_sync',
    cron: '* * * * *',
    fn: runMcpSyncWorker,
    group: 'channel',
    effect: 'idempotent',
    guard: {
      kind: 'none',
      why: 'reconciliação por hash de schema: duas execuções chegam ao mesmo conjunto de tools e à mesma decisão de suspensão. A marca `last_sync_at`/`last_test_at` é o corte, não um claim — o custo de um passe duplicado é uma chamada a mais ao server MCP.',
    },
    module: 'mcp-sync-worker.ts',
    phase: 1,
  },
  // Issue #518 — ponte Admin→runtime do pareamento de linhas WhatsApp. O
  // console só tem Postgres; o socket Baileys vive aqui. Cadência de 5s
  // porque o operador está OLHANDO a tela esperando o QR — um cron de 1min
  // tornaria o fluxo inutilizável. O custo em repouso é um probe em índice
  // parcial (`WHERE command IS NOT NULL`), que não retorna nada sem operador
  // agindo.
  {
    name: 'channel_pairing',
    cron: '*/5 * * * * *',
    fn: runChannelPairingWorker,
    group: 'channel',
    effect: 'side-effectful',
    guard: {
      kind: 'row-claim',
      claim:
        'o comando é reivindicado com FOR UPDATE SKIP LOCKED e o `owner_instance` fica gravado na linha — uma sessão de pareamento por canal',
      tables: ['channel_line_state'],
    },
    module: 'channel-pairing-worker.ts',
    phase: 1,
  },
  // Sonda sintética (spec 2026-07-17 §1.1). NO-OP com MAIA_SYNTHETIC_PROBE=false
  // (default) — a flag, não o grupo, é o gate de comportamento. Cadência
  // configurável (default */10). Sob shadow o worker falha fechado (no-op +
  // audit); só age em exact_first/strict com o canal de sonda pareado (§1.2).
  {
    name: 'synthetic_probe',
    cron: config.MAIA_PROBE_CRON,
    fn: runSyntheticProbe,
    group: 'channel',
    effect: 'side-effectful',
    guard: {
      kind: 'row-claim',
      claim:
        'single-flight por lease na linha do run (claim + auto-silêncio por backoff após N falhas, §1.5/§5)',
      tables: ['synthetic_probe_runs'],
    },
    module: 'synthetic-probe.ts',
    phase: 1,
  },

  // ─── outbound ───────────────────────────────────────────────────────────
  // Issue #292 — sweeper do ledger LEGADO (rows sem `turn_id`). Cadência
  // ~5min: o corte de stale-pending é de 5min, então rodar a cada 5min dá
  // detecção em <=10min de qualquer pending órfã.
  {
    name: 'outbound_messages_sweeper',
    cron: '*/5 * * * *',
    fn: runOutboundMessagesSweeper,
    group: 'outbound',
    effect: 'side-effectful',
    guard: { kind: 'global-singleton', lock: 'OUTBOUND_SWEEPER_LOCK_NAMESPACE' },
    module: 'outbound-messages-sweeper.ts',
    phase: 1,
  },
  // Issue #633 (fatia D da #506) — varredura de recuperação do OUTBOX DURÁVEL.
  // Distinto do sweeper acima, que é o housekeeping do ledger legado.
  // Cadência de 1 min e não de 5: aqui o que se recupera é uma RESPOSTA ao
  // usuário, e o SLI é a latência percebida. A FLAG é o gate real: com
  // FEATURE_OUTBOUND_RECOVERY off ele é no-op na PRIMEIRA linha.
  {
    name: 'outbound_recovery',
    cron: '* * * * *',
    fn: runOutboundRecovery,
    group: 'outbound',
    effect: 'side-effectful',
    guard: {
      kind: 'row-claim',
      claim:
        'toda mutação é `UPDATE ... WHERE status = <origem esperada>` (CAS) e o rearme usa `jobId` determinístico; a entrega é protegida pelo claim com lease de #632 — DELIBERADAMENTE sem lock global, que custaria disponibilidade justo à recuperação',
      tables: ['outbound_messages'],
    },
    module: 'outbound-recovery.ts',
    phase: 1,
  },
  // Issue #316 — transactional effect outbox relayer. Despacha efeitos
  // externos NÃO IDEMPOTENTES (ex.: envios WhatsApp) registrados atomicamente
  // com a reserva de idempotência vencedora, EXATAMENTE UMA VEZ, com
  // retry/backoff. Sem feature flag: é o único caminho de despacho desses
  // efeitos (a tool não envia mais inline), então tem que rodar sempre.
  {
    name: 'idempotency_outbox_relayer',
    cron: '*/1 * * * *',
    fn: runIdempotencyOutboxRelayer,
    group: 'outbound',
    effect: 'side-effectful',
    guard: { kind: 'global-singleton', lock: 'OUTBOX_RELAYER_LOCK_NAMESPACE' },
    module: 'idempotency-outbox-relayer.ts',
    phase: 1,
  },

  // ─── housekeeping ───────────────────────────────────────────────────────
  // Issue #519 — housekeeping da saga de onboarding: marca `cancelled`
  // (`last_error_code='expired'`) as runs cujo `expires_at` passou e que ainda
  // não são terminais. Varredura GLOBAL sob contexto `system` (a run pode nem
  // ter tenant ainda), em lotes por tick.
  {
    name: 'onboarding_expirer',
    cron: '*/5 * * * *',
    fn: runOnboardingExpirer,
    group: 'housekeeping',
    effect: 'idempotent',
    guard: {
      kind: 'none',
      why: 'o UPDATE é condicionado a `expires_at` vencido E estado não terminal, então a segunda réplica não encontra linha; ver o cabeçalho de `onboarding-expirer.ts` para o porquê de não haver single-flight.',
    },
    module: 'onboarding-expirer.ts',
    phase: 1,
  },
  {
    name: 'idempotency_cleanup',
    cron: '0 4 * * *',
    fn: runIdempotencyCleanup,
    group: 'housekeeping',
    effect: 'idempotent',
    guard: {
      kind: 'none',
      why: 'DELETE por corte de idade sobre `idempotency_keys`; duas execuções apagam o mesmo conjunto e a segunda volta zero linhas.',
    },
    module: 'idempotency-cleanup.ts',
    phase: 1,
  },
  {
    name: 'inactivity_sweep',
    cron: '0 3 * * *',
    fn: runInactivitySweep,
    group: 'housekeeping',
    effect: 'side-effectful',
    guard: {
      kind: 'row-claim',
      claim:
        "um único `UPDATE ... WHERE status = 'ativa' ... RETURNING` por tenant: a réplica perdedora recebe zero linhas e não audita nada",
      tables: ['permissoes'],
    },
    module: 'inactivity-sweep.ts',
    phase: 1,
  },

  // ─── ops-backup ─────────────────────────────────────────────────────────
  {
    name: 'nightly_backup',
    cron: '0 3 * * *',
    fn: runNightlyBackup,
    group: 'ops-backup',
    effect: 'side-effectful',
    guard: { kind: 'global-singleton', lock: 'OPS_LOCK_KEYS.backup_run' },
    module: 'backup.ts',
    phase: 1,
  },
  // Retenção de artefatos: domingo 04:00 BRT, desacoplada do run noturno para
  // que o caminho de upload continue rápido e a retenção possa ser pausada
  // sozinha. Planeja toda deleção a partir do manifesto, avalia legal hold sob
  // lock e cobre os dois destinos. Não apaga nada com RETENTION_DRY_RUN=true.
  {
    name: 'backup_retention',
    cron: '0 4 * * 0',
    fn: runBackupRetention,
    group: 'ops-backup',
    effect: 'side-effectful',
    guard: { kind: 'global-singleton', lock: 'OPS_LOCK_KEYS.retention_run' },
    module: 'backup.ts',
    phase: 1,
  },
  // Issue #536 — o TTL do export de privacidade, executado.
  //
  // HORÁRIO e não diário: o prazo é de dias, mas a granularidade da varredura é
  // a JANELA DE EXPOSIÇÃO de um pacote cifrado com o dado consolidado de um
  // titular já vencido. Com um passe diário essa janela chega a 24h; com um
  // horário, a uma.
  //
  // No minuto 50 de propósito: longe do :00 (onde `nightly_backup`,
  // `inactivity_sweep` e a maioria dos cron de hora cheia se acumulam) e longe
  // do :40 do `restore_drill`, que é o único outro job que pode segurar um lock
  // de ops por muito tempo.
  {
    name: 'privacy_export_sweep',
    cron: '50 * * * *',
    fn: runPrivacyExportSweepJob,
    group: 'ops-backup',
    effect: 'side-effectful',
    guard: { kind: 'global-singleton', lock: 'OPS_LOCK_KEYS.privacy_export_sweep' },
    module: 'privacy.ts',
    phase: 1,
  },
  // Issue #536 — o GATE do drill de restore. `BACKUP_RESTORE_DRILL_INTERVAL_HOURS`
  // é a IDADE MÁXIMA ACEITÁVEL DA EVIDÊNCIA, não um agendamento: por isso a
  // cadência aqui é um TICK fixo de hora em hora e não um cron derivado do
  // intervalo. O tick lê `restore_drills`, e só dispara um drill quando a
  // evidência está perto de vencer (75% do intervalo) ou nunca existiu.
  // Esta cadência de 1h é um dos três parâmetros do piso que o boot exige
  // (`backup/drill-interval-feasible`, `src/config/rules.ts`): com os timeouts
  // default o intervalo mínimo honrável é 10h, e abaixo disso o processo NÃO
  // SOBE — mudar este cron muda aquele piso.
  {
    name: 'restore_drill',
    cron: '40 * * * *',
    fn: runScheduledRestoreDrill,
    group: 'ops-backup',
    effect: 'side-effectful',
    guard: { kind: 'global-singleton', lock: 'OPS_LOCK_KEYS.restore_drill' },
    module: 'backup.ts',
    phase: 1,
  },

  // ─── console (grupo DESLIGADO por default) ──────────────────────────────
  // Issue #464 — sandbox chat do admin-console: drena `playground_turns`
  // (Postgres-as-queue) dentro do tick por ~50s, então a latência efetiva do
  // chat é de segundos apesar do cron de 1min.
  {
    name: 'playground_turn_drain',
    cron: '* * * * *',
    fn: runPlaygroundTurnWorker,
    group: 'console',
    effect: 'side-effectful',
    guard: {
      kind: 'row-claim',
      claim:
        '`claimNextQueuedTurn` com FOR UPDATE SKIP LOCKED; invocações sobrepostas ficam disjuntas por construção',
      tables: ['playground_turns'],
    },
    module: 'playground-turn-worker.ts',
    phase: 2,
  },
  // Issue #469 — work loop: percebe trabalho (perceptores por kind, 5min)
  // e executa tarefas pendentes (drain ~50s/tick).
  {
    name: 'objective_perceive',
    cron: '*/5 * * * *',
    fn: runObjectivePerceiveWorker,
    group: 'console',
    effect: 'idempotent',
    guard: {
      kind: 'none',
      why: 'o perceptor grava por `upsertTask` chaveado em `natural_key`: duas passagens produzem a MESMA tarefa, não duas.',
    },
    module: 'objective-execute-worker.ts',
    phase: 2,
  },
  {
    name: 'objective_execute',
    cron: '* * * * *',
    fn: runObjectiveExecuteWorker,
    group: 'console',
    effect: 'side-effectful',
    guard: {
      kind: 'row-claim',
      claim:
        'claim de `objective_tasks` com FOR UPDATE SKIP LOCKED; falha de executor vira `failed` com detalhe, nunca `running` preso',
      tables: ['objective_tasks'],
    },
    module: 'objective-execute-worker.ts',
    phase: 2,
  },

  // ─── cognition (grupo DESLIGADO por default) ────────────────────────────
  {
    name: 'conversation_summarizer',
    cron: '0 2 * * *',
    fn: runConversationSummarizer,
    group: 'cognition',
    effect: 'side-effectful',
    guard: { kind: 'none', why: '' },
    unguarded: {
      tracked_in: '#513',
      duplicates:
        'a sumarização chama o LLM e persiste candidato cognitivo por (tenant, agent) sem lock. Duas réplicas pagam o turno duas vezes e criam dois candidatos para a mesma conversa. O padrão a copiar é o `reflection_batch` logo abaixo, que já tem advisory lock por tenant.',
    },
    module: 'conversation-summarizer.ts',
    phase: 2,
  },
  {
    name: 'reflection_batch',
    cron: '0 2 * * *',
    fn: runReflectionBatch,
    group: 'cognition',
    effect: 'side-effectful',
    guard: { kind: 'per-tenant-singleton', lock: 'REFLECTION_BATCH_LOCK_NAMESPACE' },
    module: 'reflection-batch.ts',
    phase: 2,
  },
  {
    name: 'pattern_detector',
    cron: '0 4 * * *',
    fn: runPatternDetector,
    group: 'cognition',
    effect: 'side-effectful',
    guard: { kind: 'none', why: '' },
    unguarded: {
      tracked_in: '#513',
      duplicates:
        'roda LLM sobre o `audit_log` e persiste candidato cognitivo por (tenant, agent) sem lock — dois candidatos idênticos e custo dobrado com duas réplicas.',
    },
    module: 'pattern-detector.ts',
    phase: 2,
  },
  {
    name: 'legacy_memory_reclassifier',
    cron: '0 3 * * *',
    fn: runLegacyMemoryReclassifier,
    group: 'cognition',
    effect: 'side-effectful',
    guard: { kind: 'none', why: '' },
    unguarded: {
      tracked_in: '#513',
      duplicates:
        'classifica memória por LLM e deriva hint comportamental. O UPDATE final converge, mas a chamada ao LLM e a derivação do hint acontecem duas vezes por linha com duas réplicas.',
    },
    module: 'legacy-memory-reclassifier.ts',
    phase: 2,
  },
  {
    name: 'confidence_recompute',
    cron: '30 3 * * *',
    fn: runConfidenceRecompute,
    group: 'cognition',
    effect: 'idempotent',
    guard: {
      kind: 'none',
      why: 'a confiança é uma FUNÇÃO determinística do estado (`computeConfidence`), e o UPDATE só dispara com |novo - atual| > 0.005. Duas réplicas escrevem o mesmo valor.',
    },
    module: 'confidence-recompute.ts',
    phase: 2,
  },
  {
    name: 'procedure_candidate_consumer',
    cron: '0 2 * * *',
    fn: runProcedureCandidateConsumer,
    group: 'cognition',
    effect: 'side-effectful',
    guard: { kind: 'none', why: '' },
    unguarded: {
      tracked_in: '#513',
      duplicates:
        'consome `cognitive_candidates` sem claim e gera draft em `procedure_definitions` — duas réplicas produzem dois drafts do mesmo candidato.',
    },
    module: 'procedure-candidate-consumer.ts',
    phase: 2,
  },
  // P10a — knowledge state auto-promoter (de hora em hora; amadurece
  // ephemeral→observed→reinforced→verified→active por evidence_count + idade,
  // e expira linhas paradas para deprecated).
  {
    name: 'knowledge_state_promoter',
    cron: '0 * * * *',
    fn: runKnowledgeStatePromoter,
    group: 'cognition',
    effect: 'side-effectful',
    guard: { kind: 'none', why: '' },
    unguarded: {
      tracked_in: '#513',
      duplicates:
        'cada transição de estado é validada e ESCREVE uma linha em `lifecycle_transitions` (de propósito: a trilha é o produto). Sem claim, duas réplicas registram a mesma transição duas vezes e a trilha passa a contar o dobro de evidência.',
    },
    module: 'knowledge-state-promoter.ts',
    phase: 2,
  },

  // ─── procedures (grupo DESLIGADO por default) ───────────────────────────
  {
    name: 'procedure_execution_reaper',
    cron: '0 * * * *',
    fn: runProcedureExecutionReaper,
    group: 'procedures',
    effect: 'side-effectful',
    guard: {
      kind: 'row-claim',
      claim:
        "UPDATE condicionado a `status = 'in_progress'` E `last_activity_at` vencida, dentro de transação — CAS: a réplica perdedora não abandona nada",
      tables: ['procedure_executions'],
    },
    module: 'procedure-execution-reaper.ts',
    phase: 3,
  },
  {
    name: 'procedure_metrics_refresh',
    cron: '*/15 * * * *',
    fn: runProcedureMetricsRefresh,
    group: 'procedures',
    effect: 'idempotent',
    guard: {
      kind: 'none',
      why: '`REFRESH MATERIALIZED VIEW CONCURRENTLY procedure_metrics` — idempotente, e o Postgres serializa refreshes concorrentes da mesma view.',
    },
    module: 'procedure-metrics-refresh.ts',
    phase: 3,
  },

  // ─── proactive (grupo DESLIGADO por default — ESCREVEM PARA O USUÁRIO) ───
  {
    name: 'briefing_morning',
    cron: '0 8 * * *',
    fn: runMorningBriefing,
    group: 'proactive',
    effect: 'side-effectful',
    guard: { kind: 'none', why: '' },
    unguarded: {
      tracked_in: '#513',
      duplicates:
        'MANDA WhatsApp para todos os donos do tenant, sem claim e sem marca de "já enviei hoje". Duas réplicas de scheduler mandam dois bom-dia. É o caso mais visível da lacuna, e o motivo de o grupo `proactive` nascer desligado.',
    },
    module: 'briefings.ts',
    phase: 4,
  },
  {
    name: 'briefing_evening',
    cron: '0 21 * * *',
    fn: runEveningBriefing,
    group: 'proactive',
    effect: 'side-effectful',
    guard: { kind: 'none', why: '' },
    unguarded: {
      tracked_in: '#513',
      duplicates: 'idem `briefing_morning`: envio proativo ao dono sem claim nem marca de envio.',
    },
    module: 'briefings.ts',
    phase: 4,
  },
  {
    name: 'briefing_weekly',
    cron: '0 8 * * 1',
    fn: runWeeklyBriefing,
    group: 'proactive',
    effect: 'side-effectful',
    guard: { kind: 'none', why: '' },
    unguarded: {
      tracked_in: '#513',
      duplicates: 'idem `briefing_morning`: envio proativo ao dono sem claim nem marca de envio.',
    },
    module: 'briefings.ts',
    phase: 4,
  },
  // P4 Task 10 — drift monitor semanal (domingo 03:00 BRT).
  {
    name: 'drift_monitor',
    cron: '0 3 * * 0',
    fn: runDriftMonitor,
    group: 'proactive',
    effect: 'side-effectful',
    guard: { kind: 'none', why: '' },
    unguarded: {
      tracked_in: '#513',
      duplicates:
        '`decideAndApply` aplica decisões de drift sobre o perfil operacional ativo e audita cada uma. Sem lock por (tenant, agent), duas réplicas aplicam a mesma decisão duas vezes e a trilha de auditoria conta dois eventos para um.',
    },
    module: 'drift-monitor.ts',
    phase: 4,
  },

  // ─── governance (grupo DESLIGADO por default) ───────────────────────────
  // P5 Task 9 — gap escalation monitor (a cada 30min).
  {
    name: 'gap_escalation_monitor',
    cron: '*/30 * * * *',
    fn: runGapEscalationMonitor,
    group: 'governance',
    effect: 'side-effectful',
    guard: { kind: 'none', why: '' },
    unguarded: {
      tracked_in: '#513',
      duplicates:
        '`updateLevel` não é CAS sobre o nível anterior e a transição para `proposed` dispara `proposeCapabilityForGap` (LLM) em fire-and-forget. Duas réplicas geram duas propostas para o mesmo gap.',
    },
    module: 'gap-escalation-monitor.ts',
    phase: 5,
  },
  // #638 (fatia C da épica #471) — a metade de backend da triagem de pedidos de
  // ferramenta. O relayer roda de 5 em 5 minutos porque ele é o que o dono está
  // esperando depois de clicar em "aceitar"; o monitor de fechamento roda de
  // hora em hora porque o fato que ele observa (uma tool nova concedida a um
  // agente) muda em escala de deploy, não de segundo.
  {
    name: 'tool_request_issue_relayer',
    cron: '*/5 * * * *',
    fn: async () => {
      await runToolRequestIssueRelayer();
    },
    group: 'governance',
    effect: 'side-effectful',
    guard: { kind: 'none', why: '' },
    unguarded: {
      tracked_in: '#513',
      duplicates:
        'ABRE ISSUE NO GITHUB. `garantirIssue` procura pelo marcador de `idempotency_key` antes de criar, o que torna uma SEGUNDA PASSADA convergente (ela adota a issue existente) — mas duas réplicas no MESMO instante buscam antes de qualquer uma criar, e abrem duas issues. A janela é pequena e a lacuna é real.',
    },
    module: 'tool-request-triage.ts',
    phase: 5,
  },
  {
    name: 'tool_request_closure_monitor',
    cron: '7 * * * *',
    fn: async () => {
      await runToolRequestClosureMonitor();
    },
    group: 'governance',
    effect: 'side-effectful',
    guard: { kind: 'none', why: '' },
    unguarded: {
      tracked_in: '#513',
      duplicates:
        'fecha o gap cuja ferramenta passou a existir e AVISA o agente. Sem CAS sobre o estado do gap, duas réplicas fecham o mesmo gap e emitem dois avisos.',
    },
    module: 'tool-request-triage.ts',
    phase: 5,
  },
];

const tasks: ScheduledTask[] = [];

/**
 * Cron drain state — issue #512 §6.
 *
 * `stopWorkers()` used to be a synchronous `task.stop()` loop: it prevented
 * FUTURE ticks but returned immediately, so `gracefulShutdown()` went on to
 * close the Redis and Postgres pools underneath a cron run that was still
 * executing. A nightly backup, an outbox drain or a scheduling tick would then
 * die mid-write against a closed pool.
 *
 * We now track every in-flight run so the drain can await it within a deadline
 * and REPORT what did not finish, and we refuse to overlap a job with itself.
 */
const inflight = new Map<string, Promise<void>>();
let acceptingTicks = true;
/** Jobs whose gauges are already registered (bounded by JOBS.length). */
const gaugesRegistered = new Set<string>();
const lastSuccessAt = new Map<string, number>();
const lastFailureAt = new Map<string, number>();

function registerWorkerGauges(name: string): void {
  if (gaugesRegistered.has(name)) return;
  gaugesRegistered.add(name);
  setGaugeProvider(metricsInternal.key('maia_worker_active_jobs', { worker: name }), () =>
    inflight.has(name) ? 1 : 0,
  );
  setGaugeProvider(metricsInternal.key('maia_worker_last_success_timestamp', { worker: name }), () =>
    Math.floor((lastSuccessAt.get(name) ?? 0) / 1000),
  );
  setGaugeProvider(metricsInternal.key('maia_worker_last_failure_timestamp', { worker: name }), () =>
    Math.floor((lastFailureAt.get(name) ?? 0) / 1000),
  );
  // Issue #513 §Observabilidade — `maia_scheduler_job_lag_seconds{job}`.
  //
  // LAG aqui é a IDADE DO ÚLTIMO SUCESSO, e não "atraso em relação ao horário
  // agendado". O node-cron não entrega o instante teórico do tick, então
  // qualquer número derivado dele seria inventado; a idade do último sucesso é
  // medida, é a pergunta que o operador realmente faz ("esse job ainda está
  // vivo?") e cresce sozinha quando o job para de rodar — inclusive quando
  // para porque o GRUPO dele foi desligado. Antes do primeiro sucesso o valor
  // é a idade do processo, não zero: um job que nunca completou não deve
  // parecer recém-executado.
  const startedAt = Date.now();
  setGaugeProvider(metricsInternal.key('maia_scheduler_job_lag_seconds', { job: name }), () => {
    const last = lastSuccessAt.get(name) ?? startedAt;
    return Math.max(0, Math.floor((Date.now() - last) / 1000));
  });
}

function runTick(job: Job): void {
  // No new work once the drain started (issue #512: "Nenhum novo side effect
  // começa após draining").
  if (!acceptingTicks) return;
  // Self-overlap guard: a job whose previous run is still active is SKIPPED,
  // not queued. Every long-running job here (outbox drain, playground drain,
  // objective execute) is already single-flight via a DB lease, so a skipped
  // tick is strictly better than two racing runs.
  if (inflight.has(job.name)) {
    incCounter('maia_worker_tick_skipped_total', { worker: job.name, reason: 'overlap' });
    incCounter('maia_scheduler_job_total', { job: job.name, result: 'skipped_overlap' });
    logger.warn({ job: job.name }, 'worker.tick_skipped_overlap');
    return;
  }
  registerWorkerGauges(job.name);
  const p = job
    .fn()
    .then(() => {
      lastSuccessAt.set(job.name, Date.now());
      incCounter('maia_scheduler_job_total', { job: job.name, result: 'ok' });
    })
    .catch((err) => {
      lastFailureAt.set(job.name, Date.now());
      incCounter('maia_scheduler_job_total', { job: job.name, result: 'failed' });
      logger.error({ err, job: job.name }, 'worker.failed');
    })
    .finally(() => {
      inflight.delete(job.name);
    });
  inflight.set(job.name, p);
}

/**
 * O que o boot precisa DIZER sobre o scheduler — issue #513, critério "o boot
 * lista role e componentes/jobs ativos".
 */
export type SchedulerInventory = {
  readonly groups_enabled: readonly JobGroup[];
  readonly groups_disabled: readonly JobGroup[];
  /** Nomes dos jobs agendados, na ordem do registro. */
  readonly scheduled: readonly string[];
  /** Nomes dos jobs que NÃO foram agendados, por grupo desligado. */
  readonly skipped: readonly string[];
  /**
   * Jobs HABILITADOS que têm efeito não idempotente sem single-flight nem
   * claim (`unguarded`). São exatamente os que duplicam efeito quando o
   * scheduler roda em mais de uma réplica — por isso saem no boot como AVISO,
   * e não como uma linha de debug.
   */
  readonly unguarded_enabled: readonly string[];
};

export type StartWorkersOptions = {
  /**
   * Grupos a agendar. Default: `MAIA_SCHEDULER_GROUPS` (e, na ausência dela,
   * `DEFAULT_JOB_GROUPS` — o conjunto que reproduz exatamente o antigo
   * `startWorkers(1)`).
   */
  readonly groups?: readonly JobGroup[];
};

/**
 * Agenda os jobs dos grupos habilitados e devolve o INVENTÁRIO do que subiu.
 *
 * A assinatura antiga era `startWorkers(currentPhase = 1)`, e o único call site
 * de produção passava `1`. Isso fazia de `phase` um interruptor global e
 * invisível: 16 jobs registrados nunca eram agendados, e a única forma de
 * descobrir isso era ler o `continue`. Agora o que decide é uma lista de
 * grupos declarada, e o boot IMPRIME os dois lados dela.
 */
export function startWorkers(opts: StartWorkersOptions = {}): SchedulerInventory {
  acceptingTicks = true;

  // Fail-closed: um registro inválido (job sem classificação, lock duplicado,
  // efeito não idempotente sem claim) para o boot aqui, e não em produção às
  // 3h da manhã. O `validateJobRegistry` é o mesmo que o teste de arquitetura
  // roda — a diferença é só quando.
  const violations = validateJobRegistry(JOBS);
  if (violations.length > 0) {
    const detail = violations.map((v) => `${v.job}: ${v.rule} — ${v.detail}`).join('; ');
    throw new Error(`scheduler job registry inválido (issue #513 §9): ${detail}`);
  }

  const enabled = opts.groups ?? parseJobGroups(config.MAIA_SCHEDULER_GROUPS);
  const enabledSet = new Set<JobGroup>(enabled);
  const scheduled: string[] = [];
  const skipped: string[] = [];
  const unguarded_enabled: string[] = [];

  for (const job of JOBS) {
    if (!enabledSet.has(job.group)) {
      skipped.push(job.name);
      continue;
    }
    const t = cron.schedule(job.cron, () => runTick(job), { timezone: 'America/Sao_Paulo' });
    tasks.push(t);
    registerWorkerGauges(job.name);
    scheduled.push(job.name);
    if (job.unguarded) unguarded_enabled.push(job.name);
    logger.info({ job: job.name, cron: job.cron, group: job.group }, 'worker.scheduled');
  }

  const inventory: SchedulerInventory = {
    groups_enabled: enabled,
    groups_disabled: JOB_GROUPS.filter((g) => !enabledSet.has(g)),
    scheduled,
    skipped,
    unguarded_enabled,
  };

  logger.info(
    {
      groups_enabled: inventory.groups_enabled,
      groups_disabled: inventory.groups_disabled.map(
        (g) => `${g} (${JOBS.filter((j) => j.group === g).length} jobs)`,
      ),
      jobs_scheduled: scheduled.length,
      jobs_skipped: skipped.length,
      jobs: scheduled,
    },
    'scheduler.inventory',
  );

  if (unguarded_enabled.length > 0) {
    // NÃO é debug: é a lista de jobs cujo efeito DUPLICA se este scheduler
    // subir em duas réplicas. Quem escala o scheduler precisa ver isto no
    // primeiro log do processo.
    logger.warn(
      { jobs: unguarded_enabled, tracked_in: '#513' },
      'scheduler.unguarded_jobs_enabled — estes jobs duplicam efeito com mais de uma réplica de scheduler',
    );
  }

  return inventory;
}

/** Uma linha por job habilitado — para runbook, `--dry-run` e docs. */
export function describeScheduledJobs(groups: readonly JobGroup[] = DEFAULT_JOB_GROUPS): string[] {
  const set = new Set(groups);
  return JOBS.filter((j) => set.has(j.group)).map(describeJob);
}

/** Quantos jobs cada grupo tem — usado pelo inventário e pelos docs. */
export function jobCountByGroup(): Record<JobGroup, number> {
  const out = {} as Record<JobGroup, number>;
  for (const g of JOB_GROUPS) {
    getJobGroupSpec(g); // fail-closed: grupo sem spec explode aqui
    out[g] = JOBS.filter((j) => j.group === g).length;
  }
  return out;
}

/** Names of cron jobs currently executing. */
export function activeWorkerJobs(): string[] {
  return [...inflight.keys()];
}

export type StopWorkersResult = {
  /** Jobs that were running when the drain started and finished in time. */
  drained: string[];
  /** Jobs still executing when the deadline expired — reported, never hidden. */
  pending: string[];
};

/**
 * Stop scheduling new ticks and await the runs already in flight.
 *
 * @param deadlineMs how long to wait for in-flight runs. On expiry the still
 *        active job names are RETURNED so the caller can log/audit them
 *        (issue #512: "Componentes não drenados aparecem no log/métrica
 *        final"; "informar job ativo no momento do shutdown").
 */
export async function stopWorkers(deadlineMs = 15_000): Promise<StopWorkersResult> {
  await haltWorkerScheduling();
  return drainWorkers(deadlineMs);
}

/**
 * Stop scheduling, WITHOUT waiting — issue #512 review round 1 (P1 on
 * `src/index.ts:260`). This belongs to the first atomic shutdown step,
 * alongside `pauseQueueWorkers()`: everything that could START new work is
 * silenced before anything begins to close.
 *
 * Idempotent.
 */
export async function haltWorkerScheduling(): Promise<void> {
  acceptingTicks = false;
  // node-cron v4 `stop()` returns `void | Promise<void>`; await both shapes so
  // the scheduler is really quiesced before we start counting the drain.
  await Promise.all(tasks.map(async (t) => t.stop()));
  tasks.length = 0;
}

/** Await the cron runs already in flight. See `stopWorkers` for the contract. */
export async function drainWorkers(deadlineMs = 15_000): Promise<StopWorkersResult> {
  const running = [...inflight.keys()];
  if (running.length === 0) return { drained: [], pending: [] };
  logger.info({ jobs: running, deadline_ms: deadlineMs }, 'worker.drain_started');

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deadlineMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      Promise.all([...inflight.values()]).then(() => 'drained' as const),
      deadline,
    ]);
    const pending = outcome === 'timeout' ? [...inflight.keys()] : [];
    const drained = running.filter((j) => !pending.includes(j));
    if (pending.length > 0) {
      logger.error({ jobs: pending, deadline_ms: deadlineMs }, 'worker.drain_deadline_exceeded');
    }
    return { drained, pending };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test seam — resets the drain bookkeeping between specs. */
export function _resetWorkerStateForTests(): void {
  acceptingTicks = true;
  inflight.clear();
  tasks.length = 0;
  gaugesRegistered.clear();
  lastSuccessAt.clear();
  lastFailureAt.clear();
}

/** Test seam — drives one tick through the guard without a cron schedule. */
export const _internal = { runTick };
