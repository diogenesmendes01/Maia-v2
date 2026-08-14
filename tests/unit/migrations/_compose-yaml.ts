/**
 * Minimal reader for the two Compose files in this repo (issue #516).
 *
 * WHY NOT A YAML LIBRARY. `yaml` exists only as a TRANSITIVE dependency here,
 * and this repo has already refused to promote it for a guard of exactly this
 * shape — see the note at the top of
 * `tests/unit/observability/slo-rules.spec.ts`. Adding a dependency also means
 * touching `package-lock.json`, which the `preinstall` guard pins to npm
 * 11.5.2.
 *
 * WHY NOT REGEX. The property under test is *nesting*
 * (`services.app.depends_on.migrate.condition`), and a regex over a flat file
 * cannot tell which service a `condition:` belongs to — which is precisely the
 * mistake the guard exists to catch.
 *
 * SO: a parser for the small, regular subset those two files use — 2-space
 * indentation, block maps, block sequences, quoted or bare scalars, full-line
 * `#` comments. It is deliberately STRICT: any line it does not fully
 * understand throws `ComposeParseError` naming the file and line. A parser
 * that silently skipped what it could not read would turn a compose file it
 * misunderstood into a green test, which is the one failure mode a guard like
 * this must not have.
 */
import { readFileSync } from 'node:fs';

export type ComposeNode = string | ComposeNode[] | { [key: string]: ComposeNode };

export class ComposeParseError extends Error {
  constructor(file: string, lineNo: number, line: string, why: string) {
    super(`${file}:${lineNo}: ${why}\n  ${line}`);
    this.name = 'ComposeParseError';
  }
}

interface RawLine {
  readonly indent: number;
  readonly text: string;
  readonly no: number;
}

/** Strip a quoted scalar; leave everything else byte-for-byte. */
function scalar(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Flow sequence (`["CMD", "x"]`) — kept as a real array so `command:` can be
 * asserted the same way whether it was written in flow or block style.
 * Splits on top-level commas only, so a comma inside a quoted element stays
 * part of that element.
 */
function flowSequence(raw: string): string[] {
  const inner = raw.trim().slice(1, -1);
  if (inner.trim() === '') return [];
  const out: string[] = [];
  let buf = '';
  let quote: string | null = null;
  let escaped = false;
  for (const ch of inner) {
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      buf += ch;
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ',') {
      out.push(scalar(buf));
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(scalar(buf));
  return out;
}

const KEY_LINE = /^([A-Za-z0-9_.@/+-]+):(?:\s+(.*))?$/;

function parseBlock(lines: RawLine[], start: number, indent: number, file: string): [ComposeNode, number] {
  const first = lines[start];
  if (!first) return ['', start];

  if (first.text.startsWith('- ') || first.text === '-') {
    const seq: ComposeNode[] = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new ComposeParseError(file, line.no, line.text, 'unexpected indentation inside a sequence');
      }
      if (!line.text.startsWith('- ') && line.text !== '-') {
        break;
      }
      const item = line.text === '-' ? '' : line.text.slice(2);
      const inline = KEY_LINE.exec(item);
      if (inline && (inline[2] === undefined || inline[2] === '')) {
        // `- key:` opening a nested map inside a sequence: not used by these
        // files. Refuse rather than guess.
        throw new ComposeParseError(file, line.no, line.text, 'nested map inside a sequence is not supported');
      }
      seq.push(scalar(item));
      i += 1;
    }
    return [seq, i];
  }

  const map: Record<string, ComposeNode> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new ComposeParseError(file, line.no, line.text, 'unexpected indentation inside a map');
    }
    const m = KEY_LINE.exec(line.text);
    if (!m) {
      throw new ComposeParseError(file, line.no, line.text, 'line is neither a `key: value` nor a `- item`');
    }
    const key = m[1]!;
    const value = m[2];
    if (value === undefined || value === '') {
      const next = lines[i + 1];
      if (!next || next.indent <= indent) {
        map[key] = '';
        i += 1;
        continue;
      }
      const [child, consumed] = parseBlock(lines, i + 1, next.indent, file);
      map[key] = child;
      i = consumed;
      continue;
    }
    const trimmed = value.trim();
    map[key] = trimmed.startsWith('[') && trimmed.endsWith(']') ? flowSequence(trimmed) : scalar(trimmed);
    i += 1;
  }
  return [map, i];
}

/** Parse a Compose file from disk. Throws on anything it does not understand. */
export function parseComposeFile(path: string): Record<string, ComposeNode> {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const lines: RawLine[] = [];
  text.split('\n').forEach((raw, idx) => {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) return;
    if (raw.includes('\t')) {
      throw new ComposeParseError(path, idx + 1, raw, 'tab in indentation');
    }
    lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim(), no: idx + 1 });
  });
  const [node, consumed] = parseBlock(lines, 0, 0, path);
  if (consumed !== lines.length) {
    const stray = lines[consumed]!;
    throw new ComposeParseError(path, stray.no, stray.text, 'trailing content the parser did not consume');
  }
  return node as Record<string, ComposeNode>;
}

/** Narrowing helpers — a wrong shape is a test failure, not a silent `undefined`. */
export function asMap(node: ComposeNode | undefined, what: string): Record<string, ComposeNode> {
  if (node === undefined || typeof node === 'string' || Array.isArray(node)) {
    throw new Error(`expected ${what} to be a map, got ${JSON.stringify(node)}`);
  }
  return node;
}

export function asString(node: ComposeNode | undefined, what: string): string {
  if (typeof node !== 'string') {
    throw new Error(`expected ${what} to be a scalar, got ${JSON.stringify(node)}`);
  }
  return node;
}

/**
 * Compose interpolation: `${VAR}`, `${VAR:-default}`, `${VAR:?message}`.
 * A `:?` variable that is absent from `env` throws — the same fail-closed
 * behaviour `docker compose` has, so a test cannot accidentally "resolve" a
 * required production credential to the empty string.
 */
export function interpolate(value: string, env: Readonly<Record<string, string>>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([-?])([^}]*))?\}/g, (_all, name: string, op, rest: string) => {
    const present = env[name];
    if (present !== undefined && present !== '') return present;
    if (op === '-') return rest;
    if (op === '?') throw new Error(`compose interpolation: ${name} is required (\${${name}:?...})`);
    return '';
  });
}
