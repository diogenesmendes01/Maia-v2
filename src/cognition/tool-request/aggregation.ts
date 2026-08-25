/**
 * #637 (fatia B da épica #471) — A POLÍTICA DE AGRUPAMENTO: N pedidos de
 * ferramenta parecidos viram UM pedido com contador.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AS TRÊS DECISÕES QUE A ISSUE EXIGE, EM UM LUGAR SÓ
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **1 · O limiar.** `LIMIAR_SIMILARIDADE = 0,85` sobre o coeficiente de Dice
 * dos tokens de conteúdo. A medição que o sustenta — 2080 pares negativos com
 * rótulo REAL (todo par de tools distintas do catálogo committado), a regra de
 * decisão escrita antes do número, a comparação com os vizinhos e a fragilidade
 * da margem — está no cabeçalho de `similarity.ts` e é reprodutível por
 * `scripts/medir-limiar-tool-request.ts`.
 *
 * **2 · O rascunho Zod na fusão.** Nenhum vence, nunca. Compatíveis → união;
 * incompatíveis → o agregado é marcado `divergent`, NÃO produz contrato fundido
 * e mantém os rascunhos como variantes. Está em `draft-merge.ts`, com o porquê.
 *
 * **3 · Escopo: por tenant + agent. NÃO existe contador global.** É a invariante
 * #1 do projeto, e aqui ela não é formalidade: a agregação COMPARA o texto do
 * pedido de um cliente com o de outro. Um contador global exigiria que o texto
 * de A entrasse no cálculo que produz a linha de B — e "só o número atravessa"
 * não salva, porque contagem pequena é reconstruível. A pergunta legítima
 * ("quantos clientes pediram esta ferramenta?") tem caminho próprio: agregação
 * estatística deliberada com anonimização e ADR, nunca efeito colateral de
 * agrupar pedidos. Consequência aceita e escrita: dois tenants que precisam da
 * MESMA ferramenta produzem DOIS pedidos, e quem prioriza roadmap lê os dois.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A LIMITAÇÃO HERDADA QUE MUDA O QUE ESTE MÓDULO PODE PROMETER
 * ─────────────────────────────────────────────────────────────────────────────
 * Hoje `completeness` é quase sempre `'name_only'`: o único produtor de
 * ocorrências ligado (`src/cognition/persister.ts`) não conhece
 * `attempted_args` nem `expected_output`, então os rascunhos comparados têm
 * pouco além do nome. Duas consequências, ditas em vez de escondidas:
 *
 *   · A assinatura sai de uma frase curta. Dice sobre conjuntos pequenos é
 *     GROSSO (ver a análise de granularidade em `similarity.ts`): a 0,85, duas
 *     descrições de 4–5 tokens só fundem se o conjunto de tokens for IGUAL.
 *     Na prática, HOJE o contador sobe para repetição quase literal.
 *   · O estado `divergent` é raro por construção: rascunhos `name_only` não têm
 *     campo com que conflitar. Isso NÃO significa que a política de divergência
 *     é decorativa — significa que ela só passa a morder quando os rascunhos
 *     ficarem ricos, que é exatamente quando fundir errado ficaria caro. Por
 *     isso ela é testada com rascunhos ricos construídos à mão
 *     (`tests/unit/tool-request-draft-merge.spec.ts`), e não deixada para depois.
 *
 * Quando `attempted_args` passar a ser observado, a assinatura provavelmente
 * deve incluir nomes de campo — e aí o limiar NÃO vale como está. É para isso
 * que existe `ASSINATURA_VERSION`, gravado em cada agregado e cada membro.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O GUARDRAIL DA FATIA A CONTINUA VALENDO AQUI
 * ─────────────────────────────────────────────────────────────────────────────
 * **O agente especifica; humano implementa e instala.** Este módulo não
 * registra tool, não concede nada, não avalia `zod_source`. Ele lê propostas e
 * escreve em DUAS tabelas novas. O arquivo entra sozinho na varredura estática
 * do guardrail (`tests/integration/tool-request-guardrail-real-db.spec.ts`)
 * porque `proposer.ts` o importa — o conjunto varrido vem do grafo de imports.
 */
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { toolRequestAggregatesRepo } from '@/db/repositories.js';
import type { ToolRequestAggregateMember } from '@/db/schema.js';
import {
  ASSINATURA_VERSION,
  LIMIAR_SIMILARIDADE,
  METRICA_SIMILARIDADE,
  assinaturaDePedido,
  similaridadeDeAssinaturas,
} from './similarity.js';
import {
  fundirRascunhos,
  type EstadoDoContrato,
  type MembroParaFusao,
} from './draft-merge.js';
import { ToolRequestSpecSchema, type ToolRequestSpec } from './types.js';

