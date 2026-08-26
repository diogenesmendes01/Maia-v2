/**
 * #638 (fatia C da épica #471) — O QUE VAI PARA O GITHUB, e o que NÃO vai.
 *
 * Este módulo é PURO: ele transforma um agregado de pedidos de ferramenta no
 * título, no corpo e na chave de idempotência da issue. Não lê configuração,
 * não toca em rede, não conhece credencial nenhuma — e é essa ausência que faz
 * o critério "credencial do GitHub não vaza para o payload da proposta" ser
 * estrutural em vez de disciplina: não existe token no alcance léxico deste
 * arquivo, então não há como um `${}` distraído colocá-lo no corpo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UMA ISSUE PODE SER PÚBLICA. O CORPO É ESCRITO SOB ESSA SUPOSIÇÃO.
 * ─────────────────────────────────────────────────────────────────────────────
 * O que ENTRA: a descrição da capacidade que faltou (é o pedido — sem ela a
 * issue não serve para nada), o rascunho de contrato com a marcação de
 * rascunho, os contadores de demanda, o estado da fusão e os `root_trace_id`
 * (UUID opaco, que só quem tem acesso ao console consegue resolver).
 *
 * O que NÃO entra, e por quê:
 *
 *   · `tenant_id` / `agent_id` em texto claro — "tenant:acme" num corpo de
 *     issue pública é vazamento de cliente por descuido de formato. A
 *     correlação existe pelo `idempotency_key`, que é HASH.
 *   · o texto livre de cada situação (`situations[].intent` / `.detail`) — sai
 *     de turno real e pode carregar nome, valor ou assunto do interlocutor. O
 *     dev que precisa dessas situações as lê no console, atrás de autenticação;
 *     o corpo diz explicitamente onde. É a mesma decisão de privacidade que a
 *     fatia A tomou para `attempted_args` (ver `types.ts`), levada até o fim.
 *   · qualquer credencial, de qualquer tipo — ver acima: não há como.
 *
 * A consequência aceita: a issue sozinha não permite reconstruir o caso de uso
 * em detalhe. Ela permite DECIDIR — o que falta, para quantos pedidos, com que
 * contrato imaginado — que é o que a triagem precisa entregar a um dev.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O GUARDRAIL VAI NO CORPO, EM PRIMEIRA PESSOA
 * ─────────────────────────────────────────────────────────────────────────────
 * **O agente especifica; humano implementa e instala.** Quem abre a issue lê,
 * logo no topo, que o bloco Zod é RASCUNHO e não contrato vigente — a mesma
 * marcação literal (`MARCADOR_DE_RASCUNHO`) que sobrevive ao copiar-e-colar do
 * trecho para dentro de um arquivo `.ts`. Aceitar cria uma issue: não registra
 * tool, não concede capability, não instala nada.
 */
import { createHash } from 'node:crypto';
import { MARCADOR_DE_RASCUNHO, TOOL_REQUEST_GUARDRAIL } from './types.js';

/**
 * O marcador que viaja no corpo da issue e permite RECONHECÊ-LA depois.
 *
 * Ele existe para uma janela específica: o processo morre entre a chamada que
 * criou a issue e a gravação do número dela. Na retentativa, o relayer procura
 * este marcador antes de criar — e adota em vez de duplicar. Sem ele, o crash
 * nessa janela abriria a segunda issue, que é justamente o que a issue #638
 * proíbe.
 */
export const MARCADOR_DE_PEDIDO = 'maia-tool-request-key:';

/** O label das issues abertas por esta triagem. É por ele que a busca filtra. */
export const LABEL_DO_PEDIDO = 'pedido-de-ferramenta';

/** Labels aplicadas à issue criada. `enhancement` casa com o resto do repo. */
export const LABELS_DA_ISSUE: readonly string[] = [LABEL_DO_PEDIDO, 'enhancement'];

/**
 * A CHAVE DETERMINÍSTICA do aceite.
 *
 * Determinística: mesmo escopo + mesmo agregado ⇒ mesma chave, em qualquer
 * processo, hoje e depois de um restart. É isso que permite (a) a UNIQUE do
 * banco recusar o segundo aceite e (b) o relayer reconhecer a própria issue.
 *
 * HASH, e não o escopo legível: a chave aparece numa issue que pode ser
 * pública. `sha256` truncado em 32 hex — 128 bits, folgadíssimo contra colisão
 * acidental, e curto o bastante para caber numa linha sem virar ruído visual.
 *
 * O prefixo de domínio (`maia.tool_request.v1`) impede que esta chave colida
 * com qualquer outra derivação de idempotência do projeto que use os mesmos
 * componentes, e o `v1` permite mudar a derivação sem reinterpretar o passado.
 */
