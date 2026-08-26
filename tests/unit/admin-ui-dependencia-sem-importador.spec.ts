/**
 * Toda dependência de runtime do `src/admin-ui` tem importador — ou uma
 * justificativa escrita (#605).
 *
 * O defeito que originou este guard
 * ---------------------------------
 * A issue #605 pediu o major `recharts` 2 -> 3 "com o visual do console
 * verificado". O inventário que ela mesma exige como primeiro critério de
 * aceite devolveu VAZIO: `recharts` estava em `src/admin-ui/package.json`
 * desde o scaffold do P8.5 (e23c8523) e NENHUM arquivo do repositório jamais
 * o importou —
 *
 *     $ git log --all -S "from 'recharts"      # nenhum commit
 *
 * Uma dependência fantasma dessas não é inerte. Ela:
 *   - entra no `npm audit` e no ledger de exceções (#526), então um advisory
 *     dela REPROVA o CI por causa de código que não existe;
 *   - vira PR do Dependabot (o bloco `/src/admin-ui` que
 *     `tests/unit/dependabot-admin-ui.spec.ts` tranca), e alguém gasta uma
 *     revisão de major — foi exatamente a #587, fechada em favor da #605;
 *   - e é INVISÍVEL: nada no CI compara o manifesto com os imports.
 *
 * `recharts` arrastava 34 pacotes (todo o `d3-*` via `victory-vendor`) para
 * uma árvore que não renderiza um gráfico sequer.
 *
 * A propriedade sob teste
 * ----------------------
 * Não é "`recharts` não voltou" — isso seria um guard de um nome só, e o
 * próximo fantasma passaria igual. É a invariante geral: **uma dependência de
 * runtime do console ou tem importador, ou tem um motivo escrito aqui.**
 *
 * POR QUE VARRER `src/` INTEIRO, E NÃO SÓ `src/admin-ui/`. O console importa
 * módulos de fora da própria pasta por caminho relativo — `../../db/
 * repositories.js`, `../../config/env.js` — e é por isso que
 * `next.config.mjs` fixa `outputFileTracingRoot` na raiz do repo. Quem puxa
 * `drizzle-orm` e `pg` para o bundle do standalone é essa travessia, não um
 * import dentro de `src/admin-ui/`. Varrer só a pasta do console acusaria os
 * dois como fantasmas — falso positivo que obrigaria a allowlist a crescer com
 * entradas erradas. Varrer `src/` inteiro é a aproximação CONSERVADORA: erra
 * para o lado de achar importador demais, nunca de menos, então todo fantasma
 * que este spec aponta é fantasma de verdade.
 *
 * POR QUE `devDependencies` FICA DE FORA. Ferramenta de build não é importada
 * por código-fonte por definição (`tailwindcss`, `postcss`, `eslint`,
 * `@playwright/test`). Cobri-las seria uma allowlist do tamanho do bloco, sem
 * sinal nenhum.
 *
 * POR QUE UM SCANNER TEXTUAL, E NÃO O `tsc`. A pergunta é "existe algum
 * importador", não "os tipos fecham" — `admin:typecheck` já responde a
 * segunda, e responde-a VERDE com uma dependência fantasma no manifesto, que é
 * justamente o ponto cego aqui.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MANIFESTO = join(process.cwd(), 'src/admin-ui/package.json');
const RAIZ_VARREDURA = join(process.cwd(), 'src');

/**
 * Dependências de runtime SEM importador que continuam declaradas de
 * propósito. Toda entrada precisa de motivo escrito — a chave sozinha não
 * autoriza nada, e o spec abaixo reprova motivo vazio.
 */
const SEM_IMPORTADOR_JUSTIFICADO: Readonly<Record<string, string>> = {
  'react-dom':
    'Renderizador do React para o DOM. Nenhum arquivo do console o nomeia: ' +
    'quem o carrega é o runtime do Next (bundle de cliente e `react-dom/server` ' +
    'no SSR). É peer obrigatório de `next` e de `react` — sem ele declarado, o ' +
    '`npm ci` do Dockerfile do admin-ui não instala o renderizador e o build morre.',

  'react-hook-form':
    'DÍVIDA CONHECIDA: entrou no scaffold do P8.5 (e23c8523) e nunca foi ' +
    'ligada. Os formulários do console usam `React.useState` + ' +
    '`components/ui/field.tsx`. Fica aqui para PARAR DE SER INVISÍVEL.',

  'react-diff-viewer-continued':
    'DÍVIDA CONHECIDA: entrou no scaffold do P8.5 (e23c8523) e nunca foi ' +
    'ligada. A tela de versões/propostas mostra diff como texto. Fica aqui ' +
    'para PARAR DE SER INVISÍVEL.',
};

/**
 * Pacotes cujo importador o scanner TEM de achar. Âncora anti-vacuidade: se o
 * scanner regredir para "nunca acha nada", a asserção geral passaria sozinha
 * (tudo viraria "sem importador" e... não, reprovaria) — mas se ele regredir
 * para "acha tudo", a asserção geral passa VAZIA e nenhum fantasma é pego.
 * Estes quatro cobrem as duas formas de import que importam: dentro do console
 * (`next`, `@trpc/server`) e por travessia para fora dele (`drizzle-orm`).
 */
