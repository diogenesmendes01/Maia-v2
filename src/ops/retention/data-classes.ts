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
 *
 * Issue #536 materialised the owner's PROPOSAL as a configuration artifact
 * (`./proposed-policy.ts`). A proposal is not an approval: its `approved_by` is
 * the `pending_dpo_homologation` sentinel, `RetentionPolicy.homologated` is
 * `false` for it, and `./activation.ts` refuses to arm any class while that is
 * the case. Nothing below changed: the inventory still ships
 * `retention_days: null` for every class, because a number HERE would be the
 * legal assumption the issue forbids.
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
    // #536 — the owner's proposal gives audio transcripts a SHORTER period than
    // the message body that carries them (30d vs 180d). A shorter period that
    // cannot be addressed separately is prose, not policy, so the transcript is
    // its own class. It has no dedicated column today: the selector is
    // `mensagens` rows whose `tipo` is audio, and materialising that selector is
    // a prerequisite listed in the matrix.
    id: 'postgres.messages.audio_transcript',
    data_owner: 'platform_ops',
    purpose: 'speech-to-text transcript of a received audio message',
    sensitivity: 'sensitive_personal',
    scope: 'tenant_agent',
    source_of_truth: "postgres.mensagens (tipo='audio')",
    purge_mechanism: 'delete',
    backup_behavior: 'in_pg_dump',
    legal_hold_applicable: true,
    reversible: false,
    audit_event: 'retention_run_completed',
    dpo_open_question:
      'whether a transcript of voice needs a shorter period than the message body that carries it, and how short',
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
    // #536 — memory the USER pinned on purpose is not derived data, so the
    // inheritance rule in `./derivation.ts` must not reach it: clamping it to
    // the source message would delete something the user asked to keep, and
    // exempting it inside the derived class would silently let derived memory
    // outlive its source. Separate class, separate purpose, separate period.
    id: 'postgres.memory.pinned',
    data_owner: 'platform_ops',
    purpose: 'memory the user explicitly pinned, kept beyond the conversation that produced it',
    sensitivity: 'sensitive_personal',
    scope: 'tenant_agent',
    source_of_truth: 'postgres.agent_memories (pinned by the user)',
    purge_mechanism: 'delete',
    backup_behavior: 'in_pg_dump',
    legal_hold_applicable: true,
    reversible: false,
    audit_event: 'retention_run_completed',
    dpo_open_question:
      'the purpose and the period of user-pinned memory, which by definition does not inherit the retention of its source',
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
    legal_hold_applicable: false,
    reversible: false,
    audit_event: 'privacy_request_completed',
    dpo_open_question: 'export package lifetime before it must expire',
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
    // #536 — ANSWERED, and the only one of the eleven that could be: the
    // minimum is a technical consequence of the backup windows, not a legal
    // judgement. It is enforced at boot by `retention/tombstone-exceeds-backup`
    // rather than left as a number someone has to remember to check.
    dpo_open_question:
      'ANSWERED (#536, technical not legal): the minimum must EXCEED the longest backup retention, enforced at boot by `retention/tombstone-exceeds-backup` (RETENTION_TOMBSTONE_MIN_DAYS, default 60 against a 30-day off-site window)',
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
export function classesExcludedFromDump(): string[] {
  return DATA_CLASSES.filter((c) => c.backup_behavior !== 'in_pg_dump').map((c) => c.id);
}

export function classesIncludedInDump(): string[] {
  return DATA_CLASSES.filter((c) => c.backup_behavior === 'in_pg_dump').map((c) => c.id);
}

/**
 * Approver sentinels meaning "this policy is a PROPOSAL awaiting homologation".
 *
 * Issue #536 ships the owner's proposal as a real, loadable `RETENTION_POLICY`
 * so that counting can start before the lawyers finish — but a proposal must
 * never delete. Rather than inventing a parallel "is it real" flag an operator
 * could forget, the signal is the approver field itself: a policy signed
 * `pending_dpo_homologation` reads, in the env file, as exactly what it is.
 *
 * `homologated: false` is what `./activation.ts` refuses to arm on.
 */
export const PENDING_HOMOLOGATION_APPROVER = 'pending_dpo_homologation';

export const PENDING_HOMOLOGATION_APPROVERS: readonly string[] = Object.freeze([
  PENDING_HOMOLOGATION_APPROVER,
  'pending_dpo',
  'pending_homologation',
  'pending_accountant_homologation',
]);

/** Is this approver a real sign-off, or the pending-homologation sentinel? */
export function isHomologatedApprover(approvedBy: string | null | undefined): boolean {
  if (!approvedBy) return false;
  return !PENDING_HOMOLOGATION_APPROVERS.includes(approvedBy.trim().toLowerCase());
}

/**
 * The DPO-approved policy, supplied as configuration. Absent ⇒ nothing is
 * purgeable.
 *
 * `dry_run` is per class and defaults to `true`: the activation path is
 * "dry-run → compare counts → disarm ONE class", so a policy that merely names
 * a class must not arm it. Omitting the field keeps the class counting.
 */
export const retentionPolicySchema = z.object({
  version: z.string().min(1),
  approved_by: z.string().min(1),
  approved_at: z.string().datetime({ offset: true }),
  classes: z.record(
    z.string(),
    z.object({
      retention_days: z.number().int().positive(),
      dry_run: z.boolean().optional(),
    }),
  ),
});

export type RetentionPolicyInput = z.infer<typeof retentionPolicySchema>;

export interface RetentionPolicyClass {
  retention_days: number;
  /** `true` ⇒ this class only COUNTS, whatever the global lever says. */
  dry_run: boolean;
}

export interface RetentionPolicy {
  version: string;
  approved: boolean;
  approved_by: string | null;
  /**
   * The policy carries a real sign-off, not the pending-homologation sentinel.
   * A structurally valid proposal is `approved: true` (it parses, it has a
   * version and an approver) but `homologated: false` (nobody signed it).
   */
  homologated: boolean;
  classes: Record<string, RetentionPolicyClass>;
}

/** The policy in force when no DPO-approved configuration is present. */
export const UNAPPROVED_POLICY: RetentionPolicy = Object.freeze({
  version: UNAPPROVED_POLICY_VERSION,
  approved: false,
  approved_by: null,
  homologated: false,
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
  const classes: Record<string, RetentionPolicyClass> = {};
  for (const [id, entry] of Object.entries(result.data.classes)) {
    const known = BY_ID.get(id);
    if (!known || known.purge_mechanism === 'not_purgeable') continue;
    classes[id] = {
      retention_days: entry.retention_days,
      // Absent ⇒ dry-run. Arming is opt-in, per class, in writing.
      dry_run: entry.dry_run !== false,
    };
  }
  return {
    version: result.data.version,
    approved: true,
    approved_by: result.data.approved_by,
    homologated: isHomologatedApprover(result.data.approved_by),
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
    | 'class_not_purgeable'
    /**
     * #536 — the class itself has no approved period, but a class it derives
     * from does, and derived data may not outlive its source. Only
     * `resolveEffectiveRetention` (`./derivation.ts`) emits this.
     */
    | 'inherited_from_source';
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
