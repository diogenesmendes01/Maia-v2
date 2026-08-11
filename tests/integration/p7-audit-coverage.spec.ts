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

/**
 * Exceção controlada (issue #508): os 7 detectores de drift são funções
 * `detect()` puras — quem as executa é `src/cognition/drift/index.ts`, que faz
 * fan-out envolvendo CADA uma em `runCognitiveModule`. Antes da #508 eles
 * instanciavam o SDK da Anthropic direto e por isso escapavam deste gate por
 * acidente (o regex só procurava `callLLM`); com a migração para a fronteira
 * única eles passaram a aparecer, apesar de a cobertura de auditoria não ter
 * mudado.
 *
 * A exceção é o DIRETÓRIO, não os arquivos: o teste abaixo verifica que o
 * orquestrador realmente envolve, para a isenção não apodrecer em silêncio.
 */
const WRAPPED_BY_ORCHESTRATOR: Array<{ dir: string; orchestrator: string }> = [
  { dir: join('src', 'cognition', 'drift'), orchestrator: join('src', 'cognition', 'drift', 'index.ts') },
];

function orchestratorFor(file: string): string | null {
  const hit = WRAPPED_BY_ORCHESTRATOR.find(
    (e) => file.startsWith(e.dir) && file !== e.orchestrator,
  );
  return hit ? hit.orchestrator : null;
}

describe('P7 — audit coverage (grep gate)', () => {
  it('nenhum arquivo em src/agent/* e src/workers/* + src/cognition/* chama o LLM sem envolver com runCognitiveModule', () => {
    const roots = ['src/agent', 'src/workers', 'src/cognition'];
    const offenders: string[] = [];

    for (const root of roots) {
      for (const f of walkTs(root)) {
        // claude.ts é a infra que define callLLM — exclui.
        if (f.endsWith('claude.ts')) continue;
        const src = readFileSync(f, 'utf8');
        // Issue #508: além de `callLLM`, o gate cobre `executeLLM` — senão a
        // migração para o gateway abriria um bypass trivial para o mesmo
        // requisito de auditoria.
        const hasCall = /\b(callLLM|executeLLM)\s*\(/.test(src);
        // Match generic-typed calls: runCognitiveModule<T>(...) or runCognitiveModule(...)
        const hasWrapper = /\brunCognitiveModule\s*[<(]/.test(src);
        if (hasCall && !hasWrapper && orchestratorFor(f) === null) offenders.push(f);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('todo diretório isento tem um orquestrador que de fato envolve em runCognitiveModule', () => {
    for (const { orchestrator } of WRAPPED_BY_ORCHESTRATOR) {
      const src = readFileSync(orchestrator, 'utf8');
      expect(/\brunCognitiveModule\s*[<(]/.test(src), `${orchestrator} não envolve`).toBe(true);
    }
  });
});
