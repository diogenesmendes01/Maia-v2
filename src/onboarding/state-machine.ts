/**
 * Issue #519 §3 — a máquina de estados da saga de onboarding, PURA.
 *
 * Zero imports de banco, de config ou de rede: este módulo é o vocabulário e as
 * regras de transição, e nada mais. Isso importa por três razões concretas:
 *
 *   1. o teste unitário exercita a máquina inteira sem Postgres;
 *   2. o repo (`onboarding-repos.ts`) e o serviço (`service.ts`) importam a
 *      MESMA tabela de transições — não existe uma segunda opinião sobre o que
 *      pode seguir o quê;
 *   3. a UI recebe a projeção derivada daqui, então "ações incompatíveis
 *      desabilitadas" na tela e "salto de etapa retorna erro tipado" no backend
 *      são a mesma regra, não duas implementações que divergem.
 *
 * Fail-closed por construção: `nextStateFor` só conhece as transições
 * autorizadas; qualquer par (estado, passo) fora da tabela é recusado. Não há
 * caminho "senão avança mesmo assim".
 */

// ---------------------------------------------------------------------------
// Vocabulário
// ---------------------------------------------------------------------------

/** Tipos de jornada. O bootstrap global é o único que pode existir sem sessão. */
export const ONBOARDING_KINDS = ['global_bootstrap', 'tenant_onboarding'] as const;
export type OnboardingKind = (typeof ONBOARDING_KINDS)[number];

/**
 * Estados da run. A sequência feliz é a sugerida pela issue; os quatro últimos
 * são laterais (não fazem parte do caminho, mas são alcançáveis de vários
 * pontos).
 */
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
  'readiness_failed',
  'failed_retryable',
  'failed_terminal',
  'cancelled',
] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];

/**
 * Passos (= comandos mutáveis). Um passo é a unidade de idempotência: a chave
 * do ledger é `(run_id, step, idempotency_key_hash)`.
 *
 * Sobre `role` e `channel`: a issue lista "role" e "channel policy" como passos
 * separados, mas `channel_policies.channel_id` é FK para o canal — uma política
 * NÃO PODE existir antes da linha. Então a divisão real é:
 *
 *   - `role`    → cria o papel padrão do agente (é ele que a política vai
 *                 nomear em `default_role_id`), levando a run a `policy_ready`;
 *   - `channel` → declara a linha WhatsApp E amarra a política dela ao papel
 *                 padrão, no mesmo comando, levando a `channel_declared`.
 *
 * Fatiar diferente produziria um estado intermediário impossível de
 * representar no schema (política órfã) ou um canal permanentemente sem
 * política — que é exatamente o "canal ativo sem governança" que a #518 fechou.
 */
