// ESLint v9 flat config. The package.json was on v9.14 but had no config file,
// so `npm run lint` was crashing pre-merge. This sets up the standard
// @typescript-eslint v8 + base eslint:recommended for src/ TypeScript only.
//
// Keep the rule set lean — the suite already runs typecheck (tsc) and unit
// tests, so lint is here mainly to catch unused vars, unsafe `any`, and the
// usual style smells.
//
// `no-floating-promises` is enabled at warn level for src/ only, via the
// type-aware parser (`projectService: true`). Promises that go un-awaited
// silently fail in Node, so this is a high-value rule. Scripts/ are kept on
// the lighter parser because tsconfig.json includes only src/, and pulling
// scripts/ into the type-aware project would force tsc to compile them
// (they run via tsx, not via dist) — see the scripts block below. tests/
// also stays off the rule: Vitest specs deliberately fire-and-forget in
// some `beforeEach`/`afterAll` hooks. Other heavy type-aware rules
// (strict-boolean, no-unsafe-*) stay off pending a follow-up.

import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

// Globals are split into two sets: Node-runtime globals (used everywhere)
// and Vitest globals (only for tests/). Keeping them separate means a stray
// `describe(...)` inside src/ raises `no-undef` instead of silently passing.
const NODE_GLOBALS = {
  process: 'readonly',
  Buffer: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  global: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortSignal: 'readonly',
  AbortController: 'readonly',
  fetch: 'readonly',
  BigInt: 'readonly',
};

const VITEST_GLOBALS = {
  describe: 'readonly',
  it: 'readonly',
  expect: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
  beforeAll: 'readonly',
  afterAll: 'readonly',
  vi: 'readonly',
};

// Fase 0 do roteamento multi-linha (spec 2026-07-09 §1.6) — LINT GATE da
// fronteira única de saída: fora de src/gateway/, NINGUÉM importa as
// primitivas físicas de envio de baileys.ts/presence.ts. Todo envio passa por
// `LineOutput` (src/gateway/line-output.ts), que valida o triplete
// (tenant, agent, channel) fail-closed. Imports não-restritos (MEDIA_ROOT,
// isBaileysConnected, quotedReplyContext, tipos) continuam livres.
// NOTA flat-config: o ÚLTIMO bloco que configura uma regra para um arquivo
// VENCE (não há merge) — por isso os paths abaixo são repetidos no bloco
// P8e (agent/cognition), que também configura no-restricted-imports.
const RESTRICTED_SEND_IMPORT_PATHS = [
  {
    name: '@/gateway/baileys.js',
    importNames: ['sendOutboundText', 'sendOutboundDocument', 'sendOutboundVoice'],
    message:
      'Fronteira única de saída (spec roteamento §1.6): use LineOutput via forChannel/forCurrentAgentChannel (@/gateway/line-output.js) — nunca as primitivas físicas.',
  },
  {
    name: '@/gateway/presence.js',
    importNames: ['sendPoll', 'sendReaction', 'startTyping', 'markRead'],
    message:
      'Fronteira única de saída (spec roteamento §1.6): use LineOutput via forChannel/forCurrentAgentChannel (@/gateway/line-output.js) — nunca as primitivas físicas.',
  },
];

