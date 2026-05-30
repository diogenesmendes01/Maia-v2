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
import { vi } from 'vitest';

export interface StoreRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  status: string;
  /** ISO string or Date; only present on pending_questions rows. */
  expira_em?: string | Date | null;
  [k: string]: unknown;
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
  | { kind: 'raw'; text: string };

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
    const run = (): StoreRow[] => {
      const terms = parsePredicate(capturedSelect);
      return rows.filter((row) => rowMatches(row, terms, now));
    };
    const chain = {
      from: (_table: unknown) => chain,
      where: (predicate: unknown) => {
        capturedSelect = predicate;
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
    lastExecuteTerms: () => capturedExecuteTerms,
    lastDeletePredicate: () => capturedDelete,
    lastConflictWherePredicate: () => capturedConflictWhere,
    reset: (next: StoreRow[]) => {
      rows = next.map((r) => ({ ...r }));
      captured = undefined;
      capturedSelect = undefined;
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
