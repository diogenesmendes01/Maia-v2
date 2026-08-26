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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * #637 (fatia B) — AGREGAÇÃO ANTES DE CRIAR
 * ─────────────────────────────────────────────────────────────────────────────
 * A partir da fatia B, este call site pergunta PRIMEIRO se o pedido já existe
 * no escopo (`aggregation.ts`, passo 6) e só cria proposta quando não existe. A
 * ordem é o recurso: agregar depois de criar deixaria uma linha de
 * `capability_proposals` por pedido e transformaria a agregação numa etiqueta
 * em cima de duplicatas. Um pedido que se funde NÃO vira proposta — vira membro
 * do agregado, com o `proposed_spec` INTEIRO preservado em
 * `tool_request_aggregate_members.original_spec`, para que a fusão não possa
 * apagar a evidência do pedido original.
 *
 * O guardrail continua valendo palavra por palavra: agregar não registra tool,
 * não concede nada e não avalia `zod_source`.
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
import { decidirAgregacao, juntarAoAgregado } from './aggregation.js';
import {
  ASSINATURA_VERSION,
  LIMIAR_SIMILARIDADE,
  METRICA_SIMILARIDADE,
} from './similarity.js';
import { toolRequestAggregatesRepo } from '@/db/repositories.js';
import type { EstadoDoContrato } from './draft-merge.js';
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

/**
 * #637 — o desfecho de um pedido, agora com o AGRUPAMENTO junto.
 *
 * `resultado` diz o que aconteceu, e os três valores pedem leituras diferentes:
 *
 *   · `criado` ..... não havia pedido parecido no escopo; virou proposta nova e
 *                    representante de um agregado de 1.
 *   · `agregado` ... havia. NÃO foi criada proposta: o pedido entrou como
 *                    membro do agregado existente, e `proposal_id` é a do
 *                    REPRESENTANTE. É este o caso em que "N pedidos viram 1".
 *   · `ja_membro` .. este gap já era membro ativo. Rodar o worker de novo não
 *                    cria proposta nem incrementa contador — a idempotência é
 *                    do lado do dado, não da sorte de o cron não repetir.
 *
 * `spec` é SEMPRE o spec deste pedido, mesmo quando ele foi agregado — quem
 * chama precisa poder logar o que ESTE gap dizia, não o que o representante diz.
 */
