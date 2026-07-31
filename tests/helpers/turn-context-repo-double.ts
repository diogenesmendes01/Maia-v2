/**
 * Issue #525 — adapter that lets the pre-existing prompt-builder specs keep
 * describing the world SECTION BY SECTION.
 *
 * Those specs predate the loader: each one mocks `@/db/repositories.js` with a
 * bag of per-section fakes (`factsRepo.listMentionableForScopes`,
 * `capabilityGapsRepo.listByLevel`, …) because that is what `prompt-builder.ts`
 * used to call. The builder now calls four batched `turnContextRepo` methods
 * instead.
 *
 * Rewriting every spec to hand-build batched payloads would have thrown away
 * what they actually test — rendering behaviour — and replaced it with fixture
 * plumbing. This adapter composes a `turnContextRepo` out of the fakes the spec
 * already declares, so the specs keep their vocabulary and still exercise the
 * real loader and the real renderer.
 *
 * It is a TEST double, not a production fallback: production has exactly one
 * loading path, the batched one.
 */

type Maybe<T> = T | undefined;

export type SectionRepoBag = {
  operationalProfileVersionsRepo?: { getActive?: () => Promise<unknown> };
  selfStateRepo?: { getActive?: () => Promise<unknown> };
  mensagensRepo?: { recentInConversation?: (conversa_id: string, n: number) => Promise<unknown[]> };
  entidadesRepo?: { byIds?: (ids: string[]) => Promise<unknown[]> };
  entityStatesRepo?: { byIds?: (ids: string[]) => Promise<unknown[]> };
  factsRepo?: { listMentionableForScopes?: (escopos: string[]) => Promise<unknown[]> };
  rulesRepo?: { listActive?: (tipo: string) => Promise<unknown[]> };
  memoryEntryRepo?: { findRelevant?: (opts: unknown) => Promise<unknown[]> };
  behavioralHintRepo?: {
    findActiveForScopes?: (scopes: unknown[]) => Promise<unknown[]>;
  };
  capabilitiesSkillRepo?: { listAll?: () => Promise<unknown[]> };
  capabilityGapsRepo?: {
    listByLevel?: (level: string) => Promise<unknown[]>;
    listByLevels?: (levels: string[]) => Promise<unknown[]>;
  };
  procedureExecutionsRepo?: {
    findActiveForConversa?: (conversa_id: string) => Promise<unknown>;
  };
  procedureDefinitionsRepo?: { findById?: (id: string) => Promise<unknown> };
};

async function call<T>(fn: Maybe<(...a: never[]) => Promise<T>>, ...args: unknown[]): Promise<T | null> {
  if (typeof fn !== 'function') return null;
  return (await fn(...(args as never[]))) ?? null;
}

async function list(fn: Maybe<(...a: never[]) => Promise<unknown[]>>, ...args: unknown[]) {
  return (await call(fn, ...args)) ?? [];
}

export function turnContextRepoDouble(bag: SectionRepoBag) {
  return {
    async loadIdentity() {
      return {
        profile: await call(bag.operationalProfileVersionsRepo?.getActive),
        self: await call(bag.selfStateRepo?.getActive),
      };
    },

    async loadCore(args: {
      conversa_id: string;
      history_limit: number;
      entidade_ids: string[];
      fact_scopes: string[];
      rules_tipo: string;
    }) {
      const [history, entities, entity_states, facts, rules] = await Promise.all([
        list(bag.mensagensRepo?.recentInConversation, args.conversa_id, args.history_limit),
        args.entidade_ids.length ? list(bag.entidadesRepo?.byIds, args.entidade_ids) : [],
        args.entidade_ids.length ? list(bag.entityStatesRepo?.byIds, args.entidade_ids) : [],
        args.fact_scopes.length
          ? list(bag.factsRepo?.listMentionableForScopes, args.fact_scopes)
          : [],
        list(bag.rulesRepo?.listActive, args.rules_tipo),
      ]);
      return { history, entities, entity_states, facts, rules };
    },

    async loadEnrichment(args: {
      interlocutor_id?: string;
      conversa_id?: string;
      role_id?: string;
      channel_id?: string;
      memory_limit: number;
      hint_scopes: unknown[];
      procedure:
        | { mode: 'skip' }
        | { mode: 'lookup'; conversa_id: string }
        | { mode: 'definition_only'; definition_id: string };
    }) {
      const memories = await list(bag.memoryEntryRepo?.findRelevant, {
        interlocutor_id: args.interlocutor_id,
        conversa_id: args.conversa_id,
        role_id: args.role_id,
        channel_id: args.channel_id,
        limit: args.memory_limit,
      });
      const hints = args.hint_scopes.length
        ? await list(bag.behavioralHintRepo?.findActiveForScopes, args.hint_scopes)
        : [];

      let procedure: unknown = null;
      if (args.procedure.mode !== 'skip') {
        const execution =
          args.procedure.mode === 'lookup'
            ? ((await call(
                bag.procedureExecutionsRepo?.findActiveForConversa,
                args.procedure.conversa_id,
              )) as { definition_id?: string } | null)
            : null;
        const definition_id =
          args.procedure.mode === 'definition_only'
            ? args.procedure.definition_id
            : execution?.definition_id;
        if (definition_id) {
          const definition = await call(bag.procedureDefinitionsRepo?.findById, definition_id);
          procedure = { execution, definition };
        }
      }
      return { memories, hints, procedure };
    },

    async loadSelfAwareness(levels: string[]) {
      const skills = await list(bag.capabilitiesSkillRepo?.listAll);
      // Prefer the plural read (what the loader asks for). Specs that only
      // stubbed the singular one get the union assembled level by level, which
      // is the same set the plural query returns.
      const gaps = bag.capabilityGapsRepo?.listByLevels
        ? await list(bag.capabilityGapsRepo.listByLevels, levels)
        : (
            await Promise.all(levels.map((l) => list(bag.capabilityGapsRepo?.listByLevel, l)))
          ).flat();
      return { skills, gaps };
    },
  };
}
