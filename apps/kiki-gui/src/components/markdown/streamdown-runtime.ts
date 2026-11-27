/**
 * Lazy runtime loader for `streamdown` + `@streamdown/cjk`.
 *
 * `streamdown` statically bundles `parse5`, `tailwind-merge`, `unified`,
 * `micromark`, `rehype-sanitize`, `remark-gfm`, `marked`, and HTML entity
 * tables (~320 KB gzipped). Deferring `streamdown` behind a dynamic import
 * keeps cold `/m/*` and `/s/*` boot independent of the full Markdown AST
 * pipeline, while plain-prose messages render synchronously via `isPlainProse`
 * and Vitest pre-loads the runtime at module init so synchronous `flushSync` /
 * `act` tests observe zero behavioral change.
 */

import { useEffect, useSyncExternalStore } from 'react';

type StreamdownModule = typeof import('streamdown');
type CjkModule = typeof import('@streamdown/cjk');

export interface LoadedStreamdownRuntime {
  readonly Streamdown: StreamdownModule['Streamdown'];
  readonly CodeBlock: StreamdownModule['CodeBlock'];
  readonly defaultRemarkPlugins: StreamdownModule['defaultRemarkPlugins'];
  readonly defaultRehypePlugins: StreamdownModule['defaultRehypePlugins'];
  readonly parseMarkdownIntoBlocks: StreamdownModule['parseMarkdownIntoBlocks'];
  readonly cjk: CjkModule['cjk'];
}

let loadedRuntime: LoadedStreamdownRuntime | null = null;
let runtimeFlight: Promise<LoadedStreamdownRuntime | null> | null = null;
let runtimeVersion = 0;
const listeners = new Set<() => void>();

function emit(): void {
  runtimeVersion += 1;
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getVersion(): number {
  return runtimeVersion;
}

export function getStreamdownRuntime(): LoadedStreamdownRuntime | null {
  return loadedRuntime;
}

export function ensureStreamdownRuntime(): Promise<LoadedStreamdownRuntime | null> {
  if (loadedRuntime !== null) return Promise.resolve(loadedRuntime);
  runtimeFlight ??= Promise.all([import('streamdown'), import('@streamdown/cjk')])
    .then(([sd, cjkMod]) => {
      loadedRuntime = {
        Streamdown: sd.Streamdown,
        CodeBlock: sd.CodeBlock,
        defaultRemarkPlugins: sd.defaultRemarkPlugins,
        defaultRehypePlugins: sd.defaultRehypePlugins,
        parseMarkdownIntoBlocks: sd.parseMarkdownIntoBlocks,
        cjk: cjkMod.cjk,
      };
      emit();
      return loadedRuntime;
    })
    .catch(() => null);
  return runtimeFlight;
}

export function useStreamdownRuntime(needed: boolean): LoadedStreamdownRuntime | null {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  useEffect(() => {
    if (needed && loadedRuntime === null) {
      void ensureStreamdownRuntime();
    }
  }, [needed]);
  if (needed && loadedRuntime === null) {
    void ensureStreamdownRuntime();
  }
  return loadedRuntime;
}

// Dead-code-eliminated in `vite build` (`import.meta.env.MODE === 'production'`);
// pre-populates `loadedRuntime` synchronously before Vitest suites execute.
if (import.meta.env.MODE === 'test') {
  await ensureStreamdownRuntime();
}
