/**
 * Issue #634 (fatia E da épica #506) — O INVENTÁRIO DOS CAMINHOS DE ENVIO.
 *
 * O primeiro critério de pronto da issue é "inventário completo dos caminhos,
 * com o estado de cada um". Ele vive AQUI, em código, e não num markdown, por
 * três razões que um documento não consegue oferecer:
 *
 *  1. o teste de arquitetura
 *     (`tests/unit/runtime/outbound-trava-envio-direto.spec.ts`) varre `src/` e
 *     REPROVA um `LineOutput.send*` num módulo que não esteja aqui. Um
 *     inventário em markdown envelhece em silêncio; este não pode;
 *  2. a trava de runtime (`egress-guard.ts`) recusa `withDeclaredEgressException`
 *     com um id que não esteja aqui — não dá para abrir exceção sem escrever o
 *     motivo;
 *  3. `state` é um tipo, então "migrado" e "exceção" não podem ser confundidos
 *     por uma redação ambígua.
 *
 * ─── Como ler `state` ───────────────────────────────────────────────────────
 *
 *   `outbox`    — o envio é precedido por um artefato durável commitado
 *                 (`commitTurnOutboundTx`, #631) e a entrega o consome. É o
 *                 destino que a épica quer para todos.
 *   `declared_exception` — o envio NÃO passa pelo outbox do turno. Toda entrada
 *                 aqui carrega `reason` (por que não passa) e `containment`
 *                 (o que segura o risco enquanto não passa). A issue pede o
 *                 inventário "idealmente vazio"; ele não está, e cada linha diz
 *                 por quê.
 *   `infrastructure` — o módulo É a fronteira de saída ou o adaptador dela.
 *                 Não é um "caminho de envio": é o cano por onde os outros
 *                 passam.
 *
 * ─── O que a auditoria de fechamento da #506 mudou aqui ─────────────────────
 *
 * A #634 deixou dez exceções com `reason` e `containment` escritos, e a
 * auditoria de fechamento chamou isso pelo nome: *"o inventário de caminhos de
 * envio não está vazio"*, e o denominador comum das dez era um só — nenhuma tem
 * `turn_id`. Um denominador comum não é justificativa individual; é um
 * adiamento coletivo com dez redações.
 *
 * Duas coisas mudaram, e nenhuma delas é redação:
 *
 *  1. **Cada exceção passou a declarar um IMPEDIMENTO TIPADO** (`blocked_by`,
 *     de `OUTBOUND_EXCEPTION_BLOCKERS` — vocabulário FECHADO, sem membro
 *     genérico) e a **remediação concreta** que a apaga. As dez deixaram de
 *     compartilhar "não tem turno": quatro são `no_turn_to_anchor`, três são
 *     `foreign_recipient`, duas são `competing_durable_ledger` e uma é
 *     `ephemeral_signal_without_provider_id`. São quatro trabalhos diferentes,
 *     e agora o inventário diz qual é qual.
 *  2. **O conjunto FECHOU.** `RATIFIED_EXCEPTION_IDS` +
 *     `MAX_DECLARED_EXCEPTIONS` + `assertRatifiedInventory` formam uma catraca
 *     que roda no CARREGAMENTO do módulo: uma exceção não ratificada derruba o
 *     import — e como `egress-guard.ts` importa daqui e `line-output.ts` importa
 *     dele, a rota paralela nova não chega a enviar nada. A lista só encolhe.
 *
 * O que NÃO mudou, e é a parte honesta: nenhuma das dez foi migrada. As quatro
 * `no_turn_to_anchor` e as três `foreign_recipient` esbarram no mesmo ponto
 * concreto — `outbound_messages.turn_id` é `NOT NULL` na migração 121, a FK é
 * composta contra `agent_turns`, e `deliverOutbound` recusa explicitamente uma
 * row sem `turn_id`. Migrá-las é uma âncora durável nova mais a entrega dela,
 * não um wrapper diferente no call site.
 */

/** Categorias que a issue-mãe #506 enumera. Lista FECHADA. */
export const OUTBOUND_PATH_CATEGORIES = [
  'agent_reply',
  'early_reply',
  'fallback',
  'timeout',
  'user_visible_error',
  'governance_confirmation',
  'tool_output',
  'reaction',
  'administrative',
] as const;

