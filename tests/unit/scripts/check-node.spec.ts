/**
 * O guard de versão do Node tem que funcionar num Node VELHO — e o gate que
 * REALMENTE impede a instalação não é ele.
 *
 * ## Por que este arquivo existe
 *
 * Um guard de versão que só roda no runtime que ele deveria estar julgando é
 * circular: para descobrir se o Node serve, seria preciso primeiro carregar um
 * runtime (tsx, type-stripping, um pacote de `node_modules`) que já exige o
 * Node que serve. Num Node velho demais o guard morre com erro de sintaxe ou de
 * módulo — exatamente onde a mensagem legível era a única coisa útil.
 *
 * Daí as três propriedades que este arquivo prova, e que a escolha de `.mjs`
 * puro existe para garantir:
 *
 * 1. **Carrega com `node` puro.** Sem `npx`, sem `tsx`, sem transpilação.
 * 2. **Não alcança `node_modules`.** Provado copiando o arquivo para fora da
 *    árvore do repo e rodando de lá: se ele importasse um pacote, a cópia
 *    quebraria com `ERR_MODULE_NOT_FOUND`.
 * 3. **Reprova versão abaixo do mínimo, com mensagem legível.** A versão velha
 *    é SIMULADA pelo caminho que o próprio guard usa para lê-la
 *    (`process.versions.node`), injetada num processo filho. Nada de produção
 *    muda para o teste existir.
 *
 * ## O que este arquivo NÃO prova
 *
 * Que o guard roda em Node < 12. `.mjs` é ESM, e ESM só é carregável sem flag a
 * partir do Node 12.17/13.2 — abaixo disso o arquivo sequer é PARSEADO, então a
 * mensagem é inalcançável por construção. É o limite inerente da decisão de
 * usar `.mjs` (um `.cjs` cobriria mais fundo), e está registrado aqui de
 * propósito em vez de ser mascarado por um teste que não existe.
 *
 * ## A armadilha que este arquivo já teve (e não pode ter de novo)
 *
 * A versão anterior deste arquivo continha um caso chamado "o guard roda antes
 * de qualquer instalação (preinstall)" cuja única evidência era a STRING do
 * script `preinstall` em `package.json`. Ele provava que a string existe, e
 * daí CONCLUÍA um comportamento do npm que é falso: no `npm ci`,
 * `preinstall` roda DEPOIS de a árvore já estar escrita em `node_modules`, e
 * com `engine-strict=true` o `EBADENGINE` do próprio npm preempta o
 * `preinstall` inteiro — a mensagem customizada nunca sai.
 *
 * Por isso: **todo caso aqui ou exercita comportamento, ou diz no nome que só
 * verifica declaração.** Os blocos marcados `[declaração]` leem arquivos de
 * configuração e não afirmam nada sobre o que o npm/Docker fazem em runtime.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, copyFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(__dirname, '../../..');
const CHECKER = resolve(REPO_ROOT, 'scripts/check-node.mjs');
const GUARD_PATH = 'scripts/check-node.mjs';

type Pkg = {
  engines: { node: string; npm: string };
  devEngines?: { runtime?: { name?: string; version?: string; onFail?: string } };
  scripts: Record<string, string>;
};

function readPkg(): Pkg {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as Pkg;
}

/** Roda um arquivo com `node` puro, sem shell, sem npm, sem tsx. */
function runNode(file: string, cwd: string) {
  return spawnSync(process.execPath, [file], { cwd, encoding: 'utf8' });
}

/**
 * Roda o guard num processo filho que MENTE a versão do Node pelo mesmo
 * caminho que o guard lê (`process.versions.node`). É a única simulação
 * honesta disponível sem baixar outro runtime: se o guard passasse a ler outra
 * fonte, a injeção deixaria de surtir efeito e o teste ficaria vermelho — que é
 * o que se quer de uma sonda.
 */
function runCheckerPretendingNodeIs(version: string, file = CHECKER) {
  const harness = [
    `Object.defineProperty(process.versions, 'node', {`,
    `  value: ${JSON.stringify(version)}, configurable: true, writable: false,`,
    `});`,
    `await import(${JSON.stringify(pathToFileURL(file).href)});`,
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '-e', harness], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

/** Copia o guard para fora da árvore do repo — longe de qualquer node_modules. */
function checkerCopiedOutsideRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'maia-check-node-'));
  const copy = join(dir, 'check-node.mjs');
  copyFileSync(CHECKER, copy);
  return copy;
}

