/**
 * Issue #525 — the TurnContextLoader.
 *
 * ## What moved, and why
 *
 * Until now `prompt-builder.ts` did both jobs: it read the database and it
 * rendered the prompt, in one 1200-line file where the two were interleaved.
 * #511 stopped short of separating them deliberately, to avoid a half-finished
 * cutover in a file that big. This module is the other half.
 *
 * The loader produces a `TurnContextSnapshot` — everything the prompt needs, as
 * plain values — and the renderer consumes it. Two things fall out of that:
 *
 *   - the renderer became a PURE function of (context, snapshot). It imports no
 *     repository and issues no query, so a prompt-rendering test no longer has
 *     to stand up a fake database, and a rendering change can no longer smuggle
 *     in a new round-trip;
 *   - loading became one place, which is what made it possible to collapse 13
 *     round-trips into 4 (`src/db/repositories/turn-context-repos.ts`).
 *
 * ## The four loads, and their failure semantics
 *
 *   identity        1 query   CRITICAL   cacheable (`identity`)
 *   core            1 query   CRITICAL   history, entities+states, facts, rules
 *   enrichment      1 query   OPTIONAL   memories, hints, procedure
 *   self_awareness  1 query   OPTIONAL   skills, gaps — cacheable (`self_awareness`)
 *
 * CRITICAL means a failure fails the turn — the same contract the pre-#525
 * `Promise.all` had. OPTIONAL means a failure degrades its own sections and the
 * turn still renders — the same contract the pre-#525 `Promise.allSettled` had.
 *
 * A single statement cannot fail halfway, so a batch failure would coarsen
 * "this one section is unavailable" into "all three are". For the optional
 * batches that would be a real loss of signal — a migration that adds a column
 * to `memory_entry` would take the hint block down with it — so a failing
 * optional batch RETRIES per section through the individual repository methods.
 * The fast path costs one round-trip; only the failure path pays for isolation,
 * and it buys back exactly the granularity #511's `LoadedSection` exists to
 * express.
 *
 * ## Ordering and bytes
 *
 * The loader does not sort, filter or truncate. Budgets, sensitivity filters
 * and ordering stay in the renderer, unchanged, which is what makes the
 * byte-identity proof in `tests/unit/prompt-builder-golden.spec.ts` meaningful:
 * the rendering code is the same code, fed from a different place.
 */
import {
  turnContextRepo,
  memoryEntryRepo,
  behavioralHintRepo,
  capabilitiesSkillRepo,
  capabilityGapsRepo,
  procedureExecutionsRepo,
  procedureDefinitionsRepo,
  type TurnEntity,
  type TurnEntityState,
  type TurnFact,
  type TurnGap,
  type TurnHint,
  type TurnHistoryMessage,
  type TurnMemory,
  type TurnProcedure,
  type TurnProcedureDefinition,
  type TurnRule,
  type TurnSkill,
} from '@/db/repositories.js';
import type { AgentOperationalProfileVersion, ProcedureExecution } from '@/db/schema.js';
import { renderOperationalProfile } from '@/identity/profile-renderer.js';
import { logger } from '@/lib/logger.js';
import { GapLevel } from '@/types/enums.js';
import { readCached } from './cache.js';
import { recordSectionStatus, type TurnContextSection } from './metrics.js';
import { degraded, fromArray, loaded, SECTION_BUDGETS, type LoadedSection } from './types.js';

/** The three strings the `## Sobre você` block renders. */
export type IdentityView = {
  systemPromptBody: string;
  selfVersionLabel: string;
  resumoAprendizadosBody: string;
};

export type TurnContextSnapshot = {
  identity: IdentityView;
  history: TurnHistoryMessage[];
  entities: TurnEntity[];
  entity_states: TurnEntityState[];
  facts: TurnFact[];
  rules: TurnRule[];
  memories: LoadedSection<TurnMemory[]>;
  hints: LoadedSection<TurnHint[]>;
  skills: LoadedSection<TurnSkill[]>;
  /** `mentionable` + `proposed`; the self-awareness block filters to the former. */
  gaps: LoadedSection<TurnGap[]>;
  procedure: LoadedSection<TurnProcedure | null>;
  /** Section names that failed to load and rendered a fallback. */
  degraded_sections: string[];
};

