# Migration prefix reservation ledger

> **Append-only. Add your new migration's line to the BOTTOM, under the
> last entry. Never edit, reorder, or delete an existing line.**

## Why this file exists (issue #340)

`tests/unit/scripts/migration-number-uniqueness.spec.ts` (added in #329)
catches duplicate migration prefixes, but it only runs **against the
current checkout at CI/test-time**. That does NOT prevent two _concurrent_
PRs from independently choosing the same prefix: each passes CI on its own
branch, and the collision only surfaces **after the second PR merges** —
wasting the second author's work and forcing a post-merge renumber.

This ledger turns that silent, late collision into an **early, explicit
git merge conflict**:

- The ledger is a **single append-only file** and every new migration adds
  its line at the **end**.
- Two concurrent PRs that both reserve the **same next prefix** each append
  a new last line to the same region of the file.
- Whichever PR merges first wins. When the second PR tries to merge (or
  rebase), git sees two different commits both appending to the same tail
  of the file and raises a **merge conflict on `RESERVATIONS.md`** — the
  conflict is impossible to auto-resolve, so a human must pick the next
  free prefix. The collision is caught at **merge time**, before the
  losing author has invested in a now-doomed `NNN_*.sql` file's review.

In other words: the reservation is the cheap thing you commit _first_; the
SQL is the expensive thing you write _after_ your prefix is reserved. The
append-only single-file shape is what makes concurrent reservations of the
same prefix collide deterministically.

> **Conflict scope.** Because every entry appends to the same tail, *any* two
> concurrent migration PRs will conflict on `RESERVATIONS.md` — even when their
> prefixes differ (`074` vs `075`). That is intended friction, not a bug: when
> the prefixes do **not** collide, resolve by simply keeping both lines (only
> renumber if two PRs actually picked the **same** prefix). The
> `check-migration-reservations.ts` guard is the authoritative duplicate-prefix
> backstop — it fails CI if a real collision ever slips through a mis-resolved
> merge.

The `scripts/check-migration-reservations.ts` guard (run by
`tests/unit/scripts/migration-reservations.spec.ts` and, on `pull_request`,
by `.github/workflows/migration-prefix-guard.yml`) additionally verifies
that every migration on disk has exactly one well-formed reservation here
and vice-versa, so a missing or stale reservation also fails fast.

## How to reserve a prefix

1. Pick the next free prefix: `NNN = max(existing numeric prefix) + 1`
   (currently the next free is **074**). To slot a migration between two
   already-used numbers, append a single lowercase letter (`038b`, `038c`)
   — that token sorts after the bare number and is treated as distinct.
2. Run `npm run migrate:reserve "<short purpose>"` to print the next free
   prefix and append a reservation line for you, **or** add the line by
   hand at the bottom of the ledger below.
3. Create `migrations/NNN_<short_name>.sql` (+ its `_down.sql` sibling) so
   the filename's prefix matches the reservation you just added.

See `docs/runbooks/migrations.md` for the full migration-authoring flow.

## Format

One entry per migration **file** (not per prefix), newest at the bottom:

```
<prefix> | <filename> | <short purpose>
```

- `<prefix>`  — the leading token of the filename: digits plus a single
  optional lowercase letter (`^[0-9]+[a-z]?$`), e.g. `063` or `038b`.
- `<filename>` — the exact forward `.sql` filename (no `_down.sql`).
- `<short purpose>` — a one-line human description (free text, no `|`).

Lines beginning with `#`, and blank lines, are ignored by the parser.

### A note on legitimately shared prefixes

Several prefixes are shared by more than one migration file (007, 014,
015, 018, 020, 023, 025, 026, 027, 031, 062, 063 — and the `038`/`038b`/
`038c` sub-sequence). These predate this ledger, are already merged and
applied, and are benign because the runner tracks migrations by **full
filename**, not by prefix (see `docs/runbooks/migrations.md` and issue
#308). The ledger therefore reserves **per file**; the duplicate-prefix
allowlist that distinguishes "grandfathered" from "new" collisions lives
in `tests/unit/scripts/migration-number-uniqueness.spec.ts`. Do not add
NEW shared prefixes — pick `max(existing)+1`.

<!-- BEGIN RESERVATIONS — append new entries below this line, never above -->
001 | 001_initial.sql | initial
002 | 002_specs_v1.sql | specs v1
003 | 003_review_fixes.sql | review fixes
004 | 004_pending_one_active_per_conversa.sql | pending one active per conversa
005 | 005_audit_mensagem_idx.sql | audit mensagem idx
006 | 006_mensagens_conversa_id_nullable.sql | mensagens conversa id nullable
007 | 007_p0_tenants_agents.sql | p0 tenants agents
007 | 007_scheduling.sql | scheduling
008 | 008_p0_cognitive_module_log.sql | p0 cognitive module log
009 | 009_p0_add_tenant_agent_columns.sql | p0 add tenant agent columns
010 | 010_p0_backfill_tenant_agent.sql | p0 backfill tenant agent
011 | 011_p0_tenant_agent_indexes.sql | p0 tenant agent indexes
012 | 012_p0_force_not_null.sql | p0 force not null
013 | 013_p0_agent_facts_tenant_unique.sql | p0 agent facts tenant unique
014 | 014_p0_seed_system_tenant.sql | p0 seed system tenant
014 | 014_p1_cognitive_candidates.sql | p1 cognitive candidates
014 | 014_p2_memory_entry.sql | p2 memory entry
015 | 015_p0_agents_tenant_status_idx.sql | p0 agents tenant status idx
015 | 015_p2_behavioral_hint.sql | p2 behavioral hint
016 | 016_p2_self_model.sql | p2 self model
017 | 017_p2_migrate_legacy_facts.sql | p2 migrate legacy facts
018 | 018_p2_agent_facts_tenant_unique.sql | p2 agent facts tenant unique
018 | 018_p3a_procedure_definitions.sql | p3a procedure definitions
019 | 019_p3a_procedure_assignments.sql | p3a procedure assignments
020 | 020_p3a_procedure_hardening.sql | p3a procedure hardening
020 | 020_p3b_procedure_executions.sql | p3b procedure executions
021 | 021_p3b_procedure_execution_events.sql | p3b procedure execution events
022 | 022_p3b_procedure_selector_decisions.sql | p3b procedure selector decisions
023 | 023_p3b_unique_in_progress_per_conversa.sql | p3b unique in progress per conversa
023 | 023_p3c_procedure_tests.sql | p3c procedure tests
024 | 024_p3c_procedure_metrics.sql | p3c procedure metrics
025 | 025_p3c_procedure_metrics_tenant_defense.sql | p3c procedure metrics tenant defense
025 | 025_p4_agent_operational_profile_versions.sql | p4 agent operational profile versions
026 | 026_p3c_fix_event_type_check.sql | p3c fix event type check
026 | 026_p4_agent_drift_alerts.sql | p4 agent drift alerts
027 | 027_p4_operational_profile_immutable_content.sql | p4 operational profile immutable content
027 | 027_p5_gap_escalation_rules.sql | p5 gap escalation rules
028 | 028_p5_capability_proposals.sql | p5 capability proposals
029 | 029_p5_capability_test_results.sql | p5 capability test results
030 | 030_p5_extend_capability_gap_tipo.sql | p5 extend capability gap tipo
031 | 031_p5_capability_proposals_test_loop.sql | p5 capability proposals test loop
031 | 031_p6_channels.sql | p6 channels
032 | 032_p6_roles.sql | p6 roles
033 | 033_p6_channel_policies.sql | p6 channel policies
034 | 034_p6_role_selector_decisions.sql | p6 role selector decisions
035 | 035_p6_seed_default_channel_role_policy.sql | p6 seed default channel role policy
036 | 036_p8e_policy_rules.sql | p8e policy rules
037 | 037_p8e_seed_default_hard_limits.sql | p8e seed default hard limits
038 | 038_p8b_soul_biases.sql | p8b soul biases
038b | 038b_p8b_extend_drift_alerts_type.sql | p8b extend drift alerts type
038c | 038c_p8b_extend_capability_proposal_type.sql | p8b extend capability proposal type
039 | 039_p8b_seed_founder_biases.sql | p8b seed founder biases
040 | 040_p8b_soul_biases_proposal_unique.sql | p8b soul biases proposal unique
041 | 041_p8c_lifecycle_status.sql | p8c lifecycle status
042 | 042_p8d_extend_drift_type_papel.sql | p8d extend drift type papel
043 | 043_p9a_skills.sql | p9a skills
044 | 044_p9a_extend_capability_proposal_type.sql | p9a extend capability proposal type
045 | 045_admin_users_sessions.sql | admin users sessions
046 | 046_admin_proposal_approvals.sql | admin proposal approvals
047 | 047_admin_audit_log.sql | admin audit log
048 | 048_admin_debug_snapshot_grants.sql | admin debug snapshot grants
049 | 049_admin_proposal_approvals_user_uq.sql | admin proposal approvals user uq
050 | 050_p10a_ksm_lifecycle_and_indexes.sql | p10a ksm lifecycle and indexes
051 | 051_p10a_enforce_lifecycle_transition.sql | p10a enforce lifecycle transition
052 | 052_p10b_runtime_trace_envelopes.sql | p10b runtime trace envelopes
053 | 053_p10b_runtime_trace_bodies.sql | p10b runtime trace bodies
054 | 054_p10b_unified_trace_events_matview.sql | p10b unified trace events matview
055 | 055_calendar_a_entidades_location.sql | calendar a entidades location
056 | 056_calendar_b_holidays.sql | calendar b holidays
057 | 057_calendar_c_holiday_entidades.sql | calendar c holiday entidades
058 | 058_calendar_d_capability_proposals_holiday_type.sql | calendar d capability proposals holiday type
059 | 059_calendar_e_holidays_unique_idem.sql | calendar e holidays unique idem
060 | 060_p3a_procedure_definitions_domain.sql | p3a procedure definitions domain
061 | 061_p4_profile_body_consolidation.sql | p4 profile body consolidation
062 | 062_drop_dashboard_sessions.sql | drop dashboard sessions
062 | 062_global_settings.sql | global settings
063 | 063_agent_memories_cleanup_backup.sql | agent memories cleanup backup
063 | 063_outbound_messages.sql | outbound messages
063 | 063_p10_idempotency_keys_tenant_pk.sql | p10 idempotency keys tenant pk
064 | 064_p10_idempotency_keys_atomic_reservation.sql | p10 idempotency keys atomic reservation
065 | 065_p10_idempotency_keys_fencing_and_failed.sql | p10 idempotency keys fencing and failed
066 | 066_ksm_composite_indexes_tenant_agent_id.sql | ksm composite indexes tenant agent id
067 | 067_outbound_messages_sweeper_index.sql | outbound messages sweeper index
068 | 068_idempotency_effect_outbox.sql | idempotency effect outbox
069 | 069_idempotency_effect_outbox_relayer_index.sql | idempotency effect outbox relayer index
070 | 070_idempotency_effect_outbox_retention_index.sql | idempotency effect outbox retention index
071 | 071_scheduling_add_tenant_agent.sql | scheduling add tenant agent
072 | 072_scheduling_backfill_tenant_agent.sql | scheduling backfill tenant agent
073 | 073_scheduling_tenant_indexes.sql | scheduling tenant indexes
074 | 074_agent_audience_profiles.sql | agent audience profiles per-agent identity (issue 407)
075 | 075_baseline_skills_seed.sql | baseline skills seed for runtime agents (issue 410)
