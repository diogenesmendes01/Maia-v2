/**
 * Issue #525 — the batched reads behind the turn-context loader.
 *
 * ## Why this module exists
 *
 * #511 removed the N+1s: the turn stopped costing one query per entity and one
 * per hint scope, so the cost became CONSTANT in scope size. What it did not do
 * is make the constant small. A typical turn still paid 13 prompt round-trips
 * plus 2 for scope resolution, against the fixed 10-connection pool in
 * `src/db/client.ts`. Fifteen sequential-ish round-trips before the first LLM
 * token is fifteen chances to queue behind someone else's turn.
 *
 * The reads are INDEPENDENT of one another, so the only thing separating them
 * was that they were written as separate statements. This module composes them
 * into four statements — grouped by failure semantics, not by table:
 *
 *   `loadIdentity`      1 statement  who the agent is            (critical, cacheable)
 *   `loadCore`          1 statement  history, scope, knowledge    (critical)
 *   `loadEnrichment`    1 statement  memories, hints, procedure   (optional)
 *   `loadSelfAwareness` 1 statement  skills, gaps                 (optional, cacheable)
 *
 * Grouping by failure semantics is deliberate. `loadCore` holds exactly the
 * reads that used to sit in a `Promise.all` and fail the turn; `loadEnrichment`
 * and `loadSelfAwareness` hold exactly the ones that used to sit in a
 * `Promise.allSettled` and degrade their own section. A single statement cannot
 * fail halfway, so mixing the two groups would have silently upgraded an
 * optional section's failure into a failed turn — or the reverse.
 *
 * ## How a statement stays ONE statement
 *
 * Each section is a scalar subquery aggregated with `json_agg` (lists) or
 * `json_build_object` (single rows), so N logical reads cost one round-trip and
 * see ONE snapshot — which is also a small correctness win: the pre-#525 turn
 * read 13 independent snapshots and could render a fact that a message in the
 * same prompt had already invalidated.
 *
 * ## Why the predicates are not written here
 *
 * Every subquery embeds the EXPORTED query builder that the corresponding
 * single-section repository method already uses (`recentInConversationQuery`,
 * `factsMentionableForScopesQuery`, `memoryFindRelevantQuery`, …). Nothing in
 * this file restates a `WHERE`. That is the point: a batched read is exactly
 * the shape where a forgotten `tenant_id` predicate hides, because the caller
 * passes ids it already "knows" and a foreign row comes back looking
 * legitimate. There is only one copy of each predicate to get wrong, and
 * `tests/integration/turn-context-loader-batch.spec.ts` asserts the batch
 * returns row-for-row what the per-section methods return, for the same scope.
 *
 * ## Why the projections are narrow, and why every numeric is cast
 *
 * The subqueries return whole rows; the projections pick the columns the prompt
 * actually renders. Going through JSON changes types — `numeric` would come
 * back as a JS number (`'0.90'` → `0.9`, rendering "conf 0.9" where the prompt
 * used to say "conf 0.90") and a `timestamptz` would arrive as a string where
 * the caller expects a `Date`. So every numeric column is cast to `text` (the
 * exact representation node-postgres already hands back for `numeric`) and the
 * one timestamp that matters is revived into a `Date` on the way out. Byte
 * fidelity of the rendered prompt is asserted in
 * `tests/unit/prompt-builder-golden.spec.ts` against goldens recorded BEFORE
 * this change.
 */
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db } from '../client.js';
import {
  recentInConversationQuery,
} from './conversation-repos.js';
import { entidadesByIdsQuery, entityStatesByIdsQuery } from './finance-repos.js';
import {
  factsMentionableForScopesQuery,
  hintsFindActiveForScopesQuery,
  memoryFindRelevantQuery,
  rulesListActiveQuery,
} from './cognitive-repos.js';
import { gapsListByLevelsQuery, skillsListAllQuery } from './capability-repos.js';
import { operationalProfileGetActiveQuery } from './profile-repos.js';
import { selfStateGetActiveQuery } from './tenant-repos.js';
import {
  procedureActiveForConversaQuery,
  procedureDefinitionByIdQuery,
  procedureDefinitionsScopedQuery,
} from './procedure-repos.js';
import type { GapLevel } from '@/types/enums.js';

// ---------------------------------------------------------------------------
// Row shapes the loader consumes. Narrow on purpose: these are the columns the
// prompt renders, not the tables' full width.
// ---------------------------------------------------------------------------

