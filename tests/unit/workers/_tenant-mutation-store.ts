/**
 * Issue #345 (Phase 4 review) — shared test harness for proving MUTATION
 * isolation of the per-tenant maintenance workers.
 *
 * Used ONLY by `pending-expirer-cross-tenant.spec.ts` and
 * `conversation-summarizer-cross-tenant.spec.ts`. It provides a minimal,
 * in-memory, tenant-keyed store that stands in for `@/db/client.js`'s `db` so
 * the REAL repository methods (`pendingQuestionsRepo.expireDue`,
 * `conversasRepo.close`) execute their REAL drizzle WHERE predicate against it.
 *
 * Why this is "the test that would have caught the bug": the store applies an
 * UPDATE by EVALUATING the drizzle predicate the repo built — it does not
 * hand-roll a tenant filter. So if a repo method's WHERE clause lacks a
 * `tenant_id`/`agent_id` binding (the #345 review bug), the predicate matches
 * EVERY tenant's rows and the cross-tenant assertion fails. With the fix in
 * place the bound `tenant_id`/`agent_id` params scope the match to the running
 * tuple, leaving other tenants' rows untouched.
 *
 * The predicate evaluator understands exactly the shapes these repos emit:
 *   - equality terms  `eq(col, value)`     → `row[col.name] === value`
 *   - membership terms `inArray(col, vals)` → `vals.includes(row[col.name])`
 *   - the raw fragment `sql\`expira_em < now()\`` → `row.expira_em < NOW`
 * combined with drizzle's `and(...)`. Anything else throws loudly so a future
 * predicate change can't silently pass.
 */
import { getTableName } from 'drizzle-orm';
import { vi } from 'vitest';

export interface StoreRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  status: string;
  /** ISO string or Date; only present on pending_questions rows. */
  expira_em?: string | Date | null;
  /**
   * Optional table tag (issue #363). When a single test seeds rows that would be
   * read by SELECTs from DIFFERENT tables (e.g. `list_pending` reads
   * pending_questions + workflows + transacoes against ONE store), set this to the
   * drizzle table name so a row only matches a `select().from(thatTable)`. Rows
   * WITHOUT a tag match any table — preserving every pre-existing single-table
   * spec, which never sets it.
   */
  __table?: string;
  [k: string]: unknown;
}

/** Resolve a drizzle table object passed to `.from(...)` to its SQL name. */
function tableNameOf(table: unknown): string | undefined {
  try {
    return getTableName(table as never);
  } catch {
    return undefined;
  }
}

/** A drizzle SQL-ish node (only the bits we introspect). */
interface SqlNode {
  queryChunks?: unknown[];
}
interface ColumnNode {
  name?: string;
}
interface ParamNode {
  value?: unknown;
}

function ctorName(o: unknown): string | undefined {
  return (o as { constructor?: { name?: string } } | null)?.constructor?.name;
}
function isSql(o: unknown): o is SqlNode {
  return ctorName(o) === 'SQL' && Array.isArray((o as SqlNode).queryChunks);
}
function isColumn(o: unknown): o is ColumnNode {
  // PgColumn subclasses carry `.name`; not an SQL/StringChunk/Param.
  const c = ctorName(o);
  return (
    typeof (o as ColumnNode)?.name === 'string' &&
    c !== 'SQL' &&
    c !== 'StringChunk' &&
    c !== 'Param'
  );
}
function isParam(o: unknown): o is ParamNode {
  return ctorName(o) === 'Param';
}
function isStringChunk(o: unknown): o is { value: string[] } {
  return ctorName(o) === 'StringChunk' && Array.isArray((o as { value?: unknown }).value);
}

