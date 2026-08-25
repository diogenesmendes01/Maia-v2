/**
 * #637 (fatia B da épica #471) — A MEDIÇÃO QUE SUSTENTA O LIMIAR DE
 * SIMILARIDADE dos pedidos de ferramenta.
 *
 *   npx tsx scripts/medir-limiar-tool-request.ts
 *
 * Ela existe para que o número em `src/cognition/tool-request/similarity.ts`
 * (`LIMIAR_SIMILARIDADE`) NÃO seja um valor redondo escolhido por gosto. A
 * mesma função que produz a tabela abaixo é a que decide em produção — o script
 * importa `similaridadeDeAssinaturas` do módulo de produção, não uma cópia.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O CONJUNTO NEGATIVO É REAL. O POSITIVO É SINTÉTICO. OS DOIS ESTÃO DECLARADOS.
 * ─────────────────────────────────────────────────────────────────────────────
 * **Negativos (rótulo real).** Todos os C(N,2) pares de tools DISTINTAS de
 * `src/admin-ui/generated/tool-catalog.ts`. O rótulo não é opinião de quem
 * escreveu isto: duas tools separadas no catálogo são duas coisas que este
 * projeto já decidiu que merecem implementações separadas. Fundir um desses
 * pares é o erro CARO — some com demanda real e é quase invisível na triagem.
 *
 * **Positivos (sintéticos, e por quê).** Não existe no repositório um par de
 * gaps rotulado como "mesmo pedido": o ledger de ocorrências nasceu na fatia A
 * (#636) e está vazio em todo ambiente. Então os positivos são paráfrases
 * geradas por transformações FIXAS e committadas (abaixo), aplicadas às
 * descrições reais. O recall que a tabela mostra é a tolerância da métrica a
 * ESSAS transformações — não a duplicatas de produção. Onde isso enfraquece a
 * conclusão, o cabeçalho de `similarity.ts` diz que enfraquece.
 *
 * **Por que descrição de TOOL como proxy de descrição de GAP.** É o corpus mais
 * próximo que existe: prosa curta em português, escrita neste projeto, sobre
 * capacidades em forma de ferramenta. A limitação é real e fica registrada: o
 * texto que a produção compara é a `capability_description` do gap, tipicamente
 * MAIS CURTA — e Dice sobre conjuntos menores é mais grosso, o que o bloco de
 * granularidade no fim da saída quantifica.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A REGRA DE DECISÃO, ESCRITA ANTES DE OLHAR O NÚMERO
 * ─────────────────────────────────────────────────────────────────────────────
 * O limiar escolhido é o MENOR θ da grade de 0,05 com ZERO falsas fusões sobre
 * o conjunto negativo real. Os dois erros não custam o mesmo: fundir pedidos
 * distintos apaga demanda; não fundir deixa duplicata que a triagem (#638)
 * fecha em segundos. O limiar é fail-closed para o lado caro.
 */
import {
  LIMIAR_SIMILARIDADE,
  METRICA_SIMILARIDADE,
  assinaturaDePedido,
  similaridadeDeAssinaturas,
  tokensDeConteudo,
} from '@/cognition/tool-request/similarity.js';
import { TOOL_CATALOG } from '@/admin-ui/generated/tool-catalog.js';

/** Um par rotulado do conjunto de medição. */
export interface ParRotulado {
  readonly a: string;
  readonly b: string;
  readonly textoA: string;
  readonly textoB: string;
  /** `true` = deveria fundir. */
  readonly mesmo: boolean;
  /** Qual transformação gerou o par (só para positivos). */
  readonly origem: string;
}

/**
 * A primeira frase da descrição. É o pedaço que corresponde ao que um gap
 * registraria ("emitir guia de recolhimento no portal municipal"); o resto da
 * descrição do catálogo costuma ser ressalva de implementação (STUB, limites,
 * "apenas leitura") que um gap não teria como saber.
 */
export function primeiraFrase(descricao: string): string {
  return descricao.split(/(?<=\.)\s/)[0] ?? descricao;
}

/**
 * Sinônimos de VERBO em português. Lista fechada e committada: ela define o que
 * "paráfrase" significa nesta medição, e mudá-la muda o recall — então ela é
 * dado da medição, não detalhe de implementação.
 */
