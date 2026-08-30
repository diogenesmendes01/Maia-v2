/**
 * Issue #511 — typed contract for turn-context loading.
 *
 * The problem this replaces: every optional block of the prompt builder was a
 * bare `try { … } catch { /* degrade *\/ }`. That preserves availability, which
 * is right, but it makes six very different situations indistinguishable to the
 * operator looking at a thin prompt:
 *
 *   legitimately empty · timed out · query failed · stale cache ·
 *   repository unavailable · omitted by budget
 *
 * `LoadedSection` forces the difference to be carried in the value instead of
 * being thrown away, so `empty` and `degraded` can never be confused again.
 */

export type SectionSource = 'db' | 'cache';

export type LoadedSection<T> =
  /** Loaded successfully. `truncated` counts items dropped by the budget. */
  | { status: 'loaded'; value: T; source: SectionSource; truncated: number }
  /** Loaded successfully and there was genuinely nothing there. */
  | { status: 'empty'; value: T }
  /** The load failed. `value` is the safe fallback the caller renders instead. */
  | { status: 'degraded'; value: T; reason: string };

export function loaded<T>(
  value: T,
  opts: { source?: SectionSource; truncated?: number } = {},
): LoadedSection<T> {
  return {
    status: 'loaded',
    value,
    source: opts.source ?? 'db',
    truncated: opts.truncated ?? 0,
  };
}

export function empty<T>(value: T): LoadedSection<T> {
  return { status: 'empty', value };
}

export function degraded<T>(value: T, reason: string): LoadedSection<T> {
  return { status: 'degraded', value, reason };
}

/**
 * Wrap an array result: an empty array is `empty`, not `loaded`. The
 * distinction is the whole point — "no memories for this person" and "the
 * memory read failed" must not render the same way in a dashboard.
 */
export function fromArray<T>(
  items: T[],
  opts: { source?: SectionSource; truncated?: number } = {},
): LoadedSection<T[]> {
  return items.length === 0 && !opts.truncated ? empty(items) : loaded(items, opts);
}

/**
 * Per-section limits.
 *
 * `max_items` values reproduce the caps that were previously hard-coded inline
 * (`facts.slice(0, 20)`, `topSkills.slice(0, 5)`, `findRelevant({limit: 30})`,
 * …) — this commit does not change WHAT gets cut, it makes the cut visible and
 * gives it a byte ceiling as well.
 *
 * `max_bytes` is the new half. An item cap alone does not bound the prompt: 20
 * facts whose values are 50 KB blobs is still 1 MB of context, and nothing
 * stopped one tenant from producing it. The byte ceiling is what makes a single
 * tenant unable to generate an unbounded prompt (issue §6).
 *
 * Policy/permission blocks are DELIBERATELY absent from this table: the scope
 * block, the LLM boundaries and the input-handling rules are never truncated,
 * because silently dropping a security rule would be a governance failure
 * wearing a performance costume (issue §6, "nunca truncar silenciosamente
 * policies/permissions").
 */
export type SectionBudget = { max_items: number; max_bytes: number };

export const SECTION_BUDGETS = {
  history: { max_items: 10, max_bytes: 24_000 },
  facts: { max_items: 20, max_bytes: 8_000 },
  rules: { max_items: 20, max_bytes: 8_000 },
  memories: { max_items: 30, max_bytes: 8_000 },
  hints: { max_items: 20, max_bytes: 4_000 },
  capabilities: { max_items: 5, max_bytes: 2_000 },
  gaps: { max_items: 5, max_bytes: 2_000 },
  // #638 (fatia C da épica #471) — o aviso "isto você JÁ consegue", para os
  // gaps que fecharam porque a ferramenta pedida passou a existir e a estar
  // concedida. Orçamento pequeno de propósito: é notícia, não estado — três
  // itens e 1 KB bastam para dizer o fato, e o teto impede que uma leva de
  // ferramentas novas coma o contexto do turno.
  capacidades_novas: { max_items: 3, max_bytes: 1_000 },
  entity_states: { max_items: 100, max_bytes: 8_000 },
} as const satisfies Record<string, SectionBudget>;

export type BudgetedSection = keyof typeof SECTION_BUDGETS;

