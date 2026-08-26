/**
 * Issue #504 — contrato PURO do claim atômico, do lease e do fencing.
 *
 * Como `contract.ts` (#503), este módulo é deliberadamente sem I/O: sem `db`,
 * sem ALS, sem timers. Ele define o VOCABULÁRIO que o repositório
 * (`src/db/repositories/turn-repos.ts`) executa em SQL e que o controlador de
 * lease (`src/runtime/turns/lease.ts`) orquestra. Isso o torna testável sem
 * Postgres e mantém uma única definição das regras de elegibilidade.
 *
 * ─── Por que o claim NÃO entra na tabela de transições de #503 ───────────────
 *
 * `TURN_TRANSITIONS` descreve arestas que dependem SÓ do estado de origem. As
 * arestas do takeover — `claimed -> claimed` e `running -> claimed` — não são
 * dessas: elas só existem quando `lease_expires_at <= now()`. Enfiá-las na
 * tabela genérica autorizaria `markClaimed` (o caminho legado, sem lease) a
 * rebaixar um turno em execução COM dono vivo, que é exatamente o contrário do
 * que esta issue existe para impedir. Por isso o claim tem tabela própria, e a
 * condição de lease é parte inseparável dela.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { TurnStatus } from './contract.js';

/**
 * Estados em que um turno está disponível para um claim NOVO — nenhum worker o
 * possui, ou nunca possuiu.
 *
 * `retryable` entra porque o backoff é do PostgreSQL (`next_attempt_at`), não
 * do BullMQ: um turno em `retryable` cuja tentativa venceu é trabalho legítimo.
 * A checagem de `next_attempt_at` é feita no SQL, não aqui — é uma condição de
 * RELÓGIO, e o relógio autoritativo é o do banco (cláusula da issue: "Relógio
 * usado para elegibilidade deve ser o do PostgreSQL").
 */
export const CLAIMABLE_STATUSES = ['received', 'queued', 'retryable'] as const;

/**
 * Estados em que um turno JÁ TEM dono e só pode ser tomado se a lease venceu.
 *
 * `outbound_pending` está deliberadamente FORA, pela mesma razão de #503: a
 * resposta já foi comprometida e uma segunda execução do ReAct a duplicaria.
 * Um turno preso em `outbound_pending` é problema do outbox (#506), nunca de um
 * takeover.
 */
export const LEASE_TAKEOVER_STATUSES = ['claimed', 'running'] as const;

/** Estados que uma gravação FENCED aceita como origem (o turno é meu e está vivo). */
export const FENCED_WRITE_STATUSES = ['claimed', 'running', 'outbound_pending'] as const;

/**
 * Estados que OCUPAM a stream: enquanto um turno está em um deles, nenhum outro
 * turno da mesma stream pode ser reivindicado (issue #625, fatia B da #505).
 *
 * É a MESMA lista de `LEASE_TAKEOVER_STATUSES`, e a igualdade não é
 * coincidência: um turno ocupa a stream exatamente enquanto pode ter dono vivo.
 * Ainda assim são constantes SEPARADAS, porque respondem a perguntas
 * diferentes — "de quais estados se pode tomar posse?" e "quais estados
 * bloqueiam a stream?" — e uma fatia futura pode mover uma sem mover a outra
 * (incluir `outbound_pending` aqui, por exemplo, prenderia a stream pela
 * latência do provedor de saída sem torná-la reivindicável).
 *
 * ESTA LISTA ESPELHA O PREDICADO DO ÍNDICE `agent_turns_stream_active_uq`
 * (migration 124). Mudar uma sem a outra faz a exclusão do banco e a
 * recuperação da aplicação discordarem — e a forma dessa discordância é uma
 * stream travada. `tests/unit/runtime/stream-exclusion-contract.spec.ts` amarra
 * as duas ao mesmo texto.
 */
export const STREAM_OCCUPYING_STATUSES = ['claimed', 'running'] as const;

/** Nome do índice único parcial que garante a exclusão NO BANCO. */
export const STREAM_EXCLUSION_CONSTRAINT = 'agent_turns_stream_active_uq';

