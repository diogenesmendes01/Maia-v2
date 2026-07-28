/**
 * Canonical configuration contract (issue #515).
 *
 * SINGLE SOURCE OF TRUTH for every Maia environment variable. Runtime, Admin
 * UI, migration runner, backup and maintenance commands all derive their
 * schema, their allow-list and their documentation from this table.
 *
 * PURITY CONTRACT — importing this module must NOT:
 *   - run `dotenv/config`
 *   - read `process.env`
 *   - touch the filesystem or the network
 *   - create directories, sockets or global singletons
 *   - import gateway/db/queue modules
 * This is what lets `maia doctor` (#517), the migration runner (#516), the CLI
 * and the test suite reason about configuration without booting the world.
 * `tests/unit/config/contract-purity.spec.ts` enforces it.
 *
 * HOW TO ADD / DEPRECATE / REMOVE A VARIABLE — see `docs/configuration.md`
 * (generated) and `docs/architecture/modules/config.md`.
 */
// The ONLY import allowed here is `zod`. Anything else (even `node:path`)
// would make the contract un-bundleable for the Admin UI and weaken the purity
// guarantee that `tests/unit/config/contract-purity.spec.ts` enforces.
import { z } from 'zod';
import {
  type EnvVarSpec,
  type MaiaProfile,
  type MaiaService,
  type Tombstone,
  isMaiaNamespacedKey,
} from '@/config/metadata.js';

/**
 * Contract version. Bump on any breaking change to the shape of the contract
 * (a variable removed, a type narrowed, a default flipped). Emitted at boot and
 * by `maia config check --json` so an operator can correlate a running process
 * with the contract it was validated against.
 */
export const CONTRACT_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Reusable schema fragments
// ---------------------------------------------------------------------------

/** The repo-wide "boolean-ish env" convention: `'true'` / `'1'` are true. */
const boolFlag = (def: 'true' | 'false') =>
  z
    .string()
    .default(def)
    .transform((s) => s === 'true' || s === '1');

const posInt = (def: number) => z.coerce.number().int().positive().default(def);

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

const ALL: readonly MaiaService[] = [
  'runtime',
  'admin-ui',
  'migrator',
  'backup',
  'maintenance',
] as const;

/**
 * Every Maia variable, in generation order. `as const` preserves the concrete
 * Zod type of each `schema` so `Config` keeps exact per-key inference.
 */