export type OutboundPathCategory = (typeof OUTBOUND_PATH_CATEGORIES)[number];

export type OutboundPathState = 'outbox' | 'declared_exception' | 'infrastructure';

/**
 * Issue #506 (auditoria de fechamento) — POR QUE esta rota não passa pelo
 * outbox, como TIPO e não como redação.
 *
 * O dono da épica foi literal: *"zero exceção meramente inventariada"*. Uma
 * exceção com um parágrafo bem escrito continua sendo um item de inventário se
 * o parágrafo puder dizer qualquer coisa. O que separa "justificativa técnica
 * individual" de "texto" é o vocabulário ser FECHADO: um bloqueio novo exige
 * acrescentar um MEMBRO a esta lista, e um membro novo é uma afirmação de
 * arquitetura que aparece no diff.
 *
 * Não existe membro genérico (`other`, `legacy`, `todo`) de propósito. A
 * ausência é o mecanismo: quem não conseguir encaixar a rota em um dos quatro
 * está descobrindo que a rota não tem impedimento técnico — só não foi migrada.
 */
export const OUTBOUND_EXCEPTION_BLOCKERS = [
  /**
   * O envio acontece FORA de qualquer turno.
   *
   * Não é uma preferência de escopo: `outbound_messages.turn_id` é `NOT NULL`
   * para toda row durável (migração 121, CHECK
   * `outbound_messages_durable_row_complete_check`), a FK é composta
   * `(tenant_id, agent_id, turn_id) -> agent_turns`, e `commitTurnOutboundTx`
   * faz FENCE do `claim_token` do turno dentro da transação. Sem turno, a row
   * durável é literalmente inexprimível — não há o que cercar nem a que
   * ancorar.
   *
   * O que desbloqueia está escrito em `remediation` de cada entrada, e é sempre
   * a mesma família de trabalho: uma âncora durável para saída SEM turno, com
   * entrega própria. É trabalho de fatia, não de call site.
   */
  'no_turn_to_anchor',
  /**
   * O destinatário NÃO é o interlocutor do turno.
   *
   * A saída lógica do outbox é chaveada por `(turn_id, sequence_in_turn)` e o
   * turno aponta para ela; o JID de destino é resolvido no ingresso do job de
   * entrega a partir da `conversa_id` da row. Uma saída do MESMO turno para
   * OUTRA conversa ou outra pessoa produziria um artefato cujo destinatário
   * diverge do turno que o ancora — e a divergência só apareceria na entrega.
   */
  'foreign_recipient',
  /**
   * A rota JÁ É um outbox durável próprio, com persistência antes do envio,
   * claim, retry e DLQ.
   *
   * Migrá-la para o outbox do turno colocaria um outbox dentro de outro: duas
   * autoridades sobre a mesma saída, que é exatamente o que a §Rollback da
   * issue proíbe ("nunca habilitar simultaneamente dois senders autoritativos").
   * O trabalho real é a FUSÃO dos ledgers, e ele tem dono próprio.
   */
  'competing_durable_ledger',
  /**
   * A primitiva do provedor não devolve identificador nem confirmação, e o
   * sinal é EFÊMERO.
   *
   * `sendReaction` devolve `void`: `provider-adapter.ts` classifica o desfecho
   * como `accepted_without_id`, que `statusForOutcome` mapeia para
   * `delivery_unknown`. Uma reação migrada nasceria incerta em 100% dos casos e,
   * como o Baileys não honra chave idempotente para `reaction`,
   * `reconciliationDisposition` a mandaria para `escalate_manual` — a fila
   * HUMANA de #633. O outbox passaria a produzir trabalho de operador para um
   * sinal que não é mensagem nenhuma para o usuário.
   */
  'ephemeral_signal_without_provider_id',
] as const;

export type OutboundExceptionBlocker = (typeof OUTBOUND_EXCEPTION_BLOCKERS)[number];