/**
 * #626 — nome do índice PARCIAL que sustenta a pergunta do head-of-line
 * ("existe turno anterior não terminal nesta stream?", migration 126).
 *
 * Ele não DECIDE nada — quem decide é o `NOT EXISTS` de
 * `src/db/repositories/stream-head-sql.ts`. Ele decide o CUSTO, e é por isso
 * que o nome mora no vocabulário e não só no arquivo de migration: sem ele a
 * regra continua correta e passa a varrer o histórico inteiro de uma conversa
 * quente a cada claim — a degradação que a issue nomeia ("`NOT EXISTS` sem o
 * índice certo degrada rápido"). O runbook §11.4 usa este nome para checar
 * `pg_index.indisvalid`.
 */
export const STREAM_HEAD_OF_LINE_INDEX = 'agent_turns_stream_head_live_idx';

/**
 * #626 — VOCABULÁRIO ÚNICO dos resultados do escalonamento por stream.
 *
 * A issue pede "códigos de resultado centralizados: `not_head`, `stream_busy`,
 * `eligible`, `stream_blocked`, `promoted`". Centralizar não é catalogar: é
 * fazer com que nenhuma camada possa inventar um sexto código nem grafar um
 * dos cinco de outro jeito. Métrica, `audit_log`, log e o tipo de retorno saem
 * todos daqui, e `tests/unit/runtime/stream-head-of-line-contract.spec.ts`
 * fixa o conjunto — acrescentar um código sem tocar no teste é impossível.
 *
 * Quem PRODUZ cada um, hoje:
 *
 * | código | quem produz | significado |
 * |---|---|---|
 * | `eligible` | `claimNextEligibleTurn` (caminho de sucesso) | o turno É o head-of-line da stream e o claim foi concedido |
 * | `not_head` | `claimNextEligibleTurn` (recusa) | existe turno ANTERIOR não terminal na mesma stream, e ele avança sozinho |
 * | `stream_blocked` | `claimNextEligibleTurn` (recusa) | o anterior está em `outbound_pending`: NENHUM claim o move, quem o move é o delivery worker (#506) |
 * | `stream_busy` | o índice `agent_turns_stream_active_uq` (#625) | outro turno da stream já está ATIVO com lease viva |
 * | `promoted` | `promoteStreamSuccessor` (#627), na transação do CAS terminal | o sucessor foi eleito e enfileirado quando o head chegou a terminal |
 *
 * `promoted` entrou na #626 SEM produtor, deliberadamente, e a #627 o produz.
 * A alternativa era esta fatia acrescentar um sexto rótulo a uma série de
 * métrica já em uso — e mudar o domínio de um label depois que ele está num
 * dashboard é a forma mais fácil de quebrar um alerta sem ninguém perceber. Uma
 * série que existe em zero é barata; um vocabulário que muda debaixo do painel,
 * não.
 */
export const STREAM_SCHEDULING_RESULTS = [
  'eligible',
  'not_head',
  'stream_blocked',
  'stream_busy',
  'promoted',
  /**
   * #629 (fatia F) — a conversa está BLOQUEADA por poison message: um turno
   * anterior esgotou tentativas numa categoria de erro cuja política manda
   * bloquear em vez de liberar (`agent_stream_blocks`, migration 133).
   *
   * Sexto código, e ele merece a mesma justificativa que a #626 deu para NÃO
   * acrescentar um: mudar o domínio de um label depois que ele está num
   * dashboard quebra alerta sem ninguém perceber. A diferença é que aqui o
   * valor é ACRESCENTADO, não redefinido — nenhuma série existente muda de
   * significado, e a série nova é semeada em zero como as outras. O que não se
   * podia fazer era reusar `stream_blocked`: as duas param a conversa, e as
   * remediações são opostas (`stream_blocked` é "vá ao runbook do outbox e
   * espere"; `stream_poisoned` é "nada vai acontecer até um humano desbloquear").
   */
  'stream_poisoned',
] as const;

export type StreamSchedulingResult = (typeof STREAM_SCHEDULING_RESULTS)[number];

/**
 * #626 — os motivos de BLOQUEIO da stream, o subconjunto de
 * `STREAM_SCHEDULING_RESULTS` que vira label de
 * `maia_stream_blocked_total{reason}`.
 *
 * `eligible` e `promoted` ficam de fora porque não são bloqueio; contá-los ali
 * transformaria um contador de "quanto a fila segurou" num contador de tráfego.
 */
