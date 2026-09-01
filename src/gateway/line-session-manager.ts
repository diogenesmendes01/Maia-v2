/**
 * LineSessionManager — fases 1–3 do roteamento multi-linha (spec 2026-07-09
 * Draft v4 §1.5/§2.5).
 *
 * Camada de POSSE das sessões Baileys por linha:
 *   - `MAIA_MULTI_LINE=false` (default, fase 1): o manager existe mas fica
 *     desabilitado — a LineOutput usa o transporte global (paridade
 *     byte-a-byte com o runtime atual). A sessão primária ainda se REGISTRA
 *     (observabilidade + shadow), mas nada muda no envio.
 *   - `MAIA_MULTI_LINE=true` (fase 3): envio por canal resolve a sessão da
 *     LINHA daquele canal; sessão indisponível ⇒ TypedError (fail-closed —
 *     NUNCA sai por outra linha). Linhas adicionais sobem para todo canal
 *     whatsapp ativo+verificado, cada uma com auth dir próprio por UUID do
 *     canal (nunca pelo número — path traversal, review v3).
 *   - PairingSession (§2.5): sessão CURTA e dedicada para verificar posse de
 *     um canal DECLARADO (inativo). Nunca roteia inbound; TTL 15min; ao
 *     verificar, promove o auth state para o dir da sessão de roteamento
 *     (rename atômico) e ativa o canal (23505 do índice global ⇒ linha já
 *     pertence a outro workspace).
 *
 * Topologia v1: in-process (N sockets). O corte para processo-por-linha é
 * esta interface — `transportFor` — nada fora dela conhece sockets.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A COSTURA do adapter de canal (issue #623) — e por que ela NÃO é config
 * ─────────────────────────────────────────────────────────────────────────
 * `startPairingSession` falava com o Baileys direto: `useMultiFileAuthState`
 * + `fetchLatestBaileysVersion` + `makeWASocket`, sem ponto de injeção. Medir
 * o pareamento num job de CI exige um adapter FALSO — a própria #518 proíbe
 * linha real ali —, e o adapter passou a ser um parâmetro de CONSTRUÇÃO do
 * manager (`PairingChannelAdapter`), com o adapter Baileys como default.
 *
 * A escolha é por CONSTRUÇÃO e nunca por chave de configuração, e a razão é
 * de segurança, não de estilo: o pareamento é o momento em que provar posse
 * da linha AUTORIZA essa linha a rotear. "Pareamento provado por socket
 * falso" é fail-open exatamente aí. Como chave de contrato — uma
 * `MAIA_*` qualquer — isso viraria configuração DOCUMENTADA do produto: um
 * interruptor que desliga a prova de posse, alcançável por env var num
 * container de produção. Como fábrica injetada por um entrypoint que só o
 * teste executa, não existe caminho de produção até ela: nenhuma variável do
 * contrato é lida aqui para escolher adapter, e
 * `tests/unit/gateway/pairing-adapter-seam.spec.ts` prova essa propriedade
 * (com o contrafactual que a torna não-vácua).
 */
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
} from '@whiskeysockets/baileys';
import { mkdirSync, existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { resolve as pathResolve } from 'node:path';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { TypedError } from '../lib/utils.js';
import {
  assertIsDirectChildOfAuthRoot,
  resolveLineAuthDir,
  resolvePairingAuthDir,
  resolveScopedAuthDir,
} from '../setup/auth-dir.js';
import type { WAQuotedContext } from './types.js';
import type { SendPollResult, TypingHandle } from './presence.js';

/** Transporte de UMA linha — mesmo shape das primitivas globais. */
export interface LineTransport {
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
  sendVoice(jid: string, buf: Buffer, opts?: { quoted?: WAQuotedContext }): Promise<string | null>;
  sendPoll(
    jid: string,
    question: string,
    options: ReadonlyArray<{ key: string; label: string }>,
  ): Promise<SendPollResult>;
  sendReaction(jid: string, whatsappId: string, emoji: '✅' | '❌'): void;
  startTyping(jid: string, mensagemId: string): TypingHandle;
  markRead(jid: string, whatsappId: string): void;
  isConnected(): boolean;
}

export interface LineSessionInfo {
  channel_id: string;
  line_external_id: string | null;
  state: 'connecting' | 'connected' | 'recovering' | 'closed';
  is_primary: boolean;
}

/**
 * Cap. 7 (auditoria P0): a validação de path (traversal do channelId + guard
 * de remoção) tem FONTE ÚNICA em `setup/auth-dir.ts` — este módulo delega e
 * re-exporta para os consumidores existentes. `lineAuthDir`/`pairingAuthDir`
 * agora também validam a RAIZ (`assertSafeAuthDir`) em toda derivação.
 */
export { resolveScopedAuthDir };

export function lineAuthDir(channelId: string): string {
  return resolveLineAuthDir(channelId);
}

export function pairingAuthDir(channelId: string): string {
  return resolvePairingAuthDir(channelId);
}

const PAIRING_TTL_MS = 15 * 60_000;

export interface PairingResult {
  matched: boolean;
  /** Número real (E.164 com +) reportado pela sessão. */
  actual_line: string | null;
}

/**
 * Entrada de UMA PairingSession em curso. Criada SINCRONAMENTE na entrada de
 * `startPairingSession` (review #498 alto 4 — a reserva antes de qualquer
 * await impede duas sessões concorrentes de compartilharem o auth dir), por
 * isso `sock`/`timer` são preenchidos depois. `settle` resolve a promise
 * externa exatamente uma vez — o abort também a resolve (nunca fica pendente).
 */
type PairingEntry = {
  sock: WASocket | null;
  timer: NodeJS.Timeout | null;
  settle: ((r: PairingResult) => void) | null;
};

/**
 * O que a PairingSession precisa do mundo externo: o auth state em disco, a
 * versão do protocolo e o socket. Tudo o que fala WhatsApp de verdade está
 * DESTE lado da fronteira; nada mais no manager toca o Baileys.
 *
 * É deliberadamente a operação INTEIRA (`open`), e não só `makeWASocket`: com
 * a fábrica cobrindo apenas o construtor, um adapter falso ainda arrastaria
 * `fetchLatestBaileysVersion()` — uma chamada de REDE sem timeout — para
 * dentro de um job que não deve tocar a rede do WhatsApp. Um seam que deixa
 * rede real do outro lado não é um seam.
 */
export interface PairingChannelAdapter {
  open(args: {
    channel_id: string;
    /** Diretório de auth JÁ criado pelo manager. */
    auth_dir: string;
    declared_line: string;
  }): Promise<{ sock: WASocket; saveCreds: () => Promise<void> }>;
}

/** O adapter de PRODUÇÃO: Baileys, e só ele. */
const baileysPairingAdapter: PairingChannelAdapter = {
  async open({ auth_dir }) {
    const { state, saveCreds } = await useMultiFileAuthState(auth_dir);
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      /* fallback para a versão da lib */
    }
    return {
      sock: makeWASocket({ auth: state, version, printQRInTerminal: false }),
      saveCreds,
    };
  },
};

