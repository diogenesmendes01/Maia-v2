# Data retention matrix

> **Status: DRAFT — NOT APPROVED.** Every retention period, legal basis and exception in this document is an OPEN QUESTION for the responsible legal owner / DPO. Nothing here is legal advice, and the platform does not act on any of it until an approved policy is configured.
>
> Issue #520: *"prazos, bases legais e exceções precisam de aprovação do responsável jurídico/DPO; a implementação não deve codificar suposições jurídicas como fatos universais."*

## What is implemented, and what is not

| | State |
|---|---|
| **Mechanism** (inventory, per-class purge, legal hold, tombstones, dry-run, audit) | Implemented and tested — `src/ops/retention/` |
| **Policy** (how long each class is kept, on what legal basis, with what exceptions) | **Not decided.** Pending DPO approval |

The executable mirror of this document is [`src/ops/retention/data-classes.ts`](../../../src/ops/retention/data-classes.ts). Every class there ships with `retention_days: null` and `approval_state: 'pending_dpo'`, and `resolveRetention()` returns `purgeable: false` for all of them. **Today the retention executor deletes nothing.**

The default is deliberately "do not delete". Deletion is irreversible, so the failure mode of an unapproved policy must be keeping data too long — recoverable, and visible as a backlog metric — never deleting it too early.

## How a period becomes effective

1. The DPO answers the open question for a class (below).
2. The answer is recorded in this document, with its legal basis and exceptions.
3. It ships as the `RETENTION_POLICY` environment value (declared in the configuration contract, `src/config/contract.ts`, group `backup`):

   ```json
   {
     "version": "v1-dpo-2026-07",
     "approved_by": "<legal owner>",
     "approved_at": "2026-07-01T00:00:00.000Z",
     "classes": { "postgres.traces": { "retention_days": 30 } }
   }
   ```

4. The executor runs in dry-run (`RETENTION_DRY_RUN=true`, the default) and the counts are compared against expectation.
5. Only then is dry-run disabled, per class, with approval.

`parseRetentionPolicy` refuses to make a structurally non-purgeable class purgeable, even if the policy asks: `privacy.tombstone`, `postgres.financial` and `gateway.baileys_session` cannot be purged by policy at all.

## The inventory

`Scope` is the isolation boundary. `Backup` is what a `pg_dump` actually captures — the classes marked *excluded* are NOT in the artifact, which is a documented decision, not an omission (issue §14).

| Class | Owner | Sensitivity | Scope | Purge | Backup | Hold applies |
|---|---|---|---|---|---|---|
| `postgres.messages` | platform_ops | sensitive personal | tenant+agent | delete | in dump | yes |
| `postgres.conversations` | platform_ops | personal | tenant+agent | delete | in dump | yes |
| `postgres.people` | platform_ops | personal | tenant+agent | anonymize | in dump | yes |
| `postgres.memory` | platform_ops | sensitive personal | tenant+agent | delete | in dump | yes |
| `postgres.financial` | finance | personal | tenant+agent | **not purgeable** | in dump | yes |
| `postgres.audit` | security | internal | tenant+agent | redact | in dump | yes |
| `postgres.traces` | platform_ops | sensitive personal | tenant+agent | delete | in dump | no |
| `media.blobs` | platform_ops | sensitive personal | tenant+agent | delete | **excluded (volume)** | yes |
| `gateway.baileys_session` | platform_ops | secret | tenant | **not purgeable** | **excluded (secret)** | no |
| `queue.redis` | platform_ops | internal | system | delete | **excluded (rebuildable)** | no |
| `backup.artifact` | platform_ops | sensitive personal | system | delete | in dump | yes |
| `privacy.export` | security | sensitive personal | tenant+agent | delete | **excluded (volume)** | no |
| `privacy.tombstone` | security | internal | tenant+agent | **not purgeable** | in dump | no |

### Data outside PostgreSQL (issue §14)

- **`media.blobs`** — `docker-compose.yml` mounts `/app/media` as a separate volume; `pg_dump` does not see it. **Open decision:** is media ephemeral/recreatable (and therefore purgeable), or durable data that needs its own backup with per-object checksum, encryption, retention and hold? Until that is decided, a restore reconstitutes the database WITHOUT its attachments.
- **`gateway.baileys_session`** — WhatsApp session credentials. Treated as an operational secret: never inside a dump, never in a log. Recovery path today is **re-pair**, which is documented in [`docs/runbooks/backup-restore.md`](../../runbooks/backup-restore.md).
- **`queue.redis`** — BullMQ jobs, DLQ, caches, idempotency keys. Classified as rebuildable: the durable source of truth is Postgres (the outbox / idempotency ledger). This is deliberate — restoring a stale Redis alongside an old database snapshot would re-dispatch side effects that already happened.

