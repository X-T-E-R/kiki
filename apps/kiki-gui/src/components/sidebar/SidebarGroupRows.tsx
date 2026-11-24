/**
 * Memoized rows for automatic session groups (`组`) and the single virtual
 * infinite-scroll loader/retry row. Strict Zone 1 `18px` keyline alignment,
 * calm paper/ink restraint, zero boxed borders, zero UI emoji.
 */

import { memo } from 'react';
import type { SidebarSessionGroupEntry } from '@kiki/session-core/sessions';
import { useI18n } from '../../i18n';
import type { LifeState } from '../../lib/motion';
import { RelativeTime } from '../RelativeTime';
import { LifeMark } from '../LifeMark';
import { DisclosureChevron, Icon, Spinner } from '../icons';

export interface SessionGroupHeaderRowProps {
  readonly group: SidebarSessionGroupEntry;
  readonly title: string;
  readonly expanded: boolean;
  readonly hasActiveMember: boolean;
  readonly collapsedLife: LifeState;
  readonly showPin: boolean;
  readonly onToggle: (groupId: string) => void;
}

export const SessionGroupHeaderRow = memo(function SessionGroupHeaderRow({
  group,
  title,
  expanded,
  hasActiveMember,
  collapsedLife,
  showPin,
  onToggle,
}: SessionGroupHeaderRowProps) {
  const { t } = useI18n();
  const emphasis = (!expanded && hasActiveMember) || collapsedLife === 'waiting' || collapsedLife === 'done';
  const countLabel = group.partialCoverage === true ? `${group.memberCount}+` : String(group.memberCount);
  const countTitle = group.partialCoverage === true
    ? t('sidebar.group.memberCountPartial', { count: group.memberCount })
    : t('sidebar.group.memberCount', { count: group.memberCount });

  const showCollapsedLifeDot = !expanded && (
    collapsedLife === 'working' || collapsedLife === 'waiting' || collapsedLife === 'failed'
  );
  return (
    <div
      data-sidebar-unit-group={group.groupId}
      data-sidebar-unit-group-expanded={expanded ? 'true' : 'false'}
      data-sidebar-unit-group-life={!expanded && collapsedLife !== 'idle' ? collapsedLife : undefined}
      className="group/sgrp relative py-px"
    >
      <button
        type="button"
        data-sidebar-unit-group-toggle={group.groupId}
        aria-expanded={expanded}
        aria-label={expanded
          ? t('sidebar.group.collapse', { title })
          : t('sidebar.group.expand', { title })}
        onClick={() => { onToggle(group.groupId); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && !expanded) {
            event.preventDefault();
            onToggle(group.groupId);
          } else if (event.key === 'ArrowLeft' && expanded) {
            event.preventDefault();
            onToggle(group.groupId);
          }
        }}
        className={`row-interactive flex h-8 w-full items-center gap-2 px-2 text-left pointer-coarse:h-10 ${
          !expanded && hasActiveMember ? 'bg-ink/[0.04]' : ''
        }`}
      >
        <span className="flex h-[19px] w-[7px] shrink-0 items-center justify-center text-ink-faint">
          <DisclosureChevron open={expanded} size={12} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {showPin && group.pinned ? (
            <span data-sidebar-unit-group-pinned className="shrink-0 text-ink-faint">
              <Icon name="pin" size={12} />
            </span>
          ) : null}
          <span
            data-sidebar-unit-group-title
            className={`min-w-0 flex-1 truncate text-[13px] leading-[19px] ${
              emphasis ? 'font-medium text-ink' : 'text-ink-soft group-hover/sgrp:text-ink'
            }`}
          >
            {title}
          </span>
          <span
            data-sidebar-unit-group-count
            title={countTitle}
            className="shrink-0 text-[11.5px] leading-4 font-normal text-ink-faint tabular-nums"
          >
            {countLabel}
          </span>
          {showCollapsedLifeDot ? (
            <span
              data-sidebar-unit-group-life-dot={collapsedLife}
              className="flex h-[7px] w-[7px] shrink-0 items-center justify-center"
            >
              <LifeMark
                markId={`sgrp:${group.groupId}`}
                life={collapsedLife}
                still
                tone={collapsedLife === 'failed' ? 'bg-ink-faint' : collapsedLife === 'waiting' ? 'bg-attention' : undefined}
              />
            </span>
          ) : null}
        </span>
        <span
          data-sidebar-unit-group-time
          className="min-w-10 shrink-0 text-right text-[12px] leading-4 font-normal text-ink-faint tabular-nums"
        >
          <RelativeTime at={group.updatedAt} />
        </span>
      </button>
    </div>
  );
});

export interface SessionGroupMoreRowProps {
  readonly groupId: string;
  readonly spaceKey: string;
  readonly cursor: string;
  readonly remaining: number;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly onLoadMore: (groupId: string, spaceKey: string, cursor: string) => void;
}

export const SessionGroupMoreRow = memo(function SessionGroupMoreRow({
  groupId,
  spaceKey,
  cursor,
  remaining,
  loading,
  error,
  onLoadMore,
}: SessionGroupMoreRowProps) {
  const { t } = useI18n();
  const label = loading
    ? t('sidebar.group.loadingMembers')
    : error !== undefined
      ? `${t('sidebar.group.loadMembersFailed')} · ${t('sidebar.loadMoreRetry')}`
      : remaining > 0
        ? t('sidebar.group.loadMoreMembers', { remaining })
        : t('sidebar.group.loadMoreMembersUnknown');

  return (
    <div className="relative py-px" data-sidebar-unit-group-member={groupId}>
      <span aria-hidden className="pointer-events-none absolute top-0 bottom-0 left-[13px] w-px bg-hairline" />
      <button
        type="button"
        data-sidebar-unit-group-more={groupId}
        disabled={loading}
        onClick={() => { onLoadMore(groupId, spaceKey, cursor); }}
        className="row-interactive flex h-7 w-full items-center gap-1.5 pr-2 pl-6 text-left text-[12px] text-ink-faint hover:text-ink disabled:opacity-60 pointer-coarse:h-10"
      >
        {loading ? <Spinner label={t('sidebar.group.loadingMembers')} size={12} /> : null}
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
});

export interface SidebarLoadMoreRowProps {
  readonly hasMore: boolean;
  readonly isFetching: boolean;
  readonly error: string | null;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
}

export const SidebarLoadMoreRow = memo(function SidebarLoadMoreRow({
  hasMore,
  isFetching,
  error,
  onLoadMore,
  onRetry,
}: SidebarLoadMoreRowProps) {
  const { t } = useI18n();
  if (!hasMore && error === null) return null;

  if (error !== null) {
    return (
      <div
        role="status"
        data-session-load-more-error
        className="mt-1 flex h-8 w-full items-center justify-center gap-2 px-2 text-[12px] text-ink-soft"
      >
        <span className="truncate">{t('sidebar.loadMoreFailed')}</span>
        <button
          type="button"
          data-session-load-more-retry
          onClick={onRetry}
          className="shrink-0 font-medium text-ink underline underline-offset-2 hover:text-selected-ink"
        >
          {t('sidebar.loadMoreRetry')}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      data-session-load-more
      disabled={isFetching}
      onClick={onLoadMore}
      className="mt-1 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg px-2 text-center text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink-soft disabled:opacity-60 pointer-coarse:h-10"
    >
      {isFetching ? <Spinner label={t('sidebar.loadingMore')} size={12} /> : null}
      <span>{isFetching ? t('sidebar.loadingMore') : t('sidebar.loadMore')}</span>
    </button>
  );
});
