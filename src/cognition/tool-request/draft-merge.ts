/**
 * #637 (fatia B da épica #471) — O QUE ACONTECE COM O RASCUNHO ZOD QUANDO DOIS
 * PEDIDOS SE FUNDEM.
 *
 * A issue põe três opções na mesa: um vence, os dois viram variantes, ou o
 * contrato é remarcado como indefinido. A política desta fatia é:
 *
 *   **NENHUM VENCE. NUNCA.**
 *
 *   · Rascunhos COMPATÍVEIS → UNIÃO. Nenhum campo é descartado; `observed_in`
 *     soma; `required` só sobrevive quando o campo é obrigatório em TODOS.
 *   · Rascunhos INCOMPATÍVEIS → o agregado é marcado `divergent`, NÃO produz
 *     rascunho fundido nenhum, e os dois (ou N) rascunhos ficam lado a lado
 *     como VARIANTES. O contador continua contando — a demanda é real —, mas o
 *     contrato fica explicitamente indefinido, esperando decisão humana.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE "UM VENCE" ESTÁ FORA
 * ─────────────────────────────────────────────────────────────────────────────
 * "Um vence" apaga o contrato do perdedor sem deixar rastro no documento que o
 * dev vai ler. E o perdedor é escolhido por ordem de chegada — quem pediu
 * primeiro, ou quem pediu por último —, que não é evidência de nada. O dev
 * receberia um contrato que descreve um dos casos e um contador que promete N,
 * sem nenhum sinal de que os outros N−1 diziam outra coisa.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE "FUNDIR DE QUALQUER JEITO" ESTÁ FORA
 * ─────────────────────────────────────────────────────────────────────────────
 * Está na própria issue: fundir dois contratos incompatíveis produz uma spec
 * que não descreve nenhum dos dois casos. Se `competencia` é `z.string()` num
 * pedido e `z.number().int()` no outro, escolher um dos dois é chutar, e
 * escrever `z.unknown()` seria dizer "não sabemos" — mas dentro de um documento
 * que, no resto, afirma saber. A honestidade aqui é ADMITIR A DIVERGÊNCIA no
 * nível do agregado, não maquiá-la no nível do campo.
 *
 * (Note a diferença com `derivarCampos` da fatia A, que resolve conflito de
 * tipo ENTRE OCORRÊNCIAS DO MESMO GAP para `z.unknown()`. Ali as duas amostras
 * são o mesmo pedido visto duas vezes, e "não sabemos o tipo" é a leitura certa.
 * Aqui as amostras são PEDIDOS DIFERENTES que a similaridade juntou — e o que
 * o conflito sugere é que talvez não devessem ter sido juntados. Colapsar isso
 * em `z.unknown()` esconderia a única pista de que o agrupamento errou.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O QUE CONTA COMO INCOMPATÍVEL
 * ─────────────────────────────────────────────────────────────────────────────
 * Um campo com o MESMO NOME e expressão Zod DIFERENTE, no mesmo lado (entrada
 * ou saída). Só isso.
 *
 * O que NÃO é incompatibilidade, e por quê:
 *   · nome de tool proposto diferente — é o caso normal do agrupamento, e o
 *     nome alternativo é preservado no agregado como alias;
 *   · um campo existir num rascunho e não no outro — é evidência parcial, e a
 *     união resolve marcando o campo como opcional;
 *   · `required` diferente para o mesmo campo com o mesmo tipo — idem;
 *   · `completeness` diferente — um rascunho `name_only` não conflita com
 *     nada; ele simplesmente não acrescenta campo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TEXTO INERTE, AINDA
 * ─────────────────────────────────────────────────────────────────────────────
 * O rascunho fundido continua sendo TEXTO. Nada aqui avalia, registra ou
 * instala. O `zod_source` fundido carrega o mesmo `MARCADOR_DE_RASCUNHO` e
 * ganha uma linha a mais dizendo de quantos pedidos ele é a união — a marcação
 * de três camadas da fatia A permanece intacta e não é enfraquecida por esta.
 */
import { renderizarZodSource } from './contract-draft.js';
import {
  ContratoRascunhoSchema,
  type CampoDoContrato,
  type ContratoRascunho,
} from './types.js';

