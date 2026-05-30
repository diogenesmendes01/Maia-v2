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

export interface TenantScopedUpdateStore {
  /** The object to inject as `@/db/client.js`'s `db`. */
  db: { update: (...args: unknown[]) => unknown; select: (...args: unknown[]) => unknown };
  /** Live rows (mutated in place by applied UPDATEs). */
  rows: StoreRow[];
  /** The drizzle predicate captured from the most recent UPDATE `.where(...)`. */
  lastPredicate: () => unknown;
  /** The drizzle predicate captured from the most recent SELECT `.where(...)`. */
  lastSelectPredicate: () => unknown;
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

  return {
    db: { update, select },
    get rows() {
      return rows;
    },
    lastPredicate: () => captured,
    lastSelectPredicate: () => capturedSelect,
    reset: (next: StoreRow[]) => {
      rows = next.map((r) => ({ ...r }));
      captured = undefined;
      capturedSelect = undefined;
      update.mockClear();
      select.mockClear();
    },
  };
}
