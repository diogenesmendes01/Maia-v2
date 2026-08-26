/**
 * #637 (fatia B da épica #471) — a MÉTRICA e o LIMIAR que decidem se dois
 * pedidos de ferramenta são o MESMO pedido.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE NÃO É COSSENO DE EMBEDDING
 * ─────────────────────────────────────────────────────────────────────────────
 * A issue parte de "os embeddings já existem (pgvector)". Existem — mas para
 * ESTA decisão eles não servem hoje, e a razão é verificável, não estética:
 *
 *   1. **Não dá para calibrar.** `getEmbeddingProvider()`
 *      (`src/lib/embeddings.ts`) é uma chamada HTTP paga a Voyage/OpenAI/Cohere.
 *      O CI e a suíte offline não têm chave. Um limiar de cosseno que ninguém
 *      pode medir nem retestar é um número escolhido por gosto com uma casa
 *      decimal a mais — exatamente o que o critério de pronto proíbe.
 *   2. **Não dá para reproduzir.** Trocar de provedor (ou o provedor trocar o
 *      modelo) move a escala de cosseno inteira. O limiar calibrado no modelo
 *      de ontem agrupa diferente amanhã, em silêncio, sobre dados de governança.
 *   3. **É o regime onde cosseno separa pior.** Enquanto `completeness` for
 *      `'name_only'` (ver a limitação herdada, documentada no cabeçalho de
 *      `aggregation.ts`), o texto comparado é UMA frase curta. Cosseno de
 *      frase curta em modelo genérico dá ~0,95 tanto para paráfrase quanto para
 *      "guia municipal" × "guia estadual".
 *
 * Então a métrica desta fatia é **determinística, local e mensurável**: o
 * coeficiente de Dice sobre o conjunto de tokens de conteúdo. Ela é auditável
 * no sentido literal — dá para dizer QUAIS tokens casaram —, roda sem rede, e o
 * limiar foi medido (ver abaixo) sobre um conjunto de negativos ROTULADOS PELO
 * PRÓPRIO PROJETO.
 *
 * NÃO criamos coluna `vector` nem índice ivfflat/hnsw nesta fatia. Um índice
 * vetorial sobre uma tabela que terá dezenas de linhas por tenant é mais lento
 * que a varredura sequencial (ivfflat só compensa na casa dos milhares de
 * linhas), e uma coluna vazia que ninguém popula é dívida com aparência de
 * recurso. O ponto de extensão está descrito em `docs/architecture/...` e o
 * `signature_version` persistido existe para que trocar de sinal seja uma
 * mudança VISÍVEL no schema, não uma troca silenciosa de agrupamento.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A MEDIÇÃO QUE SUSTENTA O LIMIAR — 0,85
 * ─────────────────────────────────────────────────────────────────────────────
 * Reprodutível: `npx tsx scripts/medir-limiar-tool-request.ts` (o script imprime
 * a tabela inteira). Reafirmada em teste por
 * `tests/unit/tool-request-limiar-medicao.spec.ts`, que roda a mesma medição
 * contra o catálogo VIVO e fica vermelho se o limiar deixar de valer.
 *
 * **Conjunto negativo (rótulos REAIS).** Todos os C(65,2) = 2080 pares de tools
 * DISTINTAS de `src/admin-ui/generated/tool-catalog.ts`. O rótulo não é opinião
 * minha: duas tools separadas no catálogo são duas coisas que este projeto já
 * decidiu que merecem implementações separadas. Fundir esse par é o erro CARO.
 *
 * **Conjunto positivo (SINTÉTICO — e isto está declarado).** 5 paráfrases por
 * tool (325 pares), por transformações fixas e committadas (troca de sinônimo,
 * moldura "não consigo… preciso de", truncamento, reordenação, e a composição
 * das duas primeiras). Não existe no repositório um par de gaps rotulado como
 * "mesmo pedido" — o ledger de ocorrências nasceu na fatia A e está vazio em
 * todo ambiente. Então o RECALL abaixo mede a tolerância da métrica a essas
 * cinco perturbações, não a duplicatas de produção. Onde o número é fraco,
 * está dito.
 *
 * | θ    | falsas fusões / 2080 | fusões corretas / 325 | precisão | recall |
 * |------|----------------------|-----------------------|----------|--------|
 * | 0,50 | 5                    | 325                   | 0,985    | 1,000  |
 * | 0,60 | 3                    | 325                   | 0,991    | 1,000  |
 * | 0,70 | 2                    | 294                   | 0,993    | 0,905  |
 * | 0,80 | 1                    | 254                   | 0,996    | 0,782  |
 * | **0,85** | **0**            | **236**               | **1,000**| **0,726** |
 * | 0,90 | 0                    | 203                   | 1,000    | 0,625  |
 * | 0,95 | 0                    | 141                   | 1,000    | 0,434  |
 *
 * **A regra de decisão, escrita antes de olhar o número:** o MENOR θ da grade
 * de 0,05 com ZERO falsas fusões no conjunto negativo real. Fundir dois pedidos
 * distintos some com demanda real e é praticamente invisível na triagem; não
 * fundir deixa duplicata no backlog, que a triagem (#638) fecha em segundos. Os
 * dois erros não custam o mesmo, então o limiar é fail-closed para o lado caro.
 *
 * **Por que 0,85 e não o vizinho.** 0,80 ainda funde um par real
 * (`save_fact` × `save_rule`, 0,833) — pagaria demanda apagada por 5,6 pontos
 * de recall. 0,90 não compra segurança nenhuma (já era zero em 0,84) e custa
 * 10 pontos de recall. A varredura fina mostra que a última falsa fusão some
 * em θ = 0,84; 0,85 é o primeiro ponto da grade de 0,05 acima disso.
 *
 * **A fragilidade, dita:** a margem é de 0,017 sobre UM par
 * (`save_fact` × `save_rule`, 0,833). O segundo pior é
 * `approve_capability_proposal` × `reject_capability_proposal` (0,750). Isto é,
 * o limiar seguro é fixado por um único par adversarial — daí o teste que
 * reroda a medição contra o catálogo VIVO: uma tool nova que empurre o pior
 * negativo acima de 0,85 tem de virar VERMELHO, não agrupamento errado.
 *
 * **Onde o recall dói, por perturbação (θ = 0,85):**
 *
 *   reordenado ....... 65/65   ordem de palavra não muda a assinatura
 *   moldura .......... 65/65   "não consigo … preciso de uma ferramenta"
 *   sinônimo ......... 54/65   um verbo trocado ainda funde
 *   sinônimo+moldura . 44/65
 *   truncado ......... 8/65    **o mesmo pedido dito pela metade NÃO funde**
 *
 * O `truncado` é o preço direto de 0,85 e não está escondido: quem descrever a
 * mesma lacuna em metade das palavras abre um pedido novo. Baixar o limiar para
 * recuperar esse caso reintroduz falsa fusão no conjunto negativo REAL — e a
 * regra de decisão diz qual dos dois erros aceitamos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A CONSEQUÊNCIA DO `name_only`, QUE É A NOTÍCIA RUIM
 * ─────────────────────────────────────────────────────────────────────────────
 * Dice sobre conjuntos de m e n tokens só assume os valores 2k/(m+n). Para duas
 * descrições de 4 tokens os valores possíveis são 0 · 0,25 · 0,50 · 0,75 · 1,00
 * — ou seja, **θ = 0,85 exige casamento EXATO do conjunto de tokens**. Para 8
 * tokens (a mediana das descrições do catálogo) é preciso compartilhar 7 de 8.
 *
 * Enquanto `completeness` for `'name_only'`, a assinatura sai só da
 * `capability_description` do gap — curta. Então, na prática, HOJE a agregação
 * é "mesmo conjunto de tokens de conteúdo, a menos de ordem, acento, pontuação
 * e palavras vazias", com folga real só para descrições longas. O contador vai
 * subir para repetição quase literal e pouco mais. Isso não é defeito da
 * política: é o teto do que a evidência de hoje sustenta, e inventar folga aqui
 * seria escolher fundir pedidos distintos sem medida que autorize.
 *
 * **Quando os rascunhos ficarem ricos, o limiar NÃO vale como está.** Assinatura
 * que inclua nomes de campo observados tem muito mais tokens, distribuição de
 * Dice diferente e limiar diferente — por isso a assinatura é VERSIONADA
 * (`ASSINATURA_VERSION`) e a versão é persistida por agregado e por membro.
 * Trocar a assinatura sem re-medir é a forma de errar aqui.
 */