/** A parsed predicate term: an equality / membership binding or a raw fragment. */
type Term =
  | { kind: 'eq'; column: string; value: unknown }
  | { kind: 'in'; column: string; values: unknown[] }
  | { kind: 'raw'; text: string }
  // Issue #362 — the pending-reminder CAS adds two builder comparisons whose
  // operands are nested `sql` fragments (not Params), so they don't fit the
  // eq/in/raw shapes above:
  //   - `gt(<timestamp col>, sql\`now()\`)`  → `row[col] > now`
  | { kind: 'gt_now'; column: string }
  //   - `lt(sql\`COALESCE((<jsonb col>->>'<key>')::int, 0)\`, <number>)`
  //       → `(row[col]?.[key] ?? 0) < value`
  | { kind: 'json_int_lt'; column: string; key: string; value: number };

/**
 * Flatten a raw-comparison SQL node to its literal text, rendering StringChunks
 * verbatim and interpolated Columns by name. Examples:
 *   `sql\`expira_em < now()\``                         → "expira_em < now()"
 *   `sql\`${col} < now() - interval '7 days'\``        → "ultima_atividade_em < now() - interval '7 days'"
 *
 * Returns null when the node contains a nested SQL or a bound Param — those are
 * NOT plain raw fragments (an `eq(col, val)` carries a Param and is handled by
 * `asEqTerm` first; a composite carries nested SQL and must be recursed).
 */
function rawText(node: SqlNode): string | null {
  const chunks = node.queryChunks ?? [];
  if (chunks.some((c) => isSql(c) || isParam(c))) return null;
  const parts: string[] = [];
  for (const c of chunks) {
    if (isStringChunk(c)) parts.push((c as { value: string[] }).value.join(''));
    else if (isColumn(c)) parts.push((c as ColumnNode).name!);
    else return null; // unknown chunk kind — don't risk a false render
  }
  return parts.join('').trim();
}

/**
 * Recognise an `eq(col, value)` SQL node, whose chunk layout drizzle emits as
 * `[StringChunk, Column, StringChunk(" = "), Param, StringChunk]`.
 */
function asEqTerm(node: SqlNode): Term | null {
  const chunks = node.queryChunks ?? [];
  const col = chunks.find(isColumn) as ColumnNode | undefined;
  const param = chunks.find(isParam) as ParamNode | undefined;
  const hasEqOp = chunks.some(
    (c) => isStringChunk(c) && (c as { value: string[] }).value.join('').includes('='),
  );
  if (col?.name && param && hasEqOp) {
    return { kind: 'eq', column: col.name, value: param.value };
  }
  return null;
}

/**
 * Recognise an `inArray(col, values)` SQL node. drizzle renders it as
 * `[StringChunk(""), Column, StringChunk(" in "), <JS Array of Param nodes>,
 * StringChunk("")]` — i.e. the value list is a plain JS array (NOT a single
 * Param) whose elements are Param nodes. We extract `col.name` and unwrap each
 * Param's `.value`. Empty IN-lists never occur here (`setConversaIdMany`
 * early-returns on `ids.length === 0`).
 */
function asInArrayTerm(node: SqlNode): Term | null {
  const chunks = node.queryChunks ?? [];
  const col = chunks.find(isColumn) as ColumnNode | undefined;
  const hasInOp = chunks.some(
    (c) => isStringChunk(c) && (c as { value: string[] }).value.join('').includes(' in '),
  );
  const arr = chunks.find((c) => Array.isArray(c)) as unknown[] | undefined;
  if (col?.name && hasInOp && Array.isArray(arr)) {
    const values = arr.map((p) => (isParam(p) ? (p as ParamNode).value : p));
    return { kind: 'in', column: col.name, values };
  }
  return null;
}

/** Render a nested `sql` fragment's literal text (StringChunks + Column names). */
function nestedSqlText(node: SqlNode): string | null {
  const chunks = node.queryChunks ?? [];
  // A pure literal/column fragment — must NOT contain Params or further nesting.
  if (chunks.some((c) => isSql(c) || isParam(c))) return null;
  const parts: string[] = [];
  for (const c of chunks) {
    if (isStringChunk(c)) parts.push((c as { value: string[] }).value.join(''));
    else if (isColumn(c)) parts.push((c as ColumnNode).name!);
    else return null;
  }
  return parts.join('');
}

