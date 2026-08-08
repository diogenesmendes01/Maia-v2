/**
 * Issue #519 — SANITIZAÇÃO do que a saga persiste.
 *
 * Três colunas guardam texto vindo do operador ou do próprio passo:
 * `onboarding_runs.metadata`, `onboarding_events.summary` e
 * `onboarding_step_results.result`. Nenhuma delas pode receber segredo, QR
 * code, código de pareamento, token de sessão, telefone ou e-mail — o
 * invariante da issue é explícito ("segredos, QR codes, tokens e credenciais
 * não entram em URL, evento, auditoria ou log").
 *
 * A defesa é uma DENYLIST DE CHAVE, não uma tentativa de detectar segredo no
 * valor. Detectar segredo por heurística falha silenciosamente; recusar um
 * NOME de campo é determinístico e auditável. Uma chave na denylist vira
 * `'[redacted]'` — ela não é removida, para que a forma do objeto continue
 * legível no diagnóstico e para que a redação em si fique visível.
 *
 * Além da denylist: strings longas são truncadas (um payload gigante em
 * `metadata` é um vetor de armazenamento acidental) e a profundidade é
 * limitada (um objeto profundo demais some — se for necessário, o passo deve
 * projetar explicitamente o que quer guardar).
 *
 * ─── Por que a denylist NÃO basta, e o que a substitui na entrada ────────────
 * (review adversarial do PR #541, achado 5.)
 *
 * A denylist decide pelo NOME da chave, e as duas superfícies LIVRES da saga
 * não têm nome de chave sob controle do backend:
 *
 *   * `startOnboardingRun({ metadata })` aceitava `Record<string, unknown>`
 *     ARBITRÁRIO. `{ note: "token X / telefone +55… / e-mail j@a.com" }`
 *     atravessa inteiro: a chave `note` é permitida, e a denylist nunca olha o
 *     valor (deliberadamente — heurística sobre valor é o que este módulo se
 *     recusa a fazer).
 *   * `cancelOnboardingRun({ reason_code })` era TEXTO LIVRE, e o motivo é
 *     persistido integralmente em `onboarding_runs.last_error_code`, no evento
 *     append-only e em `admin_audit_log`.
 *
 * Nos dois casos os comentários das tabelas prometem "sem telefone, sem
 * e-mail, sem segredo" e o código não entregava. A correção NÃO é uma
 * heurística melhor: é fechar a superfície. Toda entrada livre da saga passa a
 * ser um SCHEMA TIPADO com vocabulário fechado (`runMetadataSchema`,
 * `ONBOARDING_CANCEL_REASONS`), e só os campos aprovados são PROJETADOS para
 * persistência. O que não está no contrato não é redigido: é RECUSADO.
 *
 * `sanitizeForPersistence` continua existindo e continua sendo aplicado — como
 * segunda linha, sobre o que os PASSOS produzem (`result`/`summary` são
 * gerados pelo backend, não pelo operador).
 */
import { z } from 'zod';
import { OnboardingError } from './errors.js';

const REDACTED = '[redacted]';
const MAX_STRING = 512;
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;

/**
 * Fragmentos de nome de campo proibidos (case-insensitive, substring). Cobre
 * PT e EN porque o schema mistura os dois.
 */
const DENIED_KEY_FRAGMENTS = [
  'secret',
  'segredo',
  'password',
  'senha',
  'token',
  'credential',
  'credencial',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'session',
  'qr',
  'pairing_code',
  'pairing_material',
  'phone',
  'telefone',
  'whatsapp',
  'msisdn',
  'external_id',
  'email',
  'cpf',
  'cnpj',
  'documento',
] as const;

export function isDeniedKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return DENIED_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

/**
 * Sanitiza um objeto para persistência. Sempre devolve um objeto (nunca
 * `undefined`) para que o caller possa passar direto ao `jsonb NOT NULL`.
 */
export function sanitizeForPersistence(value: unknown): Record<string, unknown> {
  const walked = walk(value, 0);
  if (walked !== null && typeof walked === 'object' && !Array.isArray(walked)) {
    return walked as Record<string, unknown>;
  }
  return { value: walked };
}

function walk(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[depth-limit]';
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => walk(v, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `…+${value.length - MAX_ARRAY}`] : head;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isDeniedKey(key) ? REDACTED : walk(v, depth + 1);
    }
    return out;
  }
  // function / symbol / bigint — nada disso pertence a um jsonb.
  return '[unsupported]';
}

// ── Superfícies de ENTRADA: schemas tipados, não texto livre ─────────────────
//
// Regra de admissão destes vocabulários: um valor só entra se for uma
// CATEGORIA (algo que o produto enumera e que a UI oferece num seletor), nunca
// um campo em que o operador digita. "Motivo por extenso" não tem lugar aqui —
// se um dia for necessário, ele pertence a uma tabela de anotação com o seu
// próprio contrato de retenção, não a `last_error_code`.