class LineSessionManager {
  private transports = new Map<string, LineTransport>();
  private info = new Map<string, LineSessionInfo>();
  private pairingSockets = new Map<string, PairingEntry>();

  /**
   * O adapter chega por CONSTRUÇÃO — nunca por configuração. Ver o cabeçalho
   * deste arquivo: o default é o Baileys, e trocá-lo exige construir o
   * manager com outro objeto, coisa que só um entrypoint faz.
   */
  constructor(private readonly adapter: PairingChannelAdapter = baileysPairingAdapter) {}

  isEnabled(): boolean {
    return config.MAIA_MULTI_LINE;
  }

  /** Test-only: qual adapter este manager recebeu na construção. */
  _adapterForTests(): PairingChannelAdapter {
    return this.adapter;
  }

  /**
   * Registro da sessão (primária hoje; adicionais na fase 3). Chamado pelo
   * dono do socket (baileys.ts / createLineSession) no connection.open.
   */
  register(
    channelId: string,
    transport: LineTransport,
    meta: { line_external_id: string | null; is_primary: boolean },
  ): void {
    this.transports.set(channelId, transport);
    this.info.set(channelId, {
      channel_id: channelId,
      line_external_id: meta.line_external_id,
      state: 'connected',
      is_primary: meta.is_primary,
    });
    logger.info(
      { channel_id: channelId, line: meta.line_external_id, primary: meta.is_primary },
      'line_session.registered',
    );
  }

  markState(channelId: string, state: LineSessionInfo['state']): void {
    const cur = this.info.get(channelId);
    if (cur) cur.state = state;
    if (state === 'closed') this.transports.delete(channelId);
  }

  /**
   * Fail-closed: sessão da linha indisponível ⇒ erro tipado. NUNCA devolve a
   * sessão de outra linha (responder pela linha errada vaza contexto).
   */
  transportFor(channelId: string): LineTransport {
    const t = this.transports.get(channelId);
    if (!t) {
      throw new TypedError(
        'line_session_unavailable',
        'no live session for this channel line — refusing to send via another line',
        { channel_id: channelId },
      );
    }
    return t;
  }

