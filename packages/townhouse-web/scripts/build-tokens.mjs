#!/usr/bin/env node
/**
 * build-tokens — compile src/theme/tokens.ts → src/theme/tokens.json.
 *
 * Tailwind v3 config is CJS and cannot import the TS module directly. We
 * keep tokens.ts as the single source of truth (typed, IDE-friendly) and
 * emit tokens.json for tailwind.config.js to require(). Run as prebuild +
 * predev so the JSON is always in sync with the TS source.
 */

import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const tokensTsPath = resolve(pkgRoot, 'src/theme/tokens.ts');
const tokensJsonPath = resolve(pkgRoot, 'src/theme/tokens.json');

const source = readFileSync(tokensTsPath, 'utf8');

const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const moduleObj = { exports: {} };
const fn = new Function('module', 'exports', transpiled);
fn(moduleObj, moduleObj.exports);

writeFileSync(tokensJsonPath, JSON.stringify(moduleObj.exports, null, 2) + '\n');
console.log(`[build-tokens] wrote ${tokensJsonPath}`);