export type ToolRequestOutcome =
  | {
      ok: true;
      resultado: 'criado' | 'agregado' | 'ja_membro';
      /** A proposta que representa o pedido. Em `agregado`, a do representante. */
      proposal_id: string;
      spec: ToolRequestSpec;
      /** `null` só quando a descrição não deixou token de conteúdo nenhum. */
      aggregate_id: string | null;
      member_id: string | null;
      /** O score que justificou a fusão. `null` quando não houve fusão. */
      similaridade: number | null;
      /** O contador do agregado depois deste pedido. */
      member_count: number;
      contract_state: EstadoDoContrato | null;
    }
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

  // 6 · #637 — ANTES de criar proposta, pergunte se este pedido já existe.
  //
  //     A ordem é o recurso. Se a proposta fosse criada primeiro e a agregação
  //     viesse depois, o backlog ganharia UMA LINHA POR PEDIDO e a agregação
  //     seria uma etiqueta em cima de duplicatas — exatamente o que a issue
  //     manda evitar. Decidindo antes, o pedido parecido NUNCA vira linha de
  //     `capability_proposals`: ele vira MEMBRO, com o spec inteiro preservado.
  let decisao;
  try {
    decisao = await decidirAgregacao({
      gap_id: gap.id,
      capability_description: gap.capability_description,
    });
  } catch (e) {
    return {
      ok: false,
      reason: 'repo_falhou',
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    // 6a · Já é membro ativo: nada a criar, nada a contar. Idempotência do lado
    //      do dado — duas passadas do cron sobre o mesmo gap não inflam o
    //      contador, que é o número que a issue existe para tornar significativo.
    if (decisao.decisao === 'ja_membro') {
      const agregado = await toolRequestAggregatesRepo.findById(decisao.aggregate_id);
      return {
        ok: true,
        resultado: 'ja_membro',
        proposal_id: agregado?.representative_proposal_id ?? '',
        spec: validado.data,
        aggregate_id: decisao.aggregate_id,
        member_id: null,
        similaridade: null,
        member_count: agregado?.member_count ?? 0,
        contract_state: (agregado?.contract_state as EstadoDoContrato | undefined) ?? null,
      };
    }

    // 6b · Achou pedido parecido. N vira 1: SEM proposta nova.
    if (decisao.decisao === 'funde') {
      const agregado = await toolRequestAggregatesRepo.findById(decisao.aggregate_id);
      if (!agregado) {
        return { ok: false, reason: 'repo_falhou', detail: 'agregado sumiu entre ler e escrever' };
      }
      const { member_id, estado } = await juntarAoAgregado({
        aggregate_id: decisao.aggregate_id,
        representative_gap_id: agregado.representative_gap_id,
        assinatura: decisao.assinatura,
        similaridade: decisao.similaridade,
        gap_id: gap.id,
        spec: validado.data,
      });
      return {
        ok: true,
        resultado: 'agregado',
        proposal_id: decisao.representative_proposal_id,
        spec: validado.data,
        aggregate_id: decisao.aggregate_id,
        member_id,
        similaridade: decisao.similaridade,
        member_count: estado.member_count,
        contract_state: estado.contract_state,
      };
    }

    // 6c · Pedido novo: a proposta é criada, como na fatia A.
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

    // O agregado de 1. Criá-lo já aqui — e não só quando aparecer o segundo
    // pedido — é o que faz o SEGUNDO ter com que se comparar. Sem isto a
    // agregação só começaria a valer a partir do terceiro pedido, em silêncio.
    //
    // LIMITAÇÃO CONHECIDA, e escrita: proposta e agregado são DUAS escritas
    // sem transação (o repositório deste projeto não usa `db.transaction`).
    // Se a segunda falhar, sobra uma proposta sem agregado, e a passada
    // seguinte do worker abre OUTRA proposta para o mesmo gap — uma duplicata,
    // que é o erro barato desta fatia (a triagem fecha) e não o caro (demanda
    // apagada). Fechar essa janela pede transação no repositório, que é
    // mudança de padrão do projeto inteiro e não cabe aqui.
    //
    // `sem_assinatura` é a exceção declarada: uma descrição sem token de
    // conteúdo não tem chave de comparação, então o pedido fica como proposta
    // isolada. Fail-open no AGRUPAMENTO é fail-closed na FUSÃO — o erro cai no
    // lado barato (uma duplicata que a triagem fecha), nunca no caro.
    let aggregate_id: string | null = null;
    let member_id: string | null = null;
    let contract_state: EstadoDoContrato | null = null;
    if (decisao.decisao === 'novo') {
      const criado = await toolRequestAggregatesRepo.criarComRepresentante({
        assinatura: decisao.assinatura,
        assinatura_version: ASSINATURA_VERSION,
        metrica: METRICA_SIMILARIDADE,
        limiar: LIMIAR_SIMILARIDADE,
        representative_proposal_id: proposta.id,
        representative_gap_id: gap.id,
        proposed_tool_name: nomeProposto,
        nomes_propostos: [nomeProposto],
        contract_state: 'single',
        merged_contract_draft: validado.data.contract_draft,
        contract_conflicts: [],
        intent: validado.data.intent,
        occurrences: validado.data.frequency.occurrences,
        original_spec: validado.data,
      });
      aggregate_id = criado.agregado.id;
      member_id = criado.membro.id;
      contract_state = 'single';
    } else {
      logger.warn(
        { gap_id: gap.id },
        'tool_request.sem_assinatura_para_agregar',
      );
    }

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
        aggregate_id,
        assinatura_version: aggregate_id === null ? null : ASSINATURA_VERSION,
      },
    });

    return {
      ok: true,
      resultado: 'criado',
      proposal_id: proposta.id,
      spec: validado.data,
      aggregate_id,
      member_id,
      similaridade: null,
      member_count: aggregate_id === null ? 0 : 1,
      contract_state,
    };
  } catch (e) {
    return {
      ok: false,
      reason: 'repo_falhou',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
