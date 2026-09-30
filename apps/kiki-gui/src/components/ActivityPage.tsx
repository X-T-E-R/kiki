/**
 * Activity — the inbox for everything that wants the user's attention, in two
 * drains: sessions blocked on an approval or a question, then sessions that
 * finished while the user was elsewhere.
 *
 * The model is pure (`sessions/inbox.ts`) and reads the session list the app
 * already polls plus the local seen-marks, so opening this page costs no
 * requests. Rows are links: a blocked row lands on the waiting card, a
 * finished row lands on the session (and clears itself, because opening a
 * session records its seen-mark).
 *
 * "Mark all as read" clears the finished drain in one write; blocked rows
 * stay until they are answered.
 *
 * Order inside each group is deliberate and stated in the group header:
 * blocked rows oldest-wait-first (the longest-stuck run is the most expensive
 * to leave), finished rows newest-first (an inbox reads down).
 *
 * A second view (`?view=comms`, components/comms/ActivityComms.tsx) lists
 * recent cross-thread messages, scoped by the shared `?workspace=` control.
 */

import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { Session } from '@kiki/protocol';
import {
  buildInboxModel,
  type InboxItem,
  type InboxReason,
} from '@kiki/session-core/sessions';
import {
  markSessionsSeen,
  sessionSeenSnapshot,
  subscribeSessionSeen,
} from '@kiki/session-core/settings';

import { useI18n } from '../i18n';
import { ActivityComms } from './comms/ActivityComms';
import { useGuardedNavigate } from './dirtyGuard';
import { Icon } from './icons';
import { LifeMark } from './LifeMark';
import { PageHeader, useWorkspaceScope } from './PageChrome';
import { RelativeTime } from './RelativeTime';
import { segmentClass, WorkspaceScopeControl } from './WorkspaceScopeControl';
import { pushToast } from '../lib/toasts';

/** Inbox (needs you + finished) or the cross-thread message log; `?view=comms`. */
type ActivityView = 'inbox' | 'comms';

/** Live seen-marks: the list repaints the moment a session is opened. */
export function useSessionSeen() {
  return useSyncExternalStore(subscribeSessionSeen, sessionSeenSnapshot, sessionSeenSnapshot);
}

const REASON_LABEL: Record<InboxReason, string> = {
  approval: 'activity.reason.approval',
  question: 'activity.reason.question',
  completed: 'activity.reason.completed',
  failed: 'activity.reason.failed',
  cancelled: 'activity.reason.cancelled',
};

/** A blocked item opens the session where the answer is asked for. */
function itemHref(item: InboxItem): string {
  return `/s/${item.sessionId}`;
}

/** Same status dot as the sidebar row, still: an inbox is a list of rows. */
function ReasonMark({ item }: { item: InboxItem }) {
  const life = item.reason === 'approval' || item.reason === 'question'
    ? 'waiting'
    : item.reason === 'completed' ? 'done' : 'failed';
  return (
    <span className="flex h-[19px] w-[7px] shrink-0 items-center">
      <LifeMark
        markId={`activity:${item.sessionId}`}
        life={life}
        tone={item.reason === 'cancelled' ? 'bg-amber-rule' : undefined}
        still
      />
    </span>
  );
}

function InboxRow({
  item,
  workspaceName,
  onOpen,
}: {
  item: InboxItem;
  workspaceName: string | undefined;
  onOpen: (href: string) => void;
}) {
  const { t } = useI18n();
  const waiting = item.reason === 'approval' || item.reason === 'question';
  return (
    <li>
      <button
        type="button"
        data-activity-item={item.sessionId}
        data-activity-reason={item.reason}
        onClick={() => { onOpen(itemHref(item)); }}
        className="group flex min-h-11 w-full items-start gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
      >
        <ReasonMark item={item} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] leading-[19px] font-medium text-ink">{item.title.trim() === '' ? t('sidebar.untitled') : item.title}</span>
            <RelativeTime at={item.at} className="shrink-0 text-[12px] leading-4 text-ink-faint tabular-nums" />
          </span>
          <span className="mt-px flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-faint">
            <span className={`shrink-0 ${waiting ? 'font-medium text-accent-deep' : ''}`}>
              {t(REASON_LABEL[item.reason] as 'activity.reason.approval')}
            </span>
            {workspaceName !== undefined && workspaceName !== '' ? (
              <span data-activity-workspace className="min-w-0 truncate">· {workspaceName}</span>
            ) : null}
          </span>
          {item.preview !== undefined ? (
            <span data-activity-preview className="mt-px block truncate text-[12px] leading-4 text-ink-soft">
              {item.preview}
            </span>
          ) : null}
        </span>
        <Icon
          name="arrowRight"
          size={12}
          className="mt-[3.5px] text-ink-faint opacity-0 transition-[opacity,transform] group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        />
      </button>
    </li>
  );
}

