import { eq, and, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { agents } from '../schema.js';
import { LearnedVoiceModifierSchema } from '@/identity/learned-voice-modifier.js';
import type { ProfileBody } from '../schema.js';

/**
 * P8d §10 — Write-path validation para `profile_body`.
 *
 * Aplicada antes de qualquer INSERT em `agent_operational_profile_versions`.
 * Garante que cognitive_limits estão dentro do range esperado e que cada
 * `LearnedVoiceModifier` casa o schema Zod.
 *
 * P9b enforça `cognitive_limits` em runtime do SkillRunner; P8d só fecha a
 * porta na DB (defesa em depth).
 */
function validateProfileBodyP8d(body: ProfileBody): void {
  const identity = (body as { identity?: Record<string, unknown> }).identity;
  if (!identity) return;

  const cl = identity.cognitive_limits as
    | { max_inference_depth?: unknown; max_speculation_in_response?: unknown; confidence_floor_for_action?: unknown }
    | undefined;
  if (cl) {
    // Aceita 0 (semente inicial pode não ter calibrado ainda) mas rejeita
    // valores negativos/fora-range tipados.
    if (typeof cl.max_inference_depth !== 'number' ||
        cl.max_inference_depth < 0 || cl.max_inference_depth > 10) {
      throw new Error('cognitive_limits.max_inference_depth out of range [0,10]');
    }
    if (typeof cl.max_speculation_in_response !== 'number' ||
        cl.max_speculation_in_response < 0 || cl.max_speculation_in_response > 1) {
      throw new Error('cognitive_limits.max_speculation_in_response out of range [0,1]');
    }
    if (typeof cl.confidence_floor_for_action !== 'number' ||
        cl.confidence_floor_for_action < 0 || cl.confidence_floor_for_action > 1) {
      throw new Error('cognitive_limits.confidence_floor_for_action out of range [0,1]');
    }
  }

  const mods = identity.learned_voice_modifiers;
  if (Array.isArray(mods)) {
    for (const m of mods) {
      // Throws ZodError com path detalhado se inválido.
      LearnedVoiceModifierSchema.parse(m);
    }
  }
}

/**
 * Extract the proposal's expected predecessor active id from `profile_body`.
 *
 * The Admin UI `updateProfile` flow populates `metadata.previous_version_id`
 * with the active version id observed at the time the proposal was authored.
 * `approveAndActivateAtomic` compares this against the freshly-locked
 * incumbent active id to detect write-skew (two stale proposals racing).
 *
 * Returns:
 *   - `string`     — explicit predecessor id from the proposal body
 *   - `null`       — explicit "no predecessor expected" (e.g., seed v1)
 *   - `'unknown'`  — `metadata.previous_version_id` is absent entirely. The
 *                    proposal predates this codepath; the caller's policy
 *                    decides whether to reject conservatively or accept.
 */
function readExpectedPredecessor(profile_body: unknown): string | null | 'unknown' {
  const md = (profile_body as { metadata?: Record<string, unknown> } | null)?.metadata;
  if (!md || !('previous_version_id' in md)) return 'unknown';
  const v = md.previous_version_id;
  if (v === null) return null;
  if (typeof v === 'string') return v;
  // Some other JSON type (number, boolean, object) — treat as legacy.
  return 'unknown';
}

/**
 * Detect whether a profile_body was backfilled by migration 061 (or any
 * other migration that stamps `metadata.migrated_from_legacy = true`).
 *
 * Codex Adversarial Review of PR #171 round 3 ([high] #173) — migration 061
 * writes `metadata.previous_version_id = null` (explicit) for every legacy
 * row backfilled from the four `core_immutable`/`operational_profile`/...
 * columns. Without a discriminator, `approveAndActivateAtomic`'s
 * predecessor check would accept that explicit `null` as "no predecessor
 * expected" (the same shape used for intentional seed v1) and a stale
 * migrated proposal could silently activate against an empty active slot.
 *
 * The migration stamps `metadata.migrated_from_legacy = true` alongside the
 * null predecessor; this helper exposes that marker to the approval path so
 * it can reject the ambiguous case (explicit null predecessor whose lineage
 * is actually unknown, NOT an intentional seed) with a distinct typed
 * sentinel.
 */
function isMigratedLegacy(profile_body: unknown): boolean {
  const md = (profile_body as { metadata?: Record<string, unknown> } | null)?.metadata;
  if (!md) return false;
  return md.migrated_from_legacy === true;
}

/**
 * Take a `FOR UPDATE` lock on the parent `agents` row for a given
 * `(tenant_id, agent_id)`. Held until the surrounding `withTx` commits.
 *
 * Returns `true` if the row exists (and is now locked), `false` if the
 * agent was deleted (or never existed) — caller decides whether that is a
 * typed-miss (`agent_missing: true`) or an error condition.
 *
 * Codex Adversarial Review of PR #171 round 3 ([medium]) — the parent-agent
 * lock target was previously only acquired by `acquireNextVersionForAgent`
 * (i.e. only by version allocators). `approveAndActivateAtomic` did NOT
 * take this lock, so a concurrent `seedNewActiveAtomic` (priorities
 * migration) and `approveAndActivateAtomic` could race on the active-row
 * freeze/insert: the partial unique index on (tenant, agent) WHERE
 * status='active' would roll one tx back, surfacing as a 500 instead of a
 * serialized update. Extracting the lock primitive into its own helper
 * lets every writer that touches active state share the same lock target.
 *
 * @param tx        the in-tx drizzle handle (caller MUST already be inside `withTx`)
 * @param tenant_id tenant slug — part of the lock predicate
 * @param agent_id  agent id (PK) — locked with FOR UPDATE
 */
async function lockParentAgent(
  tx: typeof db,
  tenant_id: string,
  agent_id: string,
): Promise<boolean> {
  const lock = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agent_id), eq(agents.tenant_id, tenant_id)))
    .for('update')
    .limit(1);
  return lock.length > 0;
}

