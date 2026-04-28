import type { IntentLike } from './rules.js';
import { config } from '@/config/env.js';

const CRITICAL_RULES: Array<{
  match: (intent: IntentLike) => boolean;
  reason: string;
}> = [
  {
    match: (i) =>
      i.tool === 'register_transaction' &&
      typeof i.args.valor === 'number' &&
      (i.args.valor as number) > config.VALOR_DUAL_APPROVAL,
    reason: 'value > VALOR_DUAL_APPROVAL',
  },
  {
    match: (i) => {
      const meta = i.args.metadata as Record<string, unknown> | undefined;
      return i.tool === 'register_transaction' && meta?.tipo === 'pix';
    },
    reason: 'PIX para terceiro',
  },
  {
    match: (i) => {
      const meta = i.args.metadata as Record<string, unknown> | undefined;
      return i.tool === 'register_transaction' && meta?.tipo === 'ted';
    },
    reason: 'TED para terceiro',
  },
  { match: (i) => i.tool === 'update_conta_bancaria', reason: 'alteração de conta bancária' },
  { match: (i) => i.tool === 'create_contraparte', reason: 'criação de contraparte' },
  { match: (i) => i.tool === 'change_permission', reason: 'alteração de permissão' },
  { match: (i) => i.tool === 'create_pessoa', reason: 'criação de pessoa' },
  { match: (i) => i.tool === 'send_proactive_message', reason: 'mensagem proativa para terceiro' },
  { match: (i) => i.tool === 'emergency_unlock', reason: 'destravar lockdown' },
  { match: (i) => i.tool === 'ban_rule', reason: 'banir regra' },
];

export function requiresDualApproval(intent: IntentLike): { required: boolean; reason?: string } {
  for (const r of CRITICAL_RULES) {
    if (r.match(intent)) return { required: true, reason: r.reason };
  }
  return { required: false };
}
