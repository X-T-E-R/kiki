/**
 * QuickSwitcher — the Ctrl+K centered overlay backed by `@base-ui/react/autocomplete`
 * (`inline` + `filter={null}`) over `@kiki/session-core`'s search results. Empty
 * query lists recent sessions; typed queries merge local title/cwd matches,
 * settings matches, and global-search hits (`POST /search`).
 */

import { useDeferredValue, useMemo, useRef, useState } from 'react';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { Session, WorkspaceCatalogEntry } from '@kiki/protocol';

import {
  buildSwitcherItems,
  highlightTerms,
  resolveWorkspaceTerm,
  settingsCardRoute,
  splitByRanges,
  SWITCHER_RECENT_LIMIT,
  SWITCHER_TITLE_MATCH_LIMIT,
  switcherSessionLabel,
  type MatchRange,
  type SwitcherItem,
  type SwitcherSettingItem,
} from '@kiki/session-core/sessions';
import {
  buildSettingsSearchIndex,
  DECISION_JUDGES_ROUTE,
  searchSettings,
  settingsSectionLabels,
} from '@kiki/session-core/settings';
import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../i18n';
import { isImeKeyEvent } from '../lib/shortcuts';
import { getPickerScaleConfig } from '../lib/subagentScaleConfig';
import { pushToast } from '../lib/toasts';
import { useMemoryAdvisor } from './memory/useMemoryAdvisor';
import { useSessionSearch } from '../lib/sessionSearch';
import { Dialog } from './Dialog';
import { useGuardedNavigate } from './dirtyGuard';
import { Icon } from './icons';
import { ThreadTitle } from './ThreadTitle';

const ADVISOR_ACTION = 'memory-advisor-toggle';
const EMPTY_SESSIONS: readonly Session[] = [];
const SWITCHER_LIST_MAX_HEIGHT = 340;
const SWITCHER_EST_ROW_HEIGHT = 50;

interface IndexedSessionRow {
  readonly session: Session;
  readonly titleLower: string;
  readonly cwdLower: string;
  readonly workspaceId: string;
  readonly updatedAt: string;
}

/** O(N * K) top-K recent sessions by `updated_at` descending without sorting all N sessions. */
function selectTopRecentSessions(sessions: readonly Session[], limit: number): Session[] {
  if (sessions.length <= limit) {
    return sessions.toSorted((a, b) => (b.updated_at > a.updated_at ? 1 : b.updated_at < a.updated_at ? -1 : 0));
  }
  const top: Session[] = [];
  for (let i = 0; i < sessions.length; i += 1) {
    const candidate = sessions[i]!;
    if (top.length === limit && candidate.updated_at <= top[limit - 1]!.updated_at) {
      continue;
    }
    let pos = top.length;
    while (pos > 0 && candidate.updated_at > top[pos - 1]!.updated_at) {
      pos -= 1;
    }
    top.splice(pos, 0, candidate);
    if (top.length > limit) top.pop();
  }
  return top;
}

function fastMatchScore(haystack: string, needle: string): number {
  const idx = haystack.indexOf(needle);
  if (idx >= 0) {
    if (idx === 0) return haystack.length === needle.length ? 1000 : 800;
    const prev = haystack.charCodeAt(idx - 1);
    const boundary = prev === 32 || prev === 47 || prev === 92 || prev === 45 || prev === 95 || prev === 46;
    return boundary ? 600 - Math.min(idx, 100) : 400 - Math.min(idx, 100);
  }
  if (needle.length > 24) return -1;
  let hi = 0;
  for (let ni = 0; ni < needle.length; ni += 1) {
    const ch = needle.charCodeAt(ni);
    let found = false;
    while (hi < haystack.length) {
      if (haystack.charCodeAt(hi) === ch) {
        found = true;
        hi += 1;
        break;
      }
      hi += 1;
    }
    if (!found) return -1;
  }
  return 100 - Math.min(hi, 90);
}