export interface OutboundSendPath {
  /** Id estável. É o valor passado a `withDeclaredEgressException`. */
  id: string;
  /** Caminho do módulo relativo à raiz do repo — o teste estático casa por ele. */
  module: string;
  state: OutboundPathState;
  categories: readonly OutboundPathCategory[];
  /** Primitivas de `LineOutput` que este módulo chama. */
  primitives: readonly string[];
  /** O que este caminho envia, em uma frase. */
  what: string;
  /** Obrigatório em `declared_exception`: por que ainda não passa pelo outbox. */
  reason?: string;
  /** Obrigatório em `declared_exception`: o que segura o risco hoje. */
  containment?: string;
  /**
   * Obrigatório em `declared_exception`: o IMPEDIMENTO técnico, do vocabulário
   * fechado. É o campo que torna a exceção uma decisão e não um adiamento.
   */
  blocked_by?: OutboundExceptionBlocker;
  /**
   * Obrigatório em `declared_exception`: o que, concretamente, precisa existir
   * para que esta rota passe pelo outbox. Escrito como trabalho, não como
   * desejo — é o que alguém executaria para APAGAR esta entrada.
   */
  remediation?: string;
}

export const OUTBOUND_SEND_PATHS: readonly OutboundSendPath[] = Object.freeze([
  // ── INFRAESTRUTURA ────────────────────────────────────────────────────────
  {
    id: 'gateway.line_output',
    module: 'src/gateway/line-output.ts',
    state: 'infrastructure',
    categories: [],
    primitives: ['sendText', 'sendDocument', 'sendVoice', 'sendPoll', 'sendReaction'],
    what: 'A fronteira única de saída. É onde a trava de runtime mora.',
  },
  {
    id: 'gateway.line_sessions',
    module: 'src/gateway/line-sessions.ts',
    state: 'infrastructure',
    categories: [],
    primitives: ['sendText', 'sendDocument', 'sendVoice', 'sendPoll', 'sendReaction'],
    what: 'Transporte por linha do LineSessionManager, abaixo da fronteira.',
  },
  {
    id: 'outbound.provider_adapter',
    module: 'src/runtime/outbound/provider-adapter.ts',
    state: 'infrastructure',
    categories: [],
    primitives: ['sendText', 'sendDocument', 'sendVoice', 'sendPoll', 'sendReaction'],
    what: 'Traduz o payload de #630 na primitiva certa. Sempre sob escopo de outbox.',
  },

  // ── MIGRADOS PARA O OUTBOX DURÁVEL ───────────────────────────────────────
  {
    id: 'agent.output_dispatch',
    module: 'src/agent/output-dispatch.ts',
    state: 'outbox',
    categories: [
      'agent_reply',
      'fallback',
      'timeout',
      'user_visible_error',
      'governance_confirmation',
      'tool_output',
    ],
    primitives: ['sendText', 'sendDocument', 'sendVoice', 'sendPoll'],
    what:
      'Resposta do turno em TODAS as variantes: texto, `status_fallback`, documento ' +
      '(PDF de relatório), voz sintetizada e enquete. Cada ramo commita o artefato ' +
      'ANTES do canal e reivindica a entrega com lease.',
  },
  {
    id: 'outbound.delivery',
    module: 'src/runtime/outbound/delivery.ts',
    state: 'outbox',
    categories: [
      'agent_reply',
      'fallback',
      'timeout',
      'user_visible_error',
      'governance_confirmation',
      'tool_output',
      'reaction',
    ],
    primitives: [],
    what:
      'O delivery worker: carrega a row, reivindica com fence e chama o adaptador ' +
      'dentro do escopo de egresso do outbox.',
  },

  // ── EXCEÇÕES DECLARADAS ──────────────────────────────────────────────────
  {
    id: 'agent.message_update_owner_review',
    module: 'src/agent/message-update.ts',
    state: 'declared_exception',
    categories: ['governance_confirmation'],
    primitives: ['sendText'],
    what: 'Pergunta ao DONO sobre uma edição de mensagem detectada.',
    reason:
      'A saída é dirigida a OUTRA pessoa (o dono) e a OUTRA conversa, não ao ' +
      'interlocutor do turno. O outbox de #631 chaveia a saída lógica por ' +
      '(turn_id, sequence_in_turn) e aponta o ponteiro do turno para ela — uma ' +
      'saída para outro destinatário no mesmo turno colidiria com a resposta ao ' +
      'usuário ou exigiria uma sequência com semântica que a fatia B não definiu.',
    containment:
      'Best-effort e idempotente pelo lado do dono: a pendência de revisão já ' +
      'existe no banco antes do envio, então uma mensagem perdida vira lembrete, ' +
      'nunca decisão perdida.',
    blocked_by: 'foreign_recipient',
    remediation:
      'Definir no contrato de #630 o que é a saída lógica de um turno dirigida a ' +
      'TERCEIRO: ou uma faixa reservada de `sequence_in_turn` com o destinatário no ' +
      'artefato (hoje o JID vem do ingresso do job, por `conversa_id`), ou uma âncora ' +
      'durável própria. Enquanto o destinatário for derivado da conversa da row, o ' +
      'artefato e o turno que o cerca discordariam sobre para quem a mensagem vai.',
  },
  {
    id: 'agent.react_loop_tool_reaction',
    module: 'src/agent/react-loop.ts',
    state: 'declared_exception',
    categories: ['reaction'],
    primitives: ['sendReaction'],
    what: 'Reação ✅/❌ na mensagem do usuário conforme a tool foi aceita ou recusada.',
    reason:
      'É um sinal EFÊMERO sobre a mensagem de ENTRADA, emitido no meio do loop e ' +
      'possivelmente várias vezes num turno. O contrato de #630 tem `reaction`, mas ' +
      'a primitiva do Baileys devolve `void` — sem id e sem confirmação —, então um ' +
      'artefato durável para ela nasceria em `delivery_unknown` e alimentaria a fila ' +
      'de reconciliação humana de #633 com ruído que não representa mensagem ' +
      'nenhuma para o usuário.',
    containment:
      'Best-effort com `.catch` que só suprime a reação; a resposta do turno é ' +
      'independente. Uma reação perdida não é uma resposta perdida.',
    blocked_by: 'ephemeral_signal_without_provider_id',
    remediation:
      'Duas coisas, nesta ordem. (a) Uma capability de provedor que confirme reação — ' +
      'hoje `sendReaction` devolve `void` e `provider-adapter.ts:189` só pode ' +
      'classificar `accepted_without_id`; (b) enquanto ela não existir, um desfecho ' +
      'TERMINAL honesto para saídas sem confirmação possível, para que a reação não ' +
      'entre na fila humana de #633. Sem (a) ou (b), migrar troca "reação perdida em ' +
      'silêncio" por "uma linha de trabalho de operador por reação".',
  },
  {
    id: 'identity.quarantine',
    module: 'src/identity/quarantine.ts',
    state: 'declared_exception',
    categories: ['administrative'],
    primitives: ['sendText'],
    what: 'Mensagens do fluxo de quarentena (aguardando confirmação, aceito, bloqueado).',
    reason:
      'Roda ANTES de existir turno: a quarentena decide se a mensagem sequer entra ' +
      'no runtime. Sem `turn_id` não há transação de commit possível — o outbox de ' +
      '#631 o exige NOT NULL e faz fence do `claim_token` do turno.',
    containment:
      'Estado da quarentena é durável em `pessoas.status` + pendência; a mensagem é ' +
      'um aviso sobre esse estado, e o estado sobrevive à perda do aviso.',
    blocked_by: 'no_turn_to_anchor',
    remediation:
      'A quarentena roda ANTES da criação do turno — ela decide se a mensagem entra no ' +
      'runtime. Só desbloqueia com âncora durável para saída sem turno; um turno ' +
      'sintético só para carregar o aviso inverteria a decisão que a quarentena existe ' +
      'para tomar.',
  },
  {
    id: 'scheduling.outbox_drain',
    module: 'src/scheduling/outbox-drain.ts',
    state: 'declared_exception',
    categories: ['administrative'],
    primitives: ['sendText'],
    what: 'Drena o outbox transacional do AGENDAMENTO (lembretes, alertas proativos).',
    reason:
      'Já É um outbox durável, com claim, retry, backoff e DLQ próprios, e sem ' +
      '`turn_id` (uma mensagem agendada não pertence a turno nenhum). Migrar seria ' +
      'aninhar um outbox dentro de outro; a fusão dos dois ledgers é trabalho ' +
      'próprio e a issue-mãe não a pede.',
    containment:
      'Persistência antes do envio, claim com lease e DLQ — as mesmas propriedades ' +
      'que a épica exige, num ledger separado.',
    blocked_by: 'competing_durable_ledger',
    remediation:
      'Fundir `scheduling_outbox` e `outbound_messages` num ledger só, com migração de ' +
      'dados e UMA autoridade de envio. Enquanto os dois existirem, ligar o drain ao ' +
      'outbox do turno criaria dois senders autoritativos para a mesma linha — o ' +
      'cenário que a §Rollback da issue proíbe nominalmente.',
  },
  {
    id: 'tools.approval_notification',
    module: 'src/tools/_dispatcher.ts',
    state: 'declared_exception',
    categories: ['governance_confirmation'],
    primitives: ['sendText'],
    what: 'Notifica os aprovadores de que uma tool sensível pediu aprovação.',
    reason:
      'Destinatários são os APROVADORES, não o interlocutor do turno — mesma ' +
      'colisão de identidade lógica da revisão de edição. O request de aprovação ' +
      'persistido é a fonte de verdade; a notificação é o aviso sobre ele.',
    containment:
      '`approval_requests` (migração 095) é durável e tem expiração própria; um ' +
      'aviso perdido não perde a aprovação, e o pedido expira com auditoria.',
    blocked_by: 'foreign_recipient',
    remediation:
      'Mesma dependência da revisão de edição: uma identidade lógica de saída dirigida a ' +
      'terceiro. Acresce um agravante próprio — os aprovadores são N pessoas, então a ' +
      'saída é um FAN-OUT, e o outbox de #631 chaveia uma saída por ' +
      '(turn_id, sequence_in_turn) para um destinatário.',
  },
  {
    id: 'workers.briefings',
    module: 'src/workers/briefings.ts',
    state: 'declared_exception',
    categories: ['administrative'],
    primitives: ['sendText'],
    what: 'Briefings periódicos (manhã/tarde/noite) para os donos do agente.',
    reason: 'Proativo sem turno e sem conversa de origem — não há `turn_id` a cercar.',
    containment:
      'Best-effort por dono, com `logger.warn` por falha. Um briefing perdido é ' +
      'reposto pelo próximo ciclo; não há decisão do usuário pendurada nele.',
    blocked_by: 'no_turn_to_anchor',
    remediation:
      'Âncora durável para saída proativa. Note que o valor seria BAIXO: um briefing ' +
      'atrasado é substituído pelo do ciclo seguinte, então entrega garantida de um ' +
      'briefing velho é pior produto do que perdê-lo.',
  },
  {
    id: 'workers.idempotency_relayer',
    module: 'src/workers/idempotency-outbox-relayer.ts',
    state: 'declared_exception',
    categories: ['administrative'],
    primitives: ['sendText'],
    what: 'Relayer do outbox de EFEITOS idempotentes (issue #278).',
    reason:
      'Segundo outbox durável do repositório, também sem `turn_id`, e o único ' +
      'que já passa `messageId` determinístico ao Baileys. Mesma decisão do ' +
      '`scheduling.outbox_drain`.',
    containment:
      'Chave de dedupe do provedor derivada da identidade da row; retry e DLQ ' +
      'próprios.',
    blocked_by: 'competing_durable_ledger',
    remediation:
      'Mesma fusão de ledgers do `scheduling.outbox_drain`. É a rota com MENOS a ganhar ' +
      'da migração: ela já passa `messageId` determinístico ao Baileys, que é ' +
      'exatamente a propriedade que `provider_idempotency_key` existe para dar.',
  },
  {
    id: 'workers.pending_reminder',
    module: 'src/workers/pending-reminder.ts',
    state: 'declared_exception',
    categories: ['administrative'],
    primitives: ['sendText'],
    what: 'Cutuca uma pergunta pendente sem resposta.',
    reason:
      'Proativo, disparado por varredura de `pending_questions`, sem `turn_id`. ' +
      'A contagem de lembretes e o teto vivem na própria row.',
    containment:
      '`reminder_count` é incrementado com CAS ANTES do envio, então uma falha de ' +
      'envio não gera dois lembretes; o teto limita o total.',
    blocked_by: 'no_turn_to_anchor',
    remediation:
      'Âncora durável para saída proativa. O CAS de `reminder_count` já dá a ' +
      'idempotência lógica — o que falta é o artefato durável e a entrega com lease.',
  },
  {
    id: 'workflows.dual_approval',
    module: 'src/workflows/dual-approval.ts',
    state: 'declared_exception',
    categories: ['governance_confirmation'],
    primitives: ['sendText'],
    what: 'Notificações 4-eyes: pedido, aprovação, recusa e expiração.',
    reason: 'Destinatários são os aprovadores; sem turno. Mesma razão da notificação de tool.',
    containment: 'O workflow persistido é a fonte de verdade; a notificação é aviso sobre ele.',
    blocked_by: 'foreign_recipient',
    remediation:
      'Mesma identidade lógica de saída para terceiro da notificação de tool, e o mesmo ' +
      'fan-out para N aprovadores. As duas rotas desbloqueiam juntas ou nenhuma.',
  },
  {
    id: 'workflows.engine',
    module: 'src/workflows/engine.ts',
    state: 'declared_exception',
    categories: ['governance_confirmation'],
    primitives: ['sendText'],
    what: 'Avisa o solicitante quando um pedido de aprovação EXPIRA.',
    reason: 'Roda no tick do engine, fora de qualquer turno.',
    containment:
      'A expiração é gravada e auditada ANTES do aviso; o `catch` do tick impede que ' +
      'uma notificação perdida trave a varredura.',
    blocked_by: 'no_turn_to_anchor',
    remediation:
      'Âncora durável para saída proativa. O tick do engine não tem turno e não pode ' +
      'ter: ele varre expirações de N workflows de uma vez.',
  },
]);