const SINONIMOS: Record<string, string> = {
  consulta: 'verifica', consultar: 'verificar', verifica: 'consulta', verificar: 'consultar',
  lista: 'enumera', listar: 'enumerar', cria: 'cadastra', criar: 'cadastrar',
  registra: 'grava', registrar: 'gravar', busca: 'procura', buscar: 'procurar',
  emite: 'gera', emitir: 'gerar', calcula: 'apura', calcular: 'apurar',
  valida: 'confere', validar: 'conferir', solicita: 'pede', solicitar: 'pedir',
  localiza: 'encontra', localizar: 'encontrar', soma: 'adiciona', conta: 'totaliza',
  marca: 'sinaliza', aprova: 'autoriza', retorna: 'devolve',
};

function trocarSinonimos(texto: string): string {
  return texto
    .split(/\s+/)
    .map((palavra) => {
      const chave = palavra
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      return SINONIMOS[chave] ?? palavra;
    })
    .join(' ');
}

/** "Não consigo X — preciso de uma ferramenta para isso." */
function comMoldura(texto: string): string {
  return `Não consigo ${texto.toLowerCase()} — preciso de uma ferramenta para isso.`;
}

/** Metade dos tokens de conteúdo: o mesmo pedido dito de forma mais curta. */
function truncado(texto: string): string {
  const t = tokensDeConteudo(texto);
  return t.slice(0, Math.max(3, Math.ceil(t.length / 2))).join(' ');
}

/** A primeira palavra vai para o fim: mesma informação, outra ordem. */
function reordenado(texto: string): string {
  const p = texto.split(/\s+/);
  return p.length < 2 ? texto : [...p.slice(1), p[0]!].join(' ');
}

export const PERTURBACOES: ReadonlyArray<{ nome: string; f: (s: string) => string }> = [
  { nome: 'sinonimo', f: trocarSinonimos },
  { nome: 'moldura', f: comMoldura },
  { nome: 'truncado', f: truncado },
  { nome: 'reordenado', f: reordenado },
  { nome: 'sinonimo+moldura', f: (s) => trocarSinonimos(comMoldura(s)) },
];

/** O conjunto de medição inteiro, a partir do catálogo committado. */
export function construirCorpus(
  catalogo: ReadonlyArray<{ name: string; description: string }> = TOOL_CATALOG,
): { negativos: ParRotulado[]; positivos: ParRotulado[] } {
  const itens = catalogo.map((t) => ({ nome: t.name, texto: primeiraFrase(t.description) }));

  const negativos: ParRotulado[] = [];
  for (let i = 0; i < itens.length; i += 1) {
    for (let j = i + 1; j < itens.length; j += 1) {
      negativos.push({
        a: itens[i]!.nome,
        b: itens[j]!.nome,
        textoA: itens[i]!.texto,
        textoB: itens[j]!.texto,
        mesmo: false,
        origem: 'catalogo',
      });
    }
  }

  const positivos: ParRotulado[] = [];
  for (const it of itens) {
    for (const p of PERTURBACOES) {
      positivos.push({
        a: it.nome,
        b: `${it.nome}#${p.nome}`,
        textoA: it.texto,
        textoB: p.f(it.texto),
        mesmo: true,
        origem: p.nome,
      });
    }
  }
  return { negativos, positivos };
}

/** O score de um par, pela MESMA função que decide em produção. */
export function scoreDoPar(par: ParRotulado): number {
  return similaridadeDeAssinaturas(
    assinaturaDePedido(par.textoA),
    assinaturaDePedido(par.textoB),
  );
}

export interface LinhaDaVarredura {
  limiar: number;
  falsas_fusoes: number;
  fusoes_corretas: number;
  precisao: number;
  recall: number;
}

export function varrer(
  negativos: readonly ParRotulado[],
  positivos: readonly ParRotulado[],
  limiares: readonly number[],
): LinhaDaVarredura[] {
  const sNeg = negativos.map(scoreDoPar);
  const sPos = positivos.map(scoreDoPar);
  return limiares.map((limiar) => {
    const fp = sNeg.filter((s) => s >= limiar).length;
    const tp = sPos.filter((s) => s >= limiar).length;
    return {
      limiar,
      falsas_fusoes: fp,
      fusoes_corretas: tp,
      precisao: tp + fp === 0 ? 1 : tp / (tp + fp),
      recall: sPos.length === 0 ? 0 : tp / sPos.length,
    };
  });
}