export type TurnContextRequest = {
  pessoa_id: string;
  conversa_id: string;
  entidades: string[];
  current_role_id?: string | null;
  current_channel_id?: string | null;
  /**
   * `undefined` = the caller did not look for a running procedure;
   * `null` = the caller looked and found none;
   * a row = the caller already has it and only the definition is missing.
   */
  activeExecution?: ProcedureExecution | null;
};

/** The gap levels the prompt can render, across both blocks. */
const PROMPT_GAP_LEVELS: GapLevel[] = [GapLevel.MENTIONABLE, GapLevel.PROPOSED];

const EMPTY_IDENTITY: IdentityView = {
  systemPromptBody: 'Você é a Maia.',
  selfVersionLabel: 'self_state_v0',
  resumoAprendizadosBody: '(vazio)',
};

export async function loadTurnContext(req: TurnContextRequest): Promise<TurnContextSnapshot> {
  const degradedSections: string[] = [];

  // The four loads are independent, so they run concurrently. `core` and
  // `identity` are awaited as rejections (they fail the turn); the two optional
  // ones resolve to a `LoadedSection` carrying their own failure.
  const [identity, core, enrichment, selfAwareness] = await Promise.all([
    loadIdentity(),
    turnContextRepo.loadCore({
      conversa_id: req.conversa_id,
      history_limit: SECTION_BUDGETS.history.max_items,
      entidade_ids: req.entidades,
      fact_scopes: [
        'global',
        `pessoa:${req.pessoa_id}`,
        ...req.entidades.map((e) => `entidade:${e}`),
      ],
      rules_tipo: 'classificacao',
    }),
    loadEnrichment(req, degradedSections),
    loadSelfAwareness(degradedSections),
  ]);

  return {
    identity,
    history: core.history,
    entities: core.entities,
    entity_states: core.entity_states,
    facts: core.facts,
    rules: core.rules,
    memories: enrichment.memories,
    hints: enrichment.hints,
    procedure: enrichment.procedure,
    skills: selfAwareness.skills,
    gaps: selfAwareness.gaps,
    degraded_sections: degradedSections,
  };
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/**
 * The operational profile v2, or the legacy `self_state` fallback.
 *
 * Only the v2 branch is cached, and that asymmetry is deliberate (it is the
 * conclusion #511's round-2 review reached and this issue keeps):
 * `selfStateRepo.appendLearning` rewrites `resumo_aprendizados` from the
 * fire-and-forget reflection path with NO publisher, so a cached copy could go
 * stale on another replica until the TTL.
 *
 * "No active profile v2" is deliberately NOT negative-cached either. The
 * negative answer forces the uncacheable `self_state` read anyway, so an entry
 * would save nothing while adding a staleness window — see `cache_absent` in
 * `cache.ts`. Because of that, a cache HIT always carries a v2 view, which is
 * why the fallback below can assume the loader ran.
 */
async function loadIdentity(): Promise<IdentityView> {
  let rows: Awaited<ReturnType<typeof turnContextRepo.loadIdentity>> | null = null;

  const cached = await readCached<IdentityView>(
    'identity',
    async () => {
      rows = await turnContextRepo.loadIdentity();
      const profile = rows.profile as AgentOperationalProfileVersion | null;
      if (profile && profile.status === 'active') {
        const rendered = renderOperationalProfile({ version: profile });
        return {
          systemPromptBody: rendered.system_prompt_block,
          selfVersionLabel: `op_profile_v${profile.version}`,
          resumoAprendizadosBody: '(perfil v2 ativo)',
        };
      }
      if (profile) {
        // Loaded but status !== 'active' — runtime defense; the DB invariant
        // should make this unreachable. Never expose a proposed/frozen persona.
        logger.warn(
          { has_profile: true, status: profile.status },
          'identity.profile_v2_invalid_fallback_to_self_state',
        );
      }
      return null;
    },
    undefined,
    { cache_absent: false },
  );

  if (cached) {
    recordSectionStatus('identity', 'loaded');
    return cached;
  }

  // Unreachable in practice: a `null` here means the loader ran (nothing
  // negative is cached), so `rows` is set. The re-read is a belt-and-braces
  // branch rather than a second round-trip on any live path.
  const resolved = rows ?? (await turnContextRepo.loadIdentity());
  const self = resolved.self;
  recordSectionStatus('identity', self ? 'loaded' : 'empty');
  if (!self) return EMPTY_IDENTITY;
  return {
    systemPromptBody: self.system_prompt ?? 'Você é a Maia.',
    selfVersionLabel: `self_state_v${self.versao ?? 0}`,
    resumoAprendizadosBody: self.resumo_aprendizados ?? '(vazio)',
  };
}

// ---------------------------------------------------------------------------
// optional batches
// ---------------------------------------------------------------------------

type EnrichmentSections = {
  memories: LoadedSection<TurnMemory[]>;
  hints: LoadedSection<TurnHint[]>;
  procedure: LoadedSection<TurnProcedure | null>;
};

async function loadEnrichment(
  req: TurnContextRequest,
  degradedSections: string[],
): Promise<EnrichmentSections> {
  const hintScopes = [
    { scope_type: 'interlocutor', subject_id: req.pessoa_id },
    { scope_type: 'conversation', subject_id: req.conversa_id },
    ...(req.current_role_id ? [{ scope_type: 'role', subject_id: req.current_role_id }] : []),
    ...(req.current_channel_id
      ? [{ scope_type: 'channel', subject_id: req.current_channel_id }]
      : []),
    { scope_type: 'agent', subject_id: null as string | null },
  ].filter((sq) => sq.scope_type === 'agent' || !!sq.subject_id);

  const procedureMode = resolveProcedureMode(req);

  try {
    const rows = await turnContextRepo.loadEnrichment({
      interlocutor_id: req.pessoa_id,
      conversa_id: req.conversa_id,
      role_id: req.current_role_id ?? undefined,
      channel_id: req.current_channel_id ?? undefined,
      memory_limit: SECTION_BUDGETS.memories.max_items,
      hint_scopes: hintScopes,
      procedure: procedureMode,
    });
    return {
      memories: section('memories', fromArray(rows.memories)),
      hints: section('hints', fromArray(rows.hints)),
      procedure: section('procedure', loaded(mergeProcedure(req, rows.procedure))),
    };
  } catch (err) {
    // The batch is one statement, so one failure took all three sections with
    // it. Retry per section so the failure is attributed to the section that
    // actually broke — the granularity the pre-#525 `allSettled` had.
    logger.warn(
      { err: (err as Error)?.message },
      'turn_context.enrichment_batch_failed_retrying_per_section',
    );
    const [memories, hints, procedure] = await Promise.allSettled([
      memoryEntryRepo.findRelevant({
        interlocutor_id: req.pessoa_id,
        conversa_id: req.conversa_id,
        role_id: req.current_role_id ?? undefined,
        channel_id: req.current_channel_id ?? undefined,
        limit: SECTION_BUDGETS.memories.max_items,
      }),
      behavioralHintRepo.findActiveForScopes(hintScopes),
      loadProcedureIndividually(req, procedureMode),
    ]);
    return {
      memories: settledSection('memories', memories, [], degradedSections, (v) => fromArray(v)),
      hints: settledSection('hints', hints, [], degradedSections, (v) => fromArray(v)),
      procedure: settledSection('procedure', procedure, null, degradedSections, (v) => loaded(v)),
    };
  }
}

async function loadSelfAwareness(
  degradedSections: string[],
): Promise<{ skills: LoadedSection<TurnSkill[]>; gaps: LoadedSection<TurnGap[]> }> {
  try {
    const rows = await readCached('self_awareness', () =>
      turnContextRepo.loadSelfAwareness(PROMPT_GAP_LEVELS),
    );
    return {
      skills: section('capabilities', fromArray(rows?.skills ?? [])),
      gaps: section('gaps', fromArray(rows?.gaps ?? [])),
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message },
      'turn_context.self_awareness_batch_failed_retrying_per_section',
    );
    const [skills, gaps] = await Promise.allSettled([
      capabilitiesSkillRepo.listAll(),
      capabilityGapsRepo.listByLevels(PROMPT_GAP_LEVELS),
    ]);
    return {
      skills: settledSection('capabilities', skills, [], degradedSections, (v) => fromArray(v)),
      gaps: settledSection('gaps', gaps, [], degradedSections, (v) => fromArray(v)),
    };
  }
}

