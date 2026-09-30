/**
 * FindBar — "find in this conversation" (Ctrl/⌘+F), a quiet floating strip
 * at the top-right of the timeline (VS Code's editor find, opencode's file
 * find): query, "3 / 12", case / whole-word toggles, previous / next, close.
 *
 * It counts over the projected blocks (every loaded turn, folded or not) and
 * asks the timeline to land each step; the timeline opens whatever hides the
 * match and paints it with the CSS Custom Highlight API. What is not loaded
 * is answered by the server's session-scoped search, and a match that no
 * loaded page can hold (compacted or rewritten history) is counted apart,
 * with a way into the global search.
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useI18n } from '../../i18n';
import type { KikiClient, SearchMessageHit } from '../../lib/client';
import {
  buildFindPattern,
  collectMatches,
  DEFAULT_FIND_OPTIONS,
  FIND_QUERY_MAX,
  requestQuickSwitcherSearch,
  turnOrdinal,
  type FindItem,
  type FindMatch,
  type FindOptions,
} from '../../lib/timelineFind';
import { useOptionalConnection } from '../../state/connection';
import { Icon } from '../icons';
import { POPOVER_SURFACE_CLASS } from '../SearchableSelect';

export interface FindBarProps {
  readonly items: readonly FindItem[];
  readonly sessionId: string | undefined;
  readonly agentId: string;
  /** Older pages remain to be loaded. */
  readonly hasMoreHistory: boolean;
  /** Turn ordinals present on the loaded pages. */
  readonly loadedTurns: ReadonlySet<number>;
  /** Seeds the query (a selection); `nonce` changes on every Ctrl+F. */
  readonly request: { readonly prefill?: string; readonly nonce: number };
  /** Land a match (open, scroll, paint); resolves false when it cannot. */
  readonly onLand: (match: FindMatch, pattern: RegExp) => Promise<boolean>;
  /** Clear paint (query emptied or no matches). */
  readonly onClear: () => void;
  /** Index of the match to start from (nearest the reader's viewport). */
  readonly startIndex: (matches: readonly FindMatch[]) => number;
  /** Page one older page in; resolves true when rows arrived. */
  readonly onLoadOlder: () => Promise<boolean>;
  /** Locate a turn (pages older history in until it shows). */
  readonly onLocateTurn: (ordinal: number) => Promise<boolean>;
  readonly onClose: () => void;
  /** F3 from outside the bar arrives here. */
  readonly stepRef: { current: ((direction: 1 | -1) => void) | null };
}

/** How many older pages "keep looking" pages in before giving up. */
const LOOK_BACK_PAGES = 5;
const SERVER_DEBOUNCE_MS = 300;

const BAR_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-faint pointer-coarse:h-9 pointer-coarse:w-9';
const NOTE_ACTION =
  'shrink-0 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:min-h-9';
const TOGGLE_ON = 'bg-selected text-selected-ink hover:bg-selected hover:text-selected-ink';

/** Stable identity of a match across re-renders (streaming, paging). */
function matchKey(match: FindMatch): string {
  return `${match.item.blockId}\0${match.occurrence}`;
}

export interface OutsideHits {
  /** Occurrences in turns older than the loaded pages (still loadable). */
  readonly earlier: number;
  /** Occurrences in turns no loaded or loadable page holds. */
  readonly compacted: number;
  /** Newest not-yet-loaded turn with a hit (the look-back target). */
  readonly nearestTurn: number | undefined;
  /** The server returned a full page: the counts are a floor. */
  readonly more: boolean;
  /** The server answered; false = no outside knowledge (offline, index down). */
  readonly known: boolean;
}

/**
 * Split session-scoped search hits by where they live relative to the loaded
 * pages. Hits in loaded turns are already counted locally; the rest are
 * either still loadable (older than the oldest loaded turn, more pages
 * remain) or held by no page (compacted or rewritten history).
 */
