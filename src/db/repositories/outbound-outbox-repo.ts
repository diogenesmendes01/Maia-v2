/**
 * Issue #631 (fatia B da épica #506) — o COMMIT TRANSACIONAL da resposta.
 *
 * Este módulo tem UMA função de produção que importa, e ela é uma transação só:
 * `commitTurnOutboundTx`. Dentro dela, nesta ordem e sem nenhum ponto de
 * escape,
 *
 *   1. o turno é movido para `outbound_pending` com o FENCE da tentativa
 *      (`claim_token` vigente + lease viva) e o CAS por `state_version`;
 *   2. o artefato outbound de #630 é inserido com a `logical_dedupe_key`;
 *   3. o evento de auditoria `outbound_committed` é gravado no MESMO `tx`;
 *   4. commit.
 *
 * Fora dela não existe caminho: se qualquer passo falhar, o `withTx` faz
 * ROLLBACK e a exceção sobe. É isso que transforma "o ledger é opcional" (o
 * defeito que a auditoria da #506 encontrou em `src/agent/output-dispatch.ts`)
 * em "sem banco não há envio".
 *
 * ─── Por que aqui e não em `turn-repos.ts` ──────────────────────────────────
 *
 * `agentTurnsRepo.markOutboundCommittedTx` existe e faz a transição — mas ela
 * abre a PRÓPRIA transação (`runTransition` chama `withTx`). Chamá-la de dentro
 * de outro `withTx` executaria o UPDATE do turno numa CONEXÃO DIFERENTE da do
 * INSERT do outbox: dois commits independentes, e exatamente a janela de crash
 * que esta fatia existe para fechar. A atomicidade exige que as duas escritas
 * compartilhem o `tx`, então o UPDATE é montado aqui — mas o `WHERE` NÃO é
 * reescrito: ele vem de `turnWriteConditions()` (`turn-fence-sql.ts`), a mesma
 * fonte ÚNICA que `runTransition` usa. Apagar a condição de lease de lá deixa
 * a produção insegura nos dois caminhos ao mesmo tempo, que é a única relação
 * que faz um predicado compartilhado valer alguma coisa.
 *
 * O par (from, to) continua sendo validado contra o contrato de #503 —
 * `assertTurnTransition` — antes de tocar o banco, pela mesma razão que
 * `transitionTurn` o faz: uma transição ilegal é erro de programação, não
 * conflito de corrida.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, withTx } from '../client.js';
import { agent_turns, outbound_messages } from '../schema.js';
import type { AgentTurn } from '../schema.js';

/** A row do outbox, como o Drizzle a projeta. */
export type OutboundOutboxRow = typeof outbound_messages.$inferSelect;
import { getCurrentTenant, getCurrentAgent } from '../tenant-context.js';
import { auditTx } from '@/governance/audit.js';
import { assertTurnTransition } from '@/runtime/turns/contract.js';
import type { TurnStatus } from '@/runtime/turns/contract.js';
import { turnWriteConditions } from './turn-fence-sql.js';
import type { OutboundArtifact } from '@/runtime/outbound/contract.js';
import { legacyChannelFor } from '@/runtime/outbound/contract.js';

/**
 * Estados do turno a partir dos quais o commit outbound é aceito.
 *
 * `running` é o caminho normal — a cognição acabou de concluir. `outbound_pending`
 * está aqui de propósito, e é uma SELF-TRANSITION deliberada: uma resposta
 * multipart (#635) compromete N artefatos do MESMO turno, e o segundo deles
 * encontra o turno já em `outbound_pending`. Recusar seria tornar multipart
 * inexprimível; aceitar não afrouxa nada, porque o fence e o CAS continuam
 * valendo em cada uma das N gravações.
 *
 * O que NÃO está aqui: qualquer estado terminal, `claimed`, `retryable`. Um
 * turno que ainda não começou a executar — ou que já acabou — não pode
 * comprometer resposta.
 */