export type TurnHistoryMessage = {
  id: string;
  direcao: string;
  tipo: string;
  conteudo: string | null;
  ferramentas_chamadas: unknown;
  created_at: Date | null;
};

export type TurnEntity = { id: string; nome: string };
export type TurnEntityState = {
  entidade_id: string;
  saldo_consolidado: string | null;
  proximo_vencimento: string | null;
};
export type TurnFact = { escopo: string; chave: string; valor: unknown };
export type TurnRule = {
  id: string;
  tipo: string;
  confianca: string;
  contexto: string;
  acao: string;
};
export type TurnMemory = {
  content: string;
  proactive_use: boolean;
  mention_allowed: boolean;
};
export type TurnHint = { hint_text: string };
export type TurnSkill = { skill_name: string; confidence: string | null };
export type TurnGap = { capability_description: string; current_level: string };
export type TurnProcedureStep = {
  id: string;
  intencao?: string;
  como?: string;
  sucesso_criteria_ref?: string;
  armadilhas?: string[];
};
export type TurnProcedureDefinition = {
  id: string;
  nome: string;
  version_number: number;
  steps: TurnProcedureStep[];
  success_criteria: Array<{ id: string; type?: string }>;
};
export type TurnProcedure = {
  execution: { id: string; definition_id: string; current_step_id: string | null; execution_state: unknown };
  definition: TurnProcedureDefinition | null;
};

export type TurnIdentityRows = {
  profile: Record<string, unknown> | null;
  self: { system_prompt: string | null; versao: number | null; resumo_aprendizados: string | null } | null;
};

export type TurnCoreRows = {
  history: TurnHistoryMessage[];
  entities: TurnEntity[];
  entity_states: TurnEntityState[];
  facts: TurnFact[];
  rules: TurnRule[];
};

export type TurnEnrichmentRows = {
  memories: TurnMemory[];
  hints: TurnHint[];
  procedure: TurnProcedure | null;
};

export type TurnSelfAwarenessRows = { skills: TurnSkill[]; gaps: TurnGap[] };

// ---------------------------------------------------------------------------
// Composition helpers
// ---------------------------------------------------------------------------

/**
 * `json_agg` over a subquery, projected through `projection` (which refers to
 * the subquery under the alias `t`). Empty result sets come back as `[]` rather
 * than SQL NULL, so the caller never has to distinguish "no rows" from "no
 * column".
 */
function jsonList(source: SQLWrapper, projection: SQL, order?: SQL): SQL {
  return sql`(SELECT coalesce(json_agg(${projection}${order ? sql` ORDER BY ${order}` : sql``}), '[]'::json) FROM (${source}) t)`;
}

/**
 * A literal empty list, for the "we deliberately do not query" branches.
 *
 * A function rather than a module-level constant: building it at import time
 * would run drizzle's `sql` tag while the module graph is still loading, which
 * breaks any spec that partially mocks `drizzle-orm`. This module must cost
 * nothing to import.
 */
const emptyList = (): SQL => sql`'[]'::json`;

// ---------------------------------------------------------------------------

export type ProcedureLoadMode =
  | { mode: 'skip' }
  | { mode: 'lookup'; conversa_id: string }
  | { mode: 'definition_only'; definition_id: string };

export type CoreLoadArgs = {
  conversa_id: string;
  history_limit: number;
  entidade_ids: string[];
  fact_scopes: string[];
  rules_tipo: string;
};

export type EnrichmentLoadArgs = {
  interlocutor_id?: string;
  conversa_id?: string;
  role_id?: string;
  channel_id?: string;
  memory_limit: number;
  hint_scopes: Array<{ scope_type: string; subject_id?: string | null }>;
  procedure: ProcedureLoadMode;
};

/**
 * The four statements, as values.
 *
 * Split from execution so `tests/unit/turn-context-statements.spec.ts` can
 * RENDER them (via drizzle's dialect) and assert the SQL text without a
 * Postgres — the tenant/agent predicates, the numeric-to-text casts, and the
 * "exactly one statement" property are all checkable off-line. The integration
 * spec then proves the statements actually run and agree with the per-section
 * repository methods.
 */
