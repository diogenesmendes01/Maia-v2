/**
 * Issue #536 §3 — a reaplicação de tombstones depois de um restore.
 *
 * O QUE FALTAVA. `planReconciliation` e `canReleaseTraffic` existem e são
 * testados desde a #520, e o drill já os AVALIA em dry-run contra o snapshot
 * restaurado. Mas nenhum processo REAPLICAVA as exclusões: o runbook mandava um
 * humano fazer isso no passo 3.6. Enquanto for manual, a proteção contra
 * ressurreição de dado depende de alguém lembrar — e o momento em que se
 * depende disso é o momento em que se acabou de perder o banco.
 *
 * A CADEIA COMPLETA, agora fechada:
 *
 *   backup (watermark de tombstone no manifesto)
 *     → restore
 *       → `planReconciliation`  — o que foi apagado DEPOIS deste snapshot?
 *         → ESTE MÓDULO        — reapaga, uma classe/sujeito por vez
 *           → `canReleaseTraffic` — libera só com o que foi CONFIRMADO
 *
 * O mecanismo de purga é o MESMO de `execution.ts` (a porta `purge`), de
 * propósito: se a reaplicação tivesse a própria implementação de exclusão, as
 * duas divergiriam, e a divergência apareceria como dado do titular voltando à
 * vida depois de um incidente — a pior hora possível para descobrir.
 *
 * IDEMPOTÊNCIA. Reaplicar um tombstone cujo dado já não existe é um no-op que
 * devolve zero linhas, e isso conta como aplicado. É o que permite a
 * `execution.ts` escrever o tombstone ANTES da purga: um tombstone que
 * "exagera" é corrigido aqui, de graça.
 */
import type { AuditAction } from '@/governance/audit-actions.js';
import { TypedError } from '@/lib/utils.js';
import {
  canReleaseTraffic,
  type ReconciliationPlan,
  type TombstoneRecord,
} from '@/ops/retention/tombstones.js';
import { getDataClass } from '@/ops/retention/data-classes.js';
import type { PurgeJob } from './execution.js';

export interface ReapplyPorts {
  /**
   * A MESMA porta que `executePrivacyRequest` usa. `subject.identifier` chega
   * como `person_id` reconstruído do próprio ledger quando existe; quando o
   * tombstone só carrega `resource_locator`, o adapter resolve por ele.
   */
  purge(job: PurgeJob): Promise<number>;
  /** Carimba o tombstone como reconciliado — o cursor de uma reaplicação retomável. */
  markReconciled(tombstoneId: string, at: Date): Promise<void>;
  audit(action: AuditAction, metadata: Record<string, unknown>): Promise<void>;
  now(): Date;
}

export interface ReapplyOptions {
  /**
   * O ledger lido veio de uma fonte INDEPENDENTE do snapshot restaurado?
   *
   * `true` só quando o ledger foi lido de um banco de produção ainda vivo
   * (rollback), ou de um export de ledger tirado antes do restore. `false`
   * (ou a dúvida) bloqueia — ver o comentário em `reapplyTombstones`.
   */
  ledger_independent: boolean;
}

export interface ReapplyOutcome {
  /** O veredito de `canReleaseTraffic`, calculado sobre o que foi CONFIRMADO. */
  release: boolean;
  reason: string;
  applied_ids: string[];
  failed: { tombstone_id: string; data_class: string; code: string }[];
  /** Linhas efetivamente removidas por classe. Zero é resultado normal. */
  reapplied: Record<string, number>;
}

/**
 * Converte um tombstone numa purga.
 *
 * Um tombstone sem sujeito E sem resource locator não descreve alvo nenhum;
 * executá-lo como "apague a classe inteira" transformaria uma linha de ledger
 * ambígua num apagamento de tenant. Recusa.
 */
function jobFor(t: TombstoneRecord): PurgeJob {
  if (t.subject_ref === null && t.resource_locator === null) {
    throw new TypedError(
      'tombstone_without_target',
      'tombstone names neither a subject nor a resource — refusing to widen it into a class-wide purge',
      { data_class: t.data_class },
    );
  }
  const klass = getDataClass(t.data_class);
  if (klass.purge_mechanism === 'not_purgeable') {
    throw new TypedError(
      'tombstone_class_not_purgeable',
      'ledger names a class that cannot be purged — the row is inconsistent with the inventory',
      { data_class: t.data_class },
    );
  }
  return {
    scope: { tenant_id: t.tenant_id, agent_id: t.agent_id },
    data_class: t.data_class,
    mechanism: klass.purge_mechanism as PurgeJob['mechanism'],
    subject: {
      subject_ref: t.subject_ref ?? '',
      // A reaplicação trabalha a partir do LEDGER, e o ledger é
      // pseudonimizado por desenho — ele reconhece um sujeito, não o enumera.
      // O adapter casa por `subject_ref`/`resource_locator`, então não há
      // identificador cru a transportar aqui.
      identifier: { kind: 'person_id', value: t.subject_ref ?? t.resource_locator ?? '' },
    },
  };
}