import { normalizarTexto, PALAVRAS_VAZIAS } from './existing-tool.js';

/**
 * Versão da ASSINATURA. Sobe quando o que entra no conjunto de tokens muda —
 * e mudar isso obriga a RE-MEDIR o limiar (ver o cabeçalho). Persistida por
 * agregado e por membro para que um agrupamento feito sob outra versão seja
 * identificável em vez de se misturar com os novos.
 */
export const ASSINATURA_VERSION = 1 as const;

/** O nome da métrica, persistido junto de cada fusão. */
export const METRICA_SIMILARIDADE = 'dice_token_v1' as const;

/**
 * O LIMIAR. Ver "A MEDIÇÃO QUE SUSTENTA O LIMIAR" no cabeçalho: menor θ da
 * grade de 0,05 com zero falsas fusões sobre 2080 pares negativos reais.
 */
export const LIMIAR_SIMILARIDADE = 0.85;

/**
 * Palavras vazias da ASSINATURA. Estende a lista do nomeador
 * (`existing-tool.ts`) porque os dois trabalhos são diferentes: lá a lista é
 * curta de propósito (uma lista grande apaga o verbo que dá sentido ao NOME);
 * aqui ela pode ser maior, porque o que sobra não vira nome — vira conjunto
 * comparado. Cada palavra abaixo é conectivo ou moldura de queixa, e nenhuma
 * distingue duas ferramentas.
 */