describe('scripts/check-node.mjs — guard de versão do Node', () => {
  it('carrega e passa com `node` puro no runtime atual', () => {
    const r = runNode(CHECKER, REPO_ROOT);
    expect(r.error).toBeUndefined();
    expect(`${r.stderr}`).toBe('');
    expect(r.status).toBe(0);
  });

  it('roda fora da árvore do repo, sem nenhum node_modules ao alcance', () => {
    const copy = checkerCopiedOutsideRepo();
    const r = runNode(copy, tmpdir());
    expect(`${r.stderr}`).toBe('');
    expect(r.status).toBe(0);
  });

  it('não importa nada além de builtins do Node', () => {
    const src = readFileSync(CHECKER, 'utf8');
    const specifiers = [...src.matchAll(/(?:^|\s)(?:import|export)[^;\n]*?from\s+['"]([^'"]+)['"]/g)]
      .map((m) => m[1])
      .concat([...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]));
    const external = specifiers.filter((s) => !/^(node:|\.{1,2}\/)/.test(s));
    expect(external, `guard importa pacote externo: ${external.join(', ')}`).toEqual([]);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });

  it('reprova Node velho TAMBÉM fora do repo (a mensagem não depende de node_modules)', () => {
    const r = runCheckerPretendingNodeIs('20.19.5', checkerCopiedOutsideRepo());
    expect(`${r.stdout}${r.stderr}`).toContain('20.19.5');
    expect(r.status).toBeGreaterThan(0);
  });
});

/**
 * Fronteiras da comparação de versão (achado #2 do review).
 *
 * O piso NÃO é mais "qualquer 22.x", e não é nem o do npm pinado. Duas
 * restrições se somam, e vale a MAIOR:
 *
 * 1. `package.json` pina `npm@11.5.2`, cujo `engines` é `^20.17.0 || >=22.9.0`
 *    — medido rodando o binário real:
 *
 *        $ node-v22.8.0/bin/node npm-11.5.2/bin/npm-cli.js --version
 *        npm warn cli npm v11.5.2 does not support Node.js v22.8.0. This
 *        version of npm supports: `^20.17.0 || >=22.9.0`.
 *
 * 2. Com `engine-strict=true` (.npmrc), o npm recusa QUALQUER pacote da árvore
 *    fora do `engines` dele. O `eslint` e os `@eslint/*` deste lockfile pedem
 *    `^20.19.0 || ^22.13.0 || >=24`. Medido com `npm ci --dry-run` real:
 *
 *        Node 22.9.0  -> npm error code EBADENGINE
 *                        notsup Required: {"node":"^20.19.0 || ^22.13.0 || >=24"}
 *        Node 22.12.0 -> npm error code EBADENGINE (idem)
 *        Node 22.13.0 -> added 810 packages in 952ms
 *
 * Daí o piso 22.13.0, comparado por versão COMPLETA (major.minor.patch) e não
 * por major. O caso `o piso cobre o que o lockfile exige` abaixo deriva esse
 * número do próprio `package-lock.json`, então um bump de dependência que suba
 * a exigência fica vermelho aqui em vez de no `npm ci` de alguém.
 *
 * Todos os casos abaixo exercitam o guard de verdade, num processo filho, pelo
 * caminho de leitura real (`process.versions.node`).
 */
