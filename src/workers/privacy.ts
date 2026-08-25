/**
 * Issue #536 §2/§3 — os JOBS. Este arquivo é o que faltava para o mecanismo
 * deixar de ser inerte.
 *
 * Mesmo formato de `src/workers/backup.ts`: uma função compartilhada por CLI e
 * por qualquer agendador, com single-flight por advisory lock, para que duas
 * execuções do mesmo procedimento destrutivo não se cruzem. Duas execuções de
 * uma exclusão por titular competiriam pelas mesmas linhas; duas reaplicações
 * pós-restore competiriam pelo mesmo ledger.
 *
 * OS DOIS PRIMEIROS NÃO SÃO CRON, de propósito. Um pedido de privacidade nasce
 * de um titular e é aprovado por um humano; uma reconciliação pós-restore
 * acontece depois de um restore, que é uma operação manual. Agendá-los daria a
 * impressão de que a plataforma decide sozinha quando apagar dado de gente.
 *
 * O TERCEIRO — `runPrivacyExportSweepJob`, o varredor do TTL do export — É
 * cron, e a diferença não é inconsistência. Ali o prazo JÁ FOI decidido (sete
 * dias, `PRIVACY_EXPORT_TTL_DAYS`) e comunicado ao titular no próprio pedido; o
 * cron não decide nada, cumpre. Um TTL que dependesse de alguém lembrar de
 * rodar um comando não seria um TTL, seria uma intenção — e foi exatamente esse
 * o estado que a decisão do dono sobre a #536 mandou consertar.
 */