/**
 * Shared per-agent version allocator for `agent_operational_profile_versions`.
 *
 * Codex Adversarial Review of PR #171 round 2 (issue #166 follow-up) — three
 * different writers allocate `version` via `MAX(version)+1`:
 *   - `operationalProfileVersionsRepo.create`        (proposal-generator)
 *   - `operationalProfileVersionsRepo.proposeAndAuditAtomic` (Admin UI)
 *   - `operationalProfileVersionsRepo.seedNewActiveAtomic`   (migration script)
 *
 * Until this helper, each writer chose its own lock strategy (none, agent row,
 * or active row), so a *mixed-allocator* race between e.g. an Admin UI propose
 * and the priorities migration could still read the same `MAX(version)` and
 * collide on `agent_op_profile_version_uq`.
 *
 * This helper centralizes the lock target on the parent `agents` row by PK +
 * tenant. All version allocators MUST go through it. The lock is held until
 * the surrounding tx commits/rollbacks, so subsequent `INSERT` lands behind
 * the same lock and the unique-index collision is impossible.
 *
 * Returns `null` if the parent agent was deleted (or never existed) — callers
 * translate that into their own typed-miss sentinel (`agent_missing: true`,
 * NOT_FOUND, etc.). Throws nothing of its own — surfacing as a Postgres error
 * only on lock acquisition failures (deadlock, statement_timeout).
 *
 * @param tx        the in-tx drizzle handle (caller must already be inside `withTx`)
 * @param tenant_id tenant slug — tested in both the lock predicate and MAX scope
 * @param agent_id  agent id (PK) — locked with FOR UPDATE
 */
async function acquireNextVersionForAgent(
  tx: typeof db,
  tenant_id: string,
  agent_id: string,
): Promise<number | null> {
  // (1) Lock the parent agent row via the shared `lockParentAgent` helper.
  //     PK + tenant_id avoids accidentally locking a same-id agent under a
  //     different tenant — defense-in-depth even though `agents.id` is
  //     globally unique today, because the schema contract is "id is unique
  //     per tenant". Sharing this primitive with `approveAndActivateAtomic`
  //     (Codex round 3) ensures every writer that touches active state OR
  //     allocates a version serializes on the same lock target.
  const locked = await lockParentAgent(tx, tenant_id, agent_id);
  if (!locked) return null;

  // (2) Read MAX(version) BEHIND the lock so concurrent allocators serialize.
  const maxRes = await tx.execute<{ max: number | null }>(sql`
    SELECT MAX(version) AS max
      FROM agent_operational_profile_versions
     WHERE tenant_id = ${tenant_id}
       AND agent_id = ${agent_id}
  `);
  const max = maxRes.rows[0]?.max ?? null;
  return max == null ? 1 : Number(max) + 1;
}

export {
  validateProfileBodyP8d,
  readExpectedPredecessor,
  isMigratedLegacy,
  lockParentAgent,
  acquireNextVersionForAgent,
};
