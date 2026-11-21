import { useMemo, useRef, useState } from 'react';

import type { UnifiedInboxItem } from '@kiki/session-core/sessions';

import { Icon } from '../../components/icons';
import { RelativeTime } from '../../components/RelativeTime';
import { useI18n } from '../../i18n';
import { SpacePill } from '../SpacePill';

type ChatsFilter = 'all' | 'unread' | 'running';

interface ChatsTabProps {
  readonly spaceLabel: string;
  readonly spaceStatusTone: 'online' | 'attention' | 'offline';
  readonly items: readonly UnifiedInboxItem[];
  readonly showSpaceTag: boolean;
  readonly onOpenSpaceSheet: () => void;
  readonly onOpenItem: (item: UnifiedInboxItem) => void;
  readonly onMarkRead: (item: UnifiedInboxItem) => void;
  readonly onArchive: (item: UnifiedInboxItem) => void;
}

function SwipeChatRow({
  item,
  showSpaceTag,
  onOpen,
  onMarkRead,
  onArchive,
}: {
  readonly item: UnifiedInboxItem;
  readonly showSpaceTag: boolean;
  readonly onOpen: () => void;
  readonly onMarkRead: () => void;
  readonly onArchive: () => void;
}) {
  const { t } = useI18n();
  const [offsetX, setOffsetX] = useState(0);
  const startRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const swipingRef = useRef(false);

  const initial = (item.title.trim()[0] ?? 'K').toUpperCase();
  const dotClass = item.needsYou
    ? 'bg-accent'
    : item.busy
      ? 'bg-success'
      : item.unread
        ? 'bg-selected-ink'
        : null;

  return (
    <div className="relative overflow-hidden">
      <div className="absolute inset-y-0 right-0 flex items-center gap-1.5 pr-4">
        {item.unread ? (
          <button
            type="button"
            onClick={() => {
              setOffsetX(0);
              onMarkRead();
            }}
            className="flex h-9 items-center rounded-full bg-selected px-3 text-[12px] font-medium text-selected-ink"
          >
            {t('mobile.chats.markRead')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setOffsetX(0);
            onArchive();
          }}
          className="flex h-9 items-center rounded-full bg-ink/[0.08] px-3 text-[12px] font-medium text-ink"
        >
          {t('mobile.chats.archive')}
        </button>
      </div>

      <button
        type="button"
        data-mobile-chat-row={item.sessionId}
        style={{ transform: `translate3d(${offsetX}px, 0, 0)` }}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          if (touch === undefined) return;
          startRef.current = { x: touch.clientX, y: touch.clientY };
          swipingRef.current = false;
        }}
        onTouchMove={(event) => {
          const start = startRef.current;
          const touch = event.touches[0];
          if (start === null || touch === undefined) return;
          const dx = touch.clientX - start.x;
          const dy = touch.clientY - start.y;
          if (!swipingRef.current && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.4) {
            swipingRef.current = true;
          }
          if (swipingRef.current) {
            setOffsetX(Math.max(-132, Math.min(0, dx)));
          }
        }}
        onTouchEnd={() => {
          if (swipingRef.current) {
            setOffsetX((cur) => (cur < -56 ? -124 : 0));
          }
          startRef.current = null;
        }}
        onClick={() => {
          if (offsetX < -10) {
            setOffsetX(0);
            return;
          }
          onOpen();
        }}
        className="relative flex min-h-[68px] w-full items-center gap-3.5 bg-paper px-4 py-3 text-left transition-transform duration-150 active:bg-ink/[0.03]"
      >
        <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-canvas font-display text-[16px] font-medium text-ink-soft">
          {initial}
          {dotClass !== null ? (
            <span
              data-mobile-chat-unread={item.unread ? '1' : undefined}
              className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-paper ${dotClass}`}
              aria-hidden="true"
            />
          ) : null}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={`min-w-0 truncate text-[15px] ${item.unread || item.needsYou ? 'font-semibold text-ink' : 'font-medium text-ink'}`}>
              {item.title}
            </span>
            <RelativeTime at={item.at} className="shrink-0 text-[12px] tabular-nums text-ink-faint" />
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-ink-faint">
            {showSpaceTag ? (
              <span className="shrink-0 rounded bg-ink/[0.05] px-1.5 py-0.5 text-[11px] font-medium text-ink-soft">
                {item.spaceName}
              </span>
            ) : null}
            {(item.preview ?? item.workspaceName) !== undefined ? (
              <span className="min-w-0 truncate">{item.preview ?? item.workspaceName}</span>
            ) : null}
          </span>
        </span>
      </button>
    </div>
  );
}

export function ChatsTab({
  spaceLabel,
  spaceStatusTone,
  items,
  showSpaceTag,
  onOpenSpaceSheet,
  onOpenItem,
  onMarkRead,
  onArchive,
}: ChatsTabProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<ChatsFilter>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === 'unread' && !item.unread && !item.needsYou) return false;
      if (filter === 'running' && !item.busy) return false;
      if (q !== '') {
        const hay = `${item.title} ${item.preview ?? ''} ${item.spaceName} ${item.workspaceName ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, filter, query]);

  const filters: readonly { readonly id: ChatsFilter; readonly label: string }[] = [
    { id: 'all', label: t('mobile.chats.filterAll') },
    { id: 'unread', label: t('mobile.chats.filterUnread') },
    { id: 'running', label: t('mobile.chats.filterRunning') },
  ];

  return (
    <div data-mobile-screen="chats" className="flex min-h-0 flex-1 flex-col">
      <header className="mx-auto flex h-12 w-full max-w-[632px] shrink-0 items-center justify-between gap-2 px-4">
        <SpacePill label={spaceLabel} statusTone={spaceStatusTone} onClick={onOpenSpaceSheet} />
        <button
          type="button"
          aria-label={t('mobile.chats.searchPlaceholder')}
          onClick={() => {
            setSearchOpen((prev) => {
              if (prev) setQuery('');
              return !prev;
            });
          }}
          className={`flex h-9 w-9 items-center justify-center rounded-full border transition-colors ${
            searchOpen
              ? 'border-ink bg-ink text-paper'
              : 'border-hairline bg-panel text-ink-soft hover:border-hairline-strong hover:text-ink'
          }`}
        >
          <Icon name={searchOpen ? 'close' : 'search'} size={16} />
        </button>
      </header>

      <div className="shrink-0 space-y-2.5 border-b border-hairline/60 px-4 pb-3 pt-1">
        {searchOpen ? (
          <input
            type="search"
            value={query}
            autoFocus
            onChange={(event) => { setQuery(event.target.value); }}
            placeholder={t('mobile.chats.searchPlaceholder')}
            className="h-10 w-full rounded-full border border-hairline bg-panel px-4 text-[16px] text-ink placeholder:text-ink-faint focus:border-selected-ink focus:outline-none"
          />
        ) : null}

        <div className="flex items-center gap-2">
          {filters.map((entry) => {
            const active = filter === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                data-mobile-chats-filter={entry.id}
                onClick={() => { setFilter(entry.id); }}
                className={`h-8 rounded-full px-3.5 text-[13px] font-medium transition-colors ${
                  active
                    ? 'bg-ink text-paper'
                    : 'border border-hairline bg-panel text-ink-soft hover:border-hairline-strong'
                }`}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-[calc(104px+var(--kiki-safe-bottom-inset))]">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <p className="text-[14.5px] text-ink-faint">{t('mobile.chats.empty')}</p>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[600px] divide-y divide-hairline/60">
            {filtered.map((item) => (
              <SwipeChatRow
                key={item.encodedKey}
                item={item}
                showSpaceTag={showSpaceTag}
                onOpen={() => { onOpenItem(item); }}
                onMarkRead={() => { onMarkRead(item); }}
                onArchive={() => { onArchive(item); }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