describe('fronteiras de versão — comparação por versão completa, não por major', () => {
  it.each([
    ['20.19.5', 'major abaixo do piso'],
    ['18.20.4', 'major bem abaixo'],
    ['21.7.3', 'major imediatamente abaixo'],
    ['12.22.12', 'o mais velho que ainda parseia .mjs'],
    ['22.0.0', 'major certo, minor abaixo do piso — npm 11.5.2 NÃO suporta'],
    ['22.8.0', 'a fronteira de cima do intervalo recusado pelo npm pinado'],
    ['22.8.999', 'último patch do último minor recusado pelo npm'],
    ['22.9.0', 'satisfaz o npm pinado, mas NÃO o eslint do lockfile'],
    ['22.12.0', 'a fronteira de cima do intervalo recusado pelo lockfile'],
    ['22.12.999', 'último patch abaixo do piso'],
    ['22.13.0-pre', 'prerelease do PRÓPRIO piso: por SemVer é MENOR que 22.13.0'],
  ])('reprova Node %s (%s) com saída != 0 e mensagem legível', (version) => {
    const r = runCheckerPretendingNodeIs(version);
    const out = `${r.stdout}${r.stderr}`;
    // A versão injetada tem que aparecer na mensagem: é o que prova que a
    // simulação atravessou o caminho de leitura REAL do guard, e não que o
    // processo morreu por outro motivo qualquer.
    expect(out).toContain(version);
    expect(out).toMatch(/22\.13\.0/);
    expect(out).toMatch(/nvm|nodejs\.org/);
    expect(r.status).toBeGreaterThan(0);
  });

  it.each([
    ['22.13.0', 'o piso exato'],
    ['22.13.1', 'patch acima do piso'],
    ['22.18.0', 'o que as lanes de CI pinam'],
    ['22.22.2', 'o runtime desta máquina'],
  ])('aceita Node %s (%s)', (version) => {
    const r = runCheckerPretendingNodeIs(version);
    expect(`${r.stderr}`).toBe('');
    expect(r.status).toBe(0);
  });

  /**
   * O TETO. Antes destes casos, 24 e 26 eram ACEITOS — o teste declarava
   * 26 como "o major da imagem de produção", o que deixou de ser verdade
   * quando o Dockerfile desceu para `node:22-alpine`. Sem teto, `engines`
   * aceitava calado um major que nenhum job deste repo exercita; foi assim
   * que `@types/node` chegou a ^25.9.2, tipando contra uma linha que o
   * `.github/dependabot.yml` bloqueia de propósito.
   */
  it.each([
    ['23.0.0', 'primeiro major acima da linha suportada'],
    ['24.4.1', 'LTS seguinte, ainda não exercitada por nenhum job'],
    ['26.0.0', 'o major que o comentário antigo do CI dizia ser produção'],
  ])('RECUSA Node %s (%s)', (version) => {
    const r = runCheckerPretendingNodeIs(version);
    expect(`${r.stderr}`).toContain('above the line this repo supports');
    expect(r.status).toBe(1);
  });

  // Precedência SemVer pura: o core `22.10.0` já é maior que `22.9.0`, então o
  // nightly passa. Isso DIVERGE de um range node-semver com
  // `includePrerelease: false` (que recusaria). A divergência é aceitável e
  // deliberada porque este guard não é o gate: `devEngines.runtime` é, e ele
  // usa o semver do próprio npm. Se o guard for permissivo demais com um
  // nightly, o npm ainda barra — o pior caso é a mensagem bonita não aparecer.
  it('aceita nightly de um minor ACIMA do piso (22.14.0-pre) — precedência SemVer do core', () => {
    const r = runCheckerPretendingNodeIs('22.14.0-pre');
    expect(`${r.stderr}`).toBe('');
    expect(r.status).toBe(0);
  });

  it.each(['', 'not-a-version', 'v22', '22'])(
    'versão malformada (%j) não inventa veredicto: avisa e sai 0',
    (version) => {
      const r = runCheckerPretendingNodeIs(version);
      const out = `${r.stdout}${r.stderr}`;
      expect(out).toMatch(/could not read the Node version/);
      expect(r.status).toBe(0);
    },
  );

  /**
   * Este caso NÃO é declaração: ele DERIVA o piso do `package-lock.json` real
   * e compara com o declarado. Com `engine-strict=true`, o npm recusa qualquer
   * pacote da árvore cujo `engines.node` não seja satisfeito — então o piso
   * verdadeiro do repo é o MAIOR mínimo da linha 22 entre todos os pacotes,
   * não um número escolhido à mão. Um `npm update` que suba essa exigência
   * fica vermelho aqui, e não no `npm ci` de quem for instalar.
   */
  it('o piso declarado cobre o que TODO pacote do lockfile exige na linha 22', () => {
    const lock = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { engines?: { node?: string } }>;
    };
    const MAJOR = 22;
    /** Menor versão da linha 22 que este range aceita, ou null se não aceita 22. */
    function lowest22(range: string): [number, number] | null {
      const found: Array<[number, number]> = [];
      for (const part of range.split('||')) {
        const t = part.trim();
        const m = /^[\^>]=?\s*22\.(\d+)\.(\d+)/.exec(t);
        if (m) found.push([Number(m[1]), Number(m[2])]);
        else if (/^(\^22|>=\s*22)(\s|$|\.x)/.test(t)) found.push([0, 0]);
      }
      if (found.length === 0) return null;
      found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      return found[0];
    }

    let required: [number, number] = [0, 0];
    let culprits: string[] = [];
    let scanned = 0;
    for (const [name, meta] of Object.entries(lock.packages ?? {})) {
      const range = meta?.engines?.node;
      if (!range) continue;
      scanned += 1;
      const low = lowest22(range);
      if (!low) continue;
      if (low[0] > required[0] || (low[0] === required[0] && low[1] > required[1])) {
        required = low;
        culprits = [`${name || '(root)'} => ${range}`];
      } else if (low[0] === required[0] && low[1] === required[1]) {
        culprits.push(`${name || '(root)'} => ${range}`);
      }
    }
    // Anti-vacuidade: se a varredura não achasse `engines` nenhum, o teste
    // passaria sem olhar nada. Este lockfile tem centenas.
    expect(scanned, 'nenhum engines.node no lockfile — varredura quebrada').toBeGreaterThan(50);

    // `engines.node` agora carrega teto (">=22.13.0 <23"): o piso é o primeiro
    // termo. Sem este split o parser lia "0 <23" e produzia NaN.
    const declared = readPkg()
      .engines.node.replace(/^>=/, '')
      .split(' ')[0]
      .split('.')
      .map(Number);
    expect(declared[0]).toBe(MAJOR);
    const declaredOk =
      declared[1] > required[0] || (declared[1] === required[0] && declared[2] >= required[1]);
    expect(
      declaredOk,
      `engines.node é >=${declared.join('.')}, mas o lockfile exige >=${MAJOR}.${required[0]}.${required[1]} ` +
        `na linha 22 (engine-strict=true recusa o install). Quem impõe:\n  ` +
        culprits.slice(0, 5).join('\n  '),
    ).toBe(true);
  });

  it('[declaração] o piso do guard é o mesmo de engines.node e de devEngines.runtime', () => {
    const src = readFileSync(CHECKER, 'utf8');
    const declared = /MINIMUM_VERSION\s*=\s*'([^']+)'/.exec(src);
    expect(declared, 'MINIMUM_VERSION não encontrado no guard').not.toBeNull();
    const pkg = readPkg();
    const teto = /MAXIMUM_MAJOR_EXCLUSIVE\s*=\s*(\d+)/.exec(src);
    expect(teto, 'MAXIMUM_MAJOR_EXCLUSIVE não encontrado no guard').not.toBeNull();
    const faixa = `>=${declared?.[1]} <${teto?.[1]}`;
    expect(pkg.engines.node).toBe(faixa);
    expect(pkg.devEngines?.runtime?.version).toBe(faixa);
  });
});