/**
 * O MENOR limiar da grade com zero falsas fusões. É a regra de decisão desta
 * medição, escrita como código para que ninguém precise confiar na prosa.
 */
export function menorLimiarSeguro(linhas: readonly LinhaDaVarredura[]): number | null {
  const seguros = linhas.filter((l) => l.falsas_fusoes === 0).map((l) => l.limiar);
  return seguros.length === 0 ? null : Math.min(...seguros);
}

function grade(de: number, ate: number, passo: number): number[] {
  const out: number[] = [];
  for (let v = de; v <= ate + 1e-9; v += passo) out.push(Math.round(v * 100) / 100);
  return out;
}

function main(): void {
  const { negativos, positivos } = construirCorpus();
  const linhas = varrer(negativos, positivos, grade(0.3, 0.95, 0.05));

  console.log(`# Medição do limiar de similaridade — pedidos de ferramenta (#637)`);
  console.log(`\nmétrica: ${METRICA_SIMILARIDADE}`);
  console.log(`negativos (rótulo REAL, pares de tools distintas do catálogo): ${negativos.length}`);
  console.log(`positivos (SINTÉTICOS, ${PERTURBACOES.length} paráfrases por tool): ${positivos.length}`);
  console.log(`\n| θ | falsas fusões / ${negativos.length} | fusões corretas / ${positivos.length} | precisão | recall |`);
  console.log('|---|---|---|---|---|');
  for (const l of linhas) {
    console.log(
      `| ${l.limiar.toFixed(2)} | ${l.falsas_fusoes} | ${l.fusoes_corretas} | ` +
        `${l.precisao.toFixed(3)} | ${l.recall.toFixed(3)} |`,
    );
  }

  const fino = varrer(negativos, positivos, grade(0.7, 0.95, 0.01));
  console.log('\n## varredura fina (onde a última falsa fusão some)');
  for (const l of fino) {
    console.log(`  θ=${l.limiar.toFixed(2)}  falsas fusões=${l.falsas_fusoes}  recall=${l.recall.toFixed(3)}`);
  }

  console.log('\n## os piores negativos (é UM par que fixa o limiar seguro)');
  const piores = negativos
    .map((p) => ({ p, s: scoreDoPar(p) }))
    .sort((x, y) => y.s - x.s)
    .slice(0, 10);
  for (const { p, s } of piores) console.log(`  ${s.toFixed(3)}  ${p.a} ~ ${p.b}`);

  console.log('\n## recall por perturbação, no limiar em vigor');
  for (const perturbacao of PERTURBACOES) {
    const desta = positivos.filter((p) => p.origem === perturbacao.nome);
    const ok = desta.filter((p) => scoreDoPar(p) >= LIMIAR_SIMILARIDADE).length;
    console.log(`  ${perturbacao.nome.padEnd(18)} ${ok}/${desta.length}`);
  }

  console.log('\n## granularidade — por que isto importa com `completeness: name_only`');
  console.log('  Dice entre conjuntos de m e n tokens só assume os valores 2k/(m+n).');
  for (const m of [3, 4, 5, 8, 12]) {
    const valores = Array.from({ length: m + 1 }, (_, k) => (k / m).toFixed(2)).join(' ');
    console.log(`  m=n=${String(m).padStart(2)}: ${valores}`);
  }
  const tamanhos = TOOL_CATALOG.map((t) => tokensDeConteudo(primeiraFrase(t.description)).length)
    .slice()
    .sort((a, b) => a - b);
  console.log(
    `  tokens por descrição no corpus: mín=${tamanhos[0]} mediana=${tamanhos[Math.floor(tamanhos.length / 2)]} máx=${tamanhos[tamanhos.length - 1]}`,
  );

  const seguro = menorLimiarSeguro(linhas);
  console.log(`\n## conclusão`);
  console.log(`  menor limiar da grade de 0,05 com zero falsas fusões: ${seguro?.toFixed(2) ?? 'nenhum'}`);
  console.log(`  limiar em vigor (LIMIAR_SIMILARIDADE): ${LIMIAR_SIMILARIDADE.toFixed(2)}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main();
}
