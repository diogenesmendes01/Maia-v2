/**
 * A FRONTEIRA DE IMPORT do console — issue #596.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A propriedade
 * ─────────────────────────────────────────────────────────────────────────
 * `src/config/env.ts` valida o subset `runtime` INTEIRO no import (é a sua
 * razão de existir: o boot fail-closed do container `app`). Qualquer módulo que
 * o alcance PAGA esse boot. Enquanto o console o alcançava — direto em
 * `src/admin-ui/trpc/tool-enablement.ts` e
 * `src/admin-ui/trpc/routers/tools-catalog.ts`, e transitivamente por
 * `@/db/client.ts` → `src/lib/logger.ts`, `src/lib/llm-settings.ts`,
 * `src/governance/idempotency.ts`,
 * `src/control-plane/runtime-trace/lib/hmac.ts`,
 * `src/gateway/staging-crypto.ts` e `src/config/feature-flags.ts` — ele exigia
 * as seis `BACKUP_*`, credencial de S3 inclusive, num processo que nunca roda
 * backup.
 *
 * Chamar `loadAdminConfig()` no boot NÃO resolve isso sozinho: o console
 * passaria a validar `admin-ui` E a continuar validando `runtime`. Por isso a
 * fronteira é uma asserção própria, e não um corolário do outro teste.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O segundo caso é o contrapeso, e sem ele este arquivo seria perigoso
 * ─────────────────────────────────────────────────────────────────────────
 * "Ninguém importa `src/config/env.ts`" é trivial de satisfazer da pior forma:
 * apagando o import do RUNTIME também, e com ele o boot fail-closed do
 * container `app`. O segundo `describe` fixa o outro lado — os entrypoints do
 * runtime continuam alcançando o singleton.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que o grafo mede
 * ─────────────────────────────────────────────────────────────────────────
 * Imports ESTÁTICOS de valor, que são os que rodam no LOAD do módulo:
 *   - `import type { ... }` e `import { type A, type B }` são apagados pelo
 *     compilador — não geram require;
 *   - `import('...')` DINÂMICO não roda no load. Ficam de fora de propósito, e
 *     os dois que existem (`@/lib/llm/cache-invalidation.js` em
 *     `src/lib/llm-settings.ts:579` e `@/agent/turn-context/cache.js` em
 *     `src/db/repositories/profile-repos.ts:79`) são publicações de invalidação
 *     de cache best-effort, com o erro engolido no ponto da chamada. Eles
 *     continuam alcançando `src/config/env.ts` a partir do console, e isso está
 *     registrado como resíduo conhecido da #596 — degradação até o TTL do
 *     cache, nunca um boot ou um request reprovado.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const SRC = join(REPO_ROOT, 'src');
const RUNTIME_SINGLETON = join(SRC, 'config/env.ts');

/** Comentários fora — um docstring que CITA um import não é um import. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

/**
 * Specifiers de import ESTÁTICO DE VALOR de um arquivo. `import type` e um
 * bloco `{ type A, type B }` inteiro são descartados: não sobrevivem à
 * compilação, logo não carregam módulo nenhum em runtime.
 */
function staticValueImports(file: string): string[] {
  const text = stripComments(readFileSync(file, 'utf8'));
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)(\s+type)?\s([^;]*?)\sfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) continue;
    const clause = m[2]!;
    const named = /^\s*\{([\s\S]*)\}\s*$/.exec(clause);
    if (named) {
      const specs = named[1]!.split(',').map((s) => s.trim()).filter(Boolean);
      if (specs.length > 0 && specs.every((s) => /^type\s/.test(s))) continue;
    }
    out.push(m[3]!);
  }
  // `import 'x'` sem binding (efeito colateral) também carrega o módulo.
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  while ((m = bare.exec(text)) !== null) out.push(m[1]!);
  return out;
}

/** Resolve um specifier para um arquivo do repositório, ou `null`. */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null;
  const candidates: string[] = [];
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
  if (base.endsWith('.jsx')) candidates.push(`${base.slice(0, -4)}.tsx`);
  candidates.push(`${base}.ts`, `${base}.tsx`, base, join(base, 'index.ts'));
  for (const candidate of candidates) {
    if (existsFile(candidate)) return candidate;
  }
  return null;
}

function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(entry)) out.push(abs);
  }
  return out;
}

/**
 * Busca em largura a partir de `entries`; devolve, para cada alcance de
 * `target`, a CADEIA de arquivos que leva até ele — a mensagem que diz por onde
 * consertar, e não só que quebrou.
 */
