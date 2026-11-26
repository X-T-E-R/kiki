import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { nativeIntermediatesDir, nativeJsBundlePath } from './paths.mjs';

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const optionalRuntimeRequires = new Set([
  '@napi-rs/keyring',
  '@kiki/auth-native',
  'node-pty',
  'ajv-formats/dist/formats',
  'ajv/dist/runtime/validation_error',
  'bufferutil',
  'canvas',
  'chokidar',
  'cpu-features',
  'fast-json-stringify/lib/serializer',
  'fast-json-stringify/lib/validator',
  'utf-8-validate',
  // Discord's SDK catches a missing zlib-sync and works without stream compression.
  'zlib-sync',
]);
const optionalRelativeRuntimeRequires = new Set(['./crypto/build/Release/sshcrypto.node']);

const REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'case', 'throw', 'in', 'of', 'typeof', 'void', 'delete',
  'new', 'else', 'do', 'yield', 'await', 'instanceof',
]);

function isIdentChar(code) {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36 ||
    code >= 128
  );
}

function stripComments(text, { maskLiterals = false } = {}) {
  const out = [];
  const length = text.length;
  // Track template literal `${ ... }` brace nesting so closing `}` resumes template scanning.
  const templateBraceDepths = [];
  let braceDepth = 0;
  let lastTokenKind = 'punct';
  let lastWord = '';
  let index = 0;

  const canStartRegex = () => {
    if (lastTokenKind === 'word') return REGEX_PREFIX_KEYWORDS.has(lastWord);
    return lastTokenKind === 'punct';
  };

  while (index < length) {
    const ch = text[index];
    const next = index + 1 < length ? text[index + 1] : '';

    // Single-line comment
    if (ch === '/' && next === '/') {
      index += 2;
      while (index < length && text[index] !== '\n') index += 1;
      continue;
    }

    // Multi-line / inline block comment
    if (ch === '/' && next === '*') {
      index += 2;
      let sawNewline = false;
      while (index < length) {
        if (text[index] === '*' && index + 1 < length && text[index + 1] === '/') {
          index += 2;
          break;
        }
        if (text[index] === '\n') {
          out.push('\n');
          sawNewline = true;
        }
        index += 1;
      }
      if (!sawNewline) out.push(' ');
      continue;
    }

    // String literals
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = index;
      index += 1;
      while (index < length) {
        const cur = text[index];
        if (cur === '\\') {
          index += 2;
          continue;
        }
        index += 1;
        if (cur === quote || cur === '\n') break;
      }
      out.push(maskLiterals ? `${quote}${quote}` : text.slice(start, index));
      lastTokenKind = 'value';
      lastWord = '';
      continue;
    }

    // Template literal start or resume after `${ ... }`
    if (ch === '`' || (ch === '}' && templateBraceDepths.length > 0 && braceDepth === templateBraceDepths[templateBraceDepths.length - 1])) {
      const start = index;
      if (ch === '}') {
        templateBraceDepths.pop();
        braceDepth -= 1;
      }
      index += 1;
      let enteredExpr = false;
      while (index < length) {
        const cur = text[index];
        if (cur === '\\') {
          index += 2;
          continue;
        }
        if (cur === '`') {
          index += 1;
          break;
        }
        if (cur === '$' && index + 1 < length && text[index + 1] === '{') {
          index += 2;
          braceDepth += 1;
          templateBraceDepths.push(braceDepth);
          enteredExpr = true;
          break;
        }
        index += 1;
      }
      if (maskLiterals) {
        const rawSlice = text.slice(start, index);
        const newlines = rawSlice.replace(/[^\n]/g, '');
        out.push(`${ch}${newlines}${enteredExpr ? '${' : '`'}`);
      } else {
        out.push(text.slice(start, index));
      }
      lastTokenKind = enteredExpr ? 'punct' : 'value';
      lastWord = '';
      continue;
    }

    // Regex literal
    if (ch === '/' && canStartRegex()) {
      const start = index;
      index += 1;
      let inClass = false;
      while (index < length) {
        const cur = text[index];
        if (cur === '\\') {
          index += 2;
          continue;
        }
        if (cur === '\n') break;
        if (cur === '[') inClass = true;
        else if (cur === ']') inClass = false;
        else if (cur === '/' && !inClass) {
          index += 1;
          while (index < length && /[a-z]/i.test(text[index])) index += 1;
          break;
        }
        index += 1;
      }
      out.push(maskLiterals ? '/x/' : text.slice(start, index));
      lastTokenKind = 'value';
      lastWord = '';
      continue;
    }

    const code = ch.charCodeAt(0);
    if (isIdentChar(code)) {
      const start = index;
      index += 1;
      while (index < length && isIdentChar(text.charCodeAt(index))) index += 1;
      const word = text.slice(start, index);
      out.push(word);
      lastTokenKind = 'word';
      lastWord = word;
      continue;
    }

    if (ch === '{') {
      braceDepth += 1;
      out.push(ch);
      lastTokenKind = 'punct';
      lastWord = '';
      index += 1;
      continue;
    }

    if (ch === '}') {
      if (braceDepth > 0) braceDepth -= 1;
      out.push(ch);
      lastTokenKind = 'punct';
      lastWord = '';
      index += 1;
      continue;
    }

    out.push(ch);
    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') {
      if (ch === ')' || ch === ']') {
        lastTokenKind = 'value';
      } else if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
        out.push(next);
        index += 1;
        lastTokenKind = 'value';
      } else {
        lastTokenKind = 'punct';
      }
      lastWord = '';
    }
    index += 1;
  }

  return out.join('');
}

