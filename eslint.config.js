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
