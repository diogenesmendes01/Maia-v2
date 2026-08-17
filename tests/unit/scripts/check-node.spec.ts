/**
 * O guard de versão do Node tem que funcionar num Node VELHO.
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
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(__dirname, '../../..');
const CHECKER = resolve(REPO_ROOT, 'scripts/check-node.mjs');

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

  it.each(['20.19.5', '18.20.4', '21.7.3', '12.22.12'])(
    'reprova Node %s (abaixo do mínimo) com saída != 0 e mensagem legível',
    (version) => {
      const r = runCheckerPretendingNodeIs(version);
      const out = `${r.stdout}${r.stderr}`;
      // A versão injetada tem que aparecer na mensagem: é o que prova que a
      // simulação atravessou o caminho de leitura REAL do guard, e não que o
      // processo morreu por outro motivo qualquer.
      expect(out).toContain(version);
      expect(out).toMatch(/22/);
      expect(out).toMatch(/nvm|nodejs\.org/);
      expect(r.status).not.toBe(0);
      expect(r.status).toBeGreaterThan(0);
    },
  );

  it('reprova Node velho TAMBÉM fora do repo (a mensagem não depende de node_modules)', () => {
    const r = runCheckerPretendingNodeIs('20.19.5', checkerCopiedOutsideRepo());
    expect(`${r.stdout}${r.stderr}`).toContain('20.19.5');
    expect(r.status).toBeGreaterThan(0);
  });

  // `22.0.0-pre` (nightly do major suportado) passa DE PROPÓSITO: a comparação
  // é por major, e um nightly do 22 é Node 22. Um piso com minor/patch seria um
  // segundo número para envelhecer sem que ninguém o atualizasse.
  it.each(['22.0.0', '22.18.0', '22.0.0-pre', '24.4.1', '26.0.0'])('aceita Node %s', (version) => {
    const r = runCheckerPretendingNodeIs(version);
    expect(`${r.stderr}`).toBe('');
    expect(r.status).toBe(0);
  });

  it('o mínimo do guard é o mesmo piso de package.json engines.node', () => {
    const src = readFileSync(CHECKER, 'utf8');
    const declared = /MINIMUM_MAJOR\s*=\s*(\d+)/.exec(src);
    expect(declared, 'MINIMUM_MAJOR não encontrado no guard').not.toBeNull();
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      engines: { node: string };
      scripts: Record<string, string>;
    };
    expect(pkg.engines.node).toBe(`>=${declared?.[1]}.0.0`);
  });

  it('o guard roda antes de qualquer instalação (preinstall) e tem script próprio', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.preinstall).toContain('scripts/check-node.mjs');
    // `node ...` direto — se alguém envolver em tsx/npx, o guard volta a
    // depender do runtime que ele deveria estar julgando.
    expect(pkg.scripts.preinstall).toMatch(/node\s+scripts\/check-node\.mjs/);
    expect(pkg.scripts['check:node']).toBe('node scripts/check-node.mjs');
  });
});