export type ResultadoDaAgregacao =
  /** Nenhum pedido parecido no escopo: este vira o representante de um agregado novo. */
  | { decisao: 'novo'; assinatura: string }
  /** Achou pedido parecido: entra como membro, e NÃO gera proposta. */
  | {
      decisao: 'funde';
      assinatura: string;
      aggregate_id: string;
      representative_proposal_id: string;
      similaridade: number;
    }
  /** Este gap JÁ é membro ativo de um agregado. Rodar o worker de novo não conta duas vezes. */
  | { decisao: 'ja_membro'; aggregate_id: string; assinatura: string }
  /**
   * A descrição do gap não deixa token de conteúdo nenhum. Sem assinatura não
   * há com que comparar — o pedido segue como proposta isolada, SEM agregado.
   * Fail-open no agrupamento é fail-closed na fusão: o erro cai no lado barato
   * (uma duplicata no backlog), nunca no caro (demanda apagada).
   */
  | { decisao: 'sem_assinatura' };

/**
 * DECIDE — sem escrever nada — o que fazer com um pedido novo.
 *
 * A separação entre decidir e escrever não é cerimônia: é o que permite testar
 * a política (limiar, exclusão de destacados, idempotência) sem banco, e é o
 * que faz o call site de escrita ser um só, escopado, auditável.
 */
export async function decidirAgregacao(args: {
  gap_id: string;
  capability_description: string;
}): Promise<ResultadoDaAgregacao> {
  const assinatura = assinaturaDePedido(args.capability_description);
  if (assinatura.length === 0) return { decisao: 'sem_assinatura' };

  // 1 · Idempotência e reversibilidade, na mesma leitura.
  const linhasDoGap = await toolRequestAggregatesRepo.membrosDoGap(args.gap_id);
  const ativo = linhasDoGap.find((m) => m.detached_at === null);
  if (ativo) return { decisao: 'ja_membro', aggregate_id: ativo.aggregate_id, assinatura };

  // Um gap DESTACADO de um agregado não volta a ele por similaridade. Sem
  // isto, "a fusão é reversível" duraria até a próxima passada do cron: o
  // worker refaria, sozinho, o agrupamento que um humano desfez.
  const excluidos = new Set(linhasDoGap.map((m) => m.aggregate_id));

  // 2 · Só agregados DESTE tenant+agent (o repositório não aceita escopo por
  //     parâmetro) e da MESMA versão de assinatura.
  const candidatos = await toolRequestAggregatesRepo.candidatosParaFusao(
    ASSINATURA_VERSION,
  );

  // O MAIOR score vence, e o empate é resolvido pela ordem em que o
  // repositório devolve — `last_member_at DESC`, isto é, o agregado mais
  // ativo. É determinístico (o `>` estrito nunca troca de campeão num empate)
  // e é a leitura certa: entre dois pedidos igualmente parecidos, somar ao que
  // está vivo é o que faz o contador significar demanda corrente.
  let melhor: { aggregate_id: string; proposal_id: string; similaridade: number } | null =
    null;
  for (const c of candidatos) {
    if (excluidos.has(c.id)) continue;
    const s = similaridadeDeAssinaturas(assinatura, c.assinatura);
    if (s < LIMIAR_SIMILARIDADE) continue;
    if (melhor === null || s > melhor.similaridade) {
      melhor = {
        aggregate_id: c.id,
        proposal_id: c.representative_proposal_id,
        similaridade: s,
      };
    }
  }

  if (melhor === null) return { decisao: 'novo', assinatura };
  return {
    decisao: 'funde',
    assinatura,
    aggregate_id: melhor.aggregate_id,
    representative_proposal_id: melhor.proposal_id,
    similaridade: melhor.similaridade,
  };
}

