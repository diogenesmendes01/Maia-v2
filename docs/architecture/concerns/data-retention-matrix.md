# Data retention matrix

> **Status: DRAFT — NOT APPROVED.** Every retention *period*, legal basis and exception in this document is an OPEN QUESTION for the responsible legal owner / DPO. Nothing here is legal advice, and the platform does not act on any of it until an approved policy is configured.
>
> Issue #520: *"prazos, bases legais e exceções precisam de aprovação do responsável jurídico/DPO; a implementação não deve codificar suposições jurídicas como fatos universais."*
>
> **Two things in this document are NOT open questions, and the difference matters when you read the rest.** `privacy.tombstone` carries a **design ratified by the platform owner** (non-purgeable — [below](#privacytombstone--ratified-by-the-platform-owner-issue-536)). The `privacy.export` TTL of seven days is an **initial policy that is running in production today** and is still **awaiting DPO confirmation** ([below](#privacyexport--an-initial-policy-live-today-confirmation-still-owed-issue-536)). Everything else is still owed by someone, and [who owes what](#the-remaining-decisions-split-by-owner) is now split by owner instead of addressed to the DPO as a single pile.

## What is implemented, and what is not

| | State |
|---|---|
| **Mechanism** (inventory, per-class purge, legal hold, tombstones, dry-run, audit) | Implemented and tested — `src/ops/retention/` |
| **Subject requests** (resolution, encrypted export, erasure execution, tombstone re-application) | Implemented and unit-tested — `src/ops/privacy/`. **Never executed against a real database**; the SQL in `adapters.ts` deletes, and no line of it has run. |
| **Policy** (how long each class is kept, on what legal basis, with what exceptions) | **Not decided**, with ONE exception. Pending DPO approval, except the `privacy.export` seven-day TTL, which the platform owner set as an initial policy and which is **already running** — see [below](#privacyexport--an-initial-policy-live-today-confirmation-still-owed-issue-536) |

The three rows are different levers. A **subject** asking for erasure is a legal obligation with a named requester, and it executes today (behind a recorded human approval). A **period-based** sweep deletes on the platform's own initiative — and exactly one of those is running: the export TTL. Every other class purges nothing, and none will until a period is approved and homologated.

The executable mirror of this document is [`src/ops/retention/data-classes.ts`](../../../src/ops/retention/data-classes.ts). Every class there ships with `retention_days: null`, and `resolveRetention()` returns `purgeable: false` for all of them. **Today the retention executor deletes nothing.**

Each class also carries a `decision`: either `{ state: 'open', owner, question }` — naming the role that owes the answer — or `{ state: 'ratified_by_owner', … }` with the decision and the argument behind it. It is a discriminated union, so a class cannot be added without saying which of the two it is. `approval_state` is derived from it (`'pending_dpo'` for every class except the ratified `privacy.tombstone`), which is why the two can never disagree.

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
5. Only then is dry-run disabled, per class, with approval — and the written homologation has to exist before that switch is flipped, not after. That is not a convention: it is [a guard that fails the build](#the-lock-no-new-periodic-policy-is-activated-without-written-homologation).

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
| `media.outbound_artifacts` | platform_ops | sensitive personal | tenant+agent | delete | **excluded (volume)** | yes |
| `gateway.baileys_session` | platform_ops | secret | tenant | **not purgeable** | **excluded (secret)** | no |
| `queue.redis` | platform_ops | internal | system | delete | **excluded (rebuildable)** | no |
| `backup.artifact` | platform_ops | sensitive personal | system | delete | in dump | yes |
| `privacy.export` | security | sensitive personal | tenant+agent | delete | **excluded (volume)** | **yes** |
| `privacy.tombstone` | security | internal | tenant+agent | **not purgeable** | in dump | no |

### Data outside PostgreSQL (issue §14)

- **`media.blobs`** — `docker-compose.yml` mounts `/app/media` as a separate volume; `pg_dump` does not see it. **Open decision:** is media ephemeral/recreatable (and therefore purgeable), or durable data that needs its own backup with per-object checksum, encryption, retention and hold? Until that is decided, a restore reconstitutes the database WITHOUT its attachments.
- **`gateway.baileys_session`** — WhatsApp session credentials. Treated as an operational secret: never inside a dump, never in a log. Recovery path today is **re-pair**, which is documented in [`docs/runbooks/backup-restore.md`](../../runbooks/backup-restore.md).
- **`queue.redis`** — BullMQ jobs, DLQ, caches, idempotency keys. Classified as rebuildable: the durable source of truth is Postgres (the outbox / idempotency ledger). This is deliberate — restoring a stale Redis alongside an old database snapshot would re-dispatch side effects that already happened.

## The remaining decisions, split by owner

Until issue #536 this was one table headed *"Open questions for the DPO"*, and in code one field literally called `dpo_open_question` printed by `openDpoQuestions()`. Two of its rows said, in their own text, that they were **not** the DPO's — `queue.redis` (*"ops owns the TTLs"*) and `gateway.baileys_session` (*"the security owner must approve"*). A single list addressed to one role is a list nobody can be held to: the DPO reads items that are not theirs, and whoever does own them never sees them.

The list is now split by the role that can actually answer, in code (`DataClass.decision.owner`, `openDecisionsByOwner()`) and here. **The fourth list is not a leftovers bin** — an item lands there only when the content genuinely does not say who decides, and it is printed like any other so the gap stays visible.

### Legal / DPO

These are periods, legal bases and exceptions. Nothing on this list is decided, and nothing on it purges anything today.

| Class | Question |
|---|---|
| `postgres.messages` | Retention for inbound/outbound message bodies; does an audio transcript need a shorter one? |
| `postgres.conversations` | May a conversation shell outlive its messages for statistics? |
| `postgres.people` | Which identifiers must be anonymised vs deleted? Which accounting retention overrides an erasure request? |
| `postgres.memory` | Does derived memory inherit the retention of its source message, or have its own? |
| `postgres.financial` | The statutory accounting retention that overrides an erasure request, and its legal basis. |
| `postgres.traces` | Debug trace retention — bodies contain raw prompts and replies. |
| `backup.artifact` | How long artifacts are kept locally vs off-site, and **the maximum window during which a deleted subject may still exist inside a retained artifact**. |
| `privacy.export` | **Confirm or replace the seven-day TTL that is already running.** See [below](#privacyexport--an-initial-policy-live-today-confirmation-still-owed-issue-536) — this is a confirmation owed on production behaviour, not on a proposal. |

Two notes on this list, because both look like they could have gone elsewhere:

- **`backup.artifact` is here and not under Ops** even though "local vs off-site" sounds operational. The number that binds is the window in which an already-erased subject still exists inside a retained artifact — a privacy consequence. Where the artifact is stored is an Ops proposal made *underneath* that ceiling, not a parallel decision.
- **`privacy.export` stays here even though the period is set.** The owner set an initial policy; confirming or replacing it is the DPO's, and the mechanism enforcing it is live in the meantime.

### Ops

These are architecture and lifecycle decisions that must land **before** any period can be discussed — for two of the three, there is no period to decide until the durability question is answered.

| Class | Question |
|---|---|
| `media.blobs` | Durable data (its own backup, per-object checksum, encryption, hold) or ephemeral/recreatable and purgeable? **If the answer is "durable", the period half returns to Legal/DPO** — it is not owed today because there is nothing yet to put a period on. |
| `media.outbound_artifacts` | How long an outbound object whose delivery ended uncertain or terminal is kept, so reconciliation and manual re-arm can still send the SAME bytes. Deleting it earlier turns a recoverable delivery into a permanent `media_ref_unresolved`. |
| `queue.redis` | None for privacy (no independent personal data) — Ops owns the TTLs. |

### Security

| Class | Question |
|---|---|
| `gateway.baileys_session` | None for privacy — it is an operational secret, not personal data. The security owner approves the **re-pair vs encrypted-backup** decision. |

### Owner still to be assigned

| Class | Question | Why nobody is named |
|---|---|---|
| `postgres.audit` | How long is the audit trail retained, and which fields may be redacted without destroying its evidential value? (*"auditabilidade não justifica conservar conteúdo bruto indefinidamente"*) | **This class is frozen: no field-by-field change without the agreed decision.** The question as frozen bundles two halves with different owners — the **period** (Legal/DPO) and **which fields may be redacted without destroying evidential value** (Security). Assigning it to either would require splitting the question, which is exactly the edit the freeze reserves. So it is listed here, visible, rather than pushed under whoever happened to head the old list. The text above is unchanged, byte for byte. |

### Ratified — no longer a question

| Class | Decision | Ratified by |
|---|---|---|
| `privacy.tombstone` | Structurally non-purgeable. [Full record below.](#privacytombstone--ratified-by-the-platform-owner-issue-536) | Platform owner, issue #536 |

## The two items that are not open questions

Both are recorded in full here because a one-line entry in a table above would lose what matters about them: one is ratified by an authority that is **not** the DPO, and the other is behaviour already running ahead of its sign-off.

### `privacy.export` — an initial policy, live today, confirmation still owed (issue #536)

> **Read these two facts together, because either one alone is misleading.**
>
> 1. **The seven-day TTL is ACTIVE in production.** `privacy_export_sweep` runs hourly (`50 * * * *`, `src/workers/index.ts`) and `PRIVACY_EXPORT_SWEEP_DRY_RUN` defaults to `false`. Encrypted export packages are being deleted today, on the platform's own initiative.
> 2. **It has NOT been homologated.** The number is the platform owner's initial policy (issue #536); the DPO's confirmation — or replacement — is still owed.
>
> Anyone reading only (1) thinks the period is settled. Anyone reading only (2) thinks nothing is happening yet. What is true is that behaviour is in production ahead of its sign-off, deliberately, for the reason in the next paragraph. This is the single grandfathered activation in [the homologation lock](#the-lock-no-new-periodic-policy-is-activated-without-written-homologation).

**Decided by the platform owner, pending DPO confirmation: seven days.** This is the one period in this document that is set, and it is set as an INITIAL POLICY rather than a legal conclusion — the DPO may replace the number, and the number lives in configuration (`PRIVACY_EXPORT_TTL_DAYS`) precisely so that replacing it is an environment change and not a code change.

Why this class could be decided ahead of the others: the conservative direction here is the **opposite** of every other class. For erasure, erring toward a longer period is recoverable; for an encrypted package containing a subject's consolidated data sitting on disk, erring toward a *shorter* period is the recoverable side. Keeping it longer is the risk, not the safety.

**The mechanism is now live, and that is the substantive change.** Before this, `privacy_requests.export_expires_at` was a stamp with no executor: the deadline existed in the database and the `.enc` stayed on disk forever. `privacy_export_sweep` (hourly) now removes the expired artifact, audits every removal (`privacy_export_purged`), refuses and audits any locator it cannot prove (`privacy_export_purge_refused`), and marks the request so a reader sees `purged` instead of a locator pointing at a file that no longer exists. Runbook: [`docs/runbooks/privacy-export-ttl.md`](../../runbooks/privacy-export-ttl.md).

**`legal_hold_applicable` moved from `no` to `yes` for this class.** The old value was written when nothing deleted the artifact, so the question had no consequence. Now that the class is destructible, an active hold on the subject freezes the package: the copy handed to a subject is responsive material exactly as much as the rows it was built from. **Operational consequence the DPO should know about:** an open-ended hold keeps that subject's `.enc` on disk indefinitely. That is the recoverable direction, but a forgotten hold becomes an eternal artifact — the runbook carries the query that lists them.

**Still open, and deliberately separate:** whether a *deletion* request from one subject should also destroy the export artifacts of that same subject. That is a different question from the TTL, and `privacy.export` remains in `UNSUPPORTED_CLASSES` until it is answered.

### `privacy.tombstone` — ratified by the platform owner (issue #536)

**This is not an open question and must not be presented as one.** It was carried as *"the MINIMUM retention for tombstones"* addressed to the DPO. The platform owner corrected the premise and ratified the design that the default branch already implements:

> *"Há uma correção: a `main` já torna `privacy.tombstone` **não-purgável**, o que é mais forte que escolher um prazo mínimo. **Ratifico esse desenho.**"*

**Recorded as received.** The ratification arrived in writing as the direction for this task, on issue #536. No date and no signature were supplied, so none is written here — the record says what it is and stops there. In code: `DataClass.decision` for this class is `{ state: 'ratified_by_owner', … }`, carrying the decision, the argument and `still_owed: null`; `approval_state` derives to `'ratified_by_owner'`, and the class no longer appears in `openDecisions()` or `openDpoQuestions()`.

**Why non-purgeable is stronger than a minimum period.** A minimum tombstone retention would have to exceed the LONGEST backup-artifact retention *at all times* — including after someone raises `backup.artifact`'s period, which is a decision that has not even been made yet. Get that inequality wrong by a day and restoring an old artifact resurrects data that should already be gone, which is the exact scenario tombstones exist to cover. Non-purgeable removes the arithmetic entirely: **there is no period left to get wrong.** It is also not a number that can drift out of date as other periods change around it.

**How the design holds.** Tombstones are never purged, so they outlive any backup retention by construction, whatever period the DPO later sets for `backup.artifact`. This is not a default that could drift:

- `privacy.tombstone` is declared `purge_mechanism: 'not_purgeable'` in [`data-classes.ts`](../../../src/ops/retention/data-classes.ts);
- `parseRetentionPolicy` **drops** any policy entry for a structurally non-purgeable class, so a future `RETENTION_POLICY` cannot make tombstones expire even if it asks (`tests/unit/ops/retention-data-classes.spec.ts`);
- `resolveRetention('privacy.tombstone', …)` returns `purgeable: false` with `reason: 'class_not_purgeable'` for **every** policy, approved or not — the `not_purgeable` branch is evaluated BEFORE the policy is consulted at all ([`data-classes.ts`](../../../src/ops/retention/data-classes.ts), first branch of `resolveRetention`), so no policy shape reaches the period arithmetic for this class;
- promoting the class to purgeable is itself a test failure — `ratified_non_purgeable_class_became_purgeable` in [the lock](#the-lock-no-new-periodic-policy-is-activated-without-written-homologation).

**What this does NOT settle**: how long a *retained backup artifact* may keep a deleted subject's data inside it. That stays open under `backup.artifact` and is a different question — it bounds the window in which a restore still needs reconciliation, not the life of the ledger. The mechanism for that window is [§3.6 of the runbook](../../runbooks/backup-restore.md): the reconciliation job re-applies every tombstone newer than the artifact's watermark before traffic is released.

**Consequence to accept**: the tombstone ledger grows without bound. It is one small pseudonymised row per deletion, and `readTombstoneLedger` already caps its read and reports `available: false` when the cap is exceeded — which **blocks** restores rather than silently truncating the plan. If that cap is ever reached in practice, the fix is a bigger cap or a compaction design, never an expiry.

## The lock: no new periodic policy is activated without written homologation

The platform owner's direction: *"nenhuma política periódica nova deve ser ativada sem homologação escrita"*. A sentence in a document does not stop anything, so it is a guard: [`src/ops/privacy/homologation.ts`](../../../src/ops/privacy/homologation.ts) plus [`tests/unit/ops/retention-homologation-guard.spec.ts`](../../../tests/unit/ops/retention-homologation-guard.spec.ts), which runs on every unit pass.

**What counts as a periodic policy here:** a job that destroys subject data BY PERIOD, on a cadence, on the platform's own initiative. It is the opposite lever from a subject request, which has a named requester and a legal obligation behind it. Nobody is asking for a periodic sweep, which is why it is the one that needs sign-off.

**The homologation field cannot be forgotten.** `PeriodicPolicy.authorisation` is a required, discriminated union — there is no optional field and no implicit value, so a new policy that omits it does not compile (`npm run typecheck` covers `src/`). Declaring that there is no authorisation means writing `{ kind: 'none', why: … }` out loud, and the guard then fails if that policy is active. The failure mode of forgetting is a red build, never a silent default.

| Declared policy | Cadence | Active today | Authorisation |
|---|---|---|---|
| `privacy.export.ttl_sweep` | hourly | **yes** | Owner-ratified, **written homologation still owed from Legal/DPO** — the single grandfathered entry |
| `backup.artifact.retention_sweep` | weekly | no (`RETENTION_DRY_RUN` defaults to `true`) | `none` — the `backup.artifact` window is still open |
| `retention.class_purge` | — | no | `none` — no per-class period exists |

The guard reports (and the test fails on) five conditions:

- `active_without_authorisation` — a policy is running and declares no authorisation;
- `new_activation_without_written_homologation` — a policy is running on the owner's ratification alone and is **not** in `GRANDFATHERED_ACTIVATIONS`. That list is closed and holds exactly one id (`privacy.export.ttl_sweep`); adding to it is a visible diff, which is the point of the word *"nova"*;
- `activation_declaration_mismatch` — the declared activation no longer matches the **real default in the configuration contract**. The guard reads `ENV_CONTRACT` rather than a hand-copied boolean, so flipping `RETENTION_DRY_RUN`'s default to `false` turns the build red without anyone remembering to update a test;
- `purgeable_class_without_homologated_policy` — a class resolves purgeable under the policy in force and no homologated policy covers it;
- `ratified_non_purgeable_class_became_purgeable` — one of the three structurally non-purgeable classes (`privacy.tombstone`, `postgres.financial`, `gateway.baileys_session`) stopped being one. That is a design change, not a period adjustment.

**The lock is not a permanent block.** Filling in a `WrittenHomologation` (authority, approver, date, where the signed record lives) is what unlocks an activation — which is exactly the step that was missing.

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
| Last updated | 2026-09-02 (issue #536 — the platform owner corrected the premise on `privacy.tombstone` and **ratified the non-purgeable design**, so it stopped being a question to the DPO; the remaining decisions were **split by owner** (Legal/DPO · Ops · Security · owner still to be assigned); the `privacy.export` seven-day TTL is recorded as **active in production AND still awaiting DPO confirmation**; and *"no new periodic policy is activated without written homologation"* became a guard. **No period was decided, and nothing new purges anything.**) |
| Approved by legal/DPO | **No — draft.** One item is ratified by the **platform owner** (`privacy.tombstone`), which is a different authority and is labelled as such wherever it appears |
| Re-review when | A class is added, a period is approved or homologated, an activation is added to `GRANDFATHERED_ACTIVATIONS`, or the media/Redis decisions land |
