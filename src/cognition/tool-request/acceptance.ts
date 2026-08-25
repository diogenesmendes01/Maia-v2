/**
 * #638 (fatia C da épica #471) — ACEITAR um pedido de ferramenta.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O QUE "ACEITAR" FAZ, INTEIRO
 * ─────────────────────────────────────────────────────────────────────────────
 * Reserva UMA linha em `tool_request_issues`, com o título e o corpo da issue
 * já montados, e audita a decisão. Só isso.
 *
 * O que ele NÃO faz, e não pode passar a fazer:
 *
 *   · **não registra tool** — o `TOOL_CATALOG` committado continua sendo a
 *     única origem de tool viva;
 *   · **não concede capability** — `agent_tool_grants` não é tocado por
 *     nenhum caminho desta fatia;
 *   · **não fecha o gap** — fechar é fato verificável, e quem o verifica é o
 *     monitor (`closure.ts`), lendo o estado real da capability;
 *   · **não fala com o GitHub** — a chamada externa é do relayer, no `runtime`,
 *     que é o único processo com a credencial.
 *
 * O guardrail da épica, repetido porque este é o arquivo onde ele seria
 * quebrado: **o agente especifica; humano implementa e instala.** O botão
 * "aceitar" cria uma issue. Tool nova segue o caminho normal — código revisado,
 * contrato Zod, classe de risco, aprovação.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IDEMPOTÊNCIA: A DECISÃO É DO BANCO
 * ─────────────────────────────────────────────────────────────────────────────
 * "Aceitar duas vezes cria UMA issue" não é implementado por um `if` que
 * consulta antes de inserir — essa janela é exatamente onde dois cliques
 * rápidos caem. É implementado pela UNIQUE (tenant_id, agent_id, aggregate_id)
 * de `tool_request_issues`, com `ON CONFLICT DO NOTHING`: o segundo aceite não
 * colhe linha, lê a que existe e devolve `ja_aceito`. Vale para duas abas, dois
 * processos e duas réplicas.
 *
 * A chave de idempotência é DETERMINÍSTICA (`chaveDeIdempotencia`) e viaja no
 * corpo da issue, o que estende a idempotência para além do banco: o relayer
 * reconhece uma issue que ele mesmo já abriu antes de um crash.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESTE MÓDULO NÃO CONHECE CREDENCIAL, E É PROPOSITAL
 * ─────────────────────────────────────────────────────────────────────────────
 * `repo_slug` entra por PARÂMETRO, vindo de quem chama. Não há import de
 * configuração aqui — nem do runtime, nem do console. Um token não tem como
 * entrar no corpo da issue nem no log deste arquivo porque não existe no seu
 * alcance léxico.
 */
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import {
  toolRequestAggregatesRepo,
  toolRequestIssuesRepo,
  capabilityProposalsRepo,
} from '@/db/repositories.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import type { ToolRequestAggregate, ToolRequestIssue } from '@/db/schema.js';
import { ToolRequestSpecSchema } from './types.js';
import {
  chaveDeIdempotencia,
  corpoDaIssue,
  tituloDaIssue,
  type AgregadoParaIssue,
  type PedidoParaIssue,
} from './issue-body.js';

export type ResultadoDoAceite =
  /** Reserva criada agora. O relayer vai abrir a issue. */
  | { ok: true; resultado: 'aceito'; issue: ToolRequestIssue }
  /** Já havia reserva para este agregado. NENHUMA segunda issue será aberta. */
  | { ok: true; resultado: 'ja_aceito'; issue: ToolRequestIssue }
  | {
      ok: false;
      motivo:
        | 'agregado_nao_encontrado'
        | 'proposta_nao_encontrada'
        | 'spec_ilegivel'
        | 'repositorio_nao_configurado';
      detalhe?: string;
    };

/** O que o corpo precisa do agregado, extraído sem recalcular nada. */
function paraIssue(agregado: ToolRequestAggregate): AgregadoParaIssue {
  return {
    proposed_tool_name: agregado.proposed_tool_name,
    nomes_propostos: Array.isArray(agregado.nomes_propostos)
      ? (agregado.nomes_propostos as string[])
      : [],
    member_count: agregado.member_count,
    total_occurrences: agregado.total_occurrences,
    contract_state: agregado.contract_state,
    merged_contract_draft: agregado.merged_contract_draft,
    contract_conflicts: agregado.contract_conflicts,
    first_member_at: agregado.first_member_at,
    last_member_at: agregado.last_member_at,
    metrica: agregado.metrica,
    limiar: agregado.limiar,
    assinatura_version: agregado.assinatura_version,
  };
}

