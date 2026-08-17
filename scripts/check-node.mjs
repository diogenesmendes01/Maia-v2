#!/usr/bin/env node
/**
 * Guard de versão do Node — ESM puro, `node` direto, ZERO dependências.
 *
 * ## O que este arquivo É, e o que ele NÃO é
 *
 * Ele **não** é o gate da instalação. O gate é `devEngines.runtime` no
 * `package.json` (`onFail: "error"`), que o npm avalia ANTES de escrever
 * `node_modules` — medido, não suposto. Este arquivo existe só para a
 * MENSAGEM: uma explicação legível de como consertar o toolchain, em vez do
 * `EBADDEVENGINES`/`EBADENGINE` cru do npm.
 *
 * Como o npm preempta os lifecycle scripts nesse caminho (com
 * `engine-strict=true` no `.npmrc`, um Node fora de `engines` morre em
 * `EBADENGINE` sem nunca rodar `preinstall`), a mensagem só é garantida se
 * alguém INVOCAR este arquivo explicitamente antes do `npm ci`. É o que o CI e
 * os Dockerfiles fazem — `node scripts/check-node.mjs` como passo próprio, e
 * `tests/unit/scripts/check-node.spec.ts` reprova quem esquecer.
 *
 * O `preinstall` continua encadeando este guard, mas como rede de segurança do
 * caminho `npm install` local, não como gate: no `npm ci` ele roda DEPOIS de a
 * árvore já estar instalada.
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
 *   `engines.node` e de `devEngines.runtime.version`.
 *
 * ## Limite conhecido
 *
 * `.mjs` é ESM, e ESM só carrega sem flag a partir do Node 12.17/13.2. Abaixo
 * disso este arquivo não chega a ser parseado e a mensagem é inalcançável — é
 * o teto da escolha por `.mjs`, registrado aqui em vez de escondido.
 */

/**
 * Piso do runtime. Espelha `engines.node` e `devEngines.runtime.version`
 * (ambos ">=22.13.0") — os testes reprovam divergência.
 *
 * ## Por que 22.13.0 e não 22.0.0
 *
 * Duas restrições se somam, e vale a MAIOR das duas:
 *
 * 1. **O npm pinado.** `package.json` pina `npm@11.5.2`, cujo `engines` é
 *    `^20.17.0 || >=22.9.0`. Medido com os binários reais:
 *
 *        $ node-v22.8.0/bin/node .../npm-cli.js --version
 *        npm warn cli npm v11.5.2 does not support Node.js v22.8.0. This
 *        version of npm supports: `^20.17.0 || >=22.9.0`.
 *        11.5.2
 *
 * 2. **A árvore de dependências, sob `engine-strict=true`.** O `.npmrc` liga
 *    `engine-strict`, e com ele o npm recusa QUALQUER pacote cujo `engines`
 *    não seja satisfeito. O `eslint` e os `@eslint/*` do lockfile pedem
 *    `^20.19.0 || ^22.13.0 || >=24`. Medido com `npm ci --dry-run` real,
 *    contra o `package-lock.json` deste repo:
 *
 *        Node 22.9.0  -> npm error code EBADENGINE
 *                        notsup Required: {"node":"^20.19.0 || ^22.13.0 || >=24"}
 *        Node 22.12.0 -> npm error code EBADENGINE (idem)
 *        Node 22.13.0 -> added 810 packages in 952ms
 *
 * Um piso em `22.0.0` (ou uma comparação só por MAJOR, que era o que estava
 * aqui) aprovava Node 22.0.0–22.12.x: toolchains em que o `npm ci` deste repo
 * NÃO completa. O contrato coerente é o maior dos dois pisos, comparado por
 * versão COMPLETA — daí major/minor/patch, e não só o major.
 *
 * `tests/unit/scripts/check-node.spec.ts` DERIVA o item 2 do
 * `package-lock.json` e reprova se este número ficar abaixo dele, para que um
 * bump de dependência apareça aqui e não no `npm ci` de alguém.
 */
var MINIMUM_VERSION = '22.13.0';
var MINIMUM_PARTS = [22, 13, 0];

var raw = process.versions && process.versions.node ? String(process.versions.node) : '';
var parsed = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw);

if (!parsed) {
  // Versão irreconhecível não é motivo para barrar ninguém: o guard existe
  // para dar uma mensagem útil, não para inventar um veredicto sobre um
  // runtime que ele não sabe ler. Avisa e sai de lado. (E não é o gate: quem
  // barra de fato é `devEngines.runtime`, com o semver do próprio npm.)
  console.error(
    '! check-node: could not read the Node version (got ' +
      JSON.stringify(raw) +
      '); skipping the version guard.'
  );
  process.exit(0);
}

var major = Number(parsed[1]);
var minor = Number(parsed[2]);
var patch = Number(parsed[3]);
var prerelease = parsed[4];

/**
 * Precedência SemVer sobre o core, com a regra do prerelease no fim: quando o
 * core é IGUAL ao piso, um prerelease é MENOR que o release (`22.9.0-pre` <
 * `22.9.0`). Era exatamente a divergência apontada no review — a spec antiga
 * exigia que `22.0.0-pre` passasse por `>=22.0.0`, o que SemVer não concede.
 *
 * Divergência conhecida e deliberada: um nightly de um minor ACIMA do piso
 * (`22.10.0-pre`) passa aqui, porque o core `22.10.0` já é maior que o piso.
 * Um range node-semver com `includePrerelease: false` recusaria. Tudo bem:
 * este guard não é o gate — `devEngines.runtime` é, e ele usa o semver do npm.
 * No pior caso o npm barra sem a mensagem bonita; nunca o contrário.
 */
var tooOld;
if (major !== MINIMUM_PARTS[0]) {
  tooOld = major < MINIMUM_PARTS[0];
} else if (minor !== MINIMUM_PARTS[1]) {
  tooOld = minor < MINIMUM_PARTS[1];
} else if (patch !== MINIMUM_PARTS[2]) {
  tooOld = patch < MINIMUM_PARTS[2];
} else {
  tooOld = Boolean(prerelease);
}

if (tooOld) {
  console.error(
    '\n✖ Node ' +
      raw +
      ' is too old for this repo (requires Node >=' +
      MINIMUM_VERSION +
      ').\n' +
      '  The floor is what this repo can actually install: with engine-strict\n' +
      '  (.npmrc), eslint and friends require ^20.19.0 || ^22.13.0 || >=24, and\n' +
      '  the pinned npm@11.5.2 requires ^20.17.0 || >=22.9.0. So Node\n' +
      '  22.0.0-22.12.x cannot install this tree (CONTRIBUTING.md -> Toolchain).\n' +
      '  Fix: nvm install && nvm use   (Node 22 from .nvmrc)\n' +
      '       or install Node ' +
      MINIMUM_VERSION +
      '+ from https://nodejs.org/\n' +
      '  Then re-run your command.\n'
  );
  process.exit(1);
}
