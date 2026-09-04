# Data retention matrix

> **Status: DRAFT — NOT APPROVED.** Every retention period, legal basis and exception in this document is an OPEN QUESTION for the responsible legal owner / DPO. Nothing here is legal advice, and the platform does not act on any of it until an approved policy is configured.
>
> Issue #520: *"prazos, bases legais e exceções precisam de aprovação do responsável jurídico/DPO; a implementação não deve codificar suposições jurídicas como fatos universais."*
>
> **One item in this document is NOT an open question:** `privacy.tombstone` carries a design **ratified by the platform owner** (2026-09-02, reaffirmed 2026-09-03) — non-purgeable, which is stronger than any minimum period. That is a different authority from the DPO and is labelled as such wherever it appears. [Full record below.](#privacytombstone--ratified-by-the-platform-owner-issue-536)

## What is implemented, and what is not

| | State |
|---|---|
| **Mechanism** (inventory, per-class purge, legal hold, tombstones, dry-run, audit) | Implemented and tested — `src/ops/retention/` |
| **Subject requests** (resolution, encrypted export, erasure execution, tombstone re-application) | Implemented and unit-tested — `src/ops/privacy/`. **Never executed against a real database**; the SQL in `adapters.ts` deletes, and no line of it has run. |
| **Policy** (how long each class is kept, on what legal basis, with what exceptions) | **Not decided.** Pending DPO approval |

The two rows are different levers and only the first two are live. A **subject** asking for erasure is a legal obligation with a named requester, and it executes today (behind a recorded human approval). A **period-based** sweep deletes on the platform's own initiative, and it deletes nothing until the DPO approves a policy.

The executable mirror of this document is [`src/ops/retention/data-classes.ts`](../../../src/ops/retention/data-classes.ts). Every class there ships with `retention_days: null`, and `resolveRetention()` returns `purgeable: false` for all of them. **Today the retention executor deletes nothing.** `approval_state` is `'pending_dpo'` for every class except `privacy.tombstone`, whose design the platform owner ratified: that one is `'ratified_by_owner'`, and the value is **derived** inside `cls()` from whether the class carries a `dpo_open_question` or an `owner_ratification` — never written by hand, so the pair cannot disagree.

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
| `privacy.export` | security | sensitive personal | tenant+agent | delete | **excluded (volume)** | **yes** |
| `privacy.tombstone` | security | internal | tenant+agent | **not purgeable** | in dump | no |

### Data outside PostgreSQL (issue §14)

- **`media.blobs`** — `docker-compose.yml` mounts `/app/media` as a separate volume; `pg_dump` does not see it. **Open decision:** is media ephemeral/recreatable (and therefore purgeable), or durable data that needs its own backup with per-object checksum, encryption, retention and hold? Until that is decided, a restore reconstitutes the database WITHOUT its attachments.
- **`gateway.baileys_session`** — WhatsApp session credentials. Treated as an operational secret: never inside a dump, never in a log. Recovery path today is **re-pair**, which is documented in [`docs/runbooks/backup-restore.md`](../../runbooks/backup-restore.md).
- **`queue.redis`** — BullMQ jobs, DLQ, caches, idempotency keys. Classified as rebuildable: the durable source of truth is Postgres (the outbox / idempotency ledger). This is deliberate — restoring a stale Redis alongside an old database snapshot would re-dispatch side effects that already happened.

## Open questions for the DPO

Each of these is carried in code as `DataClass.dpo_open_question` and is printed by `openDpoQuestions()`. A class the platform owner has ratified carries an `owner_ratification` record instead (`dpo_open_question: null`), is absent from `openDpoQuestions()`, and is printed by `ownerRatifiedClasses()` — a taken decision must not be presented as a pending one.

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
| `privacy.export` | ~~Export package lifetime before it must expire.~~ **INITIAL POLICY SET — seven days, awaiting DPO confirmation.** See below. |

### Ratified — no longer a question

| Class | Decision | Ratified by |
|---|---|---|
| `privacy.tombstone` | Structurally non-purgeable. [Full record below.](#privacytombstone--ratified-by-the-platform-owner-issue-536) | Platform owner (2026-09-02, reaffirmed 2026-09-03) |

### `privacy.export` — an initial policy, and a mechanism that enforces it (issue #536)

**Decided by the platform owner, pending DPO confirmation: seven days.** This is the one period in this document that is set, and it is set as an INITIAL POLICY rather than a legal conclusion — the DPO may replace the number, and the number lives in configuration (`PRIVACY_EXPORT_TTL_DAYS`) precisely so that replacing it is an environment change and not a code change.

Why this class could be decided ahead of the others: the conservative direction here is the **opposite** of every other class. For erasure, erring toward a longer period is recoverable; for an encrypted package containing a subject's consolidated data sitting on disk, erring toward a *shorter* period is the recoverable side. Keeping it longer is the risk, not the safety.

**The mechanism is now live, and that is the substantive change.** Before this, `privacy_requests.export_expires_at` was a stamp with no executor: the deadline existed in the database and the `.enc` stayed on disk forever. `privacy_export_sweep` (hourly) now removes the expired artifact, audits every removal (`privacy_export_purged`), refuses and audits any locator it cannot prove (`privacy_export_purge_refused`), and marks the request so a reader sees `purged` instead of a locator pointing at a file that no longer exists. Runbook: [`docs/runbooks/privacy-export-ttl.md`](../../runbooks/privacy-export-ttl.md).

**`legal_hold_applicable` moved from `no` to `yes` for this class.** The old value was written when nothing deleted the artifact, so the question had no consequence. Now that the class is destructible, an active hold on the subject freezes the package: the copy handed to a subject is responsive material exactly as much as the rows it was built from. **Operational consequence the DPO should know about:** an open-ended hold keeps that subject's `.enc` on disk indefinitely. That is the recoverable direction, but a forgotten hold becomes an eternal artifact — the runbook carries the query that lists them.

**Still open, and deliberately separate:** whether a *deletion* request from one subject should also destroy the export artifacts of that same subject. That is a different question from the TTL, and `privacy.export` remains in `UNSUPPORTED_CLASSES` until it is answered.

### `privacy.tombstone` — ratified by the platform owner (issue #536)

**This is not an open question and must not be presented as one.** It was carried as *"the MINIMUM retention for tombstones"* addressed to the DPO. The platform owner corrected the premise and ratified the design that the default branch already implements:

> *"Há uma correção: a `main` já torna `privacy.tombstone` **não-purgável**, o que é mais forte que escolher um prazo mínimo. **Ratifico esse desenho.**"*

**Recorded as received.** The ratification arrived in writing as the direction for the task on issue #536 (2026-09-02) and was reaffirmed in the owner's decision on PR #732 (2026-09-03). In code: the class carries `owner_ratification` (the decision, the argument, when it was received) instead of a `dpo_open_question`; `approval_state` derives to `'ratified_by_owner'`; and the class no longer appears in `openDpoQuestions()`.

**Why non-purgeable is stronger than a minimum period.** A minimum tombstone retention would have to exceed the LONGEST backup-artifact retention *at all times* — including after someone raises `backup.artifact`'s period, a decision that has not even been made yet. Get that inequality wrong by a day and restoring an old artifact resurrects data that should already be gone, which is the exact scenario tombstones exist to cover. Non-purgeable removes the arithmetic entirely: **there is no period left to get wrong.**

**How the design holds — and how far the guard actually reaches.** Tombstones are never purged, so they outlive any backup retention by construction, whatever period the DPO later sets for `backup.artifact`. This is not a default that could drift, and each layer below is exercised by [`tests/unit/ops/retention-tombstone-guard.spec.ts`](../../../tests/unit/ops/retention-tombstone-guard.spec.ts) on every unit pass:

- `privacy.tombstone` is declared `purge_mechanism: 'not_purgeable'` in [`data-classes.ts`](../../../src/ops/retention/data-classes.ts);
- `parseRetentionPolicy` **drops** any policy entry for a structurally non-purgeable class (`tests/unit/ops/retention-data-classes.spec.ts`), and `resolveRetention('privacy.tombstone', …)` returns `purgeable: false` / `class_not_purgeable` in its **first** branch — the guard proves this even for a policy object that smuggles the class past the parser;
- the **real call site** refuses: `executePrivacyRequest` never emits a purge job for the class — the guard runs the executor and asserts the refusal *and* that other classes were purged in the same run, so the test cannot pass vacuously;
- **no periodic policy in the repository references the class**: the guard reads the worker registry (`src/workers/index.ts`) and the configuration contract (`src/config/contract.ts`) and asserts no tombstone sweep job and no tombstone TTL/sweep key exist — while asserting the known sweepers and keys ARE there;
- the contract's **effective defaults** keep period-based purging inert: `RETENTION_DRY_RUN` parses to `true` and `RETENTION_POLICY` is absent, both read from the real contract, not a hand copy.

**Declared limit of the guard.** A deployed environment can override any contract default (`RETENTION_DRY_RUN=false`, a real `RETENTION_POLICY`), and no unit test sees a live database. CI has no such infrastructure, so the guard proves the repository *contains no path* that purges tombstones and that the default configuration creates none — it does **not** prove anything about a running environment. What reaches the effective environment is `npm run config:preflight` / `npm run doctor` and environment review; this boundary is stated in the spec header rather than papered over.

**What this does NOT settle**: how long a *retained backup artifact* may keep a deleted subject's data inside it. That stays open under `backup.artifact` and is a different question — it bounds the window in which a restore still needs reconciliation, not the life of the ledger. The mechanism for that window is [§3.6 of the runbook](../../runbooks/backup-restore.md): the reconciliation job re-applies every tombstone newer than the artifact's watermark before traffic is released.

**Consequence to accept**: the tombstone ledger grows without bound. It is one small pseudonymised row per deletion, and `readTombstoneLedger` already caps its read and reports `available: false` when the cap is exceeded — which **blocks** restores rather than silently truncating the plan. If that cap is ever reached in practice, the fix is a bigger cap or a compaction design, never an expiry.

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

**The gate is now exercised, not merely described.** The restore drill (`npm run restore:test`, [`drill.ts`](../../../src/ops/backup/drill.ts)) runs `planReconciliation` + `canReleaseTraffic` as a DRY RUN against the restored snapshot and records `restore_drills.tombstones_pending`. So an unreadable ledger, a missing watermark or a planted row now fails a scheduled drill instead of being discovered during an incident.

**Re-applying is now a job too** (issue #536). `npm run restore:reconcile` ([`reapply.ts`](../../../src/ops/privacy/reapply.ts)) replays every pending tombstone through the *same* per-class purge the privacy workflow uses, then asks `canReleaseTraffic` with the ids it actually **confirmed** — never the list it intended to apply. One guard is worth naming here because no automated check can replace it: after a `pg_restore`, `data_tombstones` inside the restored database is the OLD ledger, so a plan built from it comes back `ok` with `pending: []` and would release traffic with every erased subject back online. The rows are identical to a good ledger's. The job therefore **requires** an explicit `--ledger-source` assertion and blocks without it.

## Review

| | |
|---|---|
| Last updated | 2026-09-03 (issue #536 / PR #732 — the platform owner corrected the premise on `privacy.tombstone` and **ratified the non-purgeable design** (2026-09-02, reaffirmed 2026-09-03), so it stopped being a question to the DPO: `approval_state` now derives to `'ratified_by_owner'` for that class, and the guard on the design was extended to the real purge call site, the worker registry and the configuration contract's defaults — with its limit declared. **No period was decided, and nothing new purges anything.** The owner-split of the remaining decisions and the written-homologation lock were separated out for their own review) |
| Approved by legal/DPO | **No — draft.** One item is ratified by the **platform owner** (`privacy.tombstone`), which is a different authority and is labelled as such wherever it appears |
| Re-review when | A class is added, a period is approved, or the media/Redis decisions land |
