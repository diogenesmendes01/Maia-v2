/**
 * P9d — Field-path resolver.
 *
 * Resolves a dot-delimited path (e.g. `"transaction.amount"`) against a
 * caller-supplied context object. Numeric segments index arrays; everything
 * else indexes object properties.
 *
 *  - **Total**: never throws. Returns `undefined` for any unresolvable lookup.
 *  - **Bounded**: refuses paths deeper than `MAX_FIELD_PATH_DEPTH` segments.
 *    The caller (evaluator) must surface this as
 *    `field_path_depth_exceeded`; the resolver itself returns `undefined`.
 *  - **Prototype-safe**: explicit `__proto__`/`constructor`/`prototype`
 *    segment checks prevent prototype pollution lookups even though the
 *    evaluator only ever **reads** values.
 */

import { MAX_FIELD_PATH_DEPTH } from './constants.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Split a dot-delimited path into segments. Empty segments (`"a..b"`) are
 * preserved as empty strings so the caller can decide whether they are an
 * error (we treat them as unresolvable, mirroring `obj[""]`).
 */
export function splitFieldPath(path: string): string[] {
  if (path === '') {
    // Empty path explicitly → no segments, lookup will return the root.
    return [];
  }
  return path.split('.');
}

/**
 * `true` when `splitFieldPath(path).length > MAX_FIELD_PATH_DEPTH`.
 * Avoids actually performing the lookup when the path is too deep.
 */
export function isFieldPathTooDeep(path: string): boolean {
  return splitFieldPath(path).length > MAX_FIELD_PATH_DEPTH;
}

/**
 * Resolve `path` against `context`. Returns `undefined` for any:
 *  - missing segment
 *  - prototype-bound key (`__proto__`, `constructor`, `prototype`)
 *  - traversal through `null`/`undefined`
 *  - traversal through a primitive (string indexing returns `undefined`)
 *  - non-numeric segment indexing into an array (so `arr.foo` → `undefined`)
 *
 * The empty path returns the root `context` value as-is.
 */
export function resolveFieldPath(
  context: unknown,
  path: string,
): unknown {
  const segments = splitFieldPath(path);
  if (segments.length === 0) return context;
  if (segments.length > MAX_FIELD_PATH_DEPTH) return undefined;

  let cursor: unknown = context;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;

    if (Array.isArray(cursor)) {
      // Array path step requires a non-negative integer index. Any other
      // segment shape (named property, negative number, `NaN`) is unresolvable.
      const idx = Number(segment);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) {
        return undefined;
      }
      cursor = cursor[idx];
      continue;
    }

    if (typeof cursor !== 'object') {
      // Walking into a primitive — treat as unresolvable (we never want to
      // surface things like `"hello".length` through the DSL).
      return undefined;
    }

    if (FORBIDDEN_KEYS.has(segment)) return undefined;

    // Use `Object.hasOwn` to skip prototype-bound keys; missing keys → undefined.
    if (!Object.hasOwn(cursor as object, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
