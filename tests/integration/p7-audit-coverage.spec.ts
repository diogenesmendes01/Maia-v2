import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * P7 §9: cognitive_module_log cobre 100% das execuções de módulo.
 *
 * Grep gate — nenhum arquivo em src/{agent,workers,cognition}/ pode chamar
 * callLLM sem envolver com runCognitiveModule. claude.ts é a infra que
 * define callLLM e está excluída.
 *
 * Usa fs.readdirSync (não `glob` npm package) para manter compatibilidade
 * Windows e evitar nova dependência — mesmo padrão de
 * tests/unit/pending-deprecation.spec.ts.
 */
function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkTs(full);
    } else if (entry.endsWith('.ts')) {
      yield full;
    }
  }
}

describe('P7 — audit coverage (grep gate)', () => {
  it('nenhum arquivo em src/agent/* e src/workers/* + src/cognition/* chama callLLM sem envolver com runCognitiveModule', () => {
    const roots = ['src/agent', 'src/workers', 'src/cognition'];
    const offenders: string[] = [];

    for (const root of roots) {
      for (const f of walkTs(root)) {
        // claude.ts é a infra que define callLLM — exclui.
        if (f.endsWith('claude.ts')) continue;
        const src = readFileSync(f, 'utf8');
        const hasCall = /\bcallLLM\s*\(/.test(src);
        const hasWrapper = /\brunCognitiveModule\s*\(/.test(src);
        if (hasCall && !hasWrapper) offenders.push(f);
      }
    }

    expect(offenders).toEqual([]);
  });
});