export const turnContextStatements = {
  identity(): SQL {
    return sql`
      SELECT
        (SELECT to_json(p) FROM (${operationalProfileGetActiveQuery()}) p) AS profile,
        (SELECT json_build_object(
                  'system_prompt', s.system_prompt,
                  'versao', s.versao,
                  'resumo_aprendizados', s.resumo_aprendizados
                ) FROM (${selfStateGetActiveQuery()}) s) AS self
    `;
  },

  core(args: CoreLoadArgs): SQL {
    const hasEntities = args.entidade_ids.length > 0;
    const hasFactScopes = args.fact_scopes.length > 0;
    return sql`
      SELECT
        ${jsonList(
          recentInConversationQuery(args.conversa_id, args.history_limit),
          sql`json_build_object(
                'id', t.id,
                'direcao', t.direcao,
                'tipo', t.tipo,
                'conteudo', t.conteudo,
                'ferramentas_chamadas', t.ferramentas_chamadas,
                'created_at', t.created_at
              )`,
          sql`t.created_at DESC`,
        )} AS history,
        ${
          hasEntities
            ? jsonList(
                entidadesByIdsQuery(args.entidade_ids),
                sql`json_build_object('id', t.id, 'nome', t.nome)`,
              )
            : emptyList()
        } AS entities,
        ${
          hasEntities
            ? jsonList(
                entityStatesByIdsQuery(args.entidade_ids),
                // `saldo_consolidado` is numeric: cast to text so it renders
                // "1234.50" and not 1234.5 (see the module header).
                sql`json_build_object(
                      'entidade_id', t.entidade_id,
                      'saldo_consolidado', t.saldo_consolidado::text,
                      'proximo_vencimento', t.proximo_vencimento
                    )`,
                sql`t.entidade_id`,
              )
            : emptyList()
        } AS entity_states,
        ${
          hasFactScopes
            ? jsonList(
                factsMentionableForScopesQuery(args.fact_scopes),
                sql`json_build_object('escopo', t.escopo, 'chave', t.chave, 'valor', t.valor)`,
              )
            : emptyList()
        } AS facts,
        ${jsonList(
          rulesListActiveQuery(args.rules_tipo),
          sql`json_build_object(
                'id', t.id,
                'tipo', t.tipo,
                'confianca', t.confianca::text,
                'contexto', t.contexto,
                'acao', t.acao
              )`,
          sql`t.confianca DESC, t.updated_at DESC`,
        )} AS rules
    `;
  },

  enrichment(args: EnrichmentLoadArgs): SQL {
    const hintsQuery = hintsFindActiveForScopesQuery(args.hint_scopes);

    const executionProjection = sql`json_build_object(
      'id', e.id,
      'definition_id', e.definition_id,
      'current_step_id', e.current_step_id,
      'execution_state', e.execution_state
    )`;
    const definitionProjection = (alias: SQL): SQL => sql`json_build_object(
      'id', ${alias}.id,
      'nome', ${alias}.nome,
      'version_number', ${alias}.version_number,
      'steps', ${alias}.steps,
      'success_criteria', ${alias}.success_criteria
    )`;

    let procedureExpr: SQL;
    if (args.procedure.mode === 'skip') {
      procedureExpr = sql`NULL::json`;
    } else if (args.procedure.mode === 'lookup') {
      procedureExpr = sql`(
        SELECT json_build_object(
                 'execution', ${executionProjection},
                 'definition', CASE WHEN d.id IS NULL THEN NULL ELSE ${definitionProjection(sql`d`)} END
               )
          FROM (${procedureActiveForConversaQuery(args.procedure.conversa_id)}) e
          LEFT JOIN (${procedureDefinitionsScopedQuery()}) d ON d.id = e.definition_id
      )`;
    } else {
      // The caller owns the execution; only the definition is missing.
      procedureExpr = sql`(
        SELECT json_build_object('execution', NULL::json, 'definition', ${definitionProjection(sql`d`)})
          FROM (${procedureDefinitionByIdQuery(args.procedure.definition_id)}) d
      )`;
    }

    return sql`
      SELECT
        ${jsonList(
          memoryFindRelevantQuery({
            interlocutor_id: args.interlocutor_id,
            conversa_id: args.conversa_id,
            role_id: args.role_id,
            channel_id: args.channel_id,
            limit: args.memory_limit,
          }),
          sql`json_build_object(
                'content', t.content,
                'proactive_use', t.proactive_use,
                'mention_allowed', t.mention_allowed
              )`,
          sql`t.created_at DESC`,
        )} AS memories,
        ${
          hintsQuery === null
            ? emptyList()
            : jsonList(
                hintsQuery,
                sql`json_build_object('hint_text', t.hint_text)`,
                sql`t.created_at, t.id`,
              )
        } AS hints,
        ${procedureExpr} AS procedure
    `;
  },

  selfAwareness(levels: GapLevel[]): SQL {
    return sql`
      SELECT
        ${jsonList(
          skillsListAllQuery(),
          // `confidence` is numeric and the renderer sorts on it; text keeps
          // the exact representation node-postgres would have returned.
          sql`json_build_object('skill_name', t.skill_name, 'confidence', t.confidence::text)`,
        )} AS skills,
        ${
          levels.length > 0
            ? jsonList(
                gapsListByLevelsQuery(levels),
                sql`json_build_object(
                      'capability_description', t.capability_description,
                      'current_level', t.current_level
                    )`,
              )
            : emptyList()
        } AS gaps
    `;
  },
};

