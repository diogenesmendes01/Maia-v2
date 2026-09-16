/**
 * P04.3a (spec §8.2.3 passo 3, §5.6.3) — o SQL que tranca `conversation_controls`,
 * com UM só dono.
 *
 * ─── Por que existe um módulo só para isto ─────────────────────────────────
 *
 * `conversation_controls` é o **PRIMEIRO degrau** da ordem global de locks. O
 * §5.6.3 a fixa para o journal (`conversation_controls → agent_turns →
 * engine_runs → engine_tool_calls`) e o §8.2.3 passo 3 a estende para o controle
 * humano (`controle → exclusão/ordenação existente da stream → turnos →
 * efeito/outbox`), com a cláusula que dá origem a este arquivo: **"não
 * introduzir dois ordenamentos incompatíveis"**.
 *
 * Até aqui o trancamento era uma função privada de `engine-repos.ts`, com 16
 * call sites. O `pauseConversationTx` do §8.2.3 precisa trancar a MESMA linha, e
 * havia três saídas:
 *
 *   1. copiar o SQL para o repositório de controle — duas cópias divergem, e a
 *      divergência de uma ordem de lock só aparece sob concorrência, em
 *      produção, como deadlock;
 *   2. importar de `engine-repos.ts` — inverteria a dependência. Controle é o
 *      degrau ANTERIOR; o journal é quem o consome, não o contrário;
 *   3. extrair para um módulo compartilhado — o que a casa já fez duas vezes,
 *      por esta mesma razão: `turn-fence-sql.ts` (#504) e `stream-head-sql.ts`
 *      (#626).
 *
 * ─── Por que CONSTRUTOR de SQL, e não uma função que executa ───────────────
 *
 * Pelo mesmo motivo que os dois precedentes: `engine-repos.ts` e `turn-repos.ts`
 * importam `../client.js`, que constrói o `pg.Pool` no import e exige
 * `DATABASE_URL`. Enquanto o SQL morar lá dentro, a única prova possível de que
 * o lock existe é um teste de integração — e um teste de integração que não roda
 * (Postgres fora do ar, ou justamente indisponível quando alguém mexe no lock)
 * não prova nada.
 *
 * Aqui os construtores são puros: `new PgDialect().sqlToQuery(...)` compila o
 * SQL REAL sem banco nenhum, e `tests/unit/db/conversation-control-sql.spec.ts`
 * afirma sobre o SQL que o PostgreSQL de fato recebe. A regra que torna isso
 * honesto é a mesma de `turn-fence-sql.ts`: **nenhum chamador monta o SELECT por
 * conta própria** — todos chamam estes construtores. Se alguém apagar o
 * `FOR UPDATE` daqui, a produção fica insegura E o teste fica vermelho, que é a
 * única relação que faz um teste valer alguma coisa.
 *
 * Este módulo NÃO executa, NÃO abre transação e NÃO lê o escopo do ALS. Quem
 * chama passa `tenant_id`/`agent_id` já resolvidos e roda o SQL no seu próprio
 * executor — deliberadamente, para que ele continue puro e testável sem boot.
 *
 * ─── P04.6: o módulo passou a ter uma SEGUNDA responsabilidade ─────────────
 *
 * Além do LOCK (escrita), ele agora hospeda o predicado de ELEGIBILIDADE que o
 * caminho do turno consulta em quatro lugares (`streamNotHumanControlled`) e a
 * sonda que explica a recusa (`humanControlProbe`). As duas moram aqui pela
 * razão nº 1 acima, aplicada de novo: elas nomeiam `conversation_controls`, e
 * uma segunda cópia do predicado divergiria em silêncio.
 *
 * A alternativa considerada foi `stream-head-sql.ts`, que já hospeda
 * `streamNotPoisoned` — também um predicado de elegibilidade que não é sobre
 * ordem. O argumento é real e fica registrado: um leitor que pergunte "o que
 * pode barrar um claim?" passa a ter dois arquivos a abrir. Escolhi aqui para
 * não fazer o módulo dono da ORDEM DO TURNO (#626) importar o schema de controle
 * do P04, invertendo a mesma dependência que a razão nº 2 rejeitou. O que torna
 * a escolha segura em qualquer dos dois casos não é a pasta: é a contagem de
 * consumidores afirmada em
 * `tests/unit/runtime/conversation-control-claim-contract.spec.ts`.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  agent_turns,
  conversation_controls,
  engine_runs,
  engine_tool_calls,
} from '../schema.js';

/**
 * A linha devolvida pelos dois construtores. Eles selecionam EXATAMENTE as
 * mesmas colunas de propósito: o consumidor tipa uma linha só, e se as duas
 * formas divergissem, um dos caminhos quebraria em runtime com o tipo
 * satisfeito — o pior dos dois mundos.
 *
 * `control_epoch` sai como TEXTO porque a coluna é `bigint`: materializar como
 * `number` perderia precisão acima de 2^53, e o contrato do §8.3.2 serializa
 * epoch como decimal em string exatamente por isso.
 */
