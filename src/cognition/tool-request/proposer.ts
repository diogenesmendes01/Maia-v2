/**
 * #636 (fatia A da épica #471) — o CALL SITE de produção do pedido de ferramenta.
 *
 * Disparado pelo `gap-escalation-monitor` (`src/workers/gap-escalation-monitor.ts`)
 * quando o engine determinístico eleva um gap a `proposed`. Se — e só se — o gap
 * exige uma tool que NÃO EXISTE, este módulo monta a proposta estruturada e a
 * persiste em `capability_proposals` com `capability_type='tool_request'`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O GUARDRAIL — o que este arquivo NÃO faz, e por que está escrito aqui
 * ─────────────────────────────────────────────────────────────────────────────
 * **O agente especifica; humano implementa e instala.**
 *
 * Este módulo lê o registro de tools (`REGISTRY`) e NUNCA escreve nele. Ele não
 * chama `agentToolGrantsRepo`, não cria `agent_capabilities_*`, não avalia
 * `zod_source`, não instala nada. O produto é UMA LINHA de proposta: um
 * documento inerte que um humano lê, avalia e — se concordar — vira issue para
 * um dev. Tool nova segue o caminho normal: código revisado, contrato Zod,
 * classe de risco, aprovação.
 *
 * O import de `REGISTRY` abaixo é DE LEITURA e é o que ancora o teste do
 * guardrail: `tests/integration/tool-request-guardrail.spec.ts` fotografa
 * `Object.keys(REGISTRY)` e as linhas de `agent_tool_grants` antes e depois de
 * rodar esta função sobre um gap real, e exige que as duas fotos sejam iguais.
 * Como o teste importa ESTE módulo e ESTE `REGISTRY`, plugar um registro
 * automático em qualquer ponto do caminho deixa o teste vermelho, e apagar o
 * caminho de produção deixa o teste sem o que importar.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SEM LLM, DE PROPÓSITO
 * ─────────────────────────────────────────────────────────────────────────────
 * `capability-proposer.ts` chama Sonnet para escrever uma spec em prosa. Aqui
 * não há chamada de modelo: a decisão (gerar ou não) é determinística e o
 * conteúdo é DERIVADO de evidência persistida (as ocorrências do gap). Isso é o
 * invariante #3 no seu grau mais forte — o backend decide e o backend compõe —
 * e tem uma consequência prática: duas rodadas sobre a mesma evidência produzem
 * exatamente o mesmo rascunho, então uma proposta que mudou significa que a
 * EVIDÊNCIA mudou, não que o modelo teve outro dia.
 */
import { GapLevel } from '@/types/enums.js';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import {
  capabilityGapObservationsRepo,
  capabilityProposalsRepo,
} from '@/db/repositories.js';
import type { AgentCapabilityGap, AgentCapabilityGapObservation } from '@/db/schema.js';
// LEITURA. Ver "O GUARDRAIL" no cabeçalho: nada neste arquivo escreve aqui.
import { REGISTRY } from '@/tools/_registry.js';
import { encontrarToolExistente, esbocarNomeDeTool } from './existing-tool.js';
import { construirRascunhoDeContrato } from './contract-draft.js';
import {
  TOOL_REQUEST_CAPABILITY_TYPE,
  TOOL_REQUEST_CONTRACT_STATUS,
  TOOL_REQUEST_GUARDRAIL,
  TOOL_REQUEST_SPEC_KIND,
  TOOL_REQUEST_SPEC_VERSION,
  ToolRequestSpecSchema,
  type Situacao,
  type ToolRequestSpec,
} from './types.js';

/** Quantas ocorrências entram na proposta. Teto para o documento caber num olhar. */
const MAX_OBSERVACOES = 20;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

export type ToolRequestOutcome =
  | { ok: true; proposal_id: string; spec: ToolRequestSpec }
  | {
      ok: false;
      reason:
        | 'gap_nao_esta_proposed'
        | 'gap_nao_e_de_tool'
        | 'tool_ja_existe'
        | 'sem_ocorrencias'
        | 'sem_nome_derivavel'
        | 'spec_invalido'
        | 'repo_falhou';
      detail?: string;
    };

/** Os nomes de tool que EXISTEM no código. Leitura do registro real. */
function catalogoDeToolsExistentes(): string[] {
  return Object.keys(REGISTRY);
}

function montarSituacoes(
  observacoes: readonly AgentCapabilityGapObservation[],
  tracesResolvidos: ReadonlySet<string>,
): Situacao[] {
  return observacoes.map((o) => ({
    observed_at: o.observed_at.toISOString(),
    conversa_id: o.conversa_id,
    root_trace_id: o.root_trace_id,
    trace_id: o.trace_id,
    // `true` só quando o envelope existe NESTE tenant+agent. Ver
    // `resolveTraceIdsInScope`: um id de fora do escopo não vira link.
    trace_resolved: o.root_trace_id !== null && tracesResolvidos.has(o.root_trace_id),
    intent: o.intent,
    detail: o.detail,
  }));
}

/**
 * Gera (ou recusa gerar) o pedido de ferramenta para um gap.
 *
 * Cada `reason` de recusa é um FATO diferente, e o chamador registra qual foi:
 * "não gerei porque a tool já existe" e "não gerei porque não há ocorrência
 * registrada" pedem ações opostas do operador (conferir grant × conferir o
 * ledger de observações), e colapsar as duas num `false` mudo esconderia isso.
 */
