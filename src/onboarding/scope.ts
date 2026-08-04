/**
 * Issue #519 — GUARDA FAIL-CLOSED de escopo de provisionamento.
 *
 * `src/db/tenant-context.ts` já rejeita o literal `'default'` na LEITURA do
 * ALS. Isso não basta aqui, por um motivo específico do provisionamento: o
 * wizard recebe `tenant_id`/`agent_id` como PAYLOAD do operador, antes de
 * qualquer ALS existir. Um wizard que aceitasse `{tenant_id: 'default'}` no
 * corpo da requisição criaria recursos no bucket legado sem nunca passar pelo
 * getter do ALS — exatamente o bug que o invariante 8 do `AGENTS.md` existe
 * para prevenir.
 *
 * Por que `'system'` também é rejeitado como ALVO (e não é no ALS):
 *   `'system'` é o bucket SANCIONADO de manutenção global (backup, GC de
 *   idempotência, auditoria sem tenant). É legítimo RODAR sob ele; não é
 *   legítimo PROVISIONAR nele. Um agente operacional em `system` herdaria o
 *   escopo reservado que existe justamente porque não tem dono — e passaria a
 *   ver, no mesmo balde, trabalho global de toda a instalação.
 *
 * `'primary'` NÃO é rejeitado: é um tenant ordinário (o home single-tenant da
 * issue #323) e re-onboardá-lo é uma operação válida.
 *
 * As mesmas regras existem como CHECK na migration 108 — o banco é a última
 * linha, esta função é a primeira. Ter as duas é deliberado: a CHECK protege
 * contra um caller novo que esqueça o guard; o guard devolve um erro TIPADO em
 * vez de um 23514 opaco.
 */
import { OnboardingError } from './errors.js';

/** Literais que nunca podem ser ALVO de provisionamento. */
export const FORBIDDEN_SCOPE_LITERALS = ['default', 'system'] as const;

/**
 * Formato aceito para um id de tenant/agente criado pelo wizard. Deliberadamente
 * estreito: minúsculas, dígitos, `-` e `_`, 2–64 chars. Ids são usados como
 * segmento de chave Redis e de cache (`${tenant_id}:${agent_id}:...`), então um
 * id com `:`, espaço ou maiúscula colidiria ou geraria namespace ambíguo — o
 * mesmo raciocínio do rejeitar-whitespace de `tenant-context.ts`.
 */
const ID_SHAPE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function assertScopeId(value: unknown, field: 'tenant_id' | 'agent_id'): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OnboardingError('invalid_scope', `${field} ausente ou não-string`, { field });
  }
  if (value !== value.trim()) {
    throw new OnboardingError('invalid_scope', `${field} tem whitespace nas bordas`, { field });
  }
  if ((FORBIDDEN_SCOPE_LITERALS as readonly string[]).includes(value)) {
    throw new OnboardingError(
      'forbidden_scope_literal',
      `${field}='${value}' é um literal reservado e nunca pode ser alvo de provisionamento`,
      { field },
    );
  }
  if (!ID_SHAPE.test(value)) {
    throw new OnboardingError(
      'invalid_scope',
      `${field} fora do formato aceito (minúsculas, dígitos, '-' ou '_', 2–64 chars)`,
      { field },
    );
  }
}

/** Escopo completo (tenant + agente). Usado por readiness e ativação. */
export function assertProvisioningScope(scope: {
  tenant_id: unknown;
  agent_id: unknown;
}): asserts scope is { tenant_id: string; agent_id: string } {
  assertScopeId(scope.tenant_id, 'tenant_id');
  assertScopeId(scope.agent_id, 'agent_id');
}

/** Só o tenant — os passos anteriores à criação do agente. */
export function assertTenantScope(tenant_id: unknown): asserts tenant_id is string {
  assertScopeId(tenant_id, 'tenant_id');
}

/** Só o agente. */
export function assertAgentScope(agent_id: unknown): asserts agent_id is string {
  assertScopeId(agent_id, 'agent_id');
}

/** Variante não-lançante, para superfícies que preferem ramificar. */
export function isValidProvisioningScope(scope: {
  tenant_id: unknown;
  agent_id: unknown;
}): boolean {
  try {
    assertProvisioningScope(scope);
    return true;
  } catch {
    return false;
  }
}