export type ConversationControlLockRow = {
  id: string;
  mode: string;
  control_epoch: string;
};

/**
 * As três colunas do contrato acima, num só lugar.
 *
 * É FUNÇÃO, e não constante, e a diferença não é estilo — é a regra que
 * `src/runtime/turns/stream-metrics.ts` já declara no cabeçalho dele: **um
 * módulo importado por um repositório não pode ter efeito no import.**
 *
 * Medido, não suposto. Enquanto isto era `const COLUNAS = sql\`…\`` no escopo de
 * módulo, o `sql` era avaliado no momento do IMPORT. Enquanto este arquivo só
 * era alcançado por `engine-repos.ts` ninguém notou; quando o P04.6 o pôs no
 * grafo de `turn-repos.ts`, oito specs que fazem `vi.mock('drizzle-orm')` com
 * fábrica PARCIAL passaram a estourar na carga — "No \`sql\` export is defined on
 * the drizzle-orm mock" — levando 74 testes a vermelho e impedindo três arquivos
 * de sequer carregar. O stack apontava para este arquivo, na linha desta
 * constante, a partir do import novo.
 *
 * Adiar a avaliação para dentro das funções resolve na RAIZ: o mock parcial
 * nunca precisa de `sql` no import, e o SQL produzido é byte a byte o mesmo.
 * Consertar as oito specs seria tratar o sintoma em oito lugares alheios.
 *
 * `engine-repos.ts` tem o mesmo padrão em `SNAPSHOT_COLS`/`FENCE_COLS` e hoje
 * não machuca ninguém, porque não está no grafo dessas specs. Fica registrado
 * como armadilha latente, não corrigido aqui: mexer nele é mudança de outro
 * módulo, sem teste que a cobre e fora do escopo desta unidade.
 */
const COLUNAS = (): SQL => sql`c.id, c.mode, c.control_epoch::text AS control_epoch`;

/**
 * Tranca o controle POR ID — a forma usada quando o run ainda não existe
 * (`pinEngineAndPrepareRun`) e a que o `pauseConversationTx` do §8.2.3 usa,
 * porque um comando de operador não tem run nenhum a que se referir.
 */
export function lockControlByIdSql(input: {
  tenant_id: string;
  agent_id: string;
  control_id: string;
}): SQL {
  return sql`
    SELECT ${COLUNAS()}
      FROM ${conversation_controls} c
     WHERE c.tenant_id = ${input.tenant_id} AND c.agent_id = ${input.agent_id}
       AND c.id = ${input.control_id}
     FOR UPDATE`;
}

/**
 * Tranca o controle PELO RUN — a forma do SQL do §5.6.4, usada por todas as
 * operações do journal que já têm um run em mãos.
 *
 * **`FOR UPDATE OF c` é a cláusula que mais importa neste arquivo.** Num join,
 * um `FOR UPDATE` sem `OF` tranca TODAS as tabelas da consulta: o controle *e*
 * `engine_runs`. Isso adicionaria uma aresta de lock sobre o run ANTES do
 * controle — e o §5.6.3 fixa a ordem inversa (controle → turno → run). Seriam
 * os "dois ordenamentos incompatíveis" que o §8.2.3 passo 3 proíbe, com o
 * deadlock aparecendo só sob concorrência real. O caso 5 do spec prende isso.
 *
 * O join carrega o escopo COMPLETO (`tenant_id` e `agent_id`, não só
 * `control_id`): dois escopos com o mesmo uuid cruzariam tenants se o
 * pertencimento não fosse predicado.
 */
export function lockControlByRunSql(input: {
  tenant_id: string;
  agent_id: string;
  run_id: string;
}): SQL {
  return sql`
    SELECT ${COLUNAS()}
      FROM ${conversation_controls} c
      JOIN ${engine_runs} r
        ON r.tenant_id = c.tenant_id AND r.agent_id = c.agent_id AND r.control_id = c.id
     WHERE r.tenant_id = ${input.tenant_id} AND r.agent_id = ${input.agent_id}
       AND r.id = ${input.run_id}
     FOR UPDATE OF c`;
}

