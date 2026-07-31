import type { BadgeTone } from '../../../components/ui/badge.js';

/**
 * Apresentação dos estados e passos da saga (issue #519).
 *
 * Módulo PURO e sem React de propósito: o teste unitário do console verifica
 * que todo estado/passo do backend tem rótulo em pt-BR — um estado sem rótulo
 * apareceria como identificador cru na tela, e o operador não tem por que
 * saber que `readiness_failed` existe.
 */
export const STATE_LABEL: Record<string, string> = {
  created: 'Iniciada',
  tenant_ready: 'Tenant pronto',
  admin_ready: 'Administrador criado',
  agent_draft: 'Agente em rascunho',
  profile_ready: 'Perfil ativo',
  capabilities_ready: 'Capacidades aplicadas',
  policy_ready: 'Papel padrão definido',
  channel_declared: 'Linha declarada',
  pairing_pending: 'Aguardando pareamento',
  channel_ready: 'Linha com posse provada',
  ready_for_activation: 'Pronta para ativar',
  activating: 'Ativando',
  active: 'Agente ativo',
  readiness_failed: 'Prontidão bloqueada',
  failed_retryable: 'Falha — pode repetir',
  failed_terminal: 'Falha definitiva',
  cancelled: 'Cancelada',
};

export const STATE_TONE: Record<string, BadgeTone> = {
  created: 'neutral',
  tenant_ready: 'info',
  admin_ready: 'info',
  agent_draft: 'info',
  profile_ready: 'info',
  capabilities_ready: 'info',
  policy_ready: 'info',
  channel_declared: 'info',
  pairing_pending: 'warning',
  channel_ready: 'brand',
  ready_for_activation: 'brand',
  activating: 'warning',
  active: 'success',
  readiness_failed: 'danger',
  failed_retryable: 'warning',
  failed_terminal: 'danger',
  cancelled: 'neutral',
};

export const STEP_LABEL: Record<string, string> = {
  tenant: 'Tenant',
  admin: 'Administrador',
  agent: 'Agente',
  profile: 'Perfil',
  capabilities: 'Capacidades',
  role: 'Papel',
  channel: 'Canal',
  pairing: 'Pareamento',
  readiness: 'Prontidão',
  activation: 'Ativação',
  done: 'Concluída',
};

/** Ordem visível no stepper — `done` não é uma etapa que o operador executa. */
export const WIZARD_STEPS: readonly string[] = [
  'tenant',
  'admin',
  'agent',
  'profile',
  'capabilities',
  'role',
  'channel',
  'pairing',
  'readiness',
  'activation',
];

/**
 * Explicação de cada código de erro sanitizado. O backend devolve mensagem
 * pronta; este mapa é o texto de APOIO — o "e agora?" que a mensagem curta não
 * comporta.
 */
export const ERROR_HELP: Record<string, string> = {
  version_conflict:
    'Outra aba (ou outro operador) avançou esta run. Recarregue a página: nada foi perdido.',
  step_out_of_order:
    'A run já passou desta etapa, ou ainda não chegou nela. Recarregue para ver a etapa corrente.',
  idempotency_payload_mismatch:
    'O formulário mudou depois que a tentativa começou. Recarregue a página para gerar uma chave nova.',
  readiness_blocked:
    'Um ou mais pré-requisitos bloqueiam a ativação. Resolva o que a lista de prontidão aponta e reavalie.',
  run_expired: 'Esta run expirou. Abra uma nova — o que já foi provisionado permanece.',
  run_terminal: 'Esta run já terminou. Abra uma nova se precisar continuar.',
};