/**
 * Issue #525 — the TURN's round-trip ceiling, counted in SQL STATEMENTS for a
 * typical turn (one entity in scope, no active procedure).
 *
 * This constant is the budget, and two specs enforce it:
 * `tests/unit/turn-context-round-trips.spec.ts` counts repository CALLS and
 * names the read set; `tests/unit/turn-context-statement-count.spec.ts` counts
 * the STATEMENTS that would have gone down a real socket (only `pg` is faked).
 * A budget nothing fails on is a wish, and the whole point of #511/#525 is that
 * the turn's cost stops being a wish.
 *
 * "Whole turn" means `resolveScope` + `buildPrompt`. It deliberately counts the
 * procedure-execution lookup even though `core.ts` normally supplies it — the
 * read happens once per turn either way, and moving a query to a different
 * caller is not an optimisation.
 *
 * Current composition (legacy `self_state` path, the most expensive one):
 *
 *   resolveScope: permissoes ⋈ permission_profiles (um JOIN)             1
 *   identity: operationalProfileVersionsRepo.getActive                   1
 *   identity: selfStateRepo.getActive (fallback branch only)             1
 *   mensagensRepo.recentInConversation                                   1
 *   entidadesRepo.byIdsWithState (entities ⋈ states, one statement)      1
 *   factsRepo.listMentionableForScopes                                   1
 *   rulesRepo.listActive                                                 1
 *   memoryEntryRepo.findRelevant                                         1
 *   behavioralHintRepo.findActiveForScopes                               1
 *   capabilitiesSkillRepo.listAll                                        1
 *   capabilityGapsRepo.listParaOTurno (serves BOTH gap blocks)           1
 *   procedureExecutionsRepo.findActiveForConversa                        1
 *                                                                       --
 *                                                                       12
 *
 * Every one of these is independent of scope size: the slope is zero, so an
 * "elephant" tenant's turn costs the same as anyone else's.
 *
 * Zero slope is NOT, on its own, what protects the fixed 10-connection pool in
 * `src/db/client.ts` — a bounded read set issued all at once still empties the
 * pool. That is a separate ceiling, `TURN_CONTEXT_MAX_CONCURRENT_READS` below.
 */
export const TURN_ROUND_TRIP_BUDGET = 12;

/**
 * Issue #525 (PR #541 review, finding 1) — how many of those round-trips ONE
 * turn may have in flight at the same instant.
 *
 * The round-trip budget above bounds the turn's TOTAL cost; it says nothing
 * about how much of the shared pool a single turn may hold while paying it.
 * Those are different failure modes, and #525 fixed the first while opening the
 * second: the critical group (5) and the optional group (5) are both started
 * before either is awaited, so a cold-cache turn with an active procedure issued
 * up to TEN statements in one tick against `max: 10` in `src/db/client.ts`. One
 * turn could hold every connection in the process, and every other turn — of
 * every other tenant — queued behind it. A latency win for one turn paid for by
 * p95 tail for all of them is not a win.
 *
 * Six is not a new number: it is the ceiling the pre-#525 code enforced and
 * documented ("six concurrent reads against a 10-connection pool is a
 * deliberate ceiling — enough to collapse the waterfall, not enough for one
 * turn to starve the pool for everyone else"). #525 removed it without
 * replacing it; this restores it as a SHARED gate over critical + optional,
 * which is strictly stronger than the old per-group version.
 *
 * Why 6 of 10 specifically:
 *   - it is a strict majority, so a single turn still collapses the waterfall
 *     essentially completely — the read set is 10 tasks, so the turn pays about
 *     two waves rather than ten sequential round-trips;
 *   - it leaves 4 connections for everything else in the process (a second
 *     turn's critical group, the readiness probe, a worker), so no turn can
 *     starve the pool on its own;
 *   - it is enforced per TURN, not per process: bounding one turn's blast
 *     radius is the point, and a process-wide gate would just move the queue
 *     from the pool (which has `connectionTimeoutMillis`) into the app (which
 *     would not).
 *
 * Changing this number without changing `max` in `src/db/client.ts` changes how
 * much of the pool one tenant can take, so the two belong in the same review.
 * `tests/integration/turn-context-pool-fairness.spec.ts` measures the real peak
 * against a real pool and fails if the ceiling stops holding.
 */
export const TURN_CONTEXT_MAX_CONCURRENT_READS = 6;

