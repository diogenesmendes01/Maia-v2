/**
 * Issue #519 — erros TIPADOS da saga de onboarding.
 *
 * Todo comando devolve um código estável, nunca uma mensagem livre. Três
 * consumidores dependem disso:
 *   - a UI, que precisa mapear código → remediation traduzível;
 *   - `onboarding_runs.last_error_code`, que é persistido e portanto não pode
 *     carregar PII nem texto de exceção de driver;
 *   - as métricas (`onboarding_step_failed_total{step,error_code}`), cuja
 *     cardinalidade precisa ser FINITA — daí o union fechado abaixo.
 *
 * `details` existe para o log estruturado do servidor. NÃO é persistido em
 * `last_error_code` nem vira label de métrica.
 */
export const ONBOARDING_ERROR_CODES = [
  // Escopo / fail-closed
  'invalid_scope',
  'forbidden_scope_literal',
  'scope_mismatch',
  // Máquina de estados
  'invalid_transition',
  'run_not_found',
  'run_terminal',
  'run_expired',
  'unknown_step',
  // Concorrência / idempotência
  'version_conflict',
  'idempotency_payload_mismatch',
  'missing_idempotency_key',
  // Autorização
  'forbidden',
  // Precondições de provisionamento
  'tenant_not_found',
  'tenant_disabled',
  'agent_not_found',
  'duplicate_tenant',
  'duplicate_agent',
  'duplicate_channel',
  'role_not_found',
  'channel_not_found',
  'channel_not_paired',
  // Readiness / ativação
  'readiness_blocked',
  'activation_precondition_failed',
  // Kind ainda não implementado nesta fatia
  'kind_not_implemented',

  // Issue #519 — bootstrap global. Todos fail-closed: nenhum deles tem
  // caminho de degradacao, porque a alternativa a recusar e' conceder
  // identidade administrativa global.
  /** Ja' existe a linha em `bootstrap_completions`. Recusa DEFINITIVA. */
  'bootstrap_already_completed',
  /** O sistema ja' tem identidade administrativa global; nao cabe bootstrap. */
  'bootstrap_not_allowed',
  /** Ja' existe credencial viva (unique parcial `..._unconsumed_uq`). */
  'bootstrap_credential_exists',
  /** Segredo nao confere. Mensagem NUNCA diz o que estava errado. */
  'bootstrap_credential_invalid',
  /** `expires_at <= now()` pelo relogio do BANCO. */
  'bootstrap_credential_expired',
  /** `consumed_at IS NOT NULL` — perdeu o compare-and-swap ou ja' foi usada. */
  'bootstrap_credential_consumed',
  /** `locked_until > now()` — rate limit estourado. */
  'bootstrap_locked_out',
] as const;

export type OnboardingErrorCode = (typeof ONBOARDING_ERROR_CODES)[number];

export class OnboardingError extends Error {
  readonly code: OnboardingErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: OnboardingErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'OnboardingError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Erro DESCONHECIDO → código sanitizado. Usado no `catch` de todo comando:
 * a mensagem original vai para o log estruturado, mas o que é persistido em
 * `last_error_code` e vira label de métrica é sempre um código do union.
 */
export function toOnboardingErrorCode(err: unknown): OnboardingErrorCode | 'internal_error' {
  if (err instanceof OnboardingError) return err.code;
  return 'internal_error';
}