function executableLines(text) {
  return stripComments(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function checkBundle(bundlePath, { worker = false } = {}) {
  if (!existsSync(bundlePath)) return [`bundle does not exist: ${bundlePath}`];
  const text = readFileSync(bundlePath, 'utf-8');
  const errors = [];
  const allowedExternal = worker ? new Set() : optionalRuntimeRequires;
  const allowedRelative = worker ? new Set() : optionalRelativeRuntimeRequires;

  const checkSpecifier = (specifier, kind) => {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      if (!allowedRelative.has(specifier)) errors.push(`relative ${kind} remains: ${specifier}`);
      return;
    }
    if (!builtins.has(specifier) && !specifier.startsWith('node:') && !allowedExternal.has(specifier)) {
      errors.push(`external ${kind} remains: ${specifier}`);
    }
  };

  for (const line of executableLines(text)) {
    for (const match of line.matchAll(/(?<![.\w])require\(\s*["']([^"']+)["']\s*\)/g)) {
      checkSpecifier(match[1], 'require');
    }
    for (const match of line.matchAll(/(?<![.\w])import\(\s*["']([^"']+)["']\s*\)/g)) {
      checkSpecifier(match[1], 'dynamic import');
    }
    if (line.startsWith('import ')) {
      for (const match of line.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        checkSpecifier(match[1], 'import');
      }
      const sideEffect = line.match(/^import\s*["']([^"']+)["']/);
      if (sideEffect) checkSpecifier(sideEffect[1], 'import');
    }
  }

  const maskedCode = stripComments(text, { maskLiterals: true });
  for (const match of maskedCode.matchAll(/(?<![.\w$])(?:const|let)\s+require\s*=[^;{}]*(?<![.\w$])require\s*\(/g)) {
    const lineNo = maskedCode.slice(0, match.index ?? 0).split('\n').length;
    const snippet = match[0].replace(/\s+/g, ' ').trim();
    errors.push(`TDZ self-referencing require declaration at line ${lineNo}: ${snippet}`);
  }

  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bundles = [
    { path: nativeJsBundlePath(), worker: false },
    { path: resolve(nativeIntermediatesDir(), 'sqlite-query-worker.mjs'), worker: true },
    { path: resolve(nativeIntermediatesDir(), 'history-navigation-worker.mjs'), worker: true },
    { path: resolve(nativeIntermediatesDir(), 'usage-parser-worker.mjs'), worker: true },
    { path: resolve(nativeIntermediatesDir(), 'query-store-worker.mjs'), worker: true },
    { path: resolve(nativeIntermediatesDir(), 'usage-read-model-worker.mjs'), worker: true },
    { path: resolve(nativeIntermediatesDir(), 'mailbox-worker.mjs'), worker: true },
    { path: resolve(nativeIntermediatesDir(), 'memory-worker.mjs'), worker: true },
    { path: resolve(nativeIntermediatesDir(), 'cpu-worker.mjs'), worker: true },
    { path: resolve(nativeIntermediatesDir(), 'plugin-isolation-worker.mjs'), worker: true },
  ];
  let failed = false;
  for (const bundle of bundles) {
    const errors = checkBundle(bundle.path, { worker: bundle.worker });
    if (errors.length === 0) continue;
    failed = true;
    console.error(`Native JS bundle check failed for ${bundle.path}:`);
    for (const error of errors) console.error(`- ${error}`);
  }
  if (failed) process.exit(1);
}
