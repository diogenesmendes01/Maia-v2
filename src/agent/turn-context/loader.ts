/**
 * Issue #525 — the integrated `TurnContextLoader`.
 *
 * ## Why this file exists
 *
 * PR #524 (issue #511) built the machinery — `LoadedSection`, per-section
 * budgets with a real byte ceiling, the versioned tenant+agent cache, the
 * metrics vocabulary — but never wired it together: `prompt-builder.ts` still
 * imported thirteen repositories and interleaved I/O with string building. That
 * shape has three costs, and the round-trip count is only the cheapest of them:
 *
 *  1. **Nobody could render without a database.** Every prompt assertion in the
 *     suite had to stand up thirteen repository mocks, so the render rules were
 *     tested through an I/O harness that could (and did) hide lazy reads.
 *  2. **A "thin prompt" had no cause.** Sections that failed and sections that
 *     were genuinely empty produced the same bytes.
 *  3. **The read set was invisible.** Nothing enumerated what a turn reads, so
 *     nothing could budget it.
 *
 * This module is the single place a turn touches the database. It returns a
 * `TurnContextSnapshot`: fully-loaded, already-degraded-or-not state that
 * `renderTurnPrompt` turns into bytes with no further I/O — the renderer is a
 * SYNCHRONOUS function, which is what makes "no lazy I/O inside rendering" a
 * property of the type system instead of a review note.
 *
 * ## Tenant isolation (AGENTS.md §4.1, §4.2)
 *
 * The loader adds no scope of its own: every read below goes through a
 * repository that binds `(tenant_id, agent_id)` from the ALS context
 * (`src/db/tenant-context.ts`), and those getters THROW on a missing, empty or
 * `'default'` scope. Batching does not widen anything — a batched read is the
 * same predicate with an `IN (…)` on a non-identifying column, never a dropped
 * tenant predicate. That is the property `npm run test:leak` guards.
 *
 * Fail-closed is therefore inherited, not re-implemented: a turn without a
 * usable tenant/agent context cannot reach a single row, because the first
 * repository call raises `MissingTenantContextError` and the loader lets it
 * propagate. There is deliberately no `?? 'default'` anywhere in this file.
 *
 * ## Critical vs optional
 *
 * The split is preserved from the code this replaces, because it is a
 * correctness contract and not a performance one:
 *
 *  - **critical** (`Promise.all`): identity, history, entities, entity states,
 *    facts, rules. Each of these used to throw straight out of `buildPrompt`,
 *    and still does — the first rejection fails the turn.
 *  - **optional** (`Promise.allSettled`): memories, hints, capabilities, gaps,
 *    procedure. A failure degrades ITS OWN section, names it in
 *    `degraded_sections`, and leaves the others intact.
 *
 * The turn now waits for the SLOWEST read rather than the SUM of all of them.
 */
import {
  selfStateRepo,
  factsRepo,
  rulesRepo,
  mensagensRepo,
  entityStatesRepo,
  entidadesRepo,
  memoryEntryRepo,
  behavioralHintRepo,
  capabilitiesSkillRepo,
  capabilityGapsRepo,
  procedureExecutionsRepo,
  procedureDefinitionsRepo,
  operationalProfileVersionsRepo,
} from '@/db/repositories.js';
import type {
  AgentCapabilityGap,
  AgentCapabilitySkill,
  AgentFact,
  BehavioralHint,
  Entidade,
  EntityState,
  LearnedRule,
  MemoryEntry,
  Mensagem,
  ProcedureDefinition,
  ProcedureExecution,
  Role,
} from '@/db/schema.js';
import { renderOperationalProfile, type RenderedProfile } from '@/identity/profile-renderer.js';
import { logger } from '@/lib/logger.js';
import { GapLevel } from '@/types/enums.js';
import { readCached } from './cache.js';
import { recordSectionStatus, type TurnContextSection } from './metrics.js';
import { SECTION_BUDGETS, degraded, fromArray, loaded, empty, type LoadedSection } from './types.js';