export function chaveDeIdempotencia(args: {
  tenant_id: string;
  agent_id: string;
  aggregate_id: string;
}): string {
  return createHash('sha256')
    .update(`maia.tool_request.v1|${args.tenant_id}|${args.agent_id}|${args.aggregate_id}`)
    .digest('hex')
    .slice(0, 32);
}

/** O que o corpo precisa saber sobre o agregado. Só leitura, só o backend decidiu. */
export interface AgregadoParaIssue {
  readonly proposed_tool_name: string;
  readonly nomes_propostos: readonly string[];
  readonly member_count: number;
  readonly total_occurrences: number;
  readonly contract_state: string;
  readonly merged_contract_draft: unknown;
  readonly contract_conflicts: unknown;
  readonly first_member_at: Date;
  readonly last_member_at: Date;
  readonly metrica: string;
  readonly limiar: string;
  readonly assinatura_version: number;
}

/** O que o corpo precisa saber sobre o pedido representante. */
export interface PedidoParaIssue {
  readonly capability_description: string;
  readonly intent: string;
  readonly situacoes_totais: number;
  readonly situacoes_com_trace: number;
  readonly root_trace_ids: readonly string[];
}

/** Título curto e estável. Estável importa: ele identifica a issue na lista. */
export function tituloDaIssue(agregado: AgregadoParaIssue): string {
  return `feat(tools): ${agregado.proposed_tool_name} — pedido de ferramenta do agente`;
}

/** Uma linha `- campo: z.x()` por campo, ou a ausência dita em voz alta. */
function listarCampos(campos: unknown): string[] {
  if (!Array.isArray(campos) || campos.length === 0) {
    return ['- _(nenhum campo observado — ver `completeness` abaixo)_'];
  }
  return campos.map((c) => {
    const campo = c as { name?: unknown; zod?: unknown; required?: unknown; observed_in?: unknown };
    const obrigatorio = campo.required === true ? 'obrigatório' : 'opcional';
    return `- \`${String(campo.name)}\`: \`${String(campo.zod)}\` — ${obrigatorio}, observado em ${String(campo.observed_in)} ocorrência(s)`;
  });
}

/**
 * O CORPO da issue.
 *
 * Ele é montado NO ACEITE e gravado na linha de `tool_request_issues`; o
 * relayer envia exatamente este texto. Duas razões: o que o dono aceitou é o
 * que vai para o GitHub (o relayer não pode reescrever a spec entre o clique e
 * o envio), e o corpo vira evidência auditável mesmo se a chamada externa nunca
 * suceder.
 */
