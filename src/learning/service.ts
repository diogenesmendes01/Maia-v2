/**
 * P09 / G1 (spec §7.6.1, §7.8.4, §7.9.2) — `LearningService`.
 *
 * ─── O poder que este serviço tira de quem não devia ter ────────────────────
 *
 * `src/workers/reflection-batch.ts` chama `rulesRepo.create({ …, ativa: true })`
 * e, logo depois, `writeMemory({ …, escopo: 'global' })`. Lidas juntas, as duas
 * linhas dizem o seguinte: um worker em lote, a partir de um agrupamento de
 * correções, cria uma REGRA ATIVA que passa a governar todos os turnos
 * seguintes, e publica a justificativa do modelo como memória GLOBAL.
 *
 * Nenhum humano aparece nesse caminho. E o §7.6.1 é explícito sobre o que
 * `source='worker'` significa: **não é selo de confiança**.
 *
 * Este módulo é a porta única por onde aprendizado entra. Ele não deixa nada
 * nascer ativo, não deixa quem propõe escolher a própria proveniência, e não
 * publica raciocínio de modelo em lugar nenhum.
 *
 * ─── O que ele deliberadamente NÃO faz ──────────────────────────────────────
 *
 * Não aprova. `KnowledgeStateMachine.transition` aceita `decided_by` e **não
 * autentica humano nenhum** (§7.9.2, primeiro item), então delegar a decisão a
 * ela seria aceitar uma string como assinatura. Quem decide é o inbox, com
 * identidade de sessão e ACL — este serviço apenas diz QUAL classe de
 * aprovação a proposta exige, usando `getLearningApprovalClassFor`.
 *
 * Não generaliza. Transformar um aprendizado privado em compartilhado exige
 * revisão desidentificada, revisão de conteúdo e aprovação de destino, tudo
 * separado (§7.6.1 item 8). O que sai daqui nasce privado.
 */
import { KnowledgeStateMachine } from '@/control-plane/knowledge-state-machine/index.js';
import { logger } from '@/lib/logger.js';
import type { ApprovalClassId, RiskLevelId } from '@/db/schema.js';
import {
  alwaysRequiresHumanReview,
  destinationFor,
  getLearningApprovalClassFor,
  type LearningKind,
} from './policy.js';

/**
 * A proposta como ela chega — SEM nada que afirme autoridade.
 *
 * Repare no que não existe aqui: `origin`, `confidence` declarada pelo
 * proponente, `lifecycle_status`, `approved_by`, `visible_to_llm`. O §7.6.1
 * item 4 diz que "o modelo não escolhe lifecycle, confiança ou origem", e a
 * maneira de garantir isso não é validar esses campos — é não os aceitar.
 */
export type LearningProposalV1 = {
  kind: LearningKind;
  tenant_id: string;
  agent_id: string;
  trace_id: string;
  /** Chave fechada da política; nunca texto livre do proponente. */
  key: string;
  /** Payload canônico, tipado pelo chamador conforme o `kind` (§7.8.4). */
  content: unknown;
  /** Descrição textual NÃO autoritativa. O screening lê o `content`. */
  content_text: string;
  /** Titular, quando o destino é de escopo pessoal. */
  subject_pessoa_id?: string;
  /**
   * De onde veio, para linhagem. É rótulo de PROCEDÊNCIA TÉCNICA, não de
   * confiança: `worker` não vale mais que `tool` (§7.6.1).
   */
  source: 'worker' | 'tool' | 'operator_draft';
  /**
   * Ids que sustentam a proposta. Linhagem, não autoridade.
   *
   * O nome diz `example` e não `event` de propósito: o `reflection-batch`
   * carrega `transacoes.id` (o `alvo_id` do sinal de correção), NÃO
   * `audit_log.id`. Chamá-los de "eventos" faria o consumidor procurar na
   * tabela errada.
   */
  source_example_ids: readonly string[];
  /**
   * O exemplo REPRESENTATIVO, que vai para a coluna durável do destino.
   *
   * Separado da lista porque a coluna guarda um só, e escolher qual é do
   * chamador — ele é quem sabe qual caso explica melhor a proposta. Ausente,
   * o primeiro da lista serve.
   */
  primary_example_id?: string | null;
  /** Nativos da tabela de destino, validados pelo chamador. */
  native?: Record<string, unknown>;
};

export type LearningProposalResultV1 =
  | {
      kind: 'proposed';
      proposal_id: string;
      /** SEMPRE um estado de revisão para tudo que não seja preferência. */
      lifecycle_status: string;
      visible_to_llm: boolean;
      /** Quem precisa assinar para isto virar realidade. */
      approval_class: ApprovalClassId;
      /** Risco calculado pelo backend, nunca declarado pelo proponente. */
      risk: RiskLevelId;
    }
  | {
      kind: 'refused';
      reason: 'destination_not_knowledge' | 'missing_subject' | 'empty_lineage';
      detail: string;
    };

/**
 * A confiança de nascimento de uma proposta de aprendizado.
 *
 * Fixa, e baixa. O §7.6.1 tira do modelo a escolha de confiança, e o
 * `AGENTS.md` regra 5 diz que confiança de self-model vem de fórmula
 * determinística sobre contagem de evidências — não de declaração.
 *
 * Usar um valor fixo aqui é honesto enquanto o ledger de proveniência do
 * §7.6.2 ("persistir registro NOVO de proveniência/decisão e derivar
 * `evidence_count` dele") não existir. Quando existir, esta constante sai e a
 * confiança passa a ser derivada dele.
 */
