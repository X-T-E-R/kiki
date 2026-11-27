/**
 * Lazy loader for Streamdown's code, math, and Mermaid engines, adapted from
 * codeg's Apache-2.0 `src/components/ai-elements/streamdown-plugins.ts`.
 * CJK syntax is lightweight; the three heavy engines load only when their
 * syntax appears, keeping the first paint independent of Shiki and Mermaid.
 * Math and Mermaid refresh their consumers when ready; code updates just its
 * fences through the highlighter's async callback.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ComponentProps } from 'react';
import type { Streamdown } from 'streamdown';

import { unwrapDomMarksInCodeBlocks } from './domAnnotationMarks';
import { useStreamdownRuntime } from './streamdown-runtime';

type PluginConfig = NonNullable<ComponentProps<typeof Streamdown>['plugins']>;
type CodePlugin = NonNullable<PluginConfig['code']>;
type MathPlugin = NonNullable<PluginConfig['math']>;
type MermaidPlugin = NonNullable<PluginConfig['mermaid']>;
type HeavyKind = 'code' | 'math' | 'mermaid';

const loaded: { code?: CodePlugin; math?: MathPlugin; mermaid?: MermaidPlugin } = {};
const inflight = new Set<HeavyKind>();
let codeFlight: Promise<CodePlugin | undefined> | undefined;
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getVersion(): number {
  return version;
}

/**
 * Guard against unsupported language identifiers that appear as the info
 * string of fenced blocks in tool output (verbatim from codeg's `safeCode`):
 * without it, shiki tries to load unknown grammars and logs noisy errors. The
 * rendered text is unchanged — an unknown language stays plaintext either way.
 */
function makeSafeCode(codePlugin: CodePlugin): CodePlugin {
  return {
    ...codePlugin,
    highlight(options, callback) {
      const language = codePlugin.supportsLanguage(options.language)
        ? options.language
        : ('text' as typeof options.language);
      return codePlugin.highlight({ ...options, language }, callback);
    },
  };
}

function ensure(kind: HeavyKind): void {
  if (loaded[kind] !== undefined || inflight.has(kind)) return;
  inflight.add(kind);
  const settle = () => {
    inflight.delete(kind);
    if (kind !== 'code') emit();
  };
  if (kind === 'code') {
    codeFlight = import('@streamdown/code')
      .then((mod) => {
        loaded.code = makeSafeCode(
          mod.createCodePlugin({ themes: ['github-light', 'github-dark'] }) as CodePlugin,
        );
        return loaded.code;
      })
      .catch(() => undefined)
      .finally(settle);
  } else if (kind === 'math') {
    import('@streamdown/math')
      .then((mod) => { loaded.math = mod.createMathPlugin({ singleDollarTextMath: false }); })
      .catch(() => undefined)
      .finally(settle);
  } else {
    import('@streamdown/mermaid')
      .then((mod) => { loaded.mermaid = mod.mermaid; })
      .catch(() => undefined)
      .finally(settle);
  }
}

/** A superset of fenced and indented code; false positives only trigger a lazy import. */
export function needsCodeEngine(text: string): boolean {
  return text.includes('```') || text.includes('~~~') || / {4}|\t/.test(text);
}

// Code highlighting already has an async callback contract. Keep its plugin
// identity stable so loading Shiki updates the fences, not the document parser.
function createLazyCodePlugin(rootRef?: { readonly current: HTMLElement | null }): CodePlugin {
  return {
    name: 'shiki',
    type: 'code-highlighter',
    getThemes: () => ['github-light', 'github-dark'],
    getSupportedLanguages: () => loaded.code?.getSupportedLanguages() ?? [],
    supportsLanguage: (language) => loaded.code?.supportsLanguage(language) ?? true,
    highlight(options, callback) {
      const safeCallback = callback === undefined
        ? undefined
        : (result: Parameters<NonNullable<typeof callback>>[0]) => {
            unwrapDomMarksInCodeBlocks(options.code, rootRef !== undefined ? rootRef.current : undefined);
            callback(result);
          };
      if (loaded.code !== undefined) return loaded.code.highlight(options, safeCallback);
      ensure('code');
      void codeFlight?.then((plugin) => {
        const result = plugin?.highlight(options, safeCallback);
        // The maintained highlighter can return cached tokens synchronously.
        // eslint-disable-next-line promise/no-callback-in-promise
        if (result !== null && result !== undefined) safeCallback?.(result);
      });
      return null;
    },
  };
}

const LAZY_CODE: CodePlugin = createLazyCodePlugin();
const EMPTY_PLUGINS: PluginConfig = {};

export function useMermaidEngine(): MermaidPlugin | null {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  useEffect(() => { ensure('mermaid'); }, []);
  return loaded.mermaid ?? null;
}

export function useStreamdownPlugins(
  text: string | null | undefined,
  rootRef?: { readonly current: HTMLElement | null },
): PluginConfig {
  const runtime = useStreamdownRuntime(typeof text === 'string' && text !== '');
  const cjk = runtime?.cjk;
  const needs = useMemo(() => ({
    code: typeof text === 'string' && needsCodeEngine(text),
    math: typeof text === 'string' && (
      text.includes('$$') || text.includes('\\(') || text.includes('\\[') ||
      /(?:```|~~~)[^\S\r\n]*math\b/i.test(text)
    ),
  }), [text]);
  const { code, math } = needs;
  const currentVersion = useSyncExternalStore(subscribe, getVersion, getVersion);
  const scopedCodePlugin = useMemo(
    () => (rootRef === undefined ? LAZY_CODE : createLazyCodePlugin(rootRef)),
    [rootRef],
  );
  const cjkOnlyPlugins = useMemo<PluginConfig>(
    () => (cjk === undefined ? EMPTY_PLUGINS : { cjk }),
    [cjk],
  );
  const scopedCodePlugins = useMemo<PluginConfig>(
    () => (cjk === undefined ? { code: scopedCodePlugin } : { cjk, code: scopedCodePlugin }),
    [cjk, scopedCodePlugin],
  );

  useEffect(() => {
    if (math) ensure('math');
  }, [math]);

  return useMemo(() => {
    if (!math) return code ? scopedCodePlugins : cjkOnlyPlugins;
    const plugins: PluginConfig = cjk === undefined ? {} : { cjk };
    if (code) plugins.code = scopedCodePlugin;
    if (math && loaded.math !== undefined) plugins.math = loaded.math;
    return plugins;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cjk, cjkOnlyPlugins, code, math, currentVersion, scopedCodePlugin, scopedCodePlugins]);
}