export type OutboundSendPathId = string;

// =====================================================================
// A CATRACA — o mecanismo que impede a décima primeira exceção
// =====================================================================

/**
 * Issue #506 (auditoria de fechamento) — *"teste arquitetural impedindo novas
 * rotas paralelas"*.
 *
 * ─── O buraco que esta lista fecha ──────────────────────────────────────────
 *
 * A #634 entregou duas travas, e as duas param o mesmo caso:
 *
 *   - a varredura estática de `outbound-trava-envio-direto.spec.ts` reprova um
 *     `line.sendText(` num módulo que o inventário não conhece;
 *   - `withDeclaredEgressException` recusa, em runtime, um `path_id` que não
 *     esteja aqui.
 *
 * As duas dizem *"inventarie antes de enviar"*. Nenhuma diz *"pare de
 * inventariar"* — e a décima primeira exceção nasce exatamente por onde as
 * duas mandam: acrescenta-se uma entrada com `state:'declared_exception'`, o
 * `reason` e o `containment` são preenchidos de boa-fé, tudo fica verde, e o
 * inventário cresce. Foi assim que dez chegaram a dez.
 *
 * ─── O que a catraca faz ────────────────────────────────────────────────────
 *
 * Esta lista é o conjunto RATIFICADO de exceções. `assertRatifiedInventory`
 * roda no CARREGAMENTO deste módulo: uma exceção declarada cujo id não esteja
 * aqui derruba o import — não o teste, o import. Como `egress-guard.ts` importa
 * daqui e `line-output.ts` importa dele, uma rota paralela nova não chega a
 * enviar nada em lugar nenhum; o processo não sobe.
 *
 * ─── APPEND É PROIBIDO. Esta lista SÓ ENCOLHE. ──────────────────────────────
 *
 * Acrescentar um id aqui não é "registrar uma exceção": é revogar a decisão do
 * dono da épica de que o inventário fecha em zero. Quem migrar uma rota REMOVE
 * a entrada do inventário e o id daqui, na mesma PR, e o número abaixo cai
 * junto.
 *
 * A catraca não é inviolável — nada em código é, contra quem edita o código. O
 * que ela garante é que a violação não pode ser distraída: exige três edições
 * coordenadas (a entrada, este id e o teto) em duas camadas, e cada uma delas é
 * uma linha vermelha num diff.
 */