/**
 * O gate que o npm REALMENTE avalia antes de instalar (achado #1 do review).
 *
 * Este bloco não lê configuração: ele roda `npm ci` de verdade num diretório
 * temporário, com uma dependência `file:` (portanto offline), e observa se a
 * árvore chegou a existir. É a diferença entre "o campo está no package.json"
 * e "o npm parou antes de instalar".
 *
 * Medições que motivaram o bloco, com npm 11.5.2 real (o pinado) e Node 20.19.5
 * real, contra o package.json deste repo ANTES da correção:
 *
 *   - `preinstall` num `npm ci` bem-sucedido imprimiu
 *     `node_modules/ms present=true` — a árvore já estava escrita.
 *   - com `engine-strict=true` e Node 20.19.5, `npm ci` morreu em
 *     `npm error code EBADENGINE` e o `preinstall` NUNCA rodou.
 *
 * Ou seja: no único cenário para o qual a mensagem do guard foi escrita
 * (Node velho), ela era inalcançável.
 */
describe('devEngines.runtime é o gate que roda ANTES da instalação', () => {
  const NPM_ARGS = ['--no-audit', '--no-fund', '--offline'];
  let npmCmd: string[];

  beforeAll(() => {
    const execpath = process.env.npm_execpath;
    npmCmd = execpath ? [process.execPath, execpath] : ['npm'];
  });

  /**
   * Monta um pacote temporário com uma dependência LOCAL (`file:`), para que
   * `npm ci` tenha uma árvore real para escrever sem tocar a rede.
   */
  function fixture(devEnginesVersion: string) {
    const dir = mkdtempSync(join(tmpdir(), 'maia-devengines-'));
    mkdirSync(join(dir, 'dep'));
    writeFileSync(
      join(dir, 'dep', 'package.json'),
      JSON.stringify({ name: 'fixture-dep', version: '1.0.0' }),
    );
    const pkgPath = join(dir, 'package.json');
    const pkg: Record<string, unknown> = {
      name: 'maia-devengines-fixture',
      version: '1.0.0',
      private: true,
      scripts: {
        preinstall: `node -e "require('fs').writeFileSync('preinstall-ran','1')"`,
      },
      dependencies: { 'fixture-dep': 'file:./dep' },
    };
    // O lockfile é gerado ANTES de `devEngines` existir de propósito: o gate é
    // tão anterior à instalação que ele reprova até o
    // `npm install --package-lock-only`. Descobrir isso foi parte do achado.
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    const gen = spawnSync(
      npmCmd[0],
      [...npmCmd.slice(1), 'install', '--package-lock-only', ...NPM_ARGS],
      { cwd: dir, encoding: 'utf8' },
    );
    expect(gen.status, `não consegui gerar o lockfile da fixture:\n${gen.stdout}${gen.stderr}`).toBe(0);
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    // O próprio `--package-lock-only` dispara o `preinstall`, então o marcador
    // dele precisa sumir antes da medição — senão o teste leria o resíduo da
    // preparação como se fosse o `npm ci`.
    rmSync(join(dir, 'preinstall-ran'), { force: true });
    pkg.devEngines = { runtime: { name: 'node', version: devEnginesVersion, onFail: 'error' } };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    return dir;
  }

  function npmCi(dir: string) {
    return spawnSync(npmCmd[0], [...npmCmd.slice(1), 'ci', ...NPM_ARGS], { cwd: dir, encoding: 'utf8' });
  }

  it('um devEngines.runtime insatisfeito para o npm ANTES de escrever node_modules', () => {
    const dir = fixture('>=99.0.0');
    const r = npmCi(dir);
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, `esperava npm ci reprovar:\n${out}`).not.toBe(0);
    expect(out).toContain('EBADDEVENGINES');
    // O ponto do achado: a árvore NÃO chegou a existir.
    expect(existsSync(join(dir, 'node_modules', 'fixture-dep', 'package.json'))).toBe(false);
    // E o preinstall nem foi chamado — por isso ele não pode ser o gate.
    expect(existsSync(join(dir, 'preinstall-ran'))).toBe(false);
  });

  it('um devEngines.runtime satisfeito deixa o npm instalar normalmente', () => {
    const dir = fixture(`>=${process.versions.node.split('.')[0]}.0.0`);
    const r = npmCi(dir);
    expect(r.status, `esperava npm ci passar:\n${r.stdout}${r.stderr}`).toBe(0);
    expect(existsSync(join(dir, 'node_modules', 'fixture-dep', 'package.json'))).toBe(true);
  });

  it('CONTRA-PROVA: com o preinstall no lugar do devEngines, a árvore JÁ está instalada quando ele roda', () => {
    const dir = mkdtempSync(join(tmpdir(), 'maia-preinstall-'));
    mkdirSync(join(dir, 'dep'));
    writeFileSync(join(dir, 'dep', 'package.json'), JSON.stringify({ name: 'fixture-dep', version: '1.0.0' }));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'maia-preinstall-fixture',
        version: '1.0.0',
        private: true,
        scripts: {
          preinstall: `node -e "require('fs').writeFileSync('tree-present', String(require('fs').existsSync('node_modules/fixture-dep/package.json')))"`,
        },
        dependencies: { 'fixture-dep': 'file:./dep' },
      }),
    );
    const gen = spawnSync(npmCmd[0], [...npmCmd.slice(1), 'install', '--package-lock-only', ...NPM_ARGS], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(gen.status).toBe(0);
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    const r = npmCi(dir);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    // Este é o achado, escrito como asserção: quando `preinstall` roda, o npm
    // JÁ escreveu a árvore. Se um dia o npm mudar essa ordem, este caso fica
    // vermelho e o comentário acima deixa de valer — que é o que se quer.
    expect(readFileSync(join(dir, 'tree-present'), 'utf8')).toBe('true');
  });

  it('[declaração] package.json declara devEngines.runtime com onFail=error', () => {
    const pkg = readPkg();
    expect(pkg.devEngines?.runtime?.name).toBe('node');
    expect(pkg.devEngines?.runtime?.onFail).toBe('error');
    expect(pkg.devEngines?.runtime?.version).toMatch(/^>=\d+\.\d+\.\d+ <\d+$/);
  });
});

