/**
 * Item 10 do dono — `sharp` deixa de ser implícito.
 *
 * O problema
 * ----------
 * `sharp` chegava aqui como `peerDependency` NÃO-opcional do Baileys
 * (`@whiskeysockets/baileys` declara `"sharp": "*"` e, ao contrário de `jimp`
 * e `audio-decode`, não o marca opcional). O npm instalava o pacote JS, mas
 * NÃO instalava as `optionalDependencies` `@img/sharp-*` dele — o lockfile da
 * raiz tinha exatamente uma entrada `@img/*` (`@img/colour`) e nenhum binário.
 * O resultado é silencioso por construção: Baileys carrega a biblioteca com
 * `import('sharp').catch(() => {})` (`lib/Utils/messages-media.js:19`), então
 * a falta do binário nativo não vira erro — vira thumbnail que some.
 *
 * A prova de que o defeito era real, na árvore instalada de `origin/main`:
 *
 *   Could not load the "sharp" module using the linux-x64 runtime
 *
 * O que esta sonda faz
 * --------------------
 * `import('sharp')` NÃO basta como prova: importar o módulo em cima do binário
 * glibc da máquina de desenvolvimento não diz nada sobre a imagem Alpine, que
 * é musl. Então aqui a sonda:
 *
 *   1. detecta a libc do processo (musl x glibc) e imprime;
 *   2. importa `sharp` de verdade (sem `.catch()` — falha é falha);
 *   3. EXECUTA libvips: gera um PNG e relê os metadados. Um `import` que passa
 *      mas não processa nada deixaria passar um binário meia-boca;
 *   4. CARREGA explicitamente o binário `@img/sharp-linuxmusl-<arch>`.
 *
 * O passo 4 não é redundante com o 2 e o 3, e a medição mostra por quê: numa
 * imagem Alpine com o lockfile correto MENOS a entrada
 * `@img/sharp-linuxmusl-x64`, o `import('sharp')` passou, o round-trip PNG
 * passou, e mesmo assim não havia binário nativo — o sharp caiu em
 * `@img/sharp-wasm32`. Ou seja: uma sonda que só faz `import('sharp')` fica
 * VERDE com produção rodando em WASM. O passo 4 é o único que separa os dois.
 *
 * Como rodar DENTRO da imagem (é a única execução que prova o caso Alpine):
 *
 *   docker build --target deps -t maia-deps:probe .
 *   docker run --rm -v "$PWD/scripts:/app/scripts:ro" maia-deps:probe \
 *     node scripts/sharp-smoke.ts
 *
 * Na máquina de desenvolvimento (glibc) a sonda também roda — `npm run
 * sharp:smoke` — mas aí ela prova o caminho glibc, não o musl. Ela diz isso na
 * própria saída, para ninguém confundir os dois.
 *
 * Escrito só com sintaxe apagável (sem anotação de tipo), pelo mesmo motivo de
 * `scripts/check-audit-exceptions.ts`: roda com `node scripts/sharp-smoke.ts`
 * dentro da imagem, sem depender de `tsx` estar presente.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * `true` quando o processo roda sobre musl (Alpine).
 *
 * `process.report.getReport().header.glibcVersionRuntime` só existe em builds
 * ligadas à glibc; no Node oficial de Alpine o campo simplesmente não vem.
 * É a mesma heurística que o `detect-libc` usa como fallback, sem acrescentar
 * dependência a um script que precisa rodar na imagem `--omit=dev`.
 */
export function isMusl() {
  if (process.platform !== 'linux') return false;
  const report = process.report?.getReport();
  const header = report && typeof report === 'object' ? report.header : undefined;
  return !(header && typeof header === 'object' && 'glibcVersionRuntime' in header);
}

