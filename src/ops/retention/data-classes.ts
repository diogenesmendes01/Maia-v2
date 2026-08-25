/**
 * Issue #520 §9 — machine-readable data inventory and retention matrix.
 *
 * The baseline's retention was "delete dump files older than N days by mtime"
 * (`src/workers/backup.ts:139-153`). There was no notion of a DATA CLASS at
 * all, so messages, media, audit rows, queue jobs and Baileys credentials had
 * no stated owner, purpose, sensitivity, purge mechanism or backup behaviour.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LEGAL DEADLINES ARE NOT DECIDED HERE.
 *
 * The issue is explicit: "prazos, bases legais e exceções precisam de
 * aprovação do responsável jurídico/DPO; a implementação não deve codificar
 * suposições jurídicas como fatos universais."
 *
 * So every class ships with `retention_days: null` and
 * `approval_state: 'pending_dpo'`, and `resolveRetention` reports
 * `purgeable: false` for all of them. The MECHANISM is complete and tested;
 * the POLICY arrives as configuration (`RETENTION_POLICY`, a signed-off JSON
 * carrying a version + approver + per-class day counts).
 *
 * The conservative default is deliberately "do not delete": deletion is
 * irreversible, so the failure mode of an unapproved policy must be keeping
 * data too long (recoverable, and visible as a backlog metric), never
 * deleting it too early (unrecoverable).
 *
 * TODO(DPO): before enabling any purge, the DPO must approve, per class,
 * (a) the retention period, (b) the legal basis, and (c) the exceptions.
 * Record the approval in `docs/architecture/concerns/data-retention-matrix.md`
 * and ship it as `RETENTION_POLICY`.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { z } from 'zod';
import { TypedError } from '@/lib/utils.js';

/** Version reported by every retention run until a DPO-approved policy lands. */
export const UNAPPROVED_POLICY_VERSION = 'v0-pending-dpo';

export type Sensitivity = 'public' | 'internal' | 'personal' | 'sensitive_personal' | 'secret';

/** Which isolation boundary owns a row of this class. */
export type ClassScope = 'tenant_agent' | 'tenant' | 'system';

/** How a record of this class is removed when its retention expires. */
export type PurgeMechanism = 'delete' | 'anonymize' | 'redact' | 'not_purgeable';

/** What a `pg_dump` actually captures for this class (issue §14). */
export type BackupBehavior =
  /** Inside the logical dump — restored with the database. */
  | 'in_pg_dump'
  /** Lives in a mounted volume `pg_dump` does NOT see (docker-compose.yml media volume). */
  | 'excluded_volume'
  /** An operational secret deliberately kept out of the dump. */
  | 'excluded_secret'
  /** Rebuildable from the source of truth; loss is tolerable. */
  | 'rebuildable';

export interface DataClass {
  id: string;
  /** Accountable role, not a person's name. */
  data_owner: string;
  purpose: string;
  sensitivity: Sensitivity;
  scope: ClassScope;
  source_of_truth: string;
  purge_mechanism: PurgeMechanism;
  backup_behavior: BackupBehavior;
  legal_hold_applicable: boolean;
  /** Whether purging this class can be undone (almost never). */
  reversible: boolean;
  /** Audit action emitted when this class is purged. */
  audit_event: string;
  /**
   * ALWAYS null in code. A number here would be a legal assumption.
   * Populated at runtime from the DPO-approved `RETENTION_POLICY`.
   */
  retention_days: null;
  approval_state: 'pending_dpo';
  /** What the DPO still has to decide for this class. */
  dpo_open_question: string;
}

function cls(
  d: Omit<DataClass, 'retention_days' | 'approval_state'>,
): DataClass {
  return { ...d, retention_days: null, approval_state: 'pending_dpo' };
}

/**
 * The inventory. Every item the issue §9 enumerates has an entry, INCLUDING
 * the ones deliberately excluded from `pg_dump` — "deliberately excluded" is
 * itself a documented decision, not an omission.
 */
