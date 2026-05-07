'use strict';

const internalPlugin = require('./eslint-plugin-internal/index.cjs');
const tsParser = require('@typescript-eslint/parser');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.storybook/**',
      'storybook-static/**',
      'eslint-plugin-internal/**',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { internal: internalPlugin },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
        jsxPragma: null,
      },
    },
    rules: {
      'internal/no-inline-hex': 'error',
      'internal/no-positive-letter-spacing-geist': 'error',
      'internal/no-raw-border': 'error',
      'internal/no-direct-recharts': 'error',
    },
  },
  {
    // Allow hex in tokens file
    files: ['src/theme/tokens.ts'],
    plugins: { internal: internalPlugin },
    rules: {
      'internal/no-inline-hex': 'off',
    },
  },
  {
    // Allow recharts import in charts barrel
    files: ['src/charts/**/*.{ts,tsx}'],
    plugins: { internal: internalPlugin },
    rules: {
      'internal/no-direct-recharts': 'off',
    },
  },
  {
    // chart.tsx is shadcn-generated and uses Tailwind border utilities for
    // Recharts internal selectors. We don't modify generated code.
    files: ['src/charts/chart.tsx'],
    plugins: { internal: internalPlugin },
    rules: {
      'internal/no-raw-border': 'off',
    },
  },
];