/**
 * Issue #362 — recognise `gt(<column>, sql\`now()\`)`, which drizzle emits as
 * `[StringChunk(""), Column, StringChunk(" > "), SQL("now()"), StringChunk("")]`.
 * The right operand is a nested `now()` SQL fragment (no Param), so this never
 * collides with `asEqTerm` (which requires a Param). Only `> now()` is modelled
 * — anything else returns null so `parsePredicate` falls through / throws.
 */
function asGtNowTerm(node: SqlNode): Term | null {
  const chunks = node.queryChunks ?? [];
  const col = chunks.find(isColumn) as ColumnNode | undefined;
  const nested = chunks.find(isSql) as SqlNode | undefined;
  const hasGtOp = chunks.some(
    (c) => isStringChunk(c) && (c as { value: string[] }).value.join('').includes('>'),
  );
  if (col?.name && nested && hasGtOp && nestedSqlText(nested)?.trim().toLowerCase() === 'now()') {
    return { kind: 'gt_now', column: col.name };
  }
  return null;
}

/**
 * Issue #362 — recognise the reminder-cap CAS term
 * `lt(sql\`COALESCE((<jsonb col>->>'<key>')::int, 0)\`, <number>)`, emitted as
 * `[StringChunk(""), SQL(COALESCE…), StringChunk(" < "), Number, StringChunk("")]`.
 * The left operand is a nested COALESCE-over-JSON fragment (a Column inside a
 * nested SQL); the right is a bare numeric chunk (NOT a Param). We pull the jsonb
 * column name + the `->>'<key>'` accessor out of the nested fragment.
 */
function asJsonIntLtTerm(node: SqlNode): Term | null {
  const chunks = node.queryChunks ?? [];
  const nested = chunks.find(isSql) as SqlNode | undefined;
  const num = chunks.find((c) => typeof c === 'number') as number | undefined;
  const hasLtOp = chunks.some(
    (c) => isStringChunk(c) && (c as { value: string[] }).value.join('').includes('<'),
  );
  if (!nested || num === undefined || !hasLtOp) return null;
  // Render the nested fragment with its Column interpolated, e.g.
  // "COALESCE((metadata->>'reminder_count')::int, 0)".
  const col = (nested.queryChunks ?? []).find(isColumn) as ColumnNode | undefined;
  const text = nestedSqlText(nested);
  if (!col?.name || !text) return null;
  const m = /->>'([^']+)'/.exec(text);
  if (!m) return null;
  return { kind: 'json_int_lt', column: col.name, key: m[1]!, value: num };
}

/**
 * Walk a drizzle predicate (the argument to `.where(...)`) into a flat list of
 * terms. Handles `and(...)` nesting transparently. Throws on any construct the
 * evaluator does not understand, so the harness can never give a false pass.
 */
