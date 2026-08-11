/**
 * Issue #515, PR #522 review round 1 [P2] — `requiredWhen` must be EXECUTED,
 * not merely printed.
 *
 * Before this, `requiredWhen` was a prose string that only ever appeared inside
 * the remediation of a variable already flagged by `requiredIn`. The condition
 * itself never ran, so a production environment with
 * `FEATURE_OUTBOUND_VOICE=true` and no `OPENAI_API_KEY` (embeddings on Voyage)
 * validated `ok=true` even though the contract declared the key required. The
 * same hole existed for `RUNTIME_TRACE_DEBUG_AES_KEY` and
 * `ADMIN_UI_DEV_LOGIN_TOKEN`.
 *
 * THE COVERAGE FENCE: `CASES` below is asserted to be EXACTLY the set of
 * variables that declare `requiredWhen` in the contract. Adding a conditional
 * requirement without a case here fails the suite — "se uma condição não tem
 * teste, ela não existe".
 */
import { describe, it, expect } from 'vitest';
import { CONTRACT_ENTRIES, findSpec } from '@/config/contract.js';
import { describeRequiredWhen, evaluateRequiredWhen } from '@/config/metadata.js';
import { buildFixture } from '@/config/generate.js';
import { formatHuman, validateConfig } from '@/config/validate.js';

type Env = Record<string, string | undefined>;

interface Case {
  /** Env deltas that make the condition TRUE (the variable itself is removed). */
  readonly trigger: Env;
  /** Env deltas that make the condition FALSE. */
  readonly satisfiedOtherwise: Env;
  /** Rule id expected when the variable is missing and the condition holds. */
  readonly rule: string;
}

/**
 * One case per `requiredWhen` in the contract.
 *
 * `rule` is `contract/required-when` for conditions enforced by the generic
 * pass, or the id of the hand-written rule that predates it (those keep the
 * verbatim boot message and declare `covers`, so the generic pass stays quiet
 * instead of double-reporting).
 */
