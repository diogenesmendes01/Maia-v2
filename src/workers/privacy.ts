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
 * NENHUM DOS DOIS É CRON, de propósito. Um pedido de privacidade nasce de um
 * titular e é aprovado por um humano; uma reconciliação pós-restore acontece
 * depois de um restore, que é uma operação manual. Agendá-los daria a
 * impressão de que a plataforma decide sozinha quando apagar dado de gente.
 */
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
} from '@/db/repositories/ops-repos.js';
import { deriveTombstoneSecret, planReconciliation } from '@/ops/retention/tombstones.js';
import { createPrivacyPorts, createReapplyPorts } from '@/ops/privacy/adapters.js';
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