/** De onde a run foi aberta. Fechado: a UI escolhe, o operador não digita. */
export const RUN_METADATA_SOURCES = ['console', 'cli', 'api', 'automation'] as const;

/** Por que a run foi aberta. Também categórico. */
export const RUN_METADATA_INTENTS = [
  'new_tenant',
  'reonboarding',
  'migration',
  'evaluation',
] as const;

/**
 * O contrato COMPLETO de `onboarding_runs.metadata`.
 *
 * `.strict()` é o coração da correção: uma chave desconhecida é RECUSADA, e
 * não silenciosamente aceita para depois passar (ou não) pela denylist. É o
 * que impede `{ note: '<qualquer coisa>' }` de existir.
 *
 * `ticket_ref` é a única string, e o seu formato é fechado por regex
 * (`ABC-123`): identifica o chamado que motivou o onboarding sem admitir
 * telefone, e-mail, token ou prosa.
 */
export const runMetadataSchema = z
  .object({
    source: z.enum(RUN_METADATA_SOURCES),
    intent: z.enum(RUN_METADATA_INTENTS).optional(),
    ticket_ref: z
      .string()
      .regex(/^[A-Z][A-Z0-9]{1,9}-[0-9]{1,8}$/, 'ticket_ref fora do formato ABC-123')
      .optional(),
  })
  .strict();

export type OnboardingRunMetadata = z.infer<typeof runMetadataSchema>;

/**
 * Valida e PROJETA o metadata da criação da run.
 *
 * Devolve um objeto NOVO, montado campo a campo a partir do resultado do
 * schema — nunca o objeto do chamador. A projeção explícita é o que garante
 * que um campo novo só chegue ao banco quando alguém o adicionar AQUI, de
 * propósito; devolver o objeto parseado deixaria passar qualquer coisa que um
 * `.passthrough()` futuro admitisse.
 *
 * @throws OnboardingError('invalid_scope') — o MESMO código que
 *   `parseStepPayload` usa para violação de contrato de payload. O union de
 *   `ONBOARDING_ERROR_CODES` é espelhado pelo vocabulário fechado de métricas
 *   (`src/observability/taxonomy.ts`, fora desta fatia): reaproveitar um código
 *   existente é melhor do que divergir os dois conjuntos em silêncio.
 */
export function projectRunMetadata(raw: unknown): Record<string, unknown> {
  const parsed = runMetadataSchema.safeParse(raw ?? { source: 'console' });
  if (!parsed.success) {
    throw new OnboardingError('invalid_scope', 'metadata da run fora do contrato', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
    });
  }
  const meta = parsed.data;
  const projected: Record<string, unknown> = { source: meta.source };
  if (meta.intent !== undefined) projected.intent = meta.intent;
  if (meta.ticket_ref !== undefined) projected.ticket_ref = meta.ticket_ref;
  return projected;
}

/**
 * VOCABULÁRIO FECHADO de motivo de cancelamento.
 *
 * É um SUBCONJUNTO de `ONBOARDING_REASONS` (`src/observability/taxonomy.ts`),
 * e isso é o ponto: o motivo que vai para `onboarding_runs.last_error_code`,
 * para o evento e para a auditoria passa a ser EXATAMENTE o mesmo valor que
 * vira label de métrica. Antes eram dois — o label era colapsado no vocabulário
 * fechado e o banco recebia o texto cru do operador. Quem lia a trilha e quem
 * lia a série viam coisas diferentes, e a trilha era a que podia conter PII.
 *
 * `expired` está aqui porque é o motivo que a varredura de runs vencidas grava
 * (`expireStale`): o vocabulário do banco precisa admiti-lo.
 */
export const ONBOARDING_CANCEL_REASONS = ['operator_abort', 'expired'] as const;

export type OnboardingCancelReason = (typeof ONBOARDING_CANCEL_REASONS)[number];

/**
 * @throws OnboardingError('invalid_scope') quando o motivo não está no
 *   vocabulário — inclusive (e principalmente) quando ele é prosa com telefone
 *   ou e-mail dentro.
 */
export function parseCancelReason(raw: unknown): OnboardingCancelReason {
  if (typeof raw === 'string' && (ONBOARDING_CANCEL_REASONS as readonly string[]).includes(raw)) {
    return raw as OnboardingCancelReason;
  }
  throw new OnboardingError(
    'invalid_scope',
    `reason_code fora do vocabulário fechado (esperado: ${ONBOARDING_CANCEL_REASONS.join(', ')})`,
  );
}