const CASES: Record<string, Case> = {
  ANTHROPIC_API_KEY: {
    trigger: { LLM_PROVIDER: 'anthropic' },
    satisfiedOtherwise: { LLM_PROVIDER: 'openrouter' },
    rule: 'llm/provider-key',
  },
  OPENROUTER_API_KEY: {
    trigger: { LLM_PROVIDER: 'openrouter' },
    satisfiedOtherwise: { LLM_PROVIDER: 'anthropic' },
    rule: 'llm/provider-key',
  },
  VOYAGE_API_KEY: {
    trigger: { EMBEDDING_PROVIDER: 'voyage', EMBEDDING_MODEL: 'voyage-3' },
    satisfiedOtherwise: {
      EMBEDDING_PROVIDER: 'cohere',
      EMBEDDING_MODEL: 'embed-english-v3.0',
      COHERE_API_KEY: 'fixture-cohere-key',
    },
    rule: 'embeddings/provider-key',
  },
  COHERE_API_KEY: {
    trigger: { EMBEDDING_PROVIDER: 'cohere', EMBEDDING_MODEL: 'embed-english-v3.0' },
    satisfiedOtherwise: { EMBEDDING_PROVIDER: 'voyage', EMBEDDING_MODEL: 'voyage-3' },
    rule: 'embeddings/provider-key',
  },
  // The regression named by the review: embeddings stay on Voyage, so the
  // legacy `embeddings/provider-key` rule does NOT fire — only the executed
  // `requiredWhen` catches the outbound-voice branch.
  OPENAI_API_KEY: {
    trigger: { FEATURE_OUTBOUND_VOICE: 'true' },
    satisfiedOtherwise: { FEATURE_OUTBOUND_VOICE: 'false' },
    rule: 'contract/required-when',
  },
  MAIA_STAGING_KEYRING: {
    trigger: { MAIA_CHANNEL_ROUTING_MODE: 'strict' },
    satisfiedOtherwise: { MAIA_CHANNEL_ROUTING_MODE: 'shadow' },
    rule: 'routing/strict-requires-keyring',
  },
  // Issue #520: cifra de backup exigida ⇒ o keyring e o id da chave ativa são
  // obrigatórios. Sem eles a run FALHA FECHADA (nunca grava dump em claro), e
  // descobrir isso às 3h é tarde — o boot avisa.
  BACKUP_ENCRYPTION_KEYRING: {
    trigger: { BACKUP_ENCRYPTION_MODE: 'envelope_aes256_gcm' },
    satisfiedOtherwise: { BACKUP_ENCRYPTION_MODE: 'none' },
    rule: 'backup/encryption-key',
  },
  BACKUP_ENCRYPTION_ACTIVE_KEY_ID: {
    trigger: { BACKUP_ENCRYPTION_MODE: 'envelope_aes256_gcm' },
    satisfiedOtherwise: { BACKUP_ENCRYPTION_MODE: 'none' },
    rule: 'backup/encryption-key',
  },
  MAIA_STAGING_ACTIVE_KEY_ID: {
    trigger: { MAIA_CHANNEL_ROUTING_MODE: 'strict' },
    satisfiedOtherwise: { MAIA_CHANNEL_ROUTING_MODE: 'shadow' },
    rule: 'routing/strict-requires-keyring',
  },
  SMTP_HOST: {
    trigger: { ALERT_CHANNELS: 'email', ALERT_EMAIL_TO: 'ops@example.com' },
    satisfiedOtherwise: { ALERT_CHANNELS: 'log' },
    rule: 'alerts/email-transport',
  },
  ALERT_EMAIL_TO: {
    trigger: { ALERT_CHANNELS: 'email', SMTP_HOST: 'smtp.internal' },
    satisfiedOtherwise: { ALERT_CHANNELS: 'log' },
    rule: 'alerts/email-destination',
  },
  TELEGRAM_BOT_TOKEN: {
    trigger: { ALERT_CHANNELS: 'telegram', TELEGRAM_CHAT_ID: '-1001234567890' },
    satisfiedOtherwise: { ALERT_CHANNELS: 'log' },
    rule: 'alerts/telegram-credentials',
  },
  TELEGRAM_CHAT_ID: {
    trigger: { ALERT_CHANNELS: 'telegram', TELEGRAM_BOT_TOKEN: 'fixture-telegram-token' },
    satisfiedOtherwise: { ALERT_CHANNELS: 'log' },
    rule: 'alerts/telegram-credentials',
  },
  BACKUP_S3_ACCESS_KEY: {
    trigger: { BACKUP_S3_BUCKET: 'maia-backups' },
    // The bucket is required in staging/production, so "condition false" is
    // only reachable in development.
    satisfiedOtherwise: { BACKUP_S3_BUCKET: undefined, BACKUP_S3_SECRET_KEY: undefined },
    rule: 'backup/s3-credentials',
  },
  BACKUP_S3_SECRET_KEY: {
    trigger: { BACKUP_S3_BUCKET: 'maia-backups' },
    satisfiedOtherwise: { BACKUP_S3_BUCKET: undefined, BACKUP_S3_ACCESS_KEY: undefined },
    rule: 'backup/s3-credentials',
  },
  RUNTIME_TRACE_DEBUG_AES_KEY: {
    trigger: { RUNTIME_TRACE_DEBUG_S3_BUCKET: 'maia-trace-debug' },
    satisfiedOtherwise: { RUNTIME_TRACE_DEBUG_S3_BUCKET: undefined },
    rule: 'contract/required-when',
  },
  ADMIN_UI_DEV_LOGIN_TOKEN: {
    trigger: { ALLOW_DEV_AUTH: 'true' },
    satisfiedOtherwise: { ALLOW_DEV_AUTH: 'false' },
    rule: 'contract/required-when',
  },
};

function envWithout(profile: 'development' | 'production', name: string, deltas: Env): Env {
  const env: Env = { ...buildFixture(profile), ...deltas };
  delete env[name];
  for (const [k, v] of Object.entries(deltas)) if (v === undefined) delete env[k];
  return env;
}