export async function proposeToolRequestForGap(args: {
  gap: AgentCapabilityGap;
}): Promise<ToolRequestOutcome> {
  const gap = args.gap;

  // 1 · O engine determinístico é o único que decide QUANDO. Este módulo só
  //     age no topo da cadeia; um gap abaixo de `proposed` não vira pedido.
  if (gap.current_level !== GapLevel.PROPOSED) {
    return { ok: false, reason: 'gap_nao_esta_proposed' };
  }

  // 2 · Um gap de conhecimento ou de procedimento não é pedido de FERRAMENTA.
  if (gap.tipo !== 'tool') {
    return { ok: false, reason: 'gap_nao_e_de_tool', detail: gap.tipo };
  }

  const textoDoGap = [gap.capability_description, gap.contexto ?? ''].join(' ');

  // 3 · A tool já existe? Então não falta código — no máximo falta grant, e
  //     esse caminho é do dono, não de um dev. Ver `existing-tool.ts`.
  const existente = encontrarToolExistente({
    texto: textoDoGap,
    catalogo: catalogoDeToolsExistentes(),
  });
  if (existente) {
    return { ok: false, reason: 'tool_ja_existe', detail: existente };
  }

  const nomeProposto = esbocarNomeDeTool(gap.capability_description);
  if (!nomeProposto) {
    return { ok: false, reason: 'sem_nome_derivavel' };
  }

  // 4 · A evidência. Sem ocorrência registrada não há situação, não há janela e
  //     não há de onde derivar o contrato — o pedido seria a descrição genérica
  //     que a issue existe para substituir.
  const observacoes = await capabilityGapObservationsRepo.listForGap(
    gap.id,
    MAX_OBSERVACOES,
  );
  if (observacoes.length === 0) {
    return { ok: false, reason: 'sem_ocorrencias' };
  }

  const tracesResolvidos = await capabilityGapObservationsRepo.resolveTraceIdsInScope(
    observacoes.map((o) => o.root_trace_id).filter((v): v is string => v !== null),
  );

  const instantes = observacoes.map((o) => o.observed_at.getTime());
  const primeiro = Math.min(...instantes);
  const ultimo = Math.max(...instantes);

  const spec: ToolRequestSpec = {
    spec_kind: TOOL_REQUEST_SPEC_KIND,
    spec_version: TOOL_REQUEST_SPEC_VERSION,
    contract_status: TOOL_REQUEST_CONTRACT_STATUS,
    guardrail: TOOL_REQUEST_GUARDRAIL,
    gap_id: gap.id,
    intent: gap.capability_description,
    situations: montarSituacoes(observacoes, tracesResolvidos),
    frequency: {
      occurrences: observacoes.length,
      window_days: Math.round(((ultimo - primeiro) / MS_POR_DIA) * 100) / 100,
      first_observed_at: new Date(primeiro).toISOString(),
      last_observed_at: new Date(ultimo).toISOString(),
      gap_frequency_score: gap.frequency_score,
      gap_severity_score: gap.severity_score,
    },
    contract_draft: construirRascunhoDeContrato({
      proposed_tool_name: nomeProposto,
      gap_id: gap.id,
      observacoes,
    }),
  };

  // 5 · Fail-closed no formato: um spec que o schema recusa NÃO vira linha. O
  //     console de triagem (#638) vai ler isto; persistir um documento que ele
  //     não sabe abrir seria transformar um erro de programação em dívida.
  const validado = ToolRequestSpecSchema.safeParse(spec);
  if (!validado.success) {
    logger.warn(
      { gap_id: gap.id, erro: validado.error.message },
      'tool_request.spec_invalido',
    );
    return { ok: false, reason: 'spec_invalido', detail: validado.error.message };
  }

  try {
    const proposta = await capabilityProposalsRepo.create({
      gap_id: gap.id,
      capability_type: TOOL_REQUEST_CAPABILITY_TYPE,
      title: `Pedido de ferramenta: ${nomeProposto}`,
      description: gap.capability_description,
      proposed_spec: validado.data,
      motivation:
        `Lacuna recorrente sem tool disponível: ${observacoes.length} ocorrência(s) ` +
        `registrada(s). O agente especifica; humano implementa e instala.`,
      expected_impact:
        'Um dev avalia o pedido com intenção, situações reais, frequência e ' +
        'rascunho de contrato — sem reconstruir o contexto.',
      // Vazio de propósito: cenários de teste pertencem à tool que um humano
      // vier a implementar, e escrevê-los aqui sugeriria que esta proposta já
      // tem o que testar. Ela não tem: ela é o pedido, não a implementação.
      test_scenarios: [],
    });

    // Invariante #4 — decisão de governança auditada. O que a linha registra é
    // que a Maia PEDIU, com o nome que propôs e a evidência que usou; nada
    // sobre instalação, porque nada foi instalado.
    await audit({
      acao: 'tool_request_proposed',
      entidade_alvo: 'capability_proposals',
      alvo_id: proposta.id,
      metadata: {
        gap_id: gap.id,
        proposed_tool_name: nomeProposto,
        occurrences: observacoes.length,
        situations_with_trace: validado.data.situations.filter((s) => s.trace_resolved).length,
        completeness: validado.data.contract_draft.completeness,
        contract_status: TOOL_REQUEST_CONTRACT_STATUS,
      },
    });

    return { ok: true, proposal_id: proposta.id, spec: validado.data };
  } catch (e) {
    return {
      ok: false,
      reason: 'repo_falhou',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
