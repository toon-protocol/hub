'use strict';

const { RuleTester } = require('eslint');
const noInlineHex = require('../rules/no-inline-hex.cjs');
const noPositiveLetterSpacingGeist = require('../rules/no-positive-letter-spacing-geist.cjs');
const noRawBorder = require('../rules/no-raw-border.cjs');
const noDirectRecharts = require('../rules/no-direct-recharts.cjs');

// ESLint v9 flat-config RuleTester uses languageOptions instead of parserOptions
const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: {
      ecmaFeatures: { jsx: true },
    },
  },
});

// ── no-inline-hex ──────────────────────────────────────────────────────────

ruleTester.run('no-inline-hex', noInlineHex, {
  valid: [
    { code: `const x = 'some-class'` },
    { code: `const x = 'rgb(0,0,0)'` },
    { code: `const x = colors.ink` },
    // Allowed inside tokens file
    {
      code: `const c = '#ffffff'`,
      filename: '/project/src/theme/tokens.ts',
    },
  ],
  invalid: [
    {
      code: `const x = '#fff'`,
      filename: '/project/src/components/Button.tsx',
      errors: [{ messageId: 'noInlineHex' }],
    },
    {
      code: `const x = '#0a72ef'`,
      filename: '/project/src/App.tsx',
      errors: [{ messageId: 'noInlineHex' }],
    },
    {
      code: 'const x = `color: #ff5b4f`',
      filename: '/project/src/components/foo.tsx',
      errors: [{ messageId: 'noInlineHex' }],
    },
  ],
});

// ── no-positive-letter-spacing-geist ────────────────────────────────────────

const jsxRuleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: {
      ecmaFeatures: { jsx: true },
    },
  },
});

jsxRuleTester.run('no-positive-letter-spacing-geist', noPositiveLetterSpacingGeist, {
  valid: [
    {
      code: `<div className="font-geist-sans tracking-tight-16">text</div>`,
    },
    {
      code: `<div className="font-geist-mono tracking-wide">code</div>`,
    },
    {
      code: `<div className="font-sans tracking-widest">text</div>`,
    },
    {
      code: `<div className={cn("font-geist-sans tracking-tight-14")}>text</div>`,
    },
  ],
  invalid: [
    {
      code: `<div className="font-geist-sans tracking-wide">text</div>`,
      errors: [{ messageId: 'noPositiveTracking' }],
    },
    {
      code: `<div className="font-geist-sans tracking-widest text-ink">header</div>`,
      errors: [{ messageId: 'noPositiveTracking' }],
    },
    {
      code: `<div className={cn("font-geist-sans tracking-wide", className)}>text</div>`,
      errors: [{ messageId: 'noPositiveTracking' }],
    },
    {
      code: 'const cls = `font-geist-sans tracking-widest`',
      errors: [{ messageId: 'noPositiveTracking' }],
    },
  ],
});

// ── no-raw-border ────────────────────────────────────────────────────────────

jsxRuleTester.run('no-raw-border', noRawBorder, {
  valid: [
    {
      code: `<div className="shadow-border">card</div>`,
    },
    {
      code: `<div className="border-0 rounded">chip</div>`,
    },
    {
      code: `const style = { boxShadow: '0 0 0 1px rgba(0,0,0,0.08)' }`,
    },
    {
      code: `<div className={cn("shadow-border rounded-md", className)}>card</div>`,
    },
    {
      code: `const v = cva("shadow-border", { variants: { foo: { bar: 'border-0 rounded' } } })`,
    },
  ],
  invalid: [
    {
      code: `<div className="border rounded">card</div>`,
      errors: [{ messageId: 'noRawBorder' }],
    },
    {
      code: `const s = { borderWidth: '1px' }`,
      errors: [{ messageId: 'noRawBorder' }],
    },
    {
      code: `const s = { border: '1px solid #ccc' }`,
      errors: [{ messageId: 'noRawBorder' }],
    },
    {
      code: `<div className={cn("rounded-xl border bg-card", className)}>card</div>`,
      errors: [{ messageId: 'noRawBorder' }],
    },
    {
      code: 'const cls = `rounded border`',
      errors: [{ messageId: 'noRawBorder' }],
    },
    {
      code: `const v = cva("rounded", { variants: { x: { y: 'border-2 rounded' } } })`,
      errors: [{ messageId: 'noRawBorder' }],
    },
  ],
});

// ── no-direct-recharts ───────────────────────────────────────────────────────

ruleTester.run('no-direct-recharts', noDirectRecharts, {
  valid: [
    {
      code: `import { LineChart } from '@/charts'`,
      filename: '/project/src/pages/Home.tsx',
    },
    {
      code: `import { LineChart } from 'recharts'`,
      filename: '/project/src/charts/index.ts',
    },
    {
      code: `import { LineChart } from 'recharts'`,
      filename: '/project/src/charts/helpers.ts',
    },
  ],
  invalid: [
    {
      code: `import { LineChart } from 'recharts'`,
      filename: '/project/src/pages/Dashboard.tsx',
      errors: [{ messageId: 'noDirectRecharts' }],
    },
    {
      code: `import * as Recharts from 'recharts'`,
      filename: '/project/src/components/SomeComponent.tsx',
      errors: [{ messageId: 'noDirectRecharts' }],
    },
  ],
});

console.log('All ESLint rule tests passed ✓');
