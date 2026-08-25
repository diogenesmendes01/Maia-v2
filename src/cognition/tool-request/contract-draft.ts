/**
 * #636 — o RASCUNHO do contrato Zod, derivado de evidência.
 *
 * É a peça que dá valor ao pedido: transforma "o agente não conseguiu" em algo
 * que um dev avalia sem reconstruir o contexto. E é a peça que mais precisa de
 * disciplina, porque é a que mais se parece com código de produção.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DERIVADO, NUNCA IMAGINADO
 * ─────────────────────────────────────────────────────────────────────────────
 * Os campos saem das ocorrências: `attempted_args` (o que o agente TENTOU
 * passar) e `expected_output` (o que ele esperava de volta), gravados em
 * `agent_capability_gap_observations`. O tipo Zod é INFERIDO do tipo JSON
 * observado; `required` é `true` só quando a chave apareceu em TODAS as
 * ocorrências que trouxeram argumentos.
 *
 * Quando nenhuma ocorrência trouxe argumentos, o rascunho fica com `inputs: []`
 * e `completeness: 'name_only'`, e o `zod_source` DIZ isso num comentário. A
 * alternativa — inventar `z.object({ contexto: z.string() })` — pareceria mais
 * completa e valeria menos: o dev desenharia contra um contrato que ninguém
 * observou, e o número de ocorrências deixaria de significar alguma coisa.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O `zod_source` É TEXTO
 * ─────────────────────────────────────────────────────────────────────────────
 * Ele é renderizado, guardado e mostrado. Nunca `eval`, nunca `new Function`,
 * nunca `import()`, nunca entrada do registro de tools. O cabeçalho
 * `MARCADOR_DE_RASCUNHO` é obrigatório (o Zod de `ContratoRascunhoSchema` exige
 * `startsWith`) para que a marcação sobreviva ao copiar-e-colar do trecho para
 * fora do JSON.
 */
import type { AgentCapabilityGapObservation } from '@/db/schema.js';
import {
  MARCADOR_DE_RASCUNHO,
  type CampoDoContrato,
  type ContratoRascunho,
} from './types.js';

/** Um objeto JSON simples — o único shape de que sabemos derivar campos. */
function comoObjeto(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return Object.keys(o).length > 0 ? o : null;
}

/**
 * A expressão Zod para o tipo JSON observado.
 *
 * Conservador de propósito: `z.number().int()` só quando o valor observado é
 * inteiro, e nada de `.min()`/`.max()`/`.email()` — inferir restrição de uma
 * amostra produziria um contrato mais apertado do que a evidência sustenta, e
 * o dev não teria como saber que o aperto foi palpite nosso.
 */
export function inferirZod(valor: unknown): string {
  if (valor === null) return 'z.unknown().nullable()';
  if (typeof valor === 'string') return 'z.string()';
  if (typeof valor === 'boolean') return 'z.boolean()';
  if (typeof valor === 'number') {
    return Number.isInteger(valor) ? 'z.number().int()' : 'z.number()';
  }
  if (Array.isArray(valor)) return 'z.array(z.unknown())';
  if (typeof valor === 'object') return 'z.object({}).passthrough()';
  return 'z.unknown()';
}

/**
 * Une as chaves observadas num conjunto de campos.
 *
 * Ordenação determinística (mais observadas primeiro, empate por nome): duas
 * rodadas sobre as mesmas ocorrências produzem o MESMO rascunho, o que é o que
 * permite comparar duas gerações e ver que nada mudou.
 *
 * Conflito de tipo entre ocorrências (a chave veio `string` numa e `number`
 * noutra) resolve para `z.unknown()` — dizer "não sabemos" é honesto; escolher
 * o tipo da última ocorrência seria arbitrário e silencioso.
 */
