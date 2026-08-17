/**
 * Item 10 do dono — `sharp` não pode voltar a ser implícito.
 *
 * O defeito que este arquivo tranca
 * ---------------------------------
 * `sharp` chegava ao projeto como `peerDependency` NÃO-opcional do Baileys
 * (`@whiskeysockets/baileys` declara `"sharp": "*"`, e — ao contrário de
 * `jimp`, `audio-decode` e `link-preview-js` — não a lista em
 * `peerDependenciesMeta` como opcional). O npm resolvia o pacote JS como peer,
 * mas NÃO trazia as `optionalDependencies` `@img/sharp-*` dele: o lockfile da
 * raiz em `origin/main` tinha exatamente UMA entrada `@img/*` — `@img/colour` —
 * e nenhum binário nativo.
 *
 * Consequência, medida dentro da imagem `node:22-alpine` com `npm ci --omit=dev`
 * a partir daquele lockfile:
 *
 *   ✖ sharp-smoke falhou: Could not load the "sharp" module using the
 *     linuxmusl-x64 runtime
 *
 * E o modo de falha em produção é SILENCIOSO: Baileys carrega a biblioteca com
 * `import('sharp').catch(() => {})` (`lib/Utils/messages-media.js:19`), então
 * a ausência do binário não vira exceção — vira thumbnail que não existe.
 *
 * Por que um teste ESTÁTICO, e o que ele não prova
 * ------------------------------------------------
 * A prova de verdade é `scripts/sharp-smoke.ts` rodando DENTRO da imagem
 * Alpine — só lá o binário musl é o binário carregado. Mas o CI não constrói a
 * imagem em todo PR, e o jeito de o defeito voltar é sempre o mesmo: alguém
 * regenera o lockfile e as entradas `@img/sharp-linuxmusl-*` somem junto com a
 * declaração direta. Este spec tranca exatamente esse caminho de regressão,
 * sem Docker. Ele NÃO substitui a sonda de runtime: um lockfile correto com um
 * tarball corrompido passaria aqui.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();

interface LockEntry {
  version?: string;
  peer?: boolean;
  optional?: boolean;
}

interface Lockfile {
  packages: Record<string, LockEntry>;
}

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf8'));
}

const pkg = readJson('package.json') as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const lock = readJson('package-lock.json') as Lockfile;

/**
 * Os pacotes de binário que a imagem Alpine precisa. `linuxmusl-x64` é o que a
 * imagem de produção usa hoje; `linuxmusl-arm64` entra junto porque um build
 * multi-arch (ou um runner arm) falharia do mesmo jeito silencioso, e as duas
 * entradas vêm do mesmo `npm install` — deixar só uma seria arbitrário.
 *
 * `sharp-libvips-linuxmusl-*` é o par obrigatório: o `.node` de
 * `@img/sharp-linuxmusl-x64` traz `libvips-cpp.so` como NEEDED e o resolve por
 * RPATH dentro de `@img/sharp-libvips-linuxmusl-x64/lib`. Sem esse segundo
 * pacote o primeiro não carrega.
 */
const MUSL_PACKAGES = [
  '@img/sharp-linuxmusl-x64',
  '@img/sharp-linuxmusl-arm64',
  '@img/sharp-libvips-linuxmusl-x64',
  '@img/sharp-libvips-linuxmusl-arm64',
] as const;

describe('sharp declarado e com binários musl no lockfile da raiz (item 10)', () => {
  it('é dependência DIRETA da raiz — não uma peer implícita do Baileys', () => {
    expect(pkg.dependencies?.sharp, 'declare "sharp" em dependencies do package.json da raiz').toBeTypeOf(
      'string',
    );
    expect(pkg.devDependencies?.sharp, '"sharp" é usado em runtime; não pode ser devDependency').toBeUndefined();
  });

  it('o lockfile registra sharp como dependência do projeto, não como peer', () => {
    const entry = lock.packages['node_modules/sharp'];
    expect(entry, 'node_modules/sharp ausente do lockfile da raiz').toBeDefined();
    // `peer: true` é a assinatura exata do estado antigo: presente na árvore só
    // porque o Baileys pediu, e por isso sem as optionalDependencies dele.
    expect(entry?.peer, 'node_modules/sharp voltou a ser resolvido como peer').not.toBe(true);
  });

  it('carrega os binários Linux-musl (o que a imagem Alpine precisa)', () => {
    const sharpVersion = lock.packages['node_modules/sharp']?.version;
    expect(sharpVersion).toBeTypeOf('string');

    const faltando = MUSL_PACKAGES.filter((name) => !lock.packages[`node_modules/${name}`]);
    expect(
      faltando,
      `sem estas entradas o \`npm ci\` da imagem Alpine instala o sharp JS sem binário e ` +
        `\`import('sharp')\` falha com "Could not load the \\"sharp\\" module using the ` +
        `linuxmusl-x64 runtime". Regenere o lockfile com \`npm install sharp@<faixa> ` +
        `--package-lock-only --include=optional\`.`,
    ).toEqual([]);

    // As entradas precisam ser OPCIONAIS: é assim que o mesmo lockfile serve
    // Alpine, Debian e macOS sem `npm ci` quebrar fora do musl.
    for (const name of MUSL_PACKAGES) {
      expect(lock.packages[`node_modules/${name}`]?.optional, `${name} deveria ser optional`).toBe(
        true,
      );
    }

    // O binário tem de ser da MESMA versão do sharp resolvido. sharp exige
    // igualdade exata (`"@img/sharp-linuxmusl-x64": "0.35.3"`), então um par
    // dessincronizado é um carregamento falho, não um aviso.
    expect(lock.packages['node_modules/@img/sharp-linuxmusl-x64']?.version).toBe(sharpVersion);
    expect(lock.packages['node_modules/@img/sharp-linuxmusl-arm64']?.version).toBe(sharpVersion);
  });
});