const CONFIANCA_DE_PROPOSTA = 0.5;

/**
 * Propõe aprendizado vindo do worker de reflexão.
 *
 * Substitui `rulesRepo.create({ ativa: true })` + `writeMemory('global')` do
 * `reflection-batch`. A diferença observável: nada nasce ativo, nada nasce
 * visível ao LLM, e o raciocínio do modelo não vira memória.
 */
export async function proposeFromWorker(
  proposta: LearningProposalV1,
): Promise<LearningProposalResultV1> {
  const destino = destinationFor(proposta.kind);

  // Skills e procedures não são item de conhecimento e não entram por aqui
  // (§7.8.4). Recusar em vez de "adaptar" é o que impede este serviço de virar
  // uma segunda porta para o caminho administrativo founder-only.
  if (destino.channel !== 'ksm') {
    return {
      kind: 'refused',
      reason: 'destination_not_knowledge',
      detail: `kind=${proposta.kind} vai para o caminho governado de ${destino.artifact}, não para o KSM`,
    };
  }

  if (destino.scope === 'user' && proposta.subject_pessoa_id === undefined) {
    // Escopo pessoal sem titular demonstrável é quarentena, não default
    // (§7.6.1 item 1: "se não for demonstrável, quarentena"). O ator da
    // correção NÃO é presumido titular dos dados.
    return {
      kind: 'refused',
      reason: 'missing_subject',
      detail: `kind=${proposta.kind} exige titular, e ele não foi demonstrado`,
    };
  }

  if (proposta.source_example_ids.length === 0) {
    // Sem linhagem não há como auditar de onde a proposta veio, nem como
    // revogá-la pela fonte depois.
    return {
      kind: 'refused',
      reason: 'empty_lineage',
      detail: 'proposta sem evento de origem não é auditável',
    };
  }

  const resultado = await KnowledgeStateMachine.propose({
    trace_id: proposta.trace_id,
    tenant_id: proposta.tenant_id,
    agent_id: proposta.agent_id,
    kind: destino.kind,
    scope: destino.scope,
    ...(proposta.subject_pessoa_id !== undefined
      ? { scope_value: proposta.subject_pessoa_id }
      : {}),
    key: proposta.key,
    content: proposta.content,
    content_text: proposta.content_text,
    confidence: CONFIANCA_DE_PROPOSTA,
    // A origem é do CAMINHO, não do proponente. Tudo que chega aqui foi
    // inferido por um modelo em algum ponto da cadeia, e `worker` não muda
    // isso — é o que "`source='worker'` não é selo de confiança" quer dizer.
    origin: 'llm_inference',
    // §7.4.1 — a exigência de revisão é declarada ao KSM, que decide na
    // PRIMEIRA transição. Antes eu checava DEPOIS e só logava: o item já
    // estava gravado visível, e um log não desfaz gravação. As duas saídas
    // alternativas são proibidas pela spec — falsificar o risco estraga a
    // leitura dele, e um UPDATE de ephemeral para pending_review inventaria
    // uma aresta que a máquina não tem.
    require_human_review: alwaysRequiresHumanReview(proposta.kind),
    source: `learning:${proposta.source}`,
    native: {
      ...(proposta.native ?? {}),
      /**
       * O exemplo de origem desce até a coluna `learned_rules.exemplo_origem_id`.
       *
       * O caminho que este serviço substituiu já persistia essa referência.
       * Contar a linhagem no log e não gravá-la seria trocar um vínculo
       * durável por uma métrica — a revisão humana veria a proposta sem o
       * caso concreto que a motivou.
       */
      rule_exemplo_origem_id: proposta.primary_example_id ?? proposta.source_example_ids[0] ?? null,
    } as never,
  });

  const risk = riscoDoResultado(resultado.reason);

  logger.info(
    {
      proposal_id: resultado.proposal_id,
      learning_kind: proposta.kind,
      ksm_kind: destino.kind,
      initial_status: resultado.initial_status,
      source: proposta.source,
      lineage: proposta.source_example_ids.length,
      primary_example_id: proposta.primary_example_id ?? proposta.source_example_ids[0] ?? null,
    },
    'learning.proposed',
  );

  return {
    kind: 'proposed',
    proposal_id: resultado.proposal_id,
    lifecycle_status: resultado.initial_status,
    visible_to_llm: resultado.visible_to_llm,
    approval_class: getLearningApprovalClassFor({ kind: proposta.kind, risk }),
    risk,
  };
}

/**
 * Extrai o nível de risco da string de motivo do KSM.
 *
 * O `propose` devolve `reason` no formato `risk=<nivel> | kind=… | conf=…`, e
 * não expõe o nível em campo próprio. Ler da string é frágil, então o default
 * quando o formato não casa é `critical` — o lado que exige a assinatura mais
 * forte. Um parse que falhasse para `low` transformaria uma mudança de formato
 * numa redução silenciosa de exigência de aprovação.
 */
function riscoDoResultado(reason: string): RiskLevelId {
  const m = /(?:^|\|\s*)risk=(low|medium|high|critical)\b/.exec(reason);
  return (m?.[1] as RiskLevelId | undefined) ?? 'critical';
}
