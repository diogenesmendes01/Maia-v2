/**
 * Gate: toda chamada ao LLM Gateway declara um workload (issue #508, rodada 1).
 *
 * A regra de lint `no-restricted-imports` impede importar SDK de provider fora
 * dos adapters — mas não impedia chamar o gateway SEM declarar política. O
 * workload `legacy` existia como escape hatch para callers não migrados e, com
 * a migração terminada, virou exatamente isso: um bypass silencioso da
 * política de tier, tentativas e fallback.
 *
 * O tipo já obriga `workload` (é `LLMGatewayRequest`/`callLLM`), então o
 * compilador cobre o caso comum. Este gate cobre o que o tipo não vê:
 *   1. `legacy` (ou qualquer novo escape hatch com esse nome) não voltou;
 *   2. todo call site literal declara `workload` — inclusive os que passam o
 *      objeto por spread ou constroem em duas etapas, onde o `tsc` aceitaria
 *      um `as` e o revisor humano não notaria.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const SRC = join(REPO_ROOT, 'src');

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'generated') continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walkTs(abs, out);
    else if (/\.tsx?$/.test(entry)) out.push(relative(REPO_ROOT, abs).split('\\').join('/'));
  }
  return out;
}

/** Invocações literais do gateway: `callLLM({` / `executeLLM({`. */
const CALL_RE = /\b(?:callLLM|executeLLM)\s*\(\s*\{/g;

/** Janela de linhas em que o `workload:` do objeto precisa aparecer. */
const WINDOW_LINES = 14;

describe('gate: toda chamada ao gateway declara workload (#508)', () => {
  const files = walkTs(SRC).filter(
    // O facade e o próprio gateway definem a API; não são call sites.
    (f) => f !== 'src/lib/claude.ts' && !f.startsWith('src/lib/llm/'),
  );

  it('nenhum call site invoca o gateway sem declarar workload', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        CALL_RE.lastIndex = 0;
        if (!CALL_RE.test(lines[i]!)) continue;
        const window = lines.slice(i, i + WINDOW_LINES).join('\n');
        if (!/\bworkload\s*:/.test(window)) offenders.push(`${file}:${i + 1}`);
      }
    }

    expect(
      offenders,
      'Declare `workload` na chamada (a política de tier, tentativas e fallback ' +
        'vive em src/lib/llm/workloads.ts). Não reintroduza um default.',
    ).toEqual([]);
  });

  it('o escape hatch `legacy` não existe no vocabulário de workloads', async () => {
    const types = readFileSync(join(REPO_ROOT, 'src/lib/llm/types.ts'), 'utf8');
    // Casa a FORMA de membro da união (`| 'legacy'`), não a palavra solta —
    // o comentário que explica a remoção pode (e deve) citá-la.
    expect(types).not.toMatch(/\|\s*'legacy'/);

    const { workloadPolicy } = await import('@/lib/llm/workloads.js');
    // Um workload desconhecido cai no default em vez de explodir, mas não
    // pode existir uma entrada nomeada `legacy` no registro.
    const { _internal } = await import('@/lib/llm/workloads.js');
    expect(Object.keys(_internal.POLICIES)).not.toContain('legacy');
    // E o registro continua respondendo para os workloads reais.
    expect(workloadPolicy('reasoner').default_tier).toBe('main');
  });

  it('o facade callLLM não tem default de workload', () => {
    const facade = readFileSync(join(REPO_ROOT, 'src/lib/claude.ts'), 'utf8');
    expect(facade).not.toMatch(/workload\s*:\s*params\.workload\s*\?\?/);
    expect(facade).toMatch(/workload:\s*LLMWorkload;/);
  });
});