/**
 * Everything the renderer needs to say who the agent is.
 *
 * `source` is derived OUTSIDE the cache on purpose: the cached payload keeps the
 * exact shape PR #524 stored, so integrating the loader does not force a
 * `TURN_CONTEXT_CACHE_VERSION` bump and a cold cache on every replica at deploy.
 */
export type IdentitySnapshot = {
  systemPromptBody: string;
  selfVersionLabel: string;
  resumoAprendizadosBody: string;
  source: 'operational_profile_v2' | 'self_state';
};

/** The cached half of identity — shape-compatible with the `v1` cache entry. */
type CachedIdentity = {
  systemPromptBody: string;
  selfVersionLabel: string;
  resumoAprendizadosBody: string;
};

export type ProcedureSnapshot = {
  execution: ProcedureExecution;
  definition: ProcedureDefinition;
} | null;

/**
 * Inputs the loader needs. A strict subset of `PromptContext`, declared here so
 * the loader does not depend on the renderer (the dependency runs one way:
 * `prompt-builder` → `loader`, never back).
 */
export type TurnContextRequest = {
  pessoa_id: string | undefined;
  conversa_id: string | undefined;
  entidade_ids: string[];
  current_role_id?: string | null;
  current_channel_id?: string | null;
  activeRole?: Role | null;
  /**
   * `undefined` = the caller did not look, so the loader looks (legacy/tests).
   * `null` = the caller looked and found nothing, so the loader skips the read
   * entirely. `core.ts` always passes one of the two, which is why the
   * procedure lookup is not a per-turn cost in production.
   */
  activeExecution?: ProcedureExecution | null;
};

/**
 * The turn's context, fully loaded.
 *
 * Every field is a `LoadedSection`, so `empty` and `degraded` can never be
 * confused by the renderer or by a dashboard — that distinction is the whole
 * reason the contract exists (`types.ts`).
 */
export type TurnContextSnapshot = {
  identity: LoadedSection<IdentitySnapshot>;
  history: LoadedSection<Mensagem[]>;
  entities: LoadedSection<Entidade[]>;
  entity_states: LoadedSection<EntityState[]>;
  facts: LoadedSection<AgentFact[]>;
  rules: LoadedSection<LearnedRule[]>;
  memories: LoadedSection<MemoryEntry[]>;
  hints: LoadedSection<BehavioralHint[]>;
  capabilities: LoadedSection<AgentCapabilitySkill[]>;
  /**
   * Gaps at `mentionable` OR `proposed`, from ONE read.
   *
   * Issue #525: this used to be two round-trips — `listByLevel('mentionable')`
   * for the self-awareness clause and `listByLevels([mentionable, proposed])`
   * for the "known limitations" section. The second is a strict superset of the
   * first, so the mentionable-only view is now a filter over these rows rather
   * than a second statement. Filtering preserves relative order, so the two
   * rendered blocks keep the bytes they had.
   */
  gaps: LoadedSection<AgentCapabilityGap[]>;
  role: LoadedSection<Role | null>;
  procedure: LoadedSection<ProcedureSnapshot>;
  /** Names only — never section CONTENT (issue #511 §Observabilidade). */
  degraded_sections: string[];
};

const DEFAULT_IDENTITY: IdentitySnapshot = {
  systemPromptBody: 'Você é a Maia.',
  selfVersionLabel: 'self_state_v0',
  resumoAprendizadosBody: '(vazio)',
  source: 'self_state',
};

/**
 * Load identity: the rendered ACTIVE operational profile v2, or the legacy
 * `self_state` row.
 *
 * The caching policy is inherited verbatim from PR #524 and is NOT relaxed
 * here. Only the profile-v2 branch is cacheable: every mutation that changes
 * what `operationalProfileVersionsRepo.getActive()` returns publishes an
 * invalidation after commit (`publishIdentityInvalidation` in
 * `src/db/repositories/profile-repos.ts`), and no path rewrites an active row's
 * `profile_body` in place. The `self_state` fallback has no such publisher —
 * `selfStateRepo.appendLearning` rewrites `resumo_aprendizados` from the
 * fire-and-forget reflection path — so it is read every turn.
 */