/**
 * A meta que a issue #525 estabelece: ≤8. **NÃO atingida, e a razão foi MEDIDA,
 * não estimada.**
 *
 * Chegar a 8 é possível e foi implementado: as cinco fusões que faltavam
 * (`permissoes ⋈ permission_profiles`, `operational_profile_versions ∪
 * self_state`, `agent_facts ∪ learned_rules`, `memory_entry ∪ behavioral_hint`,
 * `agent_capabilities_skill ∪ agent_capability_gaps`) produzem exatamente oito
 * statements, com o prompt byte-idêntico e o escopo por tenant+agent intacto.
 * Quatro delas foram DESFEITAS porque o benchmark reprovou o resultado: o p95 da
 * carga de contexto TRIPLICOU.
 *
 * O mecanismo, medido em `docs/architecture/modules/agent.md` § "O que custa um
 * round-trip, e o que custa fundir dois":
 *
 *  1. um round-trip vazio custa ~0,15 ms; um statement do turno custa
 *     0,4–1,2 ms. A ida ao banco é a menor parte do preço de uma leitura;
 *  2. desde a #525 as leituras saem CONCORRENTES sob o portão de 6 permissões,
 *     então o turno paga o MÁXIMO do conjunto, não a soma. Reduzir a CONTAGEM
 *     abaixo do teto de concorrência não encurta o caminho crítico;
 *  3. um `UNION ALL` de dois ramos custa mais para PLANEJAR que qualquer um
 *     deles sozinho — cerca de 4× o pior ramo, medido com `EXPLAIN` em
 *     `tests/integration/turn-context-custo-de-fundir-real-db.spec.ts`, que
 *     reprova se a conta se inverter —, então a fusão alonga justamente o
 *     `max()` que define a latência do turno.
 *
 * A única fusão que sobreviveu é a do `resolveScope`, e ela sobreviveu porque
 * aquelas duas leituras eram SEQUENCIAIS (a segunda precisava dos `profile_id`
 * da primeira): trocar duas idas em série por uma ida só encurta o caminho
 * crítico de verdade — 1,46 ms → 0,97 ms de p50 com uma entidade em escopo
 * (`tests/integration/turn-context-escopo-real-db.spec.ts`).
 *
 * Ou seja: a contagem de round-trips deixou de medir o que ela media quando a
 * #511 a escolheu. Enquanto as leituras eram SEQUENCIAIS, contagem e latência
 * andavam juntas; desde que passaram a ser concorrentes e limitadas, a contagem
 * virou proxy de nada. Baixar de 12 para 8 é possível e é pior.
 *
 * Mantida como constante (e não apagada) porque a meta é do dono, não do código:
 * `tests/unit/turn-context-round-trips.spec.ts` afirma a DISTÂNCIA exata entre o
 * orçamento e a meta, para que ela não seja arredondada para "perto o bastante"
 * nem em silêncio declarada cumprida.
 */
export const TURN_ROUND_TRIP_TARGET = 8;

/**
 * Item cap for the gap list inside the self-awareness ("## Autoconhecimento")
 * section — the "Ainda não tem: …" clause.
 *
 * The `capabilities` budget has TWO contributing lists with different natural
 * sizes: skill names (short identifiers) and capability descriptions (free-form
 * sentences). They share one `max_bytes` ceiling — that is what makes the
 * SECTION bounded rather than just one of its clauses — but each gets its own
 * item cap, because "5 skills" and "3 gaps" are independent editorial choices.
 */
export const SELF_AWARENESS_GAP_MAX_ITEMS = 3;

/**
 * #638 — por quantos dias um gap FECHADO continua sendo anunciado ao agente
 * como capacidade recém-adquirida.
 *
 * Existe uma janela porque o aviso é NOTÍCIA, não estado permanente: passado
 * esse prazo a ferramenta é só mais uma tool na caixa do agente, e repetir o
 * anúncio para sempre gastaria contexto em todo turno para sempre. Sete dias é
 * a folga entre um deploy e o primeiro turno em que o assunto volte a aparecer
 * numa conversa real — curto o bastante para não virar mobília, longo o
 * bastante para um agente pouco usado receber o aviso pelo menos uma vez.
 *
 * A janela também é o que permite a leitura ÚNICA do turno: os gaps abertos e
 * os recém-fechados saem do mesmo `SELECT` (`capabilityGapsRepo.listParaOTurno`),
 * sem custar uma segunda ida ao banco no caminho mais quente do sistema.
 */
export const JANELA_DE_AVISO_DE_CAPACIDADE_DIAS = 7;

/** Roll-up published once per turn, and logged with the trace id. */
export type TurnContextDiagnostics = {
  query_count: number;
  duration_ms: number;
  cache_hits: number;
  /** Sections that failed to load and rendered a fallback. */
  degraded_sections: string[];
  /** Sections the budget cut, with how many items were dropped. */
  truncated_sections: Array<{ section: string; dropped: number; reason: string }>;
};
