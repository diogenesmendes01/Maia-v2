/**
 * #636 — a fronteira de uma varredura estática é uma decisão, e tem de ser
 * DERIVADA do que o código chama, não do diretório onde o arquivo mora.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O DEFEITO QUE ISTO FECHA
 * ─────────────────────────────────────────────────────────────────────────────
 * A primeira versão da varredura do guardrail listava `readdirSync()` de
 * `src/cognition/tool-request/`. Ela ficava vermelha para uma instalação de
 * tool escrita em `proposer.ts` e CEGA para a mesma instalação escrita em
 * `src/cognition/proposal-approval-handler.ts` — que é precisamente o arquivo
 * onde alguém escreveria "aprovou, então instala". A fronteira era o diretório;
 * o comportamento a ser proibido não conhece diretório.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O MECANISMO
 * ─────────────────────────────────────────────────────────────────────────────
 * A partir de pontos de entrada (os call sites reais de um caminho), segue os
 * `import`/`export ... from`/`await import()` transitivamente dentro de `src/`
 * e devolve os arquivos alcançados. Um arquivo NOVO que o caminho passe a
 * importar entra sozinho no conjunto varrido — que é a propriedade que o
 * `readdirSync` não tinha.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A FRONTEIRA, DECLARADA
 * ─────────────────────────────────────────────────────────────────────────────
 * A travessia PARA em módulos de infraestrutura compartilhada (`barreiras`).
 * Isso é necessário e é uma limitação real, então fica escrito: `@/db/…`
 * DEFINE `agentToolGrantsRepo`, `@/tools/_registry.js` DEFINE `REGISTRY`, e
 * `@/lib/…` puxa metade da plataforma. Sem barreira, a varredura alcançaria
 * centenas de arquivos e acusaria a DEFINIÇÃO de um verbo como se fosse uso —
 * um teste que grita sempre não é lido por ninguém.
 *
 * A consequência honesta: uma instalação escrita DENTRO de um módulo de
 * barreira escapa desta varredura. É por isso que ela é a defesa SECUNDÁRIA. A
 * primária é a invariante de runtime do guardrail (nenhuma tool viva fora do
 * catálogo committado), que não tem fronteira de arquivo nenhuma.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** `import x from 'y'`, `export … from 'y'`, `await import('y')`. */
const ESPECIFICADORES =
  /(?:^|[^.\w])(?:import|export)\s*(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Resolve um especificador para um arquivo `.ts` dentro de `src/`, ou `null`
 * quando ele não é código nosso (pacote do npm, tipo puro do Node…).
 *
 * O projeto é ESM com extensão `.js` nos imports (NodeNext), então o alvo em
 * disco é sempre o `.ts` de mesmo nome.
 */
export function resolverParaArquivoDeSrc(
  especificador: string,
  arquivoQueImporta: string,
  raizDoSrc: string,
): string | null {
  let bruto: string;
  if (especificador.startsWith('@/')) {
    bruto = join(raizDoSrc, especificador.slice(2));
  } else if (especificador.startsWith('.')) {
    bruto = resolve(dirname(arquivoQueImporta), especificador);
  } else {
    return null;
  }
  const candidatos = [
    bruto.replace(/\.js$/, '.ts'),
    bruto.endsWith('.ts') ? bruto : `${bruto}.ts`,
    join(bruto.replace(/\.js$/, ''), 'index.ts'),
  ];
  for (const c of candidatos) {
    if (existsSync(c)) return c;
  }
  return null;
}

export interface AlcanceArgs {
  /** Call sites reais de onde o caminho começa (caminhos absolutos `.ts`). */
  readonly entradas: readonly string[];
  /** Raiz do `src/` do projeto (caminho absoluto). */
  readonly raizDoSrc: string;
  /**
   * Prefixos (relativos ao `src/`) onde a travessia PARA. Ver "A FRONTEIRA,
   * DECLARADA" no cabeçalho — cada entrada aqui é uma cegueira assumida.
   */
  readonly barreiras: readonly string[];
}

/** Os arquivos de `src/` que o caminho alcança, ordenados e determinísticos. */
export function arquivosAlcancados(args: AlcanceArgs): string[] {
  const barrado = (arquivo: string): boolean => {
    const rel = relative(args.raizDoSrc, arquivo).split('\\').join('/');
    return args.barreiras.some((b) => rel === b || rel.startsWith(b));
  };

  const vistos = new Set<string>();
  const fila = [...args.entradas];
  while (fila.length > 0) {
    const atual = fila.pop()!;
    if (vistos.has(atual)) continue;
    if (!existsSync(atual)) continue;
    vistos.add(atual);

    const fonte = readFileSync(atual, 'utf8');
    ESPECIFICADORES.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ESPECIFICADORES.exec(fonte)) !== null) {
      const especificador = m[1] ?? m[2];
      if (!especificador) continue;
      const alvo = resolverParaArquivoDeSrc(especificador, atual, args.raizDoSrc);
      // A barreira impede a TRAVESSIA e a inclusão: um módulo de
      // infraestrutura não é varrido nem serve de ponte para o resto dela.
      if (alvo && !vistos.has(alvo) && !barrado(alvo)) fila.push(alvo);
    }
  }
  return [...vistos].sort();
}