export const ENV_CONTRACT = {
  // ---- core -------------------------------------------------------------
  NODE_ENV: {
    name: 'NODE_ENV',
    description:
      'Modo da plataforma Node (otimizações do runtime). NÃO é o profile da Maia — use MAIA_ENV.',
    group: 'core',
    secret: false,
    services: ALL,
    schema: z.enum(['development', 'test', 'production']).default('development'),
    example: 'development',
    fixture: 'development',
    fixtureByProfile: { staging: 'production', production: 'production' },
    restartRequired: true,
  },
  MAIA_ENV: {
    name: 'MAIA_ENV',
    description:
      'Profile da Maia: development | staging | production. Decide quais regras de validação são obrigatórias. Quando ausente, é derivado de NODE_ENV.',
    group: 'core',
    secret: false,
    services: ALL,
    schema: z.enum(['development', 'staging', 'production']).optional(),
    example: 'development',
    fixture: 'development',
    fixtureByProfile: { staging: 'staging', production: 'production' },
    // NODE_ENV cannot express `staging` at all, and an implicit production
    // profile is exactly the "I thought this was staging" incident. Explicit.
    requiredIn: ['staging', 'production'],
    restartRequired: true,
  },
  TZ: {
    name: 'TZ',
    description: 'Timezone IANA usada em toda formatação/agendamento.',
    group: 'core',
    secret: false,
    services: ALL,
    schema: z.string().default('America/Sao_Paulo'),
    example: 'America/Sao_Paulo',
    fixture: 'America/Sao_Paulo',
    restartRequired: true,
  },
  APP_PORT: {
    name: 'APP_PORT',
    description: 'Porta HTTP do servidor Fastify.',
    group: 'core',
    secret: false,
    services: ['runtime'],
    schema: posInt(3000),
    example: '3000',
    fixture: '3000',
    restartRequired: true,
  },
  LOG_LEVEL: {
    name: 'LOG_LEVEL',
    description: 'Nível mínimo de log (pino).',
    group: 'core',
    secret: false,
    services: ALL,
    schema: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    example: 'info',
    fixture: 'info',
    restartRequired: true,
  },
  MAIA_CONFIG_STRICT_BOOT: {
    name: 'MAIA_CONFIG_STRICT_BOOT',
    description:
      'Validação de contrato no boot (fail-closed em TODOS os profiles). `false` é o ROLLBACK DE EMERGÊNCIA: volta ao loader anterior (schema + regras de boot) e desliga a detecção de variável desconhecida, tombstone e contradição de profile. Use só para destravar um ambiente, e abra issue — ver docs/runbooks/config-contract.md.',
    group: 'core',
    secret: false,
    services: ALL,
    // Mirrors src/config/env.ts exactly (`!== 'false'`): default-ON needs no
    // variable set, and the rollback is env-only, without a redeploy.
    schema: z
      .string()
      .default('true')
      .transform((s) => s !== 'false'),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_REJECT_DEFAULT_LITERAL: {
    name: 'MAIA_REJECT_DEFAULT_LITERAL',
    description:
      "Fail-closed do literal 'default' em tenant_id/agent_id (issue #323). Default ON; `false` é o rollback de emergência sem redeploy.",
    group: 'core',
    secret: false,
    services: ['runtime', 'maintenance'],
    // Mirrors src/db/tenant-context.ts:136 exactly (`!== 'false'`).
    schema: z
      .string()
      .default('true')
      .transform((s) => s !== 'false'),
    example: 'true',
    fixture: 'true',
    restartRequired: false,
    commentedInExample: true,
  },

  // ---- database ---------------------------------------------------------
  DATABASE_URL: {
    name: 'DATABASE_URL',
    description: 'DSN completo do Postgres (inclui credenciais).',
    group: 'database',
    secret: true,
    services: ALL,
    schema: z.string().url(),
    example: 'postgres://maia:trocar_senha_forte@localhost:5432/maia',
    fixture: 'postgres://maia:fixture0000pass@db.internal:5432/maia',
    requiredIn: ['development', 'staging', 'production'],
    restartRequired: true,
  },
  POSTGRES_USER: {
    name: 'POSTGRES_USER',
    description: 'Usuário do Postgres (usado pelo compose e pelo pg_dump).',
    group: 'database',
    secret: false,
    services: ['runtime', 'migrator', 'backup', 'maintenance'],
    schema: z.string().min(1),
    example: 'maia',
    fixture: 'maia',
    requiredIn: ['development', 'staging', 'production'],
    restartRequired: true,
  },
  POSTGRES_PASSWORD: {
    name: 'POSTGRES_PASSWORD',
    description: 'Senha do Postgres (mínimo 8 caracteres).',
    group: 'database',
    secret: true,
    services: ['runtime', 'migrator', 'backup', 'maintenance'],
    schema: z.string().min(8),
    example: 'trocar_senha_forte',
    fixture: 'fixture0000pass',
    requiredIn: ['development', 'staging', 'production'],
    restartRequired: true,
  },
  POSTGRES_DB: {
    name: 'POSTGRES_DB',
    description: 'Nome do banco.',
    group: 'database',
    secret: false,
    services: ['runtime', 'migrator', 'backup', 'maintenance'],
    schema: z.string().min(1),
    example: 'maia',
    fixture: 'maia',
    requiredIn: ['development', 'staging', 'production'],
    restartRequired: true,
  },
  POSTGRES_PORT: {
    name: 'POSTGRES_PORT',
    description: 'Porta do Postgres.',
    group: 'database',
    secret: false,
    services: ['runtime', 'migrator', 'backup', 'maintenance'],
    schema: posInt(5432),
    example: '5432',
    fixture: '5432',
    restartRequired: true,
  },

  // ---- redis ------------------------------------------------------------
  REDIS_URL: {
    name: 'REDIS_URL',
    description: 'URL do Redis (filas BullMQ, dedup, debounce, rate limit).',
    group: 'redis',
    secret: true,
    services: ['runtime', 'maintenance'],
    schema: z.string().url(),
    example: 'redis://localhost:6379',
    // Carries the synthetic password on purpose: `secret/synthetic-fixture`
    // matches a secret's fixture EXACTLY, so a fixture that could plausibly be
    // somebody's real value (`redis://redis.internal:6379`) would turn into a
    // false positive that aborts their boot.
    fixture: 'redis://:fixture0000pass@redis.internal:6379',
    requiredIn: ['development', 'staging', 'production'],
    restartRequired: true,
  },
  REDIS_PORT: {
    name: 'REDIS_PORT',
    description: 'Porta do Redis (usada pelo compose).',
    group: 'redis',
    secret: false,
    services: ['runtime', 'maintenance'],
    schema: posInt(6379),
    example: '6379',
    fixture: '6379',
    restartRequired: true,
  },

  // ---- llm --------------------------------------------------------------
  LLM_PROVIDER: {
    name: 'LLM_PROVIDER',
    description: 'Provider do LLM principal: anthropic (direto) ou openrouter (gateway).',
    group: 'llm',
    secret: false,
    services: ['runtime', 'maintenance'],
    schema: z.enum(['anthropic', 'openrouter']).default('anthropic'),
    example: 'openrouter',
    fixture: 'anthropic',
    restartRequired: true,
  },
  ANTHROPIC_API_KEY: {
    name: 'ANTHROPIC_API_KEY',
    description: 'Chave da API Anthropic. Prefixo obrigatório `sk-ant-`.',
    group: 'llm',
    secret: true,
    services: ['runtime', 'maintenance'],
    schema: z.string().startsWith('sk-ant-').optional(),
    example: 'sk-ant-...',
    fixture: 'sk-ant-fixture-not-a-real-key',
    requiredWhen: { var: 'LLM_PROVIDER', equals: 'anthropic' },
    restartRequired: true,
  },
  OPENROUTER_API_KEY: {
    name: 'OPENROUTER_API_KEY',
    description: 'Chave da API OpenRouter. Prefixo obrigatório `sk-or-`.',
    group: 'llm',
    secret: true,
    services: ['runtime', 'maintenance'],
    schema: z.string().startsWith('sk-or-').optional(),
    example: 'sk-or-...',
    fixture: 'sk-or-fixture-not-a-real-key',
    requiredWhen: { var: 'LLM_PROVIDER', equals: 'openrouter' },
    restartRequired: true,
  },
  OPENROUTER_MODEL_MAIN: {
    name: 'OPENROUTER_MODEL_MAIN',
    description:
      'Slug do modelo principal no OpenRouter (a versão usa ponto: 4.6). Exige tool-calling.',
    group: 'llm',
    secret: false,
    services: ['runtime', 'maintenance'],
    schema: z.string().default('anthropic/claude-sonnet-4.6'),
    example: 'anthropic/claude-sonnet-4.6',
    fixture: 'anthropic/claude-sonnet-4.6',
    restartRequired: false,
  },
  OPENROUTER_MODEL_FAST: {
    name: 'OPENROUTER_MODEL_FAST',
    description: 'Slug do modelo rápido no OpenRouter (classificação, judge).',
    group: 'llm',
    secret: false,
    services: ['runtime', 'maintenance'],
    schema: z.string().default('anthropic/claude-haiku-4.5'),
    example: 'anthropic/claude-haiku-4.5',
    fixture: 'anthropic/claude-haiku-4.5',
    restartRequired: false,
  },
  CLAUDE_MODEL_MAIN: {
    name: 'CLAUDE_MODEL_MAIN',
    description: 'Modelo principal na API Anthropic direta.',
    group: 'llm',
    secret: false,
    services: ['runtime', 'maintenance'],
    schema: z.string().default('claude-sonnet-4-6'),
    example: 'claude-sonnet-4-6',
    fixture: 'claude-sonnet-4-6',
    restartRequired: false,
  },
  CLAUDE_MODEL_FAST: {
    name: 'CLAUDE_MODEL_FAST',
    description: 'Modelo rápido na API Anthropic direta.',
    group: 'llm',
    secret: false,
    services: ['runtime', 'maintenance'],
    schema: z.string().default('claude-haiku-4-5-20251001'),
    example: 'claude-haiku-4-5-20251001',
    fixture: 'claude-haiku-4-5-20251001',
    restartRequired: false,
  },
  CLAUDE_MAX_RETRIES: {
    name: 'CLAUDE_MAX_RETRIES',
    description: 'Retries em chamada de LLM.',
    group: 'llm',
    secret: false,
    services: ['runtime'],
    schema: z.coerce.number().int().nonnegative().default(3),
    example: '3',
    fixture: '3',
    restartRequired: true,
    commentedInExample: true,
  },
  CLAUDE_TIMEOUT_MS: {
    name: 'CLAUDE_TIMEOUT_MS',
    description: 'Timeout (ms) de chamada de LLM.',
    group: 'llm',
    secret: false,
    services: ['runtime'],
    schema: posInt(30000),
    example: '30000',
    fixture: '30000',
    restartRequired: true,
    commentedInExample: true,
  },
  DECISION_ENGINE_BUDGET_MS: {
    name: 'DECISION_ENGINE_BUDGET_MS',
    description:
      'Orçamento wall-clock total (ms) do Decision Engine. Abaixo de ~2000ms o hop Haiku estoura e cai no fallback ask_clarification.',
    group: 'llm',
    secret: false,
    services: ['runtime'],
    schema: posInt(2500),
    example: '2500',
    fixture: '2500',
    restartRequired: true,
    commentedInExample: true,
  },
  OPENAI_API_KEY: {
    name: 'OPENAI_API_KEY',
    description: 'Chave OpenAI (Whisper, TTS e embeddings openai). Prefixo `sk-`.',
    group: 'speech',
    secret: true,
    services: ['runtime', 'maintenance'],
    schema: z.string().startsWith('sk-').optional(),
    example: 'sk-...',
    fixture: 'sk-fixture-not-a-real-key',
    requiredWhen: {
      anyOf: [
        { var: 'EMBEDDING_PROVIDER', equals: 'openai' },
        { var: 'FEATURE_OUTBOUND_VOICE', truthy: true },
      ],
    },
    restartRequired: true,
  },
  WHISPER_PROVIDER: {
    name: 'WHISPER_PROVIDER',
    description: 'Provider de transcrição de áudio.',
    group: 'speech',
    secret: false,
    services: ['runtime'],
    schema: z.enum(['openai']).default('openai'),
    example: 'openai',
    fixture: 'openai',
    restartRequired: true,
    commentedInExample: true,
  },
  WHISPER_MODEL: {
    name: 'WHISPER_MODEL',
    description: 'Modelo de transcrição.',
    group: 'speech',
    secret: false,
    services: ['runtime'],
    schema: z.string().default('whisper-1'),
    example: 'whisper-1',
    fixture: 'whisper-1',
    restartRequired: true,
  },

  // ---- embeddings -------------------------------------------------------
  EMBEDDING_PROVIDER: {
    name: 'EMBEDDING_PROVIDER',
    description: 'Provider de embeddings: voyage | openai | cohere.',
    group: 'embeddings',
    secret: false,
    services: ['runtime', 'maintenance'],
    schema: z.enum(['voyage', 'openai', 'cohere']).default('voyage'),
    example: 'voyage',
    fixture: 'voyage',
    restartRequired: true,
  },
  EMBEDDING_MODEL: {
    name: 'EMBEDDING_MODEL',
    description:
      'Modelo de embeddings. O prefixo deve casar com o provider (voyage-*, text-embedding-*, embed-*).',
    group: 'embeddings',
    secret: false,
    services: ['runtime', 'maintenance'],
    schema: z.string().default('voyage-3'),
    example: 'voyage-3',
    fixture: 'voyage-3',
    restartRequired: true,
  },
  EMBEDDING_DIMENSIONS: {
    name: 'EMBEDDING_DIMENSIONS',
    description:
      'Dimensões do vetor. Precisa casar com o modelo E com a coluna pgvector já migrada.',
    group: 'embeddings',
    secret: false,
    services: ['runtime', 'maintenance'],
    schema: posInt(1024),
    example: '1024',
    fixture: '1024',
    restartRequired: true,
  },
  VOYAGE_API_KEY: {
    name: 'VOYAGE_API_KEY',
    description: 'Chave da Voyage AI.',
    group: 'embeddings',
    secret: true,
    services: ['runtime', 'maintenance'],
    schema: z.string().optional(),
    example: '__SET_ME__voyage_api_key',
    fixture: 'fixture-voyage-key',
    requiredWhen: { var: 'EMBEDDING_PROVIDER', equals: 'voyage' },
    restartRequired: true,
  },
  COHERE_API_KEY: {
    name: 'COHERE_API_KEY',
    description: 'Chave da Cohere.',
    group: 'embeddings',
    secret: true,
    services: ['runtime', 'maintenance'],
    schema: z.string().optional(),
    example: '__SET_ME__cohere_api_key',
    fixture: 'fixture-cohere-key',
    requiredWhen: { var: 'EMBEDDING_PROVIDER', equals: 'cohere' },
    restartRequired: true,
  },

  // ---- whatsapp ---------------------------------------------------------
  BAILEYS_AUTH_DIR: {
    name: 'BAILEYS_AUTH_DIR',
    description:
      'Raiz do estado de sessão do Baileys. Precisa conter um segmento "baileys"; raízes de sistema e o CWD são recusados (o recovery apaga diretórios sob esta raiz).',
    group: 'whatsapp',
    secret: false,
    services: ['runtime'],
    schema: z.string().default('./.baileys-auth'),
    example: './.baileys-auth',
    fixture: './.baileys-auth',
    restartRequired: true,
  },
  WHATSAPP_NUMBER_MAIA: {
    name: 'WHATSAPP_NUMBER_MAIA',
    description: 'Número E.164 da linha da Maia.',
    group: 'whatsapp',
    secret: false,
    services: ['runtime'],
    schema: z.string().regex(/^\+\d{10,15}$/),
    example: '+5511000000000',
    fixture: '+5511000000000',
    requiredIn: ['development', 'staging', 'production'],
    restartRequired: true,
  },
  MAIA_DISPLAY_NAME: {
    name: 'MAIA_DISPLAY_NAME',
    description: 'Nome exibido do agente.',
    group: 'whatsapp',
    secret: false,
    services: ['runtime'],
    schema: z.string().default('Maia'),
    example: 'Maia',
    fixture: 'Maia',
    restartRequired: true,
  },

  // ---- owner ------------------------------------------------------------
  OWNER_TELEFONE_WHATSAPP: {
    name: 'OWNER_TELEFONE_WHATSAPP',
    description: 'Número E.164 do owner. Precisa ser diferente de WHATSAPP_NUMBER_MAIA.',
    group: 'owner',
    secret: false,
    services: ['runtime'],
    schema: z.string().regex(/^\+\d{10,15}$/),
    example: '+5511999999999',
    fixture: '+5511999999999',
    requiredIn: ['development', 'staging', 'production'],
    restartRequired: true,
  },
  OWNER_NOME: {
    name: 'OWNER_NOME',
    description: 'Nome do owner.',
    group: 'owner',
    secret: false,
    services: ['runtime'],
    schema: z.string().min(1),
    example: 'Mendes',
    fixture: 'Fixture Owner',
    requiredIn: ['development', 'staging', 'production'],
    restartRequired: true,
  },

  // ---- governance -------------------------------------------------------
  VALOR_LIMITE_SEM_CONFIRMACAO: {
    name: 'VALOR_LIMITE_SEM_CONFIRMACAO',
    description:
      'Teto (BRL) para executar sem confirmação extra. Ordem obrigatória: SEM_CONFIRMACAO <= DUAL_APPROVAL <= LIMITE_DURO.',
    group: 'governance',
    secret: false,
    services: ['runtime'],
    schema: z.coerce.number().nonnegative().default(1000),
    example: '1000.00',
    fixture: '1000',
    restartRequired: true,
  },
  VALOR_DUAL_APPROVAL: {
    name: 'VALOR_DUAL_APPROVAL',
    description: 'Acima deste valor (BRL) a operação exige aprovação dupla (4-eyes).',
    group: 'governance',
    secret: false,
    services: ['runtime'],
    schema: z.coerce.number().nonnegative().default(20000),
    example: '5000.00',
    fixture: '5000',
    restartRequired: true,
  },
  VALOR_LIMITE_DURO: {
    name: 'VALOR_LIMITE_DURO',
    description: 'Teto absoluto (BRL). Acima disso a operação é negada.',
    group: 'governance',
    secret: false,
    services: ['runtime'],
    schema: z.coerce.number().positive().default(50000),
    example: '10000.00',
    fixture: '10000',
    restartRequired: true,
  },
  DUAL_APPROVAL_TIMEOUT_HOURS: {
    name: 'DUAL_APPROVAL_TIMEOUT_HOURS',
    description: 'Janela (h) para a segunda aprovação antes de expirar.',
    group: 'governance',
    secret: false,
    services: ['runtime'],
    schema: posInt(6),
    example: '6',
    fixture: '6',
    restartRequired: true,
    commentedInExample: true,
  },
  AUDIT_MODE_TTL_HOURS: {
    name: 'AUDIT_MODE_TTL_HOURS',
    description: 'TTL (h) do modo auditoria.',
    group: 'governance',
    secret: false,
    services: ['runtime'],
    schema: posInt(24),
    example: '24',
    fixture: '24',
    restartRequired: true,
    commentedInExample: true,
  },
  IDEMPOTENCY_BUCKET_MINUTES: {
    name: 'IDEMPOTENCY_BUCKET_MINUTES',
    description: 'Janela (min) do bucket de idempotência.',
    group: 'governance',
    secret: false,
    services: ['runtime'],
    schema: posInt(5),
    example: '5',
    fixture: '5',
    restartRequired: true,
    commentedInExample: true,
  },
  PENDING_QUESTION_TTL_MINUTES: {
    name: 'PENDING_QUESTION_TTL_MINUTES',
    description: 'TTL (min) de pergunta pendente.',
    group: 'governance',
    secret: false,
    services: ['runtime'],
    schema: posInt(120),
    example: '120',
    fixture: '120',
    restartRequired: true,
    commentedInExample: true,
  },
  PENDING_ACTION_TTL_HOURS: {
    name: 'PENDING_ACTION_TTL_HOURS',
    description: 'TTL (h) de ação pendente.',
    group: 'governance',
    secret: false,
    services: ['runtime'],
    schema: posInt(6),
    example: '6',
    fixture: '6',
    restartRequired: true,
    commentedInExample: true,
  },
  RATE_LIMIT_MSGS_PER_HOUR: {
    name: 'RATE_LIMIT_MSGS_PER_HOUR',
    description: 'Teto de mensagens processadas por hora por remetente.',
    group: 'governance',
    secret: false,
    services: ['runtime'],
    schema: posInt(30),
    example: '30',
    fixture: '30',
    restartRequired: true,
    commentedInExample: true,
  },
  WHATSAPP_RECONNECT_ALERT_MIN: {
    name: 'WHATSAPP_RECONNECT_ALERT_MIN',
    description: 'Minutos desconectado antes de alertar.',
    group: 'governance',
    secret: false,
    services: ['runtime'],
    schema: posInt(5),
    example: '5',
    fixture: '5',
    restartRequired: true,
    commentedInExample: true,
  },

  // ---- routing ----------------------------------------------------------
  MAIA_MULTI_LINE: {
    name: 'MAIA_MULTI_LINE',
    description:
      'Liga o LineSessionManager como dono do transporte por canal (fase 3). Default off = paridade mono-linha.',
    group: 'routing',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_CHANNEL_ROUTING_MODE: {
    name: 'MAIA_CHANNEL_ROUTING_MODE',
    description:
      'shadow (só loga divergência) | exact_first (exact-match com fallback) | strict (exige staging operante, falha tipado no miss).',
    group: 'routing',
    secret: false,
    services: ['runtime'],
    schema: z.enum(['shadow', 'exact_first', 'strict']).default('shadow'),
    example: 'shadow',
    fixture: 'shadow',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_STAGING_KEYRING: {
    name: 'MAIA_STAGING_KEYRING',
    description:
      'Keyring JSON { key_id: base64(32B) } do staging cifrado de inbound não-roteado. Obrigatório no modo strict.',
    group: 'routing',
    secret: true,
    services: ['runtime'],
    schema: z.string().optional(),
    example: '__SET_ME__{"k1":"<base64 32 bytes>"}',
    fixture: '{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
    requiredWhen: { var: 'MAIA_CHANNEL_ROUTING_MODE', equals: 'strict' },
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_STAGING_ACTIVE_KEY_ID: {
    name: 'MAIA_STAGING_ACTIVE_KEY_ID',
    description: 'Id da chave ativa dentro de MAIA_STAGING_KEYRING.',
    group: 'routing',
    secret: false,
    services: ['runtime'],
    schema: z.string().optional(),
    example: 'k1',
    fixture: 'k1',
    requiredWhen: { var: 'MAIA_CHANNEL_ROUTING_MODE', equals: 'strict' },
    restartRequired: true,
    commentedInExample: true,
  },

  // ---- alerts -----------------------------------------------------------
  ALERT_CHANNELS: {
    name: 'ALERT_CHANNELS',
    description:
      'Canais de alerta separados por vírgula: log, email, telegram. Cada canal exige suas credenciais/destino.',
    group: 'alerts',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: z
      .string()
      .default('email')
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    example: 'log',
    fixture: 'log',
    restartRequired: true,
  },
  SMTP_HOST: {
    name: 'SMTP_HOST',
    description: 'Host SMTP do canal de e-mail.',
    group: 'alerts',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: z.string().optional(),
    example: 'smtp.example.com',
    fixture: 'smtp.internal',
    requiredWhen: { var: 'ALERT_CHANNELS', includes: 'email' },
    restartRequired: true,
    commentedInExample: true,
  },
  SMTP_PORT: {
    name: 'SMTP_PORT',
    description: 'Porta SMTP.',
    group: 'alerts',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: z.coerce.number().int().positive().optional(),
    example: '587',
    fixture: '587',
    restartRequired: true,
    commentedInExample: true,
  },
  SMTP_USER: {
    name: 'SMTP_USER',
    description: 'Usuário SMTP.',
    group: 'alerts',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: z.string().optional(),
    example: 'maia@example.com',
    fixture: 'maia@example.com',
    restartRequired: true,
    commentedInExample: true,
  },
  SMTP_PASS: {
    name: 'SMTP_PASS',
    description: 'Senha SMTP.',
    group: 'alerts',
    secret: true,
    services: ['runtime', 'backup', 'maintenance'],
    schema: z.string().optional(),
    example: '__SET_ME__smtp_password',
    fixture: 'fixture-smtp-pass',
    restartRequired: true,
    commentedInExample: true,
  },
  ALERT_EMAIL_TO: {
    name: 'ALERT_EMAIL_TO',
    description: 'Destinatário dos alertas por e-mail.',
    group: 'alerts',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: z.string().email().optional(),
    example: 'ops@example.com',
    fixture: 'ops@example.com',
    requiredWhen: { var: 'ALERT_CHANNELS', includes: 'email' },
    restartRequired: true,
    commentedInExample: true,
  },
  TELEGRAM_BOT_TOKEN: {
    name: 'TELEGRAM_BOT_TOKEN',
    description: 'Token do bot do Telegram.',
    group: 'alerts',
    secret: true,
    services: ['runtime', 'backup', 'maintenance'],
    schema: z.string().optional(),
    example: '__SET_ME__telegram_bot_token',
    fixture: 'fixture-telegram-token',
    requiredWhen: { var: 'ALERT_CHANNELS', includes: 'telegram' },
    restartRequired: true,
    commentedInExample: true,
  },
  TELEGRAM_CHAT_ID: {
    name: 'TELEGRAM_CHAT_ID',
    description: 'Chat de destino dos alertas no Telegram.',
    group: 'alerts',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: z.string().optional(),
    example: '-1001234567890',
    fixture: '-1001234567890',
    requiredWhen: { var: 'ALERT_CHANNELS', includes: 'telegram' },
    restartRequired: true,
    commentedInExample: true,
  },
  DLQ_ALERT_THRESHOLD: {
    name: 'DLQ_ALERT_THRESHOLD',
    description: 'Tamanho da DLQ que dispara alerta.',
    group: 'alerts',
    secret: false,
    services: ['runtime', 'maintenance'],
    schema: posInt(10),
    example: '10',
    fixture: '10',
    restartRequired: true,
    commentedInExample: true,
  },

  // ---- backup -----------------------------------------------------------
  BACKUP_DIR: {
    name: 'BACKUP_DIR',
    description: 'Diretório local dos dumps.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: z.string().default('./backups'),
    example: './backups',
    fixture: './backups',
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_RETENTION_LOCAL_DAYS: {
    name: 'BACKUP_RETENTION_LOCAL_DAYS',
    description: 'Retenção local (dias).',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: posInt(7),
    example: '7',
    fixture: '7',
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_RETENTION_CLOUD_DAYS: {
    name: 'BACKUP_RETENTION_CLOUD_DAYS',
    description: 'Retenção remota (dias).',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: posInt(30),
    example: '30',
    fixture: '30',
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_S3_BUCKET: {
    name: 'BACKUP_S3_BUCKET',
    description: 'Bucket de destino do backup remoto. Sem ele, o backup é só local.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: z.string().optional(),
    example: 'maia-backups',
    fixture: 'maia-backups',
    requiredIn: ['staging', 'production'],
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_S3_ENDPOINT: {
    name: 'BACKUP_S3_ENDPOINT',
    description:
      'Endpoint custom para provedores S3-compatíveis (Backblaze B2, Cloudflare R2, Wasabi). Vazio = AWS S3 nativo.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: z.string().url().optional(),
    example: 'https://s3.us-west-002.backblazeb2.com',
    fixture: 'https://s3.us-west-002.backblazeb2.com',
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_S3_REGION: {
    name: 'BACKUP_S3_REGION',
    description: 'Região do bucket.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: z.string().default('us-east-1'),
    example: 'us-east-1',
    fixture: 'us-east-1',
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_S3_ACCESS_KEY: {
    name: 'BACKUP_S3_ACCESS_KEY',
    description: 'Access key do bucket de backup.',
    group: 'backup',
    secret: true,
    services: ['backup', 'maintenance', 'runtime'],
    schema: z.string().optional(),
    example: '__SET_ME__s3_access_key',
    fixture: 'fixture-s3-access-key',
    requiredWhen: { var: 'BACKUP_S3_BUCKET', present: true },
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_S3_SECRET_KEY: {
    name: 'BACKUP_S3_SECRET_KEY',
    description: 'Secret key do bucket de backup.',
    group: 'backup',
    secret: true,
    services: ['backup', 'maintenance', 'runtime'],
    schema: z.string().optional(),
    example: '__SET_ME__s3_secret_key',
    fixture: 'fixture-s3-secret-key',
    requiredWhen: { var: 'BACKUP_S3_BUCKET', present: true },
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_S3_PREFIX: {
    name: 'BACKUP_S3_PREFIX',
    description: 'Prefixo dentro do bucket (sem barra inicial nem final).',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: z.string().default('maia'),
    example: 'maia',
    fixture: 'maia',
    restartRequired: true,
    commentedInExample: true,
  },

  // ---- cost -------------------------------------------------------------
  DAILY_LLM_USD_THRESHOLD: {
    name: 'DAILY_LLM_USD_THRESHOLD',
    description: 'Teto diário (USD) do cost monitor. Acima dispara alerta.',
    group: 'cost',
    secret: false,
    services: ['runtime', 'maintenance'],
    schema: z.coerce.number().positive().default(5),
    example: '5',
    fixture: '5',
    restartRequired: true,
  },

  // ---- feature flags ----------------------------------------------------
  FEATURE_MCP_TOOLS: {
    name: 'FEATURE_MCP_TOOLS',
    description:
      'MCP externo v1 (#478). Fail-closed: PROIBIDO em produção até o gate G4 (threat model + pentest).',
    group: 'feature-flags',
    secret: false,
    services: ['runtime', 'admin-ui'],
    profiles: ['development', 'staging'],
    activeWhen: 'truthy',
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_PROACTIVE_MESSAGES: {
    name: 'FEATURE_PROACTIVE_MESSAGES',
    description: 'Mensagens proativas do agente.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_OFX_IMPORT: {
    name: 'FEATURE_OFX_IMPORT',
    description: 'Importação de extratos OFX.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime', 'maintenance'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_DASHBOARD: {
    name: 'FEATURE_DASHBOARD',
    description: 'Dashboard operacional embutido no runtime.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_PENDING_GATE: {
    name: 'FEATURE_PENDING_GATE',
    description: 'Gate de resolução de perguntas pendentes.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_PRESENCE: {
    name: 'FEATURE_PRESENCE',
    description: 'Sinais de presença (typing, read receipts).',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_ONE_TAP: {
    name: 'FEATURE_ONE_TAP',
    description: 'Respostas one-tap (enquete/reação como resposta).',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_MESSAGE_UPDATE: {
    name: 'FEATURE_MESSAGE_UPDATE',
    description: 'Tratamento de edição/remoção de mensagem.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_PENDING_REMINDER: {
    name: 'FEATURE_PENDING_REMINDER',
    description: 'Lembretes de pendências.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_VIEW_ONCE_SENSITIVE: {
    name: 'FEATURE_VIEW_ONCE_SENSITIVE',
    description:
      'Respostas sensíveis (saldos, comparativos) enviadas com viewOnce, gatilhado por preferência da pessoa.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_PDF_REPORTS: {
    name: 'FEATURE_PDF_REPORTS',
    description: 'Relatórios PDF (extrato/comparativo) enviados como documento.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_OUTBOUND_VOICE: {
    name: 'FEATURE_OUTBOUND_VOICE',
    description: 'Áudio de saída via OpenAI TTS (reutiliza OPENAI_API_KEY).',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_OUTBOUND_DEDUP: {
    name: 'FEATURE_OUTBOUND_DEDUP',
    description: 'Ledger de idempotência de saída (#227) em outbound_messages.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_MESSAGE_DEBOUNCE: {
    name: 'FEATURE_MESSAGE_DEBOUNCE',
    description:
      'Agrupa textos picotados do mesmo remetente numa única rodada. Mídia sempre passa direto.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_PROCEDURE_RUNTIME: {
    name: 'FEATURE_PROCEDURE_RUNTIME',
    description:
      'Kill switch do runtime de procedimentos (selector + engine + avaliador). Default ON; a rodada ReAct base não depende dele.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('true'),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
    commentedInExample: true,
  },

  // ---- probe ------------------------------------------------------------
  MAIA_SYNTHETIC_PROBE: {
    name: 'MAIA_SYNTHETIC_PROBE',
    description:
      'Sonda sintética ponta-a-ponta. Inerte enquanto false. Exige MAIA_CHANNEL_ROUTING_MODE em exact_first ou strict.',
    group: 'probe',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_PROBE_LLM_JUDGE: {
    name: 'MAIA_PROBE_LLM_JUDGE',
    description: 'Asserção secundária por LLM-as-judge na sonda (custo/ruído: off por default).',
    group: 'probe',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_PROBE_CRON: {
    name: 'MAIA_PROBE_CRON',
    description: 'Cadência do tick da sonda (1 cenário por tick).',
    group: 'probe',
    secret: false,
    services: ['runtime'],
    schema: z.string().default('*/10 * * * *'),
    example: '*/10 * * * *',
    fixture: '*/10 * * * *',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_PROBE_SLO_MS: {
    name: 'MAIA_PROBE_SLO_MS',
    description: 'Deadline (ms) do efeito colateral. Sem efeito no SLO ⇒ silent.',
    group: 'probe',
    secret: false,
    services: ['runtime'],
    schema: posInt(30_000),
    example: '30000',
    fixture: '30000',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_PROBE_SLO_WARN_MS: {
    name: 'MAIA_PROBE_SLO_WARN_MS',
    description: 'Acima deste tempo (ms) mas dentro do SLO ⇒ slow.',
    group: 'probe',
    secret: false,
    services: ['runtime'],
    schema: posInt(15_000),
    example: '15000',
    fixture: '15000',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_PROBE_ALERT_AFTER_K: {
    name: 'MAIA_PROBE_ALERT_AFTER_K',
    description: 'K falhas consecutivas para transicionar saudável→degradado e alertar.',
    group: 'probe',
    secret: false,
    services: ['runtime'],
    schema: posInt(3),
    example: '3',
    fixture: '3',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_PROBE_AUTOSILENCE_AFTER_N: {
    name: 'MAIA_PROBE_AUTOSILENCE_AFTER_N',
    description: 'N falhas consecutivas ativam o auto-silêncio (para de gastar LLM em loop).',
    group: 'probe',
    secret: false,
    services: ['runtime'],
    schema: posInt(10),
    example: '10',
    fixture: '10',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_PROBE_SILENCED_BACKOFF_MS: {
    name: 'MAIA_PROBE_SILENCED_BACKOFF_MS',
    description: 'Intervalo (ms) de sondagem de recuperação durante o auto-silêncio.',
    group: 'probe',
    secret: false,
    services: ['runtime'],
    schema: posInt(3_600_000),
    example: '3600000',
    fixture: '3600000',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_PROBE_RUN_TTL_MS: {
    name: 'MAIA_PROBE_RUN_TTL_MS',
    description: 'TTL (ms) do cleanup de rows de run órfãs.',
    group: 'probe',
    secret: false,
    services: ['runtime'],
    schema: posInt(300_000),
    example: '300000',
    fixture: '300000',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_PROBE_LEASE_MS: {
    name: 'MAIA_PROBE_LEASE_MS',
    description: 'Lease (ms) de single-flight da sonda.',
    group: 'probe',
    secret: false,
    services: ['runtime'],
    schema: posInt(120_000),
    example: '120000',
    fixture: '120000',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_PROBE_ALERT_MODE: {
    name: 'MAIA_PROBE_ALERT_MODE',
    description:
      'log_only (default, staging-safe: log + métrica) ou alert (entrega por sendAlert com retry durável).',
    group: 'probe',
    secret: false,
    services: ['runtime'],
    schema: z.enum(['log_only', 'alert']).default('log_only'),
    example: 'log_only',
    fixture: 'log_only',
    restartRequired: true,
    commentedInExample: true,
  },

  // ---- runtime trace ----------------------------------------------------
  RUNTIME_TRACE_HMAC_KEY_VERSION: {
    name: 'RUNTIME_TRACE_HMAC_KEY_VERSION',
    description: 'Versão da chave HMAC em uso (rotação a cada 90d).',
    group: 'runtime-trace',
    secret: false,
    services: ['runtime'],
    schema: posInt(1),
    example: '1',
    fixture: '1',
    restartRequired: true,
    commentedInExample: true,
  },
  RUNTIME_TRACE_HMAC_MASTER_SECRET: {
    name: 'RUNTIME_TRACE_HMAC_MASTER_SECRET',
    description:
      'Segredo mestre do HMAC de auditoria. OBRIGATÓRIO em produção — sem ele os HMACs de auditoria seriam forjáveis.',
    group: 'runtime-trace',
    secret: true,
    services: ['runtime'],
    schema: z.string().optional(),
    example: '__SET_ME__openssl_rand_base64_48',
    fixture: 'fixture-runtime-trace-master-secret-0000',
    requiredIn: ['staging', 'production'],
    restartRequired: true,
    commentedInExample: true,
  },
  RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS: {
    name: 'RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS',
    description:
      'Segredos anteriores, formato `versao=segredo` separados por `;`, retidos pela janela de retenção de auditoria.',
    group: 'runtime-trace',
    secret: true,
    services: ['runtime'],
    schema: z.string().optional(),
    example: '__SET_ME__1=<segredo-anterior>',
    fixture: '1=fixture-runtime-trace-prev-secret-0000',
    restartRequired: true,
    commentedInExample: true,
  },
  RUNTIME_TRACE_DEBUG_S3_BUCKET: {
    name: 'RUNTIME_TRACE_DEBUG_S3_BUCKET',
    description: 'Bucket dos snapshots cifrados do modo debug (TTL 24h).',
    group: 'runtime-trace',
    secret: false,
    services: ['runtime'],
    schema: z.string().optional(),
    example: 'maia-trace-debug',
    fixture: 'maia-trace-debug',
    restartRequired: true,
    commentedInExample: true,
  },
  RUNTIME_TRACE_DEBUG_AES_KEY: {
    name: 'RUNTIME_TRACE_DEBUG_AES_KEY',
    description: 'Chave AES-GCM (base64) dos snapshots de debug.',
    group: 'runtime-trace',
    secret: true,
    services: ['runtime'],
    schema: z.string().optional(),
    example: '__SET_ME__base64_32_bytes',
    fixture: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    requiredWhen: { var: 'RUNTIME_TRACE_DEBUG_S3_BUCKET', present: true },
    restartRequired: true,
    commentedInExample: true,
  },
  RUNTIME_TRACE_BODY_ORPHAN_SEC: {
    name: 'RUNTIME_TRACE_BODY_ORPHAN_SEC',
    description: 'Idade máxima (s) de um envelope pendente antes do alerta do recoverer.',
    group: 'runtime-trace',
    secret: false,
    services: ['runtime'],
    schema: posInt(300),
    example: '300',
    fixture: '300',
    restartRequired: true,
    commentedInExample: true,
  },
  RUNTIME_TRACE_MATVIEW_REFRESH_SEC: {
    name: 'RUNTIME_TRACE_MATVIEW_REFRESH_SEC',
    description: 'Intervalo (s) de refresh da matview unified_trace_events.',
    group: 'runtime-trace',
    secret: false,
    services: ['runtime'],
    schema: posInt(300),
    example: '300',
    fixture: '300',
    restartRequired: true,
    commentedInExample: true,
  },

  // ---- outbox / sweeper -------------------------------------------------
  OUTBOUND_SWEEPER_STALE_PENDING_SEC: {
    name: 'OUTBOUND_SWEEPER_STALE_PENDING_SEC',
    description: "Rows 'pending' mais antigas que isso são promovidas a 'unknown' (terminal).",
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(300),
    example: '300',
    fixture: '300',
    restartRequired: true,
    commentedInExample: true,
  },
  OUTBOUND_SWEEPER_RETENTION_DAYS: {
    name: 'OUTBOUND_SWEEPER_RETENTION_DAYS',
    description: 'Retenção (dias) de rows terminais em outbound_messages.',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(30),
    example: '30',
    fixture: '30',
    restartRequired: true,
    commentedInExample: true,
  },
  OUTBOUND_SWEEPER_RETENTION_BATCH_SIZE: {
    name: 'OUTBOUND_SWEEPER_RETENTION_BATCH_SIZE',
    description: 'Tamanho do chunk do DELETE de retenção (evita lock de tabela inteira).',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(1000),
    example: '1000',
    fixture: '1000',
    restartRequired: true,
    commentedInExample: true,
  },
  OUTBOUND_SWEEPER_RECOVERY_LIMIT_PER_TENANT: {
    name: 'OUTBOUND_SWEEPER_RECOVERY_LIMIT_PER_TENANT',
    description: 'Teto de promoções stale-pending por tenant por passe (fairness).',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(500),
    example: '500',
    fixture: '500',
    restartRequired: true,
    commentedInExample: true,
  },
  OUTBOX_RELAYER_BATCH_PER_TENANT: {
    name: 'OUTBOX_RELAYER_BATCH_PER_TENANT',
    description: 'Efeitos pendentes despachados por (tenant, agent) por passe.',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(100),
    example: '100',
    fixture: '100',
    restartRequired: true,
    commentedInExample: true,
  },
  OUTBOX_RELAYER_BASE_BACKOFF_SEC: {
    name: 'OUTBOX_RELAYER_BASE_BACKOFF_SEC',
    description: 'Base (s) do backoff exponencial em falha transitória.',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(30),
    example: '30',
    fixture: '30',
    restartRequired: true,
    commentedInExample: true,
  },
  OUTBOX_RELAYER_MAX_BACKOFF_SEC: {
    name: 'OUTBOX_RELAYER_MAX_BACKOFF_SEC',
    description: 'Teto (s) do backoff.',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(3600),
    example: '3600',
    fixture: '3600',
    restartRequired: true,
    commentedInExample: true,
  },
  OUTBOX_RELAYER_RETENTION_DAYS: {
    name: 'OUTBOX_RELAYER_RETENTION_DAYS',
    description: 'Retenção (dias) de rows terminais do outbox de efeitos.',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(30),
    example: '30',
    fixture: '30',
    restartRequired: true,
    commentedInExample: true,
  },
  OUTBOX_RELAYER_RETENTION_BATCH_SIZE: {
    name: 'OUTBOX_RELAYER_RETENTION_BATCH_SIZE',
    description: 'Chunk do DELETE de retenção do relayer.',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(1000),
    example: '1000',
    fixture: '1000',
    restartRequired: true,
    commentedInExample: true,
  },
  OUTBOX_MAX_PER_SECOND: {
    name: 'OUTBOX_MAX_PER_SECOND',
    description: 'Backpressure de saída: envios por segundo por instância de agente.',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(2),
    example: '2',
    fixture: '2',
    restartRequired: true,
    commentedInExample: true,
  },
  OUTBOX_MAX_PER_HOUR: {
    name: 'OUTBOX_MAX_PER_HOUR',
    description: 'Backpressure de saída: envios por hora por instância de agente.',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(120),
    example: '120',
    fixture: '120',
    restartRequired: true,
    commentedInExample: true,
  },
  OCCURRENCE_LEASE_TTL_SECONDS: {
    name: 'OCCURRENCE_LEASE_TTL_SECONDS',
    description: 'TTL (s) do lease de uma ocorrência antes de outro worker reclamar.',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(300),
    example: '300',
    fixture: '300',
    restartRequired: true,
    commentedInExample: true,
  },
  OUTBOX_LEASE_TTL_SECONDS: {
    name: 'OUTBOX_LEASE_TTL_SECONDS',
    description: 'TTL (s) do lease do outbox.',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(60),
    example: '60',
    fixture: '60',
    restartRequired: true,
    commentedInExample: true,
  },
  OUTBOX_WORKER_CONCURRENCY: {
    name: 'OUTBOX_WORKER_CONCURRENCY',
    description: 'Concorrência do worker de outbox.',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(4),
    example: '4',
    fixture: '4',
    restartRequired: true,
    commentedInExample: true,
  },
  OUTBOX_DRAIN_LOOP_PASSES: {
    name: 'OUTBOX_DRAIN_LOOP_PASSES',
    description: 'Passes de drain por tick.',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(5),
    example: '5',
    fixture: '5',
    restartRequired: true,
    commentedInExample: true,
  },
  OUTBOX_DRAIN_LOOP_SLEEP_MS: {
    name: 'OUTBOX_DRAIN_LOOP_SLEEP_MS',
    description: 'Sleep (ms) entre ticks de drain.',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: z.coerce.number().int().nonnegative().default(200),
    example: '200',
    fixture: '200',
    restartRequired: true,
    commentedInExample: true,
  },
  MESSAGE_DEBOUNCE_MS: {
    name: 'MESSAGE_DEBOUNCE_MS',
    description: 'Janela (ms) do debounce de mensagens; cada texto novo reinicia o timer.',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(5000),
    example: '5000',
    fixture: '5000',
    restartRequired: true,
    commentedInExample: true,
  },
  MESSAGE_DEBOUNCE_MAX_MS: {
    name: 'MESSAGE_DEBOUNCE_MAX_MS',
    description: 'Teto absoluto (ms) do debounce.',
    group: 'outbox',
    secret: false,
    services: ['runtime'],
    schema: posInt(30000),
    example: '30000',
    fixture: '30000',
    restartRequired: true,
    commentedInExample: true,
  },

  // ---- procedures -------------------------------------------------------
  PROCEDURE_SELECTOR_CONFIDENCE_THRESHOLD: {
    name: 'PROCEDURE_SELECTOR_CONFIDENCE_THRESHOLD',
    description:
      'Limiar (0,1] de confiança do selector de procedimentos. 0 auto-iniciaria em qualquer candidato.',
    group: 'procedures',
    secret: false,
    services: ['runtime'],
    schema: z.coerce.number().gt(0).lte(1).default(0.6),
    example: '0.6',
    fixture: '0.6',
    restartRequired: true,
    commentedInExample: true,
  },
  PROCEDURE_TTL_DAYS: {
    name: 'PROCEDURE_TTL_DAYS',
    description: "Dias de inatividade após os quais o reaper marca a execução como 'abandoned'.",
    group: 'procedures',
    secret: false,
    services: ['runtime'],
    schema: posInt(7),
    example: '7',
    fixture: '7',
    restartRequired: true,
    commentedInExample: true,
  },
  REAPER_BATCH_SIZE: {
    name: 'REAPER_BATCH_SIZE',
    description: 'Teto de leitura por tupla (tenant, agent) por tick do reaper.',
    group: 'procedures',
    secret: false,
    services: ['runtime'],
    schema: posInt(1000),
    example: '1000',
    fixture: '1000',
    restartRequired: true,
    commentedInExample: true,
  },
  REAPER_GLOBAL_BUDGET: {
    name: 'REAPER_GLOBAL_BUDGET',
    description: 'Orçamento GLOBAL de execuções ceifadas por tick, somando todas as tuplas.',
    group: 'procedures',
    secret: false,
    services: ['runtime'],
    schema: posInt(5000),
    example: '5000',
    fixture: '5000',
    restartRequired: true,
    commentedInExample: true,
  },
  CONTRADICTION_OVERLAY_TTL_HOURS: {
    name: 'CONTRADICTION_OVERLAY_TTL_HOURS',
    description: 'Janela (h) em que uma contradição resolvida ainda aparece no prompt.',
    group: 'procedures',
    secret: false,
    services: ['runtime'],
    schema: posInt(24),
    example: '24',
    fixture: '24',
    restartRequired: true,
    commentedInExample: true,
  },

  // ---- performance ------------------------------------------------------
  POLICY_RESOLVER_CACHE_TTL_MS: {
    name: 'POLICY_RESOLVER_CACHE_TTL_MS',
    description: 'TTL (ms) do PolicyResolverCache.',
    group: 'performance',
    secret: false,
    services: ['runtime'],
    schema: posInt(300_000),
    example: '300000',
    fixture: '300000',
    restartRequired: true,
    commentedInExample: true,
  },
  POLICY_RESOLVER_CACHE_MAX_ENTRIES: {
    name: 'POLICY_RESOLVER_CACHE_MAX_ENTRIES',
    description: 'Teto LRU do PolicyResolverCache.',
    group: 'performance',
    secret: false,
    services: ['runtime'],
    schema: posInt(10_000),
    example: '10000',
    fixture: '10000',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_TURN_CONTEXT_CACHE: {
    name: 'FEATURE_TURN_CONTEXT_CACHE',
    description:
      'Cache do contexto estático do turno (#511) — hoje só a seção `identity` (perfil operacional v2 renderizado). ' +
      'Default OFF: é a única parte da #511 que pode servir conteúdo velho, então sobe no escuro e é ligada por ambiente ' +
      'depois de observar a invalidação cross-replica. Desligar degrada para leitura direta pelo MESMO caminho, nunca ' +
      'para a waterfall legada — o kill switch custa latência, não correção.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    activeWhen: 'truthy',
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  TURN_CONTEXT_CACHE_TTL_MS: {
    name: 'TURN_CONTEXT_CACHE_TTL_MS',
    description:
      'TTL (ms) de uma entrada POSITIVA do cache de contexto do turno (#511). Limita o staleness quando o barramento ' +
      'de invalidação no Redis está inalcançável.',
    group: 'performance',
    secret: false,
    services: ['runtime'],
    schema: posInt(300_000),
    example: '300000',
    fixture: '300000',
    restartRequired: true,
    commentedInExample: true,
  },
  TURN_CONTEXT_CACHE_NEGATIVE_TTL_MS: {
    name: 'TURN_CONTEXT_CACHE_NEGATIVE_TTL_MS',
    description:
      'TTL (ms) de uma entrada NEGATIVA ("este agente não tem perfil operacional ativo") do cache de contexto do turno ' +
      '(#511). Deliberadamente menor que o TTL positivo: um miss costuma significar operador no meio do setup, e um ' +
      'perfil recém-ativado não pode esperar um TTL positivo inteiro para aparecer.',
    group: 'performance',
    secret: false,
    services: ['runtime'],
    schema: posInt(30_000),
    example: '30000',
    fixture: '30000',
    restartRequired: true,
    commentedInExample: true,
  },
  TURN_CONTEXT_CACHE_MAX_ENTRIES: {
    name: 'TURN_CONTEXT_CACHE_MAX_ENTRIES',
    description:
      'Teto de entradas do cache de contexto do turno (#511). Existe para limitar memória se a contagem de tuplas ' +
      '(tenant, agent) explodir, não para otimizar hit rate — o working set é de uma entrada por tupla.',
    group: 'performance',
    secret: false,
    services: ['runtime'],
    schema: posInt(5_000),
    example: '5000',
    fixture: '5000',
    restartRequired: true,
    commentedInExample: true,
  },
  SYNC_LATENCY_P95_BASELINE_MS: {
    name: 'SYNC_LATENCY_P95_BASELINE_MS',
    description: 'Baseline (ms) do p95 do caminho síncrono. Ausente ⇒ o gate é pulado.',
    group: 'performance',
    secret: false,
    services: ['runtime'],
    schema: z.coerce.number().int().positive().optional(),
    example: '1200',
    fixture: '1200',
    restartRequired: true,
    commentedInExample: true,
  },
  SYNC_LATENCY_P95_BUDGET_PERCENT: {
    name: 'SYNC_LATENCY_P95_BUDGET_PERCENT',
    description: 'Percentual extra permitido sobre a baseline.',
    group: 'performance',
    secret: false,
    services: ['runtime'],
    schema: z.coerce.number().int().nonnegative().default(20),
    example: '20',
    fixture: '20',
    restartRequired: true,
    commentedInExample: true,
  },

  // ---- setup ------------------------------------------------------------
  SETUP_TOKEN_OVERRIDE: {
    name: 'SETUP_TOKEN_OVERRIDE',
    description:
      'Override do token de bootstrap. Desencorajado em produção (env vaza mais que arquivo 0600), mas não proibido — deploys scriptados legítimos usam.',
    group: 'setup',
    secret: true,
    services: ['runtime'],
    schema: z.string().optional(),
    example: '__SET_ME__setup_token',
    fixture: 'fixture-setup-token',
    restartRequired: true,
    commentedInExample: true,
  },

  // ---- admin ui ---------------------------------------------------------
  ADMIN_UI_PORT: {
    name: 'ADMIN_UI_PORT',
    description: 'Porta do container Next.js do Admin UI.',
    group: 'admin-ui',
    secret: false,
    services: ['admin-ui'],
    schema: posInt(4000),
    example: '4000',
    fixture: '4000',
    restartRequired: true,
  },
  NEXTAUTH_URL: {
    name: 'NEXTAUTH_URL',
    description: 'URL pública do Admin UI. Precisa ser https fora de development.',
    group: 'admin-ui',
    secret: false,
    services: ['admin-ui'],
    schema: z.string().url().default('http://localhost:4000'),
    example: 'http://localhost:4000',
    fixture: 'http://localhost:4000',
    fixtureByProfile: {
      staging: 'https://admin.staging.example.com',
      production: 'https://admin.example.com',
    },
    restartRequired: true,
  },
  NEXTAUTH_SECRET: {
    name: 'NEXTAUTH_SECRET',
    description:
      'Segredo de assinatura do NextAuth (gere com `openssl rand -base64 48`). Placeholders são recusados fora de development.',
    group: 'admin-ui',
    secret: true,
    services: ['admin-ui'],
    schema: z.string().min(8).optional(),
    example: '__SET_ME__rotate_with_openssl_rand_base64_48_before_first_boot',
    fixture: 'fixture-nextauth-secret-0000000000000000000000000000',
    requiredIn: ['staging', 'production'],
    restartRequired: true,
  },
  AUTH_TRUST_HOST: {
    name: 'AUTH_TRUST_HOST',
    description:
      'Confia no Host vindo do proxy reverso (Coolify, nginx, ALB). Sem isso o NextAuth v5 recusa hosts que não batem com NEXTAUTH_URL.',
    group: 'admin-ui',
    secret: false,
    services: ['admin-ui'],
    schema: boolFlag('false'),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
  },
  NEXT_PUBLIC_API_URL: {
    name: 'NEXT_PUBLIC_API_URL',
    description: 'URL do runtime Fastify consumida pelo Admin UI. Precisa ser https fora de development.',
    group: 'admin-ui',
    secret: false,
    services: ['admin-ui'],
    schema: z.string().url().default('http://localhost:3000'),
    example: 'http://localhost:3000',
    fixture: 'http://localhost:3000',
    fixtureByProfile: {
      staging: 'https://api.staging.example.com',
      production: 'https://api.example.com',
    },
    restartRequired: true,
  },
  FEATURE_ADMIN_UI_V1: {
    name: 'FEATURE_ADMIN_UI_V1',
    description: 'Gate mestre do Admin UI v1.',
    group: 'admin-ui',
    secret: false,
    services: ['admin-ui'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_ADMIN_UI_DEBUG_SNAPSHOTS: {
    name: 'FEATURE_ADMIN_UI_DEBUG_SNAPSHOTS',
    description: 'Snapshots de debug no Admin UI.',
    group: 'admin-ui',
    secret: false,
    services: ['admin-ui'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_ADMIN_UI_BULK_REJECT: {
    name: 'FEATURE_ADMIN_UI_BULK_REJECT',
    description: 'Rejeição em lote no inbox do Admin UI.',
    group: 'admin-ui',
    secret: false,
    services: ['admin-ui'],
    schema: boolFlag('true'),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_ADMIN_UI_REDECIDE: {
    name: 'FEATURE_ADMIN_UI_REDECIDE',
    description: 'Re-decisão manual a partir do Admin UI.',
    group: 'admin-ui',
    secret: false,
    services: ['admin-ui'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  ALLOW_DEV_AUTH: {
    name: 'ALLOW_DEV_AUTH',
    description:
      'Habilita o provider de login de desenvolvimento. PROIBIDO fora de development — o boot recusa.',
    group: 'admin-ui',
    secret: false,
    services: ['admin-ui'],
    profiles: ['development'],
    activeWhen: 'truthy',
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  ADMIN_UI_DEV_LOGIN_TOKEN: {
    name: 'ADMIN_UI_DEV_LOGIN_TOKEN',
    description: 'Token compartilhado do login de desenvolvimento (mínimo 16 caracteres).',
    group: 'admin-ui',
    secret: true,
    services: ['admin-ui'],
    profiles: ['development'],
    schema: z.string().min(16).optional(),
    example: '__SET_ME__at_least_16_random_chars',
    fixture: 'fixture-dev-login-token-0000',
    requiredWhen: { var: 'ALLOW_DEV_AUTH', truthy: true },
    restartRequired: true,
    commentedInExample: true,
  },
  OIDC_ISSUER: {
    name: 'OIDC_ISSUER',
    description: 'Issuer do IdP. Precisa ser https em staging/production.',
    group: 'admin-ui',
    secret: false,
    services: ['admin-ui'],
    schema: z.string().url().optional(),
    example: 'https://login.example.com/realms/maia',
    fixture: 'https://login.example.com/realms/maia',
    requiredIn: ['staging', 'production'],
    restartRequired: true,
    commentedInExample: true,
  },
  OIDC_CLIENT_ID: {
    name: 'OIDC_CLIENT_ID',
    description: 'Client id registrado no IdP.',
    group: 'admin-ui',
    secret: false,
    services: ['admin-ui'],
    schema: z.string().optional(),
    example: 'maia-admin',
    fixture: 'maia-admin',
    requiredIn: ['staging', 'production'],
    restartRequired: true,
    commentedInExample: true,
  },
  OIDC_CLIENT_SECRET: {
    name: 'OIDC_CLIENT_SECRET',
    description: 'Client secret do IdP.',
    group: 'admin-ui',
    secret: true,
    services: ['admin-ui'],
    schema: z.string().optional(),
    example: '__SET_ME__copy_from_IdP',
    fixture: 'fixture-oidc-client-secret-0000',
    requiredIn: ['staging', 'production'],
    restartRequired: true,
    commentedInExample: true,
  },
  OIDC_TENANT_SLUGS: {
    name: 'OIDC_TENANT_SLUGS',
    description:
      'Lista (vírgula) não vazia de app_users.tenant_id que o IdP pode autenticar. Nunca cai para o literal `default`.',
    group: 'admin-ui',
    secret: false,
    services: ['admin-ui'],
    schema: z.string().optional(),
    example: 'primary',
    fixture: 'primary',
    requiredIn: ['staging', 'production'],
    restartRequired: true,
    commentedInExample: true,
  },
} as const satisfies Record<string, EnvVarSpec>;

// ---------------------------------------------------------------------------
// Tombstones — variables that WERE real and are now gone
// ---------------------------------------------------------------------------

export const TOMBSTONES: readonly Tombstone[] = [
  {
    name: 'FEATURE_MULTI_CHANNEL',
    removedIn: 'PR #411',
    reason:
      'A resolução de canal passou a ter catch-all single-tenant; o toggle é always-on / inexistente. Mantê-lo no ambiente sugere um gate que não existe mais.',
    failsOn: 'any-value',
  },
  {
    name: 'FEATURE_COGNITIVE_GRAPH',
    removedIn: 'PR #412',
    reason:
      'O grafo cognitivo roda incondicionalmente (paridade com o caminho imperativo comprovada). Os budgets SYNC_LATENCY_P95_* seguem existindo — eles limitam latência, não o grafo.',
    failsOn: 'any-value',
  },
  {
    name: 'FEATURE_CONTEXT_PACKET_V1',
    removedIn: 'PR #406',
    reason:
      'O hot-path do context packet foi deletado (o loop do agente sempre usa buildPrompt). Configurar a flag é um no-op que induziria o operador a erro.',
    failsOn: 'truthy',
  },
  {
    name: 'FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH',
    removedIn: 'PR #406',
    reason: 'Kill switch da flag removida acima — sem caminho para desligar.',
    failsOn: 'truthy',
  },
  {
    name: 'APROVAR_MENSAGENS_PROATIVAS',
    removedIn: 'issue #515',
    reason:
      'Nunca pertenceu ao schema: aparecia no `.env.example` sem nenhum consumidor. O gate real de mensagens proativas é FEATURE_PROACTIVE_MESSAGES.',
    replacement: 'FEATURE_PROACTIVE_MESSAGES',
    failsOn: 'any-value',
  },
] as const;

// ---------------------------------------------------------------------------
// Derived helpers (pure)
// ---------------------------------------------------------------------------

export type ContractKey = keyof typeof ENV_CONTRACT;

/** Contract entries in declaration order — the canonical generation order. */
export const CONTRACT_ENTRIES: readonly EnvVarSpec[] = Object.values(
  ENV_CONTRACT,
) as readonly EnvVarSpec[];

const BY_NAME = new Map<string, EnvVarSpec>(
  CONTRACT_ENTRIES.map((spec) => [spec.name, spec]),
);

const TOMBSTONE_BY_NAME = new Map<string, Tombstone>(
  TOMBSTONES.map((t) => [t.name, t]),
);

/** Look up a variable by name. `undefined` when it is not in the contract. */
export function findSpec(name: string): EnvVarSpec | undefined {
  return BY_NAME.get(name);
}

/** Look up a tombstone by name. */
export function findTombstone(name: string): Tombstone | undefined {
  return TOMBSTONE_BY_NAME.get(name);
}

/** True when the name is neither a live variable nor a tombstone. */
export function isUnknownMaiaKey(name: string): boolean {
  return isMaiaNamespacedKey(name) && !BY_NAME.has(name) && !TOMBSTONE_BY_NAME.has(name);
}

/** Entries a given service is allowed to read, in declaration order. */
export function entriesForService(service: MaiaService): readonly EnvVarSpec[] {
  return CONTRACT_ENTRIES.filter((spec) => spec.services.includes(service));
}

/** Profiles in which a variable may be set (defaults to all three). */
export function allowedProfiles(spec: EnvVarSpec): readonly MaiaProfile[] {
  return spec.profiles ?? ['development', 'staging', 'production'];
}

/** Names of every secret in the contract. */
export const SECRET_NAMES: readonly string[] = CONTRACT_ENTRIES.filter(
  (s) => s.secret,
).map((s) => s.name);

// ---------------------------------------------------------------------------
// Synthetic CI fixture detection — EXACT, per variable
// ---------------------------------------------------------------------------

/**
 * The synthetic values `buildFixture()` can emit for one variable (its
 * `fixture` plus every `fixtureByProfile` override). Empty for anything that is
 * not a declared secret.
 *
 * WHY EXACT, AND WHY SECRETS ONLY (PR #522 review round 2):
 *
 * The first implementation matched any value containing the word `fixture`.
 * With a fail-closed boot that is a production outage waiting to happen —
 * `OWNER_NOME=Fixture Labs`, `BACKUP_S3_BUCKET=maia-fixture-store` and
 * `NEXTAUTH_URL=https://fixture.example.com` are all legitimate, and all would
 * have aborted the process with a message claiming the operator's value was a
 * CI fixture. A broad heuristic and a fail-closed gate do not mix.
 *
 * The fixtures are generated FROM this table, so the exact synthetic value for
 * each key is known — no heuristic needed.
 *
 * Scoped to secrets because that is where the protection matters (a credential
 * that authenticates against nothing) and because non-secret fixtures are
 * ordinary values: `POSTGRES_USER=maia`, `TZ=America/Sao_Paulo` and
 * `EMBEDDING_MODEL=voyage-3` are exactly what a real deployment sets.
 */
export function syntheticFixtureValuesFor(name: string): readonly string[] {
  const spec = findSpec(name);
  if (!spec?.secret) return [];
  const values = [spec.fixture, ...Object.values(spec.fixtureByProfile ?? {})];
  return values.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * True when `value` is EXACTLY the synthetic CI fixture for `name` — i.e. this
 * environment carries a credential copied out of
 * `src/config/generated/fixtures/`, which authenticates against nothing.
 */
export function isSyntheticFixtureValue(name: string, value: string): boolean {
  return syntheticFixtureValuesFor(name).includes(value);
}

// ---------------------------------------------------------------------------
// Typed object-schema derivation
// ---------------------------------------------------------------------------

/** Contract keys whose `services` include `S`. */
export type KeysForService<S extends MaiaService> = {
  [K in ContractKey]: S extends (typeof ENV_CONTRACT)[K]['services'][number] ? K : never;
}[ContractKey];

/** Zod raw shape for the subset of the contract a service may read. */
export type ServiceShape<S extends MaiaService> = {
  [K in KeysForService<S>]: (typeof ENV_CONTRACT)[K]['schema'];
};

/**
 * Build the Zod object schema for one service. This is the ONLY place an
 * object schema is derived from the contract — runtime, Admin UI, migrator and
 * backup all go through it, which is what makes divergence impossible.
 *
 * Pure: returns a fresh schema, reads nothing.
 */
export function objectSchemaForService<S extends MaiaService>(
  service: S,
): z.ZodObject<ServiceShape<S>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const spec of entriesForService(service)) {
    shape[spec.name] = spec.schema;
  }
  return z.object(shape) as unknown as z.ZodObject<ServiceShape<S>>;
}