describe('requiredWhen — cobertura exata do contrato (#515)', () => {
  it('todo requiredWhen do contrato tem um caso de teste (e vice-versa)', () => {
    const declared = CONTRACT_ENTRIES.filter((s) => s.requiredWhen).map((s) => s.name).sort();
    expect(
      Object.keys(CASES).sort(),
      'adicionou um requiredWhen? adicione o caso aqui — condição sem teste não existe',
    ).toEqual(declared);
  });

  it('nenhum requiredWhen é string livre (a condição precisa ser executável)', () => {
    for (const spec of CONTRACT_ENTRIES) {
      if (!spec.requiredWhen) continue;
      expect(typeof spec.requiredWhen, `${spec.name}`).toBe('object');
      expect(describeRequiredWhen(spec.requiredWhen).length).toBeGreaterThan(3);
    }
  });
});

describe('requiredWhen — condição verdadeira ⇒ erro (#515)', () => {
  // ADMIN_UI_DEV_LOGIN_TOKEN só pode estar ativo em development; os demais
  // rodam no profile estrito.
  const profileFor = (name: string): 'development' | 'production' =>
    name === 'ADMIN_UI_DEV_LOGIN_TOKEN' ? 'development' : 'production';

  it.each(Object.entries(CASES))(
    '%s ausente com a condição satisfeita ⇒ erro',
    (name, testCase) => {
      const profile = profileFor(name);
      const env = envWithout(profile, name, testCase.trigger);
      const result = validateConfig({ env, profile });

      // A condição realmente avalia como verdadeira sobre este ambiente.
      const spec = findSpec(name)!;
      expect(evaluateRequiredWhen(spec.requiredWhen!, { values: {}, raw: env })).toBe(true);

      const problem = result.errors.find((p) => p.rule === testCase.rule);
      expect(
        problem,
        `esperava ${testCase.rule} para ${name}; recebi:\n${formatHuman(result)}`,
      ).toBeDefined();
      expect(result.ok).toBe(false);
      // A mensagem nomeia a variável faltante e traz remediação.
      expect(`${problem!.message} ${problem!.variable ?? ''}`).toContain(name);
      expect(problem!.remediation.length).toBeGreaterThan(0);
    },
  );
});

describe('requiredWhen — condição falsa ⇒ silêncio (#515)', () => {
  it.each(Object.entries(CASES))(
    '%s ausente com a condição NÃO satisfeita ⇒ sem erro dessa regra',
    (name, testCase) => {
      // Sempre em development: staging/production tornam obrigatórias por
      // `requiredIn` variáveis (bucket S3, OIDC…) que este caso desliga.
      const env = envWithout('development', name, testCase.satisfiedOtherwise);
      const result = validateConfig({ env, profile: 'development' });

      const spec = findSpec(name)!;
      expect(evaluateRequiredWhen(spec.requiredWhen!, { values: {}, raw: env })).toBe(false);
      expect(
        result.errors.filter((p) => p.variable === name),
        formatHuman(result),
      ).toEqual([]);
    },
  );
});

describe('requiredWhen — sem duplicação de reporte (#515)', () => {
  it('uma regra legada com `covers` silencia o passo genérico', () => {
    const env = envWithout('production', 'ANTHROPIC_API_KEY', { LLM_PROVIDER: 'anthropic' });
    const result = validateConfig({ env, profile: 'production' });
    // A mensagem de boot legada é preservada…
    expect(
      result.errors.some(
        (p) => p.message === 'ANTHROPIC_API_KEY required when LLM_PROVIDER=anthropic',
      ),
    ).toBe(true);
    // …e o passo genérico NÃO reporta a mesma variável de novo.
    expect(
      result.errors.filter(
        (p) => p.rule === 'contract/required-when' && p.variable === 'ANTHROPIC_API_KEY',
      ),
    ).toEqual([]);
  });
});

