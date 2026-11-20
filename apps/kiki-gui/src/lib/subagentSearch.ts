import { useEffect, useState } from 'react';
import type { AgentTreeNode } from '@kiki/session-core/session';
import { getSubagentScaleConfig } from './subagentScaleConfig';

/**
 * Optional server-backed subagent search callback exposed by `SessionController`
 * once the bounded-roster backend lands (`controller.searchSubagents`).
 */
export type SubagentSearchFn = (
  query: string,
  options?: { readonly limit?: number; readonly signal?: AbortSignal },
) => Promise<readonly AgentTreeNode[]>;

const EMPTY_SEARCH_RESULTS: readonly AgentTreeNode[] = [];

/**
 * Duck-typed accessor for `controller.searchSubagents` so `apps/kiki-gui`
 * typechecks standalone while automatically connecting to server search when
 * available on `SessionController`.
 */
export function resolveControllerSubagentSearch(controller: unknown): SubagentSearchFn | undefined {
  if (controller === null || controller === undefined || typeof controller !== 'object') return undefined;
  const candidate = (controller as { readonly searchSubagents?: unknown }).searchSubagents;
  if (typeof candidate !== 'function') return undefined;
  return (query, options) => (candidate as SubagentSearchFn).call(controller, query, options);
}

/**
 * Debounced (`120 ms`) remote subagent search with `AbortController` cleanup.
 * Returns immediately with an empty list when `enabled` is false, `search` is
 * absent, or `query` is blank.
 */
export function useRemoteSubagentSearch(
  query: string,
  search: SubagentSearchFn | undefined,
  enabled: boolean,
  limit?: number,
): { readonly results: readonly AgentTreeNode[]; readonly loading: boolean } {
  const scaleConfig = getSubagentScaleConfig();
  const effectiveLimit = limit ?? scaleConfig.searchResultLimit;
  const debounceMs = scaleConfig.searchDebounceMs;
  const trimmed = query.trim();
  const active = enabled && search !== undefined && trimmed.length > 0;
  const [state, setState] = useState<{
    readonly forQuery: string;
    readonly results: readonly AgentTreeNode[];
    readonly loading: boolean;
  }>({ forQuery: '', results: EMPTY_SEARCH_RESULTS, loading: false });

  useEffect(() => {
    if (!active || search === undefined) {
      setState((prev) =>
        prev.results.length === 0 && !prev.loading && prev.forQuery === ''
          ? prev
          : { forQuery: '', results: EMPTY_SEARCH_RESULTS, loading: false },
      );
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();
    setState((prev) => ({
      forQuery: trimmed,
      results: prev.forQuery === trimmed ? prev.results : EMPTY_SEARCH_RESULTS,
      loading: true,
    }));

    const timer = window.setTimeout(() => {
      void Promise.resolve(search(trimmed, { limit: effectiveLimit, signal: abortController.signal }))
        .then((hits) => {
          if (cancelled || abortController.signal.aborted) return;
          setState({
            forQuery: trimmed,
            results: Array.isArray(hits) ? hits : EMPTY_SEARCH_RESULTS,
            loading: false,
          });
        })
        .catch(() => {
          if (cancelled || abortController.signal.aborted) return;
          setState({
            forQuery: trimmed,
            results: EMPTY_SEARCH_RESULTS,
            loading: false,
          });
        });
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      abortController.abort();
    };
  }, [active, debounceMs, effectiveLimit, search, trimmed]);

  if (!active) return { results: EMPTY_SEARCH_RESULTS, loading: false };
  return {
    results: state.forQuery === trimmed ? state.results : EMPTY_SEARCH_RESULTS,
    loading: state.loading,
  };
}
