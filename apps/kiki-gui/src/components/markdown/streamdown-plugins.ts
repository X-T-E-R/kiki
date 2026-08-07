/**
 * Lazy loader for Streamdown's shiki code-highlighting engine.
 *
 * Ported from codeg (https://github.com/codeg-vn/codeg —
 * `src/components/ai-elements/streamdown-plugins.ts`, Apache-2.0), trimmed to
 * the single engine kiki ships: `@streamdown/code` (shiki). kiki does not load
 * the math/mermaid/cjk plugins (explicit non-goals), so only the fence
 * detection and the at-most-once lazy import remain.
 *
 * Why: `@streamdown/code` pulls in shiki + its grammar/theme index (multi-MB
 * unpacked). Statically importing it pins the engine into the first-paint
 * chunk; this module loads it the first time rendered markdown actually
 * contains a code block, and at most once process-wide. Mounted consumers
 * re-render via a version counter when the engine resolves, upgrading the
 * already-rendered plaintext fallback in place. Detection errs LOOSE on
 * purpose — a false positive merely pre-loads an engine that then no-ops.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ComponentProps } from 'react';
import type { Streamdown } from 'streamdown';

type PluginConfig = NonNullable<ComponentProps<typeof Streamdown>['plugins']>;
type CodePlugin = NonNullable<PluginConfig['code']>;

const loaded: { code?: CodePlugin } = {};
let inflight = false;
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

function ensureCode(): void {
  if (loaded.code !== undefined || inflight) return;
  inflight = true;
  import('@streamdown/code')
    .then((mod) => {
      // github-light first (kiki is light-only); github-dark is the plugin's
      // required second theme slot and simply never shows.
      loaded.code = makeSafeCode(
        mod.createCodePlugin({ themes: ['github-light', 'github-dark'] }),
      );
    })
    .catch(() => {
      // engine stays unloaded — fences render as plaintext
    })
    .finally(() => {
      inflight = false;
      emit();
    });
}

/**
 * Cheap detection of whether a (possibly still-streaming) markdown text needs
 * the code engine: any fenced block, or any run of ≥4 spaces / a tab that may
 * be an indented code block (a guaranteed superset — over-loading shiki once
 * per session is safe, missing a real block would stay unhighlighted).
 */
export function needsCodeEngine(text: string): boolean {
  return text.includes('```') || text.includes('~~~') || / {4}|\t/.test(text);
}

const EMPTY_PLUGINS: PluginConfig = {};

/**
 * Returns the Streamdown `plugins` config for `text`, lazy-loading the code
 * engine on first use. Pass `null`/`undefined` for the light config.
 */
export function useStreamdownPlugins(text: string | null | undefined): PluginConfig {
  const needCode = useMemo(() => typeof text === 'string' && needsCodeEngine(text), [text]);
  // Re-render when the engine resolves so the plaintext fallback upgrades.
  const currentVersion = useSyncExternalStore(subscribe, getVersion, getVersion);

  useEffect(() => {
    if (needCode) ensureCode();
  }, [needCode]);

  return useMemo(() => {
    if (!needCode || loaded.code === undefined) return EMPTY_PLUGINS;
    return { code: loaded.code };
    // `currentVersion` is the load signal: a resolved ensure() mutates the
    // module cache and bumps the version; `loaded` is read untracked on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needCode, currentVersion]);
}
