/**
 * Issue #519 §3 — a MÁQUINA DE ESTADOS da saga, pura e sem I/O.
 *
 * Ela é a segunda (e mais importante) defesa de idempotência do wizard. O
 * ledger de idempotência protege o retry da MESMA chave; a máquina de estados
 * protege o retry de uma chave DIFERENTE: um passo só é legal a partir do seu
 * estado de origem, e o commit anterior já avançou a run. Um double-click com
 * duas chaves distintas serializa no `FOR UPDATE` e o segundo recebe
 * `invalid_transition` — sem duplicar tenant, agente, papel, política ou canal.
 *
 * "Saltos não autorizados" (critério de aceite): não existe transição direta
 * `agent_draft → active`. A única porta para `active` é `activating`, e a única
 * porta para `activating` é `ready_for_activation`, que por sua vez só é
 * alcançada por uma avaliação de readiness aprovada pelo backend.
 *
 * DESVIO DELIBERADO da lista de estados da issue, documentado aqui porque o
 * schema o impõe: a issue sugere `policy_ready → channel_declared`, mas
 * `channel_policies.channel_id` é NOT NULL (`src/db/schema.ts`, tabela
 * `channel_policies`) — a política NÃO PODE existir antes do canal. Logo:
 *   - `configure_role`   leva a `policy_ready` e significa "o PAPEL de
 *     governança existe, está ativo e foi designado default";
 *   - `declare_channel`  leva a `channel_declared` e materializa o canal E a
 *     `channel_policy` que o vincula àquele papel, na MESMA transação.
 * O nome do estado foi preservado (é contrato da issue); a semântica está
 * documentada aqui e em `docs/architecture/modules/onboarding.md`.
 */
import { OnboardingError } from './errors.js';

export const ONBOARDING_STATES = [
  'created',
  'tenant_ready',
  'admin_ready',
  'agent_draft',
  'profile_ready',
  'capabilities_ready',
  'policy_ready',
  'channel_declared',
  'pairing_pending',
  'channel_ready',
  'ready_for_activation',
  'activating',
  'active',
  // Laterais
  'readiness_failed',
  'failed_retryable',
  'failed_terminal',
  'cancelled',
] as const;

export type OnboardingState = (typeof ONBOARDING_STATES)[number];

/** Estados dos quais nenhum comando pode partir. */
export const TERMINAL_STATES: readonly OnboardingState[] = [
  'active',
  'cancelled',
  'failed_terminal',
] as const;

