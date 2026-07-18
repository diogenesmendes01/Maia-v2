/**
 * Fase 0 do roteamento multi-linha (spec 2026-07-09, Draft v4 §1.6) —
 * FRONTEIRA ÚNICA DE SAÍDA.
 *
 * Todo envio físico (texto, documento, voz, poll, reação, typing, read
 * receipt) passa por um `LineOutput` obtido via `forChannel(scope)` com o
 * TRIPLETE COMPLETO — `channel_id` sozinho não prova escopo (review v4,
 * bloqueante 2): um UUID estrangeiro plantado por bug devolveria a sessão de
 * outro tenant. `forChannel` valida no DB que o canal pertence ao
 * (tenant, agent) informado e está ativo; mismatch ⇒ TypedError + log.
 *
 * O acesso direto às primitivas de envio de `baileys.ts`/`presence.ts` fora
 * deste módulo é proibido por lint (eslint no-restricted-imports — o gate da
 * fase 0). O socket nunca é exposto aqui.
 *
 * Fase 0 é MONO-LINHA por construção: o transporte subjacente é a sessão
 * global atual, e o modelo de durabilidade é preservado byte-a-byte (envio
 * síncrono continua direto; outbox continua servindo quem já serve). A fase
 * 1+ troca `resolveTransport` pelo LineSessionManager sem tocar os call
 * sites — este módulo é o ponto de corte.
 */
import { channelsRepo } from '../db/repositories/channel-repos.js';
import { getCurrentTenant, getCurrentAgent } from '../db/tenant-context.js';
import { audit } from '../governance/audit.js';
import { logger } from '../lib/logger.js';
import { TypedError } from '../lib/utils.js';
import {
  sendOutboundText,
  sendOutboundDocument,
  sendOutboundVoice,
  isBaileysConnected,
} from './baileys.js';
import {
  markRead as presenceMarkRead,
  startTyping as presenceStartTyping,
  sendReaction as presenceSendReaction,
  sendPoll as presenceSendPoll,
  type SendPollResult,
} from './presence.js';
import type { WAQuotedContext } from './types.js';
import { getLineSessionManager } from './line-session-manager.js';
import { randomUUID } from 'node:crypto';
import { isProbeSinkArmed } from '../probe/sink-guard.js';
import { isProbeScope } from '../probe/constants.js';

export interface ChannelScope {
  tenant_id: string;
  agent_id: string;
  channel_id: string;
}

export interface LineOutput {
  readonly scope: ChannelScope;
  sendText(
    jid: string,
    text: string,
    opts?: { quoted?: WAQuotedContext; view_once?: boolean; messageId?: string },
  ): Promise<string | null>;
  sendDocument(
    jid: string,
    path: string,
    opts: { mimetype: string; fileName: string; caption?: string; quoted?: WAQuotedContext },
  ): Promise<string | null>;
  sendVoice(
    jid: string,
    buf: Buffer,
    opts?: { quoted?: WAQuotedContext },
  ): Promise<string | null>;
  sendPoll(
    jid: string,
    question: string,
    options: ReadonlyArray<{ key: string; label: string }>,
  ): Promise<SendPollResult>;
  sendReaction(jid: string, whatsappId: string, emoji: '✅' | '❌'): void;
  startTyping(jid: string, mensagemId: string): ReturnType<typeof presenceStartTyping>;
  markRead(jid: string, whatsappId: string): void;
  /**
   * Conectividade DA LINHA deste escopo (fase 0: sessão global; fase 3:
   * sessão da linha). Usado pelos dispatchers para desambiguar o retorno
   * `null` dos sends (disconnected vs sent-without-id — Codex #216 HIGH-1).
   */
  isConnected(): boolean;
}

/**
 * Cache curto da validação do triplete — o caminho de resposta é quente e a
 * validação é uma leitura por (tenant, agent, channel). 60s é suficiente:
 * desativação de canal é evento raro e o transporte ainda falha fechado se a
 * sessão da linha não existir.
 */
const scopeCache = new Map<string, number>();
const SCOPE_CACHE_TTL_MS = 60_000;

function scopeKey(s: ChannelScope): string {
  // Separador NUL como ESCAPE textual (review #498 menor 7): um byte NUL
  // literal fazia o Git classificar o arquivo como binário, ocultando esta
  // fronteira de saída de diff/blame. O escape '\u0000' preserva a
  // impossibilidade de colisão (ids nunca contêm NUL) mantendo o arquivo
  // como texto.
  return `${s.tenant_id}\u0000${s.agent_id}\u0000${s.channel_id}`;
}

async function assertScope(scope: ChannelScope): Promise<void> {
  const key = scopeKey(scope);
  const cached = scopeCache.get(key);
  if (cached !== undefined && Date.now() - cached < SCOPE_CACHE_TTL_MS) return;
  const belongs = await channelsRepo.channelBelongsToScopeActive(scope);
  if (!belongs) {
    logger.error(
      { tenant_id: scope.tenant_id, agent_id: scope.agent_id, channel_id: scope.channel_id },
      'line_output.channel_scope_mismatch',
    );
    // Invariante 2/6 da spec: mismatch de triplete é AUDITADO, não só logado.
    // `audit` engole os próprios erros — nunca mascara o throw fail-closed.
    await audit({
      acao: 'channel_scope_mismatch',
      metadata: { ...scope },
    });
    throw new TypedError(
      'channel_scope_mismatch',
      'channel does not belong to (tenant, agent) or is inactive — refusing to send',
      { ...scope },
    );
  }
  scopeCache.set(key, Date.now());
}

/** Test-only: reset the scope-validation cache between cases. */
export function _clearScopeCacheForTests(): void {
  scopeCache.clear();
}