export function corpoDaIssue(args: {
  idempotency_key: string;
  agregado: AgregadoParaIssue;
  pedido: PedidoParaIssue;
}): string {
  const { agregado, pedido } = args;
  const rascunho = agregado.merged_contract_draft as
    | { zod_source?: unknown; completeness?: unknown; inputs?: unknown; outputs?: unknown }
    | null
    | undefined;

  const linhas: string[] = [];

  linhas.push('> **O agente especifica; humano implementa e instala.**');
  linhas.push('>');
  linhas.push(
    '> Esta issue foi aberta pela triagem de pedidos de ferramenta do console. ' +
      'Aceitar um pedido **cria esta issue e nada mais**: nenhuma tool foi ' +
      'registrada, nenhuma capability foi concedida, nada foi instalado. O bloco ' +
      'Zod abaixo é **rascunho**, derivado do que o agente observou — não é ' +
      'contrato vigente e não descreve nenhuma tool existente.',
  );
  linhas.push('');
  linhas.push(`## O que faltou`);
  linhas.push('');
  linhas.push(pedido.capability_description);
  linhas.push('');
  linhas.push(`## Demanda`);
  linhas.push('');
  linhas.push(`- **Pedidos agrupados:** ${agregado.member_count}`);
  linhas.push(`- **Ocorrências somadas:** ${agregado.total_occurrences}`);
  linhas.push(
    `- **Janela:** ${agregado.first_member_at.toISOString()} → ${agregado.last_member_at.toISOString()}`,
  );
  linhas.push(
    `- **Situações registradas:** ${pedido.situacoes_totais} (${pedido.situacoes_com_trace} com trace resolvido)`,
  );
  linhas.push(
    `- **Agrupamento:** métrica \`${agregado.metrica}\`, limiar ${agregado.limiar}, assinatura v${agregado.assinatura_version}`,
  );
  linhas.push('');
  linhas.push(`## Contrato imaginado (RASCUNHO — não é contrato vigente)`);
  linhas.push('');
  linhas.push(`- **Nome proposto:** \`${agregado.proposed_tool_name}\``);
  if (agregado.nomes_propostos.length > 1) {
    linhas.push(
      `- **Outros nomes que os pedidos propuseram:** ${agregado.nomes_propostos
        .map((n) => `\`${n}\``)
        .join(', ')}`,
    );
  }
  linhas.push(`- **Estado da fusão:** \`${agregado.contract_state}\``);

  if (agregado.contract_state === 'divergent') {
    linhas.push('');
    linhas.push(
      '> **Os pedidos agrupados discordam sobre o contrato.** Nenhum rascunho ' +
        'venceu e nenhum contrato fundido foi produzido — fundir contratos ' +
        'incompatíveis produziria uma spec que não descreve nenhum dos casos, e ' +
        'escolher um deles apagaria o outro por ordem de chegada. Os conflitos ' +
        'nomeados estão abaixo; a decisão é do dev.',
    );
    linhas.push('');
    linhas.push('```json');
    linhas.push(JSON.stringify(agregado.contract_conflicts, null, 2));
    linhas.push('```');
  } else {
    linhas.push(`- **Completude:** \`${String(rascunho?.completeness ?? 'desconhecida')}\``);
    linhas.push('');
    linhas.push('**Entradas observadas**');
    linhas.push('');
    linhas.push(...listarCampos(rascunho?.inputs));
    linhas.push('');
    linhas.push('**Saídas observadas**');
    linhas.push('');
    linhas.push(...listarCampos(rascunho?.outputs));
    linhas.push('');
    linhas.push('```ts');
    // O `zod_source` já começa com `MARCADOR_DE_RASCUNHO` — o CHECK do banco
    // (migração 129) recusa um rascunho fundido sem ele. O fallback existe para
    // o caso de um agregado antigo sem rascunho, e carrega a marcação na mão em
    // vez de emitir um bloco de código sem aviso.
    linhas.push(
      typeof rascunho?.zod_source === 'string'
        ? rascunho.zod_source
        : `${MARCADOR_DE_RASCUNHO}\n// (agregado sem rascunho de contrato)`,
    );
    linhas.push('```');
  }

  linhas.push('');
  linhas.push('## Caminho normal de uma tool nova');
  linhas.push('');
  linhas.push('- [ ] Contrato Zod (input/output) escrito e revisado por humano');
  linhas.push('- [ ] Classe de risco definida e política de escrita revisada');
  linhas.push('- [ ] Chave de idempotência, quando houver efeito externo');
  linhas.push('- [ ] Registrada no catálogo de tools + adicionada a um pack de domínio');
  linhas.push('- [ ] Concedida ao agente que pediu (`agent_tool_grants`)');
  linhas.push('');
  linhas.push(
    'O gap que originou este pedido fecha sozinho quando as duas últimas caixas ' +
      'estiverem marcadas de verdade: o monitor de fechamento verifica que a tool ' +
      'existe no registro **e** está concedida àquele agente, e só então marca a ' +
      'lacuna como resolvida e avisa o agente. Marcar caixa aqui não fecha nada.',
  );
  linhas.push('');
  linhas.push('## Onde estão as situações');
  linhas.push('');
  linhas.push(
    'O texto de cada situação sai de conversa real e **não** é reproduzido aqui — ' +
      'uma issue pode ser pública. Consulte a triagem no console ' +
      '(`/capabilities` → "Pedidos de ferramenta") para ver as ocorrências, os ' +
      'links de trace e a evidência completa.',
  );
  if (pedido.root_trace_ids.length > 0) {
    linhas.push('');
    linhas.push(
      `Traces de referência: ${pedido.root_trace_ids.map((t) => `\`${t}\``).join(', ')}`,
    );
  }
  linhas.push('');
  linhas.push('---');
  linhas.push('');
  linhas.push(
    `<!-- ${MARCADOR_DE_PEDIDO}${args.idempotency_key} -->`,
  );
  linhas.push(
    `_Gerado pela triagem de pedidos de ferramenta (issue #638). ${TOOL_REQUEST_GUARDRAIL}._`,
  );

  return linhas.join('\n');
}

/** `true` quando o corpo de uma issue carrega ESTE marcador. */
export function corpoTemMarcador(corpo: string | null | undefined, chave: string): boolean {
  if (typeof corpo !== 'string' || chave.length === 0) return false;
  return corpo.includes(`${MARCADOR_DE_PEDIDO}${chave}`);
}