/**
 * O estado do contrato de um agregado.
 *
 *   · `single` ...... um pedido só; o contrato é o dele, intocado.
 *   · `consistent` .. N pedidos sem conflito; o contrato é a UNIÃO.
 *   · `divergent` ... N pedidos com conflito; NÃO há contrato fundido.
 */
export type EstadoDoContrato = 'single' | 'consistent' | 'divergent';

export const ESTADOS_DE_CONTRATO: readonly EstadoDoContrato[] = [
  'single',
  'consistent',
  'divergent',
] as const;

/** Um conflito concreto, nomeado — nunca "os contratos divergem" e ponto. */
export interface ConflitoDeContrato {
  lado: 'input' | 'output';
  campo: string;
  /** As expressões Zod em disputa, ORDENADAS (determinismo na leitura). */
  zods: string[];
  /** Os pedidos que sustentam cada expressão, na mesma ordem de `zods`. */
  origens: string[][];
}

/** Um membro do agregado, do ponto de vista da fusão de rascunhos. */
export interface MembroParaFusao {
  /** Identificador legível do pedido de origem (proposal_id ou gap_id). */
  readonly origem: string;
  readonly rascunho: ContratoRascunho;
}

export interface ResultadoDaFusao {
  estado: EstadoDoContrato;
  /** `null` EXATAMENTE quando `estado === 'divergent'`. */
  rascunho: ContratoRascunho | null;
  conflitos: ConflitoDeContrato[];
  /** Todos os rascunhos originais, sempre — nenhum é descartado pela fusão. */
  variantes: MembroParaFusao[];
  /** Nomes de tool propostos pelos membros, únicos e ordenados. */
  nomes_propostos: string[];
}