  listSessions(): LineSessionInfo[] {
    return [...this.info.values()];
  }

  /** Conectividade da LINHA de um canal — nunca lança (probe, não send). */
  isLineConnected(channelId: string): boolean {
    const t = this.transports.get(channelId);
    if (!t) return false;
    if (this.info.get(channelId)?.state !== 'connected') return false;
    return t.isConnected();
  }

  /**
   * §2.5 — PairingSession: verifica posse de um canal DECLARADO. Sobe um
   * socket isolado (auth dir próprio), espera a conexão, compara o número
   * real com `declared_line` e encerra. NÃO roteia inbound (nenhum handler
   * de mensagens é instalado; eventos chegam e morrem aqui — auditado pelo
   * chamador). Ao casar, o auth state é PROMOVIDO para o dir de roteamento.
   *
   * O fluxo interativo (QR/código) é responsabilidade da superfície /setup,
   * que usa os eventos expostos via `onUpdate`.
   */
  async startPairingSession(args: {
    channel_id: string;
    declared_line: string;
    onUpdate?: (u: { qr?: string; pairing_code?: string; state: string }) => void;
    requestPairingCodeFor?: string;
  }): Promise<PairingResult> {
    // Review #498 (alto 4): UMA PairingSession por canal, mesmo sob chamadas
    // concorrentes — a reserva é síncrona (antes de qualquer await); sem ela,
    // duas sessões compartilhavam o mesmo auth dir.
    if (this.pairingSockets.has(args.channel_id)) {
      throw new TypedError(
        'pairing_in_progress',
        'a pairing session is already running for this channel',
        { channel_id: args.channel_id },
      );
    }
    const entry: PairingEntry = { sock: null, timer: null, settle: null };
    this.pairingSockets.set(args.channel_id, entry);

    let dir: string;
    let sock: WASocket;
    try {
      dir = pairingAuthDir(args.channel_id);
      mkdirSync(dir, { recursive: true });
      const opened = await this.adapter.open({
        channel_id: args.channel_id,
        auth_dir: dir,
        declared_line: args.declared_line,
      });
      sock = opened.sock;
      sock.ev.on('creds.update', opened.saveCreds);
    } catch (err) {
      // Setup falhou antes do socket existir — libera a reserva e propaga
      // (o chamador encerra o pairing com `failed`; nada fica pendente).
      this.pairingSockets.delete(args.channel_id);
      throw err;
    }
    // O operador pode ter abortado DURANTE o setup assíncrono acima — a
    // reserva já não é nossa: encerra o socket órfão e falha explicitamente
    // (nunca deixa uma sessão fantasma sem entrada no mapa).
    if (this.pairingSockets.get(args.channel_id) !== entry) {
      try {
        sock.end(undefined);
      } catch {
        /* já fechado */
      }
      throw new TypedError('pairing_aborted', 'pairing aborted during session setup', {
        channel_id: args.channel_id,
      });
    }
    entry.sock = sock;

    return new Promise<PairingResult>((resolvePromise, rejectPromise) => {
      // Settle EXATAMENTE uma vez — cobre open vs TTL vs abort (o segundo
      // `open` de um socket zumbi não pode re-executar a promoção: o rm +
      // rename repetidos destruiriam o auth state recém-promovido).
      let settled = false;
      entry.settle = (r) => {
        if (settled) return;
        settled = true;
        resolvePromise(r);
      };
      entry.timer = setTimeout(() => {
        // abortPairing resolve a promise via entry.settle (matched: false).
        void this.abortPairing(args.channel_id, 'ttl_expired');
      }, PAIRING_TTL_MS);

      sock.ev.on('connection.update', (u) => {
        if (u.qr) args.onUpdate?.({ qr: u.qr, state: 'pairing_qr' });
        if (u.connection === 'open') {
          if (settled) return;
          // Marca SINCRONAMENTE: um segundo `open` (socket zumbi) durante a
          // promoção assíncrona repetiria rm+rename e destruiria o auth
          // state recém-promovido.
          settled = true;
          const rawJid = sock.user?.id ?? '';
          const digits = rawJid.split(':')[0]?.split('@')[0] ?? '';
          const actual = digits ? `+${digits.replace(/^\+/, '')}` : null;
          const matched = actual !== null && actual === args.declared_line;
          logger.info(
            { channel_id: args.channel_id, actual, declared: args.declared_line, matched },
            'pairing_session.connected',
          );
          if (entry.timer) clearTimeout(entry.timer);
          this.pairingSockets.delete(args.channel_id);
          // Encerra o socket de pareamento SEMPRE — a sessão de roteamento
          // (se casou) sobe do dir promovido, nunca deste socket.
          sock.end(undefined);
          void (async () => {
            try {
              if (matched) {
                // Cap. 7: todo rm sob a raiz passa pelo guard — a raiz (e os
                // buckets inteiros) são irremovíveis por construção.
                const target = assertIsDirectChildOfAuthRoot(lineAuthDir(args.channel_id));
                mkdirSync(pathResolve(config.BAILEYS_AUTH_DIR, 'lines'), { recursive: true });
                if (existsSync(target)) await rm(target, { recursive: true, force: true });
                await rename(dir, target);
              } else {
                await rm(assertIsDirectChildOfAuthRoot(dir), { recursive: true, force: true });
              }
              resolvePromise({ matched, actual_line: actual });
            } catch (err) {
              // Review #498 (alto 4): falha de filesystem REJEITA a promise
              // externa — antes ela ficava pendente e o pairing preso em
              // `pairing`. Auth dir de pareamento destruído best-effort
              // (fail-closed: sem promoção não há posse).
              await rm(dir, { recursive: true, force: true }).catch(() => undefined);
              rejectPromise(err as Error);
            }
          })();
        }
      });

      if (args.requestPairingCodeFor) {
        // Código de 8 dígitos (alternativa ao QR).
        void sock
          .requestPairingCode(args.requestPairingCodeFor.replace(/^\+/, ''))
          .then((code) => args.onUpdate?.({ pairing_code: code, state: 'pairing_code' }))
          .catch((err) =>
            logger.warn({ err: (err as Error).message }, 'pairing_session.code_failed'),
          );
      }
    });
  }