function InboxGroup({
  title,
  hint,
  items,
  workspaceNames,
  onOpen,
  hook,
  action,
}: {
  title: string;
  hint: string;
  items: readonly InboxItem[];
  workspaceNames: ReadonlyMap<string, string>;
  onOpen: (href: string) => void;
  hook: Record<string, string>;
  /** One quiet control at the end of the header (e.g. mark all as read). */
  action?: ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <section {...hook} aria-label={title} className="flex flex-col gap-0.5">
      {/* The sidebar's group-header rule: T5 label, count right after it,
          the order note after that — nothing pushed to the far edge. */}
      <div className="flex h-7 items-center gap-1.5 px-3 text-[12px] leading-4">
        <h2 className="shrink-0 font-medium text-ink-soft">{title}</h2>
        <span className="shrink-0 text-ink-faint tabular-nums">{items.length}</span>
        <span aria-hidden className="text-ink-faint">·</span>
        <span className="min-w-0 flex-1 truncate text-ink-faint">{hint}</span>
        {action}
      </div>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <InboxRow
            key={`${item.reason}:${item.sessionId}`}
            item={item}
            workspaceName={workspaceNames.get(item.workspaceId)}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  );
}

export interface ActivityPageProps {
  readonly sessions: readonly Session[];
  readonly workspaceOptions: readonly { readonly id: string; readonly name: string }[];
  readonly onToggleSidebar: () => void;
}

export function ActivityPage({ sessions, workspaceOptions, onToggleSidebar }: ActivityPageProps) {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const seen = useSessionSeen();
  const model = useMemo(() => buildInboxModel(sessions, seen), [sessions, seen]);
  const workspaceNames = useMemo(
    () => new Map(workspaceOptions.map((workspace) => [workspace.id, workspace.name])),
    [workspaceOptions],
  );
  const [params, setParams] = useSearchParams();
  const view: ActivityView = params.get('view') === 'comms' ? 'comms' : 'inbox';
  const { scope, setScope } = useWorkspaceScope(workspaceOptions);
  const chooseView = (next: ActivityView) => {
    const updated = new URLSearchParams(params);
    if (next === 'inbox') {
      updated.delete('view');
      updated.delete('workspace');
    } else updated.set('view', next);
    setParams(updated, { replace: true });
  };
  const open = (href: string) => { void navigate(href); };
  // Only the finished drain can be cleared: a blocked session stays until it
  // is answered, so "read" would be a lie there.
  const markAllRead = () => {
    markSessionsSeen(model.unread.map((item) => ({ sessionId: item.sessionId, lastSeq: item.lastSeq })));
    pushToast({ tone: 'success', text: t('activity.markAllReadDone') });
  };
  return (
    <div data-activity-page data-activity-view={view} className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
      <PageHeader title={t('nav.activity')} onToggleSidebar={onToggleSidebar} />
      {/* The view switch sits on the header's left edge, the scope (comms
          only) right after it — the /cron and /board scope-bar rhythm. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 pb-2 lg:px-6">
        <div role="group" aria-label={t('activity.viewAria')} data-activity-views
          className="flex items-center gap-0.5 rounded-[9px] border border-hairline bg-paper p-0.5">
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
        {view === 'comms' && workspaceOptions.length > 1 ? (
          <WorkspaceScopeControl workspaces={workspaceOptions} value={scope} onChange={setScope} dataAttribute="data-activity-scope" />
        ) : null}
      </div>
      {/* The list starts on the header's own left edge (a reading column, not a
          centred card) so the page title and the first row share one margin. */}
      <div data-activity-scroll className="min-h-0 flex-1 overflow-y-auto px-1 pb-8 lg:px-3">
        {view === 'comms' ? (
          <div className="flex w-full max-w-[680px] flex-col gap-3 pt-1">
            <ActivityComms workspaceId={scope} workspaceNames={workspaceNames} onOpen={open} />
          </div>
        ) : (
        <div className="flex w-full max-w-[680px] flex-col gap-3 pt-1">
          <InboxGroup
            hook={{ 'data-activity-group': 'needs-you' }}
            title={t('activity.needsYou')}
            hint={t('activity.needsYouOrder')}
            items={model.needsYou}
            workspaceNames={workspaceNames}
            onOpen={open}
          />
          <InboxGroup
            hook={{ 'data-activity-group': 'unread' }}
            title={t('activity.unread')}
            hint={t('activity.unreadOrder')}
            items={model.unread}
            workspaceNames={workspaceNames}
            onOpen={open}
            action={(
              <button
                type="button"
                data-activity-mark-all-read
                onClick={markAllRead}
                className="-my-1 shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:py-2"
              >
                {t('activity.markAllRead')}
              </button>
            )}
          />
          {model.total === 0 ? (
            <div data-activity-empty className="px-3 pt-10">
              <p className="text-[14px] text-ink">{t('activity.emptyTitle')}</p>
              <p className="mt-1 text-[12.5px] text-ink-soft">{t('activity.emptyBody')}</p>
            </div>
          ) : null}
        </div>
        )}
      </div>
    </div>
  );
}
