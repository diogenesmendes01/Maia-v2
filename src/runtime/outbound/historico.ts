/**
 * Issue #635 (fatia F da épica #506) — a PROJEÇÃO do artefato no histórico da
 * conversa.
 *
 * Uma definição, um lugar, dois chamadores: o ciclo de entrega
 * (`delivery.ts` → `completeDeliveryTx`) e a reconciliação
 * (`workers/outbound-recovery.ts` → `recoverHistoryAndCompleteTx`), que fabrica
 * o histórico perdido na janela `delivered -> completed`.
 *
 * ═══ A objeção da #633, e por que ela não se aplica ════════════════════════
 *
 * A #633 recusou fabricar o histórico faltante com esta justificativa: *"não
 * fabrico o histórico porque o texto teria de ser re-renderizado a partir do
 * payload, duplicando `buildHistorico`"*. A regra que ela protegia é real e
 * continua valendo — a #632 a escreveu assim: **não gerar texto de novo no
 * delivery worker**, porque uma segunda passada de cognição produziria outro
 * texto, outro `payload_hash`, outra `logical_dedupe_key`, e a idempotência
 * inteira desapareceria na tentativa em que ela precisa funcionar.
 *
 * O que esta função faz NÃO é isso, e a diferença é verificável:
 *
 *  1. **Não há cognição.** Não há LLM, template, `Intl`, locale, relógio, RNG
 *     ou leitura de configuração. A função é total, pura e síncrona: mesmos
 *     argumentos ⇒ mesmos bytes, em qualquer processo, em qualquer instante.
 *  2. **A entrada é IMUTÁVEL.** `payload_json` foi congelado no commit de #631
 *     e é coberto por `payload_hash` (#630); a row é imutável depois de pronta
 *     para envio, por contrato da épica. O `provider_message_id` e o
 *     `in_reply_to` já estão persistidos na mesma linha. A reconciliação lê os
 *     MESMOS bytes que o ciclo de entrega leu.
 *  3. **O ciclo de entrega já fazia exatamente isto.** Ele nunca leu do
 *     "fio" o que mandou: ele projetava o artefato. Esta função é a mesma
 *     projeção, movida para um módulo próprio.
 *
 * Ou seja: o caminho de recuperação não cria uma segunda definição do que foi
 * dito. **Duplicar a função — que era o que a #633 temia — é que criaria.**
 * Compartilhá-la remove a possibilidade de divergência em vez de introduzi-la:
 * não existe um segundo corpo de código onde alguém possa mudar um dos lados.
 *
 * ─── E se alguém mudar a projeção? ─────────────────────────────────────────
 *
 * Aí os dois caminhos mudam juntos — e o histórico passa a divergir do que o
 * usuário RECEBEU. Esse risco é real e é anterior a esta fatia; o que ela
 * acrescenta é a prova. A sonda
 * `tests/integration/outbound-historico-idempotente-real-db.spec.ts` compara o
 * `conteudo` recuperado com a string EXATA que o adaptador entregou ao
 * provedor, capturada por um `LineOutput` fake. Nenhum dos dois lados da
 * comparação é produzido por esta função — o oráculo é o que saiu pelo canal.
 *
 * ═══ RETENÇÃO ══════════════════════════════════════════════════════════════
 *
 * "Artefatos de auditoria e histórico não podem conter mídia ou conteúdo
 * sensível além da política de retenção" (#635, §Retenção). A garantia aqui é
 * ESTRUTURAL, não uma limpeza a posteriori:
 *
 *  - `midia_url` é sempre `null` no INSERT (ver `completeDeliveryTx`). A
 *    referência de mídia de #630 é `local_path`/`storage_object` e não uma URL;
 *    persistir um caminho de arquivo temporário seria um link morto no dia
 *    seguinte E uma pista de onde o binário mora, no histórico, sem política de
 *    expiração própria.
 *  - o `metadata` é MONTADO campo a campo. Em nenhum ramo o payload é
 *    espalhado (`...payload`), então nenhum `media` chega aqui por descuido —
 *    um campo novo na união só entra no histórico se alguém o escrever
 *    explicitamente. `MEDIA_BEARING_PAYLOAD_FIELDS` nomeia o que está proibido,
 *    e a sonda de unidade percorre `OUTBOUND_PAYLOAD_TYPES` inteiro exigindo
 *    ausência — então um tipo NOVO adicionado à união sem tratamento aqui
 *    quebra a suíte em vez de vazar.
 */
import { OUTBOUND_PAYLOAD_TYPES, type OutboundPayload } from './contract.js';

/**
 * O que a projeção grava em `mensagens`. Deliberadamente NÃO inclui
 * `midia_url`: quem insere passa `null` literal, e não há campo por onde um
 * chamador o forneça.
 */