// Issue #508 — LINT GATE da fronteira única de LLM. Fora de
// `src/lib/llm/providers/**`, NINGUÉM importa SDK de provider generativo:
// toda chamada de chat/classificação/visão passa pelo gateway
// (`@/lib/llm/index.js`), que é quem resolve provider/modelo, aplica
// deadline, cancelamento, retry, fallback, orçamento, custo e métrica.
//
// Sem esta regra, o bypass é trivial (`new Anthropic({...})` em qualquer
// módulo) e foi exatamente assim que 13 call sites acabaram fora da
// contabilidade de custo e ignorando o `LLM_PROVIDER` configurado.
//
// A regra entra direto como `error` (e não como warning, como sugeria o
// rollout da issue) porque o sweep pós-migração já está limpo — não há
// resíduo para tolerar, só novos bypasses para impedir.
const RESTRICTED_LLM_SDK_PATTERNS = [
  {
    group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*', 'openai', 'openai/*'],
    message:
      'Fronteira única de LLM (issue #508): use o gateway (@/lib/llm/index.js → executeLLM) ou o facade callLLM (@/lib/claude.js). SDK de provider só é permitido em src/lib/llm/providers/**.',
  },
];

const TS_RULES = {
  ...tsPlugin.configs.recommended.rules,

  // Disable base no-unused-vars in favour of the TS-aware version
  'no-unused-vars': 'off',
  // Same story for no-redeclare: the base rule trips on the
  // `export const Foo = {...}` + `export type Foo = ...` enum-shaped
  // objects we use in src/types/enums.ts. The TS-aware variant
  // understands the namespace merge and skips the false positive.
  'no-redeclare': 'off',
  '@typescript-eslint/no-redeclare': 'warn',
  '@typescript-eslint/no-unused-vars': [
    'warn',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      ignoreRestSiblings: true,
    },
  ],

  // Allow `any` for now — there are deliberate `unknown`-bridge casts and
  // some external lib boundaries. Tighten later if the team wants.
  '@typescript-eslint/no-explicit-any': 'warn',

  // Empty catch blocks are common at config/cleanup boundaries.
  '@typescript-eslint/no-empty-object-type': 'off',
  'no-empty': ['warn', { allowEmptyCatch: true }],

  // Already enforced by tsc
  'no-undef': 'off',

  // Use the TS-aware variant: `const X = {} as const; type X = ...` is the
  // canonical TS pattern for "enum-shaped" objects, and lives in separate
  // namespaces (value vs. type). Base `no-redeclare` flags it as conflict,
  // `@typescript-eslint/no-redeclare` understands the namespaces.
  'no-redeclare': 'off',
  '@typescript-eslint/no-redeclare': 'error',

  // Allow re-assigning function args (common in patch-style helpers)
  'no-param-reassign': 'off',

  // Prefer const, but warn instead of error so refactors don't block CI
  'prefer-const': 'warn',
};

export default [
  // Global ignores
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'backups/**',
      '.baileys-auth/**',
      'media/**',
      'tmp-*/**',
      '.tmp-*.py',
      '.claude/**',
      // Next.js build artifacts (admin-ui). The dev `next build` produces
      // .next/{static,standalone,server}/*.js bundles that ESLint shouldn't
      // try to type-check. next-env.d.ts is generated too (gitignored): Next
      // 15.5 emits a triple-slash reference in it that trips
      // @typescript-eslint/triple-slash-reference.
      'src/admin-ui/.next/**',
      'src/admin-ui/next-env.d.ts',
    ],
  },

  // Base recommended for all JS/TS
  js.configs.recommended,

  // TypeScript source files (NO test globals — using vi/describe/it here
  // should fail with no-undef instead of silently passing).
  // Type-aware parser (projectService) enables no-floating-promises for src/.
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: NODE_GLOBALS,
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...TS_RULES,
      '@typescript-eslint/no-floating-promises': 'warn',
    },
  },

  // P8e Architecture Lock (enforced as ESLint rule, not just CI grep):
  // src/agent/ and src/cognition/ must NEVER import @/control-plane/policy
  // directly. They consume via slice builders (P8d) or PEPs (P9b/d).
  // Adversarial review #93 flagged that the grep gate is bypassable; this
  // rule makes the lock part of `npm run lint`.
  {
    files: ['src/agent/**/*.ts', 'src/cognition/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // Fase 0 lint gate — repetido aqui porque este bloco SOBRESCREVE a
          // config da regra para agent/cognition (flat config não faz merge).
          paths: RESTRICTED_SEND_IMPORT_PATHS,
          patterns: [
            {
              group: ['@/control-plane/policy', '@/control-plane/policy/*'],
              message:
                'Architecture Lock (P8e): agent/cognition MUST NOT import the policy module directly. Use a slice builder (P8d) or PEP (P9b/d) instead. See docs/runbooks/p8e-policy-descriptor-resolver.md#architecture-lock',
            },
            {
              group: [
                '**/control-plane/policy',
                '**/control-plane/policy/*',
              ],
              message:
                'Architecture Lock (P8e): agent/cognition MUST NOT import the policy module directly. Use a slice builder (P8d) or PEP (P9b/d) instead.',
            },
            // Fronteira única de LLM (#508) — repetida aqui porque flat
            // config não faz merge de opções de regra entre blocos.
            ...RESTRICTED_LLM_SDK_PATTERNS,
          ],
        },
      ],
    },
  },

  // Fase 0 do roteamento multi-linha — lint gate da fronteira única de saída
  // (ver RESTRICTED_SEND_IMPORT_PATHS no topo). src/gateway/ é o ÚNICO lugar
  // autorizado a tocar as primitivas físicas; agent/cognition recebem os
  // mesmos paths via o bloco P8e acima (flat config não faz merge de regra).
  {
    files: ['src/**/*.ts'],
    ignores: ['src/gateway/**', 'src/agent/**', 'src/cognition/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: RESTRICTED_SEND_IMPORT_PATHS, patterns: RESTRICTED_LLM_SDK_PATTERNS },
      ],
    },
  },

  // Fronteira única de LLM (#508) em src/gateway/**, que os blocos acima
  // deixam de fora de propósito (é o dono das primitivas físicas de envio).
  // O lock de SDK de provider vale ali também.
  {
    files: ['src/gateway/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: RESTRICTED_LLM_SDK_PATTERNS }],
    },
  },

  // Os ÚNICOS arquivos autorizados a importar SDK de provider. Aqui o lock de
  // LLM sai (senão os próprios adapters não compilariam sob a regra); o lock
  // das primitivas de envio continua.
  {
    files: ['src/lib/llm/providers/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: RESTRICTED_SEND_IMPORT_PATHS }],
    },
  },

  // Issue #515 — configuration contract lock. `src/config/contract.ts` is the
  // single source of truth for every Maia variable, and configuration must be
  // consumed through a service loader (`src/config/load.ts` and friends), never
  // read ad hoc from `process.env`. A direct read bypasses the schema, the
  // defaults, the per-profile rules and the per-service allow-list — which is
  // exactly how `.env.example` drifted away from the schema in the first place.
  //
  // The `ignores` list below is the EXPLICIT allow-list of files that still
  // read directly. It is a migration budget, not a permanent exemption: shrink
  // it, never grow it. A NEW direct read anywhere else fails `npm run lint`.
  {
    files: ['src/**/*.ts'],
    ignores: [
      // Authorised loaders — this is where env legitimately enters the process.
      'src/config/env.ts',
      'src/config/load.ts',
      // Admin UI: a separate Next.js app with its own build; migrating it to
      // the shared loader is tracked as the Admin rollout step of #515.
      'src/admin-ui/**',
      // Pending migration (inventoried in docs/configuration.md).
      //
      // Issue #508 encolheu esta lista: os cinco call sites de LLM que liam
      // `process.env.ANTHROPIC_API_KEY` direto (calendar-pattern-detector,
      // capability-proposer, drift/**, role-selector/llm-suggester,
      // shared/risk/llm-gate) foram migrados para o LLM Gateway, que consome a
      // chave pelo `config` tipado. A leitura direta sumiu junto — não é
      // isenção retirada "no grito", é código que deixou de existir.
      'src/agent/prompt-builder.ts',
      'src/db/tenant-context.ts',
      'src/lib/mcp-client.ts',
      'src/runtime/context-packet/test-fixtures.ts',
      'src/runtime/feature-flags/context-packet-flag.ts',
      'src/setup/index.ts',
      'src/workers/procedure-execution-reaper.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Contrato de configuração (#515): não leia process.env direto. Declare a variável em ' +
            'src/config/contract.ts e consuma pelo loader do serviço (src/config/load.ts, ' +
            'migration-config.ts, admin-config.ts, backup-config.ts) ou pelo singleton ' +
            '@/config/env.js. Exceções ficam na allow-list explícita em eslint.config.js.',
        },
      ],
    },
  },

  // Scripts use the same TS rules but without the type-aware parser.
  // tsconfig.json includes only src/, and pulling scripts/ into the
  // type-aware project would force the build to compile them (they run
  // via tsx, not via dist). Keep them on the lighter parser — they don't
  // get no-floating-promises, but the trade is acceptable for one-offs.
  {
    files: ['scripts/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: NODE_GLOBALS,
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: TS_RULES,
  },

  // Test files (Node globals + Vitest globals)
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: { ...NODE_GLOBALS, ...VITEST_GLOBALS },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: TS_RULES,
  },

  // Guards em ESM puro (`scripts/*.mjs`). Eles ficam FORA do tsc de propósito
  // — tsconfig.json inclui só `src/**/*`, e todo o `scripts/` já está fora —,
  // então o lint é a única verificação estática que os alcança. Sem este bloco
  // eles cairiam só no `js.configs.recommended`, sem globals de Node, e
  // `process`/`console` virariam `no-undef`.
  //
  // `ecmaVersion` fica em 2015 de caso pensado: um guard que precisa rodar num
  // Node velho para reclamar dele não pode usar sintaxe que o Node velho não
  // parseia (`?.`, `??`, top-level await). O parser reprovando é mais barato
  // que descobrir isso no runtime de quem está travado.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2015,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: {
      'no-var': 'off',
    },
  },

  // CommonJS scripts (rare here but defensive)
  {
    files: ['*.cjs', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
];
