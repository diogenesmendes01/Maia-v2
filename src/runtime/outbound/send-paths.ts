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
 * ─── CORREÇÃO DE FATO (#506, esta fatia) ────────────────────────────────────
 *
 * A versão anterior deste bloco afirmava que as dez exceções tinham um
 * denominador comum intransponível: "o outbox de #631 exige `turn_id` NOT NULL
 * (migração 121)". **Isso estava errado, e o erro é o que sustentava sete das
 * dez entradas.** O que a migração 121 realmente faz:
 *
 *   - `ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS turn_id uuid;`
 *     — a coluna nasce NULLABLE, e o comentário de catálogo diz o porquê:
 *     "NULL = row legada anterior ao outbox duravel";
 *   - o CHECK `outbound_messages_durable_row_complete_check` é
 *     `CASE WHEN turn_id IS NULL THEN true ELSE (...) END` — ou seja, ele
 *     EXIGE o tuplo durável inteiro quando há turno e não exige nada quando
 *     não há;
 *   - a FK composta `(tenant_id, agent_id, turn_id)` é MATCH SIMPLE (o default
 *     do PostgreSQL): com `turn_id` NULL ela é satisfeita trivialmente, então
 *     não há a que ancorar nem o que cercar;
 *   - o UNIQUE de identidade lógica é
 *     `(tenant_id, agent_id, logical_dedupe_key) WHERE logical_dedupe_key IS
 *     NOT NULL` — ele NÃO depende de `turn_id`, então a proteção contra duplo
 *     envio funciona igual numa row sem turno.
 *
 * A segunda afirmação errada era sobre o DESTINATÁRIO. `foreign_recipient`
 * (saída dirigida ao dono ou aos aprovadores) era descrita como se o outbox
 * amarrasse o destino ao turno. Não amarra: `resolveOutboundDeliveryScope`
 * (`delivery-scope.ts`) resolve o JID a partir de `o.conversa_id` e
 * `o.in_reply_to` DA PRÓPRIA ROW, e `turn_id` não aparece na consulta. O
 * destinatário de uma row é o destinatário da conversa da row.
 *
 * O que de fato bloqueia, então, não é o schema — é CÓDIGO, em dois pontos
 * nomeados:
 *
 *   a. `commitOutboundIntent` (`commit.ts`) exige `getOutboundTurnScope()` e
 *      devolve `no_turn_scope` sem ele;
 *   b. `deliverOutbound` (`delivery.ts`) recusa a row logo na entrada:
 *      `if (!row.turn_id || !row.payload_json || !row.provider_idempotency_key)`.
 *
 * Tornar o outbox do turno capaz de ancorar saída SEM turno é uma mudança de
 * MODELO (o que é a "saída lógica" de um proativo? quem faz o fence quando não
 * há posse de turno? como a reconciliação de #633 distingue as duas famílias?),
 * e a §Rollback da issue-mãe proíbe habilitar dois senders autoritativos
 * durante a transição. Por isso ela é uma PROPOSTA escrita
 * (`docs/architecture/decisions/0005-outbox-sem-turno.md`) e não um commit.
 *
 * ─── O que ESTA fatia eliminou ──────────────────────────────────────────────
 *
 * Quatro entradas saíram do inventário porque os módulos PARARAM de falar com o
 * canal, não porque a redação melhorou:
 *
 *   `workers.briefings`, `workflows.dual_approval`, `workflows.engine` e
 *   `tools.approval_notification` passaram a comprometer o aviso em
 *   `outbox_messages` via `src/runtime/outbound/proactive-notice.ts`. O ledger
 *   de agendamento (migração 007, drenado por `scheduling/outbox-drain.ts`) dá
 *   a eles as propriedades que a épica exige — persistir antes de enviar,
 *   claim com lease, backoff, DLQ auditada — e a idempotência por `dedup_key`
 *   que eles não tinham. Antes, cada um desses quatro era um `sendText` cujo
 *   fracasso o PostgreSQL nunca registrava.
 *
 * Isso NÃO os faz passar pelo outbox do TURNO, e o inventário não finge que
 * faz: o egresso deles agora está concentrado em `scheduling.outbox_drain`,
 * que continua declarado como exceção. A diferença é que a fusão dos dois
 * ledgers passou a ter UM ponto de aplicação em vez de cinco.
 *
 * ─── As seis que sobraram ───────────────────────────────────────────────────
 *
 * Cada uma tem justificativa PRÓPRIA em `reason`, e nenhuma delas é "ainda não
 * deu tempo". Em resumo:
 *
 *   - `scheduling.outbox_drain` + `workers.idempotency_relayer` — já SÃO
 *     ledgers duráveis; o trabalho é fusão, não migração;
 *   - `agent.message_update_owner_review` + `workers.pending_reminder` —
 *     dependem de algo que o ledger de agendamento ainda não carrega (o id do
 *     provedor para o histórico; a citação da mensagem original);
 *   - `identity.quarantine` — roda ANTES de existir turno e responde na mesma
 *     inspiração da mensagem que a disparou;
 *   - `agent.react_loop_tool_reaction` — sinal efêmero cuja primitiva devolve
 *     `void`.
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
      'A saída é dirigida a OUTRA pessoa (o dono) e a OUTRA conversa. O que a ' +
      'separa dos quatro avisos que ESTA fatia moveu para o ledger de agendamento ' +
      'NÃO é o destinatário — `resolveOutboundDeliveryScope` resolve o JID pela ' +
      '`conversa_id` da própria row —, é o RETORNO: o call site usa o id do ' +
      'provedor devolvido pelo envio para gravar a mensagem em `mensagens` ' +
      '(`metadata.whatsapp_id`), que é o que mantém a conversa do dono íntegra e o ' +
      'que liga a pergunta à `pending_question`. `enqueueProactiveNotice` devolve ' +
      '"comprometido", não "enviado", e o drain de agendamento não persiste ' +
      'histórico. Migrar sem resolver isso apagaria a pergunta do histórico do ' +
      'dono — trocar uma perda rara (o envio falhar) por uma perda certa (o ' +
      'registro nunca existir).',
    containment:
      'Best-effort e idempotente pelo lado do dono: a pendência de revisão já ' +
      'existe no banco antes do envio, então uma mensagem perdida vira lembrete, ' +
      'nunca decisão perdida.',
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
      'independente. Uma reação perdida não é uma resposta perdida — e é o único ' +
      'item do inventário do qual isso é literalmente verdade, porque uma reação ' +
      'não carrega informação que a resposta já não carregue. Esta entrada NÃO ' +
      'espera uma fatia futura: ela é uma decisão de que o sinal efêmero fica fora ' +
      'do ledger durável enquanto a primitiva do provedor não devolver id. Se um ' +
      'dia devolver, o `reaction` do contrato de #630 já existe e a migração é de ' +
      'call site.',
  },
  {
    id: 'identity.quarantine',
    module: 'src/identity/quarantine.ts',
    state: 'declared_exception',
    categories: ['administrative'],
    primitives: ['sendText'],
    what: 'Mensagens do fluxo de quarentena (aguardando confirmação, aceito, bloqueado).',
    reason:
      'Roda ANTES de existir turno — a quarentena decide se a mensagem sequer entra ' +
      'no runtime —, então não há `TurnHandle` para `commitOutboundIntent` cercar. ' +
      'O que a impede de seguir os quatro avisos que ESTA fatia moveu para o ledger ' +
      'de agendamento é outra coisa, e é de PRODUTO: ela é a resposta SÍNCRONA a ' +
      'uma mensagem que a pessoa acabou de mandar ("recebi, estou aguardando ' +
      'confirmação do dono"). Enfileirar num drain de cadência de 1 minuto ' +
      'transformaria um eco imediato num silêncio de até um minuto para quem está ' +
      'olhando a tela — e o silêncio é justamente o que a mensagem existe para ' +
      'evitar. Migrá-la exige um caminho de baixa latência no ledger, não uma ' +
      'mudança de call site.',
    containment:
      'Estado da quarentena é durável em `pessoas.status` + pendência; a mensagem é ' +
      'um aviso sobre esse estado, e o estado sobrevive à perda do aviso.',
  },
  {
    id: 'scheduling.outbox_drain',
    module: 'src/scheduling/outbox-drain.ts',
    state: 'declared_exception',
    categories: ['administrative'],
    primitives: ['sendText'],
    what: 'Drena o outbox transacional do AGENDAMENTO (lembretes, alertas proativos).',
    reason:
      'Já É um outbox durável, com claim, retry, backoff e DLQ próprios. Migrar o ' +
      'call site seria aninhar um outbox dentro de outro — DOIS senders ' +
      'autoritativos sobre a mesma saída, que é o que a §Rollback da issue-mãe ' +
      'proíbe explicitamente. O trabalho real é a FUSÃO dos ledgers: `outbox_drain` ' +
      'deixa de chamar o canal e passa a commitar em `outbound_messages`, com ' +
      '`deliverOutbound` como único sender. Isso depende da âncora sem turno ' +
      'proposta em `docs/architecture/decisions/0005-outbox-sem-turno.md`. ESTA ' +
      'fatia aumentou o valor dessa fusão: quatro emissores que falavam direto com ' +
      'o canal agora desembocam aqui, então fundir este ponto resolve cinco rotas ' +
      'de uma vez.',
    containment:
      'Persistência antes do envio, claim com lease e DLQ — as mesmas propriedades ' +
      'que a épica exige, num ledger separado.',
  },
  {
    id: 'workers.idempotency_relayer',
    module: 'src/workers/idempotency-outbox-relayer.ts',
    state: 'declared_exception',
    categories: ['administrative'],
    primitives: ['sendText'],
    what: 'Relayer do outbox de EFEITOS idempotentes (issue #278).',
    reason:
      'Segundo outbox durável do repositório e o único que já passa `messageId` ' +
      'determinístico ao Baileys — ou seja, o único cuja idempotência é honrada ' +
      'PELO PROVEDOR e não só pelo nosso ledger. Mesma decisão do ' +
      '`scheduling.outbox_drain`: dois senders autoritativos é o que não pode ' +
      'existir, então o caminho é a fusão dos ledgers e não a duplicação do ' +
      'emissor. Perder aqui o `messageId` determinístico durante uma migração ' +
      'parcial seria trocar uma garantia forte por uma mais fraca.',
    containment:
      'Chave de dedupe do provedor derivada da identidade da row; retry e DLQ ' +
      'próprios.',
  },
  {
    id: 'workers.pending_reminder',
    module: 'src/workers/pending-reminder.ts',
    state: 'declared_exception',
    categories: ['administrative'],
    primitives: ['sendText'],
    what: 'Cutuca uma pergunta pendente sem resposta.',
    reason:
      'Proativo e sem turno, como os quatro avisos que ESTA fatia moveu para o ' +
      'ledger de agendamento — mas com um requisito que aquele ledger ainda não ' +
      'exprime: o lembrete é enviado com `{ quoted }`, CITANDO a pergunta original ' +
      'no WhatsApp, e `WhatsappTextPayload` (`src/scheduling/types.ts`) só carrega ' +
      '`{ jid, text }`. Enfileirar hoje entregaria um "Lembra dessa?" solto, sem a ' +
      'pergunta a que ele se refere — uma regressão de produto disfarçada de ' +
      'migração. O que desbloqueia é estender o payload do ledger para carregar a ' +
      'referência citada (a CHAVE da mensagem, nunca o conteúdo dela: o payload é ' +
      'persistido e logado), e isso é trabalho do contrato do ledger.',
    containment:
      '`reminder_count` é incrementado com CAS ANTES do envio, então uma falha de ' +
      'envio não gera dois lembretes; o teto limita o total.',
  },
]);

export type OutboundSendPathId = string;

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
