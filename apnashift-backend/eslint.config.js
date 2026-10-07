// Flat config (ESLint 9). Node ESM backend + vitest tests.
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
      'no-console': 'off',
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Served browser bundle (mirror of frontend/notify.js) — window is correct here.
    files: ['public/notify.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