/**
 * ACEITA o pedido representado por `aggregate_id`, no escopo do contexto de
 * tenant/agent já aberto pelo chamador.
 *
 * `repo_slug` vazio é RECUSA explícita, não default: abrir issue é efeito
 * externo, e um destino implícito para efeito externo é como o pedido de um
 * cliente acaba no repositório de outro.
 */
export async function aceitarPedidoDeFerramenta(args: {
  aggregate_id: string;
  repo_slug: string;
  accepted_by: string;
}): Promise<ResultadoDoAceite> {
  if (args.repo_slug.trim().length === 0) {
    return { ok: false, motivo: 'repositorio_nao_configurado' };
  }

  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();

  // O agregado é lido ESCOPADO — `id` nunca é fronteira de isolamento
  // (#367/#368). Um id vazado de outro tenant não colhe linha, e o aceite
  // devolve "não encontrado" em vez de agir sobre o pedido alheio.
  const agregado = await toolRequestAggregatesRepo.findById(args.aggregate_id);
  if (!agregado) return { ok: false, motivo: 'agregado_nao_encontrado' };

  const proposta = await capabilityProposalsRepo.getById(agregado.representative_proposal_id);
  if (!proposta) return { ok: false, motivo: 'proposta_nao_encontrada' };

  // O spec do representante é a fonte da descrição e das situações. Fail-closed
  // no formato: um spec que o schema não lê não vira corpo de issue — um dev
  // receberia um pedido montado sobre um documento que ninguém validou.
  const spec = ToolRequestSpecSchema.safeParse(proposta.proposed_spec);
  if (!spec.success) {
    return { ok: false, motivo: 'spec_ilegivel', detalhe: spec.error.message };
  }

  const idempotency_key = chaveDeIdempotencia({
    tenant_id,
    agent_id,
    aggregate_id: agregado.id,
  });

  const pedido: PedidoParaIssue = {
    capability_description: proposta.description,
    intent: spec.data.intent,
    situacoes_totais: spec.data.situations.length,
    situacoes_com_trace: spec.data.situations.filter((s) => s.trace_resolved).length,
    // Só os ids OPACOS, e só os que resolvem. Um UUID não diz nada a quem lê a
    // issue e diz tudo a quem tem o console — que é a divisão certa.
    root_trace_ids: [
      ...new Set(
        spec.data.situations
          .filter((s) => s.trace_resolved && s.root_trace_id !== null)
          .map((s) => s.root_trace_id as string),
      ),
    ].slice(0, 5),
  };

  const { linha, ja_existia } = await toolRequestIssuesRepo.reservar({
    aggregate_id: agregado.id,
    idempotency_key,
    repo_slug: args.repo_slug,
    title: tituloDaIssue(paraIssue(agregado)),
    body: corpoDaIssue({ idempotency_key, agregado: paraIssue(agregado), pedido }),
    accepted_by: args.accepted_by,
  });

  // Invariante #4 — decisão de governança auditada, inclusive a que NÃO teve
  // efeito. Um segundo clique que não abre issue é um fato tão relevante quanto
  // o primeiro: é a prova de que a idempotência mordeu.
  await audit({
    acao: ja_existia ? 'tool_request_accept_duplicado' : 'tool_request_accepted',
    entidade_alvo: 'tool_request_issues',
    alvo_id: linha.id,
    metadata: {
      aggregate_id: agregado.id,
      representative_proposal_id: agregado.representative_proposal_id,
      proposed_tool_name: agregado.proposed_tool_name,
      member_count: agregado.member_count,
      total_occurrences: agregado.total_occurrences,
      contract_state: agregado.contract_state,
      repo_slug: args.repo_slug,
      idempotency_key,
      accepted_by: args.accepted_by,
      issue_status: linha.status,
      issue_number: linha.issue_number,
      // Dito na linha de auditoria para que ninguém precise ler código para
      // saber o que o aceite fez: ele NÃO instala.
      instalou_tool: false,
      concedeu_capability: false,
    },
  });

  logger.info(
    {
      aggregate_id: agregado.id,
      issue_row_id: linha.id,
      ja_existia,
      proposed_tool_name: agregado.proposed_tool_name,
    },
    ja_existia ? 'tool_request.accept_duplicado' : 'tool_request.accepted',
  );

  return ja_existia
    ? { ok: true, resultado: 'ja_aceito', issue: linha }
    : { ok: true, resultado: 'aceito', issue: linha };
}