function pathsTo(entries: readonly string[], target: string): string[] {
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const entry of entries) {
    parent.set(entry, null);
    queue.push(entry);
  }
  const found: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const spec of staticValueImports(file)) {
      const resolved = resolveSpecifier(spec, file);
      if (resolved === null) continue;
      if (resolved === target) {
        const chain: string[] = [];
        let cursor: string | null = file;
        while (cursor != null) {
          chain.unshift(relative(REPO_ROOT, cursor));
          cursor = parent.get(cursor) ?? null;
        }
        found.push(`${chain.join(' → ')} → ${relative(REPO_ROOT, target)}`);
        continue;
      }
      if (parent.has(resolved)) continue;
      parent.set(resolved, file);
      queue.push(resolved);
    }
  }
  return [...new Set(found)].sort();
}

describe('o console NÃO alcança src/config/env.ts (#596)', () => {
  it('nenhum import estático a partir de src/admin-ui/** chega ao singleton do runtime', () => {
    const paths = pathsTo(walk(join(SRC, 'admin-ui')), RUNTIME_SINGLETON);
    expect(
      paths,
      'Um caminho de import do console até `src/config/env.ts` volta a validar o subset ' +
        '`runtime` no boot do container do admin-ui — e a exigir dele as seis BACKUP_* ' +
        '(credencial de S3 inclusive) num processo que nunca roda backup. ' +
        'Módulo COMPARTILHADO entre containers lê o contrato por `@/config/contract-env.js`; ' +
        'código que é só do console lê pelo loader `admin-ui`.',
    ).toEqual([]);
  });

  it('o alvo existe e o grafo o encontra — a busca não está vacuamente verde', () => {
    // Sem este caso, um bug no resolver (ou um rename de `env.ts`) deixaria o
    // caso acima verde por não achar nada, em vez de por não haver nada.
    expect(existsFile(RUNTIME_SINGLETON)).toBe(true);
    expect(pathsTo([join(SRC, 'index.ts')], RUNTIME_SINGLETON).length).toBeGreaterThan(0);
  });
});

describe('o runtime CONTINUA alcançando src/config/env.ts (o contrapeso)', () => {
  /**
   * Os entrypoints de processo que validam o subset `runtime` no boot,
   * FIXADOS por nome.
   *
   * Esta lista é o registro do estado anterior à #596, e é isso que a torna
   * útil: sete scripts (`import-ofx`, `seed-holidays`, ...) alcançavam
   * `src/config/env.ts` DE CARONA, por `@/lib/logger.js` ou `@/db/client.ts`.
   * Tirar o singleton daqueles módulos compartilhados — que é o que fez o
   * console parar de validar `runtime` — teria tirado o boot fail-closed deles
   * junto, em silêncio. Cada um ganhou um `import '@/config/env.js'` explícito,
   * e este caso é o que impede a próxima remoção de passar despercebida.
   *
   * Um entrypoint AUSENTE daqui não valida o contrato no boot, e isso também é
   * afirmação: `scripts/migrate.ts` usa o subset `migrator` (#516),
   * `scripts/doctor.ts` é read-only por construção (#517), `scripts/config.ts`
   * é o próprio validador, e os `check-*` não tocam configuração.
   */
  const COM_BOOT_FAIL_CLOSED = [
    'scripts/activate-synthetic-probe.ts',
    'scripts/backfill-agent-turns.ts',
    'scripts/backup.ts',
    'scripts/dlq.ts',
    'scripts/embeddings-rebuild.ts',
    'scripts/import-ofx.ts',
    'scripts/import-review.ts',
    'scripts/p8d-migration-priorities.ts',
    'scripts/p8e-seed-policies.ts',
    'scripts/pessoa-add.ts',
    'scripts/restore-test.ts',
    'scripts/seed-holidays.ts',
    'scripts/seed-proposals-fixtures.ts',
    'scripts/setup.ts',
    'src/index.ts',
  ] as const;

  it('o conjunto de entrypoints que alcançam o singleton é EXATAMENTE o fixado', () => {
    const entrypoints = [
      'src/index.ts',
      ...readdirSync(join(REPO_ROOT, 'scripts'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => `scripts/${f}`),
    ];
    const alcancam = entrypoints
      .filter((e) => pathsTo([join(REPO_ROOT, e)], RUNTIME_SINGLETON).length > 0)
      .sort();
    expect(
      alcancam,
      'Um entrypoint que SAIU da lista perdeu a validação fail-closed do subset `runtime` no ' +
        'boot — provavelmente porque um módulo compartilhado deixou de importar ' +
        '`@/config/env.js`. Devolva a garantia com um `import \'@/config/env.js\';` ' +
        'explícito no entrypoint, não reintroduzindo o singleton no módulo compartilhado. ' +
        'Um entrypoint que ENTROU precisa de uma linha nesta lista dizendo por quê.',
    ).toEqual([...COM_BOOT_FAIL_CLOSED]);
  });
});