// ─── P04.6 — O HOLD DE ADMISSÃO/CLAIM (§8.2.4, §8.2.5) ──────────────────────

/**
 * **A REGRA.** `TRUE` quando a conversa do alvo **não** está sob controle
 * humano — isto é, quando a automação ainda pode trabalhar nela.
 *
 * ─── Que cláusula isto executa ────────────────────────────────────────────
 *
 * §8.2.5, primeiro bullet: mensagens retidas "podem permanecer em estado
 * operacional não terminal sob hold de controle, mas **todos os scans de
 * recovery/claim devem excluir holds**; não usar TTL Redis como fonte desse
 * hold". E o §8.2.4, na linha de `turn-repos.ts`/`claim.ts`/`message-recovery.ts`:
 * "Admission/claim deve consultar controle, retornar motivo fechado
 * `conversation_human_control`; recovery/promotion não podem fabricar tentativa
 * nova que ignore a pausa."
 *
 * A fonte do hold é esta LINHA, no PostgreSQL — não um TTL de Redis, não um
 * sinal de pubsub. É o que a spec exige por escrito, e é o que faz o hold
 * sobreviver a um restart do transporte.
 *
 * ─── `mode <> 'bot'`, e não `mode = 'human'` ─────────────────────────────
 *
 * A decisão mais importante do predicado. `pausing` é estado REAL (migration
 * 140: "entre a barreira e a drenagem confirmada existe I/O em voo que ninguém
 * pode declarar morto") e é exatamente a janela entre o clique do operador e a
 * parada confirmada. Escrevê-lo como `= 'human'` deixaria essa janela aberta a
 * claims NOVOS — o bot começando um turno DEPOIS do clique de pausa, que é o
 * defeito que a fatia inteira existe para impedir. Perguntar "não é do bot?" em
 * vez de "é do humano?" também erra para o lado seguro se um quarto modo for
 * acrescentado ao CHECK: o modo desconhecido RETÉM, em vez de liberar por
 * omissão.
 *
 * ─── Por que INCONDICIONAL, sem flag ─────────────────────────────────────
 *
 * Mesma razão que o predicado de poison (#629): uma linha de controle não-`bot`
 * é uma decisão já tomada, auditada e visível ao operador no console. Uma flag
 * que a ignorasse faria a plataforma voltar a responder numa conversa que um
 * humano assumiu — que é precisamente o dano que o P04 existe para impedir. O
 * "kill switch" desta fatia é não criar controles, nunca desrespeitar os que
 * existem.
 *
 * ─── O escape, e por que ele não é fail-open ─────────────────────────────
 *
 * `stream_key IS NULL` devolve `TRUE`, como em `streamHeadOfLineNotExists` e
 * `streamNotPoisoned`. Um turno sem identidade de stream não pertence a conversa
 * nenhuma, e o controle é endereçado POR STREAM
 * (`conversation_controls_stream_uq`): não existe controle que possa alcançá-lo.
 * Recusá-lo tornaria inclaimável todo turno anterior ao protocolo. Medição neste
 * banco: 10.833 dos 10.957 turnos não têm stream — e ZERO turnos têm stream sem
 * sequência, porque `createReceivedTurnTx` grava as duas colunas juntas ou
 * nenhuma. O fail-closed de verdade acontece no INGRESSO (`requireStreamIdentity`),
 * não aqui.
 *
 * ─── Custo ───────────────────────────────────────────────────────────────
 *
 * A subconsulta é um lookup no índice único `conversation_controls_stream_uq`
 * `(tenant_id, agent_id, stream_key)` (migration 140). O escopo entra como
 * FRAGMENTO, e não como string, porque os quatro consumidores escopam de formas
 * diferentes: o claim, o recovery e a promoção têm o par do ALS como parâmetro;
 * o dispatcher cross-tenant correlaciona com as colunas da própria linha. Um
 * `string` obrigaria o dispatcher a montar o predicado à mão — a segunda cópia
 * que este módulo existe para impedir.
 */
export function streamNotHumanControlled(input: {
  tenant: SQL;
  agent: SQL;
  alvo: SQL;
}): SQL {
  return sql`(
        ${input.alvo}.stream_key IS NULL
     OR NOT EXISTS (
          SELECT 1
            FROM ${conversation_controls} AS controle
           WHERE controle.tenant_id  = ${input.tenant}
             AND controle.agent_id   = ${input.agent}
             AND controle.stream_key = ${input.alvo}.stream_key
             AND controle.mode <> 'bot'
        )
  )`;
}