import { randomUUID } from 'node:crypto';
import { config } from '@/config/env.js';
import { pool } from '@/db/client.js';
import { runWithSystemContext, runWithTenantContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import { TypedError } from '@/lib/utils.js';
import { OPS_LOCK_KEYS, withOpsLock } from '@/ops/backup/single-flight.js';
import {
  readBackupWatermark,
  readPrivacyRequest,
  readTombstoneLedger,
  recordRetentionRun,
} from '@/db/repositories/ops-repos.js';
import { deriveTombstoneSecret, planReconciliation } from '@/ops/retention/tombstones.js';
import { createPrivacyPorts, createReapplyPorts } from '@/ops/privacy/adapters.js';
import { createExportSweepPorts } from '@/ops/privacy/export-sweeper-adapters.js';
import { runExportSweep, type ExportSweepOutcome } from '@/ops/privacy/export-sweeper.js';
import { audit } from '@/governance/audit.js';
import {
  executePrivacyRequest,
  type PrivacyExecutionResult,
  type PrivacyRequestRecord,
} from '@/ops/privacy/execution.js';
import { reapplyTombstones, type ReapplyOutcome } from '@/ops/privacy/reapply.js';
import {
  resolveSubjectRef,
  type PrivacyRequestStatus,
  type PrivacyRequestType,
  type SubjectIdentifier,
} from '@/ops/privacy/workflow.js';

export type PrivacyJobOutcome =
  | { status: 'already_running' }
  | { status: 'not_found' }
  | { status: 'ran'; result: PrivacyExecutionResult };

/**
 * Executa UM pedido de privacidade já aprovado.
 *
 * O identificador cru do titular vem do operador (é ele que o titular
 * apresentou), nunca do banco: `privacy_requests.subject_ref` é pseudônimo, e
 * é ele que a execução confere contra o identificador informado. Um
 * identificador que não deriva o mesmo `subject_ref` é RECUSADO — sem isso, um
 * erro de digitação executaria a exclusão em nome de outra pessoa.
 */
export async function runPrivacyRequestJob(
  requestId: string,
  identifier: SubjectIdentifier,
): Promise<PrivacyJobOutcome> {
  // A ÚNICA leitura fora do escopo do tenant, e por necessidade: o operador
  // traz um id de pedido opaco, e é a própria linha que diz a que tenant ele
  // pertence. Não há como abrir o contexto do tenant antes de descobrir qual
  // é. A busca é por chave primária (não enumera nada) e devolve só as colunas
  // de controle — nenhum dado de titular. Todo o resto da execução, incluindo
  // cada `audit()`, roda dentro do `runWithTenantContext` do tenant resolvido.
  const row = await runWithSystemContext(() => readPrivacyRequest(requestId));
  if (row === null) return { status: 'not_found' };

  const req: PrivacyRequestRecord = {
    id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    type: row.type as PrivacyRequestType,
    status: row.status as PrivacyRequestStatus,
    identity_verified_by: row.identity_verified_by,
    approved_by: row.approved_by,
  };

  const secret = deriveTombstoneSecret(config.RUNTIME_TRACE_HMAC_MASTER_SECRET);
  const derived = resolveSubjectRef(
    { tenant_id: req.tenant_id, agent_id: req.agent_id },
    identifier,
    secret,
  );
  if (derived.subject_ref !== row.subject_ref) {
    // Nem `denied` nem `failed`: nada foi executado e o pedido continua
    // válido. O que está errado é o identificador que o operador digitou.
    throw new TypedError(
      'privacy_subject_mismatch',
      'the identifier supplied does not resolve to this request subject',
      { request_id: requestId },
    );
  }

  // O MESMO lock da retenção, e isso é deliberado: os dois apagam as mesmas
  // linhas por classe. Um lock próprio deixaria uma retenção e uma exclusão por
  // titular correrem juntas sobre o mesmo `pessoa_id`, com a segunda contando
  // linhas que a primeira já removeu — evidência errada num pedido que precisa
  // ser defensável.
  const outcome = await withOpsLock(
    OPS_LOCK_KEYS.retention_run,
    { pool, onWarn: (event, detail) => logger.warn(detail, event) },
    () =>
      // Escopo do TENANT, não `system`: cada linha tocada aqui pertence a um
      // titular de um tenant (invariante nº 1). O backup é DB-wide e por isso
      // roda sob `system`; isto aqui é o oposto.
      runWithTenantContext({ tenant_id: req.tenant_id, agent_id: req.agent_id }, () =>
        executePrivacyRequest(
          req,
          { subject_ref: derived.subject_ref, identifier },
          createPrivacyPorts(),
        ),
      ),
  );

  if (outcome.status === 'already_running') return { status: 'already_running' };
  return { status: 'ran', result: outcome.result };
}

export type ReconcileJobOutcome =
  | { status: 'already_running' }
  | { status: 'ran'; result: ReapplyOutcome };

/**
 * Reaplica os tombstones depois de um restore e devolve o veredito de
 * liberação de tráfego.
 *
 * `ledger_independent` NÃO tem default. Ver `reapply.ts`: ler o ledger de
 * dentro do banco restaurado produz um plano `ok` e vazio, que libera o
 * tráfego com todo o dado apagado de volta no ar. Só quem operou o restore
 * sabe de onde veio o ledger.
 */
export async function runPostRestoreReconciliationJob(input: {
  backup_id: string;
  ledger_independent: boolean;
}): Promise<ReconcileJobOutcome> {
  const outcome = await withOpsLock(
    OPS_LOCK_KEYS.tombstone_reconcile,
    { pool, onWarn: (event, detail) => logger.warn(detail, event) },
    () =>
      runWithSystemContext(async () => {
        const watermark = await readBackupWatermark(input.backup_id);
        const ledger = await readTombstoneLedger();
        const plan = planReconciliation({
          watermark,
          ledger_available: ledger.available,
          tombstones: ledger.tombstones,
          secret: deriveTombstoneSecret(config.RUNTIME_TRACE_HMAC_MASTER_SECRET),
        });
        return reapplyTombstones(plan, createReapplyPorts(), {
          ledger_independent: input.ledger_independent,
        });
      }),
  );

  if (outcome.status === 'already_running') return { status: 'already_running' };
  return { status: 'ran', result: outcome.result };
}

/**
 * O TETO DO PASSE.
 *
 * Um passe sem limite seguraria o advisory lock enquanto percorresse um backlog
 * arbitrário — e, num incidente em que muitos exports vencem de uma vez, é
 * justamente quando a varredura não pode virar uma operação longa e opaca. 500
 * artefatos por passe, de hora em hora, escoam 12 mil por dia; o que sobra sai
 * no passe seguinte, e a ordem por vencimento garante que o mais exposto vai
 * primeiro. Não é configuração: é uma propriedade da cadência do job, e um
 * operador que precisar acelerar roda o CLI.
 */
const EXPORT_SWEEP_LIMIT = 500;

export type ExportSweepJobOutcome =
  | { status: 'already_running' }
  | { status: 'ran'; result: ExportSweepOutcome };

/**
 * Issue #536 — o varredor do TTL do export.
 *
 * ESTE É CRON, ao contrário dos dois jobs acima, e a diferença não é
 * inconsistência. Um pedido de privacidade nasce de um titular e é aprovado por
 * um humano; uma reconciliação pós-restore acontece depois de uma operação
 * manual. Agendá-los daria a impressão de que a plataforma decide sozinha
 * quando apagar dado de gente. Aqui é o contrário: o prazo JÁ FOI decidido
 * (sete dias, `PRIVACY_EXPORT_TTL_DAYS`) e comunicado ao titular no próprio
 * pedido. O que o cron faz é CUMPRIR uma decisão tomada — e um TTL que depende
 * de alguém lembrar de rodar um comando não é um TTL, é uma intenção.
 *
 * Single-flight em chave própria: dois passes concorrentes planejariam sobre os
 * mesmos artefatos. Perder a corrida NÃO é erro (o outro passe está fazendo o
 * trabalho) — é `already_running`, e o job seguinte pega o que sobrar.
 *
 * O passe roda sob `system` porque é manutenção cross-tenant; cada linha de
 * auditoria da remoção, porém, é escrita no contexto do tenant DAQUELE pedido
 * (ver `createExportSweepPorts`).
 */
export async function runPrivacyExportSweep(
  options: { dryRun?: boolean } = {},
): Promise<ExportSweepJobOutcome> {
  const correlationId = randomUUID();
  // O override do CLI é POR CHAMADA, nunca por variável de ambiente reescrita
  // em runtime: `config` é validada uma vez no boot, então mexer no `process.env`
  // depois ou não teria efeito nenhum ou (pior) mudaria o comportamento do CRON
  // até o próximo restart — que é o oposto do que quem digita `--dry-run` quer.
  const dryRun = options.dryRun ?? config.PRIVACY_EXPORT_SWEEP_DRY_RUN;

  const outcome = await withOpsLock(
    OPS_LOCK_KEYS.privacy_export_sweep,
    { pool, onWarn: (event, detail) => logger.warn(detail, event) },
    () =>
      runWithSystemContext(async () => {
        await audit({
          acao: 'retention_run_started',
          metadata: {
            correlation_id: correlationId,
            data_class: 'privacy.export',
            dry_run: dryRun,
          },
        });

        const result = await runExportSweep(createExportSweepPorts(), {
          dryRun,
          correlationId,
          limit: EXPORT_SWEEP_LIMIT,
        });

        // A MESMA tabela de evidência da retenção de artefatos (`retention_runs`,
        // migration 102), com `data_class='privacy.export'`. Um ledger próprio
        // para este passe seria uma segunda fonte da verdade sobre a mesma
        // pergunta — "quanto a política apagou, e quando?" — e as duas
        // divergiriam.
        //
        // `skipped_held` conta os artefatos que um hold ativo congelou; `failed`
        // soma falha e RECUSA, porque para quem lê a evidência as duas dizem a
        // mesma coisa: o artefato continua no host.
        await recordRetentionRun({
          correlation_id: correlationId,
          data_class: 'privacy.export',
          dry_run: dryRun,
          policy_version: `privacy-export-ttl-${config.PRIVACY_EXPORT_TTL_DAYS}d`,
          status: result.status,
          scanned: result.scanned,
          eligible: result.eligible,
          deleted: result.purged,
          skipped_held: result.skipped_held,
          failed: result.failed + result.refused,
          cursor_watermark: result.cursor_watermark,
          error_code: result.error_code,
        }).catch((err: unknown) => {
          // A evidência do PASSE não pode derrubar o passe: as remoções já
          // foram auditadas uma a uma, e é essa trilha que defende o pedido.
          logger.error(
            { err: (err as Error).name },
            'privacy.export_sweep_run_record_failed',
          );
        });

        await audit({
          acao:
            result.status === 'completed' ? 'retention_run_completed' : 'retention_run_failed',
          metadata: {
            correlation_id: correlationId,
            data_class: 'privacy.export',
            dry_run: dryRun,
            status: result.status,
            scanned: result.scanned,
            eligible: result.eligible,
            purged: result.purged,
            already_absent: result.already_absent,
            skipped_held: result.skipped_held,
            refused: result.refused,
            failed: result.failed,
            error_code: result.error_code,
          },
        });

        return result;
      }),
  );

  if (outcome.status === 'already_running') return { status: 'already_running' };
  return { status: 'ran', result: outcome.result };
}

/** A face do cron: sem retorno, sem lançar — `runTick` loga o resto. */
export async function runPrivacyExportSweepJob(): Promise<void> {
  const outcome = await runPrivacyExportSweep();
  if (outcome.status === 'already_running') {
    logger.info({}, 'privacy.export_sweep_already_running');
    return;
  }
  const r = outcome.result;
  const level = r.status === 'completed' ? 'info' : 'error';
  logger[level](
    {
      status: r.status,
      scanned: r.scanned,
      eligible: r.eligible,
      purged: r.purged,
      skipped_held: r.skipped_held,
      refused: r.refused,
      failed: r.failed,
      error_code: r.error_code,
    },
    'privacy.export_sweep_finished',
  );
}