export const DATA_CLASSES: readonly DataClass[] = Object.freeze([
  cls({
    id: 'postgres.messages',
    data_owner: 'platform_ops',
    purpose: 'conversation history required to answer and to audit what the agent said',
    sensitivity: 'sensitive_personal',
    scope: 'tenant_agent',
    source_of_truth: 'postgres.mensagens',
    purge_mechanism: 'delete',
    backup_behavior: 'in_pg_dump',
    legal_hold_applicable: true,
    reversible: false,
    audit_event: 'retention_run_completed',
    dpo_open_question:
      'retention period for inbound/outbound message bodies, and whether transcripts of audio require a shorter one',
  }),
  cls({
    id: 'postgres.conversations',
    data_owner: 'platform_ops',
    purpose: 'grouping of messages into a dialogue with its state',
    sensitivity: 'personal',
    scope: 'tenant_agent',
    source_of_truth: 'postgres.conversas',
    purge_mechanism: 'delete',
    backup_behavior: 'in_pg_dump',
    legal_hold_applicable: true,
    reversible: false,
    audit_event: 'retention_run_completed',
    dpo_open_question: 'whether a conversation shell may outlive its messages for statistics',
  }),
  cls({
    id: 'postgres.people',
    data_owner: 'platform_ops',
    purpose: 'identity and permission of each interlocutor',
    sensitivity: 'personal',
    scope: 'tenant_agent',
    source_of_truth: 'postgres.pessoas',
    // A person is anonymised rather than deleted: their rows are referenced by
    // financial records that must survive for accounting reasons.
    purge_mechanism: 'anonymize',
    backup_behavior: 'in_pg_dump',
    legal_hold_applicable: true,
    reversible: false,
    audit_event: 'retention_run_completed',
    dpo_open_question:
      'which identifiers must be anonymised vs deleted, and the accounting retention that overrides an erasure request',
  }),
  cls({
    id: 'postgres.memory',
    data_owner: 'platform_ops',
    purpose: 'agent memory, facts, rules and embeddings derived from conversations',
    sensitivity: 'sensitive_personal',
    scope: 'tenant_agent',
    source_of_truth: 'postgres.agent_memories / agent_facts',
    purge_mechanism: 'delete',
    backup_behavior: 'in_pg_dump',
    legal_hold_applicable: true,
    reversible: false,
    audit_event: 'retention_run_completed',
    dpo_open_question:
      'whether derived memory inherits the retention of its source message or has its own',
  }),
  cls({
    id: 'postgres.financial',
    data_owner: 'finance',
    purpose: 'transactions and balances',
    sensitivity: 'personal',
    scope: 'tenant_agent',
    source_of_truth: 'postgres.transacoes',
    // Accounting records are typically NOT purgeable on request.
    purge_mechanism: 'not_purgeable',
    backup_behavior: 'in_pg_dump',
    legal_hold_applicable: true,
    reversible: false,
    audit_event: 'retention_run_completed',
    dpo_open_question:
      'the statutory accounting retention that overrides an erasure request, and its legal basis',
  }),
  cls({
    id: 'postgres.audit',
    data_owner: 'security',
    purpose: 'decision trail required by the platform governance invariant',
    sensitivity: 'internal',
    scope: 'tenant_agent',
    source_of_truth: 'postgres.audit_logs',
    // Audit rows may be trimmed of payload but the decision record stays.
    purge_mechanism: 'redact',
    backup_behavior: 'in_pg_dump',
    legal_hold_applicable: true,
    reversible: false,
    audit_event: 'retention_run_completed',
    dpo_open_question:
      'how long the audit trail is retained, and which fields may be redacted without destroying its evidential value ("auditabilidade não justifica conservar conteúdo bruto indefinidamente")',
  }),
  cls({
    id: 'postgres.traces',
    data_owner: 'platform_ops',
    purpose: 'runtime trace envelopes/bodies for debugging',
    sensitivity: 'sensitive_personal',
    scope: 'tenant_agent',
    source_of_truth: 'postgres.runtime_trace_bodies',
    purge_mechanism: 'delete',
    backup_behavior: 'in_pg_dump',
    legal_hold_applicable: false,
    reversible: false,
    audit_event: 'retention_run_completed',
    dpo_open_question: 'debug trace retention (bodies contain raw prompts and replies)',
  }),
  cls({
    id: 'media.blobs',
    data_owner: 'platform_ops',
    purpose: 'audio, image and document attachments received or produced',
    sensitivity: 'sensitive_personal',
    scope: 'tenant_agent',
    // docker-compose.yml mounts /app/media as a separate volume — pg_dump does
    // NOT capture it. Issue §14 requires this to be an explicit decision.
    source_of_truth: 'filesystem:/app/media',
    purge_mechanism: 'delete',
    backup_behavior: 'excluded_volume',
    legal_hold_applicable: true,
    reversible: false,
    audit_event: 'retention_run_completed',
    dpo_open_question:
      'whether media is durable data requiring its own backup, or ephemeral/recreatable and purgeable — and its retention if durable',
  }),
  cls({
    id: 'gateway.baileys_session',
    data_owner: 'platform_ops',
    purpose: 'WhatsApp session credentials for the bot line',
    sensitivity: 'secret',
    scope: 'tenant',
    source_of_truth: 'filesystem:BAILEYS_AUTH_DIR',
    // Never purged by the retention executor — rotation/revocation is the
    // lifecycle, and re-pairing is the recovery path (issue §14).
    purge_mechanism: 'not_purgeable',
    backup_behavior: 'excluded_secret',
    legal_hold_applicable: false,
    reversible: false,
    audit_event: 'retention_run_completed',
    dpo_open_question:
      'none (operational secret, not personal data) — but the security owner must approve the re-pair vs encrypted-backup decision',
  }),
  cls({
    id: 'queue.redis',
    data_owner: 'platform_ops',
    purpose: 'BullMQ jobs, DLQ entries, caches and idempotency keys',
    sensitivity: 'internal',
    scope: 'system',
    source_of_truth: 'redis',
    purge_mechanism: 'delete',
    // Rebuildable: the durable source of truth is Postgres (outbox/ledger).
    // Restoring a stale Redis would re-dispatch old side effects (§14).
    backup_behavior: 'rebuildable',
    legal_hold_applicable: false,
    reversible: false,
    audit_event: 'retention_run_completed',
    dpo_open_question: 'none (no independent personal data) — ops owns the TTLs',
  }),
  cls({
    id: 'backup.artifact',
    data_owner: 'platform_ops',
    purpose: 'the backup artifacts themselves',
    sensitivity: 'sensitive_personal',
    scope: 'system',
    source_of_truth: 'backup_runs + backup_manifests',
    purge_mechanism: 'delete',
    backup_behavior: 'in_pg_dump',
    legal_hold_applicable: true,
    reversible: false,
    audit_event: 'backup_artifact_deleted',
    dpo_open_question:
      'how long artifacts are kept locally vs off-site, and the maximum window a deleted subject may still exist inside a retained artifact',
  }),
  cls({
    id: 'privacy.export',
    data_owner: 'security',
    purpose: 'encrypted data-subject export packages',
    sensitivity: 'sensitive_personal',
    scope: 'tenant_agent',
    source_of_truth: 'privacy_requests.export_locator',
    purge_mechanism: 'delete',
    backup_behavior: 'excluded_volume',
    // ERA `false`, e era uma declaração obsoleta: foi escrita quando NADA
    // apagava o artefato, então a pergunta "um hold congela o export?" não
    // tinha consequência. O TTL do #536 tornou a classe destrutível, e um
    // pacote cifrado é uma cópia materializada do dado do titular — material
    // responsivo tanto quanto a origem. Destruí-lo sob hold é a pior saída
    // possível deste módulo, e a direção recuperável é conservá-lo.
    //
    // O varredor NÃO consulta este campo para decidir se avalia hold (ver
    // `src/ops/privacy/export-sweeper.ts`): condicionar uma recusa destrutiva a
    // um campo mutável de registro significa que uma edição de um caractere
    // desarma a proteção. O campo declara a verdade; a proteção é incondicional.
    legal_hold_applicable: true,
    reversible: false,
    audit_event: 'privacy_export_purged',
    // Sete dias é a POLÍTICA INICIAL decidida pelo dono (issue #536) e vive em
    // `PRIVACY_EXPORT_TTL_DAYS`, não numa constante. O que continua com o DPO é
    // confirmar (ou mudar) o número.
    dpo_open_question:
      'confirm or replace the initial 7-day export package lifetime (PRIVACY_EXPORT_TTL_DAYS); the mechanism that enforces it is live',
  }),
  cls({
    id: 'privacy.tombstone',
    data_owner: 'security',
    purpose: 'ledger proving a deletion happened, so a restore cannot undo it',
    sensitivity: 'internal',
    scope: 'tenant_agent',
    source_of_truth: 'data_tombstones',
    // Purging tombstones would re-enable resurrection. They outlive every
    // artifact that could contain the deleted data.
    purge_mechanism: 'not_purgeable',
    backup_behavior: 'in_pg_dump',
    legal_hold_applicable: false,
    reversible: false,
    audit_event: 'retention_run_completed',
    dpo_open_question:
      'the MINIMUM retention for tombstones (must exceed the longest backup retention, or resurrection becomes possible again)',
  }),
]);

