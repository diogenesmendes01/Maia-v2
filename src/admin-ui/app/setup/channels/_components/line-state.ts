/**
 * Issue #518 — vocabulário de ESTADO DE LINHA compartilhado pela tela.
 *
 * Fica em módulo separado (e sem JSX) de propósito: são funções puras de
 * apresentação, testáveis sem montar React, e a tabela e o modal precisam
 * concordar sobre o que cada estado significa e qual é a próxima ação.
 */
import type { BadgeTone } from '../../../../components/ui/badge.js';

export type LineState =
  | 'declared'
  | 'pairing'
  | 'aborting'
  | 'verified_offline'
  | 'connected'
  | 'recovering'
  | 'logged_out'
  | 'failed'
  | 'disabled';

interface StatePresentation {
  label: string;
  tone: BadgeTone;
  /** Uma frase: o que este estado significa para quem opera. */
  help: string;
}

const STATES: Record<LineState, StatePresentation> = {
  declared: {
    label: 'declarada',
    tone: 'neutral',
    help: 'O número foi registrado, mas ninguém provou a posse. Não roteia.',
  },
  pairing: {
    label: 'pareando',
    tone: 'info',
    help: 'Sessão de pareamento aberta. Leia o QR ou digite o código no WhatsApp.',
  },
  aborting: {
    label: 'cancelando',
    tone: 'warning',
    help: 'Cancelamento pedido. A linha reabre quando o runtime confirmar que a sessão morreu.',
  },
  verified_offline: {
    label: 'verificada',
    tone: 'brand',
    help: 'Posse provada. Aguardando a sessão de roteamento subir.',
  },
  connected: {
    label: 'conectada',
    tone: 'success',
    help: 'Sessão viva: envia e recebe.',
  },
  recovering: {
    label: 'reconectando',
    tone: 'warning',
    help: 'Queda transitória. O runtime tenta reconectar sozinho.',
  },
  logged_out: {
    label: 'deslogada',
    tone: 'danger',
    help: 'O WhatsApp encerrou a sessão. A posse acabou: é preciso re-parear.',
  },
  failed: {
    label: 'falhou',
    tone: 'danger',
    help: 'A última tentativa não completou. Pode repetir.',
  },
  disabled: {
    label: 'desabilitada',
    tone: 'neutral',
    help: 'Desligada pelo operador. Não roteia.',
  },
};

const FALLBACK: StatePresentation = {
  label: 'desconhecido',
  tone: 'neutral',
  help: 'Estado não reconhecido por esta versão do console.',
};

export function presentState(state: string): StatePresentation {
  return STATES[state as LineState] ?? FALLBACK;
}

/**
 * Códigos de razão são SANITIZADOS por contrato (nunca mensagem crua de erro,
 * nunca auth state). Traduzimos os conhecidos; um desconhecido é exibido como
 * veio, o que é seguro justamente porque a origem é um vocabulário fechado.
 */
const REASONS: Record<string, string> = {
  line_mismatch: 'O número que leu o código não é o número declarado.',
  line_owned_elsewhere: 'Esta linha já está ativa em outro workspace.',
  ttl_expired_or_aborted: 'A tentativa expirou ou foi cancelada.',
  interrupted_retryable: 'O runtime reiniciou durante o pareamento. Pode repetir.',
  operator_abort: 'Cancelado pelo operador.',
  operator_disabled: 'Desabilitada pelo operador.',
  operator_repair_requested: 'Re-pareamento pedido pelo operador.',
  repair_completed: 'Posse encerrada. Pronta para um novo pareamento.',
  awaiting_readiness:
    'Posse provada. A linha só entra em roteamento quando tiver política com papel padrão ativo — o backend ativa sozinho assim que isso acontecer.',
  missing_policy: 'Falta a política de canal (papel padrão) para esta linha rotear.',
  default_role_inactive: 'O papel padrão da política está desativado — a linha não roteia.',
  already_active: 'A linha já estava ativa.',
  not_whatsapp: 'Este canal não é uma linha WhatsApp.',
  invalid_line: 'O identificador não é uma linha E.164 válida.',
  channel_not_found: 'Canal não encontrado neste tenant/agente.',
  whatsapp_logged_out: 'O WhatsApp encerrou a sessão desta linha.',
  transport_closed: 'A conexão caiu.',
  reconnect_exhausted: 'As tentativas de reconexão se esgotaram.',
  session_error: 'A sessão de pareamento falhou.',
  command_execution_failed: 'O runtime não conseguiu executar o comando.',
};

export function presentReason(code: string | null): string | null {
  if (!code) return null;
  return REASONS[code] ?? code;
}

export type LineAction = 'pair' | 'repair' | 'disable' | null;

/**
 * Próxima ação PRIMÁRIA para a linha. Uma linha ativa nunca oferece "parear"
 * — re-parear passa obrigatoriamente pelo re-pareamento, que encerra a posse
 * atual de forma auditada.
 */
export function primaryAction(line: { state: string; active: boolean }): LineAction {
  // `aborting` não oferece CTA: o backend rejeita um novo start até confirmar
  // o abort, e um botão que só devolve CONFLICT é uma mentira de UI.
  if (line.state === 'pairing' || line.state === 'aborting') return null;
  if (line.active) return 'repair';
  if (line.state === 'logged_out') return 'repair';
  return 'pair';
}

/** Formata o tempo restante de uma expiração como `mm:ss`. */
export function countdown(expiresAt: Date | string | null, now: number): string | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(ms)) return null;
  const remaining = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(remaining / 60)).padStart(2, '0');
  const s = String(remaining % 60).padStart(2, '0');
  return `${m}:${s}`;
}