/** Single-pass O(N) top-K local session match (avoids sorting 10,000+ matches per keystroke). */
function selectTopLocalSessionMatches(
  indexed: readonly IndexedSessionRow[],
  queryText: string,
  workspaceId: string | undefined,
  workspaceNamesLower: ReadonlyMap<string, string>,
  limit: number,
): Session[] {
  const needle = queryText.trim().toLowerCase();
  if (needle === '') {
    if (workspaceId === undefined) return [];
    const scoped: Session[] = [];
    for (let i = 0; i < indexed.length; i += 1) {
      const row = indexed[i]!;
      if (row.workspaceId !== workspaceId) continue;
      if (scoped.length === limit && row.updatedAt <= scoped[limit - 1]!.updated_at) continue;
      let pos = scoped.length;
      while (pos > 0 && row.updatedAt > scoped[pos - 1]!.updated_at) pos -= 1;
      scoped.splice(pos, 0, row.session);
      if (scoped.length > limit) scoped.pop();
    }
    return scoped;
  }
  const top: { readonly session: Session; readonly score: number; readonly updatedAt: string }[] = [];
  for (let i = 0; i < indexed.length; i += 1) {
    const row = indexed[i]!;
    if (workspaceId !== undefined && row.workspaceId !== workspaceId) continue;
    let score = fastMatchScore(row.titleLower, needle);
    if (score < 0) {
      const cwdScore = fastMatchScore(row.cwdLower, needle);
      if (cwdScore >= 0) score = cwdScore - 200;
    }
    if (score < 0 && workspaceId === undefined) {
      const wsName = workspaceNamesLower.get(row.workspaceId);
      if (wsName !== undefined) {
        const wsScore = fastMatchScore(wsName, needle);
        if (wsScore >= 0) score = wsScore - 400;
      }
    }
    if (score < 0) continue;
    if (top.length === limit) {
      const last = top[limit - 1]!;
      if (score < last.score || (score === last.score && row.updatedAt <= last.updatedAt)) {
        continue;
      }
    }
    let pos = top.length;
    while (pos > 0) {
      const prev = top[pos - 1]!;
      if (score > prev.score || (score === prev.score && row.updatedAt > prev.updatedAt)) {
        pos -= 1;
      } else {
        break;
      }
    }
    top.splice(pos, 0, { session: row.session, score, updatedAt: row.updatedAt });
    if (top.length > limit) top.pop();
  }
  return top.map((entry) => entry.session);
}

interface IndexedSwitcherItem {
  readonly key: string;
  readonly index: number;
  readonly headerText: string | null;
  readonly item: SwitcherItem;
}