export function parsePredicate(predicate: unknown): Term[] {
  const terms: Term[] = [];
  const visit = (node: unknown): void => {
    if (!isSql(node)) {
      throw new Error(`tenant-mutation-store: non-SQL predicate node (${ctorName(node)})`);
    }
    // An eq term?
    const eq = asEqTerm(node);
    if (eq) {
      terms.push(eq);
      return;
    }
    // An inArray membership term?
    const inTerm = asInArrayTerm(node);
    if (inTerm) {
      terms.push(inTerm);
      return;
    }
    // Issue #362 — the pending-reminder CAS builder comparisons. Checked BEFORE
    // `rawText`/composite recursion: both carry a nested SQL operand, so the
    // recursion would otherwise descend into `now()`/`COALESCE(...)` and trip on
    // the column-at-composite-level guard.
    const gtNow = asGtNowTerm(node);
    if (gtNow) {
      terms.push(gtNow);
      return;
    }
    const jsonLt = asJsonIntLtTerm(node);
    if (jsonLt) {
      terms.push(jsonLt);
      return;
    }
    // A raw fragment (e.g. `expira_em < now()`)?
    const raw = rawText(node);
    if (raw !== null && raw.length > 0) {
      terms.push({ kind: 'raw', text: raw });
      return;
    }
    // Otherwise it's a composite (and/or wrapper): recurse into nested SQL
    // chunks, skipping the bare string glue ("(", " and ", ")").
    for (const chunk of node.queryChunks ?? []) {
      if (isSql(chunk)) visit(chunk);
      else if (isStringChunk(chunk)) {
        const text = (chunk as { value: string[] }).value.join('').trim();
        // Only the boolean glue / parens are allowed as bare strings here.
        if (text.length > 0 && !/^[()]*$/.test(text) && text !== 'and' && text !== 'or') {
          throw new Error(`tenant-mutation-store: unexpected bare SQL glue "${text}"`);
        }
      } else if (isColumn(chunk) || isParam(chunk)) {
        // A column/param at composite level means an unrecognised binary op.
        throw new Error('tenant-mutation-store: unrecognised predicate term shape');
      }
    }
  };
  visit(predicate);
  return terms;
}

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') return new Date(v);
  return null;
}

/** Does `row` satisfy every parsed predicate term (relative to `now`)? */
export function rowMatches(row: StoreRow, terms: Term[], now: Date): boolean {
  for (const t of terms) {
    if (t.kind === 'eq') {
      if (row[t.column] !== t.value) return false;
    } else if (t.kind === 'in') {
      if (!t.values.includes(row[t.column])) return false;
    } else if (t.kind === 'gt_now') {
      // Issue #362 — `expira_em > now()`: a row with no/null timestamp, or one
      // whose timestamp is at/before `now`, is NOT eligible (the CAS skips it).
      const v = toDate(row[t.column] as unknown);
      if (!v || v.getTime() <= now.getTime()) return false;
    } else if (t.kind === 'json_int_lt') {
      // Issue #362 — `COALESCE((metadata->>'<key>')::int, 0) < value`.
      const json = row[t.column] as Record<string, unknown> | null | undefined;
      const current = Number((json?.[t.key] as number | undefined) ?? 0);
      if (!(current < t.value)) return false;
    } else if (!rawFragmentSatisfied(t.text, row, now)) {
      return false;
    }
  }
  return true;
}

/**
 * Evaluate the raw fragments the repos/workers under test emit:
 *   - `expira_em < now()`                               (pending_questions)
 *   - `<col> < now() - interval 'N days'`               (conversas staleness)
 *   - `status IN ('a','b',...)`                         (workflows listPending — #345 Batch D)
 * Throws on anything else so a future predicate change can't silently pass.
 */
function rawFragmentSatisfied(text: string, row: StoreRow, now: Date): boolean {
  const due = /^expira_em\s*<\s*now\(\)$/i.exec(text);
  if (due) {
    const exp = toDate(row.expira_em);
    return !!exp && exp.getTime() < now.getTime();
  }
  const stale = /^(\w+)\s*<\s*now\(\)\s*-\s*interval\s*'(\d+)\s*days?'$/i.exec(text);
  if (stale) {
    const col = stale[1]!;
    const days = Number(stale[2]);
    const v = toDate(row[col] as unknown);
    return !!v && v.getTime() < now.getTime() - days * 86_400_000;
  }
  // `status IN ('pendente','em_andamento',...)` — drizzle renders the literal
  // IN-list as a single StringChunk (no params/columns), so it reaches here as a
  // raw fragment. Parse the quoted list and test membership against row.status.
  const inList = /^(\w+)\s+IN\s*\((.+)\)$/i.exec(text);
  if (inList) {
    const col = inList[1]!;
    const allowed = new Set(
      inList[2]!
        .split(',')
        .map((s) => s.trim().replace(/^'(.*)'$/, '$1')),
    );
    return allowed.has(String(row[col]));
  }
  // `<col> is null` — drizzle renders `isNull(col)` as a column interpolation
  // followed by the literal " is null" (no Param), so `rawText` collapses it to
  // `"<col> is null"` and it reaches here. Used by `transacoesRepo
  // .listPendingForEntidades` (issue #363: `isNull(transacoes.confirmada_em)`).
  const nullCheck = /^(\w+)\s+is\s+null$/i.exec(text);
  if (nullCheck) {
    return row[nullCheck[1]!] == null;
  }
  throw new Error(`tenant-mutation-store: unsupported raw fragment "${text}"`);
}

