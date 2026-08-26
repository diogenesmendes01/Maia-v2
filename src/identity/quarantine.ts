import { config } from '@/config/env.js';
import { pessoasRepo, conversasRepo, pendingQuestionsRepo } from '@/db/repositories.js';
import type { Pessoa, Mensagem } from '@/db/schema.js';
import { audit } from '@/governance/audit.js';
import { forCurrentAgentChannel } from '@/gateway/line-output.js';
import { withDeclaredEgressException } from '@/runtime/outbound/egress-guard.js';
import { logger } from '@/lib/logger.js';
import { parseDecision, maskPhone } from './quarantine-utils.js';

/**
 * Fase 0 (spec roteamento v4 §1.6) — envio pela fronteira única. O canal vem
 * do inbound (a linha que a pessoa contactou) quando conhecido; NULL resolve o
 * canal único ativo do agente (fail-closed em ambiguidade — o catch dos call
 * sites preserva o contrato best-effort atual).
 */
async function sendViaLine(
  jid: string,
  text: string,
  channel_id: string | null,
): Promise<string | null> {
  const line = await forCurrentAgentChannel(channel_id);
  // #634 — exceção INVENTARIADA (`identity.quarantine`): roda ANTES de existir
  // turno, então não há `turn_id` a cercar nem transação de commit possível.
  return withDeclaredEgressException('identity.quarantine', () => line.sendText(jid, text));
}

const HOLDING_MESSAGE =
  'Oi! Antes de eu poder te atender, preciso confirmar com {OWNER_NAME} que é você mesmo. Aguenta 1 minutinho?';
const ACCEPTED_MESSAGE =
  'Confirmado! Sou a Maia, assistente do {OWNER_NAME}. Pode mandar sua mensagem.';
const BLOCKED_MESSAGE = 'Não consigo te atender no momento.';
const TIMEOUT_MESSAGE = 'Ainda aguardando confirmação. Tenta de novo mais tarde.';

function jidFromPhone(tel: string): string {
  return tel.replace('+', '') + '@s.whatsapp.net';
}

/**
 * Send the holding message to the quarantined person and a confirmation
 * prompt to the owner. Idempotent: if a pending owner-confirmation exists for
 * this pessoa, only the timeout-aware reminder path runs.
 *
 * Returns whether the agent loop should continue (always false: quarantined
 * people never reach the agent until the owner approves).
 */
export async function handleQuarantineFirstContact(input: {
  pessoa: Pessoa;
  inbound: Mensagem;
}): Promise<void> {
  const { pessoa, inbound } = input;
  const owner = await findOwner();
  if (!owner) {
    logger.error({ pessoa_id: pessoa.id }, 'quarantine.no_owner');
    return;
  }

  const existing = await pendingQuestionsRepo.findOpenByPessoaAndType(owner.id, 'identity_confirmation');
  if (existing) {
    // A confirmation is already open (possibly for a different contact). Sending
    // a second one would make the owner's next reply ambiguous — we can't tell
    // which person they're confirming. Keep one open at a time and tell the new
    // contact to wait.
    const tel = (pessoa.telefone_whatsapp ?? '').trim();
    if (tel) {
      await sendViaLine(jidFromPhone(tel), TIMEOUT_MESSAGE, inbound.channel_id).catch(() => null);
    }
    return;
  }

  await audit({
    acao: 'first_contact_received',
    pessoa_id: pessoa.id,
    mensagem_id: inbound.id,
    metadata: { telefone: '[REDACTED]' },
  });

  // Reply to the quarantined contact.
  const tel = (pessoa.telefone_whatsapp ?? '').trim();
  if (tel) {
    await sendViaLine(
      jidFromPhone(tel),
      HOLDING_MESSAGE.replace('{OWNER_NAME}', config.OWNER_NOME),
      inbound.channel_id,
    ).catch((err) => logger.warn({ err: (err as Error).message }, 'quarantine.holding_send_failed'));
  }

  // Persist a pending question keyed to the OWNER (so dispatch by phone works).
  // We also store the new pessoa's id in acao_proposta so the resolver can
  // flip status when the owner replies.
  const ttl = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const ownerConv = await conversasRepo.findActive(owner.id);
  await pendingQuestionsRepo.create({
    conversa_id: ownerConv?.id ?? null,
    pessoa_id: owner.id,
    tipo: 'identity_confirmation',
    pergunta: `${pessoa.nome} (${maskPhone(pessoa.telefone_whatsapp)}) mandou primeira mensagem. Confirma que é ela mesmo?`,
    opcoes_validas: [
      { key: 'sim', label: 'Sim, libera' },
      { key: 'bloqueia', label: 'Não, bloqueia' },
    ],
    acao_proposta: {
      kind: 'identity_confirmation',
      target_pessoa_id: pessoa.id,
    },
    expira_em: new Date(ttl),
    status: 'aberta',
    metadata: {},
  });

  // Send the prompt to the owner (pela conversa/canal do dono quando houver).
  if (owner.telefone_whatsapp) {
    await sendViaLine(
      jidFromPhone(owner.telefone_whatsapp),
      `${pessoa.nome} (${maskPhone(pessoa.telefone_whatsapp)}) mandou primeira mensagem. Responde "sim" para liberar ou "bloqueia" para bloquear.`,
      ownerConv?.channel_id ?? null,
    ).catch((err) => logger.warn({ err: (err as Error).message }, 'quarantine.owner_prompt_failed'));
  }
}

/**
 * Called when the owner replies to a pending identity_confirmation. Returns
 * true if the reply matched a pending confirmation (so the agent loop can
 * skip its normal flow for this turn).
 */
export async function handleOwnerIdentityReply(input: {
  ownerPessoa: Pessoa;
  reply: string;
}): Promise<boolean> {
  const { ownerPessoa, reply } = input;
  const open = await pendingQuestionsRepo.findOpenByPessoaAndType(
    ownerPessoa.id,
    'identity_confirmation',
  );
  if (!open) return false;
  const proposta = (open.acao_proposta ?? {}) as { kind?: string; target_pessoa_id?: string };
  if (proposta.kind !== 'identity_confirmation' || !proposta.target_pessoa_id) return false;

  const decision = parseDecision(reply);
  if (!decision) return false;

  const target = await pessoasRepo.findById(proposta.target_pessoa_id);
  if (!target) {
    await pendingQuestionsRepo.resolve(open.id, { decision, missing: true });
    return true;
  }

  if (decision === 'aprova') {
    await pessoasRepo.updateStatus(target.id, 'ativa');
    await audit({
      acao: 'owner_confirmed_identity',
      pessoa_id: ownerPessoa.id,
      alvo_id: target.id,
      metadata: { decision },
    });
    if (target.telefone_whatsapp) {
      await sendViaLine(
        jidFromPhone(target.telefone_whatsapp),
        ACCEPTED_MESSAGE.replace('{OWNER_NAME}', config.OWNER_NOME),
        null,
      ).catch(() => null);
    }
  } else {
    await pessoasRepo.updateStatus(target.id, 'bloqueada');
    if (target.telefone_whatsapp) {
      await sendViaLine(jidFromPhone(target.telefone_whatsapp), BLOCKED_MESSAGE, null).catch(
        () => null,
      );
    }
  }
  await pendingQuestionsRepo.resolve(open.id, { decision });
  return true;
}

async function findOwner(): Promise<Pessoa | null> {
  return pessoasRepo.findByPhone(config.OWNER_TELEFONE_WHATSAPP);
}