export const ONBOARDING_STEPS = [
  'provision_tenant',
  'provision_admin',
  'provision_agent',
  'configure_profile',
  'apply_capability_packs',
  'configure_role',
  'declare_channel',
  'start_pairing',
  'confirm_channel_ready',
  'evaluate_readiness',
  'activate',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export type StepDefinition = {
  step: OnboardingStep;
  /** Estados a partir dos quais o passo é legal. */
  from: readonly OnboardingState[];
  /** Estado alcançado no sucesso. */
  to: OnboardingState;
  /**
   * Estado alcançado quando o backend REPROVA a decisão (não é erro de
   * infraestrutura, é uma negativa de governança). Só `evaluate_readiness` e
   * `activate` têm um — os demais ou commitam ou falham.
   */
  onDeny?: OnboardingState;
  /**
   * `true` quando reexecutar o passo é semanticamente inofensivo, porque ele
   * não PROVISIONA nada (só observa/decide). Um passo repetível pode partir do
   * seu próprio estado de destino.
   */
  repeatable: boolean;
};

/**
 * O contrato completo. Note que TODO passo aceita `failed_retryable` como
 * origem: uma falha transitória (deadlock, timeout de rede) não pode obrigar o
 * operador a recomeçar o wizard — ele reexecuta o mesmo passo.
 */
export const STEP_DEFINITIONS: Readonly<Record<OnboardingStep, StepDefinition>> = Object.freeze({
  provision_tenant: {
    step: 'provision_tenant',
    from: ['created', 'failed_retryable'],
    to: 'tenant_ready',
    repeatable: false,
  },
  provision_admin: {
    step: 'provision_admin',
    from: ['tenant_ready', 'failed_retryable'],
    to: 'admin_ready',
    repeatable: false,
  },
  provision_agent: {
    step: 'provision_agent',
    from: ['admin_ready', 'failed_retryable'],
    to: 'agent_draft',
    repeatable: false,
  },
  configure_profile: {
    step: 'configure_profile',
    from: ['agent_draft', 'failed_retryable'],
    to: 'profile_ready',
    repeatable: false,
  },
  apply_capability_packs: {
    step: 'apply_capability_packs',
    from: ['profile_ready', 'failed_retryable'],
    to: 'capabilities_ready',
    repeatable: false,
  },
  configure_role: {
    step: 'configure_role',
    from: ['capabilities_ready', 'failed_retryable'],
    to: 'policy_ready',
    repeatable: false,
  },
  declare_channel: {
    step: 'declare_channel',
    from: ['policy_ready', 'failed_retryable'],
    to: 'channel_declared',
    repeatable: false,
  },
  // Pareamento é o passo mais frágil da saga (depende de um humano com um
  // celular e de uma sessão de 180s). Ele é repetível a partir de
  // `pairing_pending`: abortar e recomeçar o pareamento é a remediação normal,
  // não um erro. Não provisiona nada — apenas enfileira o comando de #518.
  start_pairing: {
    step: 'start_pairing',
    from: ['channel_declared', 'pairing_pending', 'failed_retryable'],
    to: 'pairing_pending',
    repeatable: true,
  },
  // Verifica no backend que a linha PROVOU posse. É observação, não escrita.
  confirm_channel_ready: {
    step: 'confirm_channel_ready',
    from: ['pairing_pending', 'channel_ready', 'failed_retryable'],
    to: 'channel_ready',
    repeatable: true,
  },
  // Readiness pode (e deve) ser reavaliado quantas vezes o operador quiser,
  // inclusive a partir de `readiness_failed` — é assim que ele corrige um
  // check vermelho e tenta de novo.
  evaluate_readiness: {
    step: 'evaluate_readiness',
    from: ['channel_ready', 'ready_for_activation', 'readiness_failed', 'failed_retryable'],
    to: 'ready_for_activation',
    onDeny: 'readiness_failed',
    repeatable: true,
  },
  // A ativação é o único passo que NÃO é repetível a partir do destino:
  // `active` é terminal. Duas ativações concorrentes serializam no lock da run
  // e a segunda vê `invalid_transition` — "uma única transição conclusiva".
  activate: {
    step: 'activate',
    from: ['ready_for_activation', 'activating'],
    to: 'active',
    onDeny: 'readiness_failed',
    repeatable: false,
  },
});

export function isTerminalState(state: OnboardingState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function getStepDefinition(step: string): StepDefinition {
  const def = (STEP_DEFINITIONS as Record<string, StepDefinition | undefined>)[step];
  if (!def) {
    throw new OnboardingError('unknown_step', `passo desconhecido: ${step}`, { step });
  }
  return def;
}

export type TransitionPlan = {
  step: OnboardingStep;
  from: OnboardingState;
  to: OnboardingState;
  onDeny: OnboardingState;
};

/**
 * Valida a transição e devolve o PLANO. Puro: não toca banco, não decide
 * autorização, não valida payload — só responde "esse passo é legal a partir
 * desse estado?".
 */
export function planTransition(input: {
  step: string;
  from: OnboardingState;
}): TransitionPlan {
  const def = getStepDefinition(input.step);

  if (isTerminalState(input.from)) {
    throw new OnboardingError(
      'run_terminal',
      `run em estado terminal '${input.from}' não aceita comandos`,
      { state: input.from, step: def.step },
    );
  }

  if (!def.from.includes(input.from)) {
    throw new OnboardingError(
      'invalid_transition',
      `passo '${def.step}' não é legal a partir de '${input.from}' (esperado: ${def.from.join(', ')})`,
      { step: def.step, from: input.from, expected: def.from },
    );
  }

  return {
    step: def.step,
    from: input.from,
    to: def.to,
    // Sem `onDeny` declarado, a negativa cai em `failed_retryable`: a
    // precondição pode ser corrigida e o passo reexecutado.
    onDeny: def.onDeny ?? 'failed_retryable',
  };
}

/**
 * Os passos legais a partir de um estado — o que a UI usa para desabilitar
 * ações incompatíveis (§7 da issue) sem reimplementar a regra no frontend.
 * Backend é a fonte de verdade; a UI só desenha o que isto devolve.
 */
export function allowedStepsFrom(state: OnboardingState): OnboardingStep[] {
  if (isTerminalState(state)) return [];
  return ONBOARDING_STEPS.filter((step) => STEP_DEFINITIONS[step].from.includes(state));
}

/**
 * Cancelamento: legal a partir de qualquer estado NÃO terminal. `activating` é
 * incluído de propósito — uma run presa em `activating` (crash entre o UPDATE e
 * a resposta) precisa poder ser encerrada pelo operador; o que o cancelamento
 * NÃO faz é desprovisionar recurso já usado (ver `compensation` no doc).
 */
export function planCancellation(from: OnboardingState): { from: OnboardingState; to: 'cancelled' } {
  if (isTerminalState(from)) {
    throw new OnboardingError(
      'run_terminal',
      `run em estado terminal '${from}' não pode ser cancelada`,
      { state: from },
    );
  }
  return { from, to: 'cancelled' };
}
