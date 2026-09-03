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
 *
 * ─── A RATIFICAÇÃO (#506): três campos que não existiam ─────────────────────
 *
 * O dono recusou ratificar as seis em bloco, e a direção foi literal:
 *
 *   > "Tragam uma tabela por exceção com callsite, justificativa, controle
 *   >  fail-closed, owner, prazo e condição de remoção."
 *
 * Três dos seis já estavam aqui, espalhados: `module` é o callsite, `reason` é
 * a justificativa, `containment` é o controle. Os outros três não existiam, e
 * agora existem — TIPADOS e OBRIGATÓRIOS pelo compilador, porque
 * `OutboundDeclaredException` é uma variante própria da união e não um punhado
 * de campos opcionais:
 *
 *   `owner`    — conjunto FECHADO (`OUTBOUND_EXCEPTION_OWNERS`). Um campo de
 *                texto aceitaria `"time"` e `""`, e o ADR 0005 já traz
 *                `Owner: Maia maintainers` no cabeçalho — o dono coletivo que
 *                a recusa mira. Quando um prazo vence, um time não recebe
 *                e-mail.
 *   `deadline` — `pendente_do_dono` ou uma DATA que vence, no formato do ledger
 *                de `npm audit` (#526/#574). `expiredExceptions()` reprova
 *                depois dela: é o que impede uma exceção "temporária" de virar
 *                permanente por esquecimento.
 *   `removal`  — o FATO verificável que apaga a entrada, com SONDA. A sonda é a
 *                diferença entre condição e promessa: o teste
 *                `outbound-excecoes-dono-prazo-remocao.spec.ts` fica VERMELHO
 *                no dia em que o símbolo aparecer, dizendo que a condição
 *                passou a valer e a exceção deve sair.
 *
 * **O que o repositório NÃO conseguiu preencher.** `owner` e `deadline` das
 * seis estão `pendente-do-dono`, e isso é um achado, não uma omissão: nada em
 * `src/`, no histórico do git ou nos ADRs designa uma pessoa a qualquer uma
 * delas, nem escreve uma data. Chutar produziria uma tabela que parece
 * completa. `PENDING_OWNER_DECISION_IDS` declara a lacuna e a ratchetea.
 *
 * A tabela renderizada, com as seis colunas lado a lado, está em
 * `docs/architecture/outbound-excecoes-egresso-e-equivalencia-506.md`.
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

/**
 * Issue #506 (ratificação) — QUEM responde por esta exceção.
 *
 * O dono recusou ratificar as seis em bloco e pediu `owner` por linha. Um
 * `owner: string` aceitaria `"time"`, `"a plataforma"` e `""` — e um dono
 * coletivo é exatamente o não-dono que a recusa mira. O ADR 0005 tem
 * `Owner: Maia maintainers` no cabeçalho, e é essa a redação que não pode
 * atravessar para cá.
 *
 * Então o vocabulário é FECHADO, como `OUTBOUND_EXCEPTION_BLOCKERS`: um dono
 * novo é um MEMBRO novo desta lista, e um membro novo aparece no diff.
 *
 * `pendente-do-dono` NÃO é um dono: é a marca de que ninguém foi designado.
 * Ela existe para que a lacuna seja VISÍVEL e contável (ver
 * `PENDING_OWNER_DECISION_IDS`) em vez de ser preenchida por um chute que
 * pareceria completo. Uma entrada com ela está declaradamente incompleta.
 */
export const OUTBOUND_EXCEPTION_OWNERS = [
  /** Dono do repositório e da épica #506 — o login do GitHub, como no ledger de #526. */
  'diogenesmendes01',
  /** NÃO É UM DONO. Marca a ausência de designação; ver `PENDING_OWNER_DECISION_IDS`. */
  'pendente-do-dono',
] as const;

export type OutboundExceptionOwner = (typeof OUTBOUND_EXCEPTION_OWNERS)[number];

/** A marca de ausência de dono, como constante — para não repetir a string. */
export const OWNER_PENDENTE: OutboundExceptionOwner = 'pendente-do-dono';

/**
 * Issue #506 (ratificação) — ATÉ QUANDO esta exceção vale.
 *
 * União discriminada, e não `expires?: string`, porque as duas situações são
 * diferentes e um campo opcional as confunde: "o dono deu prazo" e "ninguém
 * deu prazo" ficariam ambos `undefined` para quem lê o tipo.
 *
 * `prazo` segue o formato do ledger de `npm audit` (`security/audit-exceptions.json`,
 * #526/#574): `YYYY-MM-DD` em UTC, e `expiredExceptions()` REPROVA depois dele.
 * É o mecanismo que impede uma exceção "temporária" de virar permanente por
 * esquecimento.
 */
export type OutboundExceptionDeadline =
  | { readonly kind: 'pendente_do_dono' }
  | { readonly kind: 'prazo'; readonly expires: string };

/**
 * Uma sonda da condição de remoção: um símbolo que HOJE não existe no módulo
 * indicado e cuja APARIÇÃO significa que a condição passou a valer.
 *
 * É o que separa "condição verificável" de "condição bem escrita". A checagem
 * mora no teste (`tests/unit/runtime/outbound-excecoes-dono-prazo-remocao.spec.ts`)
 * e não aqui, porque ela lê o disco — um módulo de produção não faz I/O no
 * import.
 *
 * A checagem é de DUAS pontas, e a segunda é a que importa: se o símbolo
 * APARECER, o teste fica VERMELHO dizendo "a condição de remoção desta exceção
 * está satisfeita — remova a entrada". A condição deixa de ser uma promessa e
 * vira um alarme.
 */
export interface OutboundRemovalProbe {
  /** Caminho do módulo relativo à raiz do repo. */
  readonly module: string;
  /** Trecho de CÓDIGO cuja presença em `module` torna a condição verdadeira. */
  readonly symbol: string;
}

/**
 * Issue #506 (ratificação) — A CONDIÇÃO DE REMOÇÃO.
 *
 * O dono pediu "condição de remoção", e é o campo mais fácil de escrever mal:
 * "quando der" e "quando a arquitetura permitir" não são condições, são
 * adiamentos com data aberta. Uma condição de remoção é um FATO VERIFICÁVEL —
 * "quando `X` existir", "quando a issue #N fechar", "quando o call site Y
 * passar a aceitar Z".
 *
 * A estrutura força as três partes de um fato utilizável:
 *
 *   `when`            — o fato, afirmado. FALSO hoje, por construção.
 *   `why_sufficient`  — por que ESTE fato basta para apagar ESTA entrada. Sem
 *                       ele, um fato verdadeiro e irrelevante passaria.
 *   `probes`          — onde a máquina confere. Sem elas, `when` é prosa.
 */
export interface OutboundExceptionRemoval {
  readonly when: string;
  readonly why_sufficient: string;
  /** Ao menos uma. Todas ausentes hoje; todas presentes = condição satisfeita. */
  readonly probes: readonly OutboundRemovalProbe[];
}

interface OutboundSendPathBase {
  /** Id estável. É o valor passado a `withDeclaredEgressException`. */
  readonly id: string;
  /** Caminho do módulo relativo à raiz do repo — o teste estático casa por ele. */
  readonly module: string;
  readonly categories: readonly OutboundPathCategory[];
  /** Primitivas de `LineOutput` que este módulo chama. */
  readonly primitives: readonly string[];
  /** O que este caminho envia, em uma frase. */
  readonly what: string;
}

/** Rota migrada, ou o próprio cano. Não carrega justificativa porque não deve nenhuma. */
export interface OutboundMigratedPath extends OutboundSendPathBase {
  readonly state: 'outbox' | 'infrastructure';
}

/**
 * Uma exceção declarada, com TODOS os campos obrigatórios pelo COMPILADOR.
 *
 * A #634 deixou `reason`/`containment`/`blocked_by`/`remediation` opcionais no
 * tipo e cobrados só por `assertRatifiedInventory` — ou seja, no import, em
 * runtime. A ratificação de #506 acrescenta três campos (`owner`, `deadline`,
 * `removal`) e move a cobrança para onde ela custa menos: uma exceção sem dono
 * ou sem condição de remoção **não compila**. A checagem de runtime continua
 * existindo (ela pega o que atravessa um `as`), mas deixou de ser a única.
 */
export interface OutboundDeclaredException extends OutboundSendPathBase {
  readonly state: 'declared_exception';
  /** Por que ainda não passa pelo outbox. */
  readonly reason: string;
  /** O que segura o risco hoje — o controle fail-closed desta rota. */
  readonly containment: string;
  /**
   * O IMPEDIMENTO técnico, do vocabulário fechado. É o campo que torna a
   * exceção uma decisão e não um adiamento.
   */
  readonly blocked_by: OutboundExceptionBlocker;
  /**
   * O que, concretamente, precisa existir para que esta rota passe pelo
   * outbox. Escrito como trabalho, não como desejo — é o que alguém executaria
   * para APAGAR esta entrada.
   */
  readonly remediation: string;
  /** Quem responde por ela. Conjunto FECHADO. */
  readonly owner: OutboundExceptionOwner;
  /** Até quando ela vale. */
  readonly deadline: OutboundExceptionDeadline;
  /** O fato verificável que a apaga. */
  readonly removal: OutboundExceptionRemoval;
}

export type OutboundSendPath = OutboundMigratedPath | OutboundDeclaredException;

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
    blocked_by: 'foreign_recipient',
    remediation:
      'Definir no contrato de #630 o que é a saída lógica de um turno dirigida a ' +
      'TERCEIRO: ou uma faixa reservada de `sequence_in_turn` com o destinatário no ' +
      'artefato (hoje o JID vem do ingresso do job, por `conversa_id`), ou uma âncora ' +
      'durável própria. Enquanto o destinatário for derivado da conversa da row, o ' +
      'artefato e o turno que o cerca discordariam sobre para quem a mensagem vai.',
    owner: OWNER_PENDENTE,
    deadline: { kind: 'pendente_do_dono' },
    removal: {
      when:
        '`commitStandaloneOutbound` existir em `src/runtime/outbound/commit.ts` e ' +
        '`deliverOutbound` aceitar a família `anchor_kind` — a coorte 3 da §5 do ADR ' +
        '`docs/architecture/decisions/0005-outbox-sem-turno.md`.',
      why_sufficient:
        'O que falta a esta rota é o COMMIT sem turno; o RETORNO que `reason` invoca já ' +
        'existe do outro lado. `src/runtime/outbound/historico.ts:132` grava ' +
        '`whatsapp_id: ctx.provider_message_id` — o ciclo de entrega já persiste no ' +
        'histórico exatamente o id que o call site hoje precisa capturar à mão. Com o ' +
        'commit standalone, o call site deixa de depender do valor de retorno do envio, ' +
        'e a perda que `reason` teme (a pergunta sumir do histórico do dono) deixa de ' +
        'ser possível.',
      probes: [
        { module: 'src/runtime/outbound/commit.ts', symbol: 'commitStandaloneOutbound' },
        { module: 'src/runtime/outbound/delivery.ts', symbol: 'anchor_kind' },
      ],
    },
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
      'não carrega informação que a resposta já não carregue. Esta entrada não ' +
      'espera uma fatia DESTA épica: ela é a decisão de que o sinal efêmero fica ' +
      'fora do ledger durável enquanto a primitiva do provedor não devolver id. O ' +
      'que a apaga está em `remediation`, e é do provedor, não do outbox.',
    blocked_by: 'ephemeral_signal_without_provider_id',
    remediation:
      'Duas coisas, nesta ordem. (a) Uma capability de provedor que confirme reação — ' +
      'hoje `sendReaction` devolve `void` e `provider-adapter.ts:189` só pode ' +
      'classificar `accepted_without_id`; (b) enquanto ela não existir, um desfecho ' +
      'TERMINAL honesto para saídas sem confirmação possível, para que a reação não ' +
      'entre na fila humana de #633. Sem (a) ou (b), migrar troca "reação perdida em ' +
      'silêncio" por "uma linha de trabalho de operador por reação". Se um dia ' +
      '(a) existir, o `reaction` do contrato de #630 já existe e a migração é de ' +
      'call site.',
    owner: OWNER_PENDENTE,
    deadline: { kind: 'pendente_do_dono' },
    removal: {
      when:
        '`reaction` deixar de ser `PROVIDER_IDEMPOTENCY_NONE` na tabela ' +
        '`WHATSAPP_IDEMPOTENCY` de `src/runtime/outbound/delivery-contract.ts` — isto é, ' +
        'quando o provedor passar a confirmar reação com identificador.',
      why_sufficient:
        'É o item (a) da `remediation`, e é o único fato que muda a aritmética do ' +
        'desfecho. Enquanto `sendReaction` devolve `void`, `provider-adapter.ts` só pode ' +
        'classificar `accepted_without_id`, a linha nasce `delivery_unknown` e ' +
        '`reconciliationDisposition` a manda para a fila HUMANA de #633. Com a ' +
        'capability nativa declarada, o desfecho vira confirmável, e o `reaction` do ' +
        'contrato de #630 já existe: a migração passa a ser de call site. ATENÇÃO: o ' +
        'item (b) da `remediation` (um desfecho terminal honesto para saída sem ' +
        'confirmação possível) NÃO satisfaz esta sonda — ele apaga a exceção por outro ' +
        'caminho e exigiria reescrever esta condição.',
      probes: [
        {
          module: 'src/runtime/outbound/delivery-contract.ts',
          symbol: 'reaction: PROVIDER_IDEMPOTENCY_NATIVE',
        },
      ],
    },
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
    blocked_by: 'no_turn_to_anchor',
    remediation:
      'A quarentena roda ANTES da criação do turno — ela decide se a mensagem entra no ' +
      'runtime. Só desbloqueia com âncora durável para saída sem turno; um turno ' +
      'sintético só para carregar o aviso inverteria a decisão que a quarentena existe ' +
      'para tomar.',
    owner: OWNER_PENDENTE,
    deadline: { kind: 'pendente_do_dono' },
    removal: {
      when:
        '`commitStandaloneOutbound` existir em `src/runtime/outbound/commit.ts` e ' +
        '`deliverOutbound` aceitar a família `anchor_kind` — a coorte 1 da §5 do ADR ' +
        '`docs/architecture/decisions/0005-outbox-sem-turno.md`.',
      why_sufficient:
        'A coorte 1 do ADR é literalmente esta rota, e ela responde às DUAS objeções ' +
        'escritas em `reason`: a âncora sem turno resolve "não há `TurnHandle` para ' +
        'cercar", e a entrega IMEDIATA na mesma chamada (em vez de enfileirar num drain ' +
        'de cadência de 1 minuto) preserva o eco síncrono que é a razão de a mensagem ' +
        'existir. Nada aqui depende de o drain de agendamento mudar.',
      probes: [
        { module: 'src/runtime/outbound/commit.ts', symbol: 'commitStandaloneOutbound' },
        { module: 'src/runtime/outbound/delivery.ts', symbol: 'anchor_kind' },
      ],
    },
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
    blocked_by: 'competing_durable_ledger',
    remediation:
      'Fundir `scheduling_outbox` e `outbound_messages` num ledger só, com migração de ' +
      'dados e UMA autoridade de envio. Enquanto os dois existirem, ligar o drain ao ' +
      'outbox do turno criaria dois senders autoritativos para a mesma linha — o ' +
      'cenário que a §Rollback da issue proíbe nominalmente.',
    owner: OWNER_PENDENTE,
    deadline: { kind: 'pendente_do_dono' },
    removal: {
      when:
        '`commitStandaloneOutbound` existir em `src/runtime/outbound/commit.ts` e ' +
        '`deliverOutbound` aceitar a família `anchor_kind` — a coorte 4 da §5 do ADR ' +
        '`docs/architecture/decisions/0005-outbox-sem-turno.md`.',
      why_sufficient:
        'O impedimento é `competing_durable_ledger`, e o que ele proíbe é LIGAR o ' +
        'emissor novo sem DESLIGAR o antigo. A coorte 4 do ADR faz a troca no mesmo ' +
        'commit: o drain para de chamar `line.sendText` e passa a commitar standalone, ' +
        'com `deliverOutbound` como único sender. `outbox_messages` continua existindo ' +
        'como AGENDADOR — o que some é o segundo sender, que é a única coisa que a ' +
        '§Rollback proíbe.',
      probes: [
        { module: 'src/runtime/outbound/commit.ts', symbol: 'commitStandaloneOutbound' },
        { module: 'src/runtime/outbound/delivery.ts', symbol: 'anchor_kind' },
      ],
    },
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
    blocked_by: 'competing_durable_ledger',
    remediation:
      'Mesma fusão de ledgers do `scheduling.outbox_drain`. É a rota com MENOS a ganhar ' +
      'da migração: ela já passa `messageId` determinístico ao Baileys, que é ' +
      'exatamente a propriedade que `provider_idempotency_key` existe para dar.',
    owner: OWNER_PENDENTE,
    deadline: { kind: 'pendente_do_dono' },
    removal: {
      when:
        '`commitStandaloneOutbound` existir em `src/runtime/outbound/commit.ts` e ' +
        '`deliverOutbound` aceitar a família `anchor_kind` — a coorte 5 da §5 do ADR ' +
        '`docs/architecture/decisions/0005-outbox-sem-turno.md`.',
      why_sufficient:
        'Mesma troca de emissor da coorte 4, com uma exigência a mais que o ADR nomeia: ' +
        'o `messageId` determinístico de hoje vira o `provider_idempotency_key` da row ' +
        'standalone. É o que impede a migração de trocar a garantia forte (idempotência ' +
        'honrada PELO PROVEDOR) pela mais fraca (honrada só pelo nosso ledger) — o risco ' +
        'que `reason` levanta. A coorte 5 é a última do ADR de propósito.',
      probes: [
        { module: 'src/runtime/outbound/commit.ts', symbol: 'commitStandaloneOutbound' },
        { module: 'src/runtime/outbound/delivery.ts', symbol: 'anchor_kind' },
      ],
    },
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
    blocked_by: 'no_turn_to_anchor',
    remediation:
      'Âncora durável para saída proativa. O CAS de `reminder_count` já dá a ' +
      'idempotência lógica — o que falta é o artefato durável e a entrega com lease.',
    owner: OWNER_PENDENTE,
    deadline: { kind: 'pendente_do_dono' },
    removal: {
      when:
        '`commitStandaloneOutbound` existir em `src/runtime/outbound/commit.ts`, ' +
        '`deliverOutbound` aceitar a família `anchor_kind`, e o payload de texto do ' +
        'contrato de #630 (`src/runtime/outbound/contract.ts`) carregar a CHAVE da ' +
        'mensagem citada — a coorte 2 da §5 do ADR ' +
        '`docs/architecture/decisions/0005-outbox-sem-turno.md`.',
      why_sufficient:
        'A âncora sem turno resolve o `blocked_by`, mas sozinha ela entregaria um ' +
        '"Lembra dessa?" SOLTO — a regressão de produto que `reason` descreve. Por isso ' +
        'a terceira sonda: sob o caminho standalone o `{ quoted }` deixa de vir do call ' +
        'site e passa a ter de estar no artefato durável. E é a CHAVE da mensagem, ' +
        'nunca o conteúdo: o payload é persistido e logado.',
      probes: [
        { module: 'src/runtime/outbound/commit.ts', symbol: 'commitStandaloneOutbound' },
        { module: 'src/runtime/outbound/delivery.ts', symbol: 'anchor_kind' },
        { module: 'src/runtime/outbound/contract.ts', symbol: 'quoted' },
      ],
    },
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
  'workers.idempotency_relayer',
  'workers.pending_reminder',
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
export const MAX_DECLARED_EXCEPTIONS = 6;

/**
 * Issue #506 (ratificação) — AS LACUNAS QUE SÃO DO DONO, listadas.
 *
 * O dono recusou ratificar em bloco e pediu `owner` e `prazo` por exceção. O
 * repositório NÃO tem base para preencher nenhum dos dois: nada em `src/`, em
 * `migrations/`, no histórico do git ou nos ADRs designa uma pessoa a nenhuma
 * das seis, e nenhuma data foi escrita para nenhuma delas. O único texto de
 * dono em toda a cadeia é o cabeçalho do ADR 0005 — `Owner: Maia maintainers` —,
 * que é exatamente o dono coletivo que a recusa rejeita.
 *
 * Chutar `diogenesmendes01` nas seis produziria uma tabela que PARECE completa
 * e não é. Deixar o campo de fora produziria uma tabela que envelhece em
 * silêncio. Esta lista é a terceira opção: a lacuna é declarada, contável e
 * ratchetada.
 *
 * ─── SÓ ENCOLHE ────────────────────────────────────────────────────────────
 *
 * Quando o dono designar `owner` (e, querendo, `prazo`) para uma entrada, o id
 * sai DAQUI na mesma PR. Acrescentar um id aqui é declarar uma lacuna nova de
 * governança, e `assertRatifiedInventory` recusa uma exceção pendente cujo id
 * não esteja listado — a lacuna nova não sobe o processo.
 */
export const PENDING_OWNER_DECISION_IDS = Object.freeze([
  'agent.message_update_owner_review',
  'agent.react_loop_tool_reaction',
  'identity.quarantine',
  'scheduling.outbox_drain',
  'workers.idempotency_relayer',
  'workers.pending_reminder',
] as const);

/**
 * `true` quando `owner` ou `deadline` ainda são do dono — a linha está
 * VISIVELMENTE incompleta.
 *
 * Os dois contam porque respondem à mesma pergunta em dois tempos: sem dono
 * não há a quem cobrar, e sem prazo não há quando. Uma linha com dono e sem
 * prazo continua pendente; uma linha com prazo e sem dono é recusada por
 * `assertRatifiedInventory` (um prazo que não vence para ninguém não vence).
 */
export function isPendingOwnerDecision(e: OutboundDeclaredException): boolean {
  return e.owner === OWNER_PENDENTE || e.deadline.kind === 'pendente_do_dono';
}

/**
 * `true` só para uma data de calendário que EXISTE.
 *
 * Cópia deliberada de `isCalendarDate` de `scripts/check-audit-exceptions.ts`
 * (#526): `src/` não importa de `scripts/`, e a alternativa — aceitar
 * `Date.parse` — deixaria `2026-02-31` virar 2026-03-03 em silêncio, dando três
 * dias de vida a uma data que ninguém escreveu.
 */
export function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * As exceções cujo `prazo` JÁ VENCEU em `today` (`YYYY-MM-DD`, UTC).
 *
 * ─── Por que isto NÃO está em `assertRatifiedInventory` ────────────────────
 *
 * `assertRatifiedInventory` roda no import e derruba o processo. Um prazo é
 * uma data que passa sozinha: pendurar a queda do runtime numa data faria uma
 * exceção vencida DERRUBAR A PRODUÇÃO num domingo — trocaria um problema de
 * governança por uma indisponibilidade. O ledger de `npm audit` (#526) já
 * resolveu isso do jeito certo, e este segue o mesmo desenho: o vencimento
 * reprova o CI (`tests/unit/runtime/outbound-excecoes-dono-prazo-remocao.spec.ts`),
 * onde há gente para renovar ou corrigir, e o import continua cobrando só o
 * que é erro de PROGRAMAÇÃO.
 *
 * `today` entra por parâmetro para o teste poder congelar o relógio; puro.
 */
export function expiredExceptions(
  paths: readonly OutboundSendPath[],
  today: string,
): readonly OutboundDeclaredException[] {
  return declaredExceptionsOf(paths).filter(
    (e) => e.deadline.kind === 'prazo' && e.deadline.expires < today,
  );
}

/** `YYYY-MM-DD` em UTC. */
export function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * A catraca, como função pura — para que o teste possa alimentá-la com um
 * inventário FALSO (uma rota paralela de mentira) e ver a recusa, sem mexer no
 * array congelado da produção.
 *
 * Lança na primeira violação. Todas as quatro condições são erro de
 * PROGRAMAÇÃO, não desfecho de execução: não há caminho em que a resposta certa
 * seja registrar e seguir.
 */
export function assertRatifiedInventory(
  paths: readonly OutboundSendPath[],
  /**
   * As pendências DECLARADAS. Entra por parâmetro pela mesma razão que `paths`
   * entra: sem isso, a recusa de "pendência não declarada" seria intestável —
   * hoje as seis exceções estão TODAS na lista, então não existe id de
   * produção que produza a violação. A produção chama com o default.
   */
  pendingIds: readonly string[] = PENDING_OWNER_DECISION_IDS,
): void {
  const ratificados = new Set<string>(RATIFIED_EXCEPTION_IDS);
  const pendentesDeclarados = new Set<string>(pendingIds);
  const donos = new Set<string>(OUTBOUND_EXCEPTION_OWNERS);
  const excecoes = declaredExceptionsOf(paths);

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

    // ── Os TRÊS campos da ratificação de #506. ──────────────────────────────
    // O compilador já os exige (`OutboundDeclaredException`); estas checagens
    // pegam o que atravessa um `as` — e é por um `as` que uma entrada mal
    // formada chegaria aqui.
    if (!donos.has(e.owner)) {
      throw new Error(
        `outbound send-path inventory: exceção '${e.id}' com owner '${e.owner}' fora do ` +
          `vocabulário FECHADO OUTBOUND_EXCEPTION_OWNERS ` +
          `(${OUTBOUND_EXCEPTION_OWNERS.join(', ')}). Dono é pessoa, não time: um valor ` +
          `livre aceitaria "a plataforma" e "", que é o não-dono que a recusa da ` +
          `ratificação em bloco mira.`,
      );
    }
    if (e.deadline.kind === 'prazo') {
      if (!isCalendarDate(e.deadline.expires)) {
        throw new Error(
          `outbound send-path inventory: exceção '${e.id}' com prazo ` +
            `'${e.deadline.expires}' que não é uma data YYYY-MM-DD existente.`,
        );
      }
      if (e.owner === OWNER_PENDENTE) {
        // Um prazo sem dono não vence para ninguém: quando a data chegar, o CI
        // reprova e não há a quem devolver o trabalho.
        throw new Error(
          `outbound send-path inventory: exceção '${e.id}' tem prazo ` +
            `'${e.deadline.expires}' e owner '${OWNER_PENDENTE}'. Prazo exige dono — ` +
            `senão o vencimento reprova o CI sem ter a quem cobrar.`,
        );
      }
    }
    if (isPendingOwnerDecision(e) && !pendentesDeclarados.has(e.id)) {
      throw new Error(
        `outbound send-path inventory: exceção '${e.id}' está pendente do dono ` +
          `(owner='${e.owner}', deadline='${e.deadline.kind}') e não consta de ` +
          `PENDING_OWNER_DECISION_IDS. Uma lacuna de governança nova não entra em ` +
          `silêncio: ou a entrada recebe dono e prazo, ou o id é acrescentado ali — e ` +
          `aquela lista SÓ ENCOLHE.`,
      );
    }
    if (e.removal.when.trim().length === 0 || e.removal.why_sufficient.trim().length === 0) {
      throw new Error(
        `outbound send-path inventory: exceção '${e.id}' sem condição de remoção. ` +
          `'removal.when' é o FATO verificável que a apaga e 'removal.why_sufficient' é ` +
          `por que aquele fato basta. "Quando der" e "quando a arquitetura permitir" não ` +
          `são condições — são adiamentos com data aberta.`,
      );
    }
    if (e.removal.probes.length === 0) {
      throw new Error(
        `outbound send-path inventory: exceção '${e.id}' com condição de remoção sem ` +
          `sonda. Sem 'removal.probes' o fato é prosa: ninguém consegue conferir se ele ` +
          `já vale, e a exceção sobrevive à própria condição.`,
      );
    }
    for (const probe of e.removal.probes) {
      if (probe.module.trim().length === 0 || probe.symbol.trim().length === 0) {
        throw new Error(
          `outbound send-path inventory: exceção '${e.id}' com sonda de remoção ` +
            `incompleta (module='${probe.module}', symbol='${probe.symbol}').`,
        );
      }
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

/**
 * As exceções de um inventário QUALQUER — a forma pura, para o teste alimentar
 * um inventário falso sem tocar no array congelado da produção.
 *
 * O predicado de tipo é o que faz `assertRatifiedInventory` e
 * `expiredExceptions` enxergarem `owner`/`deadline`/`removal` sem `!` nem cast.
 */
export function declaredExceptionsOf(
  paths: readonly OutboundSendPath[],
): readonly OutboundDeclaredException[] {
  return paths.filter((p): p is OutboundDeclaredException => p.state === 'declared_exception');
}

export function declaredExceptions(): readonly OutboundDeclaredException[] {
  return declaredExceptionsOf(OUTBOUND_SEND_PATHS);
}

/** As exceções sem dono ou sem prazo — a coluna que o dono precisa preencher. */
export function pendingOwnerDecisions(): readonly OutboundDeclaredException[] {
  return declaredExceptions().filter(isPendingOwnerDecision);
}
