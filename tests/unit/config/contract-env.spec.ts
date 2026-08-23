/**
 * `contractEnv` — o acessor por-variável do contrato (issue #596).
 *
 * Duas propriedades, e as duas são o que justificam o módulo existir:
 *
 *  1. **Equivalência de VALOR com o `config` de `src/config/env.ts`.** Aquele
 *     singleton parseia `objectSchemaForService('runtime')` sobre `process.env`;
 *     aqui é `spec.schema` sobre `process.env[NOME]`, chave a chave. Se as duas
 *     derivações divergissem, trocar uma pela outra num módulo compartilhado
 *     mudaria comportamento em silêncio. A comparação abaixo é feita contra o
 *     MESMO construtor de schema que `env.ts` usa — não contra uma segunda
 *     tabela escrita à mão, que seria só outra coisa para envelhecer.
 *
 *  2. **Ausência do boot de qualquer serviço.** Ler uma variável não pode
 *     exigir o subset `runtime` inteiro — era exatamente isso que o console
 *     pagava.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CONTRACT_ENTRIES,
  entriesForService,
  objectSchemaForService,
} from '@/config/contract.js';
import { contractEnv, _resetContractEnvCacheForTests } from '@/config/contract-env.js';

/** Um ambiente `runtime` completo o bastante para o schema inteiro parsear. */
const RUNTIME_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'production',
  MAIA_ENV: 'production',
  DATABASE_URL: 'postgres://maia:f4kepassw0rd@postgres:5432/maia',
  POSTGRES_USER: 'maia',
  POSTGRES_PASSWORD: 'f4kepassw0rd',
  POSTGRES_DB: 'maia',
  REDIS_URL: 'redis://:f4keredispass@redis:6379',
  WHATSAPP_NUMBER_MAIA: '+5511000000000',
  OWNER_TELEFONE_WHATSAPP: '+5511999999999',
  OWNER_NOME: 'Operador de Producao',
  LOG_LEVEL: 'warn',
  IDEMPOTENCY_BUCKET_MINUTES: '7',
  FEATURE_PDF_REPORTS: 'true',
  RUNTIME_TRACE_HMAC_KEY_VERSION: '3',
};

let saved: NodeJS.ProcessEnv;

function useEnv(env: Readonly<Record<string, string>>): void {
  for (const spec of CONTRACT_ENTRIES) delete process.env[spec.name];
  for (const key of Object.keys(process.env)) {
    if (/^(MAIA_|FEATURE_)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, env);
  _resetContractEnvCacheForTests();
}

beforeEach(() => {
  saved = { ...process.env };
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
  _resetContractEnvCacheForTests();
});

describe('contractEnv — mesmo valor que o schema do serviço entregaria', () => {
  it('toda variável do subset `runtime` bate, uma a uma', () => {
    useEnv(RUNTIME_ENV);
    // A referência é a derivação REAL de `src/config/env.ts`:
    // `objectSchemaForService('runtime').safeParse(process.env)`.
    const parsed = objectSchemaForService('runtime').safeParse(process.env);
    expect(parsed.success, 'o ambiente desta spec deixou de satisfazer o schema runtime').toBe(true);
    const reference = parsed.success ? (parsed.data as Record<string, unknown>) : {};

    const divergentes: string[] = [];
    for (const spec of entriesForService('runtime')) {
      const viaContractEnv = (contractEnv as unknown as Record<string, unknown>)[spec.name];
      // Comparação ESTRUTURAL: schemas com `.transform()` (ALERT_CHANNELS vira
      // array) produzem instâncias distintas para o mesmo valor, e é o valor
      // que importa aqui.
      const igual =
        JSON.stringify(viaContractEnv ?? null) === JSON.stringify(reference[spec.name] ?? null);
      if (!igual) divergentes.push(spec.name);
    }
    expect(
      divergentes,
      'contractEnv divergiu do schema do serviço — um módulo compartilhado passaria a ver ' +
        'um valor diferente do que o runtime vê para a mesma variável.',
    ).toEqual([]);
    // E o ambiente exercita valores NÃO-default, senão a igualdade acima seria
    // "undefined === undefined" para quase tudo.
    expect(contractEnv.LOG_LEVEL).toBe('warn');
    expect(contractEnv.IDEMPOTENCY_BUCKET_MINUTES).toBe(7);
    expect(contractEnv.FEATURE_PDF_REPORTS).toBe(true);
  });

  it('default do contrato aplicado quando a variável está ausente', () => {
    useEnv({ NODE_ENV: 'test' });
    expect(contractEnv.LOG_LEVEL).toBe('info');
    expect(contractEnv.IDEMPOTENCY_BUCKET_MINUTES).toBe(5);
    expect(contractEnv.FEATURE_PDF_REPORTS).toBe(false);
  });

  it('valor inválido LANÇA nomeando a variável, e nunca o valor', () => {
    useEnv({ ...RUNTIME_ENV, IDEMPOTENCY_BUCKET_MINUTES: 'nao-e-numero' });
    expect(() => contractEnv.IDEMPOTENCY_BUCKET_MINUTES).toThrow(/IDEMPOTENCY_BUCKET_MINUTES/);
    try {
      void contractEnv.IDEMPOTENCY_BUCKET_MINUTES;
    } catch (err) {
      expect((err as Error).message).not.toContain('nao-e-numero');
    }
  });
});

describe('contractEnv — ler uma variável não é o boot de nenhum serviço', () => {
  it('um ambiente de console SEM nada do subset `runtime` entrega DATABASE_URL', () => {
    // O caso que o console vive: `src/db/client.ts` precisa da DSN, e não pode
    // pagar por isso o subset `runtime` inteiro (as seis BACKUP_*, a chave de
    // LLM, o número do WhatsApp...).
    useEnv({
      NODE_ENV: 'production',
      MAIA_ENV: 'production',
      DATABASE_URL: 'postgres://maia:f4kepassw0rd@postgres:5432/maia',
      NEXTAUTH_URL: 'https://admin.example.com',
    });
    expect(contractEnv.DATABASE_URL).toBe('postgres://maia:f4kepassw0rd@postgres:5432/maia');
    // E o mesmo ambiente REPROVA o subset runtime — que é o motivo de o console
    // não poder passar por lá.
    expect(objectSchemaForService('runtime').safeParse(process.env).success).toBe(false);
  });

  it('o memo devolve o mesmo valor e não relê process.env', () => {
    useEnv({ ...RUNTIME_ENV, LOG_LEVEL: 'debug' });
    expect(contractEnv.LOG_LEVEL).toBe('debug');
    process.env.LOG_LEVEL = 'error';
    expect(contractEnv.LOG_LEVEL).toBe('debug');
    _resetContractEnvCacheForTests();
    expect(contractEnv.LOG_LEVEL).toBe('error');
  });

  it('expõe exatamente as chaves do contrato', () => {
    expect(Object.keys(contractEnv).sort()).toEqual(
      CONTRACT_ENTRIES.map((s) => s.name).sort(),
    );
  });
});