export const RATIFIED_EXCEPTION_IDS = Object.freeze([
  'agent.message_update_owner_review',
  'agent.react_loop_tool_reaction',
  'identity.quarantine',
  'scheduling.outbox_drain',
  'tools.approval_notification',
  'workers.briefings',
  'workers.idempotency_relayer',
  'workers.pending_reminder',
  'workflows.dual_approval',
  'workflows.engine',
] as const);

/**
 * O TETO de exceções declaradas. Redundante com a lista acima por construção — e
 * é a redundância que interessa.
 *
 * A lista responde *"esta rota específica foi ratificada?"*; o teto responde
 * *"quantas existem?"*, e é a pergunta que aparece num code review de uma linha.
 * Um número literal que precisa subir é a coisa mais difícil de justificar num
 * diff, que é exatamente a fricção que se quer.
 *
 * SÓ DIMINUI.
 */
export const MAX_DECLARED_EXCEPTIONS = 10;

/**
 * A catraca, como função pura — para que o teste possa alimentá-la com um
 * inventário FALSO (uma rota paralela de mentira) e ver a recusa, sem mexer no
 * array congelado da produção.
 *
 * Lança na primeira violação. Todas as quatro condições são erro de
 * PROGRAMAÇÃO, não desfecho de execução: não há caminho em que a resposta certa
 * seja registrar e seguir.
 */