async function loadIdentity(): Promise<IdentitySnapshot> {
  const cached = await readCached<CachedIdentity>('identity', async () => {
    const profile = await operationalProfileVersionsRepo.getActive();
    if (profile && profile.status === 'active') {
      const rendered: RenderedProfile = renderOperationalProfile({ version: profile });
      return {
        systemPromptBody: rendered.system_prompt_block,
        selfVersionLabel: `op_profile_v${profile.version}`,
        resumoAprendizadosBody: '(perfil v2 ativo)',
      };
    }
    if (profile) {
      // Loaded but status !== 'active' — runtime defense against a slipped DB
      // invariant. Never expose a `proposed`/`frozen` profile; fall back to
      // self_state. Fires on a cache MISS only, so the negative TTL rate-limits
      // the log line.
      logger.warn(
        { has_profile: true, status: profile.status },
        'identity.profile_v2_invalid_fallback_to_self_state',
      );
    }
    return null;
  });

  if (cached) return { ...cached, source: 'operational_profile_v2' };

  const self = await selfStateRepo.getActive();
  return {
    systemPromptBody: self?.system_prompt ?? DEFAULT_IDENTITY.systemPromptBody,
    selfVersionLabel: `self_state_v${self?.versao ?? 0}`,
    resumoAprendizadosBody: self?.resumo_aprendizados ?? '(vazio)',
    source: 'self_state',
  };
}

/**
 * The hint scopes to ask for, in the order the batched query receives them.
 *
 * The "skip a tuple whose subject id is missing" rule lives here: an
 * interlocutor/conversation/role/channel tuple with no subject would otherwise
 * match EVERY hint of that scope type — a cross-subject read wearing a
 * convenience costume. `agent` is the one scope with a legitimately null
 * subject.
 */
function hintScopes(req: TurnContextRequest): Array<{ scope_type: string; subject_id?: string | null }> {
  return [
    { scope_type: 'interlocutor', subject_id: req.pessoa_id },
    { scope_type: 'conversation', subject_id: req.conversa_id },
    ...(req.current_role_id ? [{ scope_type: 'role', subject_id: req.current_role_id }] : []),
    ...(req.current_channel_id ? [{ scope_type: 'channel', subject_id: req.current_channel_id }] : []),
    { scope_type: 'agent', subject_id: null },
  ].filter((sq) => sq.scope_type === 'agent' || !!sq.subject_id);
}

/**
 * Entity rows plus their state rows, in ONE round-trip.
 *
 * Issue #525: the scope block ("## Escopo desta conversa", entity NAMES) and
 * the state block ("## Estado atual", balances) read the SAME entity set from
 * two tables joined on `entity_states.entidade_id = entidades.id`. One LEFT
 * JOIN answers both — see `entidadesRepo.byIdsWithState`.
 *
 * The `?.` fallback is not defensive programming for production (the method is
 * always there); it keeps the dozens of existing specs that stub only the old
 * `byIds` pair working against the real loader instead of forcing a mechanical
 * rewrite of every prompt fixture in the suite. Production always takes the
 * single-statement branch; the fallback costs two.
 */
async function loadEntitiesWithState(
  ids: string[],
): Promise<Array<{ entidade: Entidade; state: EntityState | null }>> {
  const joined = await entidadesRepo?.byIdsWithState?.(ids);
  if (joined) return joined;
  const [entities, states] = await Promise.all([
    entidadesRepo.byIds(ids),
    (async () => (await entityStatesRepo?.byIds?.(ids)) ?? [])(),
  ]);
  const stateById = new Map(states.map((s) => [s.entidade_id, s]));
  return entities.map((entidade) => ({ entidade, state: stateById.get(entidade.id) ?? null }));
}

