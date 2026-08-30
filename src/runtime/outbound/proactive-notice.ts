/**
 * Issue #506 — o AVISO PROATIVO passa a ser uma linha de ledger, não uma
 * chamada ao canal.
 *
 * ─── O que este módulo corrige ──────────────────────────────────────────────
 *
 * Quatro rotas do inventário de #634 (`send-paths.ts`) faziam a mesma coisa,
 * cada uma do seu jeito: resolviam a linha, chamavam `line.sendText(jid, text)`
 * dentro de um `withDeclaredEgressException`, e embrulhavam tudo num `.catch`
 * que registrava um `warn`. O efeito comum não era o `warn` — era o que o
 * `warn` escondia: **o PostgreSQL nunca soube que aquela mensagem ia existir.**
 * Um processo morto entre a resolução da linha e o retorno do provedor não
 * deixava linha nenhuma para reconciliar, e o aviso simplesmente não acontecia.
 * É exatamente o defeito que a épica #506 existe para eliminar, e ele estava
 * INVENTARIADO como exceção em vez de corrigido.
 *
 * ─── Por que o ledger de AGENDAMENTO e não o outbox do TURNO ────────────────
 *
 * O outbox durável de #631 ancora a saída lógica no turno: `commitOutboundIntent`
 * exige um `TurnHandle` vivo (`getOutboundTurnScope()`), faz FENCE do
 * `claim_token` da tentativa e move o turno para `outbound_pending`. Um briefing
 * das 7h, uma notificação a aprovador e um aviso de expiração emitido no tick do
 * engine não têm turno para cercar — e inventar um turno sintético só para poder
 * commitar seria fabricar a posse que o fence existe para verificar.
 *
 * O que essas rotas precisam é a PROPRIEDADE, não a tabela: persistir antes de
 * enviar, reivindicar com lease, tentar de novo com backoff, e morrer em DLQ com
 * auditoria em vez de sumir. `outbox_messages` (migração 007, drenado por
 * `src/scheduling/outbox-drain.ts` a cada minuto, por tenant) já oferece
 * exatamente isso, já é a rota de TODO lembrete agendado do produto, e já tem
 * precedente para envio proativo sem ocorrência —
 * `src/scheduling/disambiguation.ts` enfileira `whatsapp_text` com
 * `occurrence_id: null`, chaveado pela row durável que justifica o aviso.
 *
 * Então este módulo NÃO cria um terceiro ledger. Ele move quatro emissores para
 * um ledger que já existe, e o número de módulos de produção que falam com o
 * canal cai de dez para seis. O trabalho que sobra — FUNDIR os dois ledgers
 * duráveis num só, com `outbound_messages` como único sender — passa a ter UM
 * ponto de aplicação (`outbox-drain.ts`) em vez de cinco, que é a diferença
 * entre uma fatia executável e um projeto.
 *
 * ─── A IDEMPOTÊNCIA é obrigatória, não opcional ─────────────────────────────
 *
 * `dedupe_key` é parâmetro EXIGIDO e não `string | undefined` de propósito. O
 * `idx_outbox_dedup` da migração 007 é UNIQUE PARCIAL sobre `dedup_key` e
 * GLOBAL (a 073 o deixou deliberadamente sem tenant/agent à frente, e diz por
 * quê). Duas consequências que o chamador precisa saber:
 *
 *  1. **a chave tem que ser globalmente única** — por isso o contrato manda
 *     derivá-la do UUID da row durável que justifica o aviso
 *     (`approval_requests.id`, `workflows.id`, `pessoas.id`), nunca de um
 *     contador local nem de um texto;
 *  2. **a chave só rende UM aviso, para sempre** — que é o desfecho certo para
 *     tudo que passa por aqui: um pedido de aprovação notifica cada aprovador
 *     uma vez, uma expiração avisa uma vez, e um briefing sai uma vez por dono
 *     por período por dia. Hoje, um worker que rodasse duas vezes mandava a
 *     mensagem duas vezes.
 *
 * Colisão de chave NÃO é erro: é a prova de que o aviso já foi comprometido.
 * `outboxRepo.enqueue` traduz a violação de unicidade em `null`, e aqui isso
 * vira `'already_enqueued'` — um desfecho NOMEADO, para que o chamador não
 * confunda "já estava lá" com "não fiz nada".
 */
import { outboxRepo } from '@/scheduling/repos.js';
import type { WhatsappTextPayload } from '@/scheduling/types.js';

export type ProactiveNoticeInput = {
  /** JID de destino, já resolvido pelo chamador (é ele que conhece a pessoa). */
  jid: string;
  text: string;
  /**
   * Identidade do aviso. Ver o bloco "A IDEMPOTÊNCIA" acima: precisa ser
   * globalmente única e derivada de uma row durável.
   */
  dedupe_key: string;
  /**
   * Canal de saída. `null`/ausente resolve o canal ÚNICO ativo do agente
   * corrente e é FAIL-CLOSED em ambiguidade (`resolveOutboxChannelId` lança
   * `channel_ambiguous`) — a mesma regra que `forCurrentAgentChannel(null)`
   * aplicava nos call sites que este módulo substitui.
   */
  channel_id?: string | null;
};

export type ProactiveNoticeOutcome = 'enqueued' | 'already_enqueued';

/**
 * Compromete um aviso proativo no ledger durável. NÃO envia.
 *
 * Lança quando o banco recusa a gravação ou quando o canal é ambíguo — que é o
 * comportamento certo: sem linha no ledger não há aviso, e seguir em frente
 * seria o fail-open que a invariante proíbe. Os call sites que hoje toleram
 * falha de aviso continuam podendo tolerá-la, mas agora a tolerância é
 * explícita no call site em vez de estar embutida no emissor.
 */
export async function enqueueProactiveNotice(
  input: ProactiveNoticeInput,
): Promise<ProactiveNoticeOutcome> {
  const payload: WhatsappTextPayload = { jid: input.jid, text: input.text };
  const row = await outboxRepo.enqueue({
    occurrence_id: null,
    task_id: null,
    // `whatsapp_text` e não `whatsapp_alert`: os dois caem no MESMO ramo de
    // `pickChannel`, mas só `whatsapp_text` tem a conclusão de task acoplada —
    // e ela é inerte aqui, porque `task_id` é null. `whatsapp_alert` carrega a
    // semântica de "alerta de ocorrência atrasada" que estes avisos não têm.
    kind: 'whatsapp_text',
    payload: payload as unknown as Record<string, unknown>,
    dedup_key: input.dedupe_key,
    ...(input.channel_id ? { channel_id: input.channel_id } : {}),
  });
  return row === null ? 'already_enqueued' : 'enqueued';
}