export function assertRatifiedInventory(paths: readonly OutboundSendPath[]): void {
  const ratificados = new Set<string>(RATIFIED_EXCEPTION_IDS);
  const excecoes = paths.filter((p) => p.state === 'declared_exception');

  for (const e of excecoes) {
    if (!ratificados.has(e.id)) {
      throw new Error(
        `outbound send-path inventory: '${e.id}' é uma exceção NÃO RATIFICADA. ` +
          `A épica #506 fechou o inventário: uma rota nova passa pelo outbox durável ` +
          `(commitTurnOutboundTx), não por uma exceção nova. Se você acredita que esta ` +
          `rota tem impedimento técnico, ele precisa ser ratificado em ` +
          `RATIFIED_EXCEPTION_IDS — e essa lista só encolhe.`,
      );
    }
    // Sem impedimento tipado, a exceção é adiamento com redação — que é
    // literalmente o que o dono chamou de "exceção meramente inventariada".
    if (!e.blocked_by) {
      throw new Error(
        `outbound send-path inventory: exceção '${e.id}' sem 'blocked_by'. ` +
          `Toda exceção declara o IMPEDIMENTO técnico, do vocabulário fechado ` +
          `OUTBOUND_EXCEPTION_BLOCKERS.`,
      );
    }
    if (!e.remediation || e.remediation.trim().length === 0) {
      throw new Error(
        `outbound send-path inventory: exceção '${e.id}' sem 'remediation'. ` +
          `Toda exceção descreve o trabalho concreto que a APAGA.`,
      );
    }
  }

  if (excecoes.length > MAX_DECLARED_EXCEPTIONS) {
    throw new Error(
      `outbound send-path inventory: ${excecoes.length} exceções declaradas, teto ` +
        `MAX_DECLARED_EXCEPTIONS=${MAX_DECLARED_EXCEPTIONS}. O teto SÓ DIMINUI.`,
    );
  }
}

// Fail-closed no CARREGAMENTO do módulo, e não só no teste. `egress-guard.ts`
// importa daqui e `src/gateway/line-output.ts` importa dele: um inventário
// inválido derruba o processo antes de qualquer envio, em vez de esperar a
// suíte rodar.
assertRatifiedInventory(OUTBOUND_SEND_PATHS);

const BY_ID = new Map(OUTBOUND_SEND_PATHS.map((p) => [p.id, p]));

/** Os módulos que o teste de arquitetura reconhece como inventariados. */
export function inventoriedModules(): readonly string[] {
  return OUTBOUND_SEND_PATHS.map((p) => p.module);
}

export function findSendPath(id: string): OutboundSendPath | undefined {
  return BY_ID.get(id);
}

/**
 * `true` só para entradas `declared_exception`. Um id de módulo já MIGRADO
 * (`agent.output_dispatch`) não pode abrir escopo de exceção: se ele precisar
 * enviar, é pelo outbox.
 */
export function isDeclaredEgressException(id: string): boolean {
  return BY_ID.get(id)?.state === 'declared_exception';
}

export function declaredExceptions(): readonly OutboundSendPath[] {
  return OUTBOUND_SEND_PATHS.filter((p) => p.state === 'declared_exception');
}
