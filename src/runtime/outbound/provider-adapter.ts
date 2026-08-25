/**
 * Issue #632 (fatia C da épica #506) — o ADAPTADOR: união de #630 ⇒ primitiva
 * de `LineOutput`, e observação bruta do provedor de volta.
 *
 * Este módulo existe para que o ciclo de entrega (`delivery.ts`) não conheça
 * nem o Baileys nem os cinco `send*`. Ele tem duas responsabilidades, e a
 * segunda é a que a issue nomeia:
 *
 *  1. traduzir o payload persistido na chamada certa, entregando a
 *     `provider_idempotency_key` QUANDO a primitiva a aceita;
 *  2. **encapsular a limitação de idempotência do Baileys numa capability
 *     explícita**, em vez de fingir uma garantia que só existe para texto.
 *
 * ─── O que foi VERIFICADO na fronteira única de saída ───────────────────────
 *
 * `src/gateway/line-output.ts`, interface `LineOutput`:
 *
 *   sendText(jid, text, { quoted?, view_once?, messageId? })   ← messageId
 *   sendDocument(jid, path, { mimetype, fileName, caption?, quoted? })
 *   sendVoice(jid, buf, { quoted? })
 *   sendPoll(jid, question, options)
 *   sendReaction(jid, whatsappId, emoji)   → void, SEM retorno
 *
 * Só `sendText` tem `messageId`. Ele desce para
 * `MiscMessageGenerationOptions.messageId` e o Baileys o grava VERBATIM na key
 * da mensagem; o WhatsApp chaveia por `(remoteJid, fromMe, id)`, então para
 * texto o reenvio é deduplicado PELO PROVEDOR. Nos outros quatro o Baileys
 * gera `generateMessageIDV2()` a cada chamada — um reenvio é uma mensagem NOVA
 * no telefone do usuário.
 *
 * A capability por tipo está em `delivery-contract.ts`
 * (`providerIdempotencySupport`), e é ela — não este módulo — que autoriza ou
 * proíbe o reenvio automático. Aqui a capability só decide se o valor é
 * PASSADO adiante. Separar as duas perguntas é deliberado: passar uma chave que
 * o adaptador ignora é inofensivo; CONFIAR numa que ele ignora é a duplicata.
 *
 * ─── Limitações declaradas, não escondidas ──────────────────────────────────
 *
 * - `sendReaction` devolve `void`. Não há identificador nem confirmação: o
 *   melhor desfecho honesto possível é `accepted_without_id`, que vira
 *   `accepted_unconfirmed` e depois `delivery_unknown`. Não é pessimismo — é o
 *   que a primitiva realmente informa.
 * - `sendVoice` precisa dos BYTES do áudio, e o artefato guarda uma
 *   REFERÊNCIA. A resolução de `storage_object` para bytes não existe ainda
 *   (é #634, junto com a migração dos call sites), então `audio` com
 *   referência de storage é recusado como `rejected_permanent` em vez de
 *   enviar outra coisa. `local_path` é lido do disco — e a limitação de que um
 *   `local_path` não sobrevive entre processos já está declarada no contrato
 *   de #630.
 */
import { readFile } from 'node:fs/promises';
import type { LineOutput } from '@/gateway/line-output.js';
import type { OutboundPayload, OutboundProviderChannel } from './contract.js';
import {
  shouldPassIdempotencyKey,
  type ProviderAttemptObservation,
} from './delivery-contract.js';

export type ProviderCallTarget = {
  line: LineOutput;
  jid: string;
  channel: OutboundProviderChannel;
  /** `provider_idempotency_key` da row. Entregue só onde a primitiva a aceita. */
  provider_idempotency_key: string;
  /** Cancelamento da tentativa dona (#504). Verificado ANTES e DEPOIS da chamada. */
  signal?: AbortSignal;
};

/**
 * Chama o provedor e devolve a OBSERVAÇÃO bruta. Nunca lança por falha de
 * envio: um throw do transporte é capturado e classificado, porque a
 * classificação (`ambiguous`) é a informação mais importante da fatia — é ela
 * que decide se um retry é reenvio cego.
 *
 * `signal.aborted` é consultado nos DOIS lados da chamada, e o `after_send` do
 * segundo é `true`: entre o `await` e o retorno a mensagem pode ter saído, e
 * dizer `cancelled_before_send` ali seria afirmar que nada saiu quando ninguém
 * sabe.
 */
export async function sendPayloadToProvider(
  payload: OutboundPayload,
  target: ProviderCallTarget,
): Promise<ProviderAttemptObservation> {
  if (target.signal?.aborted) {
    return { kind: 'aborted', after_send: false, error_code: 'aborted_before_send' };
  }
  try {
    const observation = await callPrimitive(payload, target);
    if (target.signal?.aborted && observation.kind !== 'accepted_with_id') {
      // Abortou com a chamada em voo e sem identificador de volta: não há como
      // afirmar que nada saiu. Com identificador, saiu — o abort é posterior e
      // irrelevante para o desfecho.
      return { kind: 'aborted', after_send: true, error_code: 'aborted_after_send' };
    }
    return observation;
  } catch (e) {
    // A ÚNICA distinção que importa: a falha é comprovadamente anterior ao
    // envio, ou pode ter havido envio? `DOC_READ_FAILED` é o tag que
    // `src/gateway/baileys.ts` põe no throw de leitura de arquivo — falha
    // local, nada tocou a rede. Qualquer outro throw vem do transporte e é
    // AMBÍGUO por construção.
    const code = (e as Error & { code?: string })?.code;
    const preSend = code === 'DOC_READ_FAILED' || code === 'MEDIA_UNRESOLVED';
    return {
      kind: 'transport_throw',
      ambiguous: !preSend,
      error_code: preSend ? 'media_read_failed' : 'transport_throw',
    };
  }
}

