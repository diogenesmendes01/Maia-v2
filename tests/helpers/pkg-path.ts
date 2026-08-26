/**
 * Issue #571 — resolver um arquivo DENTRO de um pacote instalado, de um jeito
 * que sobreviva a uma `git worktree`.
 *
 * ## O defeito que isto substitui
 *
 * Dois specs montavam o caminho de um executável de `node_modules` por
 * caminho relativo:
 *
 *   new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)   // ao ARQUIVO
 *   resolve('node_modules/vitest/vitest.mjs')                            // ao CWD
 *
 * Ambos assumem que existe um `node_modules` na raiz do checkout. Numa
 * `git worktree` não existe: a árvore de dependências é a do repositório raiz,
 * e quem chega até ela é a subida de diretórios do resolvedor do Node —
 * `<worktree>/node_modules` → `…/worktrees/node_modules` → `…/.claude/node_modules`
 * → `<repo>/node_modules`. Um caminho relativo não sobe; ele aponta para o
 * primeiro degrau, que não existe, e o teste falha 100% das vezes numa
 * worktree limpa. Instalar `node_modules` por worktree resolveria e é caro
 * demais (e proibido neste ambiente); a resolução é que estava errada.
 *
 * ## Por que não `require.resolve('tsx/dist/cli.mjs')` direto
 *
 * `tsx` e `vitest` declaram `exports` no `package.json`, e um subpath não
 * listado ali é REJEITADO com `ERR_PACKAGE_PATH_NOT_EXPORTED` — vale tanto para
 * `tsx/dist/cli.mjs` quanto para `vitest/vitest.mjs`. O que os dois expõem é o
 * próprio `package.json` (o Node exporta `./package.json` por padrão), então
 * resolvemos ESSE e caminhamos a partir da pasta do pacote.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Caminho absoluto de `arquivo` dentro do pacote `pacote`, resolvido a partir
 * de `deUrl` (passe sempre `import.meta.url` do chamador).
 *
 * @example
 *   const TSX = arquivoDoPacote('tsx', 'dist/cli.mjs', import.meta.url);
 */
export function arquivoDoPacote(pacote: string, arquivo: string, deUrl = import.meta.url): string {
  const require_ = createRequire(deUrl);
  const raizDoPacote = dirname(require_.resolve(`${pacote}/package.json`));
  return join(raizDoPacote, arquivo);
}