  async abortPairing(channelId: string, reason: string): Promise<void> {
    const entry = this.pairingSockets.get(channelId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.pairingSockets.delete(channelId);
    try {
      entry.sock?.end(undefined);
    } catch {
      /* já fechado */
    }
    await rm(assertIsDirectChildOfAuthRoot(pairingAuthDir(channelId)), {
      recursive: true,
      force: true,
    });
    // Resolve a promise pendente (matched: false) — review #498 alto 4:
    // o abort deixava a promise da PairingSession pendente para sempre.
    entry.settle?.({ matched: false, actual_line: null });
    logger.info({ channel_id: channelId, reason }, 'pairing_session.aborted');
  }

  /** Test-only. */
  _resetForTests(): void {
    this.transports.clear();
    this.info.clear();
    this.pairingSockets.clear();
  }
}

let managerSingleton: LineSessionManager | null = null;
let adapterInstalado: PairingChannelAdapter | null = null;

/**
 * Instala o adapter com que o singleton será CONSTRUÍDO.
 *
 * Existe um único chamador legítimo, e ele não é código de produção: o
 * entrypoint `tests/admin-ui/e2e/_runtime/runtime-com-canal-falso.ts`, que o
 * job do console executa para ter um runtime Maia sem linha WhatsApp real.
 * Nenhuma variável do contrato chega até aqui — trocar o adapter exige
 * EXECUTAR OUTRO ENTRYPOINT, não setar uma env var.
 *
 * Fail-closed nas duas bordas: instalar depois de o manager existir seria
 * silenciosamente ineficaz (o pareamento seguiria no Baileys), e instalar
 * duas vezes esconderia qual dos dois venceu.
 */
export function installPairingChannelAdapter(adapter: PairingChannelAdapter): void {
  if (managerSingleton !== null) {
    throw new TypedError(
      'pairing_adapter_installed_too_late',
      'o LineSessionManager já foi construído — o adapter tem de ser instalado ANTES do primeiro getLineSessionManager()',
      {},
    );
  }
  if (adapterInstalado !== null) {
    throw new TypedError(
      'pairing_adapter_already_installed',
      'um adapter de canal já foi instalado neste processo',
      {},
    );
  }
  adapterInstalado = adapter;
}

export function getLineSessionManager(): LineSessionManager {
  if (!managerSingleton) {
    managerSingleton =
      adapterInstalado === null
        ? new LineSessionManager()
        : new LineSessionManager(adapterInstalado);
  }
  return managerSingleton;
}

/** Test-only: desfaz singleton e instalação entre casos. */
export function _resetLineSessionManagerForTests(): void {
  managerSingleton = null;
  adapterInstalado = null;
}
