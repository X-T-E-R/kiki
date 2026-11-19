/**
 * Shared syntax-highlighting helpers for code previews
 * (tool-call Write/Edit, approval-panel Write content, etc.) and markdown
 * code blocks, backed by `highlight.js` v11 core with on-demand language
 * registration and a theme-token ANSI emitter.
 */

import { extname } from 'node:path';

import { codeHighlightTheme, type CodeHighlightStyler } from '#/tui/theme/highlight-theme';

import { hljs } from './hljs-runtime.mjs';

const EXT_LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  css: 'css',
  html: 'html',
  sql: 'sql',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
};

const HLJS_TOKEN_RE = /<span class="([^"]+)">|<\/span>|([^<]+)/g;

function decodeHtmlEntities(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

function resolveStyler(stack: readonly string[]): CodeHighlightStyler | undefined {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const scope = stack[i]!;
    const direct = codeHighlightTheme[scope];
    if (direct !== undefined) return direct;
    const base = scope.split('-')[0];
    if (base !== undefined && codeHighlightTheme[base] !== undefined) {
      return codeHighlightTheme[base];
    }
  }
  return undefined;
}

function renderHljsHtmlToAnsi(html: string): string {
  const stack: string[] = [];
  let output = '';
  for (const match of html.matchAll(HLJS_TOKEN_RE)) {
    const openClass = match[1];
    const textChunk = match[2];
    if (openClass !== undefined) {
      const primary = openClass.split(/\s+/)[0] ?? '';
      stack.push(primary.startsWith('hljs-') ? primary.slice(5) : primary);
      continue;
    }
    if (textChunk === undefined) {
      stack.pop();
      continue;
    }
    const decoded = decodeHtmlEntities(textChunk);
    const styler = resolveStyler(stack);
    if (styler === undefined) {
      output += decoded;
    } else {
      output += decoded.split('\n').map((part) => (part.length > 0 ? styler(part) : '')).join('\n');
    }
  }
  return output;
}

export function supportsLanguage(lang: string): boolean {
  return hljs.getLanguage(lang) !== undefined;
}

export function highlightCode(code: string, lang: string): string {
  const { value } = hljs.highlight(code, { language: lang, ignoreIllegals: true });
  return renderHljsHtmlToAnsi(value);
}

export function langFromPath(filePath: string): string | undefined {
  const ext = extname(filePath).slice(1).toLowerCase();
  if (ext.length === 0) return undefined;
  const lang = EXT_LANG_MAP[ext] ?? ext;
  return supportsLanguage(lang) ? lang : undefined;
}

export function highlightLines(code: string, lang: string | undefined): string[] {
  const normalizedLang = lang?.trim().toLowerCase();
  if (!normalizedLang || !supportsLanguage(normalizedLang)) return code.split('\n');
  try {
    return highlightCode(code, normalizedLang).split('\n');
  } catch {
    return code.split('\n');
  }
}