// ---------------------------------------------------------------------------
// procedure plumbing
// ---------------------------------------------------------------------------

function resolveProcedureMode(
  req: TurnContextRequest,
):
  | { mode: 'skip' }
  | { mode: 'lookup'; conversa_id: string }
  | { mode: 'definition_only'; definition_id: string } {
  if (!req.conversa_id) return { mode: 'skip' };
  if (req.activeExecution === undefined) return { mode: 'lookup', conversa_id: req.conversa_id };
  if (req.activeExecution === null) return { mode: 'skip' };
  return { mode: 'definition_only', definition_id: req.activeExecution.definition_id };
}

/**
 * In `definition_only` mode the statement cannot know the execution the caller
 * already holds, so it returns `execution: null` and this stitches the two
 * halves back together.
 */
function mergeProcedure(
  req: TurnContextRequest,
  rows: TurnProcedure | null,
): TurnProcedure | null {
  if (!rows) return null;
  if (rows.execution) return rows;
  const exec = req.activeExecution;
  if (!exec) return null;
  return {
    execution: {
      id: exec.id,
      definition_id: exec.definition_id,
      current_step_id: exec.current_step_id,
      execution_state: exec.execution_state,
    },
    definition: rows.definition,
  };
}

/** The per-section retry for the procedure, using the pre-#525 two reads. */
async function loadProcedureIndividually(
  req: TurnContextRequest,
  mode: ReturnType<typeof resolveProcedureMode>,
): Promise<TurnProcedure | null> {
  if (mode.mode === 'skip') return null;
  const exec =
    mode.mode === 'lookup'
      ? await procedureExecutionsRepo.findActiveForConversa(mode.conversa_id)
      : (req.activeExecution ?? null);
  if (!exec) return null;
  const def = await procedureDefinitionsRepo.findById(exec.definition_id);
  return {
    execution: {
      id: exec.id,
      definition_id: exec.definition_id,
      current_step_id: exec.current_step_id,
      execution_state: exec.execution_state,
    },
    definition: def
      ? ({
          id: def.id,
          nome: def.nome,
          version_number: def.version_number,
          // `steps` / `success_criteria` are `jsonb` columns: untyped at the
          // schema level, given their shape by the renderer. The batched read
          // projects the same two columns, so both paths agree.
          steps: def.steps,
          success_criteria: def.success_criteria,
        } as unknown as TurnProcedureDefinition)
      : null,
  };
}

// ---------------------------------------------------------------------------
// metering helpers
// ---------------------------------------------------------------------------

function section<T>(name: TurnContextSection, s: LoadedSection<T>): LoadedSection<T> {
  recordSectionStatus(name, s.status);
  return s;
}

function settledSection<T>(
  name: TurnContextSection,
  outcome: PromiseSettledResult<T>,
  fallback: T,
  degradedSections: string[],
  wrap: (v: T) => LoadedSection<T>,
): LoadedSection<T> {
  if (outcome.status === 'fulfilled') return section(name, wrap(outcome.value));
  const reason = (outcome.reason as Error)?.message ?? 'unknown';
  degradedSections.push(name);
  recordSectionStatus(name, 'degraded');
  logger.warn({ section: name, err: reason }, 'turn_context.section_degraded');
  return degraded(fallback, reason);
}