/**
 * Issue #355 (H2 of #323) — parse a RAW `tx.execute(sql\`UPDATE … RETURNING\`)`
 * statement into the same `Term[]` the drizzle-builder path produces, so the
 * raw-SQL mutations (`pendingQuestionsRepo.cancelTx` /
 * `cancelOpenForConversaTx`) are exercised against the in-memory store with
 * their REAL WHERE clause — exactly mirroring how the builder path proves
 * `expireDue`'s tenant binding.
 *
 * A `sql\`…${jsString}…\`` template interpolates a plain JS string as a *boxed*
 * `String` chunk (NOT a drizzle `Param` node — that wrapping only happens for
 * `eq(col, val)` builder terms). So the template's `queryChunks` alternate
 * `StringChunk` (literal SQL) and `String`/primitive (interpolated value). We
 * recover the predicate by:
 *   - pairing each literal preamble ending in `<identifier> = ` with the value
 *     chunk that immediately follows it → `eq(column, value)`, AND
 *   - scanning every literal for an inline `<identifier> = '<literal>'`
 *     comparison (e.g. the `status = 'aberta'` gate) → `eq(column, literal)`.
 *
 * The returned `Term[]` feeds the SAME `rowMatches` evaluator the builder path
 * uses. Anything we cannot account for (a value chunk with no `<col> =`
 * preamble) throws loudly, so a future raw-SQL change can't silently pass.
 */
export function parseRawUpdateTerms(node: SqlNode): Term[] {
  const chunks = node.queryChunks ?? [];
  const terms: Term[] = [];
  // Trailing `<identifier> = ` (optionally newline/space-prefixed) — captures
  // the column whose bound value is the NEXT chunk. Excludes the SET clause's
  // `status = 'cancelada'` (that has a quoted literal, handled by the inline
  // scan below, and its preamble does not end in bare `= `).
  const eqPreamble = /(?:^|[\s(,])([a-z_][a-z0-9_]*)\s*=\s*$/i;
  // Inline `<identifier> = '<literal>'` comparison anywhere in a literal chunk.
  const inlineEqAll = /(?:^|[\s(,])([a-z_][a-z0-9_]*)\s*=\s*'([^']*)'/gi;

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (isStringChunk(c)) {
      const text = (c as { value: string[] }).value.join('');
      // (a) inline quoted comparisons in this literal (e.g. status = 'aberta').
      let m: RegExpExecArray | null;
      inlineEqAll.lastIndex = 0;
      while ((m = inlineEqAll.exec(text)) !== null) {
        // Skip the SET assignment `status = 'cancelada'` / `'expirada'` — it is
        // a write, not a WHERE filter. Heuristic: a SET target appears before
        // the WHERE keyword. We only treat inline eqs that occur AFTER a WHERE
        // (or in a later chunk) as predicate terms.
        const beforeWhere = /\bset\b/i.test(text) && !/\bwhere\b/i.test(text.slice(0, m.index));
        if (beforeWhere) continue;
        terms.push({ kind: 'eq', column: m[1]!, value: m[2]! });
      }
      // (b) a bound-value preamble: the NEXT chunk is this column's value.
      const pre = eqPreamble.exec(text);
      if (pre) {
        const next = chunks[i + 1];
        if (next === undefined || isStringChunk(next)) {
          throw new Error(
            `tenant-mutation-store: raw "${pre[1]}=" has no bound value chunk`,
          );
        }
        terms.push({ kind: 'eq', column: pre[1]!, value: String(next as unknown) });
        i += 1; // consume the value chunk
      }
    }
    // Non-StringChunk reached WITHOUT a preceding `<col> =` preamble would be an
    // unbound value — the metadata-merge param (`metadata || ${json}::jsonb`) is
    // the only such chunk and is a SET payload, not a predicate, so it is safely
    // ignored here (its preamble does not match `eqPreamble`).
  }
  return terms;
}