async function loadProcedure(req: TurnContextRequest): Promise<ProcedureSnapshot> {
  if (!req.conversa_id) return null;
  const execution =
    req.activeExecution !== undefined
      ? req.activeExecution
      : ((await procedureExecutionsRepo?.findActiveForConversa?.(req.conversa_id)) ?? null);
  if (!execution) return null;
  const definition = (await procedureDefinitionsRepo?.findById?.(execution.definition_id)) ?? null;
  if (!definition) return null;
  return { execution, definition };
}

/**
 * Fan out one optional section. A rejection becomes a `degraded` LoadedSection
 * carrying the safe fallback the renderer will use, plus a NAMED entry in
 * `degraded_sections` — the failure is counted and named instead of vanishing
 * into an empty `catch`, which is what made a thin prompt un-diagnosable.
 */
async function optional<T>(
  section: TurnContextSection,
  fallback: T,
  load: () => Promise<T>,
  isEmpty: (value: T) => boolean,
  degradedSections: string[],
): Promise<LoadedSection<T>> {
  try {
    const value = await load();
    const status = isEmpty(value) ? 'empty' : 'loaded';
    recordSectionStatus(section, status);
    return status === 'empty' ? empty(value) : loaded(value);
  } catch (err) {
    const reason = (err as Error)?.message ?? 'unknown';
    degradedSections.push(section);
    recordSectionStatus(section, 'degraded');
    logger.warn({ section, err: reason }, 'turn_context.section_degraded');
    return degraded(fallback, reason);
  }
}

/**
 * Load everything a turn needs to render, in as few round-trips as the read set
 * allows.
 *
 * Round-trips for the typical turn (no active procedure), measured at the
 * repository boundary by `tests/unit/turn-context-round-trips.spec.ts`:
 *
 *   operational profile v2 active, `activeExecution` supplied by `core.ts`   9
 *   legacy `self_state` fallback, `activeExecution` supplied                10
 *   legacy `self_state` fallback, loader resolves the procedure itself      11
 *
 * Both are independent of scope size — the slope is zero, which is the property
 * that stops one "elephant" tenant from monopolising the fixed 10-connection
 * pool in `src/db/client.ts`.
 */