export const turnContextRepo = {
  /**
   * Identity: the active operational profile v2 and the legacy `self_state`
   * fallback, in ONE statement.
   *
   * Both are at most one row and neither depends on the other, so a `FULL OUTER
   * JOIN … ON true` of the two single-row subqueries is exactly one row (or
   * zero when both are absent) with independent NULLability. The alternative —
   * reading the profile first and only reading `self_state` on the fallback —
   * traded a round-trip for a serial dependency, which is the wrong way round
   * when the two reads are this cheap.
   *
   * The profile row is projected whole (`to_json`) because
   * `renderOperationalProfile` reads `profile_body` plus, for legacy fixtures,
   * top-level layer columns. The row carries no `numeric` column, and the
   * renderer reads no timestamp, so the JSON round-trip is lossless for
   * everything it touches.
   */
  async loadIdentity(): Promise<TurnIdentityRows> {
    const result = await db.execute<TurnIdentityRows>(turnContextStatements.identity());
    const row = result.rows[0];
    return { profile: row?.profile ?? null, self: row?.self ?? null };
  },

  /**
   * The critical half of the turn context: conversation history, the scope's
   * entities and their financial state, and the validated knowledge blocks.
   *
   * These are the five reads that used to sit in a `Promise.all` and fail the
   * turn on the first rejection. That contract is preserved exactly — one
   * statement, one failure — while the turn now waits for one round-trip
   * instead of five concurrent ones against a 10-connection pool.
   */
  async loadCore(args: CoreLoadArgs): Promise<TurnCoreRows> {
    const result = await db.execute<TurnCoreRows>(turnContextStatements.core(args));
    const row = result.rows[0];
    return {
      // `created_at` survives JSON as an ISO string; the caller compares it
      // with `.getTime()`, so revive it here rather than leaking the
      // representation into the renderer.
      history: (row?.history ?? []).map((m) => ({
        ...m,
        created_at: m.created_at ? new Date(m.created_at as unknown as string) : null,
      })),
      entities: row?.entities ?? [],
      entity_states: row?.entity_states ?? [],
      facts: row?.facts ?? [],
      rules: row?.rules ?? [],
    };
  },

  /**
   * The optional half: relevant memories, active behavioural hints, and the
   * running procedure with its definition.
   *
   * `procedure` has three modes, mirroring the pre-#525 contract on
   * `PromptContext.activeExecution`:
   *   - `lookup`          the caller did not look → find the active execution
   *                       and LEFT JOIN its definition (was two round-trips);
   *   - `definition_only` the caller already has the execution → fetch only
   *                       the definition;
   *   - `skip`            the caller looked and found nothing → no subquery at
   *                       all, so the statement does not pay for an answer the
   *                       caller already has.
   */
  async loadEnrichment(args: EnrichmentLoadArgs): Promise<TurnEnrichmentRows> {
    const result = await db.execute<TurnEnrichmentRows>(turnContextStatements.enrichment(args));
    const row = result.rows[0];
    return {
      memories: row?.memories ?? [],
      hints: row?.hints ?? [],
      procedure: row?.procedure ?? null,
    };
  },

  /**
   * Skills and gaps — the `## Autoconhecimento` and `## Limitações conhecidas`
   * blocks — in ONE statement.
   *
   * The pre-#525 path spent THREE round-trips here: the skill catalogue, the
   * `mentionable` gaps for the self-awareness block, and the `mentionable` +
   * `proposed` gaps for the limitations block. The second was a strict subset
   * of the third, so it is now a filter in the renderer rather than a query.
   */
  async loadSelfAwareness(levels: GapLevel[]): Promise<TurnSelfAwarenessRows> {
    const result = await db.execute<TurnSelfAwarenessRows>(
      turnContextStatements.selfAwareness(levels),
    );
    const row = result.rows[0];
    return { skills: row?.skills ?? [], gaps: row?.gaps ?? [] };
  },
};