function Highlighted({ text, ranges }: { readonly text: string; readonly ranges: readonly MatchRange[] }) {
  if (ranges.length === 0) return <>{text}</>;
  return (
    <>
      {splitByRanges(text, ranges).map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded-[2px] bg-accent-soft px-px text-ink">{part.text}</mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function QuickSwitcher({
  sessions,
  workspaces = [],
  initialQuery,
  onClose,
}: {
  sessions: readonly Session[];
  workspaces?: readonly WorkspaceCatalogEntry[];
  /** Seeds the search (the conversation find bar hands its query over). */
  initialQuery?: string;
  onClose: () => void;
}) {
  const { t, time, locale } = useI18n();
  const navigate = useGuardedNavigate();
  // The advisor switch is a command, not a page: it saves the mode and
  // stays here. While it still needs a source it opens Decision models.
  const advisor = useMemoryAdvisor();
  const advisorNeedsSetup = advisor.view.on && advisor.view.kind === 'unconfigured';
  const advisorTitle = advisor.data === undefined ? undefined
    : advisorNeedsSetup ? t('memory.advisor.setUp')
      : t(advisor.view.on ? 'memory.advisor.turnOff' : 'memory.advisor.turnOn');
  const [input, setInput] = useState(initialQuery ?? '');
  const [includeToolOutput, setIncludeToolOutput] = useState(false);
  const pickerScale = getPickerScaleConfig();
  const listRef = useRef<HTMLDivElement>(null);

  const untitled = t('sidebar.untitled');
  const useFastLocalIndex = sessions.length > pickerScale.fastFilterThreshold;
  const deferredInput = useDeferredValue(input);

  // Pre-compute top-K recent sessions in O(N) once per `sessions` identity so
  // `buildSwitcherItems` never re-sorts 10,000 sessions on every keystroke.
  const recentSessions = useMemo(
    () => selectTopRecentSessions(sessions, SWITCHER_RECENT_LIMIT),
    [sessions],
  );

  // For 10,000-session workspaces, build a pre-lowercased index once per
  // `sessions` array and bypass `useSessionSearch`'s per-render full mapping.
  const indexedSessions = useMemo<readonly IndexedSessionRow[]>(() => {
    if (!useFastLocalIndex) return [];
    const rows = new Array<IndexedSessionRow>(sessions.length);
    for (let i = 0; i < sessions.length; i += 1) {
      const session = sessions[i]!;
      rows[i] = {
        session,
        titleLower: switcherSessionLabel(session, untitled).toLowerCase(),
        cwdLower: session.metadata.cwd.toLowerCase(),
        workspaceId: session.workspace_id,
        updatedAt: session.updated_at,
      };
    }
    return rows;
  }, [useFastLocalIndex, sessions, untitled]);

  const workspaceNamesLower = useMemo(() => {
    const map = new Map<string, string>();
    for (const workspace of workspaces) {
      map.set(workspace.id, workspace.name.toLowerCase());
    }
    return map;
  }, [workspaces]);

  // The same two-layer engine as the sidebar: instant local ranking plus the
  // debounced, abortable content search. When `useFastLocalIndex` is active,
  // local matching runs through the O(N) top-K index below while content search
  // (`POST /search`) stays wired identically.
  const search = useSessionSearch({
    text: input,
    sessions: useFastLocalIndex ? EMPTY_SESSIONS : sessions,
    workspaces,
    untitled,
    queryKeyPrefix: 'quick-switcher-search',
    includeToolOutput,
  });

  const inWorkspaceId = useMemo(
    () => resolveWorkspaceTerm(search.parsed.workspaceTerm, workspaces)?.id,
    [search.parsed.workspaceTerm, workspaces],
  );

  const localMatches = useMemo(() => {
    if (!useFastLocalIndex) {
      return search.parsed.text.trim() === ''
        ? undefined
        : search.local.sessions.map((match) => match.session.source);
    }
    if (deferredInput.trim() === '') return undefined;
    return selectTopLocalSessionMatches(
      indexedSessions,
      search.parsed.text,
      inWorkspaceId,
      workspaceNamesLower,
      SWITCHER_TITLE_MATCH_LIMIT,
    );
  }, [
    useFastLocalIndex,
    search.parsed.text,
    search.local.sessions,
    deferredInput,
    indexedSessions,
    inWorkspaceId,
    workspaceNamesLower,
  ]);
  const usageActionTitle = t('switcher.action.usage');
  const settingsActionTitle = t('switcher.action.settings');
  // The settings index is the same one the settings page searches, so a name
  // that works there works here — and lands on the card, not the section.
  const settingsIndex = useMemo(
    () => buildSettingsSearchIndex(settingsSectionLabels(t), t),
    [t],
  );
  const settingsMatches: SwitcherSettingItem[] = useMemo(
    () =>
      searchSettings(settingsIndex, input).map((entry) => ({
        kind: 'setting',
        cardId: entry.cardId,
        sectionLabel: entry.sectionLabel,
        title: entry.title,
        route: settingsCardRoute(entry.section, entry.cardId, entry.tab),
      })),
    [settingsIndex, input],
  );
  const items = useMemo(
    () =>
      buildSwitcherItems({
        query: input,
        sessions: recentSessions,
        hits: search.hits,
        untitled,
        localMatches,
        actions: [
          {
            actionId: 'usage',
            title: usageActionTitle,
            route: '/usage',
            keywords: ['activity', 'usage', 'live', 'quotas', '运行', '用量', '实时', '额度'],
          },
          { actionId: 'cron', title: t('nav.cron'), route: '/cron' },
          { actionId: 'memory', title: t('nav.memory'), route: '/memory' },
          ...(advisorTitle === undefined ? [] : [{ actionId: ADVISOR_ACTION, title: advisorTitle, route: DECISION_JUDGES_ROUTE }]),
          { actionId: 'settings', title: settingsActionTitle, route: '/settings' },
        ],
        settings: settingsMatches,
      }),
    [
      input,
      recentSessions,
      search.hits,
      localMatches,
      untitled,
      usageActionTitle,
      settingsActionTitle,
      settingsMatches,
      advisorTitle,
      t,
    ],
  );

  const indexedItems = useMemo<readonly IndexedSwitcherItem[]>(() => {
    const firstActionIndex = items.findIndex((item) => item.kind === 'action');
    const firstSessionIndex = items.findIndex((item) => item.kind === 'session');
    const firstHitIndex = items.findIndex((item) => item.kind === 'hit');
    const firstSettingIndex = items.findIndex((item) => item.kind === 'setting');
    return items.map((item, index) => {
      const headerText =
        index === firstActionIndex
          ? t('switcher.pages')
          : index === firstSessionIndex
            ? input.trim() === ''
              ? t('switcher.recent')
              : t('switcher.sessions')
            : index === firstHitIndex
              ? t('switcher.matches')
              : index === firstSettingIndex
                ? t('switcher.settings')
                : null;
      const key =
        item.kind === 'action'
          ? `action-${item.actionId}`
          : item.kind === 'setting'
            ? `setting-${item.cardId}`
            : `${item.kind}-${item.sessionId}-${index}`;
      return { key, index, headerText, item };
    });
  }, [items, input, t]);

  const openItem = (item: SwitcherItem | undefined) => {
    if (item === undefined) return;
    onClose();
    if (item.kind === 'action' && item.actionId === ADVISOR_ACTION && !advisorNeedsSetup) {
      const on = !advisor.view.on;
      void advisor.setOn(on).then(
        () => { pushToast({ tone: 'success', text: t(on ? 'memory.advisor.turnedOn' : 'memory.advisor.turnedOff') }); },
        (error: unknown) => { pushToast({ tone: 'error', text: t('memory.advisor.toggleFailed', { detail: errorText(locale, error) }) }); },
      );
    } else if (item.kind === 'action' || item.kind === 'setting') void navigate(item.route);
    else if (item.kind === 'hit') {
      const route = item.agentId && item.agentId !== 'main'
        ? `/s/${encodeURIComponent(item.sessionId)}/agent/${encodeURIComponent(item.agentId)}`
        : `/s/${encodeURIComponent(item.sessionId)}`;
      const queryParams = new URLSearchParams();
      if (item.turn !== undefined) queryParams.set('turn', String(item.turn));
      if (item.stepId !== undefined && item.stepId !== '') queryParams.set('step', item.stepId);
      const queryText = search.contentQuery.trim() || search.parsed.text.trim();
      if (queryText !== '') queryParams.set('q', queryText);
      const qs = queryParams.toString();
      void navigate(qs === '' ? route : `${route}?${qs}`);
    } else void navigate(`/s/${encodeURIComponent(item.sessionId)}`);
  };

  const searching = search.contentPending;
  // The content layer keeps its own failures: a read that failed or an index
  // this server cannot serve is not "no sessions match". The local title /
  // cwd matches and the typed query stay exactly as they are.
  const contentProblem = search.contentInitialError !== null;
  const unavailable = search.unavailable;
  const searchStatus = input.trim() !== ''
    && (contentProblem || unavailable !== undefined || search.building !== undefined || search.incomplete);

  const isVirtualized = indexedItems.length > pickerScale.selectVirtualizeThreshold;
  const virtualizer = useVirtualizer({
    count: isVirtualized ? indexedItems.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (indexedItems[index]?.headerText !== null ? SWITCHER_EST_ROW_HEIGHT + 24 : SWITCHER_EST_ROW_HEIGHT),
    getItemKey: (index) => indexedItems[index]?.key ?? index,
    overscan: pickerScale.virtualOverscan,
    initialRect: { width: 528, height: SWITCHER_LIST_MAX_HEIGHT },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement;
      if (el === null) return;
      const emit = () => {
        const rect = el.getBoundingClientRect();
        const height = Math.round(rect.height || el.clientHeight);
        const width = Math.round(rect.width || el.clientWidth);
        if (height > 0) cb({ width, height });
      };
      emit();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(emit);
      observer.observe(el);
      return () => { observer.disconnect(); };
    },
    measureElement: (el) => {
      const height = Math.round(el.getBoundingClientRect().height);
      return height > 0 ? height : SWITCHER_EST_ROW_HEIGHT;
    },
    useFlushSync: false,
  });

  const renderEntry = (entry: IndexedSwitcherItem) => {
    const { item, index, headerText } = entry;
    return (
      <>
        {headerText !== null ? (
          <p className={`px-2 pb-0.5 text-[12px] font-medium text-ink-faint ${index === 0 ? 'pt-1' : 'pt-2'}`}>
            {headerText}
          </p>
        ) : null}
        <Autocomplete.Item
          value={entry}
          index={index}
          data-index={index}
          onClick={() => { openItem(item); }}
          className="flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-3 py-1.5 text-left transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] data-[highlighted]:bg-paper data-[highlighted]:shadow-[var(--kiki-sheet-shadow)]"
        >
          {item.kind === 'action' ? (
            <span className="flex items-center gap-2">
              <Icon name="arrowUpRight" size={14} className="text-ink-faint" />
              <span className="truncate text-[13px] font-medium text-ink">
                {item.title}
              </span>
            </span>
          ) : item.kind === 'setting' ? (
            <span className="flex min-w-0 items-center gap-1">
              <span className="shrink-0 text-[12px] text-ink-faint">
                {item.sectionLabel}
              </span>
              <Icon name="chevron" size={12} className="text-ink-faint" />
              <span className="truncate text-[13px] font-medium text-ink">
                {item.title}
              </span>
            </span>
          ) : item.kind === 'session' ? (
            <>
              <span className="truncate text-[13px] font-medium text-ink">
                <ThreadTitle text={item.title} />
              </span>
              <span className="flex items-center gap-1.5 text-[12px] text-ink-faint">
                <span className="truncate">{item.cwd}</span>
                <span className="shrink-0">· {time.relativeTime(item.updatedAt)}</span>
              </span>
            </>
          ) : (
            <>
              <span className="line-clamp-2 text-[12px] leading-snug text-ink">
                <Highlighted text={item.snippet} ranges={highlightTerms(item.snippet, search.contentQuery || search.parsed.text)} />
              </span>
              <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                <span className="truncate">
                  <ThreadTitle text={item.sessionTitle.trim() !== '' ? item.sessionTitle : untitled} />
                </span>
                {item.turn !== undefined ? (
                  <span data-switcher-hit-turn className="shrink-0 rounded bg-ink/[0.06] px-1 py-px font-mono text-[10.5px] text-ink-soft tabular-nums">
                    #{item.turn}
                  </span>
                ) : null}
                {item.agentId !== undefined && item.agentId !== '' && item.agentId !== 'main' ? (
                  <span data-switcher-hit-agent className="max-w-28 shrink-0 truncate rounded bg-ink/[0.06] px-1 py-px font-mono text-[10.5px] text-ink-soft">
                    {item.agentId}
                  </span>
                ) : null}
                <span className="shrink-0">· {t(item.role === 'tool' ? 'search.toolOutput' : `sidebar.results.role.${item.role}`)}</span>
              </span>
            </>
          )}
        </Autocomplete.Item>
      </>
    );
  };

  return (
    <Dialog
      onClose={onClose}
      ariaLabel={t('switcher.aria')}
      overlayId="quick-switcher"
      panelClassName="anim-enter w-full max-w-[560px] overflow-hidden rounded-2xl border border-hairline bg-panel shadow-[0_16px_48px_-16px_rgb(var(--kiki-shadow-ink)/0.35)]"
    >
      <Autocomplete.Root
        inline
        open
        filter={null}
        autoHighlight="always"
        keepHighlight
        loopFocus
        items={indexedItems}
        value={input}
        itemToStringValue={(entry) => entry.key}
        onValueChange={(nextValue, eventDetails) => {
          if (eventDetails.reason === 'input-change' || eventDetails.reason === 'input-clear') {
            setInput(nextValue);
          }
        }}
        onOpenChange={(nextOpen, eventDetails) => {
          if (!nextOpen && eventDetails.reason === 'escape-key') {
            onClose();
          }
        }}
      >
        <div className="border-b border-hairline px-4 py-3">
          <Autocomplete.Input
            type="text"
            data-autofocus
            placeholder={t('switcher.placeholder')}
            aria-label={t('switcher.aria')}
            onKeyDown={(event) => {
              // Enter and the arrows belong to an open IME candidate window.
              if (isImeKeyEvent(event)) {
                event.preventBaseUIHandler();
              }
            }}
            className="w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-faint"
          />
          <label className="mt-2 flex w-fit cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-within:outline-2 focus-within:outline-selected-ink">
            <input
              type="checkbox"
              data-search-tools
              checked={includeToolOutput}
              onChange={(event) => { setIncludeToolOutput(event.target.checked); }}
              className="accent-selected-ink"
            />
            {t('search.includeToolOutput')}
          </label>
        </div>

        <Autocomplete.List
          ref={listRef}
          id="quick-switcher-list"
          className="max-h-[340px] overflow-y-auto p-2"
        >
          {indexedItems.length === 0 ? (
            // A content-layer problem is stated below instead: never claim the
            // search found nothing when it did not finish.
            searchStatus ? null : (
              <p className="px-2 py-6 text-center text-[12px] text-ink-faint">
                {searching ? t('sidebar.searching') : input.trim() === '' ? t('switcher.empty') : t('switcher.noMatches', { query: input.trim() })}
              </p>
            )
          ) : isVirtualized ? (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((row) => {
                const entry = indexedItems[row.index];
                if (entry === undefined) return null;
                return (
                  <div
                    key={row.key}
                    data-index={row.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${row.start}px)`,
                    }}
                  >
                    {renderEntry(entry)}
                  </div>
                );
              })}
            </div>
          ) : (
            indexedItems.map((entry) => (
              <div key={entry.key}>
                {renderEntry(entry)}
              </div>
            ))
          )}
          {searchStatus ? (
            <div data-switcher-search-status className="border-t border-hairline px-2 pt-1.5 pb-0.5 text-[12px] leading-snug text-ink-faint">
              {contentProblem ? (
                <div data-search-error className="mx-1 border-l-2 border-danger py-0.5 pl-3">
                  <p className="text-[12.5px] font-medium text-danger">{t('sidebar.searchFailed')}</p>
                  <p className="text-[12px] text-ink-soft">{search.contentInitialError?.message || t('common.unknownError')}</p>
                  <button
                    type="button"
                    data-search-initial-retry
                    onClick={search.retry}
                    className="mt-1 text-[12px] font-medium text-ink underline underline-offset-2"
                  >
                    {t('common.retry')}
                  </button>
                </div>
              ) : null}
              {unavailable !== undefined ? (
                <p data-search-unavailable role="status" className="px-2">
                  {t(`sidebar.results.unavailable.${unavailable.reason ?? 'generic'}`)}
                  {unavailable.reason !== 'disabled' && unavailable.reason !== 'runtime_disabled' ? (
                    <button
                      type="button"
                      data-search-unavailable-retry
                      onClick={() => { void search.retryUnavailable().catch(() => search.retry()); }}
                      className="ml-2 font-medium text-ink underline underline-offset-2"
                    >
                      {t('common.retry')}
                    </button>
                  ) : null}
                </p>
              ) : null}
              {search.building !== undefined ? (
                <p data-search-building className="px-2">
                  {t('sidebar.results.building', { indexed: search.building.indexed_sessions, total: search.building.total_sessions })}
                </p>
              ) : null}
              {search.incomplete ? (
                <p data-search-incomplete className="px-2">{t('sidebar.results.incomplete')}</p>
              ) : null}
            </div>
          ) : null}
        </Autocomplete.List>
      </Autocomplete.Root>

      <div className="border-t border-hairline px-4 py-2 text-[11px] text-ink-faint">
        {t('switcher.hint')}
      </div>
    </Dialog>
  );
}