export async function loadTurnContext(req: TurnContextRequest): Promise<TurnContextSnapshot> {
  const degradedSections: string[] = [];

  // --- critical -------------------------------------------------------------
  // These five reads have no dependency on one another. `Promise.all` (not
  // `allSettled`) is deliberate: each one previously threw straight out of
  // `buildPrompt`, and that contract is preserved — the first rejection still
  // fails the turn. What changes is that the turn waits for the SLOWEST rather
  // than the SUM.
  //
  // `loadEntitiesWithState` replaces the per-entity `entityStatesRepo.byId`
  // loop that was the dominant N+1 of the turn — and, since #525, also the
  // second statement that read the same entity set for its state rows.
  const criticalPromise = Promise.all([
    loadIdentity(),
    mensagensRepo.recentInConversation(req.conversa_id!, SECTION_BUDGETS.history.max_items),
    loadEntitiesWithState(req.entidade_ids),
    // Scope strings are built in the SAME order as before the split — the
    // repository's result order feeds the rendered "## Fatos relevantes" block,
    // so reordering the argument would reorder the prompt.
    factsRepo.listMentionableForScopes([
      'global',
      `pessoa:${req.pessoa_id}`,
      ...req.entidade_ids.map((e) => `entidade:${e}`),
    ]),
    rulesRepo.listActive('classificacao'),
  ]);

  // --- optional -------------------------------------------------------------
  // Started BEFORE awaiting the critical group so the two groups overlap: the
  // turn pays the maximum latency of the whole read set, not the sum of two
  // phases. A rejection here can never reject the critical group, because each
  // is wrapped by `optional` before it is handed to `Promise.all`.
  const optionalPromise = Promise.all([
    optional(
      'memories',
      [] as MemoryEntry[],
      async () =>
        (await memoryEntryRepo?.findRelevant?.({
          interlocutor_id: req.pessoa_id,
          conversa_id: req.conversa_id,
          role_id: req.current_role_id ?? undefined,
          channel_id: req.current_channel_id ?? undefined,
          limit: SECTION_BUDGETS.memories.max_items,
        })) ?? [],
      (v) => v.length === 0,
      degradedSections,
    ),
    optional(
      'hints',
      [] as BehavioralHint[],
      async () => (await behavioralHintRepo?.findActiveForScopes?.(hintScopes(req))) ?? [],
      (v) => v.length === 0,
      degradedSections,
    ),
    optional(
      'capabilities',
      [] as AgentCapabilitySkill[],
      async () => (await capabilitiesSkillRepo?.listAll?.()) ?? [],
      (v) => v.length === 0,
      degradedSections,
    ),
    optional(
      'gaps',
      [] as AgentCapabilityGap[],
      async () =>
        (await capabilityGapsRepo?.listByLevels?.([GapLevel.MENTIONABLE, GapLevel.PROPOSED])) ?? [],
      (v) => v.length === 0,
      degradedSections,
    ),
    optional(
      'procedure',
      null as ProcedureSnapshot,
      () => loadProcedure(req),
      (v) => v === null,
      degradedSections,
    ),
  ]);

  const [identity, history, entityRows, facts, rules] = await criticalPromise;
  const [memories, hints, capabilities, gaps, procedure] = await optionalPromise;

  const entities = entityRows.map((r) => r.entidade);
  const entityStates = entityRows
    .map((r) => r.state)
    .filter((s): s is EntityState => s !== null);

  recordSectionStatus('identity', 'loaded');
  recordSectionStatus('history', history.length === 0 ? 'empty' : 'loaded');
  recordSectionStatus('entities', entities.length === 0 ? 'empty' : 'loaded');
  recordSectionStatus('entity_states', entityStates.length === 0 ? 'empty' : 'loaded');
  recordSectionStatus('facts', facts.length === 0 ? 'empty' : 'loaded');
  recordSectionStatus('rules', rules.length === 0 ? 'empty' : 'loaded');

  // The active role is already in hand (resolved by the channel/role selector
  // upstream), so it costs zero round-trips — but it is still a SECTION.
  // Its `maia_turn_context_section_total` sample is emitted by the RENDERER,
  // not here: whether the role produces a block depends on render-time gates
  // (default role, empty description AND addendum), so only the renderer knows
  // whether the section was really `loaded` or `empty`.
  const role: LoadedSection<Role | null> = req.activeRole
    ? loaded(req.activeRole)
    : empty(req.activeRole ?? null);

  if (degradedSections.length > 0) {
    // One structured line per turn carrying the degraded section NAMES only.
    logger.warn(
      { degraded_sections: degradedSections, conversa_id: req.conversa_id },
      'turn_context.degraded',
    );
  }

  return {
    identity: loaded(identity),
    history: fromArray(history),
    entities: fromArray(entities),
    entity_states: fromArray(entityStates),
    facts: fromArray(facts),
    rules: fromArray(rules),
    memories,
    hints,
    capabilities,
    gaps,
    role,
    procedure,
    degraded_sections: degradedSections,
  };
}

/**
 * Test seam: an all-empty snapshot a renderer test can start from, so a spec
 * about (say) the contradiction overlay does not have to stand up thirteen
 * repository mocks to reach the renderer. This is the practical payoff of the
 * loader/renderer split.
 */
export function emptyTurnContextSnapshot(
  overrides: Partial<TurnContextSnapshot> = {},
): TurnContextSnapshot {
  return {
    identity: loaded(DEFAULT_IDENTITY),
    history: empty([]),
    entities: empty([]),
    entity_states: empty([]),
    facts: empty([]),
    rules: empty([]),
    memories: empty([]),
    hints: empty([]),
    capabilities: empty([]),
    gaps: empty([]),
    role: empty(null),
    procedure: empty(null),
    degraded_sections: [],
    ...overrides,
  };
}