export const PALAVRAS_VAZIAS_DE_ASSINATURA: ReadonlySet<string> = new Set([
  ...PALAVRAS_VAZIAS,
  'se', 'ha', 'quando', 'apenas', 'ex', 'vs', 'sobre', 'como', 'isso', 'esse',
  'essa', 'este', 'esta', 'ser', 'estar', 'ter', 'muito', 'mais', 'menos',
  'tambem', 'ainda', 'ja', 'so', 'entao', 'porque', 'pois', 'mas', 'nem',
]);

/**
 * Os TOKENS DE CONTEÚDO de um texto: normalizados, sem palavra vazia e sem
 * token de uma letra só (que nunca discrimina e infla o denominador).
 *
 * Determinístico e sem estado — duas rodadas sobre o mesmo texto dão o mesmo
 * conjunto, que é o que permite comparar agrupamentos de dias diferentes.
 */
export function tokensDeConteudo(texto: string): string[] {
  return normalizarTexto(texto)
    .split(' ')
    .filter((t) => t.length > 1 && !PALAVRAS_VAZIAS_DE_ASSINATURA.has(t));
}

/**
 * A ASSINATURA de um pedido: os tokens de conteúdo, únicos e ORDENADOS.
 *
 * Ordenar é o que faz a assinatura ser estável sob reordenação de palavras
 * ("emitir guia municipal" e "guia municipal emitir" têm a mesma assinatura), e
 * é o que a torna legível numa coluna de texto — quem lê a linha vê exatamente
 * o que foi comparado.
 *
 * O que ENTRA: só a `capability_description` do gap. `contexto` fica de fora de
 * propósito: ele é situacional ("cobranca", "onboarding") e apareceria em
 * pedidos que não têm nada a ver entre si, inflando a similaridade justamente
 * onde o erro é caro. O que a assinatura tem de capturar é "a mesma ferramenta
 * faltando", não "a mesma parte do dia".
 */
export function assinaturaDePedido(capability_description: string): string {
  return [...new Set(tokensDeConteudo(capability_description))].sort().join(' ');
}

/** Os tokens de uma assinatura já montada (ela é o join por espaço). */
export function tokensDaAssinatura(assinatura: string): Set<string> {
  return new Set(assinatura.split(' ').filter((t) => t.length > 0));
}

/**
 * Coeficiente de Dice entre dois conjuntos: `2·|A∩B| / (|A|+|B|)`.
 *
 * Dois conjuntos vazios dão 0, e NÃO 1. Um pedido sem token de conteúdo não
 * tem do que ser "igual" a outro; devolver 1 faria todo pedido indescritível
 * cair no mesmo balde — o pior agrupamento possível, e silencioso.
 */
export function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersecao = 0;
  for (const t of a) if (b.has(t)) intersecao += 1;
  return (2 * intersecao) / (a.size + b.size);
}

/** A similaridade entre duas ASSINATURAS, em [0,1]. */
export function similaridadeDeAssinaturas(a: string, b: string): number {
  return dice(tokensDaAssinatura(a), tokensDaAssinatura(b));
}

/**
 * A DECISÃO: estes dois pedidos são o mesmo pedido?
 *
 * Devolve o score junto do veredito porque quem persiste a fusão grava o score
 * — um agrupamento sem o número que o justificou não é auditável, é um fato
 * sem prova.
 */
export function mesmoPedido(
  assinaturaA: string,
  assinaturaB: string,
  limiar: number = LIMIAR_SIMILARIDADE,
): { funde: boolean; similaridade: number } {
  const similaridade = similaridadeDeAssinaturas(assinaturaA, assinaturaB);
  return { funde: similaridade >= limiar, similaridade };
}
