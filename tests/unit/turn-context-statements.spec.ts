import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { runWithTenantContext } from '../../src/db/tenant-context.js';
import { turnContextStatements } from '../../src/db/repositories/turn-context-repos.js';
import { GapLevel } from '../../src/types/enums.js';

/**
 * Issue #525 — what the batched turn-context statements actually SAY.
 *
 * The loader collapses 13 prompt round-trips into 4 statements. Those
 * statements only run against a real Postgres, which is CI-only here, so this
 * spec renders them through drizzle's dialect and asserts the properties that
 * must hold for the batch to be safe — without a database:
 *
 *   1. ONE statement. No `;` outside a string literal, so "4 statements" is a
 *      fact about the SQL and not just about how many `db.execute` calls the
 *      code makes. (The production counter in `src/db/query-counter.ts` counts
 *      round-trips, and a multi-statement string would count as one while
 *      costing more.)
 *   2. TENANT SCOPE. Every subquery carries the running (tenant_id, agent_id)
 *      as bound parameters. A batched read is exactly where a lost tenant
 *      predicate hides.
 *   3. NUMERIC → TEXT. `numeric` columns that reach the prompt are cast, so a
 *      JSON round-trip cannot turn "0.90" into 0.9 and silently rewrite the
 *      prompt bytes.
 *
 * Row-level agreement with the per-section repository methods is the
 * integration spec's job (`tests/integration/turn-context-loader-batch.spec.ts`).
 */

const dialect = new PgDialect();
const SCOPE = { tenant_id: 'acme', agent_id: 'agent-1' };

async function render(build: () => ReturnType<typeof turnContextStatements.identity>): Promise<{
  sql: string;
  params: unknown[];
}> {
  return runWithTenantContext(SCOPE, async () => {
    const q = dialect.sqlToQuery(build());
    return { sql: q.sql, params: q.params };
  });
}

/** Strips single-quoted literals so a `;` inside a string is not miscounted. */
function stripLiterals(s: string): string {
  return s.replace(/'(?:[^']|'')*'/g, "''");
}

const CORE_ARGS = {
  conversa_id: 'conv-1',
  history_limit: 10,
  entidade_ids: ['ent-a', 'ent-b'],
  fact_scopes: ['global', 'pessoa:p-1'],
  rules_tipo: 'classificacao',
};

const ENRICHMENT_ARGS = {
  interlocutor_id: 'pessoa-1',
  conversa_id: 'conv-1',
  role_id: 'role-1',
  channel_id: 'chan-1',
  memory_limit: 30,
  hint_scopes: [
    { scope_type: 'interlocutor', subject_id: 'pessoa-1' },
    { scope_type: 'agent', subject_id: null },
  ],
  procedure: { mode: 'lookup' as const, conversa_id: 'conv-1' },
};

const ALL = [
  ['identity', () => turnContextStatements.identity()],
  ['core', () => turnContextStatements.core(CORE_ARGS)],
  ['enrichment', () => turnContextStatements.enrichment(ENRICHMENT_ARGS)],
  [
    'self_awareness',
    () => turnContextStatements.selfAwareness([GapLevel.MENTIONABLE, GapLevel.PROPOSED]),
  ],
] as const;

describe('#525 batched turn-context statements', () => {
  it.each(ALL)('%s is exactly ONE statement', async (_name, build) => {
    const { sql } = await render(build);
    expect(stripLiterals(sql)).not.toContain(';');
    expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
  });

  it.each(ALL)('%s binds the running tenant and agent', async (_name, build) => {
    const { params } = await render(build);
    expect(params).toContain('acme');
    expect(params).toContain('agent-1');
  });

  it('core casts every prompt-visible numeric to text', async () => {
    const { sql } = await render(() => turnContextStatements.core(CORE_ARGS));
    // `saldo_consolidado` renders as "1234.50"; through JSON without the cast
    // it would arrive as the number 1234.5 and the prompt bytes would change.
    expect(sql).toContain('saldo_consolidado::text');
    expect(sql).toContain('confianca::text');
  });

  it('self_awareness casts skill confidence to text', async () => {
    const { sql } = await render(() =>
      turnContextStatements.selfAwareness([GapLevel.MENTIONABLE, GapLevel.PROPOSED]),
    );
    expect(sql).toContain('confidence::text');
  });

  it('core keeps the facts sensitivity filter, not just the tenant scope', async () => {
    const { sql } = await render(() => turnContextStatements.core(CORE_ARGS));
    // The `NOT EXISTS` is what keeps a do-not-mention fact out of the prompt.
    // It survives because the batch embeds the repo's own statement.
    expect(sql).toContain('memory_entry');
    expect(sql).toContain('mention_allowed');
    expect(sql).toContain('needs_review');
  });

  it('core degenerates to a literal empty list rather than an unscoped read', async () => {
    const { sql } = await render(() =>
      turnContextStatements.core({ ...CORE_ARGS, entidade_ids: [], fact_scopes: [] }),
    );
    // No entity/fact subquery at all — an `IN ()` or an unfiltered scan would
    // be the fail-OPEN reading of "nothing in scope".
    expect(sql).not.toContain('entidades');
    expect(sql).not.toContain('agent_facts');
    // 3 degenerate columns (entities, entity_states, facts) + the 2 `coalesce`
    // fallbacks of the columns that DID emit a subquery (history, rules).
    expect(sql.match(/'\[\]'::json/g)?.length).toBe(5);
  });

  it('enrichment emits no procedure subquery when the caller already looked', async () => {
    const { sql } = await render(() =>
      turnContextStatements.enrichment({
        ...ENRICHMENT_ARGS,
        procedure: { mode: 'skip' },
      }),
    );
    expect(sql).not.toContain('procedure_executions');
    expect(sql).not.toContain('procedure_definitions');
    expect(sql).toContain('NULL::json');
  });

  it('enrichment resolves execution AND definition in the same statement', async () => {
    const { sql } = await render(() => turnContextStatements.enrichment(ENRICHMENT_ARGS));
    expect(sql).toContain('procedure_executions');
    expect(sql).toContain('procedure_definitions');
    expect(sql.toLowerCase()).toContain('left join');
    expect(stripLiterals(sql)).not.toContain(';');
  });

  it('enrichment never matches every hint when there are no scopes', async () => {
    const { sql } = await render(() =>
      turnContextStatements.enrichment({ ...ENRICHMENT_ARGS, hint_scopes: [] }),
    );
    // Fail-closed: no hint subquery is emitted at all, so an empty scope list
    // cannot degrade into "every hint of the tenant".
    expect(sql).not.toContain('behavioral_hint');
  });

  it('self_awareness asks for the gap levels the two blocks need, once', async () => {
    const { params } = await render(() =>
      turnContextStatements.selfAwareness([GapLevel.MENTIONABLE, GapLevel.PROPOSED]),
    );
    expect(params).toContain('mentionable');
    expect(params).toContain('proposed');
  });
});