/**
 * A SONDA de diagnóstico: qual controle está retendo a conversa deste turno, e
 * em que modo.
 *
 * Só o caminho de FRACASSO do claim a usa (`explainClaimRejection`), e é ela que
 * torna possível cumprir a exigência de "motivo FECHADO" do §8.2.4: sem ela a
 * recusa cairia no `not_eligible` genérico, que fala do TURNO ("este aqui não
 * pode ser reivindicado agora") quando o fato é sobre a CONVERSA ("um humano
 * está no controle"). São diagnósticos com remediações opostas.
 *
 * O `mode` vem junto porque `pausing` e `human` são leituras operacionais
 * diferentes — "estamos parando, há I/O em voo" e "um humano está atendendo" — e
 * o console decide o que mostrar com base nisso.
 *
 * ─── O que ela NÃO projeta, e por quê ────────────────────────────────────
 *
 * `stream_key`: a issue-mãe da #505 a restringe a log protegido. Ela aparece no
 * JOIN, que é onde a comparação acontece; o que não pode é SAIR da consulta —
 * mesma regra de `streamPoisonProbe`.
 *
 * `owner_app_user_id`, `reason_code`, `reason_ref`: quem recusa um claim precisa
 * saber que HÁ hold, não quem o colocou nem por quê. O dono e o motivo são dados
 * de atendimento, e o console os lê pela sua própria porta, com a sua própria
 * ACL. Trazê-los para o caminho do claim os poria a um `logger.info` de
 * distância de virar campo de log de rotina.
 *
 * O alvo entra como JOIN (`agent_turns AS alvo`) em vez de valores lidos antes:
 * ler `stream_key` numa consulta e compará-la na seguinte abriria a janela em
 * que o turno muda entre as duas, e a explicação do fracasso passaria a
 * descrever um estado que já não existe.
 */
export function humanControlProbe(input: {
  tenant: SQL;
  agent: SQL;
  turn_id: string;
}): SQL {
  return sql`
    SELECT controle.id AS control_id, controle.mode AS mode
      FROM ${agent_turns} AS alvo
      JOIN ${conversation_controls} AS controle
        ON  controle.tenant_id  = ${input.tenant}
        AND controle.agent_id   = ${input.agent}
        AND controle.stream_key = alvo.stream_key
     WHERE alvo.tenant_id = ${input.tenant}
       AND alvo.agent_id  = ${input.agent}
       AND alvo.id        = ${input.turn_id}
       AND alvo.stream_key IS NOT NULL
       AND controle.mode <> 'bot'
     LIMIT 1`;
}

// ─── P04.5b.2a — O DESCARTE ADMINISTRATIVO DE BACKLOG (§8.2.5) ──────────────

/**
 * Estados de origem do descarte, na ordem em que a spec os enumera.
 *
 * O §8.2.5 diz "turnos `received/queued/retryable` retidos pelo controle". Os
 * dois primeiros chegam aqui pela tabela AUTOMÁTICA ou pela MANUAL conforme o
 * caso (`received → ignored` é automática desde o #503; `queued` e `retryable`
 * ganharam aresta manual no P04.5b.1).
 *
 * **`running` está deliberadamente FORA**, e essa ausência é a metade que
 * importa: ele TEM aresta automática para `ignored`, então um conjunto montado
 * por `sourceStatusesFor('ignored', { manual: true })` o traria junto — e
 * cancelar administrativamente um turno EM EXECUÇÃO é o oposto do "sem
 * execução/efeito pendente" que a spec exige. `outbound_pending` também fica de
 * fora, pela cláusula seguinte: "turnos antes executados ou `outbound_pending`
 * seguem conciliação específica; não apagar seu resultado/efeito para fazê-los
 * caber no descarte do backlog".
 */
export const ESTADOS_DESCARTAVEIS_DO_BACKLOG = [
  'received',
  'queued',
  'retryable',
] as const;