/** Nome do pacote de runtime que o `sharp` precisa ter em disco nesta libc. */
export function expectedRuntimePackage(platform, arch, musl) {
  if (platform !== 'linux') return `@img/sharp-${platform}-${arch}`;
  return musl ? `@img/sharp-linuxmusl-${arch}` : `@img/sharp-linux-${arch}`;
}

/**
 * CARREGA o binário nativo esperado, pelo mesmo especificador que o `sharp`
 * usa (`${spec}/sharp.node` — os pacotes `@img/sharp-*` publicam um `exports`
 * fechado, então `${spec}/package.json` daria falso negativo mesmo instalado).
 *
 * Carregar, e não apenas resolver, é deliberado: resolver prova que o pacote
 * está em disco; carregar prova que o `.node` linka nesta libc. São coisas
 * diferentes e a segunda é a que interessa numa imagem musl.
 *
 * Devolve `null` (com o motivo) quando não dá.
 */
function loadNativeOrNull(spec) {
  try {
    const req = createRequire(import.meta.url);
    const resolved = req.resolve(`${spec}/sharp.node`);
    req(`${spec}/sharp.node`);
    return resolved;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function main() {
  const musl = isMusl();
  const libc = process.platform !== 'linux' ? 'n/a' : musl ? 'musl' : 'glibc';
  console.log(
    `[sharp-smoke] platform=${process.platform} arch=${process.arch} libc=${libc} node=${process.version}`,
  );
  if (!musl) {
    console.log(
      '[sharp-smoke] AVISO: esta execução NÃO é musl. Ela exercita o binário glibc ' +
        'e não prova o caso Alpine da imagem de produção. Rode dentro da imagem para isso.',
    );
  }

  const mod = await import('sharp');
  const sharp = mod.default;
  console.log(`[sharp-smoke] sharp=${sharp.versions.sharp} libvips=${sharp.versions.vips}`);

  // Exercita libvips de fato: gerar e reler. Um binário que carrega mas não
  // processa não serve para nada, e um `import` sozinho não distingue os dois.
  const png = await sharp({
    create: { width: 8, height: 4, channels: 3, background: { r: 12, g: 34, b: 56 } },
  })
    .png()
    .toBuffer();
  const meta = await sharp(png).metadata();
  if (meta.width !== 8 || meta.height !== 4 || meta.format !== 'png') {
    throw new Error(
      `libvips devolveu metadados inesperados: ${JSON.stringify({ w: meta.width, h: meta.height, f: meta.format })}`,
    );
  }
  console.log(`[sharp-smoke] round-trip PNG ok: ${meta.width}x${meta.height} ${meta.format}`);

  const expected = expectedRuntimePackage(process.platform, process.arch, musl);
  const loaded = loadNativeOrNull(expected);
  if (typeof loaded !== 'string') {
    throw new Error(
      `o binário nativo "${expected}" NÃO carregou: ${loaded.error}\n` +
        `  ATENÇÃO: o \`import('sharp')\` e o round-trip acima podem ter PASSADO mesmo assim — ` +
        `o sharp cai em @img/sharp-wasm32 quando o binário nativo falta. Foi exatamente o que ` +
        `aconteceu ao remover @img/sharp-linuxmusl-x64 do lockfile: import verde, PNG verde, ` +
        `produção rodando em WASM. Por isso esta checagem existe.\n` +
        `  Verifique se o lockfile carrega as entradas @img/sharp-linuxmusl-* e se o ` +
        `\`npm ci\` as instalou.`,
    );
  }
  console.log(`[sharp-smoke] binário nativo carregado: ${expected} (${loaded})`);
  console.log('[sharp-smoke] OK');
}

/**
 * Só roda `main()` quando este arquivo é o entrypoint — mesma técnica de
 * `scripts/check-audit-exceptions.ts`, para o spec importar os helpers puros
 * sem disparar o `import('sharp')`.
 */
export function isDirectInvocation(entry, metaUrl) {
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === metaUrl;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    console.error(`\n✖ sharp-smoke falhou: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
