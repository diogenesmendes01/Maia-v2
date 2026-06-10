/**
 * P10a (Codex review round-2 finding 2) — rulesRepo.listActive and
 * findByContext must NOT include `eq(learned_rules.ativa, true)` in
 * their predicate.
 *
 * Before this fix the legacy `ativa=true` requirement meant that
 * KSM-approved rules (lifecycle_status='active' but `ativa` left at
 * the DB default) were invisible to the prompt builder. We drop the
 * redundant `ativa=true` predicate and rely on lifecycle_status as
 * the single source of truth for "is this rule LLM-visible".
 *
 * We assert by reading the repositories source — Drizzle's AST when
 * captured at the .where() boundary embeds the whole table schema,
 * so the `ativa` token appears even when no predicate references it.
 * The source-level check is unambiguous: it directly verifies that
 * the `eq(learned_rules.ativa, ...)` call was removed.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

// rulesRepo lives in the cognitive domain module since the repositories.ts
// barrel split (src/db/repositories/cognitive-repos.ts).
const REPOSITORIES_PATH = resolve(__dirname, '../../src/db/repositories/cognitive-repos.ts');

function extractFunctionSource(source: string, marker: string): string {
  // Find the function definition by its declaration line, then walk
  // brace depth until we hit the matching closing brace.
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  let depth = 0;
  let started = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
      started = true;
    } else if (ch === '}') {
      depth--;
      if (started && depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`unterminated function body for ${marker}`);
}

describe('Finding 2 — rulesRepo.listActive uses lifecycle_status, not ativa', () => {
  const source = readFileSync(REPOSITORIES_PATH, 'utf8');

  it('rulesRepo.listActive body does NOT include eq(learned_rules.ativa, ...)', () => {
    const body = extractFunctionSource(
      source,
      'async listActive(tipo: string): Promise<LearnedRule[]>',
    );
    expect(body).toContain('lifecycle_status');
    expect(body).toContain("'active'");
    // No predicate references `learned_rules.ativa` anymore.
    expect(body).not.toMatch(/learned_rules\.ativa\b/);
  });

  it('rulesRepo.findByContext body does NOT include eq(learned_rules.ativa, ...)', () => {
    const body = extractFunctionSource(
      source,
      'async findByContext(tipo: string, contexto: string): Promise<LearnedRule | null>',
    );
    expect(body).toContain('lifecycle_status');
    expect(body).not.toMatch(/learned_rules\.ativa\b/);
  });
});