/**
 * Estados em que uma chamada de tool NÃO está liquidada — ela ainda pode
 * produzir efeito.
 *
 * É o conjunto do índice parcial `engine_tool_calls_unsettled_idx` (migration
 * 140), com `effect_unknown` dentro porque uma call de efeito incerto continua
 * bloqueadora (§5.7.4 item 9).
 *
 * ⚠️ **Já existem duas cópias desta lista no repositório** —
 * `ESTADOS_EM_VOO` em `conversation-control-repo.ts` e
 * `ESTADOS_QUE_OCUPAM_A_VAGA` em `engine-repos.ts`. Esta é a terceira, e eu a
 * escrevo sabendo disso em vez de fingir que não vi: unificá-las é mudança em
 * três módulos de donos diferentes, sem teste que a cubra, e fazê-la no meio
 * desta fatia seria refatoração de arrasto. Fica NOMEADA aqui para ganhar
 * vermelho próprio na fatia de fiação — o risco real é o índice parcial da 140
 * mudar e só uma das cópias acompanhar.
 */
export const ESTADOS_DE_CALL_EM_VOO = [
  'received',
  'dispatching',
  'handler_started',
  'effect_unknown',
] as const;

/**
 * Os estados como LITERAIS SQL, não como parâmetros.
 *
 * ⚠️ **A justificativa aqui foi CORRIGIDA depois de medir.** A primeira versão
 * deste comentário copiava a de `stream-head-sql.ts` — "literais para o
 * planejador provar a implicação e escolher o índice parcial". Rodei `EXPLAIN`
 * contra o Postgres real e a afirmação é FALSA para estas consultas:
 * `engine_tool_calls_unsettled_idx` **não** é escolhido; o plano usa
 * `engine_tool_calls_ordinal_uq` com `Filter`. E a causa não é o `OR` da
 * evidência — é que aquele índice é chaveado por
 * `(tenant_id, agent_id, run_id, ordinal)` e esta consulta filtra por
 * **`turn_id`**, que não está nele. Nenhum rearranjo do predicado tornaria a
 * frase verdadeira; só um índice novo por turno, que é migration e não pertence
 * a esta fatia.
 *
 * O que continua VERDADEIRO e é a razão de manter literais:
 *
 *  1. o texto fica idêntico ao do predicado do índice parcial da migration 140,
 *     de modo que uma divergência de vocabulário (um estado novo num lado só)
 *     salta aos olhos em vez de virar plano ruim silencioso;
 *  2. `status = ANY ('{...}')` resolvido no texto não depende de o planejador
 *     ter substituído parâmetros, então o plano não muda entre a execução custom
 *     e a genérica — que é a degradação difícil de flagrar do `stream-head-sql`.
 *
 * O plano completo medido está no V-043. Registrar a limitação é melhor do que
 * herdar uma justificativa que soa bem e não se aplica.
 *
 * Seguro por construção: os valores vêm de `as const` deste arquivo, nunca de
 * entrada externa. A guarda abaixo existe para que isso continue verdadeiro se
 * alguém acrescentar um estado.
 */
function literais(valores: readonly string[]): SQL {
  for (const v of valores) {
    if (!/^[a-z_]+$/.test(v)) {
      throw new Error(
        `conversation-control-sql: '${v}' não é identificador simples e não pode ser ` +
          'inlinado como literal SQL.',
      );
    }
  }
  return sql.raw(valores.map((v) => `'${v}'`).join(', '));
}

/**
 * `TRUE` quando o turno alvo **não** tem execução nem efeito pendente.
 *
 * ─── Por que um predicado NOVO, e não a consulta de drenagem que já existe ──
 *
 * `reconcilePauseTx` já compõe evidência de efeito, mas escopada pelo
 * CONTROLE: ela responde "esta CONVERSA tem algo em voo?". A pergunta do
 * §8.2.5 é outra — "este TURNO tem execução ou efeito pendente?" — e conflatar
 * as duas teria consequência concreta nos dois sentidos: um único run aberto em
 * qualquer turno impediria o descarte de TODO o backlog, e um backlog inteiro
 * sem efeito nenhum ficaria preservado por causa de um turno alheio.
 *
 * ─── O que ele prova, e o que NÃO prova ───────────────────────────────────
 *
 * PROVA, pelas três fontes que o C42 declara como composição (o "journal de
 * efeitos/admissão" que o §8.2.3 pressupõe não existe): não há run aberto para
 * o turno, não há call em estado não liquidado, e nenhuma call carrega
 * evidência de efeito `unknown`.
 *
 * NÃO PROVA ausência de efeito de origem NÃO-engine. `outbound_messages` só
 * alcança o turno, e egresso produzido por caminhos legados (outbox drain,
 * relayer, lembretes) não passa por run nenhum — é o C43, e a cobertura dele é
 * a unidade dos fences do §8.2.4, não esta. Quem lê este predicado como "o
 * turno não produziu efeito algum" está lendo mais do que ele diz.
 */