export const OUTBOUND_COMMIT_SOURCE_STATUSES = ['running', 'outbound_pending'] as const;

/** Por que o commit transacional foi RECUSADO. Vocabulário fechado. */
export const OUTBOUND_COMMIT_REJECTIONS = [
  /** O turno não existe no escopo (tenant+agent) corrente. */
  'turn_not_found',
  /**
   * O `claim_token` da tentativa não é mais o vigente na linha, ou a lease
   * venceu. É o caso que o critério de pronto nomeia: "um worker sem posse NÃO
   * consegue commitar resposta".
   */
  'stale_claim',
  /** O turno andou de estado (ou de versão) desde a leitura do chamador. */
  'state_mismatch',
] as const;

export type OutboundCommitRejection = (typeof OUTBOUND_COMMIT_REJECTIONS)[number];

/**
 * O commit transacional FALHOU. É um erro e não um retorno tipado, e a escolha
 * é o ponto inteiro da fatia: o chamador é o dispatcher de saída, cuja próxima
 * linha é a chamada ao canal. Um retorno `{ ok: false }` é ignorável — basta um
 * `if` esquecido para o envio acontecer assim mesmo, que é literalmente o
 * defeito atual. Uma exceção não é ignorável.
 */
export class OutboundCommitError extends Error {
  readonly code = 'OUTBOUND_COMMIT_FAILED';
  readonly rejection: OutboundCommitRejection;
  readonly turn_id: string;

  constructor(rejection: OutboundCommitRejection, turn_id: string) {
    super(`outbound_commit_rejected:${rejection}`);
    this.name = 'OutboundCommitError';
    this.rejection = rejection;
    this.turn_id = turn_id;
  }
}

export type OutboundCommitInput = {
  /** O artefato determinístico de #630, já construído e validado. */
  artifact: OutboundArtifact;
  /** Conversa da saída. Coluna NOT NULL desde a 063. */
  conversa_id: string;
  /** Mensagem inbound representativa do turno. Coluna NOT NULL desde a 063. */
  in_reply_to: string;
  /** CAS opcional sobre `agent_turns.state_version`. */
  expected_state_version?: number;
  /**
   * O FENCE. Presente sempre que a tentativa tem posse (`FEATURE_TURN_CLAIM`
   * ON, o default). Ausente apenas no regime de rollback de #503, onde não
   * existe token a exigir — e nesse regime o CAS por `state_version` é o que
   * resta, exatamente como em toda outra gravação de turno.
   */
  expected_claim_token?: string;
  /** Só para auditoria/correlação. Nunca entra na derivação de chave. */
  pessoa_id?: string | null;
};

export type OutboundCommitResult = {
  /** A linha do outbox — recém-inserida OU a que já existia (idempotência). */
  row: OutboundOutboxRow;
  /** O turno DEPOIS da transição, para o caller atualizar o handle em memória. */
  turn: AgentTurn;
  /**
   * `false` quando a `logical_dedupe_key` já existia: a saída lógica já estava
   * comprometida por uma tentativa anterior e NENHUMA segunda linha nasceu. O
   * critério de pronto "duas tentativas de inserir a mesma saída lógica
   * resultam em UMA linha" é observável por aqui.
   */
  inserted: boolean;
};

