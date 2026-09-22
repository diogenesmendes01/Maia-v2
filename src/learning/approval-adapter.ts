/**
 * P09 (spec §7.9.2) — ADAPTER TRANSACIONAL de decisão humana sobre
 * `knowledge_proposal`.
 *
 * ─── O buraco que ele fecha ─────────────────────────────────────────────────
 *
 * O inbox unificado despacha a decisão por SOURCE, e `knowledge_proposal`
 * caía em `source_not_supported` (`admin-repos.ts`). A consequência é a que a
 * spec nomeia: "o lançamento de aprovação de learning depende dessa entrega".
 * Existiam propostas de conhecimento nascendo em `pending_review` e não havia
 * caminho autenticado para decidi-las.
 *
 * ─── Por que não delegar a `KnowledgeStateMachine.transition` ───────────────
 *
 * Porque ela aceita `decided_by` e **não autentica humano nenhum** (§7.9.2,
 * primeiro item). Passar o id de uma sessão para lá seria aceitar uma string
 * como assinatura: nada na máquina distingue `decided_by: 'founder-1'` escrito
 * por um router autenticado de um escrito por qualquer outro caller.
 *
 * Quem autentica é o inbox, antes de chegar aqui. Este módulo recebe a
 * decisão já autenticada e cuida de UMA coisa: que ela e o efeito dela
 * aconteçam juntos.
 *
 * ─── Por que transacional ───────────────────────────────────────────────────
 *
 * A linha de aprovação e a mudança de estado do item canônico são dois fatos
 * sobre a mesma decisão. Em transações separadas, um crash entre elas deixa um
 * dos dois estados impossíveis:
 *
 *  - decisão gravada sem efeito: o console mostra "aprovado", o item continua
 *    invisível, e ninguém consegue dizer se falta aplicar ou se já aplicou;
 *  - efeito sem decisão: o item vira ativo e não há linha dizendo quem
 *    autorizou — que é a definição de mudança de comportamento sem dono.
 *
 * Por isso `knowledgeRepos` ganhou executor: a leitura e a escrita do KSM
 * rodam DENTRO da transação do inbox.
 */
import { assertAllowedTransition } from '@/control-plane/knowledge-state-machine/transitions.js';
import { knowledgeRepos } from '@/control-plane/knowledge-state-machine/repos.js';
import type {
  KnowledgeKind,
  KnowledgeLifecycleStatus,
  KnowledgeTransitionRecord,
} from '@/control-plane/knowledge-state-machine/types.js';
import type { db } from '@/db/client.js';

type Executor = typeof db;

export type KnowledgeDecisionV1 = {
  kind: KnowledgeKind;
  proposal_id: string;
  /** `approve` promove; `reject` revoga. Não há terceiro desfecho. */
  decision: 'approve' | 'reject';
  /**
   * Quem decidiu, JÁ AUTENTICADO pelo inbox.
   *
   * O nome do campo diz `app_user_id` e não `decided_by` de propósito: é uma
   * identidade de sessão verificada, não um rótulo livre.
   */
  decided_by_app_user_id: string;
  /** Motivo curto, para a trilha. Não é o conteúdo da decisão. */
  reason: string;
};

export type KnowledgeDecisionResultV1 =
  | { ok: true; from: KnowledgeLifecycleStatus; to: KnowledgeLifecycleStatus }
  | { ok: false; reason: 'not_found' }
  | {
      ok: false;
      reason: 'invalid_source_status';
      current: KnowledgeLifecycleStatus;
    }
  | { ok: false; reason: 'illegal_transition'; detail: string };

/**
 * Para onde a decisão leva.
 *
 * `approve` vai para `active`, e não para `verified`: `verified` é estado de
 * EVIDÊNCIA acumulada, que o auto-promoter atinge sozinho. Uma aprovação
 * humana não é evidência — é autorização, e o estado que a representa é
 * `active`.
 *
 * `reject` vai para `revoked`, que o §7.4.1 define como terminal absoluto. Não
 * existe "rejeitado e depois reconsiderado" na mesma linha: reconsiderar é uma
 * proposta nova, com decisão nova.
 */
function destino(decision: 'approve' | 'reject'): KnowledgeLifecycleStatus {
  return decision === 'approve' ? 'active' : 'revoked';
}

/**
 * Aplica a decisão humana DENTRO da transação do chamador.
 *
 * Recebe o `tx` em vez de abrir um: quem decide o escopo da atomicidade é o
 * inbox, que também grava a linha de aprovação e a auditoria. Abrir transação
 * aqui criaria uma segunda, aninhada ou paralela, e desfaria a garantia.
 */
export async function applyKnowledgeDecisionTx(
  tx: Executor,
  input: KnowledgeDecisionV1,
): Promise<KnowledgeDecisionResultV1> {
  const row = await knowledgeRepos.findById(input.kind, input.proposal_id, tx);
  if (row === null) return { ok: false, reason: 'not_found' };

  const from = row.lifecycle_status as KnowledgeLifecycleStatus;

  /**
   * Só proposta PENDENTE é decidível por esta porta.
   *
   * Um item já `active` não precisa de aprovação, e um já `revoked` é
   * terminal. Aceitar qualquer um dos dois faria o inbox parecer ter mudado
   * algo que não mudou — e `invalid_source_status` é exatamente o que o router
   * já sabe traduzir para "atualize e tente de novo".
   */
  if (from !== 'pending_review') {
    return { ok: false, reason: 'invalid_source_status', current: from };
  }

  const to = destino(input.decision);

  // A tabela de transições é a autoridade. Validar contra ela antes de tocar o
  // banco mantém esta porta incapaz de inventar aresta — que é o mesmo motivo
  // de `require_human_review` existir em vez de um UPDATE direto.
  try {
    assertAllowedTransition(from, to);
  } catch (err) {
    return { ok: false, reason: 'illegal_transition', detail: (err as Error).message };
  }

  const registro: KnowledgeTransitionRecord = {
    from,
    to,
    at: new Date().toISOString(),
    // A identidade AUTENTICADA entra no MOTIVO, não em `decided_by`.
    //
    // `decided_by` é vocabulário FECHADO (`KnowledgeDecidedBy`), e
    // `human_approval`/`human_rejection` são os valores que já existem para
    // este fato. Cunhar um `app_user:<id>` ali partiria em duas todas as
    // consultas que agrupam por decisor — e o campo deixaria de ser enumerável.
    reason: `app_user:${input.decided_by_app_user_id};${input.reason}`,
    decided_by: input.decision === 'approve' ? 'human_approval' : 'human_rejection',
  };

  await knowledgeRepos.update(
    input.kind,
    input.proposal_id,
    {
      lifecycle_status: to,
      lifecycle_transitions: [
        ...((row.lifecycle_transitions ?? []) as KnowledgeTransitionRecord[]),
        registro,
      ],
      // CAS: se outra decisão passou entre a leitura e a escrita, o UPDATE não
      // encontra linha e o repositório reclama — em vez de sobrescrever uma
      // decisão que alguém acabou de tomar.
      expected_previous_status: from,
    },
    tx,
  );

  return { ok: true, from, to };
}
