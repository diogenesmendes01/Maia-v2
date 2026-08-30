/**
 * O manifesto do Tailwind e a configuração do console não podem divergir.
 *
 * O defeito que originou este guard
 * ---------------------------------
 * A PR automática do Dependabot #654 ("bump tailwindcss from 3.4.15 to 4.3.3
 * in /src/admin-ui") mexeu em DOIS arquivos: `src/admin-ui/package.json` e o
 * lockfile. Nada mais. Só que o major 4 do Tailwind move o plugin de PostCSS
 * para outro pacote (`@tailwindcss/postcss`) e troca as três diretivas
 * `@tailwind base/components/utilities` por `@import "tailwindcss"`. Com o
 * manifesto no 4 e a configuração ainda no 3, o `next build` do console morreu
 * em `./styles/globals.css` com
 *
 *     It looks like you're trying to use `tailwindcss` directly as a PostCSS
 *     plugin. The PostCSS plugin has moved to a separate package...
 *
 * (job "build + e2e do console (admin-ui)" da run 33007290479).
 *
 * A propriedade sob teste
 * ----------------------
 * Não é "o Tailwind é a versão X" — isso seria um guard de um número, e o
 * próximo major passaria igual. É a invariante: **enquanto o manifesto do
 * console declarar Tailwind >= 4, a configuração tem de ser a do 4.** Um
 * bump automático que mexa só no manifesto reprova AQUI, em ~1s no job
 * rápido, em vez de reprovar 90 segundos adiante dentro do `next build`.
 *
 * O QUE ELE COBRE E O BUILD NÃO. Os `@source` do `globals.css` substituíram o
 * array `content` do antigo `tailwind.config.ts`, e erram em SILÊNCIO: um
 * caminho que deixa de existir (pasta renomeada) não é erro de compilação —
 * o Tailwind simplesmente não varre nada ali, não gera as classes daquela
 * árvore, e o build sai VERDE com o console sem estilo. Nada mais no
 * repositório olha para esses caminhos.
 *
 * WHY NOT COMPILAR O CSS AQUI. Isso mediria o Tailwind, não a nossa
 * configuração, e traria o custo do compilador para o job rápido. Quem prova
 * que a folha compila é o `next build` do job `admin-ui` — este spec prova que
 * ela tem chance de compilar antes de o job existir.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ADMIN_UI = join(process.cwd(), 'src/admin-ui');
const MANIFESTO = join(ADMIN_UI, 'package.json');
const POSTCSS = join(ADMIN_UI, 'postcss.config.cjs');
const GLOBAIS = join(ADMIN_UI, 'styles/globals.css');

const manifesto = JSON.parse(readFileSync(MANIFESTO, 'utf8')) as {
  devDependencies?: Record<string, string>;
};
const dev = manifesto.devDependencies ?? {};
const versaoTailwind = dev['tailwindcss'] ?? '';
const majorTailwind = Number(versaoTailwind.replace(/^[^\d]*/, '').split('.')[0]);
const postcssConfig = readFileSync(POSTCSS, 'utf8');
const globais = readFileSync(GLOBAIS, 'utf8');

describe('config do Tailwind do console acompanha o major do manifesto (#654)', () => {
  it('o manifesto declara um tailwindcss legível', () => {
    expect(
      Number.isInteger(majorTailwind) && majorTailwind >= 3,
      `\`tailwindcss\` em ${MANIFESTO} está como "${versaoTailwind}" — este guard não ` +
        'consegue ler o major, e sem ele todas as asserções abaixo passariam vazias',
    ).toBe(true);
  });

  it('no major >= 4 o plugin de PostCSS é `@tailwindcss/postcss`, na MESMA versão', () => {
    if (majorTailwind < 4) return;
    expect(
      dev['@tailwindcss/postcss'],
      'o console está no Tailwind >= 4 mas não declara `@tailwindcss/postcss`. O plugin ' +
        'saiu do pacote `tailwindcss` no major 4; sem ele o `next build` reprova em ' +
        'styles/globals.css. Foi assim que a PR #654 do Dependabot ficou vermelha.',
    ).toBe(versaoTailwind);
    expect(
      /['"]@tailwindcss\/postcss['"]\s*:/.test(postcssConfig),
      `${POSTCSS} não registra o plugin \`@tailwindcss/postcss\``,
    ).toBe(true);
    expect(
      /(^|[\s{,])['"]?tailwindcss['"]?\s*:/m.test(postcssConfig),
      `${POSTCSS} ainda registra \`tailwindcss\` como plugin de PostCSS — é exatamente ` +
        'o uso que o major 4 recusa em tempo de build.',
    ).toBe(false);
  });

  it('no major >= 4 a folha usa `@import "tailwindcss"` e não as diretivas do 3', () => {
    if (majorTailwind < 4) return;
    expect(
      /@import\s+['"]tailwindcss['"]/.test(globais),
      `${GLOBAIS} não importa o Tailwind com \`@import "tailwindcss"\``,
    ).toBe(true);
    expect(
      /@tailwind\s+(base|components|utilities)\s*;/.test(globais),
      `${GLOBAIS} ainda tem diretivas \`@tailwind\`, que não existem no major 4 — elas ` +
        'sobreviveriam ao build sem gerar utility nenhuma.',
    ).toBe(false);
  });

  it('todo `@source` da folha aponta para um diretório que existe', () => {
    const fontes = [...globais.matchAll(/@source\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(
      fontes.length,
      `${GLOBAIS} não declara nenhum \`@source\`. No major 4 isso não é erro de build: ` +
        'a descoberta automática assumiria a raiz do MONOREPO e varreria `src/` inteiro, ' +
        'trazendo para o CSS do console classes de outras árvores (ex.: o HTML com CDN do ' +
        'Tailwind 3 em src/setup/templates.ts).',
    ).toBeGreaterThan(0);

    const quebrados = fontes.filter((f) => {
      const alvo = resolve(dirname(GLOBAIS), f);
      return !existsSync(alvo) || !statSync(alvo).isDirectory();
    });
    expect(
      quebrados,
      'caminho de `@source` que não existe mais. O Tailwind NÃO reclama: ele varre zero ' +
        'arquivo, não emite as classes daquela árvore, e o build sai verde com a tela sem ' +
        'estilo. Estes `@source` são o que restou do array `content` do antigo ' +
        '`tailwind.config.ts`.',
    ).toEqual([]);
  });

  it('no major >= 4 não sobrou `tailwind.config.*` órfão', () => {
    if (majorTailwind < 4) return;
    const orfaos = ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.cjs']
      .map((n) => join(ADMIN_UI, n))
      .filter((p) => existsSync(p));
    expect(
      orfaos,
      'o tema do console mora em `@theme`, dentro de styles/globals.css. Um ' +
        '`tailwind.config.*` ao lado dele NÃO é carregado sozinho no major 4 (precisaria ' +
        'de `@config`), então seria uma segunda fonte de verdade que ninguém lê.',
    ).toEqual([]);
  });
});
