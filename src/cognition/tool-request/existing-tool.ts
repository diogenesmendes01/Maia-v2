/**
 * #636 — "esta lacuna precisa de uma tool que NÃO EXISTE?"
 *
 * É a pergunta que decide se um gap vira pedido de ferramenta. A resposta é
 * DETERMINÍSTICA e não passa por LLM: o pedido é dirigido a um dev, e "o
 * backend decide" (invariante #3) vale com mais força ainda quando a decisão
 * gera trabalho humano.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O QUE CONTA COMO "TOOL DISPONÍVEL"
 * ─────────────────────────────────────────────────────────────────────────────
 * Existir NO CÓDIGO — isto é, ser uma chave de `REGISTRY`
 * (`src/tools/_registry.ts`) —, e não "estar concedida a este agente".
 *
 * A distinção importa e é contestável, então está escrita: o entregável de um
 * pedido de ferramenta é uma ISSUE PARA DEVS. Se a tool já existe mas o agente
 * não a tem, não falta código: falta GRANT, e o caminho é o dono conceder
 * (`agent_tool_grants`, #408) — abrir issue de implementação ali seria mandar
 * um dev construir o que já está construído. Por isso o resultado
 * `tool_ja_existe` carrega o nome encontrado: quem chama pode registrar
 * "existe, verifique o grant" em vez de silenciar.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COMO O CASAMENTO É FEITO
 * ─────────────────────────────────────────────────────────────────────────────
 * Por NOME, nas duas direções, sobre o texto normalizado do gap:
 *
 *   1. o nome de uma tool registrada aparece no texto do gap
 *      (`query_balance` ou `query balance`);
 *   2. o nome que ESTA fatia proporia para o gap (`esbocarNomeDeTool`) já é
 *      uma tool registrada.
 *
 * O que ele NÃO faz, deliberadamente: casamento por SIMILARIDADE semântica.
 * Isso é a fatia B (#637) e exige embeddings + limiar + calibração. Um
 * casamento fuzzy mal calibrado aqui erraria para o lado caro — deixaria de
 * abrir o pedido porque "parece" com uma tool existente. Por nome, o erro é
 * para o lado barato: abre um pedido a mais, que a triagem (#638) fecha.
 */

/** Sem acento, minúsculo, e tudo que não é letra/dígito vira espaço. */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Palavras que não ajudam a nomear uma tool. Lista curta e fechada de propósito:
 * uma lista grande passa a apagar o verbo que dá sentido ao nome.
 */
const PALAVRAS_VAZIAS = new Set([
  'a', 'as', 'o', 'os', 'um', 'uma', 'uns', 'umas',
  'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas',
  'para', 'por', 'com', 'sem', 'e', 'ou', 'que', 'ao', 'aos', 'the',
  'nao', 'consigo', 'preciso', 'precisa', 'poder', 'posso',
]);

/** Quantos tokens entram no nome proposto. Além disso o nome vira frase. */
const MAX_TOKENS_NO_NOME = 4;

/**
 * O nome que esta fatia proporia para a tool que falta.
 *
 * Determinístico: mesma descrição, mesmo nome, sempre — o que faz duas rodadas
 * do worker sobre o mesmo gap produzirem o mesmo rascunho em vez de dois nomes
 * concorrentes para a mesma coisa.
 *
 * Devolve `null` quando não sobra token utilizável. `null` não é um nome
 * genérico de reserva: sem nome não há rascunho de contrato, e sem rascunho não
 * há pedido — a fatia prefere não abrir o pedido a abrir um chamado
 * `tool_1` que ninguém sabe avaliar.
 */
export function esbocarNomeDeTool(descricao: string): string | null {
  const tokens = normalizarTexto(descricao)
    .split(' ')
    .filter((t) => t.length > 0 && !PALAVRAS_VAZIAS.has(t))
    // Um token que começa com dígito não pode abrir um identificador; no meio
    // do nome ele é legítimo (`consultar_cep_8_digitos`).
    .slice(0, MAX_TOKENS_NO_NOME);

  while (tokens.length > 0 && /^[0-9]/.test(tokens[0]!)) tokens.shift();
  if (tokens.length === 0) return null;

  const nome = tokens.join('_').slice(0, 64);
  return /^[a-z][a-z0-9_]{2,63}$/.test(nome) ? nome : null;
}

/**
 * O nome da tool JÁ REGISTRADA que cobre este gap, ou `null`.
 *
 * `catalogo` é a lista de nomes de tools que existem no código. Ela é passada
 * pelo chamador — que a lê do `REGISTRY` real — para que esta função continue
 * pura e comparável em teste; o ancoramento no call site de produção é
 * responsabilidade do `proposer.ts`, que NÃO aceita catálogo alternativo.
 */
export function encontrarToolExistente(args: {
  texto: string;
  catalogo: readonly string[];
}): string | null {
  const alvo = ` ${normalizarTexto(args.texto)} `;

  for (const nome of args.catalogo) {
    const comEspacos = ` ${normalizarTexto(nome)} `;
    if (comEspacos.trim().length === 0) continue;
    if (alvo.includes(comEspacos)) return nome;
  }

  const esboco = esbocarNomeDeTool(args.texto);
  if (esboco && args.catalogo.includes(esboco)) return esboco;

  return null;
}