/** O estado do contrato + o contador, recomputados a partir dos membros ATIVOS. */
export interface EstadoRecomputado {
  member_count: number;
  total_occurrences: number;
  contract_state: EstadoDoContrato;
  merged_contract_draft: unknown;
  contract_conflicts: unknown;
  nomes_propostos: string[];
}

/**
 * Relê os membros ativos e reconstrói contador e contrato do zero.
 *
 * RECOMPUTAR, e não incrementar. Um contador incrementado diverge em silêncio
 * na primeira retentativa ou no primeiro destaque; um recomputado só pode
 * divergir se a tabela de membros estiver errada — e é ela que a auditoria lê.
 */
export async function recomputarAgregado(
  aggregate_id: string,
  gap_id_do_representante: string,
): Promise<EstadoRecomputado> {
  const membros = await toolRequestAggregatesRepo.membrosAtivos(aggregate_id);
  const ordenados = [...membros].sort(
    (a, b) =>
      Number(b.is_representative) - Number(a.is_representative) ||
      a.joined_at.getTime() - b.joined_at.getTime(),
  );

  const paraFusao: MembroParaFusao[] = [];
  const ilegiveis: ToolRequestAggregateMember[] = [];
  for (const m of ordenados) {
    const parsed = ToolRequestSpecSchema.safeParse(m.original_spec);
    if (!parsed.success) {
      // Fail-closed no CONTRATO, sem mexer no contador: um spec que o schema
      // não lê não pode entrar numa união que o dev vai tomar por evidência.
      ilegiveis.push(m);
      continue;
    }
    paraFusao.push({ origem: m.id, rascunho: parsed.data.contract_draft });
  }

  const total_occurrences = ordenados.reduce((soma, m) => soma + m.occurrences, 0);

  if (paraFusao.length === 0) {
    return {
      member_count: ordenados.length,
      total_occurrences,
      contract_state: 'divergent',
      merged_contract_draft: null,
      contract_conflicts: [
        {
          lado: 'input',
          campo: '(nenhum spec legível)',
          zods: ['spec_ilegivel'],
          origens: [ilegiveis.map((m) => m.id)],
        },
      ],
      nomes_propostos: [],
    };
  }

  const fusao = fundirRascunhos({ membros: paraFusao, gap_id_do_representante });

  // Um membro ilegível não pode ficar invisível: ele conta no contador e vira
  // divergência declarada no contrato.
  const conflitos =
    ilegiveis.length === 0
      ? fusao.conflitos
      : [
          ...fusao.conflitos,
          {
            lado: 'input' as const,
            campo: '(spec ilegível)',
            zods: ['spec_ilegivel'],
            origens: [ilegiveis.map((m) => m.id)],
          },
        ];
  const estado: EstadoDoContrato = ilegiveis.length === 0 ? fusao.estado : 'divergent';

  return {
    member_count: ordenados.length,
    total_occurrences,
    contract_state: estado,
    merged_contract_draft: estado === 'divergent' ? null : fusao.rascunho,
    contract_conflicts: conflitos,
    nomes_propostos: fusao.nomes_propostos,
  };
}

/**
 * ESCREVE a entrada de um pedido num agregado existente, e devolve o estado
 * recomputado. Não cria proposta — é aqui que N pedidos viram 1.
 */
