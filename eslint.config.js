// ESLint v9 flat config. The package.json was on v9.14 but had no config file,
// so `npm run lint` was crashing pre-merge. This sets up the standard
// @typescript-eslint v8 + base eslint:recommended for src/ TypeScript only.
//
// Keep the rule set lean — the suite already runs typecheck (tsc) and unit
// tests, so lint is here mainly to catch unused vars, unsafe `any`, and the
// usual style smells. Heavy rules (no-floating-promises, strict-boolean) are
// off because they require the type-aware parser, which we can opt into
// later if the team wants stricter checks.

import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  // Global ignores - mirror tsconfig + add generated/test artifacts
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

  // TypeScript-specific config for our source
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        // Node built-ins used across the codebase
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
        // Vitest globals (only relevant inside tests/, but enabling here is harmless)
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Start from the type-eslint flat preset
      ...tsPlugin.configs.recommended.rules,

      // Disable base no-unused-vars in favour of the TS-aware version
      'no-unused-vars': 'off',
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

      // Allow re-assigning function args (common in patch-style helpers)
      'no-param-reassign': 'off',

      // Prefer const, but warn instead of error so refactors don't block CI
      'prefer-const': 'warn',
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
