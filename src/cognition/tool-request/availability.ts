/**
 * #638 (fatia C da épica #471) — "A TOOL FOI REGISTRADA" É UM FATO
 * VERIFICÁVEL, e este módulo é onde ele é verificado.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O ELO MAIS FRÁGIL DA ÉPICA, E COMO ELE É SUSTENTADO
 * ─────────────────────────────────────────────────────────────────────────────
 * A issue #638 diz, com todas as letras: *"o gap fecha porque a capability
 * existe e está disponível para aquele tenant/agent, não porque alguém marcou
 * uma caixa no console"*. Por isso a pergunta é feita contra DOIS fatos
 * independentes, e os dois vêm do estado real:
 *
 *   1. **existe no código** — o nome é chave viva do registro de tools. O
 *      registro é montado a partir de arquivos committados e revisados; uma
 *      tool desligada por flag de configuração NÃO está nele, e portanto não
 *      conta como disponível (o agente de fato não pode chamá-la);
 *   2. **está concedida a ESTE tenant+agent** — o nome está no conjunto que
 *      `resolveGrantedToolNames` deriva do grant do agente (packs concedidos ∪
 *      tools concedidas ∪ o piso `baseline.core`, menos as negadas).
 *
 * Nenhuma marcação de console entra nessa conta. Não existe rota que escreva
 * "considere disponível".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESTE MÓDULO LÊ O GRANT. ELE NÃO O ESCREVE — E NÃO PODE PASSAR A ESCREVER.
 * ─────────────────────────────────────────────────────────────────────────────
 * A leitura de `agent_tool_grants` é o que torna a verificação honesta: sem
 * ela, "disponível" viraria "existe no repositório", e o gap de um cliente
 * fecharia por causa de uma tool que o agente dele não pode chamar.
 *
 * A escrita continua proibida, e a proibição é afirmada onde ela não depende de
 * texto: a invariante de runtime do guardrail
 * (`tests/integration/tool-request-guardrail-real-db.spec.ts`) roda o caminho
 * de fechamento inteiro e exige, DEPOIS dele, que o grant do agente continue
 * EXATAMENTE o semeado e que nenhuma tool viva esteja fora do catálogo
 * committado. Essa afirmação é absoluta e não tem fronteira de arquivo — ela
 * pega uma concessão escrita aqui, em `closure.ts`, ou em qualquer outro lugar.
 *
 * (A varredura ESTÁTICA do guardrail não alcança este arquivo, porque ele não é
 * importado por nenhum call site de geração/aprovação. Isso é uma cegueira
 * ASSUMIDA e escrita, não um descuido: um módulo que precisa LER o grant não
 * pode ser varrido por um padrão que proíbe o IDENTIFICADOR do repositório de
 * grants, e afrouxar o padrão para distinguir leitura de escrita enfraqueceria
 * a defesa nos arquivos onde ela morde de verdade.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COMO O NOME É CASADO — a simetria com a fatia A
 * ─────────────────────────────────────────────────────────────────────────────
 * O gap virou pedido de ferramenta porque `encontrarToolExistente` devolveu
 * `null` contra o catálogo. Ele fecha quando a MESMA função devolve um nome —
 * agora contra o catálogo DISPONÍVEL a este agente. É a mesma regra
 * determinística, na direção oposta, e por isso não introduz um segundo
 * critério que pudesse discordar do primeiro.
 *
 * A consequência aceita: se o dev implementar a ferramenta com um nome que não
 * aparece na descrição do gap nem coincide com o nome proposto, o fechamento
 * NÃO acontece sozinho. O erro cai do lado barato — o gap continua aberto e um
 * humano o resolve — em vez do caro, que seria fechar o pedido errado por
 * casamento frouxo.
 */
import { REGISTRY } from '@/tools/_registry.js';
import { resolveGrantedToolNames } from '@/tools/grant-math.js';
import { agentToolGrantsRepo } from '@/db/repositories.js';
import { encontrarToolExistente } from './existing-tool.js';

/** O que o monitor precisa saber, e que vira `evidencia` na linha do aviso. */
export interface Disponibilidade {
  /** Nomes que existem no código E estão concedidos a este agente. */
  readonly disponiveis: readonly string[];
  /** Total de tools vivas no registro — contexto para quem lê a evidência. */
  readonly registradas: number;
  /** `false` quando o agente não tem sequer linha de grant. */
  readonly tem_grant: boolean;
}

/**
 * O catálogo REALMENTE disponível ao agente do contexto atual.
 *
 * Uma leitura por escopo, reaproveitada para todos os gaps daquele agente — o
 * monitor não repete a consulta por gap.
 */
export async function catalogoDisponivelParaAgente(): Promise<Disponibilidade> {
  const registradas = Object.keys(REGISTRY);
  const grant = await agentToolGrantsRepo.findForCurrentAgent();
  if (!grant) {
    return { disponiveis: [], registradas: registradas.length, tem_grant: false };
  }
  const concedidas = resolveGrantedToolNames({
    granted_packs: grant.granted_packs,
    granted_tools: grant.granted_tools,
    denied_tools: grant.denied_tools,
  });
  const vivas = new Set(registradas);
  return {
    disponiveis: [...concedidas].filter((n) => vivas.has(n)).sort(),
    registradas: registradas.length,
    tem_grant: true,
  };
}

/**
 * A tool que cobre este gap e JÁ está disponível a este agente — ou `null`.
 *
 * `nomes_extras` são os nomes que a triagem propôs (o do agregado e os das
 * variantes dos membros). Eles entram porque um dev que siga o nome sugerido
 * pela issue produz exatamente esse nome, e ele pode não aparecer no texto do
 * gap.
 */
export function toolQueFechaOGap(args: {
  capability_description: string;
  nomes_extras: readonly string[];
  disponibilidade: Disponibilidade;
}): string | null {
  const disponiveis = new Set(args.disponibilidade.disponiveis);
  for (const nome of args.nomes_extras) {
    if (disponiveis.has(nome)) return nome;
  }
  return encontrarToolExistente({
    texto: args.capability_description,
    catalogo: args.disponibilidade.disponiveis,
  });
}