export const STREAM_BLOCKED_REASONS = [
  'not_head',
  'stream_blocked',
  'stream_busy',
  /**
   * #629 — a conversa está bloqueada por política de poison. Entra aqui porque
   * é bloqueio de verdade, e sai da leitura de `not_head`: `not_head` cresce e
   * volta sozinho ao normal quando o head anda; `stream_poisoned` cresce e NÃO
   * volta — cada ponto é uma tentativa contra uma conversa que nenhum worker
   * vai destravar. É a série cuja subida sustentada é o sinal de "há operação
   * manual pendente", que nenhuma das outras três dá.
   */
  'stream_poisoned',
] as const;

export type StreamBlockedReason = (typeof STREAM_BLOCKED_REASONS)[number];

/**
 * #627 (fatia D) — os desfechos de uma PROMOÇÃO, e o domínio de
 * `maia_stream_promotion_total{result}`.
 *
 * A issue pede que a métrica "cubra promoção, rejeição por fence e
 * recuperação". Os cinco abaixo são esses três mais os dois que, sem estarem
 * nomeados, tornariam os outros ilegíveis:
 *
 *  - `promoted` — o sucessor foi eleito, a decisão foi COMITADA e a BullMQ foi
 *    sinalizada. É o código do vocabulário central (`STREAM_SCHEDULING_RESULTS`)
 *    e o único que os dois conjuntos compartilham — de propósito: uma promoção
 *    é um resultado de escalonamento, e ter dois nomes para o mesmo fato é
 *    exatamente a divergência que a #626 fechou na outra dimensão;
 *  - `no_successor` — o predecessor terminou e não havia quem promover (a
 *    conversa acabou, ou o próximo está `outbound_pending`/já reivindicado).
 *    É o caso NORMAL e majoritário. Sem ele, `promoted` sozinho não diz se as
 *    conclusões estão liberando fila ou se a promoção parou de rodar — a razão
 *    `promoted/(promoted+no_successor)` é o sinal, e ela precisa do denominador;
 *  - `fence_rejected` — uma tentativa STALE tentou concluir o turno e, com
 *    isso, liberar o sucessor. Recusada. É a falha nº 9 da issue-mãe
 *    ("takeover após lease expirado permite ao worker antigo liberar o
 *    sucessor") vista como número;
 *  - `enqueue_failed` — a decisão COMITOU e o sinal da BullMQ falhou. NÃO é
 *    perda: é exatamente o estado que o recovery reconcilia, e por isso ele
 *    tem nome próprio em vez de virar um log solto. `enqueue_failed` subindo
 *    com `recovered` acompanhando é o sistema funcionando; `enqueue_failed`
 *    sem `recovered` é o varredor parado;
 *  - `recovered` — o varredor encontrou um turno PROMOVIDO e não enfileirado e
 *    fechou o buraco. É a prova de que "a fila é wake-up, não fonte de verdade"
 *    é verdade na operação, e não só na doc.
 */
export const STREAM_PROMOTION_RESULTS = [
  'promoted',
  'no_successor',
  'fence_rejected',
  'enqueue_failed',
  'recovered',
] as const;

export type StreamPromotionResult = (typeof STREAM_PROMOTION_RESULTS)[number];

/**
 * #626 — onde uma violação de FIFO pode ser DETECTADA.
 *
 * `maia_stream_fifo_violation_total{stage}` é, pela issue, "sempre zero" — e um
 * contador que ninguém sabe incrementar também é sempre zero, sem provar nada.
 * Cada estágio aqui é um detector REAL, e a pergunta que ele responde é
 * diferente:
 *
 *  - `claim` — PÓS-CONDIÇÃO dentro da transação do claim concedido: o turno que
 *    acabou de ser reivindicado tinha, mesmo assim, um anterior não terminal na
 *    stream. Acusa a regra não ter sido aplicada (removida do `WHERE`, aplicada
 *    à linha errada, índice e código discordando);
 *  - `recovery` — o varredor rearmou um turno que não era o head-of-line.
 *    Acusa a divergência que a issue nomeia por escrito: "duas cópias da regra
 *    de elegibilidade divergem, e a divergência só aparece durante um recovery".
 */
export const STREAM_FIFO_VIOLATION_STAGES = ['claim', 'recovery'] as const;

export type StreamFifoViolationStage = (typeof STREAM_FIFO_VIOLATION_STAGES)[number];