export function derivarCampos(amostras: readonly unknown[]): CampoDoContrato[] {
  const objetos = amostras.map(comoObjeto).filter((o): o is Record<string, unknown> => o !== null);
  if (objetos.length === 0) return [];

  const porChave = new Map<string, { observed_in: number; zods: Set<string> }>();
  for (const obj of objetos) {
    for (const [chave, valor] of Object.entries(obj)) {
      const atual = porChave.get(chave) ?? { observed_in: 0, zods: new Set<string>() };
      atual.observed_in += 1;
      atual.zods.add(inferirZod(valor));
      porChave.set(chave, atual);
    }
  }

  return [...porChave.entries()]
    .map(([name, info]) => ({
      name,
      zod: info.zods.size === 1 ? [...info.zods][0]! : 'z.unknown()',
      required: info.observed_in === objetos.length,
      observed_in: info.observed_in,
    }))
    .sort((a, b) => b.observed_in - a.observed_in || a.name.localeCompare(b.name));
}

/** `consultar_estoque` → `consultarEstoque`. Identificador TS válido. */
function paraCamelCase(nome: string): string {
  return nome.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function renderizarObjeto(campos: readonly CampoDoContrato[], vazio: string): string {
  if (campos.length === 0) return `z.object({\n  ${vazio}\n})`;
  const linhas = campos.map((c) => {
    const expr = c.required ? c.zod : `${c.zod}.optional()`;
    return `  ${c.name}: ${expr}, // observado em ${c.observed_in} ocorrência(s)`;
  });
  return `z.object({\n${linhas.join('\n')}\n})`;
}

/**
 * Renderiza o rascunho como fonte TypeScript legível. TEXTO INERTE — ver o
 * cabeçalho deste arquivo.
 */
export function renderizarZodSource(args: {
  proposed_tool_name: string;
  inputs: readonly CampoDoContrato[];
  outputs: readonly CampoDoContrato[];
  ocorrencias: number;
  gap_id: string;
}): string {
  const base = paraCamelCase(args.proposed_tool_name);
  return [
    MARCADOR_DE_RASCUNHO,
    '// Rascunho gerado pela Maia a partir de ' +
      `${args.ocorrencias} ocorrência(s) do gap ${args.gap_id}.`,
    '// NENHUMA tool foi registrada, instalada ou executada por causa deste texto.',
    '// O caminho de uma tool nova continua sendo o normal: código revisado,',
    '// contrato Zod, classe de risco e aprovação.',
    '',
    `// tool proposta: ${args.proposed_tool_name}`,
    `const ${base}InputProposto = ${renderizarObjeto(
      args.inputs,
      '// entradas NÃO OBSERVADAS — nenhuma ocorrência registrou os argumentos tentados.',
    )};`,
    '',
    `const ${base}OutputProposto = ${renderizarObjeto(
      args.outputs,
      '// saídas NÃO OBSERVADAS — nenhuma ocorrência registrou o retorno esperado.',
    )};`,
  ].join('\n');
}

/**
 * Monta o rascunho completo. `proposed_tool_name` chega pronto de
 * `esbocarNomeDeTool` (e já foi conferido contra o registro real de tools pelo
 * `proposer.ts` — este módulo não decide se a tool existe).
 */
export function construirRascunhoDeContrato(args: {
  proposed_tool_name: string;
  gap_id: string;
  observacoes: readonly AgentCapabilityGapObservation[];
}): ContratoRascunho {
  const inputs = derivarCampos(args.observacoes.map((o) => o.attempted_args));
  const outputs = derivarCampos(args.observacoes.map((o) => o.expected_output));

  const completeness: ContratoRascunho['completeness'] =
    inputs.length > 0 && outputs.length > 0
      ? 'inputs_and_outputs_observed'
      : inputs.length > 0 || outputs.length > 0
        ? 'partially_observed'
        : 'name_only';

  return {
    proposed_tool_name: args.proposed_tool_name,
    completeness,
    inputs,
    outputs,
    zod_source: renderizarZodSource({
      proposed_tool_name: args.proposed_tool_name,
      inputs,
      outputs,
      ocorrencias: args.observacoes.length,
      gap_id: args.gap_id,
    }),
  };
}