export const outboundOutboxRepo = {
  /**
   * A TRANSAÇÃO ÚNICA. Ver o cabeçalho do módulo para a ordem e a razão.
   *
   * Lança `OutboundCommitError` quando o turno recusa a gravação (posse
   * perdida, estado/versão divergentes, turno inexistente no escopo) e propaga
   * qualquer erro de banco. Nos dois casos o `withTx` já fez ROLLBACK: não há
   * linha parcial, não há turno em `outbound_pending` sem artefato, e o
   * chamador NÃO pode enviar.
   */
  async commitTurnOutboundTx(input: OutboundCommitInput): Promise<OutboundCommitResult> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const { artifact } = input;

    // Isolamento por construção: o artefato foi derivado sob UM escopo e a
    // transação roda sob o escopo do ALS. Se divergirem, a `logical_dedupe_key`
    // (que tem tenant e agent no material) pertenceria a outro tenant — e a
    // linha entraria no espaço de unicidade errado. Fail-closed, antes do banco.
    if (artifact.tenant_id !== tenant_id || artifact.agent_id !== agent_id) {
      throw new Error(
        'commitTurnOutboundTx: o escopo do artefato outbound diverge do contexto ativo — ' +
          'a chave lógica foi derivada para outro tenant/agent e a gravação seria um vazamento.',
      );
    }

    // Contrato de #503 ANTES do banco. `outbound_pending -> outbound_pending`
    // não está na tabela de transições (nem deveria: é uma self-transition de
    // multipart, não uma aresta do ciclo de vida), então só o par vindo de
    // `running` é validado — é o que a tabela descreve.
    assertTurnTransition('running', 'outbound_pending', null);

    return withTx(async (tx) => {
      // ── (1) O TURNO. Fenced + CAS, numa única declaração. ────────────────
      const turnRows = await tx
        .update(agent_turns)
        .set({
          status: 'outbound_pending',
          state_version: sql`${agent_turns.state_version} + 1`,
          outbound_committed_at: sql`now()`,
          updated_at: sql`now()`,
        } as never)
        .where(
          and(
            ...turnWriteConditions({
              tenant_id,
              agent_id,
              turn_id: artifact.turn_id,
              sources: OUTBOUND_COMMIT_SOURCE_STATUSES as readonly TurnStatus[],
              ...(input.expected_state_version !== undefined
                ? { expected_version: input.expected_state_version }
                : {}),
              fence:
                input.expected_claim_token !== undefined
                  ? { kind: 'self', claim_token: input.expected_claim_token }
                  : { kind: 'none' },
            }),
          ),
        )
        .returning();

      const turn = turnRows[0];
      if (!turn) {
        // Classificação do conflito, com a MESMA ordem de `runTransition`:
        // quando havia fence e ele não bate, a causa é PERDA DE POSSE, mesmo
        // que o estado também tenha andado. Dizer `state_mismatch` aqui mandaria
        // um zumbi reler e insistir — a reação exatamente errada.
        const [current] = await tx
          .select({
            claim_token: agent_turns.claim_token,
            lease_live: sql<boolean>`(${agent_turns.lease_expires_at} > now())`,
          })
          .from(agent_turns)
          .where(
            and(
              eq(agent_turns.tenant_id, tenant_id),
              eq(agent_turns.agent_id, agent_id),
              eq(agent_turns.id, artifact.turn_id),
            ),
          )
          .limit(1);
        if (!current) throw new OutboundCommitError('turn_not_found', artifact.turn_id);
        const fenceBroken =
          input.expected_claim_token !== undefined &&
          (current.claim_token !== input.expected_claim_token || current.lease_live !== true);
        throw new OutboundCommitError(
          fenceBroken ? 'stale_claim' : 'state_mismatch',
          artifact.turn_id,
        );
      }

      // ── (2) O ARTEFATO. Mesma transação, mesma conexão. ──────────────────
      //
      // `idempotency_key` recebe a `logical_dedupe_key`: a coluna é NOT NULL
      // desde a 063 e carrega o unique TOTAL `(tenant, agent, idempotency_key)`,
      // enquanto o unique de #630 é PARCIAL. Usar a mesma chave nas duas faz as
      // duas constraints afirmarem a MESMA coisa sobre a row durável, e o
      // prefixo `mol1_` a mantém fora do espaço de nomes das chaves legadas
      // (`<conversa_uuid>:<mensagem_uuid>`), que é como as duas famílias
      // coabitam sem colidir.
      const inserted = await tx
        .insert(outbound_messages)
        .values({
          tenant_id,
          agent_id,
          idempotency_key: artifact.logical_dedupe_key,
          conversa_id: input.conversa_id,
          in_reply_to: input.in_reply_to,
          channel: legacyChannelFor(artifact.payload_type),
          status: 'pending',
          turn_id: artifact.turn_id,
          sequence_in_turn: artifact.sequence_in_turn,
          payload_version: artifact.payload_version,
          payload_type: artifact.payload_type,
          payload_json: artifact.payload,
          payload_hash: artifact.payload_hash,
          logical_dedupe_key: artifact.logical_dedupe_key,
          provider_idempotency_key: artifact.provider_idempotency_key,
          // Relógio do BANCO. `next_attempt_at` é NOT NULL para row durável
          // (CHECK de completude da 121) e é o gate que o índice (7c) percorre:
          // é ele que torna a linha VISÍVEL para o recovery de #633 no instante
          // do commit — que é o mecanismo pelo qual "enqueue perdido depois do
          // commit é recuperado" não depende da BullMQ.
          next_attempt_at: sql`now()`,
        } as never)
        // Idempotência da SAÍDA LÓGICA. `DO NOTHING` sem `target`: as duas
        // constraints (o unique total do legado e o parcial de #630) afirmam a
        // mesma coisa aqui, e nomear uma delas deixaria a outra virar erro.
        .onConflictDoNothing()
        .returning();

      let row = inserted[0];
      if (!row) {
        // A saída lógica já estava comprometida — retry da MESMA resposta.
        // Reler é obrigatório: o caller precisa do `id` para correlacionar, e a
        // ausência de linha nova é o desfecho CORRETO, não um erro.
        const [existing] = await tx
          .select()
          .from(outbound_messages)
          .where(
            and(
              eq(outbound_messages.tenant_id, tenant_id),
              eq(outbound_messages.agent_id, agent_id),
              eq(outbound_messages.logical_dedupe_key, artifact.logical_dedupe_key),
            ),
          )
          .limit(1);
        if (!existing) {
          // Conflito sem linha correspondente = a colisão foi em OUTRA
          // constraint (por exemplo, a posição `(turn, sequence)` já ocupada
          // por conteúdo diferente). Isso não é idempotência: é duas saídas
          // lógicas distintas disputando a mesma posição, e seguir seria
          // enviar sem registro.
          throw new Error(
            'commitTurnOutboundTx: conflito de unicidade sem linha correspondente à chave lógica — ' +
              'a posição (turn_id, sequence_in_turn) provavelmente já está ocupada por outro payload.',
          );
        }
        row = existing;
      }

      // ── (2b) O PONTEIRO do turno para o primeiro artefato. ───────────────
      //
      // `agent_turns.outbound_message_id` é singular e a resposta pode ser
      // multipart (#635), então ele aponta para o PRIMEIRO artefato e nunca é
      // sobrescrito: `coalesce` deixa a segunda parte passar sem apagar o elo
      // que a primeira estabeleceu. Sem `WHERE` de fence aqui de propósito — a
      // autoridade desta gravação já foi decidida no passo (1), na MESMA
      // transação e na MESMA linha, e repetir o predicado só criaria um
      // segundo lugar de onde ele poderia sumir.
      const linked = await tx
        .update(agent_turns)
        .set({
          outbound_message_id: sql`coalesce(${agent_turns.outbound_message_id}, ${row.id}::uuid)`,
        } as never)
        .where(
          and(
            eq(agent_turns.tenant_id, tenant_id),
            eq(agent_turns.agent_id, agent_id),
            eq(agent_turns.id, artifact.turn_id),
          ),
        )
        .returning();

      // ── (3) A AUDITORIA, no MESMO tx. `auditTx` NÃO engole erro. ─────────
      //
      // `audit()` (o writer normal) captura a própria falha e segue — correto
      // para telemetria de caminho quente, errado aqui: este evento é a prova
      // durável de que a intenção de resposta foi comprometida, e uma resposta
      // comprometida sem trilha é o mesmo buraco de governança que a #366
      // fechou para as tools que mexem em dinheiro.
      await auditTx(tx, {
        acao: 'outbound_committed',
        ...(input.pessoa_id ? { pessoa_id: input.pessoa_id } : {}),
        conversa_id: input.conversa_id,
        mensagem_id: input.in_reply_to,
        alvo_id: row.id,
        metadata: {
          turn_id: artifact.turn_id,
          outbound_id: row.id,
          sequence_in_turn: artifact.sequence_in_turn,
          payload_type: artifact.payload_type,
          payload_version: artifact.payload_version,
          // O digest é inerte (sha256, pré-imagem-resistente) e é o que permite
          // correlacionar a trilha com a row sem carregar conteúdo nem telefone.
          payload_hash: artifact.payload_hash,
          from_status: 'running',
          to_status: 'outbound_pending',
          idempotent_reuse: inserted.length === 0,
        },
      });

      return { row, turn: linked[0] ?? turn, inserted: inserted.length > 0 };
    });
  },

  /**
   * Resultado da tentativa de entrega feita PELO PRÓPRIO worker que commitou.
   *
   * ─── Por que isto existe, e por que é explicitamente provisório ──────────
   *
   * A fatia B entrega o commit; o delivery worker com claim/lease é a #632.
   * Enquanto ela não chega, quem entrega é o mesmo processo, logo em seguida —
   * e sem registrar o desfecho a linha durável ficaria `pending` PARA SEMPRE,
   * inclusive nas saídas que o usuário já recebeu. Quando a #632 subir, ela
   * varreria essas linhas e reenviaria tudo: um duplo envio criado justamente
   * pela mecânica que existe para impedi-lo.
   *
   * Então esta função fecha a linha com o desfecho NORMALIZADO de #506 §Resultado
   * do provider. Ela NÃO tem claim, NÃO tem lease e NÃO tem fence de outbound —
   * isso é #632, e o comentário fica para que a ausência seja lida como escopo,
   * não como esquecimento.
   *
   * NÃO lança: quando ela roda, o efeito externo JÁ ocorreu. Falhar aqui não
   * desfaz o envio, e transformar bookkeeping pós-efeito em exceção só trocaria
   * uma linha desatualizada por um turno abortado. A linha fica `pending` e a
   * reconciliação de #633 é quem decide — que é o desfecho honesto para
   * "enviamos e não conseguimos registrar".
   */
  async recordInlineDeliveryOutcome(input: {
    outbound_id: string;
    status: 'delivered' | 'delivery_unknown' | 'retryable';
    delivery_outcome:
      | 'accepted_confirmed'
      | 'accepted_unconfirmed'
      | 'rejected_retryable'
      | 'timeout_unknown';
    provider_message_id?: string | null;
    last_error_code?: string | null;
  }): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(outbound_messages)
      .set({
        status: input.status,
        delivery_outcome: input.delivery_outcome,
        provider_message_id: input.provider_message_id ?? null,
        last_error_code: input.last_error_code ?? null,
        attempt: sql`${outbound_messages.attempt} + 1`,
        ...(input.status === 'delivered'
          ? { sent_at: sql`now()`, provider_timestamp: sql`now()` }
          : {}),
      } as never)
      .where(
        and(
          eq(outbound_messages.tenant_id, tenant_id),
          eq(outbound_messages.agent_id, agent_id),
          eq(outbound_messages.id, input.outbound_id),
          // CAS de estado: só uma linha AINDA pendente aceita desfecho. Impede
          // que um caminho tardio sobrescreva um `delivered` já registrado.
          eq(outbound_messages.status, 'pending'),
        ),
      );
  },
};