/**
 * #627 — um turno que a plataforma elegeu para AVANÇAR e a quem, portanto, ela
 * deve um wake-up.
 *
 * O tipo mora aqui, no vocabulário PURO, e não em `turn-repos.ts`, porque ele é
 * a moeda entre TRÊS camadas que não podem se importar em cadeia: o repositório
 * o produz (na transação), `src/runtime/turns/stream-promotion.ts` o consome
 * (para sinalizar a BullMQ) e `src/runtime/turns/lease.ts` o audita. Declará-lo
 * no repositório obrigaria o módulo que fala com a fila a importar o módulo que
 * fala com o banco só para ter um tipo.
 *
 * `representative_message_id` é o que o payload do job carrega; `conversa_id`
 * vai para a auditoria (a `audit_log` tem coluna própria). Nenhum dos dois é
 * label de métrica.
 */
export type StreamClaimRecovery = {
  turn_id: string;
  representative_message_id: string;
  conversa_id: string | null;
  status_before: TurnStatus;
  status_after: TurnStatus;
};

/**
 * #629 (fatia F) — uma STREAM foi INTERDITADA por política de poison, e este é
 * o fato que atravessa as camadas.
 *
 * Mora aqui, no vocabulário PURO, pela mesma razão de `StreamClaimRecovery`: é
 * a moeda entre três camadas que não podem se importar em cadeia — o
 * repositório o PRODUZ (dentro da transação do CAS terminal),
 * `src/runtime/turns/lifecycle.ts` o AUDITA e `src/ops/stream-unblock.ts` o
 * resolve.
 *
 * O que ele NÃO carrega: `stream_key`. A issue-mãe a restringe a log protegido,
 * e nenhum consumidor precisa dela — o bloqueio é endereçado por `block_id`, e
 * "qual conversa?" se responde pelo `blocked_turn_id`. Carregá-la aqui seria
 * pô-la a um `logger.info` de distância de virar campo de log de rotina.
 */
export type StreamBlockRecord = {
  block_id: string;
  /** `POISON_CATEGORIES` de `poison-policy.ts` — a categoria que DECIDIU. */
  category: string;
  /** `STREAM_BLOCK_REASONS` de `poison-policy.ts`. */
  reason: string;
  /** O turno envenenado, que foi para `dead_letter` nesta mesma transação. */
  blocked_turn_id: string;
  conversa_id: string | null;
  error_code: string | null;
};

/**
 * Resultado TIPADO de uma tentativa de claim. `not_claimed` NÃO é erro: é a
 * resposta correta para "outro worker chegou primeiro" e para "ainda não está
 * elegível". O que ele nunca é: autorização para processar.
 *
 * `recovered_stream_claims` (#625) carrega os turnos da MESMA stream cujo claim
 * expirado foi recuperado DENTRO da transação deste claim. Vem nos dois ramos
 * de propósito: a recuperação acontece antes de sabermos se venceremos a
 * corrida, e quem perdeu ainda precisa relatar que desbloqueou a stream. Vazio
 * é o caso normal.
 *
 * #627 mudou o CONTEÚDO desse campo de `string[]` para o mesmo objeto da
 * promoção por conclusão, e a razão é operacional: um turno recuperado perdeu o
 * único wake-up que tinha (o job do dono morto), então ele PRECISA ser
 * re-enfileirado — e para armar o job é preciso o `representative_message_id`,
 * que só existe na linha recuperada. Buscá-lo numa segunda consulta abriria a
 * janela em que o turno muda entre as duas leituras, e o sinal descreveria um
 * estado que já não existe. O tipo é `StreamPromotion` porque o FATO é o mesmo
 * — "este turno é quem deve avançar, e alguém lhe deve um sinal" —, contraído
 * por outro caminho.
 */
export type ClaimResult =
  | {
      ok: true;
      claim: TurnClaim;
      recovered_stream_claims?: readonly StreamClaimRecovery[];
      /**
       * #626 — o CANÁRIO disparou: o claim foi concedido e, ainda assim, havia
       * turno anterior não terminal na stream. Presente só na anomalia.
       *
       * Vem no resultado em vez de virar log dentro do repositório pela mesma
       * razão de `recovered_stream_claims`: o repositório é puro-DB, e `audit()`
       * lá fecharia o ciclo de import governance/audit -> repositories. Quem
       * relata é `src/runtime/turns/lease.ts`.
       */
      fifo_violation?: { stage: StreamFifoViolationStage; earlier_live: number };
    }
  | {
      ok: false;
      reason: ClaimRejection;
      recovered_stream_claims?: readonly StreamClaimRecovery[];
      /**
       * #626 — QUEM está na frente, quando a recusa é `not_head` ou
       * `stream_blocked`. Diagnóstico, nunca instrução: esta fatia NÃO
       * enfileira o bloqueador (promoção é #627), e agir sobre ele aqui
       * transformaria um claim recusado em escrita num turno alheio.
       *
       * Sem este campo, "a conversa parou" e "a conversa parou por causa DAQUELE
       * turno" seriam o mesmo log, e o operador teria de reconstruir a fila à
       * mão a partir da `stream_key` — que é justamente o dado que a issue-mãe
       * restringe.
       */
      head_block?: { turn_id: string; status: TurnStatus };
    };

