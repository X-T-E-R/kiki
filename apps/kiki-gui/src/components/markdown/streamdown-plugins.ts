/**
 * Lazy loader for Streamdown's code, math, and Mermaid engines, adapted from
 * codeg's Apache-2.0 `src/components/ai-elements/streamdown-plugins.ts`.
 * CJK syntax is lightweight; the three heavy engines load only when their
 * syntax appears, keeping the first paint independent of Shiki and Mermaid.
 * Mounted consumers re-render when an engine resolves.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ComponentProps } from 'react';
import { cjk } from '@streamdown/cjk';
import type { Streamdown } from 'streamdown';

type PluginConfig = NonNullable<ComponentProps<typeof Streamdown>['plugins']>;
type CodePlugin = NonNullable<PluginConfig['code']>;
type MathPlugin = NonNullable<PluginConfig['math']>;
type MermaidPlugin = NonNullable<PluginConfig['mermaid']>;
type HeavyKind = 'code' | 'math' | 'mermaid';

const loaded: { code?: CodePlugin; math?: MathPlugin; mermaid?: MermaidPlugin } = {};
const inflight = new Set<HeavyKind>();
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
    emit();
  };
  if (kind === 'code') {
    import('@streamdown/code')
      .then((mod) => {
        loaded.code = makeSafeCode(
          mod.createCodePlugin({ themes: ['github-light', 'github-dark'] }) as CodePlugin,
        );
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

const CJK_PLUGINS: PluginConfig = { cjk };

export function useMermaidEngine(): MermaidPlugin | null {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  useEffect(() => { ensure('mermaid'); }, []);
  return loaded.mermaid ?? null;
}

export function useStreamdownPlugins(text: string | null | undefined): PluginConfig {
  const needs = useMemo(() => ({
    code: typeof text === 'string' && needsCodeEngine(text),
    math: typeof text === 'string' && (
      text.includes('$$') || text.includes('\\(') || text.includes('\\[') ||
      /(?:```|~~~)[^\S\r\n]*math\b/i.test(text)
    ),
    mermaid: typeof text === 'string' && /(?:```|~~~)[^\S\r\n]*mermaid\b/i.test(text),
  }), [text]);
  const { code, math, mermaid } = needs;
  const currentVersion = useSyncExternalStore(subscribe, getVersion, getVersion);

  useEffect(() => {
    if (code) ensure('code');
    if (math) ensure('math');
    if (mermaid) ensure('mermaid');
  }, [code, math, mermaid]);

  return useMemo(() => {
    if (!code && !math && !mermaid) return CJK_PLUGINS;
    const plugins: PluginConfig = { cjk };
    if (code && loaded.code !== undefined) plugins.code = loaded.code;
    if (math && loaded.math !== undefined) plugins.math = loaded.math;
    if (mermaid && loaded.mermaid !== undefined) plugins.mermaid = loaded.mermaid;
    return plugins;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, math, mermaid, currentVersion]);
}