export function turnWithoutPendingEffectSql(input: {
  tenant: SQL;
  agent: SQL;
  alvo: SQL;
}): SQL {
  return sql`(
     NOT EXISTS (
          SELECT 1
            FROM ${engine_runs} r
           WHERE r.tenant_id = ${input.tenant} AND r.agent_id = ${input.agent}
             AND r.turn_id = ${input.alvo}.id
             AND r.phase <> 'closed'
        )
     AND NOT EXISTS (
          SELECT 1
            FROM ${engine_tool_calls} c
           WHERE c.tenant_id = ${input.tenant} AND c.agent_id = ${input.agent}
             AND c.turn_id = ${input.alvo}.id
             AND (c.state IN (${literais(ESTADOS_DE_CALL_EM_VOO)})
                  OR c.effect_evidence = 'unknown')
        )
  )`;
}

/**
 * A SELEÇÃO do backlog retido que o `resume` vai descartar, trancada para
 * escrita e em ordem determinística.
 *
 * ─── As três conjunções do §8.2.5, e nenhuma a mais ───────────────────────
 *
 *  1. **retidos pelo controle** — a stream vem da linha de controle, nunca de
 *     um `stream_key` passado pelo caller. Deixá-la entrar de fora permitiria
 *     descartar o backlog de uma conversa com o comando de outra;
 *  2. **sem execução/efeito pendente** — `turnWithoutPendingEffectSql`, com os
 *     limites que o cabeçalho dele declara;
 *  3. **anteriores ou iguais ao watermark** — `<=`, porque o watermark é o
 *     último ingresso RETIDO e ele próprio entra no descarte; `<` deixaria
 *     exatamente uma mensagem para trás. `IS NOT NULL` é explícito: turno sem
 *     sequência (caminho de compatibilidade, C50) não é ordenável por ingresso,
 *     e `NULL <= x` já o excluiria — a guarda existe para que a exclusão seja
 *     DECISÃO legível, e não efeito colateral da semântica de NULL que alguém
 *     "simplifica" depois.
 *
 * ─── A ordem de lock ──────────────────────────────────────────────────────
 *
 * `ORDER BY t.id` + `FOR UPDATE OF t` é a "ordem determinística de turnos" que
 * o §8.2.3 passo 3 exige dentro da ordem global (controle → stream → turnos →
 * efeito/outbox). O precedente é `recoverExpiredStreamClaims`, e o comentário
 * dele explica o porquê: sem `ORDER BY`, duas transações que toquem a mesma
 * stream adquirem o conjunto em ordens diferentes e podem fechar ciclo.
 *
 * **`FOR UPDATE OF t`, nunca `FOR UPDATE` pelado** — a consulta junta
 * `conversation_controls`, e um lock pelado trancaria o controle por um SEGUNDO
 * caminho, que é o "ordenamento incompatível" do §8.2.3 passo 3. É a mesma
 * cláusula que o caso 5 deste módulo já prende para o lock por run.
 *
 * Projeção mínima: `id` e `state_version`, porque a transição de cada turno é
 * compare-and-swap e ler a versão numa segunda consulta abriria a janela em que
 * o turno muda entre as duas. `stream_key` NÃO sai da consulta — ela aparece no
 * JOIN, que é onde a comparação acontece, e a issue-mãe da #505 a restringe a
 * log protegido.
 */
export function heldBacklogForCancellationSql(input: {
  tenant_id: string;
  agent_id: string;
  control_id: string;
  /** Decimal em string: `resume_after_ingress_seq` é `bigint` (§8.3.2). */
  watermark: string;
}): SQL {
  const tenant = sql`${input.tenant_id}`;
  const agent = sql`${input.agent_id}`;
  return sql`
    SELECT t.id, t.state_version
      FROM ${agent_turns} t
      JOIN ${conversation_controls} c
        ON  c.tenant_id  = t.tenant_id AND c.agent_id = t.agent_id
        AND c.stream_key = t.stream_key
     WHERE c.tenant_id = ${tenant} AND c.agent_id = ${agent}
       AND c.id = ${input.control_id}
       AND t.status IN (${literais(ESTADOS_DESCARTAVEIS_DO_BACKLOG)})
       AND t.last_ingress_seq IS NOT NULL
       AND t.last_ingress_seq <= ${input.watermark}::bigint
       AND ${turnWithoutPendingEffectSql({ tenant, agent, alvo: sql`t` })}
     ORDER BY t.id
       FOR UPDATE OF t`;
}
