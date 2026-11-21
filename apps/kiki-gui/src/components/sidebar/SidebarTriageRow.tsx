/**
 * SidebarTriageRow — one conversation row in the Vibe42-inspired Inbox view.
 *
 * Aligned on the Zone 1 `18px` left keyline (`px-2.5` parent + `pl-2` row).
 *   Line 1: 7px LifeMark slot + truncated title (+ `#` prefix for rooms)
 *           + hover / focus-within / touch action cluster (`✓`, `Clock`, `Archive`).
 *   Line 2: quiet coordinate `<RelativeTime /> · <StateWord> [· <WorkspaceName>] [· <SpaceName>]`.
 */

import { useRef, useState } from 'react';

import type { InboxReason, UnifiedInboxItem } from '@kiki/session-core/sessions';
import type { SnoozePreset } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import type { LifeState } from '../../lib/motion';
import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { RelativeTime } from '../RelativeTime';
import { ThreadTitle } from '../ThreadTitle';
import { SidebarSnoozePopover } from './SidebarSnoozePopover';

export type InboxRowBucket = 'active' | 'working' | 'snoozed' | 'archived';

export interface SidebarTriageRowProps {
  readonly item: UnifiedInboxItem;
  readonly bucket: InboxRowBucket;
  readonly active: boolean;
  readonly focused?: boolean;
  readonly showSpaceLabel: boolean;
  readonly untitled: string;
  readonly resolveTitle?: (text: string) => string;
  readonly onOpen: () => void;
  readonly onSettle?: () => void;
  readonly onSnooze?: (preset: SnoozePreset) => void;
  readonly onArchive?: () => void;
  readonly onRestore?: () => void;
}

function lifeForInboxItem(item: UnifiedInboxItem, bucket: InboxRowBucket): LifeState {
  if (bucket === 'archived') return 'idle';
  if (item.needsYou) return 'waiting';
  if (item.busy || bucket === 'working') return 'working';
  if (!item.unread) return 'idle';
  if (item.reason === 'failed' || item.reason === 'cancelled') return 'failed';
  return 'done';
}

function stateLabelKey(reason: InboxReason):
  | 'sidebar.inbox.state.approval'
  | 'sidebar.inbox.state.question'
  | 'sidebar.inbox.state.budget'
  | 'sidebar.inbox.state.completed'
  | 'sidebar.inbox.state.failed'
  | 'sidebar.inbox.state.cancelled'
  | 'sidebar.inbox.state.running' {
  switch (reason) {
    case 'approval':
      return 'sidebar.inbox.state.approval';
    case 'question':
      return 'sidebar.inbox.state.question';
    case 'budget':
      return 'sidebar.inbox.state.budget';
    case 'failed':
      return 'sidebar.inbox.state.failed';
    case 'cancelled':
      return 'sidebar.inbox.state.cancelled';
    case 'running':
      return 'sidebar.inbox.state.running';
    case 'completed':
    default:
      return 'sidebar.inbox.state.completed';
  }
}

function formatClock(ms: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toTimeString().slice(0, 5);
  }
}

const ACTION_BTN =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.08] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-8 pointer-coarse:w-8';

