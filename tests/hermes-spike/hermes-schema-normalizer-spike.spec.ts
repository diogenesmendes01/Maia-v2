/**
 * P06 (§9.1 validação 4) — o porte do sanitizador contra o sanitizador Python
 * PINADO, sobre os vetores do fixture e sobre TODA tool do registry da Maia.
 * Pula sem `MAIA_HERMES_WORKER_PYTHON`/`MAIA_HERMES_UPSTREAM`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify } from '@/integrations/hermes/canonical-json.js';
import { hermesToolParameters } from '@/integrations/hermes/hermes-schema-normalizer.js';

const PYTHON = process.env.MAIA_HERMES_WORKER_PYTHON;
const UPSTREAM = process.env.MAIA_HERMES_UPSTREAM;
// O registry carrega a config, que recusa `MAIA_*` fora do contrato: as duas
// do spike saem do env antes do import (dinâmico, dentro do teste).
delete process.env.MAIA_HERMES_WORKER_PYTHON;
delete process.env.MAIA_HERMES_UPSTREAM;
const d = PYTHON && UPSTREAM ? describe : describe.skip;
const SEP = process.platform === 'win32' ? ';' : ':';

type Entry = { name: string; model: string; input_schema: unknown };

function sanitizePython(entries: Entry[]): Map<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'maia-hermes-sanitize-'));
  try {
    const file = join(dir, 'tools.json');
    writeFileSync(file, JSON.stringify(entries));
    const out = spawnSync(
      PYTHON as string,
      [resolve('tests/hermes-spike/python/sanitize_tool_schemas.py'), file],
      {
        encoding: 'utf8',
        env: {
          SystemRoot: process.env.SystemRoot ?? '',
          PATH: process.env.PATH ?? '',
          TEMP: dir,
          TMP: dir,
          PYTHONPATH: `${UPSTREAM as string}${SEP}${resolve('.')}`,
          PYTHONUTF8: '1',
          HERMES_HOME: join(dir, 'home'),
        },
      },
    );
    if (out.status !== 0) throw new Error(out.stderr.slice(-800));
    const parsed = JSON.parse(out.stdout.trim().split('\n').at(-1) as string) as Array<{
      name: string;
      parameters: unknown;
    }>;
    return new Map(parsed.map((p) => [p.name, p.parameters]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

d('spike — porte do sanitizador contra o Hermes pinado', () => {
  it('o fixture de vetores continua sendo o que o Python produz', () => {
    const { vectors } = JSON.parse(
      readFileSync(resolve('tests/fixtures/hermes-schema-sanitizer/vectors.json'), 'utf8'),
    ) as { vectors: Array<Entry & { expected: unknown }> };
    const py = sanitizePython(vectors);
    for (const v of vectors) {
      expect(canonicalJsonStringify(py.get(v.name)), v.name).toBe(
        canonicalJsonStringify(v.expected),
      );
    }
  }, 60_000);

  it('toda tool do registry: o porte reproduz o Python, sem recusa', async () => {
    const { REGISTRY } = await import('@/tools/_registry.js');
    const { buildToolSchema } = await import('@/tools/schema-json.js');
    const entries: Entry[] = [];
    // Um modelo do caminho genérico e um Kimi (reescrita Moonshot por cima).
    for (const model of ['anthropic/claude-sonnet-4.6', 'moonshotai/kimi-k2']) {
      for (const tool of Object.values(REGISTRY)) {
        const built = buildToolSchema(tool);
        if (built) {
          entries.push({ name: `${model}:${built.name}`, model, input_schema: built.input_schema });
        }
      }
    }
    expect(entries.length).toBeGreaterThan(80);
    const py = sanitizePython(entries);
    const reescritas: string[] = [];
    for (const e of entries) {
      const ts = canonicalJsonStringify(hermesToolParameters(e.input_schema, e.model));
      expect(ts, e.name).toBe(canonicalJsonStringify(py.get(e.name)));
      if (ts !== canonicalJsonStringify(e.input_schema)) reescritas.push(e.name);
    }
    // O Hermes reescreve parte das tools reais: sem o porte, cada uma delas
    // seria `tool_surface_mismatch` no gateway.
    expect(reescritas.filter((n) => n.startsWith('anthropic/')).length).toBeGreaterThan(0);
    expect(reescritas.filter((n) => n.startsWith('moonshotai/')).length).toBeGreaterThan(0);
  }, 120_000);
});