export const ONBOARDING_STEPS = [
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
  'done',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_EVENT_TYPES = [
  'started',
  'completed',
  'denied',
  'failed',
  'replayed',
  'cancelled',
  'expired',
] as const;
export type OnboardingEventType = (typeof ONBOARDING_EVENT_TYPES)[number];

/**
 * Estados terminais: a run não aceita mais comandos, e o índice parcial da
 * migration 113 libera o par (tenant, agente) para uma nova run.
 */
export const TERMINAL_STATES: ReadonlySet<OnboardingState> = new Set([
  'active',
  'cancelled',
  'failed_terminal',
]);

export function isTerminal(state: OnboardingState): boolean {
  return TERMINAL_STATES.has(state);
}

// ---------------------------------------------------------------------------
// Tabela de transições
// ---------------------------------------------------------------------------

interface TransitionRule {
  /** Estados a partir dos quais o passo pode ser executado. */
  readonly from: readonly OnboardingState[];
  /** Estado resultante do sucesso. */
  readonly to: OnboardingState;
  /** Passo que fica pendente depois do sucesso. */
  readonly nextStep: OnboardingStep;
  /** Kinds de run que podem executar este passo. */
  readonly kinds: readonly OnboardingKind[];
}

/**
 * A ÚNICA tabela de transições. Cada `from` inclui deliberadamente o estado que
 * o próprio passo produz — repetir um passo já concluído é um RETRY, e o
 * ledger de idempotência devolve o resultado anterior em vez de refazer o
 * trabalho. Sem isso, um retry legítimo após timeout de rede (o cliente não
 * recebeu a resposta, mas o commit aconteceu) viraria `step_out_of_order`.
 *
 * `readiness_failed` reabre os passos de configuração: é exatamente o caso
 * "erro corrigível" do plano de testes E2E — o operador conserta a política e
 * repete, sem abrir uma run nova e sem perder o que já foi provisionado.
 */
const TRANSITIONS: Readonly<Record<Exclude<OnboardingStep, 'done'>, TransitionRule>> =
  Object.freeze({
    tenant: {
      from: ['created', 'tenant_ready'],
      to: 'tenant_ready',
      nextStep: 'admin',
      kinds: ['global_bootstrap', 'tenant_onboarding'],
    },
    admin: {
      from: ['tenant_ready', 'admin_ready'],
      to: 'admin_ready',
      nextStep: 'agent',
      kinds: ['global_bootstrap', 'tenant_onboarding'],
    },
    agent: {
      from: ['admin_ready', 'agent_draft'],
      to: 'agent_draft',
      nextStep: 'profile',
      kinds: ['global_bootstrap', 'tenant_onboarding'],
    },
    profile: {
      from: ['agent_draft', 'profile_ready', 'readiness_failed'],
      to: 'profile_ready',
      nextStep: 'capabilities',
      kinds: ['global_bootstrap', 'tenant_onboarding'],
    },
    capabilities: {
      from: ['profile_ready', 'capabilities_ready', 'readiness_failed'],
      to: 'capabilities_ready',
      nextStep: 'role',
      kinds: ['global_bootstrap', 'tenant_onboarding'],
    },
    role: {
      from: ['capabilities_ready', 'policy_ready', 'readiness_failed'],
      to: 'policy_ready',
      nextStep: 'channel',
      kinds: ['global_bootstrap', 'tenant_onboarding'],
    },
    channel: {
      from: ['policy_ready', 'channel_declared', 'readiness_failed'],
      to: 'channel_declared',
      nextStep: 'pairing',
      kinds: ['global_bootstrap', 'tenant_onboarding'],
    },
    pairing: {
      // `channel_ready` reentra: pedir re-pareamento de uma linha já verificada
      // é legítimo (a #518 tem `requestRepair`), e a run volta a esperar.
      from: ['channel_declared', 'pairing_pending', 'channel_ready', 'readiness_failed'],
      to: 'pairing_pending',
      nextStep: 'pairing',
      kinds: ['global_bootstrap', 'tenant_onboarding'],
    },
    readiness: {
      // A conclusão do pareamento é observada, não declarada pela UI: o comando
      // `readiness` lê o estado REAL da linha (#518) e só então decide.
      from: [
        'pairing_pending',
        'channel_ready',
        'ready_for_activation',
        'readiness_failed',
      ],
      to: 'ready_for_activation',
      nextStep: 'activation',
      kinds: ['global_bootstrap', 'tenant_onboarding'],
    },
    activation: {
      // NÃO aceita `readiness_failed` nem `channel_ready`: ativar exige ter
      // passado por uma avaliação de readiness verde. É o gate fail-closed.
      from: ['ready_for_activation'],
      to: 'active',
      nextStep: 'done',
      kinds: ['global_bootstrap', 'tenant_onboarding'],
    },
  });

export type TransitionDenial =
  | { ok: false; reason: 'unknown_step' }
  | { ok: false; reason: 'run_terminal'; state: OnboardingState }
  | { ok: false; reason: 'step_out_of_order'; state: OnboardingState; step: OnboardingStep }
  | { ok: false; reason: 'kind_not_allowed'; kind: OnboardingKind; step: OnboardingStep };

export type TransitionDecision =
  | { ok: true; to: OnboardingState; nextStep: OnboardingStep }
  | TransitionDenial;

/**
 * Decide a transição de um passo. Esta função é a resposta canônica a "posso
 * executar isto agora?" — o router, o serviço e a UI perguntam para ela.
 */
export function planTransition(args: {
  kind: OnboardingKind;
  state: OnboardingState;
  step: OnboardingStep;
}): TransitionDecision {
  if (args.step === 'done') return { ok: false, reason: 'unknown_step' };
  const rule = TRANSITIONS[args.step];
  if (!rule) return { ok: false, reason: 'unknown_step' };
  if (isTerminal(args.state)) {
    return { ok: false, reason: 'run_terminal', state: args.state };
  }
  if (!rule.kinds.includes(args.kind)) {
    return { ok: false, reason: 'kind_not_allowed', kind: args.kind, step: args.step };
  }
  if (!rule.from.includes(args.state)) {
    return { ok: false, reason: 'step_out_of_order', state: args.state, step: args.step };
  }
  return { ok: true, to: rule.to, nextStep: rule.nextStep };
}

/** Passos executáveis AGORA, na ordem canônica. Alimenta o "desabilitado" da UI. */
export function allowedSteps(args: {
  kind: OnboardingKind;
  state: OnboardingState;
}): OnboardingStep[] {
  return ONBOARDING_STEPS.filter(
    (step) => planTransition({ kind: args.kind, state: args.state, step }).ok,
  );
}

/**
 * Progresso 0..1 derivado do estado — a UI não conta passos por conta própria.
 * Estados laterais reportam o progresso do último estado feliz conhecido, para
 * que uma falha não faça a barra "voltar" e sugerir que trabalho foi perdido.
 */
const HAPPY_PATH: readonly OnboardingState[] = [
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
];

export function progressOf(state: OnboardingState): number {
  const idx = HAPPY_PATH.indexOf(state);
  if (idx >= 0) return idx / (HAPPY_PATH.length - 1);
  // Laterais: readiness_failed vem depois do canal pronto; os demais são
  // indeterminados e reportam 0 em vez de mentir.
  if (state === 'readiness_failed') return HAPPY_PATH.indexOf('channel_ready') / (HAPPY_PATH.length - 1);
  return 0;
}

/**
 * Códigos de falha SANITIZADOS. Toda negação/erro da saga vira um destes —
 * nunca uma mensagem de banco, nunca um stack, nunca um payload. É o que vai
 * para `onboarding_runs.last_error_code`, para o evento e para a métrica
 * (rótulo `reason`, cardinalidade fechada).
 */
export const ONBOARDING_ERROR_CODES = [
  'run_not_found',
  'run_terminal',
  'run_expired',
  'step_out_of_order',
  'kind_not_allowed',
  'version_conflict',
  'idempotency_payload_mismatch',
  'scope_mismatch',
  'forbidden_role',
  'tenant_not_found',
  'tenant_suspended',
  'tenant_duplicate',
  'admin_duplicate',
  'agent_duplicate',
  'agent_not_found',
  'profile_not_found',
  'profile_approval_failed',
  'role_conflict',
  'channel_conflict',
  'channel_invalid_line',
  'pairing_unavailable',
  'pairing_in_progress',
  'line_not_verified',
  'readiness_blocked',
  'activation_race_lost',
  'bootstrap_not_allowed',
  'bootstrap_credential_invalid',
  'bootstrap_credential_locked',
  'wizard_disabled',
  'internal_error',
] as const;
export type OnboardingErrorCode = (typeof ONBOARDING_ERROR_CODES)[number];

/**
 * Falha da saga com código sanitizado. O `message` é para o operador (pt-BR,
 * acionável); o `code` é o que atravessa evento, auditoria e métrica.
 */
export class OnboardingError extends Error {
  constructor(
    readonly code: OnboardingErrorCode,
    message: string,
    /** `true` = o operador pode corrigir e repetir; `false` = run morta. */
    readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = 'OnboardingError';
  }
}

/** Traduz uma negação da máquina de estados no erro sanitizado equivalente. */
export function denialToError(denial: TransitionDenial): OnboardingError {
  switch (denial.reason) {
    case 'run_terminal':
      return new OnboardingError(
        'run_terminal',
        `A run já terminou em '${denial.state}' e não aceita mais comandos. Abra uma nova.`,
        false,
      );
    case 'step_out_of_order':
      return new OnboardingError(
        'step_out_of_order',
        `O passo '${denial.step}' não pode ser executado com a run em '${denial.state}'. Recarregue e siga a etapa corrente.`,
      );
    case 'kind_not_allowed':
      return new OnboardingError(
        'kind_not_allowed',
        `O passo '${denial.step}' não pertence a uma run do tipo '${denial.kind}'.`,
        false,
      );
    case 'unknown_step':
      return new OnboardingError('step_out_of_order', 'Passo desconhecido.', false);
  }
}