const IMPORTADORES_OBRIGATORIOS = ['next', 'zod', '@trpc/server', 'drizzle-orm'] as const;

/** `@scope/pkg/sub/path` -> `@scope/pkg`; `pkg/sub` -> `pkg`. */
function nomeDoPacote(especificador: string): string {
  const partes = especificador.split('/');
  return especificador.startsWith('@') ? partes.slice(0, 2).join('/') : partes[0]!;
}

function arquivosDeFonte(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (entrada === 'node_modules' || entrada === '.next' || entrada === 'dist') continue;
    const caminho = join(dir, entrada);
    if (statSync(caminho).isDirectory()) {
      arquivosDeFonte(caminho, acc);
      continue;
    }
    if (/\.(ts|tsx|mts|cts|mjs|js|jsx)$/.test(entrada)) acc.push(caminho);
  }
  return acc;
}

/**
 * Especificadores BARE (não relativos, não `node:`) alcançados por qualquer
 * uma das quatro formas: `import ... from`, `export ... from`, `import(...)`
 * e `require(...)`.
 */
const FORMAS_DE_IMPORT = [
  /(?:^|[\s;}])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function pacotesImportados(): ReadonlySet<string> {
  const encontrados = new Set<string>();
  for (const arquivo of arquivosDeFonte(RAIZ_VARREDURA)) {
    const texto = readFileSync(arquivo, 'utf8');
    for (const forma of FORMAS_DE_IMPORT) {
      forma.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = forma.exec(texto)) !== null) {
        const esp = m[1]!;
        if (esp.startsWith('.') || esp.startsWith('/') || esp.startsWith('node:')) continue;
        if (esp.startsWith('@/') || esp.startsWith('@db/') || esp.startsWith('@admin/')) continue;
        if (esp.startsWith('@governance/')) continue;
        encontrados.add(nomeDoPacote(esp));
      }
    }
  }
  return encontrados;
}

const manifesto = JSON.parse(readFileSync(MANIFESTO, 'utf8')) as {
  dependencies?: Record<string, string>;
};
const declaradas = Object.keys(manifesto.dependencies ?? {});
const importados = pacotesImportados();

describe('dependência de runtime do admin-ui sem importador (#605)', () => {
  it('o manifesto do console declara dependências de runtime', () => {
    expect(declaradas.length).toBeGreaterThan(0);
  });

  // Âncora anti-vacuidade — ver a nota em IMPORTADORES_OBRIGATORIOS.
  it('o scanner enxerga mesmo os imports (âncora)', () => {
    for (const pacote of IMPORTADORES_OBRIGATORIOS) {
      expect(
        importados.has(pacote),
        `o scanner não achou nenhum import de \`${pacote}\`, que o código comprovadamente ` +
          'importa — ele regrediu, e as asserções abaixo estão passando vazias',
      ).toBe(true);
    }
  });

  it('toda dependência declarada tem importador ou motivo escrito', () => {
    const fantasmas = declaradas.filter(
      (d) => !importados.has(d) && !(d in SEM_IMPORTADOR_JUSTIFICADO),
    );
    expect(
      fantasmas,
      'dependência de runtime em `src/admin-ui/package.json` que NENHUM arquivo de `src/` ' +
        'importa. Foi assim que `recharts` ficou 2 majors parado, virando advisory no ledger ' +
        '(#526) e PR de major do Dependabot (#587) por código que não existe. Remova a ' +
        'dependência, ou declare o motivo em SEM_IMPORTADOR_JUSTIFICADO neste arquivo.',
    ).toEqual([]);
  });

  it('toda justificativa traz um motivo não vazio', () => {
    for (const [pacote, motivo] of Object.entries(SEM_IMPORTADOR_JUSTIFICADO)) {
      expect(motivo.trim().length, `\`${pacote}\` está na allowlist sem motivo escrito`)
        .toBeGreaterThan(40);
    }
  });

  // Anti-apodrecimento: a allowlist é uma lista de exceções VIVAS. Uma entrada
  // para pacote que já saiu do manifesto, ou que já ganhou importador, é
  // permissão sobrando — e permissão sobrando é como um fantasma volta sem
  // ninguém reparar.
  it('a allowlist não guarda entrada obsoleta', () => {
    const naoDeclaradas = Object.keys(SEM_IMPORTADOR_JUSTIFICADO).filter(
      (p) => !declaradas.includes(p),
    );
    expect(
      naoDeclaradas,
      'entrada em SEM_IMPORTADOR_JUSTIFICADO para pacote que não está mais nas ' +
        '`dependencies` do console — apague a entrada',
    ).toEqual([]);

    const jaImportadas = Object.keys(SEM_IMPORTADOR_JUSTIFICADO).filter((p) =>
      importados.has(p),
    );
    expect(
      jaImportadas,
      'entrada em SEM_IMPORTADOR_JUSTIFICADO para pacote que AGORA tem importador — a ' +
        'exceção deixou de ser necessária, apague a entrada',
    ).toEqual([]);
  });
});
