#!/usr/bin/env node
/**
 * Guard de versão do Node — ESM puro, `node` direto, ZERO dependências.
 *
 * ## Por que este arquivo não é TypeScript
 *
 * Um guard que precisa de `tsx` (ou de qualquer type-stripping, ou de um
 * pacote de `node_modules`) para responder "este Node serve?" é circular: para
 * julgar o runtime é preciso primeiro carregar algo que já exige o runtime
 * julgado. Num Node velho demais esse guard morre com `SyntaxError` ou
 * `ERR_MODULE_NOT_FOUND` — bem no único momento em que a mensagem legível era
 * a coisa útil. Por isso aqui não há `import`, não há `require`, não há leitura
 * de arquivo: só sintaxe que o Node entende há muitas versões.
 *
 * Consequências práticas, que são regras para quem editar este arquivo:
 *
 * - **Nada de sintaxe recente.** Sem `?.`, sem `??`, sem top-level `await`,
 *   sem `Array.prototype.at`, sem campos privados de classe, nem vírgula
 *   final em chamada de função (ES2017). Se o parser do Node velho engasgar, a
 *   mensagem não sai. O bloco dos `.mjs` de `scripts/` no `eslint.config.js` fixa
 *   `ecmaVersion: 2015` justamente para reprovar isso no lint, e não no dia em
 *   que alguém estiver travado.
 * - **Nada de `import` de pacote.** Nem builtin com prefixo `node:` (só a
 *   partir do 14.18/16) — nem isso é necessário aqui.
 * - **Não leia `package.json`.** Ler exigiria `fs` e amarraria o guard à
 *   posição dele na árvore. O piso está duplicado na constante abaixo, e
 *   `tests/unit/scripts/check-node.spec.ts` reprova se ela divergir de
 *   `engines.node`.
 *
 * ## Limite conhecido
 *
 * `.mjs` é ESM, e ESM só carrega sem flag a partir do Node 12.17/13.2. Abaixo
 * disso este arquivo não chega a ser parseado e a mensagem é inalcançável — é
 * o teto da escolha por `.mjs`, registrado aqui em vez de escondido.
 *
 * ## Onde ele roda
 *
 * `preinstall` (antes de existir `node_modules`) e `npm run check:node`.
 * Silencioso quando passa, como o guard de npm que vive ao lado dele no
 * `package.json`: guard bom só fala quando reprova.
 */

/**
 * Piso do runtime. Espelha `engines.node` (">=22.0.0") e `.nvmrc` ("22").
 * Comparação por MAJOR: o piso declarado é `.0.0`, então minor/patch não
 * mudam o veredicto. Manter assim evita um segundo número para envelhecer.
 */
var MINIMUM_MAJOR = 22;

var raw = process.versions && process.versions.node ? String(process.versions.node) : '';
var parsed = /^(\d+)\./.exec(raw);

if (!parsed) {
  // Versão irreconhecível não é motivo para barrar ninguém: o guard existe
  // para dar uma mensagem útil, não para inventar um veredicto sobre um
  // runtime que ele não sabe ler. Avisa e sai de lado.
  console.error(
    '! check-node: could not read the Node version (got ' +
      JSON.stringify(raw) +
      '); skipping the version guard.'
  );
  process.exit(0);
}

var major = Number(parsed[1]);

if (major < MINIMUM_MAJOR) {
  console.error(
    '\n✖ Node ' +
      raw +
      ' is too old for this repo (requires Node >=' +
      MINIMUM_MAJOR +
      '.0.0).\n' +
      '  This repo runs a single Node line: .nvmrc, package.json engines and the\n' +
      '  Docker images all say ' +
      MINIMUM_MAJOR +
      ' (see CONTRIBUTING.md -> Toolchain).\n' +
      '  Fix: nvm install && nvm use   (Node ' +
      MINIMUM_MAJOR +
      ' from .nvmrc)\n' +
      '       or install Node ' +
      MINIMUM_MAJOR +
      '+ from https://nodejs.org/\n' +
      '  Then re-run your command.\n'
  );
  process.exit(1);
}
