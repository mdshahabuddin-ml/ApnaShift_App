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
    // Served browser bundles — window is correct here (theme/lang/text-size
    // declare their own locals on purpose, so keep the list explicit).
    files: ['public/notify.js', 'public/api-config.js', 'public/announcements.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