export function classifyOutsideHits(input: {
  readonly hits: readonly SearchMessageHit[];
  readonly loadedTurns: ReadonlySet<number>;
  readonly hasMoreHistory: boolean;
  readonly pattern: RegExp;
  readonly more: boolean;
}): OutsideHits {
  const oldestLoaded = input.loadedTurns.size === 0 ? undefined : Math.min(...input.loadedTurns);
  let earlier = 0;
  let compacted = 0;
  let nearestTurn: number | undefined;
  for (const hit of input.hits) {
    if (hit.role === 'title' || hit.turn === undefined || input.loadedTurns.has(hit.turn)) continue;
    // The snippet carries the matched passage; it re-applies case / whole-word
    // (the index matches loosely) and counts repeats inside the window.
    input.pattern.lastIndex = 0;
    const inSnippet = (hit.snippet.match(input.pattern) ?? []).length;
    if (inSnippet === 0) continue;
    const loadable = input.hasMoreHistory && (oldestLoaded === undefined || hit.turn < oldestLoaded);
    if (loadable) {
      earlier += inSnippet;
      nearestTurn = nearestTurn === undefined ? hit.turn : Math.max(nearestTurn, hit.turn);
    } else {
      compacted += inSnippet;
    }
  }
  return { earlier, compacted, nearestTurn, more: input.more, known: true };
}

type SessionSearch = Pick<KikiClient, 'searchMessages'>;
let searchOverride: SessionSearch | undefined;

/** Tests and visual harnesses without a live connection answer the search here. */
export function setFindSearchForTests(search: SessionSearch | undefined): void {
  searchOverride = search;
}

const NO_OUTSIDE: OutsideHits = { earlier: 0, compacted: 0, nearestTurn: undefined, more: false, known: false };

/**
 * One bounded, cancellable session-scoped search per settled query: the
 * server knows the turns this client has not paged in (and those no page
 * holds). A failure or an unavailable index just means no outside count.
 */
function useOutsideHits(input: {
  readonly query: string;
  readonly pattern: RegExp | null;
  readonly sessionId: string | undefined;
  readonly agentId: string;
  readonly loadedTurns: ReadonlySet<number>;
  readonly hasMoreHistory: boolean;
}): OutsideHits {
  const client = useOptionalConnection()?.client ?? searchOverride;
  const [page, setPage] = useState<{ key: string; hits: readonly SearchMessageHit[]; more: boolean; failed: boolean } | null>(null);
  const key = `${input.sessionId ?? ''}\0${input.agentId}\0${input.query}`;
  const armed = client !== undefined && input.sessionId !== undefined && input.query.trim().length >= 2;
  useEffect(() => {
    if (!armed) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void client.searchMessages({
        query: input.query,
        mode: 'literal',
        container: { session_id: input.sessionId, agent_id: input.agentId },
        sort: 'time_desc',
        page_size: 50,
      }, controller.signal).then(
        (response) => {
          const usable = response.index_state.state !== 'unavailable';
          setPage({ key, hits: usable ? response.items : [], more: response.has_more, failed: !usable });
        },
        () => { if (!controller.signal.aborted) setPage({ key, hits: [], more: false, failed: true }); },
      );
    }, SERVER_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [armed, client, key, input.query, input.sessionId, input.agentId]);
  return useMemo(() => {
    if (!armed || page === null || page.key !== key || input.pattern === null || page.failed) return NO_OUTSIDE;
    return classifyOutsideHits({
      hits: page.hits, loadedTurns: input.loadedTurns, hasMoreHistory: input.hasMoreHistory,
      pattern: input.pattern, more: page.more,
    });
  }, [armed, page, key, input.pattern, input.loadedTurns, input.hasMoreHistory]);
}