/**
 * Reaplica o plano e devolve o veredito de liberação.
 *
 * FALHA FECHADO em três lugares distintos, e os três importam:
 *
 *  1. plano não-ok (ledger ilegível, watermark ausente, tombstone inválido) ⇒
 *     nada é reaplicado e o tráfego NÃO é liberado. Não tentar é o certo: sem
 *     plano confiável não se sabe o que reaplicar;
 *  2. um tombstone que falha ao ser reaplicado NÃO interrompe os outros — os
 *     demais continuam sendo reaplicados —, mas o id dele fica FORA de
 *     `applied_ids`, e `canReleaseTraffic` bloqueia por causa dele. Parar no
 *     primeiro erro deixaria mais dado ressuscitado vivo sem mudar o veredito;
 *  3. `canReleaseTraffic` recebe o que foi CONFIRMADO, nunca a lista de
 *     pendentes. É a diferença entre "eu quis reaplicar tudo" e "tudo foi
 *     reaplicado".
 */
export async function reapplyTombstones(
  plan: ReconciliationPlan,
  ports: ReapplyPorts,
  opts: ReapplyOptions,
): Promise<ReapplyOutcome> {
  const applied_ids: string[] = [];
  const failed: ReapplyOutcome['failed'] = [];
  const reapplied: Record<string, number> = {};

  // A armadilha silenciosa deste passo, e a razão de a flag ser obrigatória.
  //
  // Depois de um `pg_restore`, `data_tombstones` dentro do banco restaurado é
  // a cópia ANTIGA do ledger — a que veio no snapshot. Ler o ledger dali e
  // pedir o plano devolve `pending: []` e `ok: true`, porque nenhum tombstone
  // do snapshot é mais novo que o watermark do próprio snapshot. É
  // indistinguível de "não havia nada a reaplicar", e libera o tráfego com
  // todo o dado que o titular mandou apagar de volta no ar. É exatamente o
  // cenário que os tombstones existem para cobrir, chegando pela porta dos
  // fundos.
  //
  // Nenhuma checagem automática distingue as duas leituras — as linhas são as
  // mesmas. Só quem operou o restore sabe de onde veio o ledger, então a
  // afirmação é EXIGIDA, e a ausência dela bloqueia.
  if (!opts.ledger_independent) {
    await ports.audit('post_restore_reconciliation_failed', {
      outcome: 'blocked',
      reason: 'ledger_not_independent',
      pending: plan.pending.length,
    });
    return {
      release: false,
      reason: 'ledger_not_independent',
      applied_ids,
      failed,
      reapplied,
    };
  }

  if (!plan.ok) {
    const gate = canReleaseTraffic(plan, []);
    await ports.audit('post_restore_reconciliation_failed', {
      outcome: 'blocked',
      reason: gate.reason,
      blocked_reason: plan.blocked_reason,
      invalid_tombstones: plan.invalid_ids.length,
      pending: plan.pending.length,
    });
    return { release: false, reason: gate.reason, applied_ids, failed, reapplied };
  }

  for (const t of plan.pending) {
    try {
      const removed = await ports.purge(jobFor(t));
      reapplied[t.data_class] = (reapplied[t.data_class] ?? 0) + removed;
      await ports.markReconciled(t.id, ports.now());
      applied_ids.push(t.id);
    } catch (err) {
      const code = (err as TypedError)?.code;
      failed.push({
        tombstone_id: t.id,
        data_class: t.data_class,
        code: typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'reapply_failed',
      });
    }
  }

  const gate = canReleaseTraffic(plan, applied_ids);
  await ports.audit(
    gate.release ? 'post_restore_reconciliation_completed' : 'post_restore_reconciliation_failed',
    {
      outcome: gate.release ? 'released' : 'blocked',
      reason: gate.reason,
      pending: plan.pending.length,
      applied: applied_ids.length,
      failed: failed.length,
      by_class: plan.by_class,
      reapplied,
    },
  );

  return { release: gate.release, reason: gate.reason, applied_ids, failed, reapplied };
}