describe('evaluateRequiredWhen — semântica dos operadores (#515)', () => {
  const raw = {
    LLM_PROVIDER: 'anthropic',
    ALERT_CHANNELS: 'log, telegram',
    FEATURE_OUTBOUND_VOICE: '1',
    BACKUP_S3_BUCKET: 'bucket',
    EMPTY: '   ',
  };
  const view = { values: {}, raw };

  it('equals compara o valor efetivo', () => {
    expect(evaluateRequiredWhen({ var: 'LLM_PROVIDER', equals: 'anthropic' }, view)).toBe(true);
    expect(evaluateRequiredWhen({ var: 'LLM_PROVIDER', equals: 'openrouter' }, view)).toBe(false);
  });

  it('includes entende a lista separada por vírgula, com espaços', () => {
    expect(evaluateRequiredWhen({ var: 'ALERT_CHANNELS', includes: 'telegram' }, view)).toBe(true);
    expect(evaluateRequiredWhen({ var: 'ALERT_CHANNELS', includes: 'email' }, view)).toBe(false);
  });

  it('includes também funciona sobre o valor já parseado (array)', () => {
    expect(
      evaluateRequiredWhen(
        { var: 'ALERT_CHANNELS', includes: 'email' },
        { values: { ALERT_CHANNELS: ['log', 'email'] }, raw },
      ),
    ).toBe(true);
  });

  it('truthy aceita `true`, `1` e o booleano parseado', () => {
    expect(evaluateRequiredWhen({ var: 'FEATURE_OUTBOUND_VOICE', truthy: true }, view)).toBe(true);
    expect(
      evaluateRequiredWhen(
        { var: 'FEATURE_OUTBOUND_VOICE', truthy: true },
        { values: { FEATURE_OUTBOUND_VOICE: false }, raw },
      ),
    ).toBe(false);
  });

  it('present ignora string vazia ou só espaços', () => {
    expect(evaluateRequiredWhen({ var: 'BACKUP_S3_BUCKET', present: true }, view)).toBe(true);
    expect(evaluateRequiredWhen({ var: 'EMPTY', present: true }, view)).toBe(false);
    expect(evaluateRequiredWhen({ var: 'AUSENTE', present: true }, view)).toBe(false);
  });

  it('anyOf / allOf combinam condições', () => {
    const anyOf = {
      anyOf: [
        { var: 'LLM_PROVIDER', equals: 'openrouter' } as const,
        { var: 'FEATURE_OUTBOUND_VOICE', truthy: true } as const,
      ],
    };
    expect(evaluateRequiredWhen(anyOf, view)).toBe(true);
    const allOf = {
      allOf: [
        { var: 'LLM_PROVIDER', equals: 'openrouter' } as const,
        { var: 'FEATURE_OUTBOUND_VOICE', truthy: true } as const,
      ],
    };
    expect(evaluateRequiredWhen(allOf, view)).toBe(false);
  });

  it('describeRequiredWhen produz a prosa que a documentação publica', () => {
    expect(describeRequiredWhen({ var: 'LLM_PROVIDER', equals: 'anthropic' })).toBe(
      'LLM_PROVIDER=anthropic',
    );
    expect(describeRequiredWhen({ var: 'ALERT_CHANNELS', includes: 'email' })).toBe(
      'ALERT_CHANNELS contém email',
    );
    expect(describeRequiredWhen({ var: 'ALLOW_DEV_AUTH', truthy: true })).toBe(
      'ALLOW_DEV_AUTH=true',
    );
    expect(describeRequiredWhen({ var: 'BACKUP_S3_BUCKET', present: true })).toBe(
      'BACKUP_S3_BUCKET está definida',
    );
    expect(
      describeRequiredWhen({
        anyOf: [
          { var: 'EMBEDDING_PROVIDER', equals: 'openai' },
          { var: 'FEATURE_OUTBOUND_VOICE', truthy: true },
        ],
      }),
    ).toBe('EMBEDDING_PROVIDER=openai ou FEATURE_OUTBOUND_VOICE=true');
  });
});
