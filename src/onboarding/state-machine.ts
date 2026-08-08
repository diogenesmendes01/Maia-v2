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
 * O contrato completo.
 *
 * ─── `failed_retryable` NÃO é mais origem universal (review do PR #541) ──────
 * A versão anterior listava `failed_retryable` no `from` de TODO passo, com a
 * justificativa "uma falha transitória não pode obrigar o operador a recomeçar
 * o wizard — ele reexecuta o mesmo passo". A justificativa está certa; a
 * implementação não fazia o que ela diz. O estado não guardava QUAL passo
 * falhou, então "reexecutar o mesmo passo" era indistinguível de "executar
 * qualquer passo": depois de uma negativa em `start_pairing`, o backend
 * autorizava `provision_tenant`, `provision_admin`, `declare_channel` ou
 * `evaluate_readiness` — passos que REBOBINAM o estado materializado da saga
 * ou criam recursos adicionais (um segundo admin, um segundo canal).
 *
 * Agora a origem `failed_retryable` não é declarada em nenhuma definição: ela
 * é decidida por `planTransition` a partir do ponto de retomada PERSISTIDO na
 * run (`onboarding_runs.failed_step`, migration 113) — só o retry do passo que
 * falhou e as remediações declaradas em `RETRY_REMEDIATIONS` são legais. Sem
 * ponto de retomada gravado, nada é legal (fail-closed).
 */
export const STEP_DEFINITIONS: Readonly<Record<OnboardingStep, StepDefinition>> = Object.freeze({
  provision_tenant: {
    step: 'provision_tenant',
    from: ['created'],
    to: 'tenant_ready',
    repeatable: false,
  },
  provision_admin: {
    step: 'provision_admin',
    from: ['tenant_ready'],
    to: 'admin_ready',
    repeatable: false,
  },
  provision_agent: {
    step: 'provision_agent',
    from: ['admin_ready'],
    to: 'agent_draft',
    repeatable: false,
  },
  configure_profile: {
    step: 'configure_profile',
    from: ['agent_draft'],
    to: 'profile_ready',
    repeatable: false,
  },
  apply_capability_packs: {
    step: 'apply_capability_packs',
    from: ['profile_ready'],
    to: 'capabilities_ready',
    repeatable: false,
  },
  configure_role: {
    step: 'configure_role',
    from: ['capabilities_ready'],
    to: 'policy_ready',
    repeatable: false,
  },
  declare_channel: {
    step: 'declare_channel',
    from: ['policy_ready'],
    to: 'channel_declared',
    repeatable: false,
  },
  // Pareamento é o passo mais frágil da saga (depende de um humano com um
  // celular e de uma sessão de 180s). Ele é repetível a partir de
  // `pairing_pending`: abortar e recomeçar o pareamento é a remediação normal,
  // não um erro. Não provisiona nada — apenas enfileira o comando de #518.
  start_pairing: {
    step: 'start_pairing',
    from: ['channel_declared', 'pairing_pending'],
    to: 'pairing_pending',
    repeatable: true,
  },
  // Verifica no backend que a linha PROVOU posse. É observação, não escrita.
  confirm_channel_ready: {
    step: 'confirm_channel_ready',
    from: ['pairing_pending', 'channel_ready'],
    to: 'channel_ready',
    repeatable: true,
  },
  // Readiness pode (e deve) ser reavaliado quantas vezes o operador quiser,
  // inclusive a partir de `readiness_failed` — é assim que ele corrige um
  // check vermelho e tenta de novo.
  evaluate_readiness: {
    step: 'evaluate_readiness',
    from: ['channel_ready', 'ready_for_activation', 'readiness_failed'],
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

/**
 * As REMEDIAÇÕES autorizadas a partir de `failed_retryable`, por passo que
 * falhou. O retry do PRÓPRIO passo é sempre legal e não precisa ser listado
 * aqui; esta tabela declara o que MAIS é aceitável.
 *
 * O critério para entrar aqui é estreito de propósito: a remediação não pode
 * rebobinar o estado materializado da saga nem criar recurso adicional. Por
 * isso a única entrada é o par pareamento/confirmação — os dois passos são
 * `repeatable: true`, nenhum dos dois provisiona nada, e "a confirmação falhou
 * porque a linha não pareou" tem como remediação natural (e única) refazer o
 * pareamento da MESMA linha.
 *
 * O que deliberadamente NÃO está aqui: `declare_channel` como remediação de um
 * pareamento falho (declararia uma SEGUNDA linha) e qualquer passo de
 * provisionamento (tenant/admin/agente/profile/packs/papel), que reexecutado
 * fora de ordem duplica governança.
 */
export const RETRY_REMEDIATIONS: Readonly<Record<OnboardingStep, readonly OnboardingStep[]>> =
  Object.freeze({
    provision_tenant: [],
    provision_admin: [],
    provision_agent: [],
    configure_profile: [],
    apply_capability_packs: [],
    configure_role: [],
    declare_channel: [],
    start_pairing: [],
    confirm_channel_ready: ['start_pairing'],
    evaluate_readiness: [],
    activate: [],
  });

/**
 * O ponto de retomada de uma run em `failed_retryable`, como ele está
 * PERSISTIDO (`onboarding_runs.failed_step` / `.resume_state`, migration 113).
 *
 * `failed_step` é o que AUTORIZA; `resume_state` é diagnóstico (de que estado o
 * passo partiu) e aparece na projeção da run devolvida ao operador.
 */
export type RetryPoint = {
  failed_step?: string | null;
  resume_state?: string | null;
};

/**
 * Os passos legais a partir de `failed_retryable`, dado o ponto de retomada.
 *
 * Fail-closed: sem `failed_step` gravado, NENHUM passo é legal — a run só pode
 * ser cancelada. A migration 113 impede que essa combinação seja gravada
 * (`onboarding_runs_retry_point_ck`); a função continua tratando o caso porque
 * runs anteriores à migration podem existir.
 */
export function stepsAllowedAfterRetryableFailure(point: RetryPoint): OnboardingStep[] {
  const failed = point.failed_step;
  if (typeof failed !== 'string') return [];
  const def = (STEP_DEFINITIONS as Record<string, StepDefinition | undefined>)[failed];
  if (!def) return [];
  return [def.step, ...RETRY_REMEDIATIONS[def.step]];
}

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
  /**
   * O ponto de retomada da run — obrigatório na prática quando `from` é
   * `failed_retryable`. Vem do estado PERSISTIDO: o repo o lê da row TRAVADA e
   * o repassa, para que a autorização do retry seja avaliada contra o mesmo
   * retrato da transição (nunca contra algo lido antes do lock).
   */
  retry_point?: RetryPoint;
}): TransitionPlan {
  const def = getStepDefinition(input.step);

  if (isTerminalState(input.from)) {
    throw new OnboardingError(
      'run_terminal',
      `run em estado terminal '${input.from}' não aceita comandos`,
      { state: input.from, step: def.step },
    );
  }

  // `failed_retryable` é a ÚNICA origem que não está declarada nas definições:
  // ela é resolvida contra o ponto de retomada persistido. Ver o comentário de
  // `STEP_DEFINITIONS` para o porquê.
  if (input.from === 'failed_retryable') {
    const allowed = stepsAllowedAfterRetryableFailure(input.retry_point ?? {});
    if (!allowed.includes(def.step)) {
      throw new OnboardingError(
        'invalid_transition',
        allowed.length === 0
          ? "run em 'failed_retryable' sem ponto de retomada — nenhum passo é legal (cancele a run)"
          : `passo '${def.step}' não é legal a partir de 'failed_retryable' com falha em '${String(
              input.retry_point?.failed_step,
            )}' (esperado: ${allowed.join(', ')})`,
        {
          step: def.step,
          from: input.from,
          failed_step: input.retry_point?.failed_step ?? null,
          expected: allowed,
        },
      );
    }
    return {
      step: def.step,
      from: input.from,
      to: def.to,
      onDeny: def.onDeny ?? 'failed_retryable',
    };
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
export function allowedStepsFrom(
  state: OnboardingState,
  retry_point?: RetryPoint,
): OnboardingStep[] {
  if (isTerminalState(state)) return [];
  // A partir de `failed_retryable` o que a UI pode desenhar é EXATAMENTE o que
  // `planTransition` aceitaria — retry do passo que falhou + remediações. Sem
  // ponto de retomada, nada: a run só pode ser cancelada, e é isso que o
  // console precisa mostrar (em vez de onze botões que o backend recusaria).
  if (state === 'failed_retryable') {
    const allowed = new Set(stepsAllowedAfterRetryableFailure(retry_point ?? {}));
    return ONBOARDING_STEPS.filter((step) => allowed.has(step));
  }
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
