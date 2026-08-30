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
  MAIA_BUILD_COMMIT: {
    name: 'MAIA_BUILD_COMMIT',
    description:
      'Commit desta build, injetado pelo pipeline de deploy. Vira provenance do manifesto de backup (issue #520), respondendo "qual código este artefato representa". Ausente = null no manifesto.',
    group: 'core',
    secret: false,
    services: ALL,
    schema: z.string().optional(),
    example: 'd93624b',
    fixture: 'd93624b',
    restartRequired: true,
    commentedInExample: true,
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

  // ---- database · migration runner (issue #516) --------------------------
  //
  // Os quatro tetos abaixo eram defaults de CALL SITE — `DEFAULT_LOCK_WAIT_MS`
  // e `DEFAULT_LOCK_POLL_MS` em `src/migrations/lock.ts`,
  // `DEFAULT_STATEMENT_LOCK_TIMEOUT_MS` em `src/migrations/runner.ts`, e o
  // `?? null` do `statementTimeoutMs`. Constante de módulo é um teto que só
  // muda com deploy: no incidente em que ele é curto demais (backfill legítimo
  // levando mais que o previsto) ou longo demais (migration segurando ACCESS
  // EXCLUSIVE), o operador não tem alavanca nenhuma. Aqui ele tem uma, e ela
  // passa por schema.
  //
  // Os defaults são EXATAMENTE os valores anteriores — mover para o contrato
  // não muda comportamento. Só o `migrator` os recebe: o runtime não migra.
  //
  // As constantes em `src/migrations/` continuam existindo e continuam sendo o
  // default da BIBLIOTECA (ela nunca lê `process.env`). Quem injeta a
  // configuração é o adaptador, `scripts/migrate.ts`, via
  // `migrationRunOptions()`.
  MIGRATION_LOCK_WAIT_MS: {
    name: 'MIGRATION_LOCK_WAIT_MS',
    description:
      'Quanto um segundo migrator espera pelo advisory lock global antes de desistir com `lock_unavailable` (issue #516). Ele NUNCA aplica nada sem o lock — o teto decide só quanto tempo ele tenta. Subir ajuda quando a migration do vencedor é longa e o perdedor é um deploy paralelo; descer devolve o container mais rápido.',
    group: 'database',
    secret: false,
    services: ['migrator'],
    schema: posInt(30_000),
    example: '30000',
    fixture: '30000',
    restartRequired: true,
    commentedInExample: true,
  },
  MIGRATION_LOCK_POLL_MS: {
    name: 'MIGRATION_LOCK_POLL_MS',
    description:
      'Intervalo entre tentativas de `pg_try_advisory_lock` enquanto o migrator espera (issue #516). O runner faz POLL em vez de bloquear dentro de `pg_advisory_lock` porque um backend bloqueado é invisível: com poll ele emite `migration.lock_wait`, respeita o prazo e é testável sem Postgres. Valores muito baixos viram round-trip à toa; muito altos atrasam a largada do perdedor depois que o vencedor termina.',
    group: 'database',
    secret: false,
    services: ['migrator'],
    schema: posInt(500),
    example: '500',
    fixture: '500',
    restartRequired: true,
    commentedInExample: true,
  },
  MIGRATION_LOCK_TIMEOUT_MS: {
    name: 'MIGRATION_LOCK_TIMEOUT_MS',
    description:
      '`SET lock_timeout` aplicado à sessão que roda cada migration (issue #516). Guarda o apagão clássico: o `ALTER TABLE` da migration entra na fila atrás de uma query longa e TODA query seguinte entra na fila atrás do pedido de lock dela. Falhar em 10s é recuperável; travar a tabela por minutos não é. `0` desliga (default do Postgres) e é fail-OPEN — use só com intenção.',
    group: 'database',
    secret: false,
    services: ['migrator'],
    schema: z.coerce.number().int().nonnegative().default(10_000),
    example: '10000',
    fixture: '10000',
    restartRequired: true,
    commentedInExample: true,
  },
  MIGRATION_STATEMENT_TIMEOUT_MS: {
    name: 'MIGRATION_STATEMENT_TIMEOUT_MS',
    description:
      '`SET statement_timeout` aplicado à sessão que roda cada migration (issue #516). Default `0` = SEM teto, e isso é deliberado: um backfill legítimo roda por minutos, e matar uma migration `-- maia:no-transaction` no meio FABRICA exatamente o dirty state que a #516 existe para evitar. Uma migration específica sobe o próprio teto com `-- maia:statement-timeout=<ms>`, onde o revisor vê; esta variável é o piso do ambiente.',
    group: 'database',
    secret: false,
    services: ['migrator'],
    schema: z.coerce.number().int().nonnegative().default(0),
    example: '0',
    fixture: '0',
    restartRequired: true,
    commentedInExample: true,
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
  REDIS_CONNECT_TIMEOUT_MS: {
    name: 'REDIS_CONNECT_TIMEOUT_MS',
    description:
      'Quanto o boot espera pela conexão com o Redis antes de FALHAR FECHADO (issue #512). Redis é dependência obrigatória (BullMQ, dedup, debouncer, working memory, rate limit): `ensureRedisConnect()` não engole mais a falha — sem conexão o processo não anuncia readiness e sai com erro.',
    group: 'redis',
    secret: false,
    services: ['runtime'],
    schema: posInt(10_000),
    example: '10000',
    fixture: '10000',
    restartRequired: true,
    commentedInExample: true,
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
  LLM_TURN_DEADLINE_MS: {
    name: 'LLM_TURN_DEADLINE_MS',
    description:
      'Orçamento wall-clock TOTAL (ms) de uma chamada de LLM quando o caller não declara um deadline: cobre todas as tentativas, backoff, fallback e parsing. Instante absoluto, nunca reiniciado a cada retry (issue #508). O caller pode passar um deadline mais curto; nunca um mais longo na prática, já que o gateway usa o menor tempo restante.',
    group: 'llm',
    secret: false,
    services: ['runtime'],
    schema: posInt(120000),
    example: '120000',
    fixture: '120000',
    restartRequired: true,
    commentedInExample: true,
  },
  LLM_DAILY_BUDGET_USD: {
    name: 'LLM_DAILY_BUDGET_USD',
    description:
      'Teto de gasto diário de LLM por tenant+agent, em USD. Imposto no LLM Gateway ANTES de qualquer requisição ao provider (issue #508); estouro rejeita a chamada com erro não retentável. 0 desliga a quota.',
    group: 'llm',
    secret: false,
    services: ['runtime'],
    schema: z.coerce.number().nonnegative().default(0),
    example: '0',
    fixture: '0',
    restartRequired: true,
    commentedInExample: true,
  },
  LLM_CIRCUIT_MODE: {
    name: 'LLM_CIRCUIT_MODE',
    description:
      'Postura BASE do disjuntor de LLM (issue #534, decisão do owner na revisão): off | shadow | enforce. `shadow` (default) roda a máquina de estados inteira e mede o que faria, sem NUNCA recusar chamada; `enforce` recusa de fato; `off` desliga e não guarda estado. Promover para `enforce` só depois de uma passagem por staging com would_open/would_reject medidos. NÃO é o kill switch: mudar aqui exige restart. A alavanca de incidente, sem restart e sem deploy, é o override por Redis — ver docs/runbooks/operational.md §3.1.',
    group: 'llm',
    secret: false,
    services: ['runtime'],
    schema: z.enum(['off', 'shadow', 'enforce']).default('shadow'),
    example: 'shadow',
    fixture: 'shadow',
    // Honesto de propósito: `config` é congelado no boot, então trocar esta
    // variável só vale no próximo start. Marcar `false` aqui venderia como
    // alavanca quente algo que não é — e é exatamente essa confusão que o
    // override por Redis existe para não deixar acontecer.
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

  // ---- onboarding (decisão 13, #519) -------------------------------------
  // O domínio da saga (`src/onboarding/`) e do worker `onboarding_expirer`.
  // Estas chaves moravam em `governance`; o grupo é só o índice do operador
  // nos artefatos gerados, então mover NÃO altera schema, default,
  // `requiredIn` nem `services` de nenhuma delas — ver
  // `tests/unit/config/onboarding-group.spec.ts`.
  ONBOARDING_EXPIRER_BATCH_LIMIT: {
    name: 'ONBOARDING_EXPIRER_BATCH_LIMIT',
    description:
      'Teto de runs de onboarding vencidas expiradas por tick do worker onboarding_expirer. É trabalho limitado por tick, não vazão contratada: o backlog restante fica visível em maia_onboarding_expiry_backlog e drena nos ticks seguintes.',
    group: 'onboarding',
    secret: false,
    services: ['runtime'],
    schema: posInt(100),
    example: '100',
    fixture: '100',
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
  MAIA_OTLP_TRACES_ENDPOINT: {
    name: 'MAIA_OTLP_TRACES_ENDPOINT',
    description:
      'Endpoint OTLP/HTTP de traces (ex.: http://collector:4318/v1/traces). Vazio = exporter INERTE: nenhum span é amostrado, montado ou enviado, e o hot path fica idêntico ao anterior (#535).',
    group: 'alerts',
    secret: false,
    services: ['runtime'],
    schema: z.string().url().optional(),
    example: 'http://otel-collector:4318/v1/traces',
    // The fixture only has to SATISFY the schema (it is never booted — see
    // `scripts/config.ts`); the unit suite runs with the variable unset, which
    // is the inert state the exporter is designed around.
    fixture: 'http://localhost:4318/v1/traces',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_OTLP_TRACES_HEADERS: {
    name: 'MAIA_OTLP_TRACES_HEADERS',
    description:
      'Headers extras do exporter OTLP no formato k=v,k=v (tipicamente autenticação do collector). Segredo — nunca aparece em log nem em /metrics.',
    group: 'alerts',
    secret: true,
    services: ['runtime'],
    schema: z.string().optional(),
    example: '__SET_ME__authorization=Bearer_xxx',
    // Carries the literal `fixture` so the `secret/synthetic-fixture` boot
    // check can flag it EXACTLY without a plausible real value becoming a
    // false positive (PR #522 review round 2).
    fixture: 'x-maia-fixture=fixture-not-a-real-credential',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_OTLP_SAMPLE_RATIO: {
    name: 'MAIA_OTLP_SAMPLE_RATIO',
    description:
      'Fração de turnos amostrados para OTLP (0..1). A decisão é DERIVADA do trace_id, então gateway e worker chegam ao mesmo veredito sem propagar bit de amostragem — um turno amostrado é amostrado inteiro.',
    group: 'alerts',
    secret: false,
    services: ['runtime'],
    schema: z.coerce.number().min(0).max(1).default(0.05),
    example: '0.05',
    fixture: '1',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_OTLP_SERVICE_NAME: {
    name: 'MAIA_OTLP_SERVICE_NAME',
    description: 'Valor de `service.name` no resource OTLP.',
    group: 'alerts',
    secret: false,
    services: ['runtime'],
    schema: z.string().default('maia-runtime'),
    example: 'maia-runtime',
    fixture: 'maia-runtime-test',
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

  // Issue #520 — backup VERIFICÁVEL. As variáveis acima descrevem o destino;
  // estas descrevem o que conta como sucesso. Não há `BACKUP_PROFILE`: o
  // profile da Maia é MAIA_ENV, e um segundo seletor de profile só para backup
  // seria uma segunda fonte de verdade. As regras fail-closed que consomem
  // estas variáveis vivem em src/config/rules.ts (grupo `backup/*`).
  BACKUP_ENABLED: {
    name: 'BACKUP_ENABLED',
    description:
      'Liga o backup. `false` é recusado no profile production — um deploy de produção sem backup não tem caminho de recuperação.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: boolFlag('true'),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_OFFSITE_REQUIRED: {
    name: 'BACKUP_OFFSITE_REQUIRED',
    description:
      'Exige cópia off-site VERIFICADA para uma run contar como sucesso. Ausente = o profile decide (production exige). `false` é recusado em production.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    // Tri-state DE PROPÓSITO: ausente ≠ false. Ausente delega ao profile;
    // `false` é uma decisão explícita do operador (e ilegal em production).
    schema: z
      .enum(['true', 'false', '1', '0'])
      .optional()
      .transform((s) => (s === undefined ? undefined : s === 'true' || s === '1')),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_ENCRYPTION_MODE: {
    name: 'BACKUP_ENCRYPTION_MODE',
    description:
      'Cifra do artefato: `none` ou `envelope_aes256_gcm` (client-side, antes de sair do host). `none` é recusado em production — o dump contém dados pessoais de todos os tenants.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: z.enum(['none', 'envelope_aes256_gcm']).default('none'),
    example: 'envelope_aes256_gcm',
    fixture: 'none',
    // A fixture de production TEM de satisfazer a regra backup/encryption-mode.
    fixtureByProfile: { production: 'envelope_aes256_gcm' },
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_ENCRYPTION_KEYRING: {
    name: 'BACKUP_ENCRYPTION_KEYRING',
    description:
      'Keyring JSON { key_id: base64(32B) } da cifra de backup. A chave vive FORA do artefato; rotação é aditiva (mantenha a chave antiga enquanto houver artefato que a referencie).',
    group: 'backup',
    secret: true,
    services: ['backup', 'maintenance', 'runtime'],
    schema: z.string().optional(),
    example: '__SET_ME__{"k1":"<base64 32 bytes>"}',
    // Sintética e inconfundível (mesma forma de MAIA_STAGING_KEYRING):
    // base64 de 32 bytes zerados, que não decifra nada de verdade.
    fixture: '{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
    requiredWhen: { var: 'BACKUP_ENCRYPTION_MODE', equals: 'envelope_aes256_gcm' },
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_ENCRYPTION_ACTIVE_KEY_ID: {
    name: 'BACKUP_ENCRYPTION_ACTIVE_KEY_ID',
    description:
      'Id da chave ATIVA dentro de BACKUP_ENCRYPTION_KEYRING. É um identificador, não material de chave — é o único campo de cifra que aparece em manifesto e auditoria.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: z.string().optional(),
    example: 'k1',
    fixture: 'k1',
    requiredWhen: { var: 'BACKUP_ENCRYPTION_MODE', equals: 'envelope_aes256_gcm' },
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_DUMP_TIMEOUT_MS: {
    name: 'BACKUP_DUMP_TIMEOUT_MS',
    description: 'Orçamento do pg_dump. Estourado, o processo é morto e a run falha.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: posInt(3_600_000),
    example: '3600000',
    fixture: '3600000',
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_UPLOAD_TIMEOUT_MS: {
    name: 'BACKUP_UPLOAD_TIMEOUT_MS',
    description: 'Orçamento do upload off-site.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: posInt(1_800_000),
    example: '1800000',
    fixture: '1800000',
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_RESTORE_TIMEOUT_MS: {
    name: 'BACKUP_RESTORE_TIMEOUT_MS',
    description: 'Orçamento do restore drill.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: posInt(3_600_000),
    example: '3600000',
    fixture: '3600000',
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_MIN_ARTIFACT_BYTES: {
    name: 'BACKUP_MIN_ARTIFACT_BYTES',
    description:
      'Piso de tamanho do artefato. Abaixo disso é dump truncado, não backup — tamanho sozinho nunca é evidência, mas um piso pega o caso grosseiro.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: posInt(4096),
    example: '4096',
    fixture: '4096',
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_RPO_TARGET_HOURS: {
    name: 'BACKUP_RPO_TARGET_HOURS',
    description:
      'Objetivo de ponto de recuperação. Abaixo de 24h é recusado: dump lógico noturno não cumpre, e a plataforma não anuncia objetivo que a arquitetura não honra (exigiria PITR/WAL).',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: posInt(24),
    example: '24',
    fixture: '24',
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_RTO_TARGET_MINUTES: {
    name: 'BACKUP_RTO_TARGET_MINUTES',
    description: 'Objetivo de tempo de recuperação, comparado à duração medida do último drill.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: posInt(120),
    example: '120',
    fixture: '120',
    restartRequired: true,
    commentedInExample: true,
  },
  BACKUP_RESTORE_DRILL_INTERVAL_HOURS: {
    name: 'BACKUP_RESTORE_DRILL_INTERVAL_HOURS',
    description:
      'Intervalo máximo entre drills de restore aprovados. Vencido, a readiness degrada — até um drill passar, nenhum artefato é sabidamente restaurável.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: posInt(168),
    example: '168',
    fixture: '168',
    restartRequired: true,
    commentedInExample: true,
  },
  RETENTION_DRY_RUN: {
    name: 'RETENTION_DRY_RUN',
    description:
      'Executor de retenção só CONTA, não apaga. Default `true` de propósito: exclusão é irreversível, então desligar isso é uma decisão explícita por ambiente. Só `false`/`0` desligam.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    // NÃO usa boolFlag: com boolFlag um valor inesperado (`yes`) viraria
    // `false` e LIGARIA a exclusão. Aqui qualquer coisa que não seja um
    // desligamento explícito mantém o dry-run.
    schema: z
      .string()
      .default('true')
      .transform((s) => !(s === 'false' || s === '0')),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
    commentedInExample: true,
  },
  RETENTION_POLICY: {
    name: 'RETENTION_POLICY',
    description:
      'Política de retenção APROVADA pelo jurídico/DPO, em JSON { version, approved_by, approved_at, classes: { <classe>: { retention_days } } }. Ausente ou malformada = nenhuma classe é purgável (o mecanismo conta, não apaga). Ver docs/architecture/concerns/data-retention-matrix.md.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    // Validada em profundidade por `parseRetentionPolicy`
    // (src/ops/retention/data-classes.ts), que devolve a política NÃO-APROVADA
    // em qualquer erro em vez de cair num default embutido.
    schema: z.string().optional(),
    example:
      '{"version":"v1-dpo-2026-07","approved_by":"<responsável jurídico>","approved_at":"2026-07-01T00:00:00.000Z","classes":{}}',
    fixture:
      '{"version":"v0-fixture","approved_by":"fixture-dpo","approved_at":"2026-01-01T00:00:00.000Z","classes":{}}',
    restartRequired: true,
    commentedInExample: true,
  },
  PRIVACY_EXPORT_TTL_DAYS: {
    name: 'PRIVACY_EXPORT_TTL_DAYS',
    description:
      'Vida útil do pacote cifrado de export de privacidade, em dias. Sete é a POLÍTICA INICIAL decidida pelo dono (issue #536); o DPO ajusta depois, e por isso o prazo é configuração e não constante no código. Vale no momento da EMISSÃO: o prazo fica carimbado em privacy_requests.export_expires_at e é ele que o varredor honra, para que um export já entregue não mude de prazo debaixo do titular.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    schema: posInt(7),
    example: '7',
    fixture: '7',
    restartRequired: true,
    commentedInExample: true,
  },
  PRIVACY_EXPORT_SWEEP_DRY_RUN: {
    name: 'PRIVACY_EXPORT_SWEEP_DRY_RUN',
    description:
      'Varredor do TTL do export só CONTA, não apaga. Default `false` — ao contrário de RETENTION_DRY_RUN, aqui a direção segura é EXECUTAR: o prazo de sete dias já é decisão tomada, e um varredor inerte deixa o pacote cifrado do titular no disco para sempre, que é o vazamento que o TTL fecha. Só `true`/`1` ligam o dry-run, então um valor inesperado mantém o varredor ativo.',
    group: 'backup',
    secret: false,
    services: ['runtime', 'backup', 'maintenance'],
    // NÃO usa boolFlag: com boolFlag um valor inesperado (`yes`) viraria
    // `true` num campo cujo `true` DESLIGA a proteção. A inversão aqui é
    // deliberada e é o espelho do comentário de RETENTION_DRY_RUN — nos dois
    // casos o valor inesperado cai no lado seguro, que é o oposto em cada um.
    schema: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    example: 'false',
    fixture: 'false',
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
    services: ['runtime', 'admin-ui'],
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
  FEATURE_OUTBOUND_DURABLE_COMMIT: {
    name: 'FEATURE_OUTBOUND_DURABLE_COMMIT',
    description:
      'Commit TRANSACIONAL da resposta do turno (issue #631, fatia B da #506). Default ON. ' +
      'ON: ao concluir a cognição, uma ÚNICA transação valida o claim_token do turno, insere o ' +
      'artefato outbound com a logical_dedupe_key, move o turno para outbound_pending e grava a ' +
      'auditoria — e SÓ DEPOIS do commit alguma coisa vai ao canal. Falha da transação IMPEDE o ' +
      'envio, com erro observável (maia_outbound_commit_rejected_total). EXIGE a migration 121 ' +
      'aplicada e FEATURE_TURN_STATE_MACHINE ligada (sem turno durável não há turn_id, e a FK ' +
      'composta da 121 torna a row inexprimível). ' +
      'OFF NÃO É CONFIGURAÇÃO SUPORTADA EM PRODUÇÃO — o boot é RECUSADO no profile production, ' +
      'porque desligar aqui restaura exatamente o caminho fail-open que a #506 documentou: envio ' +
      'ao canal sem registro durável. Fora de produção é a alavanca de rollback declarada. ' +
      'Ver docs/runbooks/turn-state-machine.md.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('true'),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_OUTBOUND_DELIVERY_WORKER: {
    name: 'FEATURE_OUTBOUND_DELIVERY_WORKER',
    description:
      'CONSUMIDOR da fila BullMQ `outbound-delivery` (issue #633, fatia D da #506). Default OFF. ' +
      'ON: o processo registra o worker que consome jobs de entrega — payload `{version:1, ' +
      'outbound_id}`, jobId DETERMINISTICO por outbound_id — resolve o escopo pela fronteira de ' +
      'confianca e chama o ciclo de entrega de #632 (claim atomico, lease, fence). ' +
      'NASCE DESLIGADA porque o CONSUMIDOR PRECEDE O PRODUTOR: ligue esta primeiro, confirme que ' +
      'a fila drena, e so entao ligue FEATURE_OUTBOUND_RECOVERY (que e quem enfileira). O ' +
      'inverso acumula jobs que ninguem consome. ' +
      'EXIGE a migration 131 aplicada e FEATURE_OUTBOUND_DURABLE_COMMIT ligada (sem linha ' +
      'duravel nao ha o que entregar). Ver docs/runbooks/outbound-recovery.md.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_OUTBOUND_RECOVERY: {
    name: 'FEATURE_OUTBOUND_RECOVERY',
    description:
      'VARREDURA de recuperacao, reconciliacao e DLQ do outbox duravel (issue #633, fatia D da ' +
      '#506). Default OFF. ' +
      'ON: a cada minuto o worker `outbound_recovery` rearma o trabalho entregavel (pending/' +
      'retryable vencidos e claims com lease morta), reconcilia o incerto (delivery_unknown, ' +
      'reconciling e a janela delivered->completed), manda para dead_letter o que estourou o teto ' +
      'de tentativas ou o prazo de reconciliacao, e detecta divergencia turno<->outbound nos dois ' +
      'sentidos. Publica maia_outbound_pending_age_seconds, ' +
      'maia_outbound_reconciliation_total{result} e maia_outbound_turn_inconsistency_total{kind}. ' +
      'OFF: o worker e NO-OP na primeira linha (nenhuma consulta ao banco) — e nada rearma o ' +
      'outbox, entao uma linha que falhe a entrega fica parada ate intervencao manual ' +
      '(`npm run dlq outbound-rearm`). ' +
      'EXIGE FEATURE_OUTBOUND_DELIVERY_WORKER ligada: a varredura ENFILEIRA, e sem consumidor os ' +
      'jobs se acumulam no Redis sem ninguem os processar. Ver docs/runbooks/outbound-recovery.md.',
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
  FEATURE_TURN_STATE_MACHINE: {
    name: 'FEATURE_TURN_STATE_MACHINE',
    description:
      'Máquina de estados durável do turno inbound (issue #503): agent_turns. ' +
      'EXIGE as migrations 096 e 097 APLICADAS — subir o processo com esta flag ligada antes de ' +
      '`npm run db:migrate` derruba todo o ingresso. Default ON. Com ' +
      'FEATURE_TURN_STATE_AUTHORITATIVE também ON (o default desde #504), agent_turns é a fonte ' +
      'de verdade do turno e `mensagens.processada_em` fica sendo apenas projeção de ' +
      'compatibilidade; com ela OFF a máquina roda em shadow e `processada_em` decide. ' +
      'OFF é ROLLBACK EMERGENCIAL, não configuração suportada — e desligar SÓ esta flag é ' +
      'recusado no boot, porque FEATURE_TURN_CLAIM e FEATURE_TURN_STATE_AUTHORITATIVE (ambas ON ' +
      'por default) ficariam inertes: desligue as três juntas. Nenhum turno já gravado é perdido. ' +
      'Ver docs/runbooks/turn-state-machine.md.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('true'),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_TURN_STREAM_KEY: {
    name: 'FEATURE_TURN_STREAM_KEY',
    description:
      'Identidade de STREAM e sequência de ingresso do turno (issue #505, fases 1–2 do rollout: ' +
      'SHADOW). EXIGE as migrations 118 e 119 APLICADAS. Default ON e apenas ESCRITA: as colunas ' +
      'stream_key/stream_key_version/ingress_seq (mensagens) e stream_key/first_ingress_seq/' +
      'last_ingress_seq (agent_turns) passam a ser preenchidas, e NADA as lê para decidir — o ' +
      'head-of-line, a exclusão por stream e o debounce transacional são fases posteriores. ' +
      'A ÚNICA mudança de comportamento observável: um ingresso cuja identidade de stream não ' +
      'pode ser derivada com segurança (tenant/agent/canal/identidade remota ausentes, ou o ' +
      "literal 'default') passa a ser RECUSADO e auditado (`stream_ingress_rejected`) em vez de " +
      'seguir — é a invariante MUST nº 2/nº 8, e a issue proíbe explicitamente agrupar esse ' +
      'ingresso numa stream genérica. Em produção esse caso já era fail-closed antes daqui: todo ' +
      'ramo não-lançante de resolveChannel devolve channel_id. Kill switch: false volta a ' +
      'persistir sem stream (colunas NULL) sem perder as sequências já alocadas — mas a stream ' +
      'retomada continua de onde parou, então religar NÃO reordena nada. ' +
      'Ver docs/runbooks/turn-state-machine.md §8.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('true'),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_TURN_HEAD_OF_LINE: {
    name: 'FEATURE_TURN_HEAD_OF_LINE',
    description:
      'HEAD-OF-LINE como condição do claim (issue #626, fatia C da #505; fase 6 do rollout). ' +
      'EXIGE a migration 126 APLICADA e FEATURE_TURN_STREAM_KEY ligada — sem stream_key e ' +
      'first_ingress_seq gravados não existe ordem a impor, e a regra vira no-op silencioso. ' +
      'Default ON. ON: um turno só é reivindicável quando NÃO existe turno anterior não terminal ' +
      'na mesma stream (menor first_ingress_seq). Recusas tipadas: `not_head` (o anterior avança ' +
      'sozinho) e `stream_blocked` (o anterior está em outbound_pending e nenhum claim o move). ' +
      'A MESMA regra filtra os candidatos do recovery, para que o varredor não rearme um turno ' +
      'que o claim vai recusar. OFF é ROLLBACK EMERGENCIAL, não configuração suportada: o claim ' +
      'volta ao comportamento de #625 (qualquer turno elegível pode ser reivindicado, com no ' +
      'máximo um ATIVO por stream), e a plataforma volta a poder responder M2 antes de M1. ' +
      'Nenhum turno já gravado é perdido e religar não reordena nada — a ordem vem de ' +
      'first_ingress_seq, que continua sendo gravado nas duas posições. ' +
      'CUSTO CONHECIDO ao ligar: um head preso em estado não terminal segura a conversa inteira; ' +
      'vigie maia_stream_blocked_total{reason} e maia_stream_fifo_violation_total (sempre zero). ' +
      'Ver docs/runbooks/turn-state-machine.md §11.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('true'),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_TURN_STREAM_PROMOTION: {
    name: 'FEATURE_TURN_STREAM_PROMOTION',
    description:
      'PROMOÇÃO DO SUCESSOR quando o head-of-line chega a estado terminal (issue #627, fatia D ' +
      'da #505; fase 6 do rollout). EXIGE a migration 127 APLICADA (colunas promoted_at e ' +
      'promoted_by_turn_id) e FEATURE_TURN_HEAD_OF_LINE ligada. Default ON. ON: a MESMA transação ' +
      'que conclui um turno elege o próximo turno elegível da stream, persiste a decisão e só ' +
      'DEPOIS do commit sinaliza a BullMQ — a fila é wake-up, não fonte de verdade, e um crash ' +
      'entre o commit e o enqueue é reconciliado pelo varredor (promoted_at). Também re-arma o ' +
      'turno cujo claim expirado foi recuperado na transação do claim (#625), que sem isto ' +
      'esperava até STUCK_AFTER_MS (2 min) pelo varredor. Um worker STALE não promove ninguém: o ' +
      'fence do CAS terminal recusa a conclusão antes de a promoção rodar. ' +
      'OFF é ROLLBACK: a conclusão deixa de promover, a ordem CONTINUA correta (o head-of-line ' +
      'não depende disto) e a conversa volta a andar na cadência do varredor de recovery — ' +
      'latência, não inversão. Sem head-of-line a flag é INERTE de propósito: naquele regime ' +
      'nenhum job é recusado por posição, então não há fila a destravar. ' +
      'Vigie maia_stream_promotion_total{result} — `enqueue_failed` subindo sem `recovered` ' +
      'acompanhando é varredor parado, não promoção quebrada. ' +
      'Ver docs/runbooks/turn-state-machine.md §12.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('true'),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_TURN_STREAM_DEBOUNCE: {
    name: 'FEATURE_TURN_STREAM_DEBOUNCE',
    description:
      'DEBOUNCE TRANSACIONAL — a janela deixa de ser um timer em memória (issue #628, fatia E ' +
      'da #505; fase 7 do rollout). EXIGE a migration 130 APLICADA (colunas debounce_*) e ' +
      'FEATURE_TURN_HEAD_OF_LINE ligada — sem head-of-line um turno NÃO-cabeça pode ser ' +
      'reivindicado, e o fechamento do batch precisaria de fence sobre cada irmão em vez de ' +
      'poder confiar em que ninguém os executa. Default ON, e INERTE enquanto ' +
      'FEATURE_MESSAGE_DEBOUNCE estiver OFF (o default do repositório): sem debounce não há ' +
      'janela a tornar transacional. ' +
      'ON: a janela é uma LINHA do PostgreSQL, aberta na MESMA transação que persiste o ' +
      'ingresso e estendida na MESMA transação do ingresso seguinte; o prazo é comparado com ' +
      'now() do BANCO (nunca Date.now() de réplica); o fechamento é compare-and-swap sob o ' +
      'mutex da stream (a linha de agent_stream_sequences), então duas réplicas produzem um ' +
      'fechamento e zero; o batch é o PREFIXO CONTÍGUO de ingressos a partir do head, de modo ' +
      'que uma lacuna (mídia no meio da rajada) fecha o batch em vez de ser absorvida; e o ' +
      'wake-up sai do Redis para o varredor stream_debounce_closer, que reencontra a janela ' +
      'vencida depois de um reinício. ' +
      'OFF é ROLLBACK: volta o debounce em memória (BullMQ atrasada + chave no Redis), com as ' +
      'duas falhas conhecidas — réplicas podem fechar batches sobrepostos e um reinício perde ' +
      'a janela. Nenhuma mensagem é perdida em nenhuma das posições; janelas já abertas e não ' +
      'fechadas param de ser fechadas e os turnos voltam a ser rearmados pelo recovery por ' +
      'estado (até STUCK_AFTER_MS), um turno por mensagem, em ordem. ' +
      'Vigie maia_stream_debounce_batch_size (a distribuição do tamanho do batch) e ' +
      'maia_stream_debounce_close_total{result} — `stream_locked` constante é contenção de ' +
      'ingresso, `lost_race` constante é mais de um varredor do que a fila precisa. ' +
      'Ver docs/runbooks/turn-state-machine.md §13.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('true'),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_STRICT_TOOL_SCHEMAS: {
    name: 'FEATURE_STRICT_TOOL_SCHEMAS',
    description:
      'NÃO é uma flag inócua: muda o JSON Schema das tools ENTREGUE ao modelo e, ' +
      'portanto, como ele chama tools. ON (default, #509): schema estrito derivado ' +
      'do contrato Zod — campos, obrigatórios, enums, limites e descrições reais. ' +
      'OFF: volta o stub genérico {type:object, additionalProperties:true}. Só afeta ' +
      'o que o modelo é INFORMADO — a revalidação Zod no dispatcher e todos os gates ' +
      'de grant/permissão/limite/aprovação seguem ativos nas duas posições, então ' +
      'desligar nunca amplia o que uma tool pode fazer. Lever de rollback temporária; ' +
      'remover junto com o branch legado em src/tools/_registry.ts.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('true'),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_TURN_CLAIM: {
    name: 'FEATURE_TURN_CLAIM',
    description:
      'Claim ATÔMICO do turno com lease e fencing (issue #504). Default ON — inclusive no PRIMEIRO ' +
      'deploy de produção. ON: antes de executar, o worker exige um claim atômico no PostgreSQL, ' +
      'renova lease por heartbeat e TODA gravação da tentativa passa a exigir o claim_token ' +
      'vigente; perder a lease cancela a tentativa em vez de concluí-la. EXIGE a migration 114 ' +
      'aplicada e FEATURE_TURN_STATE_MACHINE ligada (sem a máquina de estados não há turno a ' +
      'reivindicar). OFF é ROLLBACK EMERGENCIAL, não configuração suportada: o runtime volta ao ' +
      'claim apenas de ESTADO de #503, que NÃO é exclusão mútua — duas réplicas voltam a poder ' +
      'processar o mesmo turno e as gravações deixam de carregar fence. Nenhum claim já gravado é ' +
      'perdido. Ver docs/runbooks/turn-state-machine.md §6.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('true'),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_TURN_JOB_V2: {
    name: 'FEATURE_TURN_JOB_V2',
    description:
      'PRODUTOR do payload V2 do job de turno (issue #504 §Contrato do job). OFF (default): ' +
      'enqueueAgent arma o payload V1 legado ({mensagem_id, turn_id?, correlação}) — o consumidor ' +
      'já lê os DOIS formatos desde esta issue, então ligar aqui é o passo 5 do rollout e nunca o ' +
      'primeiro. ON: quando o produtor conhece o turno, o payload passa a ser exatamente ' +
      '{version: 2, turn_id} e mais nada; o worker redescobre tenant, agent e mensagem no ' +
      'PostgreSQL pelo resolvedor de escopo (src/runtime/turns/scope-resolver.ts). ' +
      'ORDEM OBRIGATÓRIA: só ligue depois que TODAS as réplicas de consumo estiverem no build que ' +
      'entende V2 — um worker antigo recebendo V2 não acha mensagem_id e falha o job. ' +
      'EXIGE FEATURE_TURN_STATE_MACHINE ligada (sem turno durável não há turn_id a transportar). ' +
      'CUSTO CONHECIDO: o payload V2 não carrega received_at_ms/enqueued_at_ms/trace_id; o ' +
      'consumidor os recompõe do banco, então maia_queue_wait_ms passa a medir agent_turns.queued_at ' +
      'em vez do carimbo do produtor. Kill switch: false volta a armar V1 no próximo enqueue. ' +
      'Ver docs/runbooks/turn-state-machine.md §7.',
    group: 'feature-flags',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  FEATURE_TURN_STATE_AUTHORITATIVE: {
    name: 'FEATURE_TURN_STATE_AUTHORITATIVE',
    description:
      'Flip da LEITURA da máquina de estados do turno (issue #503): o recovery elege candidatos ' +
      'por agent_turns.status em vez de processada_em IS NULL. Default ON — numa produção ' +
      'greenfield não existe histórico a backfillar, e é o ÚNICO modo em que um turno `retryable` ' +
      '(timeout de reasoner, falha pre-send do outbound) volta para a fila; com ele OFF esses ' +
      'turnos ficam invisíveis para o recovery. Também torna BLOQUEANTE a falha de escrita da ' +
      'máquina de estados (`TurnStateWriteError`), como exige "PostgreSQL é a fonte de verdade". ' +
      'Exige FEATURE_TURN_STATE_MACHINE ligada e, numa base COM histórico, o backfill concluído ' +
      '(`npm run backfill:turns`) e maia_turn_legacy_projection_mismatch_total estável. ' +
      'OFF é ROLLBACK EMERGENCIAL: devolve a decisão a `mensagens.processada_em` e volta a ' +
      'fail-soft. Ver docs/runbooks/turn-state-machine.md §2.',
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
  FEATURE_RUNTIME_TRACE_V1: {
    name: 'FEATURE_RUNTIME_TRACE_V1',
    description:
      'Liga o runtime trace durável no hot path (#514). Default OFF: com a flag desligada o caminho do turno é idêntico ao anterior e o HMAC master secret não é exigido. Ligar em canário — ver docs/runbooks/observability-slo.md.',
    group: 'runtime-trace',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_STRICT_METRIC_LABELS: {
    name: 'MAIA_STRICT_METRIC_LABELS',
    description:
      'Promove violação da política de labels de métrica (PII / alta cardinalidade) a exceção em vez de descarte silencioso (#514). Para suíte de testes e diagnóstico; em produção o sanitizer já descarta sem lançar.',
    group: 'runtime-trace',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
    restartRequired: true,
    commentedInExample: true,
  },
  RUNTIME_TRACE_HMAC_KEY_VERSION: {
    name: 'RUNTIME_TRACE_HMAC_KEY_VERSION',
    description: 'Versão da chave HMAC em uso (rotação a cada 90d).',
    group: 'runtime-trace',
    secret: false,
    services: ['runtime', 'admin-ui'],
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
    services: ['runtime', 'admin-ui'],
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
    services: ['runtime', 'admin-ui'],
    schema: z.string().optional(),
    example: '__SET_ME__1=<segredo-anterior>',
    fixture: '1=fixture-runtime-trace-prev-secret-0000',
    restartRequired: true,
    commentedInExample: true,
  },
  RUNTIME_TRACE_ACCEPT_SIGNATURE_V1: {
    name: 'RUNTIME_TRACE_ACCEPT_SIGNATURE_V1',
    description:
      'Aceita envelopes de runtime trace com `signature_version=1` na LEITURA (#535). Default `true`: produção só escreve v2, mas fixtures e ambientes que já têm linhas v1 precisam continuar recebendo veredito real de integridade. Com `false`, uma linha v1 lê `rejected_version` — distinto de `invalid`, porque a assinatura pode ser genuína. Ligue `false` no ambiente que comprovadamente não tem linha v1: a v1 deixa `root_trace_id`/`attempt` fora da assinatura.',
    group: 'runtime-trace',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('true'),
    example: 'true',
    fixture: 'true',
    restartRequired: false,
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
  TURN_LEASE_TTL_MS: {
    name: 'TURN_LEASE_TTL_MS',
    description:
      'Validade (ms) da lease do claim do turno (#504). É o tempo MÁXIMO que um turno fica preso ' +
      'depois de o worker dono morrer sem aviso — mais curto recupera antes, e mais longo tolera ' +
      'melhor uma pausa de GC ou um provedor lento. Curto demais produz takeover FALSO, que é ' +
      'execução dupla; por isso deve ficar confortavelmente acima da duração p99 de um turno ' +
      'quando somado ao heartbeat. Relação com TURN_LEASE_HEARTBEAT_MS validada no boot.',
    group: 'performance',
    secret: false,
    services: ['runtime'],
    schema: posInt(60_000),
    example: '60000',
    fixture: '60000',
    restartRequired: true,
    commentedInExample: true,
  },
  TURN_LEASE_HEARTBEAT_MS: {
    name: 'TURN_LEASE_HEARTBEAT_MS',
    description:
      'Intervalo (ms) entre renovações da lease do turno (#504). DEVE caber ao menos três vezes ' +
      'em TURN_LEASE_TTL_MS — com duas, uma única renovação perdida já deixa a lease vencer e o ' +
      'turno é tomado por outro worker enquanto o dono ainda está processando. A regra ' +
      'cross-field turn-lease/heartbeat-ratio recusa o boot quando a relação é insegura.',
    group: 'performance',
    secret: false,
    services: ['runtime'],
    schema: posInt(15_000),
    example: '15000',
    fixture: '15000',
    restartRequired: true,
    commentedInExample: true,
  },
  TURN_POISON_BLOCK_CATEGORIES: {
    name: 'TURN_POISON_BLOCK_CATEGORIES',
    description:
      'POLÍTICA DE POISON/DLQ por CATEGORIA DE ERRO (issue #629, fatia F da #505; fase 8 do ' +
      'rollout). EXIGE a migration 133 APLICADA (tabela agent_stream_blocks) — sem ela toda ' +
      'conclusão de turno envenenado falha, porque o INSERT do bloqueio referencia uma tabela ' +
      'inexistente. Lista separada por vírgula das categorias em que ESGOTAR TENTATIVAS deve ' +
      'BLOQUEAR a conversa para intervenção humana, em vez de dead-letter que LIBERA o próximo ' +
      'turno. Categorias válidas: effect_committed, model, transport, infrastructure, operator, ' +
      'unknown (espelho de POISON_CATEGORIES em src/runtime/turns/poison-policy.ts; uma ' +
      'categoria desconhecida REPROVA o boot em vez de ser ignorada, porque silenciá-la faria o ' +
      'operador acreditar ter ligado o bloqueio). ' +
      'Default `effect_committed`, e a escolha é o núcleo da issue-mãe: as duas saídas são ' +
      'defensáveis e INCOMPATÍVEIS — liberar preserva disponibilidade às custas da semântica ' +
      '(a plataforma responde M2 sem nunca ter respondido M1), bloquear preserva a semântica às ' +
      'custas da conversa (nada anda até alguém olhar). effect_committed é a única categoria em ' +
      'que a conversa já está semanticamente quebrada ANTES de a política decidir: uma tool ' +
      'irreversível rodou e o turno falhou depois. As demais têm causa COMPARTILHADA e ' +
      'transitória — um incidente de LLM ou de rede que bloqueasse pararia milhares de conversas ' +
      'de uma vez, com desbloqueio manual uma a uma. ' +
      'LISTA VAZIA é o KILL SWITCH da fatia: nenhum bloqueio NOVO nasce e a conclusão volta ao ' +
      'comportamento da #627. Ela NÃO desfaz bloqueios existentes — quem os desfaz é ' +
      '`npm run dlq -- unblock`, que é operação auditada. ' +
      'Vigie maia_stream_blocked_total{reason="stream_poisoned"} (sobe e NÃO volta sozinha: ' +
      'cada ponto é uma tentativa contra uma conversa que nenhum worker vai destravar) e ' +
      'maia_stream_poisoned_streams (o gauge de quantas conversas estão interditadas agora). ' +
      'Ver docs/runbooks/turn-state-machine.md §14.',
    group: 'governance',
    secret: false,
    services: ['runtime'],
    // A validação do CONTEÚDO é aqui, e não em `parsePoisonBlockCategories`,
    // porque o boot é o único momento em que o operador ainda pode corrigir a
    // digitação. `parsePoison…` também lança — defesa em profundidade, para o
    // caso de a lista chegar por um caminho que não passou pelo contrato.
    schema: z
      .string()
      .default('effect_committed')
      .refine(
        (raw) =>
          raw
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s.length > 0)
            .every((s) =>
              [
                'effect_committed',
                'model',
                'transport',
                'infrastructure',
                'operator',
                'unknown',
              ].includes(s),
            ),
        {
          message:
            'categorias válidas: effect_committed, model, transport, infrastructure, operator, ' +
            'unknown (lista separada por vírgula; vazia desliga o bloqueio)',
        },
      ),
    example: 'effect_committed',
    fixture: 'effect_committed',
    restartRequired: true,
    commentedInExample: true,
  },
  TURN_STREAM_STARVATION_AFTER_MS: {
    name: 'TURN_STREAM_STARVATION_AFTER_MS',
    description:
      'A partir de quantos ms um head-of-line parado conta como STARVATION (issue #629). É o ' +
      'limiar de maia_stream_starvation_total e do gauge maia_stream_head_age_seconds — não ' +
      'muda comportamento nenhum do escalonador, só o ponto em que a plataforma passa a AFIRMAR ' +
      'que uma conversa está sendo preterida. Default 300000 (5 min), que é folgado de ' +
      'propósito: STUCK_AFTER_MS do varredor é 2 min e o backoff de retry vai a 15 min, então um ' +
      'limiar abaixo de 5 min contaria como starvation um backoff legítimo em aberto — e uma ' +
      'métrica de fairness que dispara com o retry funcionando é uma métrica que o plantão ' +
      'aprende a ignorar. Ver docs/runbooks/turn-state-machine.md §14.4.',
    group: 'performance',
    secret: false,
    services: ['runtime'],
    schema: posInt(300_000),
    example: '300000',
    fixture: '300000',
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

  // ---- lifecycle do processo (issue #512) --------------------------------
  MAIA_PROCESS_ROLE: {
    name: 'MAIA_PROCESS_ROLE',
    description:
      'Qual fatia da topologia ESTE processo executa: all | api | worker | scheduler | session-owner. O papel decide o que o boot INICIA e o que o /readyz EXIGE, então um processo worker nunca fica fora de rotação por causa do WhatsApp, e um api-only nunca anuncia readiness por conseguir falar com o Redis. `all` é o modo compatível de processo único que roda hoje; os demais existem para a separação de topologia (issue #513). Contrato em src/runtime/lifecycle/roles.ts.',
    group: 'lifecycle',
    secret: false,
    services: ['runtime'],
    // Fail-closed por construção: valor fora do enum é erro de schema e aborta
    // o boot — nunca cai num default permissivo.
    schema: z.enum(['all', 'api', 'worker', 'scheduler', 'session-owner']).default('all'),
    example: 'all',
    fixture: 'all',
    restartRequired: true,
  },
  // Issue #513 §5 — o que SUBSTITUI `phase: number` como mecanismo.
  MAIA_SCHEDULER_GROUPS: {
    name: 'MAIA_SCHEDULER_GROUPS',
    description:
      'Grupos de jobs de cron que ESTE processo agenda, separados por vírgula, ou `all` para todos. Vazio = o conjunto default, que reproduz exatamente o comportamento do antigo `startWorkers(1)`: turn-pipeline, outbound, scheduling, channel, monitoring, housekeeping, ops-backup. Os grupos console, cognition, procedures, proactive e governance nascem DESLIGADOS — eram os jobs que `phase > 1` descartava em silêncio, e ligá-los é uma decisão de operação (proactive, em particular, ESCREVE para o usuário). Nome desconhecido é ERRO de boot, nunca um grupo ignorado. Inventário completo e classificação de concorrência de cada job: src/workers/job-contract.ts e docs/architecture/modules/workers.md.',
    group: 'lifecycle',
    secret: false,
    services: ['runtime'],
    schema: z.string().default(''),
    example: 'turn-pipeline,outbound,scheduling,channel,monitoring,housekeeping,ops-backup',
    fixture: 'turn-pipeline,outbound,scheduling,channel,monitoring,housekeeping,ops-backup',
    restartRequired: true,
    commentedInExample: true,
  },
  SHUTDOWN_GRACE_MS: {
    name: 'SHUTDOWN_GRACE_MS',
    description:
      'Orçamento TOTAL do drain depois do SIGTERM: ticks de cron em execução, jobs BullMQ ativos e tarefas de background rastreadas. Precisa ser MENOR que o timeout de kill do supervisor (systemd TimeoutStopSec / compose stop_grace_period, hoje 40s), senão o SIGKILL corta o drain no meio.',
    group: 'lifecycle',
    secret: false,
    services: ['runtime'],
    schema: posInt(25_000),
    example: '25000',
    fixture: '25000',
    restartRequired: true,
    commentedInExample: true,
  },
  SHUTDOWN_STEP_TIMEOUT_MS: {
    name: 'SHUTDOWN_STEP_TIMEOUT_MS',
    description:
      'Teto por PASSO do shutdown, para que um componente travado (um socket que não fecha) não consuma o orçamento inteiro. Também limita a espera pela fase de boot em voo; se essa espera estoura, o drain é marcado incompleto e o processo sai forçado.',
    group: 'lifecycle',
    secret: false,
    services: ['runtime'],
    schema: posInt(10_000),
    example: '10000',
    fixture: '10000',
    restartRequired: true,
    commentedInExample: true,
  },
  SHUTDOWN_EXIT_TIMEOUT_MS: {
    name: 'SHUTDOWN_EXIT_TIMEOUT_MS',
    description:
      'Rede de segurança APÓS um drain limpo. O processo sai naturalmente quando o event loop esvazia; este timer (unref) só dispara se algum handle vazado mantiver o loop vivo. Não é um process.exit prematuro — a saída natural sempre vence a corrida.',
    group: 'lifecycle',
    secret: false,
    services: ['runtime'],
    schema: posInt(5_000),
    example: '5000',
    fixture: '5000',
    restartRequired: true,
    commentedInExample: true,
  },
  SHUTDOWN_FORCED_EXIT_CODE: {
    name: 'SHUTDOWN_FORCED_EXIT_CODE',
    description:
      'Código de saída quando o drain termina INCOMPLETO (deadline estourado com trabalho em voo, segundo sinal, ou fase de boot que não cedeu). Distinto do 0 de um drain limpo, para o supervisor e o log distinguirem os dois casos.',
    group: 'lifecycle',
    secret: false,
    services: ['runtime'],
    schema: z.coerce.number().int().nonnegative().default(1),
    example: '1',
    fixture: '1',
    restartRequired: true,
    commentedInExample: true,
  },
  READINESS_CACHE_MS: {
    name: 'READINESS_CACHE_MS',
    description:
      'Janela de cache da avaliação de componentes do /readyz, para que um polling agressivo do load balancer não vire gerador de carga em DB/Redis. O ESTADO do lifecycle nunca é cacheado: o drain derruba o /readyz para 503 na requisição seguinte.',
    group: 'lifecycle',
    secret: false,
    services: ['runtime'],
    schema: z.coerce.number().int().nonnegative().default(2_000),
    example: '2000',
    fixture: '2000',
    restartRequired: true,
    commentedInExample: true,
  },
  READINESS_PROBE_TIMEOUT_MS: {
    name: 'READINESS_PROBE_TIMEOUT_MS',
    description:
      'Timeout por componente nas probes de readiness. Componente que não responde a tempo é reportado como `unknown` — o que é fail-closed para um componente obrigatório do papel.',
    group: 'lifecycle',
    secret: false,
    services: ['runtime'],
    schema: posInt(1_500),
    example: '1500',
    fixture: '1500',
    restartRequired: true,
    commentedInExample: true,
  },
  READINESS_SCHEMA_CHECK: {
    name: 'READINESS_SCHEMA_CHECK',
    description:
      'Liga o veredito canônico de schema (getSchemaReadiness, #516) nos DOIS gates: no BOOT e na readiness. No boot (ADR 0004) dirty state, checksum divergente, migration ausente e schema incompatível ENCERRAM o processo com exit code 90-98, específico da invariante; num processo já no ar as mesmas condições derrubam o /readyz para 503, e um veredito `unknown` também (fail-closed). Nenhum dos dois aplica migration — quem aplica é o job de migration. INVÁLIDO no profile production: `false` recusa o boot. Fora de production, desligue apenas onde código e schema são publicados fora de banda de propósito (é o que mantém um `npm run dev` vivo contra um banco desalinhado); isso é política explícita, não fallback silencioso.',
    group: 'lifecycle',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('true'),
    example: 'true',
    fixture: 'true',
    restartRequired: true,
    commentedInExample: true,
  },
  READINESS_BACKLOG_MAX: {
    name: 'READINESS_BACKLOG_MAX',
    description:
      'Shedding de capacidade opcional: reporta NÃO-pronto quando a fila do agente tem mais de N jobs esperando. Default 0 = DESLIGADO, deliberadamente — um limiar mal escolhido drena a frota inteira durante um pico legítimo e transforma backlog em outage. Ligue por ambiente depois de conhecer o formato normal do backlog.',
    group: 'lifecycle',
    secret: false,
    services: ['runtime'],
    schema: z.coerce.number().int().nonnegative().default(0),
    example: '0',
    fixture: '0',
    restartRequired: true,
    commentedInExample: true,
  },
  READINESS_REQUIRE_WHATSAPP_LIVE: {
    name: 'READINESS_REQUIRE_WHATSAPP_LIVE',
    description:
      'Readiness estrita de WhatsApp. Default false: uma sessão JÁ estabelecida que está reconectando reporta `degraded` e a instância PERMANECE em rotação, porque queda de socket Baileys é rotina e travar nisso faz a readiness flapar. Ligue onde capacidade de canal e capacidade de API precisam ser o mesmo sinal. Não afeta o cold start: antes do primeiro `open` a instância nunca fica pronta, com a flag ligada ou não.',
    group: 'lifecycle',
    secret: false,
    services: ['runtime'],
    schema: boolFlag('false'),
    example: 'false',
    fixture: 'false',
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

  // ---- pedidos de ferramenta (issues da triagem) -------------------------
  //
  // #638 (fatia C da épica #471). As duas variáveis do efeito EXTERNO da
  // triagem: para onde a issue vai, e com que credencial.
  //
  // O DESTINO é lido pelos dois serviços; a CREDENCIAL, só pelo `runtime`. Essa
  // assimetria é a defesa central do critério "credencial do GitHub não vaza
  // para o payload da proposta nem para log". O botão "aceitar" é servido pelo
  // `admin-ui`, que valida o PRÓPRIO subset no boot: um token fora do subset
  // dele não é lido, não é tipado e não existe naquele processo. O console
  // reserva a linha (e precisa dizer ao dono para onde a issue vai, por isso
  // conhece o repositório); quem fala com o GitHub é o relayer do `runtime`. A
  // separação é estrutural, não é disciplina —
  // `tests/unit/tool-request-credencial.spec.ts` a afirma contra o contrato.
  MAIA_TOOL_REQUEST_ISSUE_REPO: {
    name: 'MAIA_TOOL_REQUEST_ISSUE_REPO',
    description:
      'Repositório GitHub "owner/repo" onde a triagem de pedidos de ferramenta abre issues. Ausente = o aceite é recusado com motivo explícito (nada de destino implícito para efeito externo).',
    group: 'tool-requests',
    secret: false,
    services: ['runtime', 'admin-ui'],
    schema: z
      .string()
      .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'formato esperado: owner/repo')
      .optional(),
    example: 'minha-org/meu-repo',
    fixture: 'maia-fixture/maia-fixture',
    restartRequired: true,
    commentedInExample: true,
  },
  MAIA_TOOL_REQUEST_GITHUB_TOKEN: {
    name: 'MAIA_TOOL_REQUEST_GITHUB_TOKEN',
    description:
      'Token do GitHub usado SOMENTE pelo relayer de pedidos de ferramenta (escopo mínimo: abrir issue no repositório acima). Não é lido pelo Admin UI — o console reserva o aceite, o runtime faz a chamada.',
    group: 'tool-requests',
    secret: true,
    services: ['runtime'],
    schema: z.string().optional(),
    example: '__SET_ME__tool_request_github_token',
    fixture: 'fixture-tool-request-token',
    requiredWhen: { var: 'MAIA_TOOL_REQUEST_ISSUE_REPO', present: true },
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

/**
 * TODA variável do contrato, já PARSEADA — a união dos subsets de serviço.
 *
 * É a forma de `contractEnv` (`src/config/contract-env.ts`), o acessor que os
 * módulos COMPARTILHADOS entre containers usam. Um módulo que o runtime e o
 * console carregam (`src/db/client.ts`, `src/lib/logger.ts`, ...) não pertence
 * a um serviço só, então não há subset correto para tipá-lo: o tipo aqui é o
 * contrato inteiro, e quem decide o que cada CONTAINER precisa continua sendo o
 * loader do serviço (`loadServiceConfig`), no boot.
 */
export type ContractValues = {
  readonly [K in ContractKey]: z.infer<(typeof ENV_CONTRACT)[K]['schema']>;
};

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
