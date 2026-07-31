/**
 * Issue #516 §1 — the `maia migrate` CLI surface.
 *
 * Only the DATABASE-FREE parts are exercised here: argument parsing, the
 * offline artifact check (`migrate check`, which is what CI runs — a lint job
 * has no `DATABASE_URL`) and the manifest command. The exit codes are pinned
 * because the Compose job and CI switch on them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXIT_DRIFT,
  EXIT_ERROR,
  EXIT_OK,
  cmdCheck,
  cmdManifest,
  isDirectInvocation,
  parseArgs,
  run,
} from '@/cli/maia.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'maia-cli-'));
}

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseArgs', () => {
  it('handles positionals, --flag, --flag=value and --flag value', () => {
    const flags = parseArgs(['migrate', 'repair', '--id', '110_x.sql', '--reason=because', '--yes']);
    expect(flags.positional).toEqual(['migrate', 'repair']);
    expect(flags.named.id).toBe('110_x.sql');
    expect(flags.named.reason).toBe('because');
    expect(flags.named.yes).toBe(true);
  });

  it('does not swallow the next flag as a value', () => {
    const flags = parseArgs(['--json', '--strict']);
    expect(flags.named.json).toBe(true);
    expect(flags.named.strict).toBe(true);
  });
});

describe('maia migrate check (offline, no database)', () => {
  it('passes on the REAL artifact in this repo', () => {
    expect(cmdCheck(false)).toBe(EXIT_OK);
    expect(stdout.join('')).toMatch(/migrate check passed/);
  });

  it('fails with EXIT_DRIFT when a forward migration has no _down sibling', () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, '001_a.sql'), 'SELECT 1;\n');
      expect(cmdCheck(false, dir)).toBe(EXIT_DRIFT);
      expect(stderr.join('')).toMatch(/missing its _down\.sql sibling/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a filename has no conforming numeric prefix', () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'schema.sql'), 'SELECT 1;\n');
      writeFileSync(join(dir, 'schema_down.sql'), 'SELECT 1;\n');
      expect(cmdCheck(false, dir)).toBe(EXIT_DRIFT);
      expect(stderr.join('')).toMatch(/no conforming numeric prefix/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits machine-readable JSON with --json', () => {
    expect(cmdCheck(true)).toBe(EXIT_OK);
    const parsed = JSON.parse(stdout.join('')) as { ok: boolean; migration_count: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.migration_count).toBeGreaterThan(100);
  });
});

describe('maia migrate manifest (offline)', () => {
  it('prints the release manifest as JSON', () => {
    expect(cmdManifest(true)).toBe(EXIT_OK);
    const parsed = JSON.parse(stdout.join('')) as { expected_head: string };
    expect(parsed.expected_head).toMatch(/\.sql$/);
  });
});

describe('argument validation refuses dangerous or ambiguous invocations', () => {
  it('rejects an unknown command group', async () => {
    expect(await run(['nonsense'])).toBe(EXIT_ERROR);
  });

  it('rejects an unknown migrate subcommand', async () => {
    expect(await run(['migrate', 'nuke'])).toBe(EXIT_ERROR);
  });

  it('prints usage for no arguments', async () => {
    expect(await run([])).toBe(EXIT_OK);
    expect(stdout.join('')).toMatch(/maia migrate <command>/);
  });

  it('refuses repair without --id, --resolution, --reason, --actor and --yes', async () => {
    // Every one of these guards exists because `repair` is the single command
    // that can declare a partially-applied migration "done" on an operator's
    // word. It never touches the database until all of them are satisfied.
    expect(await run(['migrate', 'repair'])).toBe(EXIT_ERROR);
    expect(await run(['migrate', 'repair', '--id', '110_x.sql'])).toBe(EXIT_ERROR);
    expect(
      await run(['migrate', 'repair', '--id', '110_x.sql', '--resolution', 'applied']),
    ).toBe(EXIT_ERROR);
    expect(
      await run([
        'migrate',
        'repair',
        '--id',
        '110_x.sql',
        '--resolution',
        'applied',
        '--actor',
        'ops',
        '--reason',
        'short',
      ]),
    ).toBe(EXIT_ERROR);
    expect(stderr.join('')).toMatch(/at least 10 characters/);
  });

  it('refuses repair without the explicit --yes acknowledgement', async () => {
    expect(
      await run([
        'migrate',
        'repair',
        '--id',
        '110_x.sql',
        '--resolution',
        'applied',
        '--actor',
        'ops-oncall',
        '--reason',
        'verified column exists in production',
      ]),
    ).toBe(EXIT_ERROR);
    expect(stderr.join('')).toMatch(/needs --yes/);
  });

  it('rejects a resolution outside applied|pending', async () => {
    expect(
      await run(['migrate', 'repair', '--id', '110_x.sql', '--resolution', 'skip', '--yes']),
    ).toBe(EXIT_ERROR);
  });
});

describe('entrypoint guard', () => {
  it('does not treat an importing test as the process entrypoint', () => {
    expect(isDirectInvocation(undefined, import.meta.url)).toBe(false);
    expect(isDirectInvocation('/some/other/file.ts', import.meta.url)).toBe(false);
  });
});
