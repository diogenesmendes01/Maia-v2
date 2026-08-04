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
 */

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