## Open questions for the DPO

Each of these is carried in code as `DataClass.dpo_open_question` and is printed by `openDpoQuestions()`.

| Class | Question |
|---|---|
| `postgres.messages` | Retention for inbound/outbound message bodies; does an audio transcript need a shorter one? |
| `postgres.conversations` | May a conversation shell outlive its messages for statistics? |
| `postgres.people` | Which identifiers must be anonymised vs deleted? Which accounting retention overrides an erasure request? |
| `postgres.memory` | Does derived memory inherit the retention of its source message, or have its own? |
| `postgres.financial` | The statutory accounting retention that overrides an erasure request, and its legal basis. |
| `postgres.audit` | How long is the audit trail retained, and which fields may be redacted without destroying its evidential value? (*"auditabilidade não justifica conservar conteúdo bruto indefinidamente"*) |
| `postgres.traces` | Debug trace retention — bodies contain raw prompts and replies. |
| `media.blobs` | Durable (own backup) or ephemeral (purgeable)? And the period if durable. |
| `gateway.baileys_session` | None for privacy; the security owner must approve re-pair vs encrypted backup. |
| `queue.redis` | None — ops owns the TTLs. |
| `backup.artifact` | Local vs off-site retention, and the maximum window during which a deleted subject may still exist inside a retained artifact. |
| `privacy.export` | Export package lifetime before it must expire. |
| `privacy.tombstone` | The MINIMUM tombstone retention. **It must exceed the longest backup retention**, or resurrection becomes possible again once tombstones are gone. |

## Legal hold

A hold freezes a class (or `*`), optionally narrowed to one pseudonymised subject, for a case reference, with a coded reason (never free text — a sensitive reason must not reach a log). While active, it blocks the applicable purge.

Two deliberate choices in [`legal-hold.ts`](../../../src/ops/retention/legal-hold.ts):

- A **subject-scoped hold blocks a class-wide purge**, because that purge would sweep the held subject away. Conservative on purpose.
- **Releasing a hold does not delete anything.** The retention policy must be re-evaluated afterwards.

## Tombstones and non-resurrection

A backup taken before a deletion still contains the deleted record. Restoring it would resurrect data a subject asked to erase.

Every deletion writes a signed tombstone. Restoring a snapshot requires replaying every tombstone newer than the artifact's `tombstone_watermark` **before** traffic is released; if the ledger is unreadable, the watermark is unknown, or any row fails verification, the restore is blocked. See [`docs/runbooks/backup-restore.md`](../../runbooks/backup-restore.md).

The ledger stores **pseudonyms** (keyed HMAC), never raw identifiers — a tombstone holding the phone number it claims to have erased would be a copy of the very data it deleted. It can recognise a subject it is given; it cannot enumerate subjects.

**The ledger's key is now defined** (issue #536). `deriveTombstoneSecret()` in [`tombstones.ts`](../../../src/ops/retention/tombstones.ts) derives it from the platform HMAC master secret under the fixed label `maia.tombstone.hmac.v1`, so the ledger key is not the manifest-signing key even though both descend from the same master. It could be pinned now precisely because nothing has written a tombstone yet; once rows exist it is frozen, since a different derivation makes every existing HMAC fail and an unverifiable ledger blocks every restore by design. This is a **key-management** decision, not a legal one — no retention period is implied or set by it.

**The gate is now exercised, not merely described.** The restore drill (`npm run restore:test`, [`drill.ts`](../../../src/ops/backup/drill.ts)) runs `planReconciliation` + `canReleaseTraffic` as a DRY RUN against the restored snapshot and records `restore_drills.tombstones_pending`. So an unreadable ledger, a missing watermark or a planted row now fails a scheduled drill instead of being discovered during an incident. Re-APPLYING the tombstones is still manual — it needs the per-class deletion mechanism the privacy workflow will build.

## Review

| | |
|---|---|
| Last updated | 2026-08-04 (issue #536 — tombstone key derivation + the drill's reconciliation dry run; **no period was decided**) |
| Approved by legal/DPO | **No — draft** |
| Re-review when | A class is added, a period is approved, or the media/Redis decisions land |