/** Por que o claim não foi concedido — label de métrica, cardinalidade fechada. */
export const CLAIM_REJECTIONS = [
  /** A row não existe NO ESCOPO (tenant+agent) corrente. */
  'not_found',
  /** Existe, mas outro worker tem lease viva — ou o estado não é elegível. */
  'not_eligible',
  /**
   * #625 — o turno estava elegível, mas OUTRO turno da mesma stream já está
   * ativo com lease viva, e o banco recusou o segundo claim.
   *
   * Deliberadamente distinto de `not_eligible`. `not_eligible` fala do TURNO
   * ("este aqui não pode ser reivindicado agora"); `stream_busy` fala da
   * STREAM ("a conversa está ocupada por outro turno"). A reação operacional é
   * a mesma — parar —, mas o diagnóstico é oposto: `not_eligible` em massa é
   * problema de roteamento ou de backoff, `stream_busy` em massa é uma
   * conversa serializando, que é o sintoma que a issue-mãe manda vigiar
   * (§Risk: "índice inadequado pode serializar hot streams").
   */
  'stream_busy',
  /**
   * #626 — o turno NÃO é o head-of-line: existe turno ANTERIOR não terminal na
   * mesma stream (`first_ingress_seq` menor).
   *
   * Distinto de `stream_busy` porque as perguntas são diferentes e as
   * remediações também. `stream_busy` é "a conversa está OCUPADA agora" — o
   * anterior tem lease viva e está executando; some sozinho quando ele termina.
   * `not_head` é "a conversa tem FILA" — o anterior pode estar apenas
   * `received`, sem ninguém tê-lo tocado. Colapsar os dois esconderia o caso em
   * que a fila cresce sem nada estar executando, que é o sintoma de starvation
   * que a issue-mãe manda vigiar.
   */
  'not_head',
  /**
   * #626 — o turno anterior está em `outbound_pending`: a stream não avança por
   * escalonamento nenhum.
   *
   * É a recusa que NÃO se resolve com tempo nem com outro worker. Quem tira um
   * turno de `outbound_pending` é o delivery worker do outbox (#506); enquanto
   * ele não o fizer, todo claim desta stream continuará sendo recusado. Por
   * isso não é `not_head`: a leitura operacional de `not_head` é "espere", e a
   * de `stream_blocked` é "vá ao runbook do outbox".
   */
  'stream_blocked',
  /**
   * #629 — a CONVERSA está bloqueada por política de poison: um turno anterior
   * esgotou tentativas numa categoria de erro cuja política manda BLOQUEAR em
   * vez de liberar, e existe uma linha ATIVA em `agent_stream_blocks`
   * (migration 133).
   *
   * Distinto de `stream_blocked` porque a leitura operacional é a mais
   * diferente de todas as cinco: `stream_blocked` é "espere o outbox";
   * `stream_poisoned` é "NADA vai acontecer sem um humano". Nenhum worker,
   * nenhum varredor, nenhuma promoção e nenhuma quantidade de tempo destravam
   * esta conversa — só `npm run dlq -- unblock`, que é operação auditada.
   *
   * Distinto de `not_eligible` porque não fala do TURNO: o turno pode estar
   * perfeitamente elegível, com backoff vencido e ninguém o disputando. É a
   * conversa que está interditada, por decisão de política.
   */
  'stream_poisoned',
] as const;

export type ClaimRejection = (typeof CLAIM_REJECTIONS)[number];