/**
 * Como `engine-strict` + `devEngines` preemptam o `preinstall`, a mensagem
 * legível do guard só é garantida se alguém a INVOCAR explicitamente antes do
 * `npm ci`. Este bloco enumera CI e Dockerfiles e cobra exatamente isso.
 *
 * [declaração]: ele lê YAML e Dockerfile. Não prova que o runner/Docker
 * executam nessa ordem — prova que a ordem está escrita onde deveria.
 */
describe('[declaração] o guard é invocado explicitamente antes de todo `npm ci`', () => {
  const GUARD_INVOCATION = /node\s+scripts\/check-node\.mjs/;

  it.each(['Dockerfile', 'src/admin-ui/Dockerfile'])(
    '%s: todo stage que roda `npm ci` sobre o package.json da raiz invoca o guard antes',
    (dockerfile) => {
      const offenders: string[] = [];
      for (const stage of stagesOf(dockerfile)) {
        let rootPkgCopied = false;
        let guardAvailable = false;
        let guardInvoked = false;
        for (const line of stage.lines) {
          if (/^\s*COPY\s/i.test(line) && !/--from=/i.test(line)) {
            if (/(^|\s)(\.\/)?package\.json(\s|$)/.test(line)) rootPkgCopied = true;
            if (line.includes(GUARD_PATH) || /^\s*COPY\s+\.\s+\.\/?\s*$/.test(line)) guardAvailable = true;
          }
          if (/^\s*RUN\b/i.test(line) && GUARD_INVOCATION.test(line)) guardInvoked = true;
          if (/^\s*RUN\b/i.test(line) && /\bnpm\s+ci\b/.test(line) && rootPkgCopied) {
            if (!guardAvailable) offenders.push(`${dockerfile} [${stage.name}] guard não copiado: ${line.trim()}`);
            else if (!guardInvoked) offenders.push(`${dockerfile} [${stage.name}] guard não invocado antes: ${line.trim()}`);
          }
        }
      }
      expect(offenders, offenders.join('\n')).toEqual([]);
    },
  );

  it('todo job de workflow que roda `npm ci` invoca o guard antes', () => {
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      let guardInvoked = false;
      for (const line of lines) {
        // Um novo job zera o estado: cada job é um runner limpo.
        if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) guardInvoked = false;
        if (GUARD_INVOCATION.test(line)) guardInvoked = true;
        if (/\bnpm\s+ci\b/.test(line) && !line.trim().startsWith('#') && !guardInvoked) {
          offenders.push(`${file.replace(REPO_ROOT + '/', '')}: \`npm ci\` sem \`node ${GUARD_PATH}\` antes → ${line.trim()}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

/**
 * Achado #3: nem toda lane de CI estava pinada. `migration-prefix-guard.yml`
 * usava `node-version: 22` (major flutuante) e rodava o mesmo `npm ci`; como
 * essa workflow só dispara em mudanças de migrations/scripts, ela não apareceu
 * entre os checks da PR.
 *
 * [declaração]: percorre `.github/workflows/**` e lê YAML. Não roda o CI.
 */
describe('[declaração] toda lane de CI pina a versão de Node', () => {
  it('encontra pelo menos os workflows conhecidos (anti-vacuidade da varredura)', () => {
    const files = workflowFiles().map((f) => f.replace(REPO_ROOT + '/', ''));
    expect(files.length).toBeGreaterThan(1);
    expect(files).toContain('.github/workflows/ci.yml');
    expect(files).toContain('.github/workflows/migration-prefix-guard.yml');
  });

  it('nenhum `node-version` da linha 22 fica sem minor (22 flutuante é proibido)', () => {
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const m = /^\s*node-version:\s*(.+?)\s*(?:#.*)?$/.exec(line);
          if (!m) return;
          const value = m[1].replace(/^['"]|['"]$/g, '');
          // Expressões de matriz são resolvidas no bloco de baixo.
          if (value.startsWith('${{')) return;
          if (/^22(\.x)?$/.test(value)) {
            offenders.push(`${file.replace(REPO_ROOT + '/', '')}:${i + 1} node-version: ${value}`);
          }
        });
    }
    expect(
      offenders,
      `lane da linha 22 sem pin de minor (use 22.18):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('nenhum valor de `strategy.matrix.node` da linha 22 fica sem minor', () => {
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const m = /^\s*node:\s*\[(.+?)\]\s*(?:#.*)?$/.exec(line);
          if (!m) return;
          for (const raw of m[1].split(',')) {
            const value = raw.trim().replace(/^['"]|['"]$/g, '');
            if (/^22(\.x)?$/.test(value)) {
              offenders.push(`${file.replace(REPO_ROOT + '/', '')}:${i + 1} matrix node: ${value}`);
            }
          }
        });
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('CONTRIBUTING.md não afirma `node-version-file` se nenhum workflow usa', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
    const workflowsUseIt = workflowFiles().some((f) =>
      /^\s*node-version-file:/m.test(readFileSync(f, 'utf8')),
    );
    // A doc PODE citar o mecanismo para dizer que ele NÃO é usado; o que ela
    // não pode é afirmar que o CI o usa. Este caso amarra a afirmação ao
    // arquivo de workflow: se alguém reintroduzir a frase antiga sem mudar o
    // CI, fica vermelho.
    const claimsCiUsesIt = /O CI usa `node-version-file/.test(doc);
    expect(
      claimsCiUsesIt && !workflowsUseIt,
      'CONTRIBUTING.md afirma que o CI usa `node-version-file`, mas nenhum workflow usa',
    ).toBe(false);
  });

  it('todo `node-version` pinado da linha 22 satisfaz o piso de engines.node', () => {
    const floor = readPkg().engines.node.replace(/^>=/, '').split('.').map(Number);
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const m = /^\s*node-version:\s*['"]?(\d+)(?:\.(\d+))?(?:\.(\d+))?['"]?\s*(?:#.*)?$/.exec(line);
          if (!m) return;
          const v = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
          if (v[0] !== floor[0]) return; // outro major (26) tem sua própria perna
          if (v[1] < floor[1] || (v[1] === floor[1] && v[2] < floor[2])) {
            offenders.push(`${file.replace(REPO_ROOT + '/', '')}:${i + 1} node-version ${v.join('.')} < ${floor.join('.')}`);
          }
        });
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

/** Stages de um Dockerfile: nome + linhas, na ordem. */
function stagesOf(dockerfile: string) {
  const stages: Array<{ name: string; lines: string[] }> = [];
  for (const line of readFileSync(resolve(REPO_ROOT, dockerfile), 'utf8').split('\n')) {
    if (/^\s*FROM\s+/i.test(line)) {
      const as = /\bAS\s+(\S+)/i.exec(line);
      stages.push({ name: as ? as[1] : line.trim(), lines: [] });
    } else if (stages.length > 0) {
      stages[stages.length - 1]?.lines.push(line);
    }
  }
  return stages;
}

/** Todos os arquivos de workflow, recursivamente. */
function workflowFiles(): string[] {
  const root = resolve(REPO_ROOT, '.github/workflows');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ya?ml$/.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}