export type HistoricoProjection = {
  /** `mensagens.tipo` — vocabulário da 001/116, não o `payload_type` de #630. */
  tipo: string;
  conteudo: string;
  metadata: Record<string, unknown>;
};

export type HistoricoProjectionContext = {
  /** Id do provedor, quando houve. `null` em `accepted_unconfirmed`. */
  provider_message_id: string | null;
  /** JID do destinatário. Vem do chamador — o outbox não persiste telefone. */
  jid: string;
  /** Mensagem de ingresso que esta saída responde. */
  in_reply_to: string;
};

/**
 * Campos da união de #630 que carregam REFERÊNCIA DE MÍDIA. Nenhum pode
 * aparecer no histórico — nem em `conteudo`, nem em `metadata`.
 *
 * Existe como constante exportada, e não como comentário, porque é o predicado
 * que a sonda de retenção exige. Uma lista que o teste lê é uma lista que
 * alguém atualiza quando a união cresce.
 */
export const MEDIA_BEARING_PAYLOAD_FIELDS = ['media', 'path', 'bucket', 'object_key'] as const;

/**
 * `mensagens.tipo` por `payload_type`. Total por construção (`Record` sobre a
 * união fechada), então um tipo novo em #630 não compila até ganhar uma
 * entrada aqui.
 *
 * Os dois vocabulários NÃO são o mesmo e a tradução é o motivo desta tabela:
 * `mensagens.tipo` tem CHECK próprio desde a 001 (mais 'evento' na 116), e
 * gravar o discriminante de #630 direto ali seria recusado pelo banco —
 * silenciosamente, do ponto de vista de quem lê o histórico.
 */
const HISTORICO_TIPO_BY_PAYLOAD: Record<OutboundPayload['type'], string> = {
  text: 'texto',
  status_fallback: 'texto',
  audio: 'audio',
  document: 'documento',
  reaction: 'evento',
  interactive_poll: 'texto',
};

/**
 * O que vai para o histórico da conversa, derivado do ARTEFATO.
 *
 * Total sobre a união: o `default` é inalcançável e existe só para que um tipo
 * novo em #630 seja um erro de COMPILAÇÃO (`never`) em vez de um histórico
 * vazio em produção.
 */
export function buildHistoricoFromArtifact(
  payload: OutboundPayload,
  ctx: HistoricoProjectionContext,
): HistoricoProjection {
  const metadata: Record<string, unknown> = {
    whatsapp_id: ctx.provider_message_id,
    remote_jid: ctx.jid,
    in_reply_to: ctx.in_reply_to,
    outbound_payload_type: payload.type,
  };
  const tipo = HISTORICO_TIPO_BY_PAYLOAD[payload.type];
  switch (payload.type) {
    case 'text':
      return { tipo, conteudo: payload.text, metadata };
    case 'status_fallback':
      return {
        tipo,
        conteudo: payload.text,
        metadata: { ...metadata, fallback_reason: payload.reason },
      };
    case 'audio':
      // `source_text` e não o áudio: é o texto que gerou a voz, persistido em
      // #630 exatamente para que o histórico e o fallback tivessem o conteúdo.
      // O `media` da union NÃO é copiado — ver §RETENÇÃO no topo.
      return { tipo, conteudo: payload.source_text, metadata };
    case 'document':
      return {
        tipo,
        conteudo: payload.caption ?? '',
        // `file_name` é o NOME escolhido pela plataforma para o anexo, não um
        // caminho: ele não localiza o binário nem sobrevive como referência.
        metadata: { ...metadata, file_name: payload.file_name },
      };
    case 'reaction':
      return {
        tipo,
        conteudo: payload.emoji,
        metadata: { ...metadata, target_provider_message_id: payload.target_provider_message_id },
      };
    case 'interactive_poll':
      return {
        tipo,
        conteudo: payload.question,
        metadata: { ...metadata, poll_options: payload.options },
      };
    default: {
      const _never: never = payload;
      void _never;
      throw new TypeError('buildHistoricoFromArtifact: payload fora do contrato de #630');
    }
  }
}

/**
 * Todo `payload_type` da união tem projeção declarada?
 *
 * Redundante com a exaustividade do `switch` em tempo de COMPILAÇÃO, e mantida
 * assim de propósito: `OUTBOUND_PAYLOAD_TYPES` é a lista que o banco usa no
 * CHECK `outbound_messages_payload_type_check` (121), enquanto o `switch` fecha
 * sobre o tipo TypeScript. As duas podem divergir num `as` mal colocado, e a
 * divergência aparece como histórico vazio — não como erro.
 */
export function historicoProjectionCoversAllPayloadTypes(): boolean {
  return OUTBOUND_PAYLOAD_TYPES.every((t) => typeof HISTORICO_TIPO_BY_PAYLOAD[t] === 'string');
}