export async function juntarAoAgregado(args: {
  aggregate_id: string;
  representative_gap_id: string;
  assinatura: string;
  similaridade: number;
  gap_id: string;
  spec: ToolRequestSpec;
}): Promise<{ member_id: string; estado: EstadoRecomputado }> {
  const membro = await toolRequestAggregatesRepo.acrescentarMembro({
    aggregate_id: args.aggregate_id,
    gap_id: args.gap_id,
    assinatura: args.assinatura,
    assinatura_version: ASSINATURA_VERSION,
    metrica: METRICA_SIMILARIDADE,
    limiar: LIMIAR_SIMILARIDADE,
    similaridade: args.similaridade,
    intent: args.spec.intent,
    occurrences: args.spec.frequency.occurrences,
    // A EVIDÊNCIA. O spec inteiro, como entrou. Nada da fusão o reescreve.
    original_spec: args.spec,
  });

  const estado = await recomputarAgregado(args.aggregate_id, args.representative_gap_id);
  await toolRequestAggregatesRepo.atualizarAgregado({
    aggregate_id: args.aggregate_id,
    member_count: estado.member_count,
    total_occurrences: estado.total_occurrences,
    contract_state: estado.contract_state,
    merged_contract_draft: estado.merged_contract_draft,
    contract_conflicts: estado.contract_conflicts,
    nomes_propostos: estado.nomes_propostos,
    last_member_at: new Date(),
  });

  // Invariante #4 — a decisão automática de fundir dois pedidos é auditada com
  // o número que a justificou. Um agrupamento sem o score é um fato sem prova.
  await audit({
    acao: 'tool_request_aggregated',
    entidade_alvo: 'tool_request_aggregates',
    alvo_id: args.aggregate_id,
    metadata: {
      member_id: membro.id,
      gap_id: args.gap_id,
      similaridade: args.similaridade,
      limiar: LIMIAR_SIMILARIDADE,
      metrica: METRICA_SIMILARIDADE,
      assinatura_version: ASSINATURA_VERSION,
      member_count: estado.member_count,
      total_occurrences: estado.total_occurrences,
      contract_state: estado.contract_state,
      conflitos: Array.isArray(estado.contract_conflicts)
        ? estado.contract_conflicts.length
        : 0,
    },
  });

  logger.info(
    {
      aggregate_id: args.aggregate_id,
      gap_id: args.gap_id,
      similaridade: args.similaridade,
      member_count: estado.member_count,
      contract_state: estado.contract_state,
    },
    'tool_request.aggregated',
  );

  return { member_id: membro.id, estado };
}

/**
 * DESFAZ um agrupamento: o membro sai do contador e o contrato é recomputado.
 *
 * Não apaga nada. `detached_at` + motivo, e o membro continua legível com o
 * `original_spec` intacto — que é o que faz "um agrupamento errado não pode
 * apagar a evidência dos pedidos originais" ser verdade e não intenção.
 *
 * O REPRESENTANTE não pode ser destacado. Ele é a proposta em
 * `capability_proposals` que ancora o agregado inteiro; destacá-lo deixaria o
 * grupo apontando para um pedido que já não é dele. Quem quer desfazer um
 * agregado inteiro destaca os NÃO-representantes — o que reduz o agregado ao
 * pedido original, que é o estado de antes da fusão.
 */
export async function destacarDoAgregado(args: {
  member_id: string;
  reason: string;
  by?: string | null;
}): Promise<
  | { ok: true; aggregate_id: string; estado: EstadoRecomputado }
  | { ok: false; reason: 'nao_encontrado' | 'e_representante' | 'ja_destacado' }
> {
  const linha = await toolRequestAggregatesRepo.membroPorId(args.member_id);
  if (!linha) return { ok: false, reason: 'nao_encontrado' };
  if (linha.detached_at !== null) return { ok: false, reason: 'ja_destacado' };
  if (linha.is_representative) return { ok: false, reason: 'e_representante' };

  const destacado = await toolRequestAggregatesRepo.destacarMembro({
    member_id: args.member_id,
    reason: args.reason,
    by: args.by ?? null,
  });
  if (!destacado) return { ok: false, reason: 'ja_destacado' };

  const agregado = await toolRequestAggregatesRepo.findById(linha.aggregate_id);
  if (!agregado) return { ok: false, reason: 'nao_encontrado' };

  const estado = await recomputarAgregado(
    agregado.id,
    agregado.representative_gap_id,
  );
  await toolRequestAggregatesRepo.atualizarAgregado({
    aggregate_id: agregado.id,
    member_count: estado.member_count,
    total_occurrences: estado.total_occurrences,
    contract_state: estado.contract_state,
    merged_contract_draft: estado.merged_contract_draft,
    contract_conflicts: estado.contract_conflicts,
    nomes_propostos: estado.nomes_propostos,
  });

  await audit({
    acao: 'tool_request_aggregate_detached',
    entidade_alvo: 'tool_request_aggregate_members',
    alvo_id: args.member_id,
    metadata: {
      aggregate_id: agregado.id,
      gap_id: linha.gap_id,
      reason: args.reason,
      by: args.by ?? null,
      member_count: estado.member_count,
      contract_state: estado.contract_state,
    },
  });

  return { ok: true, aggregate_id: agregado.id, estado };
}
