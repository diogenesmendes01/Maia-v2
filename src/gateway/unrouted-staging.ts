/**
 * §1.4 do roteamento multi-linha (spec 2026-07-09 Draft v4) — staging cifrado
 * de inbound NÃO-ROTEADO (modo strict), atômico de ponta a ponta.
 *
 * Caminho feliz: miss no strict ⇒ envelope AES-GCM (keyring) → row em
 * `inbound_unrouted` → job BullMQ com jobId ESTÁVEL logo após o commit.
 * Sem janela de perda Postgres→BullMQ: o conflito no insert (retry do evento)
 * re-arma o job; o recovery sweep re-arma rows órfãs; o jobId estável torna
 * tudo idempotente.
 *
 * Handoff: o replay entrega pela MESMA pipeline de ingresso com a LINHA
 * original — o dedup POR CANAL (§1.7) resolve a corrida com o caminho vivo
 * no UNIQUE, nunca em entrega dupla. Row entregue ⇒ status='handed_off'.
 */
import type { proto } from '@whiskeysockets/baileys';
import { logger } from '../lib/logger.js';
import { audit } from '../governance/audit.js';
import { inboundUnroutedRepo } from '../db/repositories/inbound-unrouted-repos.js';
import { parseKeyring, sealEnvelope, openEnvelope } from './staging-crypto.js';
import { enqueueUnroutedReplay } from './queue.js';
import { ingressUpsertMessage } from './baileys.js';

/**
 * JSON.stringify seguro para o envelope proto: timestamps do Baileys chegam
 * como Long (`{low, high, unsigned}` com .toNumber) ou bigint — serializados
 * como número para que o replay reconstrua um envelope que a pipeline lê
 * (`Number(msg.messageTimestamp)`).
 */
function protoReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { toNumber?: unknown }).toNumber === 'function' &&
    'low' in (value as object) &&
    'high' in (value as object)
  ) {
    return (value as { toNumber(): number }).toNumber();
  }
  return value;
}

/**
 * Estagia um inbound que o modo strict recusou rotear. Retorna true quando a
 * row + job estão garantidos (a mensagem NÃO se perdeu); false quando o
 * staging em si falhou (aí vale o audit de drop já emitido pelo resolver —
 * fail-loud, nunca silencioso).
 */
export async function stageUnroutedInbound(
  msg: proto.IWebMessageInfo,
  line_external_id: string,
): Promise<boolean> {
  const whatsapp_message_id = msg.key?.id;
  if (!whatsapp_message_id) return false;
  try {
    // Keyring inválido/ausente lança — strict não deveria estar ligado sem
    // ele (guard no boot); este throw é a última linha de defesa.
    const keyring = parseKeyring();
    const plaintext = Buffer.from(JSON.stringify(msg, protoReplacer), 'utf8');
    const envelope = sealEnvelope(plaintext, keyring);
    const staged = await inboundUnroutedRepo.stage({
      line_external_id,
      whatsapp_message_id,
      envelope,
      enc_key_id: keyring.activeKeyId,
    });
    // SEMPRE re-arma — insert novo OU conflito (retry): o jobId estável faz
    // do re-add um no-op quando o job já vive (§1.4, bloqueante 3).
    await enqueueUnroutedReplay({
      unrouted_id: staged.id,
      line_external_id,
      whatsapp_message_id,
    });
    await audit({
      acao: 'inbound_staged',
      metadata: {
        unrouted_id: staged.id,
        line_external_id,
        whatsapp_id: whatsapp_message_id,
        already_staged: staged.already_staged,
      },
    });
    logger.info(
      { unrouted_id: staged.id, line: line_external_id, already: staged.already_staged },
      'unrouted.staged',
    );
    return true;
  } catch (err) {
    logger.error(
      { err: (err as Error).message, line: line_external_id, whatsapp_id: whatsapp_message_id },
      'unrouted.stage_failed',
    );
    return false;
  }
}

/**
 * Processor do worker de replay: decifra e re-entrega pela pipeline normal
 * com a linha original. Outcomes:
 *   - row ausente/handed_off/expired ⇒ no-op idempotente;
 *   - pipeline entregou ⇒ CAS para handed_off + audit;
 *   - ainda não roteável (canal segue inexistente) ⇒ throw — BullMQ
 *     reagenda; esgotadas as tentativas, o recovery sweep re-arma até o TTL.
 */
export async function processUnroutedReplay(unrouted_id: string): Promise<void> {
  const row = await inboundUnroutedRepo.findById(unrouted_id);
  if (!row || row.status !== 'pending') return;
  if (row.expires_at.getTime() <= Date.now()) return; // sweeper expira + audita

  const keyring = parseKeyring();
  const msg = JSON.parse(
    openEnvelope(row.envelope, keyring).toString('utf8'),
  ) as proto.IWebMessageInfo;

  await inboundUnroutedRepo.bumpAttempts(row.id);
  const outcome = await ingressUpsertMessage(msg, {
    botLineE164: row.line_external_id,
  });
  if (outcome !== 'handled') {
    // Continua sem rota (ou caiu de novo no strict): em strict o próprio
    // resolver re-estagia (no-op no UNIQUE). Lança para o BullMQ reagendar.
    throw new Error(`unrouted_replay_not_delivered: outcome=${outcome}`);
  }
  const won = await inboundUnroutedRepo.markHandedOff(row.id);
  if (won) {
    await audit({
      acao: 'inbound_unrouted_handed_off',
      metadata: {
        unrouted_id: row.id,
        line_external_id: row.line_external_id,
        whatsapp_id: row.whatsapp_message_id,
        attempts: row.attempts + 1,
      },
    });
  }
}