export function FindBar({
  items, sessionId, agentId, hasMoreHistory, loadedTurns, request, onLand, onClear, startIndex,
  onLoadOlder, onLocateTurn, onClose, stepRef,
}: FindBarProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(request.prefill ?? '');
  const [options, setOptions] = useState<FindOptions>(DEFAULT_FIND_OPTIONS);
  // Typing stays instant on a long session; counting follows a beat behind.
  const deferredQuery = useDeferredValue(query);
  const pattern = useMemo(() => buildFindPattern(deferredQuery, options), [deferredQuery, options]);
  const matches = useMemo(() => collectMatches(items, pattern), [items, pattern]);
  const outside = useOutsideHits({ query: deferredQuery, pattern, sessionId, agentId, loadedTurns, hasMoreHistory });
  const [currentKey, setCurrentKey] = useState<string | undefined>(undefined);
  const [lookingBack, setLookingBack] = useState(false);
  const index = currentKey === undefined ? -1 : matches.findIndex((match) => matchKey(match) === currentKey);
  const current = index === -1 ? undefined : matches[index];

  // Each Ctrl+F refocuses and selects the query (a new selection replaces it).
  useEffect(() => {
    if (request.prefill !== undefined) setQuery(request.prefill);
    const input = inputRef.current;
    if (input === null) return;
    input.focus({ preventScroll: true });
    input.select();
  }, [request.nonce, request.prefill]);

  // A new query or option set starts from the match nearest the reader.
  const landRef = useRef(onLand);
  landRef.current = onLand;
  const startRef = useRef(startIndex);
  startRef.current = startIndex;
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  useEffect(() => {
    const list = matchesRef.current;
    if (pattern === null || list.length === 0) {
      setCurrentKey(undefined);
      return;
    }
    const first = list[Math.min(Math.max(startRef.current(list), 0), list.length - 1)]!;
    setCurrentKey(matchKey(first));
  }, [pattern]);
  // Matches arriving after an empty result (a page loaded) pick a start too.
  useEffect(() => {
    if (currentKey === undefined && pattern !== null && matches.length > 0) {
      setCurrentKey(matchKey(matches[Math.min(Math.max(startRef.current(matches), 0), matches.length - 1)]!));
    }
  }, [currentKey, pattern, matches]);

  // Land whenever the current match changes.
  const landedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (current === undefined || pattern === null) {
      landedRef.current = undefined;
      onClear();
      return;
    }
    // The pattern is part of the key: a longer query can keep the same first
    // match while its painted range must grow.
    const key = `${matchKey(current)}\0${pattern.source}\0${pattern.flags}`;
    if (landedRef.current === key) return;
    landedRef.current = key;
    void landRef.current(current, pattern);
  }, [current, pattern, onClear]);

  const step = useCallback((direction: 1 | -1) => {
    if (matches.length === 0) return;
    const from = index === -1 ? (direction === 1 ? -1 : 0) : index;
    const next = matches[(from + direction + matches.length) % matches.length]!;
    landedRef.current = undefined;
    setCurrentKey(matchKey(next));
  }, [matches, index]);
  stepRef.current = step;

  // "Keep looking": page older history in, bounded, until a local match
  // appears. With a server hit it jumps straight to that turn instead.
  const lookBackRef = useRef<AbortController | null>(null);
  useEffect(() => () => { lookBackRef.current?.abort(); }, []);
  useEffect(() => { lookBackRef.current?.abort(); setLookingBack(false); }, [pattern]);
  const lookBack = useCallback(async () => {
    lookBackRef.current?.abort();
    const controller = new AbortController();
    lookBackRef.current = controller;
    setLookingBack(true);
    try {
      if (outside.nearestTurn !== undefined) {
        await onLocateTurn(outside.nearestTurn);
        return;
      }
      for (let page = 0; page < LOOK_BACK_PAGES && !controller.signal.aborted; page += 1) {
        const before = matchesRef.current.length;
        const loaded = await onLoadOlder();
        // Let the new rows project and count.
        await new Promise((resolve) => { setTimeout(resolve, 60); });
        if (!loaded || matchesRef.current.length > before) break;
      }
    } finally {
      if (lookBackRef.current === controller) {
        lookBackRef.current = null;
        setLookingBack(false);
      }
    }
  }, [onLoadOlder, onLocateTurn, outside.nearestTurn]);
  const stopLookBack = () => {
    lookBackRef.current?.abort();
    setLookingBack(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === 'F3') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (lookingBack) stopLookBack();
      else onClose();
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'c' || event.key === 'C')) {
      event.preventDefault();
      setOptions((value) => ({ ...value, caseSensitive: !value.caseSensitive }));
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'w' || event.key === 'W')) {
      event.preventDefault();
      setOptions((value) => ({ ...value, wholeWord: !value.wholeWord }));
    }
  };

  const hasQuery = deferredQuery !== '';
  const total = matches.length;
  const status = !hasQuery
    ? ''
    : total === 0
      ? t('find.noResults')
      : t('find.count', { current: index === -1 ? '–' : String(index + 1), total: String(total) });
  const earlierCount = outside.earlier;
  const canLookBack = hasQuery && hasMoreHistory && (earlierCount > 0 || !outside.known || (total === 0 && outside.more));
  const plus = outside.more ? '+' : '';

  const toggle = (on: boolean) => `${BAR_BUTTON} font-mono text-[11px] font-semibold ${on ? TOGGLE_ON : ''}`;
  return (
    <div
      role="search"
      aria-label={t('find.aria')}
      data-find-bar
      data-find-skip
      className={`anim-enter absolute top-2 right-3 z-20 w-[min(420px,calc(100%-24px))] ${POPOVER_SURFACE_CLASS}`}
    >
      <div className="flex h-10 items-center gap-0.5 pr-1 pl-2.5">
        <Icon name="search" size={14} className="shrink-0 text-ink-faint" />
        <input
          ref={inputRef}
          type="text"
          data-find-input
          value={query}
          maxLength={FIND_QUERY_MAX}
          onChange={(event) => { setQuery(event.target.value); }}
          onKeyDown={onKeyDown}
          placeholder={t('find.placeholder')}
          aria-label={t('find.placeholder')}
          aria-describedby="kiki-find-status"
          spellCheck={false}
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent px-2 text-[13px] text-ink outline-none placeholder:text-ink-faint"
        />
        <span
          id="kiki-find-status"
          role="status"
          aria-live="polite"
          data-find-count
          className={`shrink-0 pr-1.5 text-[12px] tabular-nums whitespace-nowrap ${hasQuery && total === 0 ? 'text-ink-soft' : 'text-ink-faint'}`}
        >
          {status}
        </span>
        <button
          type="button"
          data-find-case
          aria-pressed={options.caseSensitive}
          aria-label={t('find.caseSensitive')}
          title={`${t('find.caseSensitive')} (Alt+C)`}
          onClick={() => { setOptions((value) => ({ ...value, caseSensitive: !value.caseSensitive })); }}
          className={toggle(options.caseSensitive)}
        >
          Aa
        </button>
        <button
          type="button"
          data-find-word
          aria-pressed={options.wholeWord}
          aria-label={t('find.wholeWord')}
          title={`${t('find.wholeWord')} (Alt+W)`}
          onClick={() => { setOptions((value) => ({ ...value, wholeWord: !value.wholeWord })); }}
          className={toggle(options.wholeWord)}
        >
          <span className="underline decoration-1 underline-offset-2">ab</span>
        </button>
        <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-hairline" />
        <button
          type="button"
          data-find-prev
          disabled={total === 0}
          aria-label={t('find.previous')}
          title={`${t('find.previous')} (Shift+Enter)`}
          onClick={() => { step(-1); }}
          className={BAR_BUTTON}
        >
          <Icon name="arrowUp" size={14} />
        </button>
        <button
          type="button"
          data-find-next
          disabled={total === 0}
          aria-label={t('find.next')}
          title={`${t('find.next')} (Enter)`}
          onClick={() => { step(1); }}
          className={BAR_BUTTON}
        >
          <Icon name="arrowDown" size={14} />
        </button>
        <button
          type="button"
          data-find-close
          aria-label={t('find.close')}
          title={`${t('find.close')} (Esc)`}
          onClick={onClose}
          className={BAR_BUTTON}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      {hasQuery && (canLookBack || outside.compacted > 0 || lookingBack) ? (
        <div data-find-note className="flex flex-col gap-0.5 border-t border-hairline px-3 py-1.5 text-[12px] leading-snug text-ink-soft">
          {lookingBack ? (
            <p className="flex items-center gap-2">
              <span className="status-dot-busy h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
              <span className="min-w-0 flex-1">{t('locate.loading')}</span>
              <button type="button" onClick={stopLookBack} className={NOTE_ACTION}>{t('find.stop')}</button>
            </p>
          ) : canLookBack ? (
            <p data-find-earlier className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                {earlierCount > 0 ? t('find.earlier', { count: `${earlierCount}${plus}` }) : t('find.loadedOnly')}
              </span>
              <button type="button" data-find-look-back onClick={() => { void lookBack(); }} className={NOTE_ACTION}>
                {t('find.lookBack')}
              </button>
            </p>
          ) : null}
          {outside.compacted > 0 ? (
            <p data-find-compacted className="flex items-center gap-2">
              <span className="min-w-0 flex-1">{t('find.compacted', { count: `${outside.compacted}${plus}` })}</span>
              <button
                type="button"
                data-find-global
                onClick={() => { requestQuickSwitcherSearch(deferredQuery); }}
                className={NOTE_ACTION}
              >
                {t('find.openGlobal')}
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
