/**
 * Activity — the paper-and-ink triage desk and live-pulse board.
 *
 * Three ordered streams, built from the session list the app already polls plus
 * local seen-marks (zero extra list requests):
 *   1. `needsYou` — blocked on an approval, question, or room budget, sorted
 *      longest-wait-first; session approvals and questions can be answered
 *      inline via a bounded concurrency-2 detail fetcher without leaving the
 *      triage desk.
 *   2. `unread`   — finished, failed, or cancelled runs not yet opened, sorted
 *      newest-first, with single-row mark-as-read (`x`) and bulk clear.
 *   3. `running`  — active background sessions currently executing, sorted most
 *      recent activity first.
 *
 * `?view=comms` switches to the cross-thread message log (`ActivityComms`).
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { PersonaSummary, RoomListItem, Session } from '@kiki/protocol';
import {
  buildConversationInbox,
  filterInboxModel,
  nextCursorAfterDismiss,
  roomRefLink,
  sessionAttentionCursor,
  stepInboxCursor,
  type InboxItem,
  type InboxReason,
  type InboxTriageFilter,
} from '@kiki/session-core/sessions';
import {
  encodeConversationRef,
  markConversationsSeen,
  markSessionsSeen,
  roomSeenKey,
  sessionSeenSnapshot,
  subscribeSessionSeen,
  type AttentionCursor,
  type ConversationRef,
  type SessionSeenMap,
} from '@kiki/session-core/settings';

import { useI18n } from '../i18n';
import { beginExplicitConversationOpen, useConversationSeen } from '../lib/conversationOpen';
import { pushToast } from '../lib/toasts';
import { useOptionalConnection } from '../state/connection';
import {
  ActivityInlineDecisionStrip,
  activityInlineQueryKey,
  canInlineTriageSession,
  type ActivityInlineDetail,
  type ActivityThreadTarget,
} from './activity/ActivityInlineDecisionStrip';
import { isLongWait, shortModelLabel } from './activity/activityTriageLimiter';
import { ActivityComms } from './comms/ActivityComms';
import { useGuardedNavigate } from './dirtyGuard';
import { DisclosureChevron, Icon } from './icons';
import { LifeMark } from './LifeMark';
import { PAGE_WIDTH, PageHeader, useWorkspaceScope } from './PageChrome';
import { PERSONAS_QUERY_KEY } from './persona/usePersonas';
import { RelativeTime } from './RelativeTime';
import { ThreadTitle } from './ThreadTitle';
import { getPickerScaleConfig } from '../lib/subagentScaleConfig';
import { segmentClass, WorkspaceScopeControl } from './WorkspaceScopeControl';

type ActivityView = 'inbox' | 'comms';
export const ACTIVITY_VIRTUALIZE_THRESHOLD = getPickerScaleConfig().catalogVirtualizeThreshold;

type FlatActivityRow =
  | {
      readonly kind: 'header';
      readonly key: string;
      readonly groupKey: 'needs-you' | 'unread' | 'running';
      readonly title: string;
      readonly hint: string;
      readonly count: number;
      readonly isFirst: boolean;
      readonly action?: ReactNode;
    }
  | {
      readonly kind: 'item';
      readonly key: string;
      readonly groupKey: 'needs-you' | 'unread' | 'running';
      readonly item: InboxItem;
      readonly dismissible: boolean;
    };

const VALID_FILTERS = new Set<InboxTriageFilter>(['all', 'needs-you', 'unread', 'running']);

export function useSessionSeen() {
  return useSyncExternalStore(subscribeSessionSeen, sessionSeenSnapshot, sessionSeenSnapshot);
}

const REASON_LABEL: Record<InboxReason, string> = {
  approval: 'activity.reason.approval',
  question: 'activity.reason.question',
  budget: 'activity.reason.budget',
  interrupted: 'activity.reason.interrupted',
  completed: 'activity.reason.completed',
  failed: 'activity.reason.failed',
  cancelled: 'activity.reason.cancelled',
  running: 'activity.reason.running',
};

function itemHref(item: InboxItem, target?: ActivityThreadTarget): string {
  if (item.roomId !== undefined) return roomRefLink(item.roomId);
  const base = `/s/${encodeURIComponent(item.sessionId)}`;
  const agentSegment = target?.agentId !== undefined && target.agentId !== '' && target.agentId !== 'main'
    ? `/agent/${encodeURIComponent(target.agentId)}`
    : '';
  const query = target?.interactionId !== undefined && target.interactionId !== ''
    ? `?interaction=${encodeURIComponent(target.interactionId)}`
    : '';
  return `${base}${agentSegment}${query}`;
}

function cachedInteractionTarget(queryClient: QueryClient, item: InboxItem): ActivityThreadTarget | undefined {
  if (item.roomId !== undefined || (item.reason !== 'approval' && item.reason !== 'question')) return undefined;
  const cached = queryClient.getQueryData<ActivityInlineDetail>(
    activityInlineQueryKey(item.sessionId, item.reason, item.lastSeq),
  );
  if (cached?.kind === 'approval') {
    const first = cached.approvals[0];
    return first === undefined ? undefined : { agentId: first.agent_id, interactionId: first.approval_id };
  }
  if (cached?.kind === 'question') {
    const first = cached.questions[0];
    if (first === undefined) return undefined;
    const agentId = (first as typeof first & { readonly agent_id?: string }).agent_id;
    return { agentId, interactionId: first.question_id };
  }
  return undefined;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return target.closest('[role="dialog"], [role="menu"], [role="listbox"]') !== null;
}

function ReasonMark({ item }: { item: InboxItem }) {
  const waiting = item.reason === 'approval' || item.reason === 'question' || item.reason === 'budget';
  const life = waiting
    ? 'waiting'
    : item.reason === 'running'
      ? 'working'
      : item.reason === 'completed'
        ? 'done'
        : 'failed';
  return (
    <span className="flex h-[19px] w-[7px] shrink-0 items-center">
      <LifeMark
        markId={`activity:${item.sessionId}`}
        life={life}
        tone={item.reason === 'cancelled' ? 'bg-amber-rule' : undefined}
        still={item.reason !== 'running'}
      />
    </span>
  );
}

function InboxRow({
  item,
  workspaceName,
  personaLabel,
  focused,
  expanded,
  canExpandInline,
  suppressAutoScroll = false,
  bare = false,
  onFocusRow,
  onToggleExpand,
  onDismiss,
  onOpen,
}: {
  item: InboxItem;
  workspaceName: string | undefined;
  personaLabel: string | undefined;
  focused: boolean;
  expanded: boolean;
  canExpandInline: boolean;
  suppressAutoScroll?: boolean;
  bare?: boolean;
  onFocusRow: () => void;
  onToggleExpand?: () => void;
  onDismiss?: () => void;
  onOpen: (href: string) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const waiting = item.reason === 'approval' || item.reason === 'question' || item.reason === 'budget';
  const failed = item.reason === 'failed';
  const urgentWait = waiting && isLongWait(item.at);
  const modelShort = shortModelLabel(item.model);

  useEffect(() => {
    if (focused && !suppressAutoScroll) {
      rowRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [focused, suppressAutoScroll]);

  const body = (
    <div
      ref={rowRef}
      data-activity-item={item.sessionId}
      data-activity-reason={item.reason}
      data-activity-focused={focused ? 'true' : undefined}
      onMouseEnter={onFocusRow}
      className={`group rounded-lg px-2 py-1 transition-colors ${
        focused ? 'bg-ink/[0.045]' : 'hover:bg-ink/[0.03]'
      }`}
    >
        <div className="flex min-h-10 items-start gap-1.5">
          <button
            type="button"
            data-activity-open={item.sessionId}
            onFocus={onFocusRow}
            onClick={() => { onOpen(itemHref(item, cachedInteractionTarget(queryClient, item))); }}
            className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-1 py-0.5 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
          >
            <ReasonMark item={item} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                {personaLabel !== undefined && personaLabel !== '' ? (
                  <span
                    data-activity-persona={item.personaId}
                    className="max-w-32 shrink-0 truncate rounded bg-ink/[0.055] px-1.5 py-px text-[11px] leading-4 font-medium text-ink-soft"
                  >
                    {personaLabel}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-[13px] leading-[19px] font-medium text-ink">
                  <ThreadTitle text={item.title.trim() === '' ? t('sidebar.untitled') : item.title} />
                </span>
                <RelativeTime
                  at={item.at}
                  className={`shrink-0 text-[12px] leading-4 tabular-nums ${
                    urgentWait ? 'font-medium text-accent-deep' : 'text-ink-faint'
                  }`}
                />
              </span>
              <span className="mt-px flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-faint">
                <span
                  className={`shrink-0 ${
                    waiting
                      ? 'font-medium text-accent-deep'
                      : failed
                        ? 'font-medium text-danger'
                        : item.reason === 'running'
                          ? 'font-medium text-ink-soft'
                          : ''
                  }`}
                >
                  {t(REASON_LABEL[item.reason] as 'activity.reason.approval')}
                </span>
                {workspaceName !== undefined && workspaceName !== '' ? (
                  <span data-activity-workspace className="min-w-0 truncate">· {workspaceName}</span>
                ) : null}
                {item.reason === 'running' && modelShort !== undefined ? (
                  <span className="hidden truncate sm:inline">· {modelShort}</span>
                ) : null}
                {item.turnCount !== undefined && item.reason === 'running' ? (
                  <span className="hidden shrink-0 tabular-nums sm:inline">
                    · {t(item.turnCount === 1 ? 'activity.turns.one' : 'activity.turns.other', { count: item.turnCount })}
                  </span>
                ) : null}
              </span>
              {item.preview !== undefined ? (
                <span data-activity-preview className="mt-px block truncate text-[12px] leading-4 text-ink-soft">
                  {item.preview}
                </span>
              ) : null}
            </span>
          </button>

          <div className="mt-0.5 flex w-7 pointer-coarse:w-9 shrink-0 items-center justify-center">
            {canExpandInline && onToggleExpand !== undefined ? (
              <button
                type="button"
                data-activity-expand={item.sessionId}
                aria-expanded={expanded}
                aria-label={t(expanded ? 'activity.collapseDecision' : 'activity.expandDecision')}
                title={t(expanded ? 'activity.collapseDecision' : 'activity.expandDecision')}
                onClick={onToggleExpand}
                className="inline-flex h-7 w-7 pointer-coarse:h-9 pointer-coarse:w-9 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
              >
                <DisclosureChevron open={expanded} size={12} />
              </button>
            ) : onDismiss !== undefined ? (
              <button
                type="button"
                data-activity-dismiss={item.sessionId}
                aria-label={t('activity.markReadShortcut')}
                title={t('activity.markReadShortcut')}
                onClick={onDismiss}
                className={`inline-flex h-7 w-7 pointer-coarse:h-9 pointer-coarse:w-9 items-center justify-center rounded-md text-ink-faint transition-[opacity,background-color,color] hover:bg-ink/[0.06] hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink [@media(hover:none)]:opacity-100 ${
                  focused ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                <Icon name="check" size={14} />
              </button>
            ) : (
              <span
                aria-hidden="true"
                className={`inline-flex h-7 w-7 pointer-coarse:h-9 pointer-coarse:w-9 items-center justify-center text-ink-faint transition-[opacity,transform,color] group-hover:translate-x-0.5 group-hover:opacity-100 [@media(hover:none)]:opacity-60 ${
                  focused ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <Icon name="arrowRight" size={12} />
              </span>
            )}
          </div>
        </div>

        {canExpandInline && expanded && (item.reason === 'approval' || item.reason === 'question') ? (
          <ActivityInlineDecisionStrip
            sessionId={item.sessionId}
            reason={item.reason}
            lastSeq={item.lastSeq}
            onOpenThread={(target) => { onOpen(itemHref(item, target)); }}
          />
        ) : null}
    </div>
  );
  return bare ? body : <li>{body}</li>;
}

function InboxGroup({
  title,
  hint,
  items,
  workspaceNames,
  personaNames,
  focusedSessionId,
  expandedIds,
  canInlineFor,
  dismissible,
  onFocusItem,
  onToggleExpand,
  onDismissItem,
  onOpen,
  hook,
  action,
}: {
  title: string;
  hint: string;
  items: readonly InboxItem[];
  workspaceNames: ReadonlyMap<string, string>;
  personaNames: ReadonlyMap<string, string>;
  focusedSessionId: string | undefined;
  expandedIds: ReadonlySet<string>;
  canInlineFor: (item: InboxItem) => boolean;
  dismissible?: boolean;
  onFocusItem: (sessionId: string) => void;
  onToggleExpand: (sessionId: string) => void;
  onDismissItem: (item: InboxItem) => void;
  onOpen: (href: string) => void;
  hook: Record<string, string>;
  action?: ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <section {...hook} aria-label={title} className="flex flex-col gap-0.5">
      <div className="flex h-7 items-center gap-1.5 px-3 text-[12px] leading-4">
        <h2 className="shrink-0 font-medium text-ink-soft">{title}</h2>
        <span className="shrink-0 text-ink-faint tabular-nums">{items.length}</span>
        <span aria-hidden className="hidden text-ink-faint sm:inline">·</span>
        <span className="hidden min-w-0 flex-1 truncate text-ink-faint sm:inline">{hint}</span>
        <span className="flex-1 sm:hidden" />
        {action}
      </div>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => {
          const canExpandInline = canInlineFor(item);
          const personaLabel = item.personaName ?? (item.personaId !== undefined ? personaNames.get(item.personaId) : undefined);
          return (
            <InboxRow
              key={`${item.reason}:${item.sessionId}`}
              item={item}
              workspaceName={workspaceNames.get(item.workspaceId)}
              personaLabel={personaLabel}
              focused={focusedSessionId === item.sessionId}
              expanded={expandedIds.has(item.sessionId)}
              canExpandInline={canExpandInline}
              onFocusRow={() => { onFocusItem(item.sessionId); }}
              onToggleExpand={canExpandInline ? () => { onToggleExpand(item.sessionId); } : undefined}
              onDismiss={dismissible === true ? () => { onDismissItem(item); } : undefined}
              onOpen={onOpen}
            />
          );
        })}
      </ul>
    </section>
  );
}

export interface ActivityPageProps {
  readonly sessions: readonly Session[];
  readonly rooms?: readonly RoomListItem[];
  readonly workspaceOptions: readonly { readonly id: string; readonly name: string; readonly root?: string }[];
  readonly onToggleSidebar: () => void;
}

export function ActivityPage({ sessions, rooms = [], workspaceOptions, onToggleSidebar }: ActivityPageProps) {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const connection = useOptionalConnection();
  const spaceKey = connection?.spaceKey ?? 'main';
  const legacySeen = useSessionSeen();
  const seenV2 = useConversationSeen();
  const seen = useMemo<SessionSeenMap>(() => {
    const merged: Record<string, number> = { ...legacySeen };
    let changed = false;
    for (const session of sessions) {
      const key = encodeConversationRef({ spaceKey, kind: 'session', id: session.id });
      const rec = seenV2[key];
      if (rec !== undefined && merged[session.id] !== rec.seq) {
        merged[session.id] = rec.seq;
        changed = true;
      }
    }
    for (const room of rooms) {
      const key = encodeConversationRef({ spaceKey, kind: 'room', id: room.id });
      const rec = seenV2[key];
      const roomKey = roomSeenKey(room.id);
      if (rec !== undefined && merged[roomKey] !== rec.seq) {
        merged[roomKey] = rec.seq;
        changed = true;
      }
    }
    return changed ? merged : legacySeen;
  }, [legacySeen, seenV2, sessions, rooms, spaceKey]);

  const rawModel = useMemo(
    () => buildConversationInbox(sessions, rooms, seen, workspaceOptions),
    [sessions, rooms, seen, workspaceOptions],
  );
  const workspaceNames = useMemo(
    () => new Map(workspaceOptions.map((workspace) => [workspace.id, workspace.name])),
    [workspaceOptions],
  );

  const canQueryPersonas = typeof connection?.client?.listPersonas === 'function';
  const personasQuery = useQuery({
    queryKey: [...PERSONAS_QUERY_KEY, { includeArchived: false }],
    queryFn: () => connection!.client.listPersonas({ includeArchived: false }),
    enabled: canQueryPersonas,
    staleTime: 60_000,
  });
  const personaNames = useMemo(() => {
    const map = new Map<string, string>();
    const items: readonly PersonaSummary[] = personasQuery.data ?? [];
    for (const persona of items) {
      if (persona.name.trim() !== '') map.set(persona.id, persona.name.trim());
    }
    return map;
  }, [personasQuery.data]);

  const [params, setParams] = useSearchParams();
  const view: ActivityView = params.get('view') === 'comms' ? 'comms' : 'inbox';
  const rawFilter = params.get('filter') as InboxTriageFilter | null;
  const filter: InboxTriageFilter = rawFilter !== null && VALID_FILTERS.has(rawFilter) ? rawFilter : 'all';
  const { scope, setScope } = useWorkspaceScope(workspaceOptions);

  const scopedAll = useMemo(
    () => filterInboxModel(rawModel, { workspaceId: scope, filter: 'all' }),
    [rawModel, scope],
  );
  const model = useMemo(
    () => filterInboxModel(rawModel, { workspaceId: scope, filter }),
    [rawModel, scope, filter],
  );

  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const [manualExpanded, setManualExpanded] = useState<Readonly<Record<string, boolean>>>({});

  const canInlineFor = (item: InboxItem): boolean =>
    item.roomId === undefined &&
    (item.reason === 'approval' || item.reason === 'question') &&
    canInlineTriageSession(connection?.client, item.reason);

  const firstExpandableId = useMemo(
    () => model.needsYou.find((item) => canInlineFor(item))?.sessionId,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model.needsYou, connection?.client],
  );

  const expandedIds = useMemo(() => {
    const out = new Set<string>();
    if (firstExpandableId !== undefined && manualExpanded[firstExpandableId] !== false) {
      out.add(firstExpandableId);
    }
    for (const [id, isOpen] of Object.entries(manualExpanded)) {
      if (isOpen) out.add(id);
    }
    return out;
  }, [firstExpandableId, manualExpanded]);

  const visibleItemById = useMemo(
    () => new Map(model.visibleItems.map((item) => [item.sessionId, item])),
    [model.visibleItems],
  );
  const activeFocusedId = useMemo(() => {
    if (focusedId !== undefined && visibleItemById.has(focusedId)) {
      return focusedId;
    }
    return undefined;
  }, [focusedId, visibleItemById]);

  const toggleExpand = (sessionId: string) => {
    setManualExpanded((prev) => {
      const currentlyOpen = expandedIds.has(sessionId);
      return { ...prev, [sessionId]: !currentlyOpen };
    });
  };

  const chooseView = (next: ActivityView) => {
    const updated = new URLSearchParams(params);
    if (next === 'inbox') {
      updated.delete('view');
    } else {
      updated.set('view', next);
      updated.delete('filter');
    }
    setParams(updated, { replace: true });
  };

  const chooseFilter = (next: InboxTriageFilter) => {
    const updated = new URLSearchParams(params);
    if (next === 'all') updated.delete('filter');
    else updated.set('filter', next);
    setParams(updated, { replace: true });
  };

  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const roomById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);

  const cursorForItem = (item: InboxItem): { readonly ref: ConversationRef; readonly cursor: AttentionCursor } => {
    if (item.roomId !== undefined) {
      return {
        ref: { spaceKey, kind: 'room', id: item.roomId },
        cursor: { seq: Math.max(0, Math.trunc(item.lastSeq)) },
      };
    }
    const session = sessionById.get(item.sessionId);
    return {
      ref: { spaceKey, kind: 'session', id: item.sessionId },
      cursor: session !== undefined ? sessionAttentionCursor(session) : { seq: Math.max(0, Math.trunc(item.lastSeq)) },
    };
  };

  const open = (href: string) => {
    const sessionMatch = /^\/s\/([^/?#]+)/.exec(href);
    const roomMatch = /^\/rooms\/([^/?#]+)/.exec(href);
    let handle: { commit(): void; cancel(): void } | undefined;
    if (sessionMatch?.[1] !== undefined) {
      const id = decodeURIComponent(sessionMatch[1]);
      const session = sessionById.get(id);
      if (session !== undefined) {
        handle = beginExplicitConversationOpen(
          { spaceKey, kind: 'session', id },
          sessionAttentionCursor(session),
          { syncLegacy: true },
        );
      }
    } else if (roomMatch?.[1] !== undefined) {
      const id = decodeURIComponent(roomMatch[1]);
      const room = roomById.get(id);
      if (room !== undefined) {
        handle = beginExplicitConversationOpen(
          { spaceKey, kind: 'room', id },
          { seq: Math.max(0, Math.trunc(room.lastSeq)) },
          { syncLegacy: true },
        );
      }
    }
    void navigate(href, undefined, () => { handle?.cancel(); });
  };

  const dismissOne = (item: InboxItem) => {
    const nextCursor = nextCursorAfterDismiss(model.visibleItems, item.sessionId);
    const { ref, cursor } = cursorForItem(item);
    markConversationsSeen([{ ref, cursor }]);
    markSessionsSeen([{ sessionId: item.sessionId, lastSeq: cursor.seq }]);
    if (activeFocusedId === item.sessionId) {
      setFocusedId(nextCursor);
    }
  };

  const markAllRead = () => {
    const entries = scopedAll.unread.map(cursorForItem);
    markConversationsSeen(entries);
    markSessionsSeen(scopedAll.unread.map((item, idx) => ({
      sessionId: item.sessionId,
      lastSeq: entries[idx]?.cursor.seq ?? item.lastSeq,
    })));
    pushToast({ tone: 'success', text: t('activity.markAllReadDone') });
  };

  useEffect(() => {
    if (view !== 'inbox') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableElement(event.target)) return;
      const items = model.visibleItems;
      if (items.length === 0) return;

      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        setFocusedId((current) => stepInboxCursor(items, current, 1));
        return;
      }
      if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        setFocusedId((current) => stepInboxCursor(items, current, -1));
        return;
      }
      const currentId = activeFocusedId ?? items[0]?.sessionId;
      const currentItem = currentId === undefined ? undefined : visibleItemById.get(currentId);
      if (currentItem === undefined) return;

      if (event.key === 'x') {
        const isUnread =
          currentItem.reason === 'completed' ||
          currentItem.reason === 'failed' ||
          currentItem.reason === 'cancelled';
        if (isUnread) {
          event.preventDefault();
          dismissOne(currentItem);
        }
        return;
      }

      const onInteractiveTarget =
        event.target instanceof HTMLElement &&
        event.target.closest('button, a') !== null;
      if (onInteractiveTarget) return;

      if (event.key === 'Enter') {
        event.preventDefault();
        open(itemHref(currentItem, cachedInteractionTarget(queryClient, currentItem)));
        return;
      }
      if (event.key === ' ' && canInlineFor(currentItem)) {
        event.preventDefault();
        toggleExpand(currentItem.sessionId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, model.visibleItems, activeFocusedId, expandedIds, connection?.client]);

  const allCount = scopedAll.needsYou.length + scopedAll.unread.length + scopedAll.running.length;
  const filterOptions: readonly {
    readonly key: InboxTriageFilter;
    readonly labelKey:
      | 'activity.filter.all'
      | 'activity.filter.needsYou'
      | 'activity.filter.unread'
      | 'activity.filter.running';
    readonly count: number;
  }[] = [
    { key: 'all', labelKey: 'activity.filter.all', count: allCount },
    { key: 'needs-you', labelKey: 'activity.filter.needsYou', count: scopedAll.needsYou.length },
    { key: 'unread', labelKey: 'activity.filter.unread', count: scopedAll.unread.length },
    { key: 'running', labelKey: 'activity.filter.running', count: scopedAll.running.length },
  ];

  const showNeedsYou = filter === 'all' || filter === 'needs-you';
  const showUnread = filter === 'all' || filter === 'unread';
  const showRunning = filter === 'all' || filter === 'running';

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const windowed = view === 'inbox' && model.visibleItems.length > getPickerScaleConfig().catalogVirtualizeThreshold;
  const markAllReadAction = (
    <button
      type="button"
      data-activity-mark-all-read
      onClick={markAllRead}
      className="-my-1 shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:py-2"
    >
      {t('activity.markAllRead')}
    </button>
  );
  const flatRows = useMemo<readonly FlatActivityRow[]>(() => {
    if (!windowed) return [];
    const out: FlatActivityRow[] = [];
    const pushGroup = (
      groupKey: 'needs-you' | 'unread' | 'running',
      title: string,
      hint: string,
      items: readonly InboxItem[],
      dismissible: boolean,
      action?: ReactNode,
    ) => {
      if (items.length === 0) return;
      out.push({
        kind: 'header',
        key: `hdr:${groupKey}`,
        groupKey,
        title,
        hint,
        count: items.length,
        isFirst: out.length === 0,
        action,
      });
      for (const item of items) {
        out.push({
          kind: 'item',
          key: `${item.reason}:${item.sessionId}`,
          groupKey,
          item,
          dismissible,
        });
      }
    };
    if (showNeedsYou) {
      pushGroup('needs-you', t('activity.needsYou'), t('activity.needsYouOrder'), model.needsYou, false);
    }
    if (showUnread) {
      pushGroup('unread', t('activity.unread'), t('activity.unreadOrder'), model.unread, true, markAllReadAction);
    }
    if (showRunning) {
      pushGroup('running', t('activity.runningGroup'), t('activity.runningOrder'), model.running, false);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowed, showNeedsYou, showUnread, showRunning, model.needsYou, model.unread, model.running, t]);

  const activityVirtualizer = useVirtualizer({
    count: windowed ? flatRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = flatRows[index];
      if (row === undefined) return 60;
      if (row.kind === 'header') return row.isFirst ? 30 : 44;
      return expandedIds.has(row.item.sessionId) ? 140 : 60;
    },
    getItemKey: (index) => flatRows[index]?.key ?? index,
    overscan: 8,
    initialRect: { width: 720, height: 640 },
    measureElement: (element, _entry, instance) => {
      const height = Math.round(element.getBoundingClientRect().height);
      return height > 0 ? height : instance.options.estimateSize(Number(element.getAttribute('data-index') ?? 0));
    },
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
    useFlushSync: false,
  });

  useEffect(() => {
    if (!windowed || activeFocusedId === undefined) return;
    const index = flatRows.findIndex((row) => row.kind === 'item' && row.item.sessionId === activeFocusedId);
    if (index >= 0) activityVirtualizer.scrollToIndex(index, { align: 'auto' });
  }, [windowed, activeFocusedId, flatRows, activityVirtualizer]);

  return (
    <div data-activity-page data-activity-view={view} className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
      <PageHeader title={t('nav.activity')} onToggleSidebar={onToggleSidebar} width="reading" />
      <div className="shrink-0 px-4 pb-2 lg:px-6">
        <div className={`mx-auto flex w-full ${PAGE_WIDTH.reading} flex-wrap items-center gap-x-3 gap-y-2`}>
          <div
            role="group"
            aria-label={t('activity.viewAria')}
            data-activity-views
            className="flex items-center gap-0.5 rounded-[9px] border border-hairline bg-paper p-0.5"
          >
            {(['inbox', 'comms'] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                data-activity-view-option={candidate}
                aria-pressed={view === candidate}
                onClick={() => { chooseView(candidate); }}
                className={segmentClass(view === candidate, 'h-7 px-3 text-[13px]')}
              >
                {t(candidate === 'inbox' ? 'activity.view.inbox' : 'activity.view.comms')}
              </button>
            ))}
          </div>

          {view === 'inbox' && (allCount > 0 || filter !== 'all') ? (
            <div
              role="group"
              aria-label={t('activity.filterAria')}
              data-activity-filters
              className="flex flex-wrap items-center gap-1"
            >
              {filterOptions.map((opt) => {
                const active = filter === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    data-activity-filter={opt.key}
                    aria-pressed={active}
                    onClick={() => { chooseFilter(opt.key); }}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
                      active
                        ? 'bg-ink/[0.07] font-medium text-ink'
                        : 'text-ink-soft hover:bg-ink/[0.035] hover:text-ink'
                    }`}
                  >
                    {opt.key === 'needs-you' && opt.count > 0 ? (
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
                    ) : null}
                    <span>{t(opt.labelKey)}</span>
                    {opt.count > 0 ? (
                      <span className="text-[11.5px] text-ink-faint tabular-nums">{opt.count}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          {workspaceOptions.length > 1 && (view === 'comms' || rawModel.total + rawModel.running.length > 0 || scope !== undefined) ? (
            <WorkspaceScopeControl
              workspaces={workspaceOptions}
              value={scope}
              onChange={setScope}
              dataAttribute="data-activity-scope"
            />
          ) : null}

          {view === 'inbox' && model.visibleItems.length > 0 ? (
            <span
              data-activity-shortcuts-hint
              className="ml-auto hidden text-[11.5px] leading-4 text-ink-faint lg:inline"
            >
              {t('activity.shortcutsHint')}
            </span>
          ) : null}
        </div>
      </div>

      <div ref={scrollRef} data-activity-scroll className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 lg:px-6">
        {view === 'comms' ? (
          <div className={`mx-auto flex w-full ${PAGE_WIDTH.reading} flex-col gap-3 pt-1`}>
            <ActivityComms workspaceId={scope} workspaceNames={workspaceNames} onOpen={open} />
          </div>
        ) : windowed ? (
          <div className={`mx-auto flex w-full ${PAGE_WIDTH.reading} flex-col pt-1`}>
            <ul
              data-activity-virtualized="true"
              className="relative"
              style={{ height: activityVirtualizer.getTotalSize() }}
            >
              {activityVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = flatRows[virtualRow.index];
                if (row === undefined) return null;
                if (row.kind === 'header') {
                  return (
                    <li
                      key={row.key}
                      data-index={virtualRow.index}
                      ref={activityVirtualizer.measureElement}
                      data-activity-group={row.groupKey}
                      className={`absolute inset-x-0 ${row.isFirst ? '' : 'pt-3.5'}`}
                      style={{ top: virtualRow.start }}
                    >
                      <div className="flex h-7 items-center gap-1.5 px-3 text-[12px] leading-4">
                        <h2 className="shrink-0 font-medium text-ink-soft">{row.title}</h2>
                        <span className="shrink-0 text-ink-faint tabular-nums">{row.count}</span>
                        <span aria-hidden className="hidden text-ink-faint sm:inline">·</span>
                        <span className="hidden min-w-0 flex-1 truncate text-ink-faint sm:inline">{row.hint}</span>
                        <span className="flex-1 sm:hidden" />
                        {row.action}
                      </div>
                    </li>
                  );
                }
                const item = row.item;
                const canExpandInline = canInlineFor(item);
                const personaLabel = item.personaName ?? (item.personaId !== undefined ? personaNames.get(item.personaId) : undefined);
                return (
                  <li
                    key={row.key}
                    data-index={virtualRow.index}
                    ref={activityVirtualizer.measureElement}
                    className="absolute inset-x-0 pb-0.5"
                    style={{ top: virtualRow.start }}
                  >
                    <InboxRow
                      item={item}
                      workspaceName={workspaceNames.get(item.workspaceId)}
                      personaLabel={personaLabel}
                      focused={activeFocusedId === item.sessionId}
                      expanded={expandedIds.has(item.sessionId)}
                      canExpandInline={canExpandInline}
                      suppressAutoScroll
                      bare
                      onFocusRow={() => { setFocusedId(item.sessionId); }}
                      onToggleExpand={canExpandInline ? () => { toggleExpand(item.sessionId); } : undefined}
                      onDismiss={row.dismissible ? () => { dismissOne(item); } : undefined}
                      onOpen={open}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <div className={`mx-auto flex w-full ${PAGE_WIDTH.reading} flex-col gap-3.5 pt-1`}>
            {showNeedsYou ? (
              <InboxGroup
                hook={{ 'data-activity-group': 'needs-you' }}
                title={t('activity.needsYou')}
                hint={t('activity.needsYouOrder')}
                items={model.needsYou}
                workspaceNames={workspaceNames}
                personaNames={personaNames}
                focusedSessionId={activeFocusedId}
                expandedIds={expandedIds}
                canInlineFor={canInlineFor}
                onFocusItem={setFocusedId}
                onToggleExpand={toggleExpand}
                onDismissItem={dismissOne}
                onOpen={open}
              />
            ) : null}

            {showUnread ? (
              <InboxGroup
                hook={{ 'data-activity-group': 'unread' }}
                title={t('activity.unread')}
                hint={t('activity.unreadOrder')}
                items={model.unread}
                workspaceNames={workspaceNames}
                personaNames={personaNames}
                focusedSessionId={activeFocusedId}
                expandedIds={expandedIds}
                canInlineFor={canInlineFor}
                dismissible
                onFocusItem={setFocusedId}
                onToggleExpand={toggleExpand}
                onDismissItem={dismissOne}
                onOpen={open}
                action={markAllReadAction}
              />
            ) : null}

            {showRunning ? (
              <InboxGroup
                hook={{ 'data-activity-group': 'running' }}
                title={t('activity.runningGroup')}
                hint={t('activity.runningOrder')}
                items={model.running}
                workspaceNames={workspaceNames}
                personaNames={personaNames}
                focusedSessionId={activeFocusedId}
                expandedIds={expandedIds}
                canInlineFor={canInlineFor}
                onFocusItem={setFocusedId}
                onToggleExpand={toggleExpand}
                onDismissItem={dismissOne}
                onOpen={open}
              />
            ) : null}

            {scopedAll.needsYou.length === 0 && scopedAll.unread.length === 0 && scopedAll.running.length === 0 ? (
              <div data-activity-empty className="px-3 pt-10">
                <p className="text-[14px] text-ink">{t('activity.emptyTitle')}</p>
                <p className="mt-1 text-[12.5px] text-ink-soft">{t('activity.emptyBody')}</p>
              </div>
            ) : model.visibleItems.length === 0 ? (
              <div data-activity-empty-filter className="px-3 pt-8">
                <p className="text-[13.5px] text-ink-soft">{t('activity.emptyFilterTitle')}</p>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