/**
 * Ponto de corte fase 0 → fase 1+: em `MAIA_MULTI_LINE=false` (default) o
 * transporte é a sessão global (paridade byte-a-byte com o comportamento
 * atual); com o manager ligado, a sessão vem do LineSessionManager e envio
 * por linha sem sessão viva falha fechado — NUNCA sai por outra linha.
 */
/**
 * Sonda sintética (spec §1.3) — SINK de outbound. Fisicamente inerte: NUNCA
 * chama uma primitiva de envio (baileys/presence/manager), logo é impossível
 * um reply da sonda sair pela linha real de WhatsApp. Mas o pipeline segue
 * idêntico até a persistência da `mensagens direcao='out'` — a "prova de
 * resposta" do §1.3 é essa row, não a entrega física (que é o Nível 3). Por
 * isso os `send*` devolvem um whatsapp_id SINTÉTICO não-nulo (a row de saída é
 * gravada normalmente, satisfazendo a asserção de liveness §1.4b) e
 * `isConnected()` é true (sem retry/backoff espúrio).
 */
function buildSyntheticSink(scope: ChannelScope): LineOutput {
  const wid = (): string => `synthetic-${randomUUID()}`;
  return {
    scope,
    async sendText() {
      return wid();
    },
    async sendDocument() {
      return wid();
    },
    async sendVoice() {
      return wid();
    },
    async sendPoll() {
      return { whatsapp_id: wid(), message_secret: null, creator_jid: null };
    },
    sendReaction() {
      /* inerte */
    },
    startTyping() {
      return { stop: () => undefined };
    },
    markRead() {
      /* inerte */
    },
    isConnected() {
      return true;
    },
  };
}

function buildOutput(scope: ChannelScope): LineOutput {
  // §1.3 — o sink só arma quando o gate foi armado no boot (após a validação
  // fail-fast provar que o canal é exclusivamente sintético) E o escopo casa o
  // TRIPLETE COMPLETO de sonda. Nunca por tenant_id sozinho: o blast radius
  // fica no canal exato. Um triplete de sonda cujo canal não fosse sintético
  // nunca teria armado o gate (o boot falharia antes).
  if (isProbeSinkArmed() && isProbeScope(scope)) {
    return buildSyntheticSink(scope);
  }
  const manager = getLineSessionManager();
  const viaManager = manager.isEnabled();
  return {
    scope,
    async sendText(jid, text, opts) {
      if (viaManager) return manager.transportFor(scope.channel_id).sendText(jid, text, opts);
      return sendOutboundText(jid, text, opts);
    },
    async sendDocument(jid, path, opts) {
      if (viaManager) return manager.transportFor(scope.channel_id).sendDocument(jid, path, opts);
      return sendOutboundDocument(jid, path, opts);
    },
    async sendVoice(jid, buf, opts) {
      if (viaManager) return manager.transportFor(scope.channel_id).sendVoice(jid, buf, opts);
      return sendOutboundVoice(jid, buf, opts);
    },
    sendPoll(jid, question, options) {
      if (viaManager) return manager.transportFor(scope.channel_id).sendPoll(jid, question, options);
      return presenceSendPoll(jid, question, options);
    },
    sendReaction(jid, whatsappId, emoji) {
      if (viaManager) {
        manager.transportFor(scope.channel_id).sendReaction(jid, whatsappId, emoji);
        return;
      }
      presenceSendReaction(jid, whatsappId, emoji);
    },
    startTyping(jid, mensagemId) {
      if (viaManager) return manager.transportFor(scope.channel_id).startTyping(jid, mensagemId);
      return presenceStartTyping(jid, mensagemId);
    },
    markRead(jid, whatsappId) {
      if (viaManager) {
        manager.transportFor(scope.channel_id).markRead(jid, whatsappId);
        return;
      }
      presenceMarkRead(jid, whatsappId);
    },
    isConnected() {
      if (viaManager) return manager.isLineConnected(scope.channel_id);
      return isBaileysConnected();
    },
  };
}

/** Test-only: exercita o roteamento de `buildOutput` (inclui o sink de sonda). */
export function _buildOutputForTests(scope: ChannelScope): LineOutput {
  return buildOutput(scope);
}

/** API única de envio — triplete completo, validado fail-closed no DB. */
export async function forChannel(scope: ChannelScope): Promise<LineOutput> {
  await assertScope(scope);
  return buildOutput(scope);
}

/**
 * Helper para call sites que rodam sob ALS (tenant/agent do contexto) e
 * conhecem o canal da conversa/row. `channel_id === null` cobre o legado
 * (conversas pré-090 e proativos sem canal): resolve o canal ÚNICO ativo do
 * agente — ambíguo/zero ⇒ TypedError (fail-closed; o chamador proativo deve
 * então especificar o canal explicitamente, spec §1.6).
 */
export async function forCurrentAgentChannel(
  channel_id: string | null | undefined,
): Promise<LineOutput> {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  if (channel_id) return forChannel({ tenant_id, agent_id, channel_id });

  const sole = await channelsRepo.findSoleActiveForCurrentAgent();
  if (sole.kind !== 'one') {
    logger.error(
      { tenant_id, agent_id, resolution: sole.kind },
      'line_output.sole_channel_unresolvable',
    );
    throw new TypedError(
      'channel_ambiguous',
      sole.kind === 'none'
        ? 'agent has no active channel — cannot send'
        : 'agent has multiple active channels — caller must specify channel_id explicitly',
      { tenant_id, agent_id, resolution: sole.kind },
    );
  }
  return buildOutput({ tenant_id, agent_id, channel_id: sole.id });
}
