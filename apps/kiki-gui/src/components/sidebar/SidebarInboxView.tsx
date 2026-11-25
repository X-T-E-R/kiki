/**
 * SidebarInboxView — Vibe42-inspired Inbox-Zero sidebar surface.
 *
 * Layout:
 *   - Top: unheaded FLIP-animated active stream (`needsYou` oldest-first →
 *     `failed`/`cancelled` newest-first → `done`/woken newest-first).
 *   - Empty active stream: generous calm whitespace with a single hairline
 *     check mark + `全部清空` / `All clear`.
 *   - Bottom (`mt-auto`): collapsible `工作中 [N]`, `稍后 [N]`, and subdued
 *     `已归档` drawers (rendered only when populated).
 *   - Scoped keyboard triage (`↑`/`↓`/`Enter`/`e`/`a`/`u`/`Esc`) when active,
 *     not inert, outside editable elements, and with no overlay open.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { UnifiedInboxItem, UnifiedInboxModel } from '@kiki/session-core/sessions';
import type { SnoozePreset } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { isEditableTarget } from '../../lib/shortcuts';
import { anyOverlayOpen } from '../../lib/uiBusy';
import { useListFlip } from '../../lib/useListFlip';
import type { MultiSpaceHealth } from '../../lib/useMultiSpaceSessions';
import { DisclosureChevron, Icon } from '../icons';
import { SidebarTriageRow } from './SidebarTriageRow';

export interface SidebarInboxViewProps {
  readonly inbox: UnifiedInboxModel;
  readonly activeConversationKey?: string;
  readonly showSpaceLabel: boolean;
  readonly healthBySpace?: ReadonlyMap<string, MultiSpaceHealth>;
  readonly untitled: string;
  readonly resolveTitle?: (text: string) => string;
  readonly activeShortcutsEnabled?: boolean;
  readonly onOpenItem: (item: UnifiedInboxItem) => void;
  readonly onContextMenuItem?: (item: UnifiedInboxItem, x: number, y: number) => void;
  readonly onSettleItem: (item: UnifiedInboxItem) => void;
  readonly onSnoozeItem: (item: UnifiedInboxItem, preset: SnoozePreset) => void;
  readonly onArchiveItem: (item: UnifiedInboxItem) => void;
  readonly onRestoreItem: (item: UnifiedInboxItem) => void;
  readonly onUndo: () => boolean;
  readonly onRecoverAllInterrupted?: (items: readonly UnifiedInboxItem[]) => Promise<void> | void;
  readonly recoveringInterrupted?: boolean;
}

export function SidebarInboxView({
  inbox,
  activeConversationKey,
  showSpaceLabel,
  healthBySpace,
  untitled,
  resolveTitle,
  activeShortcutsEnabled = true,
  onOpenItem,
  onContextMenuItem,
  onSettleItem,
  onSnoozeItem,
  onArchiveItem,
  onRestoreItem,
  onUndo,
  onRecoverAllInterrupted,
  recoveringInterrupted = false,
}: SidebarInboxViewProps) {
  const isSpaceOffline = (spaceKey: string) => healthBySpace?.get(spaceKey)?.state === 'offline';
  const { t } = useI18n();
  const activeListRef = useRef<HTMLDivElement>(null);
  const [focusedKey, setFocusedKey] = useState<string | undefined>(undefined);
  const [workingOpen, setWorkingOpen] = useState(true);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const activeKeys = useMemo(
    () => inbox.active.map((item) => item.encodedKey),
    [inbox.active],
  );
  useListFlip(activeKeys, activeListRef);

  const resolvedFocusedKey = useMemo(() => {
    if (focusedKey === undefined) return undefined;
    return inbox.active.some((item) => item.encodedKey === focusedKey) ? focusedKey : undefined;
  }, [focusedKey, inbox.active]);

  // Scoped Inbox triage shortcuts: ↑/↓/Enter/e/a/u/Esc.
  useEffect(() => {
    if (!activeShortcutsEnabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (anyOverlayOpen()) return;
      if (isEditableTarget(event.target)) return;
      if (event.target instanceof Element && event.target.closest('.xterm') !== null) return;

      if (event.key === 'u') {
        if (onUndo()) event.preventDefault();
        return;
      }

      const items = inbox.active;
      if (items.length === 0) return;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setFocusedKey((current) => {
          const idx = current === undefined ? -1 : items.findIndex((item) => item.encodedKey === current);
          if (idx === -1) return delta > 0 ? items[0]?.encodedKey : items[items.length - 1]?.encodedKey;
          const nextIdx = Math.max(0, Math.min(items.length - 1, idx + delta));
          return items[nextIdx]?.encodedKey;
        });
        return;
      }

      if (event.key === 'Escape' && resolvedFocusedKey !== undefined) {
        event.preventDefault();
        setFocusedKey(undefined);
        return;
      }

      const targetItem =
        (resolvedFocusedKey !== undefined ? items.find((i) => i.encodedKey === resolvedFocusedKey) : undefined)
        ?? (activeConversationKey !== undefined ? items.find((i) => i.encodedKey === activeConversationKey) : undefined)
        ?? items[0];
      if (targetItem === undefined) return;

      if (event.key === 'Enter' && resolvedFocusedKey !== undefined) {
        event.preventDefault();
        onOpenItem(targetItem);
      } else if (event.key === 'e' && !targetItem.needsYou && !targetItem.busy) {
        event.preventDefault();
        const idx = items.findIndex((i) => i.encodedKey === targetItem.encodedKey);
        const nextFocus = items[idx + 1]?.encodedKey ?? items[idx - 1]?.encodedKey;
        setFocusedKey(nextFocus);
        onSettleItem(targetItem);
      } else if (event.key === 'a' && !targetItem.needsYou) {
        event.preventDefault();
        const idx = items.findIndex((i) => i.encodedKey === targetItem.encodedKey);
        const nextFocus = items[idx + 1]?.encodedKey ?? items[idx - 1]?.encodedKey;
        setFocusedKey(nextFocus);
        onArchiveItem(targetItem);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [
    activeShortcutsEnabled,
    inbox.active,
    resolvedFocusedKey,
    activeConversationKey,
    onOpenItem,
    onSettleItem,
    onArchiveItem,
    onUndo,
  ]);

  const hasDrawers = inbox.working.length > 0 || inbox.snoozed.length > 0 || inbox.archived.length > 0;
  const interruptedItems = useMemo(
    () => inbox.active.filter((item) => item.reason === 'interrupted' && item.ref.kind === 'session'),
    [inbox.active],
  );

  return (
    <div
      data-sidebar-inbox
      role="region"
      aria-label={t('sidebar.inbox.aria')}
      className="flex min-h-full flex-col pt-1"
    >
      {interruptedItems.length > 0 && onRecoverAllInterrupted !== undefined ? (
        <div className="mb-1 px-1">
          <button
            type="button"
            data-recover-all-interrupted
            disabled={recoveringInterrupted}
            onClick={() => { void onRecoverAllInterrupted(interruptedItems); }}
            className="flex h-7 w-full items-center justify-between gap-2 rounded-md border border-amber-rule/45 bg-amber-rule/[0.08] px-2 text-left text-[12px] font-normal text-amber-ink transition-colors hover:bg-amber-rule/[0.14] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-default disabled:opacity-60"
          >
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-rule" />
              <span className="truncate">
                {recoveringInterrupted
                  ? t('sidebar.inbox.recovering')
                  : t('sidebar.inbox.recoverAll', { count: interruptedItems.length })}
              </span>
            </span>
          </button>
        </div>
      ) : null}
      {inbox.active.length > 0 ? (
        <div ref={activeListRef} data-inbox-active-list className="flex flex-col gap-0.5">
          {inbox.active.map((item) => (
            <SidebarTriageRow
              key={item.encodedKey}
              item={item}
              bucket="active"
              active={item.encodedKey === activeConversationKey}
              focused={item.encodedKey === resolvedFocusedKey}
              showSpaceLabel={showSpaceLabel}
              spaceOffline={isSpaceOffline(item.spaceKey)}
              untitled={untitled}
              resolveTitle={resolveTitle}
              onOpen={() => { onOpenItem(item); }}
              onContextMenu={onContextMenuItem === undefined ? undefined : (x, y) => { onContextMenuItem(item, x, y); }}
              onSettle={() => { onSettleItem(item); }}
              onSnooze={(preset) => { onSnoozeItem(item, preset); }}
              onArchive={() => { onArchiveItem(item); }}
            />
          ))}
        </div>
      ) : (
        <div
          data-inbox-all-clear
          className="flex flex-1 flex-col items-center justify-center gap-2.5 px-4 py-12 text-center"
        >
          <span
            aria-hidden
            className="flex h-8 w-8 items-center justify-center rounded-full border border-hairline-strong/80 text-ink-faint"
          >
            <Icon name="check" size={14} />
          </span>
          <p className="text-[12.5px] font-normal text-ink-faint">{t('sidebar.inbox.allClear')}</p>
        </div>
      )}

      {hasDrawers ? (
        <div
          data-inbox-drawers
          className="mt-auto flex flex-col gap-1 border-t border-hairline/60 pt-2.5"
        >
          {inbox.working.length > 0 ? (
            <div data-inbox-drawer="working">
              <button
                type="button"
                aria-expanded={workingOpen}
                data-inbox-drawer-toggle="working"
                onClick={() => { setWorkingOpen((v) => !v); }}
                className="row-interactive flex h-7 w-full items-center gap-1.5 px-2 text-left text-[12px] font-normal text-ink-faint hover:text-ink"
              >
                <DisclosureChevron open={workingOpen} size={12} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t('sidebar.inbox.working')}</span>
                <span className="shrink-0 tabular-nums text-[11px]">{inbox.working.length}</span>
              </button>
              {workingOpen ? (
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {inbox.working.map((item) => (
                    <SidebarTriageRow
                      key={item.encodedKey}
                      item={item}
                      bucket="working"
                      active={item.encodedKey === activeConversationKey}
                      showSpaceLabel={showSpaceLabel}
                      spaceOffline={isSpaceOffline(item.spaceKey)}
                      untitled={untitled}
                      resolveTitle={resolveTitle}
                      onOpen={() => { onOpenItem(item); }}
                      onContextMenu={onContextMenuItem === undefined ? undefined : (x, y) => { onContextMenuItem(item, x, y); }}
                      onArchive={() => { onArchiveItem(item); }}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {inbox.snoozed.length > 0 ? (
            <div data-inbox-drawer="snoozed">
              <button
                type="button"
                aria-expanded={snoozedOpen}
                data-inbox-drawer-toggle="snoozed"
                onClick={() => { setSnoozedOpen((v) => !v); }}
                className="row-interactive flex h-7 w-full items-center gap-1.5 px-2 text-left text-[12px] font-normal text-ink-faint hover:text-ink"
              >
                <DisclosureChevron open={snoozedOpen} size={12} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t('sidebar.inbox.snoozed')}</span>
                <span className="shrink-0 tabular-nums text-[11px]">{inbox.snoozed.length}</span>
              </button>
              {snoozedOpen ? (
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {inbox.snoozed.map((item) => (
                    <SidebarTriageRow
                      key={item.encodedKey}
                      item={item}
                      bucket="snoozed"
                      active={item.encodedKey === activeConversationKey}
                      showSpaceLabel={showSpaceLabel}
                      spaceOffline={isSpaceOffline(item.spaceKey)}
                      untitled={untitled}
                      resolveTitle={resolveTitle}
                      onOpen={() => { onOpenItem(item); }}
                      onContextMenu={onContextMenuItem === undefined ? undefined : (x, y) => { onContextMenuItem(item, x, y); }}
                      onRestore={() => { onRestoreItem(item); }}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {inbox.archived.length > 0 ? (
            <div data-inbox-drawer="archived" className="opacity-80">
              <button
                type="button"
                aria-expanded={archivedOpen}
                data-inbox-drawer-toggle="archived"
                onClick={() => { setArchivedOpen((v) => !v); }}
                className="row-interactive flex h-7 w-full items-center gap-1.5 px-2 text-left text-[12px] font-normal text-ink-faint hover:text-ink"
              >
                <DisclosureChevron open={archivedOpen} size={12} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t('sidebar.inbox.archived')}</span>
                <span className="shrink-0 tabular-nums text-[11px]">{inbox.archived.length}</span>
              </button>
              {archivedOpen ? (
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {inbox.archived.map((item) => (
                    <SidebarTriageRow
                      key={item.encodedKey}
                      item={item}
                      bucket="archived"
                      active={item.encodedKey === activeConversationKey}
                      showSpaceLabel={showSpaceLabel}
                      spaceOffline={isSpaceOffline(item.spaceKey)}
                      untitled={untitled}
                      resolveTitle={resolveTitle}
                      onOpen={() => { onOpenItem(item); }}
                      onContextMenu={onContextMenuItem === undefined ? undefined : (x, y) => { onContextMenuItem(item, x, y); }}
                      onRestore={() => { onRestoreItem(item); }}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