function conflitosDeUmLado(
  membros: readonly MembroParaFusao[],
  lado: 'input' | 'output',
): ConflitoDeContrato[] {
  const porCampo = new Map<string, Map<string, string[]>>();
  for (const m of membros) {
    const campos = lado === 'input' ? m.rascunho.inputs : m.rascunho.outputs;
    for (const c of campos) {
      const zods = porCampo.get(c.name) ?? new Map<string, string[]>();
      zods.set(c.zod, [...(zods.get(c.zod) ?? []), m.origem]);
      porCampo.set(c.name, zods);
    }
  }
  const conflitos: ConflitoDeContrato[] = [];
  for (const [campo, zods] of [...porCampo.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (zods.size <= 1) continue;
    const ordenados = [...zods.keys()].sort();
    conflitos.push({
      lado,
      campo,
      zods: ordenados,
      origens: ordenados.map((z) => [...(zods.get(z) ?? [])].sort()),
    });
  }
  return conflitos;
}

/**
 * A união dos campos de um lado. Só é chamada quando NÃO há conflito naquele
 * lado, então toda ocorrência de um mesmo nome tem a mesma expressão Zod.
 *
 * `required` é conservador: só continua obrigatório o campo que aparece em
 * TODOS os membros e é obrigatório em todos. Um campo que um pedido não viu não
 * pode ser exigido do dev com base nos outros.
 */
function unirCampos(
  membros: readonly MembroParaFusao[],
  lado: 'input' | 'output',
): CampoDoContrato[] {
  const acc = new Map<
    string,
    { zod: string; observed_in: number; requiredEmTodos: boolean; presenteEm: number }
  >();
  for (const m of membros) {
    const campos = lado === 'input' ? m.rascunho.inputs : m.rascunho.outputs;
    for (const c of campos) {
      const atual = acc.get(c.name);
      if (atual) {
        atual.observed_in += c.observed_in;
        atual.requiredEmTodos = atual.requiredEmTodos && c.required;
        atual.presenteEm += 1;
      } else {
        acc.set(c.name, {
          zod: c.zod,
          observed_in: c.observed_in,
          requiredEmTodos: c.required,
          presenteEm: 1,
        });
      }
    }
  }
  return [...acc.entries()]
    .map(([name, info]) => ({
      name,
      zod: info.zod,
      required: info.requiredEmTodos && info.presenteEm === membros.length,
      observed_in: info.observed_in,
    }))
    .sort((a, b) => b.observed_in - a.observed_in || a.name.localeCompare(b.name));
}

function completude(
  inputs: readonly CampoDoContrato[],
  outputs: readonly CampoDoContrato[],
): ContratoRascunho['completeness'] {
  if (inputs.length > 0 && outputs.length > 0) return 'inputs_and_outputs_observed';
  if (inputs.length > 0 || outputs.length > 0) return 'partially_observed';
  return 'name_only';
}

/**
 * A POLÍTICA, executável.
 *
 * `membros[0]` é o REPRESENTANTE — é dele que sai o nome da tool no rascunho
 * fundido. Ser representante não dá voto no contrato: o representante não
 * "vence" conflito nenhum, e um conflito o leva a `divergent` como qualquer
 * outro. O papel dele é só nomear.
 *
 * `gap_id_do_representante` entra no cabeçalho do `zod_source` porque o
 * renderizador da fatia A o exige; ele identifica de qual pedido saiu o
 * nome, não de qual saiu o contrato.
 */
export function fundirRascunhos(args: {
  membros: readonly MembroParaFusao[];
  gap_id_do_representante: string;
}): ResultadoDaFusao {
  const membros = args.membros;
  if (membros.length === 0) {
    throw new Error('fundirRascunhos: nenhum membro — um agregado sem pedido não existe');
  }

  const nomes_propostos = [
    ...new Set(membros.map((m) => m.rascunho.proposed_tool_name)),
  ].sort();

  if (membros.length === 1) {
    return {
      estado: 'single',
      rascunho: membros[0]!.rascunho,
      conflitos: [],
      variantes: [...membros],
      nomes_propostos,
    };
  }

  const conflitos = [
    ...conflitosDeUmLado(membros, 'input'),
    ...conflitosDeUmLado(membros, 'output'),
  ];

  if (conflitos.length > 0) {
    // DIVERGENTE. Nenhum rascunho fundido é produzido — nem o do
    // representante, nem um "melhor esforço". Ver o cabeçalho: uma spec que
    // não descreve nenhum dos casos é pior que a ausência dela, porque o dev
    // não tem como saber que ela é um chute.
    return { estado: 'divergent', rascunho: null, conflitos, variantes: [...membros], nomes_propostos };
  }

  const inputs = unirCampos(membros, 'input');
  const outputs = unirCampos(membros, 'output');
  const nomeDoRepresentante = membros[0]!.rascunho.proposed_tool_name;
  const alternativos = nomes_propostos.filter((n) => n !== nomeDoRepresentante);

  const rascunho: ContratoRascunho = {
    proposed_tool_name: nomeDoRepresentante,
    completeness: completude(inputs, outputs),
    inputs,
    outputs,
    zod_source: renderizarZodSource({
      proposed_tool_name: nomeDoRepresentante,
      inputs,
      outputs,
      // O número que o dev precisa ver aqui é quantos PEDIDOS a união cobre.
      // O total de ocorrências vive no agregado, ao lado do contador.
      ocorrencias: membros.length,
      gap_id: args.gap_id_do_representante,
      notas: [
        `// #637 — UNIÃO de ${membros.length} pedidos agregados por similaridade;`,
        '// nenhum rascunho foi descartado e nenhum campo foi inventado.',
        ...(alternativos.length > 0
          ? [`// nomes também propostos para a mesma ferramenta: ${alternativos.join(', ')}`]
          : []),
      ],
    }),
  };

  // Fail-closed no formato, pelo mesmo motivo do `proposer.ts`: um rascunho que
  // o schema recusa NÃO é persistido como se fosse contrato. Aqui a recusa
  // degrada para `divergent` — o contador continua valendo, o contrato fica
  // indefinido — em vez de derrubar a agregação inteira.
  const validado = ContratoRascunhoSchema.safeParse(rascunho);
  if (!validado.success) {
    return {
      estado: 'divergent',
      rascunho: null,
      conflitos: [
        {
          lado: 'input',
          campo: '(rascunho fundido inválido)',
          zods: [validado.error.message],
          origens: [membros.map((m) => m.origem)],
        },
      ],
      variantes: [...membros],
      nomes_propostos,
    };
  }

  return { estado: 'consistent', rascunho: validado.data, conflitos: [], variantes: [...membros], nomes_propostos };
}