export interface TenantScopedUpdateStore {
  /** The object to inject as `@/db/client.js`'s `db`. */
  db: {
    update: (...args: unknown[]) => unknown;
    select: (...args: unknown[]) => unknown;
    execute: (...args: unknown[]) => unknown;
    // Issue #355 (H4 of #323) — DELETE + INSERT…ON CONFLICT paths, added for the
    // state/memory mutations whose single-row writes are a DELETE
    // (`procedureTestsRepo.delete`) or a read-then-write upsert
    // (`entityStatesRepo.upsert`). Additive: existing specs use only the three
    // above and are unaffected.
    delete: (...args: unknown[]) => unknown;
    insert: (...args: unknown[]) => unknown;
  };
  /** Live rows (mutated in place by applied UPDATEs). */
  rows: StoreRow[];
  /** The drizzle predicate captured from the most recent UPDATE `.where(...)`. */
  lastPredicate: () => unknown;
  /** The drizzle predicate captured from the most recent SELECT `.where(...)`. */
  lastSelectPredicate: () => unknown;
  /**
   * EVERY SELECT `.where(...)` predicate captured since the last `reset`, in call
   * order. A single handler can issue several SELECTs (e.g. `list_pending` reads
   * pending_questions + workflows + transacoes — issue #363); `lastSelectPredicate`
   * only retains the final one, so use this to assert each read was tenant-scoped.
   */
  selectPredicates: () => unknown[];
  /** The `Term[]` parsed from the most recent raw `execute(sql\`…\`)` UPDATE. */
  lastExecuteTerms: () => Term[] | undefined;
  /** The drizzle predicate captured from the most recent DELETE `.where(...)`. */
  lastDeletePredicate: () => unknown;
  /**
   * The drizzle predicate captured from the most recent
   * `insert(...).onConflictDoUpdate({ where })` — i.e. the conflict-arm
   * ownership gate (#355 H4 `entityStatesRepo.upsert`).
   */
  lastConflictWherePredicate: () => unknown;
  /** Reset rows + captured predicates. */
  reset: (rows: StoreRow[]) => void;
}

/**
 * Build a store-backed `db` whose `update(table).set(patch).where(pred)` mutates
 * ONLY the rows matching the evaluated drizzle predicate. Supports an optional
 * terminal `.returning(selection)` (used by `expireDue`) and a direct `await`
 * on the `.where(...)` result (used by `close`).
 *
 * `now` is fixed at construction so `expira_em < now()` is deterministic; due
 * rows should set `expira_em` in the past, not-yet-due rows in the future.
 */