/** Posse concedida: o que o worker precisa carregar para escrever com fence. */
export type TurnClaim = {
  turn_id: string;
  tenant_id: string;
  agent_id: string;
  /** Tentativa CANÔNICA — vem do PostgreSQL, nunca de `job.attemptsMade`. */
  attempt: number;
  /** O FENCE. Toda gravação da tentativa exige este valor no WHERE. */
  claim_token: string;
  worker_id: string;
  claimed_at: Date;
  lease_expires_at: Date;
  status: TurnStatus;
  state_version: number;
  /**
   * #629 — QUANTO TEMPO este turno esperou antes de começar, em segundos,
   * medido pelo relógio do PostgreSQL (`now() - COALESCE(queued_at,
   * created_at)`) no mesmo `RETURNING` do claim.
   *
   * ─── Por que no banco, e por que nesta consulta ────────────────────────
   *
   * No BANCO porque a espera é a diferença entre dois instantes gravados por
   * processos possivelmente diferentes: calculá-la com `Date.now()` do worker
   * mediria o skew entre o relógio dele e o do banco junto com a espera, e num
   * cluster com nós dessincronizados a métrica de fairness passaria a medir
   * NTP. É a mesma regra que faz toda elegibilidade do claim usar `now()`.
   *
   * NESTA consulta porque ler `queued_at` depois abriria a janela em que a
   * linha muda entre as duas leituras — e a promoção (#627) preserva
   * `queued_at` de propósito justamente para que esta conta continue medindo
   * desde a PRIMEIRA vez que o turno entrou na fila, não desde o último
   * re-arme.
   *
   * `queued_at` nulo (turno que nunca passou por `queued`: um `received`
   * reivindicado direto) cai em `created_at`, que é o instante do ingresso — a
   * espera real do usuário, e nunca zero.
   */
  wait_seconds: number;
};

/**
 * Contexto de execução propagado pela tentativa (issue §Fencing).
 *
 * `deadline` e `signal` nascem aqui porque o cancelamento por perda de lease é
 * desta issue; o orçamento GLOBAL do turno é #507, que preenche `deadline` com
 * o mínimo entre o vencimento do lease e o seu próprio orçamento.
 */
export type TurnExecutionContext = {
  tenant_id: string;
  agent_id: string;
  turn_id: string;
  attempt: number;
  claim_token: string;
  worker_id: string;
  deadline: Date;
  signal: AbortSignal;
};

/** Por que a posse foi perdida — label de métrica. */
export const LEASE_LOSS_REASONS = [
  /** O heartbeat encontrou o turno com outro token (ou nenhum): fomos tomados. */
  'token_mismatch',
  /** O heartbeat falhou repetidamente (banco indisponível) e abortamos ANTES do vencimento. */
  'heartbeat_failed',
  /** A lease venceu sem renovação bem-sucedida. */
  'expired',
  /** Shutdown gracioso: liberamos a posse de propósito. */
  'released',
] as const;

export type LeaseLossReason = (typeof LEASE_LOSS_REASONS)[number];

/** Resultado TIPADO de uma renovação de lease. */
export type LeaseRenewalResult =
  | { ok: true; lease_expires_at: Date; heartbeat_at: Date }
  | { ok: false; reason: 'token_mismatch' };

// ─── Identidade do worker ────────────────────────────────────────────────────

let cachedWorkerId: string | null = null;

/**
 * Identidade ÚNICA e ESTÁVEL deste processo enquanto dono de claims.
 *
 * `<hostname>:<pid>:turn:<rand>`. O sufixo aleatório não é decoração: a issue
 * proíbe explicitamente "usar hostname sozinho como garantia de unicidade", e
 * `hostname:pid` também não basta — o PID é reciclado pelo kernel, e num
 * container que reinicia o processo pode voltar com o MESMO par. Se isso
 * acontecesse, um zumbi da encarnação anterior teria `claimed_by` idêntico ao
 * do sucessor e a trilha de auditoria juntaria dois donos num só.
 *
 * O que impede a escrita do zumbi continua sendo o `claim_token` (fencing), não
 * este id — `claimed_by` é DIAGNÓSTICO. Ainda assim ele precisa distinguir
 * encarnações, senão o diagnóstico mente.
 *
 * Estável durante toda a vida do processo (memoizado) e sem informação
 * sensível: hostname e pid já aparecem em todo log da instalação.
 */
export function turnWorkerId(): string {
  cachedWorkerId ??= `${hostname()}:${process.pid}:turn:${randomUUID().slice(0, 8)}`;
  return cachedWorkerId;
}

/** Só para teste: força uma nova identidade (simula outra réplica). */
export function __resetTurnWorkerIdForTest(): void {
  cachedWorkerId = null;
}

// ─── Aritmética do lease ─────────────────────────────────────────────────────