const BY_ID = new Map(DATA_CLASSES.map((c) => [c.id, c]));

export function listDataClasses(): readonly DataClass[] {
  return DATA_CLASSES;
}

export function getDataClass(id: string): DataClass {
  const found = BY_ID.get(id);
  if (!found) {
    throw new TypedError('unknown_data_class', `data class '${id}' is not in the inventory`, {
      data_class: id,
    });
  }
  return found;
}

/** Classes that a `pg_dump` does NOT capture — the manifest declares these as excluded. */
/**
 * As classes que um pedido de um TITULAR alcança (issue #536 §2).
 *
 * O critério é o escopo: `tenant_agent` é a única faixa em que uma linha
 * pertence a um titular identificável. `gateway.baileys_session` é de tenant
 * (é credencial da linha, não dado do titular), e `queue.redis` /
 * `backup.artifact` são de sistema — apagar qualquer um deles "em nome" de um
 * titular destruiria dado de todos os outros.
 *
 * Inclui deliberadamente as classes NÃO purgáveis: elas viram EXCEÇÃO
 * registrada no pedido, não omissão. Um relatório de conformidade que
 * simplesmente não mencionasse `postgres.financial` não estaria dizendo que a
 * retenção contábil sobrepôs o apagamento — estaria escondendo.
 */
