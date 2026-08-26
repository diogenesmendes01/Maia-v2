/**
 * #638 (fatia C da épica #471) — O FECHAMENTO DO CICLO: a tool passou a
 * existir, o gap fecha, e o agente que pediu descobre que agora pode.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O GAP FECHA POR FATO, NÃO POR CAIXA MARCADA
 * ─────────────────────────────────────────────────────────────────────────────
 * A pergunta "a tool foi registrada?" é respondida por `availability.ts`, que
 * lê os DOIS lados do estado real — o nome existe no registro vivo de tools E
 * está concedido a este tenant+agent. Nenhuma rota do console escreve
 * `resolved_at`; nenhuma marcação humana entra nesta conta. Se o dono fechar a
 * issue no GitHub sem a tool existir, o gap continua aberto — e é o certo.
 *
 * O `WHERE resolved_at IS NULL` do `resolverGap` é o que torna isto idempotente
 * sob cron: a segunda passada não colhe linha, e por isso NÃO reaudita nem
 * reavisa. "Fechei agora" e "já estava fechado" são fatos diferentes e o código
 * os distingue pela linha devolvida, não por uma releitura que poderia correr.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A NOTIFICAÇÃO AO AGENTE — o que é, e o que ela NÃO promete
 * ─────────────────────────────────────────────────────────────────────────────
 * O aviso é uma LINHA em `tool_request_notifications` (qual tool, por causa de
 * qual gap, com que evidência, quando) mais uma ação de auditoria. A ENTREGA
 * acontece no turno seguinte: o gap resolvido sai do bloco de limitações do
 * prompt — ele parava de dizer "isto eu não consigo" só por isso — e entra num
 * bloco novo que diz, em primeira pessoa, que a capacidade passou a existir
 * (ver `buildCapacidadeAdquiridaSection` em `src/agent/prompt-builder.ts`).
 *
 * O que isto NÃO é: um recibo de entrega por turno. Não gravamos "o agente leu
 * o aviso no turno X". O que é auditável é que o aviso foi EMITIDO, e que o
 * prompt daquele agente passa a carregá-lo — o segundo fato é provado por
 * teste sobre o prompt de produção, não por inspeção. Dito aqui para que
 * ninguém leia "notificação auditada" como mais do que é.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O GUARDRAIL
 * ─────────────────────────────────────────────────────────────────────────────
 * **O agente especifica; humano implementa e instala.** Este módulo LÊ o
 * registro e o grant; não escreve nem um nem outro. Ele fecha um gap e escreve
 * um aviso — duas linhas de dado, nenhuma instalação. A invariante de runtime
 * do guardrail roda este caminho e exige, depois dele, que o grant do agente
 * continue exatamente o semeado e que nenhuma tool viva esteja fora do catálogo
 * committado.
 */
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import {
  capabilityGapsRepo,
  toolRequestAggregatesRepo,
  toolRequestNotificationsRepo,
} from '@/db/repositories.js';
import { catalogoDisponivelParaAgente, toolQueFechaOGap } from './availability.js';

/** O `tipo` de gap que esta fatia fecha. Os outros não pedem ferramenta. */
export const TIPO_DE_GAP = 'tool';

export interface ResultadoDoFechamento {
  /** Gaps abertos avaliados nesta passada. */
  avaliados: number;
  /** Gaps que passaram a ter a ferramenta disponível e foram fechados AGORA. */
  fechados: number;
  /** Avisos ao agente criados AGORA (nunca mais de um por gap). */
  avisados: number;
}

/**
 * Fecha, no escopo de tenant/agent já aberto pelo chamador, todo gap de tool
 * cuja ferramenta passou a existir E a estar concedida.
 */
export async function fecharGapsComFerramentaDisponivel(): Promise<ResultadoDoFechamento> {
  const abertos = await capabilityGapsRepo.listAbertosPorTipo(TIPO_DE_GAP);
  if (abertos.length === 0) return { avaliados: 0, fechados: 0, avisados: 0 };

  const disponibilidade = await catalogoDisponivelParaAgente();

  // Os nomes que a TRIAGEM propôs, por gap. Um dev que siga a sugestão da issue
  // produz exatamente um desses nomes, e ele pode não aparecer no texto do gap.
  // Uma leitura por agregado do escopo — não uma por gap.
  const nomesPorGap = new Map<string, string[]>();
  const agregadoPorGap = new Map<string, string>();
  for (const agregado of await toolRequestAggregatesRepo.listarDoEscopo()) {
    const nomes = [
      agregado.proposed_tool_name,
      ...(Array.isArray(agregado.nomes_propostos) ? (agregado.nomes_propostos as string[]) : []),
    ];
    for (const membro of await toolRequestAggregatesRepo.membrosAtivos(agregado.id)) {
      nomesPorGap.set(membro.gap_id, nomes);
      agregadoPorGap.set(membro.gap_id, agregado.id);
    }
  }

  let fechados = 0;
  let avisados = 0;

  for (const gap of abertos) {
    const tool = toolQueFechaOGap({
      capability_description: gap.capability_description,
      nomes_extras: nomesPorGap.get(gap.id) ?? [],
      disponibilidade,
    });
    if (tool === null) continue;

    const motivo =
      `tool '${tool}' existe no registro e está concedida a este agente ` +
      `(verificado pelo monitor de fechamento, issue #638)`;
    const fechado = await capabilityGapsRepo.resolverGap({
      id: gap.id,
      reason: motivo,
      tool_name: tool,
    });
    // `null` = outra passada fechou antes desta. Não reauditar e não reavisar
    // é o ponto: um aviso duplicado é ruído no contexto de todo turno.
    if (!fechado) continue;
    fechados += 1;

    const evidencia = {
      tool_name: tool,
      tools_registradas: disponibilidade.registradas,
      tools_concedidas: disponibilidade.disponiveis.length,
      tem_grant: disponibilidade.tem_grant,
      verificado_em: new Date().toISOString(),
    };

    await audit({
      acao: 'tool_request_gap_closed',
      entidade_alvo: 'agent_capability_gaps',
      alvo_id: gap.id,
      metadata: {
        tool_name: tool,
        capability_description: gap.capability_description,
        aggregate_id: agregadoPorGap.get(gap.id) ?? null,
        frequency_score: gap.frequency_score,
        current_level: gap.current_level,
        evidencia,
        // O fechamento NÃO instalou nada — ele constatou. Dito na linha para
        // quem lê a auditoria sem ler o código.
        instalou_tool: false,
        concedeu_capability: false,
      },
    });

    const aviso = await toolRequestNotificationsRepo.avisar({
      gap_id: gap.id,
      aggregate_id: agregadoPorGap.get(gap.id) ?? null,
      tool_name: tool,
      evidencia,
    });
    if (aviso.criada) {
      avisados += 1;
      await audit({
        acao: 'tool_request_agent_notified',
        entidade_alvo: 'tool_request_notifications',
        alvo_id: aviso.linha?.id ?? null,
        metadata: {
          gap_id: gap.id,
          tool_name: tool,
          aggregate_id: agregadoPorGap.get(gap.id) ?? null,
          // A entrega acontece no prompt do turno seguinte; o que esta ação
          // registra é a EMISSÃO. Ver o cabeçalho deste arquivo.
          entrega: 'prompt_do_proximo_turno',
        },
      });
    }

    logger.info(
      { gap_id: gap.id, tool_name: tool, avisado: aviso.criada },
      'tool_request.gap_fechado',
    );
  }

  return { avaliados: abertos.length, fechados, avisados };
}
