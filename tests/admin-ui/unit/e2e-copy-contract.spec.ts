/**
 * Issue #481 item 4 — contrato de CÓPIA entre as specs Playwright e o console.
 *
 * As specs de `tests/admin-ui/e2e/` foram traduzidas para pt-BR mas nunca
 * executadas: a suíte Playwright depende do dev server + fixtures e a
 * execução em CI é o #472 (parte A). Enquanto isso, um seletor que aponta
 * para um texto que não existe mais falha só quando alguém rodar a suíte —
 * e foi assim que `trace-explorer.spec.ts` ficou com "Request full snapshot"
 * (inglês) apontando para um botão que hoje diz "Solicitar snapshot
 * completo".
 *
 * O que dá para verificar SEM navegador: que todo texto literal usado como
 * seletor nas specs e2e ainda EXISTE no código-fonte do console. Não prova
 * que a tela renderiza (isso é o #472), mas transforma drift de cópia — a
 * falha mais provável e mais silenciosa — em erro de unit test, que já roda
 * em CI hoje.
 *
 * Fora de alcance por desenho: seletores compostos em runtime (interpolação
 * de contadores). Ficam no ALLOWLIST abaixo, com a fonte anotada, e o teste
 * garante que o allowlist não apodrece.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const E2E_DIR = join(REPO_ROOT, 'tests/admin-ui/e2e');
const ADMIN_UI_SRC = join(REPO_ROOT, 'src/admin-ui');

const SOURCE_EXTS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo']);

/**
 * Textos que o console COMPÕE em runtime — a string literal não existe no
 * fonte, então não podem ser verificados estaticamente. Cada entrada aponta
 * o trecho que os produz.
 */
const COMPOSED_AT_RUNTIME: Record<string, string> = {
  // `{proposal.approvals.length} de {proposal.required_roles.length} aprovações`
  '1 de 2 aprovações': 'src/admin-ui/app/proposals/[id]/page.tsx',
};

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listSourceFiles(full, out);
    else if (SOURCE_EXTS.has(extname(entry))) out.push(full);
  }
  return out;
}

/** Literais usados como seletor de TEXTO nas specs Playwright. */
function extractCopySelectors(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    // page.locator('text=...') / page.click('text=...')
    /['"]text=([^'"]+)['"]/g,
    // getByRole('button', { name: '...' })
    /name:\s*['"]([^'"]+)['"]/g,
    // expect(...).toContainText('...')
    /toContainText\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const literal = m[1]!.trim();
      if (literal.length > 0) found.add(literal);
    }
  }
  return [...found];
}

const specFiles = readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts'));

// Um único haystack: a pergunta é "esta cópia ainda existe no console?", não
// "em qual arquivo?" — o segundo é ruído (um mesmo rótulo aparece no botão,
// no modal e no aria-label).
const adminUiSource = listSourceFiles(ADMIN_UI_SRC)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

describe('contrato de cópia entre specs e2e e o console (#481)', () => {
  it('encontra specs e2e para inspecionar (guarda contra o teste virar no-op)', () => {
    expect(specFiles.length).toBeGreaterThan(0);
    expect(adminUiSource.length).toBeGreaterThan(1000);
  });

  it.each(specFiles)('%s — todo seletor de texto existe em src/admin-ui', (file) => {
    const source = readFileSync(join(E2E_DIR, file), 'utf8');
    const selectors = extractCopySelectors(source);
    const missing = selectors.filter(
      (s) => COMPOSED_AT_RUNTIME[s] === undefined && !adminUiSource.includes(s),
    );
    expect(
      missing,
      `${file}: seletor(es) sem correspondência no console — a cópia mudou ou ` +
        `a spec ficou para trás: ${missing.map((s) => JSON.stringify(s)).join(', ')}`,
    ).toEqual([]);
  });

  it('o allowlist de textos compostos não apodrece', () => {
    const allSelectors = new Set(
      specFiles.flatMap((f) => extractCopySelectors(readFileSync(join(E2E_DIR, f), 'utf8'))),
    );
    const unused = Object.keys(COMPOSED_AT_RUNTIME).filter((s) => !allSelectors.has(s));
    expect(unused, `entradas do allowlist não usadas por nenhuma spec: ${unused.join(', ')}`).toEqual(
      [],
    );
  });
});