export function makeTenantScopedUpdateStore(
  initialRows: StoreRow[] = [],
  now: Date = new Date(),
): TenantScopedUpdateStore {
  let rows: StoreRow[] = initialRows.map((r) => ({ ...r }));
  let captured: unknown = undefined;
  let capturedSelect: unknown = undefined;
  const capturedSelects: unknown[] = [];
  let capturedExecuteTerms: Term[] | undefined = undefined;
  let capturedDelete: unknown = undefined;
  let capturedConflictWhere: unknown = undefined;

  const applyUpdate = (patch: Record<string, unknown>, predicate: unknown): StoreRow[] => {
    captured = predicate;
    const terms = parsePredicate(predicate);
    const matched: StoreRow[] = [];
    for (const row of rows) {
      if (rowMatches(row, terms, now)) {
        Object.assign(row, patch);
        matched.push(row);
      }
    }
    return matched;
  };

  const update = vi.fn((_table: unknown) => ({
    set: (patch: Record<string, unknown>) => ({
      where: (predicate: unknown) => {
        // Eagerly capture so a no-`.returning()` caller (await on where) still
        // applies the mutation, while a `.returning()` caller can read results.
        const matched = applyUpdate(patch, predicate);
        const result = {
          returning: async (_selection?: unknown) =>
            matched.map((r) => ({ id: r.id })),
          // Allow `await db.update(...).set(...).where(...)` (no returning).
          then: (
            resolve: (v: { rowCount: number }) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve({ rowCount: matched.length }).then(resolve, reject),
        };
        return result;
      },
    }),
  }));

  // Read path. Returns only the rows matching the evaluated drizzle predicate —
  // so an unscoped SELECT would leak other tenants' rows into the result (and the
  // worker would then mutate them), which is exactly what the isolation assertion
  // catches. Supports BOTH terminal shapes the repos under test use:
  //   - `.where(pred).limit(n)`            (e.g. conversasRepo stale select)
  //   - `.where(pred)` awaited directly    (e.g. workflowsRepo.listPending — #345)
  //   - `.where(pred).orderBy(col)`        (e.g. workflowStepsRepo.byWorkflow — #345)
  const select = vi.fn(() => {
    let fromTable: string | undefined;
    const run = (): StoreRow[] => {
      const terms = parsePredicate(capturedSelect);
      return rows.filter(
        (row) =>
          // A tagged row only matches a SELECT from its own table (issue #363);
          // untagged rows match any table (back-compat with single-table specs).
          (row.__table === undefined || fromTable === undefined || row.__table === fromTable) &&
          rowMatches(row, terms, now),
      );
    };
    const chain = {
      from: (table: unknown) => {
        fromTable = tableNameOf(table);
        return chain;
      },
      where: (predicate: unknown) => {
        capturedSelect = predicate;
        capturedSelects.push(predicate);
        return chain;
      },
      orderBy: () => chain,
      limit: async (n: number) => run().slice(0, n),
      // Make the chain awaitable directly on `.where()`/`.orderBy()` (no limit).
      then: (resolve: (v: StoreRow[]) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return chain;
  });

  // Raw-SQL write path — `tx.execute(sql\`UPDATE … RETURNING id::text\`)`. Used
  // by `pendingQuestionsRepo.cancelTx` / `cancelOpenForConversaTx` (#355 H2).
  // Parses the template into `Term[]` (via `parseRawUpdateTerms`) and applies
  // the UPDATE to ONLY the matching rows — so a missing tenant/agent binding in
  // the raw WHERE would match other tenants' rows and the isolation assertion
  // would fail, exactly as in the builder path. The SET status is read from the
  // statement's leading literal (`SET status = '<x>'`). Returns the postgres
  // `{ rows }` shape the repo reads (`result.rows`).
  const execute = vi.fn(async (node: unknown) => {
    const terms = parseRawUpdateTerms(node as SqlNode);
    capturedExecuteTerms = terms;
    const chunks = (node as SqlNode).queryChunks ?? [];
    const head = chunks.find(isStringChunk) as { value: string[] } | undefined;
    const setMatch = head ? /set\s+status\s*=\s*'([^']*)'/i.exec(head.value.join('')) : null;
    const newStatus = setMatch?.[1];
    if (!newStatus) {
      throw new Error('tenant-mutation-store: raw UPDATE without a SET status literal');
    }
    const matched: StoreRow[] = [];
    for (const row of rows) {
      if (rowMatches(row, terms, now)) {
        row.status = newStatus;
        matched.push(row);
      }
    }
    return { rows: matched.map((r) => ({ id: r.id })) };
  });

  // DELETE path — `db.delete(table).where(pred)` with or without a trailing
  // `.returning(selection)`. Used by `procedureTestsRepo.delete` (#355 H4/H5),
  // which now `await`s the builder directly (idempotent: no row-count check).
  // REMOVES only the rows matching the evaluated drizzle predicate — so a missing
  // tenant/agent binding in the WHERE would delete other tenants' rows
  // (irreversible cross-tenant data loss) and the isolation assertion would catch
  // it, exactly as the UPDATE path does. Exposes BOTH shapes: `.returning({id})`
  // (the deleted rows' ids) AND a thenable resolving to `{ rowCount }`, so the
  // bare-await delete and any `.returning()`-based caller both work.
  const del = vi.fn((_table: unknown) => ({
    where: (predicate: unknown) => {
      capturedDelete = predicate;
      const terms = parsePredicate(predicate);
      const matched: StoreRow[] = [];
      const survivors: StoreRow[] = [];
      for (const row of rows) {
        if (rowMatches(row, terms, now)) matched.push(row);
        else survivors.push(row);
      }
      rows = survivors;
      return {
        returning: async (_selection?: unknown) => matched.map((r) => ({ id: r.id })),
        then: (
          resolve: (v: { rowCount: number }) => unknown,
          reject?: (e: unknown) => unknown,
        ) => Promise.resolve({ rowCount: matched.length }).then(resolve, reject),
      };
    },
  }));

  // INSERT … ON CONFLICT DO UPDATE path — `db.insert(table).values(v)
  // .onConflictDoUpdate({ target, set, where }).returning()`. Used by
  // `entityStatesRepo.upsert` (#355 H4 read-then-write pair). Models the
  // `entidade_id` PK conflict precisely so the test proves the conflict arm
  // cannot overwrite a FOREIGN tenant's row:
  //   - no existing row with the same `entidade_id` → INSERT the new values;
  //   - an existing row with that `entidade_id`:
  //       * apply the SET ONLY when the captured `onConflictDoUpdate.where`
  //         predicate matches the EXISTING row (the tenant+agent ownership gate);
  //       * otherwise the conflict arm is rejected → 0 rows returned (the foreign
  //         row is left byte-for-byte untouched), which the repo turns into its
  //         FAIL-LOUD throw.
  // The conflict key is the `entidade_id` field on the inserted values (the PK).
  const insert = vi.fn((_table: unknown) => ({
    values: (vals: Record<string, unknown>) => ({
      onConflictDoUpdate: (cfg: {
        target?: unknown;
        set?: Record<string, unknown>;
        where?: unknown;
      }) => ({
        returning: async (_selection?: unknown) => {
          const key = vals.entidade_id;
          const existing = rows.find((r) => r.entidade_id === key);
          if (!existing) {
            const inserted: StoreRow = { ...(vals as StoreRow) };
            rows.push(inserted);
            return [{ ...inserted }];
          }
          // Conflict: gate the SET on the ownership WHERE (if any).
          capturedConflictWhere = cfg.where;
          const gateOk =
            cfg.where === undefined
              ? true
              : rowMatches(existing, parsePredicate(cfg.where), now);
          if (!gateOk) return []; // foreign row — reject, leave untouched
          Object.assign(existing, cfg.set ?? {});
          return [{ ...existing }];
        },
      }),
    }),
  }));

  return {
    db: { update, select, execute, delete: del, insert },
    get rows() {
      return rows;
    },
    lastPredicate: () => captured,
    lastSelectPredicate: () => capturedSelect,
    selectPredicates: () => [...capturedSelects],
    lastExecuteTerms: () => capturedExecuteTerms,
    lastDeletePredicate: () => capturedDelete,
    lastConflictWherePredicate: () => capturedConflictWhere,
    reset: (next: StoreRow[]) => {
      rows = next.map((r) => ({ ...r }));
      captured = undefined;
      capturedSelect = undefined;
      capturedSelects.length = 0;
      capturedExecuteTerms = undefined;
      capturedDelete = undefined;
      capturedConflictWhere = undefined;
      update.mockClear();
      select.mockClear();
      execute.mockClear();
      del.mockClear();
      insert.mockClear();
    },
  };
}