export function subjectScopedClasses(): readonly DataClass[] {
  return DATA_CLASSES.filter((c) => c.scope === 'tenant_agent');
}

export function classesExcludedFromDump(): string[] {
  return DATA_CLASSES.filter((c) => c.backup_behavior !== 'in_pg_dump').map((c) => c.id);
}

export function classesIncludedInDump(): string[] {
  return DATA_CLASSES.filter((c) => c.backup_behavior === 'in_pg_dump').map((c) => c.id);
}

/**
 * The DPO-approved policy, supplied as configuration. Absent ⇒ nothing is
 * purgeable.
 */
export const retentionPolicySchema = z.object({
  version: z.string().min(1),
  approved_by: z.string().min(1),
  approved_at: z.string().datetime({ offset: true }),
  classes: z.record(
    z.string(),
    z.object({ retention_days: z.number().int().positive() }),
  ),
});

export type RetentionPolicyInput = z.infer<typeof retentionPolicySchema>;

export interface RetentionPolicy {
  version: string;
  approved: boolean;
  approved_by: string | null;
  classes: Record<string, { retention_days: number }>;
}

/** The policy in force when no DPO-approved configuration is present. */
export const UNAPPROVED_POLICY: RetentionPolicy = Object.freeze({
  version: UNAPPROVED_POLICY_VERSION,
  approved: false,
  approved_by: null,
  classes: {},
});

/**
 * Parse `RETENTION_POLICY`. A malformed policy is NOT a reason to fall back to
 * some built-in default — it returns the unapproved policy, so the executor
 * keeps counting and stops deleting. Silent "best effort" deletion is exactly
 * the failure this issue exists to prevent.
 */
export function parseRetentionPolicy(raw: string | undefined): RetentionPolicy {
  if (!raw || raw.trim().length === 0) return UNAPPROVED_POLICY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return UNAPPROVED_POLICY;
  }
  const result = retentionPolicySchema.safeParse(parsed);
  if (!result.success) return UNAPPROVED_POLICY;
  // A policy may only speak about classes that exist AND are purgeable at all.
  const classes: Record<string, { retention_days: number }> = {};
  for (const [id, entry] of Object.entries(result.data.classes)) {
    const known = BY_ID.get(id);
    if (!known || known.purge_mechanism === 'not_purgeable') continue;
    classes[id] = { retention_days: entry.retention_days };
  }
  return {
    version: result.data.version,
    approved: true,
    approved_by: result.data.approved_by,
    classes,
  };
}

export interface RetentionVerdict {
  purgeable: boolean;
  retention_days: number | null;
  policy_version: string;
  /** Stable code, safe for logs and `maia doctor`. */
  reason:
    | 'ok'
    | 'policy_not_approved'
    | 'class_not_in_policy'
    | 'class_not_purgeable';
}

/**
 * Backend decides (invariant 3): given a class and the policy in force, may
 * the executor delete, and after how many days?
 *
 * Fail-closed at every branch — an unapproved policy, an unlisted class or a
 * structurally non-purgeable class all yield `purgeable: false`.
 */
export function resolveRetention(classId: string, policy: RetentionPolicy): RetentionVerdict {
  const klass = getDataClass(classId);
  if (klass.purge_mechanism === 'not_purgeable') {
    return {
      purgeable: false,
      retention_days: null,
      policy_version: policy.version,
      reason: 'class_not_purgeable',
    };
  }
  if (!policy.approved) {
    return {
      purgeable: false,
      retention_days: null,
      policy_version: policy.version,
      reason: 'policy_not_approved',
    };
  }
  const entry = policy.classes[classId];
  if (!entry) {
    return {
      purgeable: false,
      retention_days: null,
      policy_version: policy.version,
      reason: 'class_not_in_policy',
    };
  }
  return {
    purgeable: true,
    retention_days: entry.retention_days,
    policy_version: policy.version,
    reason: 'ok',
  };
}

/** Every question still owed to the DPO, for the runbook and `maia doctor`. */
export function openDpoQuestions(): { data_class: string; question: string }[] {
  return DATA_CLASSES.map((c) => ({ data_class: c.id, question: c.dpo_open_question }));
}