async function callPrimitive(
  payload: OutboundPayload,
  target: ProviderCallTarget,
): Promise<ProviderAttemptObservation> {
  const { line, jid } = target;
  const nativeKey = shouldPassIdempotencyKey(target.channel, payload.type)
    ? target.provider_idempotency_key
    : null;

  switch (payload.type) {
    case 'text':
    case 'status_fallback': {
      // A ÚNICA primitiva com chave nativa. `messageId` é o eixo de dedupe do
      // WhatsApp: mesmo valor ⇒ mesma mensagem para o cliente do destinatário.
      const wid = await line.sendText(
        jid,
        payload.text,
        nativeKey ? { messageId: nativeKey } : undefined,
      );
      return acceptance(wid, line);
    }
    case 'document': {
      const path = localPathOf(payload.media);
      if (!path) return unresolvedMedia();
      const wid = await line.sendDocument(jid, path, {
        mimetype: payload.mimetype,
        fileName: payload.file_name,
        ...(payload.caption ? { caption: payload.caption } : {}),
      });
      return acceptance(wid, line);
    }
    case 'audio': {
      const path = localPathOf(payload.media);
      if (!path) return unresolvedMedia();
      // `readFile` pode lançar; o catch de `sendPayloadToProvider` classifica
      // como pré-envio só quando o erro carrega o tag. Um ENOENT cru é
      // ambíguo do ponto de vista deste módulo, então marcamos o tag aqui —
      // ler um arquivo é comprovadamente anterior a qualquer byte na rede.
      let buf: Buffer;
      try {
        buf = await readFile(path);
      } catch {
        return {
          kind: 'transport_throw',
          ambiguous: false,
          error_code: 'media_read_failed',
        };
      }
      const wid = await line.sendVoice(jid, buf);
      return acceptance(wid, line);
    }
    case 'interactive_poll': {
      const sent = await line.sendPoll(jid, payload.question, payload.options);
      // Sem os três segredos a enquete é indecifrável para o voto de volta — o
      // usuário veria uma pergunta que não consegue responder. Isso é uma
      // recusa DEFINITIVA de configuração, não uma falha transitória: reenviar
      // produziria outra enquete igualmente indecifrável.
      if (!sent.whatsapp_id) return acceptance(null, line);
      if (!sent.message_secret || !sent.creator_jid) {
        return { kind: 'rejected_permanent', error_code: 'poll_missing_secrets' };
      }
      return { kind: 'accepted_with_id', provider_message_id: sent.whatsapp_id };
    }
    case 'reaction': {
      // `void`, sem identificador e sem confirmação. O melhor desfecho honesto
      // é "aceito sem confirmação" — o que faz uma reação terminar em
      // `delivery_unknown`. É o custo de uma primitiva que não informa nada, e
      // fingir `accepted_confirmed` aqui seria inventar uma confirmação.
      line.sendReaction(jid, payload.target_provider_message_id, payload.emoji);
      return { kind: 'accepted_without_id' };
    }
    default: {
      const _never: never = payload;
      void _never;
      throw new TypeError('sendPayloadToProvider: payload fora do contrato de #630');
    }
  }
}

/**
 * `null` do gateway é AMBÍGUO e a desambiguação é a conectividade da linha —
 * o mesmo raciocínio que `output-dispatch.ts` já usa (Codex #216 HIGH-1):
 *
 *   desconectado ⇒ nada foi enviado ⇒ recusa TRANSITÓRIA, reenvio seguro;
 *   conectado    ⇒ o comando saiu e não voltou id ⇒ aceito SEM confirmação.
 *
 * Colapsar os dois em "erro" tornaria o reenvio inseguro no segundo caso;
 * colapsá-los em "aceito" perderia o retry legítimo do primeiro.
 */
function acceptance(
  provider_message_id: string | null,
  line: LineOutput,
): ProviderAttemptObservation {
  if (provider_message_id) return { kind: 'accepted_with_id', provider_message_id };
  if (line.isConnected()) return { kind: 'accepted_without_id' };
  return { kind: 'rejected_transient', error_code: 'channel_disconnected' };
}

/**
 * Referência de mídia que este worker ainda não sabe resolver.
 *
 * `storage_object` é a forma DURÁVEL de #630 e a que o delivery worker
 * precisará quando entregar minutos depois e de outra réplica — mas o
 * resolvedor (credencial de runtime, download) é #634. Até lá, recusar
 * DEFINITIVAMENTE é o desfecho honesto: um `rejected_retryable` faria a linha
 * girar no backoff para sempre, e enviar "o que der" é o que a issue proíbe.
 */
function unresolvedMedia(): ProviderAttemptObservation {
  return { kind: 'rejected_permanent', error_code: 'media_ref_unresolved' };
}

function localPathOf(media: { kind: string; path?: string }): string | null {
  return media.kind === 'local_path' ? (media.path ?? null) : null;
}
