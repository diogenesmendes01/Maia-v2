/**
 * Leitor de SCHEMA a partir de `migrations/*.sql`, para testes SEM BANCO.
 *
 * Existe porque a classe de defeito mais cara do módulo de onboarding é
 * "o código escreve algo que o schema recusa": literal fora de um
 * `CHECK (col IN (…))`, string em coluna `uuid`, FK cujo alvo ainda não existe.
 * Nenhuma dessas coisas é visível para um teste com store falso — um store
 * falso não tem constraint. E a suíte que TEM banco só roda com `TEST_DB_URL`.
 *
 * Este módulo não é um parser de SQL geral; é o mínimo para responder três
 * perguntas contra os arquivos de migration, na ordem em que o runner os
 * aplica. As respostas foram conferidas contra um Postgres real (12 colunas,
 * incluindo os casos multi-migration `agents.status` 007→110 e
 * `agent_drift_alerts.drift_type` 026→042) e batem exatamente com
 * `pg_get_constraintdef` / `information_schema.columns`.
 *
 * Não é `.spec.ts` de propósito: o vitest coleta `tests/**\/*.spec.ts`, então
 * este arquivo é só biblioteca.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/** Migrations FORWARD, na ordem em que o runner as aplica (sort por nome). */
export function forwardMigrations(): Array<{ id: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
    .sort()
    .map((id) => ({ id, sql: readFileSync(join(MIGRATIONS_DIR, id), 'utf8') }));
}

/**
 * Statements separados por `;` de topo, sem comentários e sem corpos
 * dollar-quoted. Precisa ser consciente de string literal e de `$tag$…$tag$`:
 * um `;` dentro do corpo de uma função partiria o statement no lugar errado e
 * o parser passaria a enxergar constraints que não existem.
 */
export function statements(sql: string): string[] {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (sql[i] === "'") {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += sql.slice(start, i);
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      // O corpo vira espaço: nada dentro dele define constraint de coluna.
      i = end === -1 ? sql.length : end + tag.length;
      out += ' ';
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isCreateTable(stmt: string, table: string): boolean {
  return new RegExp(
    `^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${table}"?\\b`,
    'i',
  ).test(stmt);
}

/** Os literais de `<col> IN ('a','b',…)` dentro de um trecho de SQL. */
function inListFor(fragment: string, column: string): string[] | null {
  const re = new RegExp(`\\b${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i');
  const m = re.exec(fragment);
  if (!m) return null;
  const literals = [...m[1]!.matchAll(/'((?:[^']|'')*)'/g)].map((x) =>
    x[1]!.replace(/''/g, "'"),
  );
  return literals.length > 0 ? literals : null;
}

export type EffectiveCheck = { set: string[]; source: string };

/**
 * O CHECK EFETIVO de `table.column` depois de aplicar as migrations em ordem.
 *
 * Cobre as duas formas que o repo usa: a definição dentro do `CREATE TABLE`, e
 * o par `ALTER TABLE … DROP CONSTRAINT` + `ALTER TABLE … ADD CONSTRAINT …
 * CHECK (…)` das migrations de alargamento. A última definição encontrada
 * vence — que é exatamente a semântica do banco.
 */
export function effectiveCheckIn(table: string, column: string): EffectiveCheck {
  let found: EffectiveCheck | null = null;
  for (const { id, sql } of forwardMigrations()) {
    for (const stmt of statements(sql)) {
      const isAddCheck =
        new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?"?${table}"?\\b`, 'i').test(stmt) &&
        /\bADD\s+CONSTRAINT\b/i.test(stmt) &&
        /\bCHECK\b/i.test(stmt);
      if (!isCreateTable(stmt, table) && !isAddCheck) continue;
      const literals = inListFor(stmt, column);
      if (literals) found = { set: literals, source: id };
    }
  }
  if (!found) {
    throw new Error(
      `nenhum CHECK (${column} IN (…)) encontrado para ${table} em migrations/ — ` +
        'o parser precisa ser ajustado, ou a coluna deixou de ter CHECK',
    );
  }
  return found;
}

/**
 * As colunas declaradas `uuid` no `CREATE TABLE` de `table`, mais as
 * acrescentadas depois por `ALTER TABLE … ADD COLUMN … uuid`.
 *
 * Serve à classe "string não-uuid numa coluna uuid" — que é pior que um CHECK
 * violado quando o caller engole a exceção: vira uma escrita que simplesmente
 * não acontece.
 */
export function uuidColumnsOf(table: string): Set<string> {
  const cols = new Set<string>();
  for (const { sql } of forwardMigrations()) {
    for (const stmt of statements(sql)) {
      if (isCreateTable(stmt, table)) {
        const body = stmt.slice(stmt.indexOf('('));
        for (const line of body.split('\n')) {
          const m = /^\s*"?([a-z_][a-z0-9_]*)"?\s+uuid\b/i.exec(line);
          if (m) cols.add(m[1]!.toLowerCase());
        }
        continue;
      }
      const add = new RegExp(
        `^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?"?${table}"?\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?([a-z_][a-z0-9_]*)"?\\s+uuid\\b`,
        'i',
      ).exec(stmt);
      if (add) cols.add(add[1]!.toLowerCase());
    }
  }
  if (cols.size === 0) {
    throw new Error(`nenhuma coluna uuid encontrada para ${table} — parser desatualizado?`);
  }
  return cols;
}

/** Forma canônica de um uuid, como o Postgres a aceita em `uuid`. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