/**
 * Razão MÁXIMA entre intervalo de heartbeat e TTL do lease (issue §Lease: "o
 * intervalo de heartbeat deve ser no máximo um terço do TTL").
 *
 * Um terço, e não metade, porque com metade UMA renovação perdida já deixa o
 * lease vencer: não há segunda tentativa dentro da janela. Com um terço cabem
 * duas falhas consecutivas antes do vencimento, que é o que transforma um blip
 * de rede num evento invisível em vez de num takeover falso.
 */
export const MAX_HEARTBEAT_TO_TTL_RATIO = 1 / 3;

/**
 * Quantas renovações consecutivas podem falhar antes de abortarmos a tentativa
 * por conta própria.
 *
 * Derivado da razão acima: com heartbeat = TTL/3, a terceira falha consecutiva
 * cai EM CIMA do vencimento. Abortamos na segunda, ainda dentro da janela — a
 * issue exige que "falha repetida de heartbeat deve abortar a tentativa ANTES
 * da expiração", e abortar depois seria escrever com lease vencida.
 */
export const MAX_HEARTBEAT_FAILURES = 2;

export type LeaseTimingCheck =
  | { ok: true }
  | { ok: false; reason: 'ttl_not_positive' | 'heartbeat_not_positive' | 'heartbeat_too_slow' };

/**
 * Valida a relação TTL × heartbeat. FAIL-CLOSED por construção: qualquer
 * combinação que não deixe pelo menos três renovações caberem no TTL é
 * rejeitada, porque ela produz takeover falso sob carga normal — e um takeover
 * falso é DUAS execuções do mesmo turno, o defeito que esta issue fecha.
 *
 * Usada em duas camadas: na regra cross-field do contrato de config (boot) e no
 * construtor do controlador de lease (defesa em profundidade, caso alguém passe
 * valores programaticamente).
 */
export function checkLeaseTiming(ttl_ms: number, heartbeat_ms: number): LeaseTimingCheck {
  if (!Number.isFinite(ttl_ms) || ttl_ms <= 0) return { ok: false, reason: 'ttl_not_positive' };
  if (!Number.isFinite(heartbeat_ms) || heartbeat_ms <= 0) {
    return { ok: false, reason: 'heartbeat_not_positive' };
  }
  if (heartbeat_ms > ttl_ms * MAX_HEARTBEAT_TO_TTL_RATIO) {
    return { ok: false, reason: 'heartbeat_too_slow' };
  }
  return { ok: true };
}

/** Erro FAIL-LOUD de configuração de lease insegura. */
export class UnsafeLeaseTimingError extends Error {
  readonly code = 'UNSAFE_LEASE_TIMING';
  constructor(ttl_ms: number, heartbeat_ms: number, reason: string) {
    super(
      `configuração de lease insegura (ttl_ms=${ttl_ms}, heartbeat_ms=${heartbeat_ms}, ` +
        `motivo=${reason}): o heartbeat precisa caber ao menos 3x no TTL, senão uma ` +
        `renovação perdida já produz takeover falso — e takeover falso é execução dupla`,
    );
    this.name = 'UnsafeLeaseTimingError';
  }
}

export function assertLeaseTiming(ttl_ms: number, heartbeat_ms: number): void {
  const check = checkLeaseTiming(ttl_ms, heartbeat_ms);
  if (!check.ok) throw new UnsafeLeaseTimingError(ttl_ms, heartbeat_ms, check.reason);
}

/**
 * Erro lançado quando uma gravação da tentativa é REJEITADA pelo fence — o
 * turno pertence a outro worker (ou não está mais em estado gravável).
 *
 * É um erro, e não um resultado silencioso, porque o caller que o recebe está
 * no meio de uma tentativa que precisa PARAR. Tratá-lo como `false` produziria
 * o pior dos mundos: o pipeline seguiria adiante achando que gravou.
 */
export class StaleClaimError extends Error {
  readonly code = 'STALE_CLAIM';
  readonly turn_id: string;
  readonly operation: string;
  constructor(args: { turn_id: string; operation: string }) {
    super(
      `stale_claim: a gravação '${args.operation}' do turno ${args.turn_id} foi rejeitada pelo ` +
        `fence — o claim_token não é mais o vigente. A tentativa local perdeu a posse e NÃO ` +
        `pode concluir o turno.`,
    );
    this.name = 'StaleClaimError';
    this.turn_id = args.turn_id;
    this.operation = args.operation;
  }
}