export function SidebarTriageRow({
  item,
  bucket,
  active,
  focused = false,
  showSpaceLabel,
  untitled,
  resolveTitle,
  onOpen,
  onSettle,
  onSnooze,
  onArchive,
  onRestore,
}: SidebarTriageRowProps) {
  const { t, locale } = useI18n();
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const snoozeTriggerRef = useRef<HTMLButtonElement>(null);

  const rawTitle = item.title.trim() !== '' ? item.title : (item.preview ?? untitled);
  const displayTitle = resolveTitle !== undefined ? resolveTitle(rawTitle) : rawTitle;
  const life = lifeForInboxItem(item, bucket);
  const isRoom = item.ref.kind === 'room';
  const subdued = bucket === 'archived';
  const emphasis = active || (!subdued && (item.needsYou || item.unread));
  const stateWord = t(stateLabelKey(item.reason));
  const stateToneClass = item.needsYou
    ? 'text-attention'
    : item.reason === 'failed' || item.reason === 'cancelled'
      ? 'text-ink-soft'
      : 'text-ink-faint';

  const showSettle = bucket === 'active' && !item.needsYou && onSettle !== undefined;
  const showSnooze = bucket === 'active' && onSnooze !== undefined;
  const showArchive = (bucket === 'active' || bucket === 'working') && !item.needsYou && onArchive !== undefined;
  const showWake = bucket === 'snoozed' && onRestore !== undefined;
  const showRestore = bucket === 'archived' && onRestore !== undefined;
  const hasActions = showSettle || showSnooze || showArchive || showWake || showRestore;

  return (
    <div
      data-flip-key={item.encodedKey}
      data-inbox-row={item.sessionId}
      data-inbox-bucket={bucket}
      data-inbox-space={item.spaceKey}
      data-inbox-unread={item.unread ? 'true' : 'false'}
      data-inbox-focused={focused ? 'true' : undefined}
      className={`group relative rounded-md ${focused ? 'bg-ink/[0.045]' : ''}`}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'page' : undefined}
        className={`row-interactive flex w-full items-start gap-2 py-1.5 pr-2 pl-2 text-left ${
          subdued ? 'opacity-70 hover:opacity-100' : ''
        }`}
      >
        <span className="flex h-[19px] w-[7px] shrink-0 items-center">
          <span data-inbox-status={life} className="flex h-[7px] w-[7px]">
            <LifeMark
              markId={`inbox:${item.encodedKey}`}
              life={life}
              still
              title={stateWord}
              tone={life === 'failed' ? 'bg-ink-faint' : life === 'waiting' ? 'bg-attention' : undefined}
            />
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span
            data-inbox-title
            className={`flex min-w-0 items-center gap-1 pr-1 text-[13px] leading-[19px] ${
              hasActions ? 'group-hover:pr-[74px] group-focus-within:pr-[74px] pointer-coarse:pr-[74px]' : ''
            } ${emphasis ? 'font-medium text-ink' : 'text-ink-soft'}`}
          >
            {isRoom ? <Icon name="room" size={12} className="shrink-0 text-ink-faint" /> : null}
            <span className="min-w-0 flex-1 truncate">
              <ThreadTitle text={displayTitle} />
            </span>
          </span>
          <span
            data-inbox-meta
            className="mt-0.5 flex min-w-0 items-center gap-1 text-[11.5px] leading-4 text-ink-faint"
          >
            {bucket === 'snoozed' && item.snoozedUntil !== undefined ? (
              <span className="shrink-0 tabular-nums text-ink-soft">
                {t('sidebar.inbox.snoozeUntil', { time: formatClock(item.snoozedUntil, locale) })}
              </span>
            ) : (
              <RelativeTime at={item.at} className="shrink-0 tabular-nums" />
            )}
            <span aria-hidden>·</span>
            <span className={`shrink-0 ${stateToneClass}`}>{stateWord}</span>
            {item.workspaceName !== undefined && item.workspaceName !== '' ? (
              <>
                <span aria-hidden>·</span>
                <span className="min-w-0 truncate">{item.workspaceName}</span>
              </>
            ) : null}
            {showSpaceLabel && item.spaceName !== '' ? (
              <>
                <span aria-hidden>·</span>
                <span data-inbox-space-label className="min-w-0 shrink truncate text-ink-faint/90">
                  {item.spaceName}
                </span>
              </>
            ) : null}
          </span>
        </span>
      </button>

      {hasActions ? (
        <div
          data-inbox-actions
          className={`absolute top-1 right-1 flex items-center gap-0.5 rounded-md bg-canvas/95 pl-1 transition-opacity ${
            snoozeOpen
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100'
          }`}
        >
          {showSettle ? (
            <button
              type="button"
              data-inbox-action="settle"
              aria-label={t('sidebar.inbox.settle')}
              title={`${t('sidebar.inbox.settle')} (e)`}
              onClick={(event) => {
                event.stopPropagation();
                onSettle();
              }}
              className={ACTION_BTN}
            >
              <Icon name="check" size={14} />
            </button>
          ) : null}
          {showSnooze ? (
            <button
              ref={snoozeTriggerRef}
              type="button"
              data-inbox-action="snooze"
              aria-haspopup="menu"
              aria-expanded={snoozeOpen}
              aria-label={t('sidebar.inbox.snooze')}
              title={t('sidebar.inbox.snooze')}
              onClick={(event) => {
                event.stopPropagation();
                setSnoozeOpen((open) => !open);
              }}
              className={ACTION_BTN}
            >
              <Icon name="clock" size={14} />
            </button>
          ) : null}
          {showArchive ? (
            <button
              type="button"
              data-inbox-action="archive"
              aria-label={t('sidebar.inbox.archive')}
              title={`${t('sidebar.inbox.archive')} (a)`}
              onClick={(event) => {
                event.stopPropagation();
                onArchive();
              }}
              className={ACTION_BTN}
            >
              <Icon name="archive" size={14} />
            </button>
          ) : null}
          {showWake ? (
            <button
              type="button"
              data-inbox-action="wake"
              aria-label={t('sidebar.inbox.wakeNow')}
              title={t('sidebar.inbox.wakeNow')}
              onClick={(event) => {
                event.stopPropagation();
                onRestore();
              }}
              className="h-6 rounded-md px-1.5 text-[11.5px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.08] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
            >
              {t('sidebar.inbox.wakeNow')}
            </button>
          ) : null}
          {showRestore ? (
            <button
              type="button"
              data-inbox-action="restore"
              aria-label={t('sidebar.inbox.restore')}
              title={t('sidebar.inbox.restore')}
              onClick={(event) => {
                event.stopPropagation();
                onRestore();
              }}
              className={ACTION_BTN}
            >
              <Icon name="archiveRestore" size={14} />
            </button>
          ) : null}
        </div>
      ) : null}

      {snoozeOpen && onSnooze !== undefined ? (
        <SidebarSnoozePopover
          anchorRef={snoozeTriggerRef}
          onSelect={(preset) => { onSnooze(preset); }}
          onClose={() => { setSnoozeOpen(false); }}
        />
      ) : null}
    </div>
  );
}
