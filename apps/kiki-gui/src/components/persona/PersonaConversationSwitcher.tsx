/**
 * PersonaConversationSwitcher: the one conversation switcher for a persona,
 * anchored under whatever opened it (sidebar row, session header identity).
 *
 * One list, in the order the question is asked:
 *   - the fixed daily conversation first, with no home yet saying so;
 *   - then the rest, attention first and then by recency, the current one
 *     carrying the same paper sheet every other list uses for "you are here";
 *   - room members last in kind but not in address: they open the room.
 * The footer starts another conversation (inheriting the current project) or
 * opens the full list. Search appears only once the list is too long to read.
 *
 * Keyboard follows the sidebar's overlay menu: ↑↓ move, Esc closes and hands
 * focus back to the anchor. Placement is the shared anchored-popover tier
 * (`overlays/AnchoredPopover` + `placeAnchored`): portalled to the body,
 * flipped and shifted inside the viewport, re-placed while the page or the
 * sidebar scrolls underneath it, so it never detaches from the person or the
 * row it belongs to.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session, WorkspaceCatalogEntry } from '@kiki/protocol';
import { sessionRowState } from '@kiki/session-core/sessions';
import type { SessionSeenMap } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useGuardedNavigate } from '../dirtyGuard';
import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { AnchoredPopover } from '../overlays';
import { RelativeTime } from '../RelativeTime';
import { PersonaAvatar, personaAvatarOf, type PersonaAvatarData } from './PersonaAvatar';
import { personaNewConversationUrl } from './personaNavigation';
import type { PersonaDirectoryEntry } from './usePersonaDirectory';

/** Rows the list shows before it truncates: the daily row plus eight others. */
const MAX_OTHER_ROWS = 8;

export interface PersonaConversationSwitcherProps {
  readonly anchor: HTMLElement | null;
  /**
   * Which edge of the reference block the panel hangs from. `end` matches the
   * sidebar's row menus (the panel's right edge sits on the trigger's, so it
   * opens leftwards over the rail); `start` puts the panel's left edge under
   * the block, which is what a header trigger needs: a 320px sheet
   * right-aligned to a 20px chevron would land on top of the sidebar.
   */
  readonly align?: 'start' | 'end';
  /**
   * The block the panel aligns to when that is not the trigger itself — the
   * header passes the identity block so the panel opens under the person,
   * into the content column, rather than under the chevron that opened it.
   */
  readonly alignTo?: HTMLElement | null;
  readonly persona: PersonaDirectoryEntry;
  /** This persona's conversations. The caller owns attribution: the sidebar
   * and the session header both read the server's answer for this persona
   * (`usePersonaSwitcherConversations`), and re-judging it here would drop
   * rows the server knows about. */
  readonly sessions: readonly Session[];
  /**
   * How the caller's read is going, so an unfinished one is never shown as
   * "this persona has no conversations". `undefined` when the list is just
   * the caller's (nothing to wait for). `error` is the reason, already in the
   * reader's language, exactly as the full conversations list reports it.
   */
  readonly status?: { readonly loading?: boolean; readonly error?: string };
  readonly activeSessionId?: string;
  readonly workspaceOptions?: readonly WorkspaceCatalogEntry[];
  readonly seen?: SessionSeenMap;
  /** Room names, when the opener already has them; ids resolve to titles otherwise. */
  readonly roomNames?: ReadonlyMap<string, string>;
  readonly onClose: () => void;
}

interface ItemEntry {
  readonly id: string;
  readonly kind: 'daily' | 'topic' | 'room';
  readonly title: string;
  readonly workspaceName?: string;
  readonly updatedAt?: string;
  readonly life: 'idle' | 'working' | 'waiting' | 'done';
  readonly isCurrent: boolean;
  readonly needsYou: boolean;
  readonly targetUrl: string;
}

function lifeOf(state: ReturnType<typeof sessionRowState>): ItemEntry['life'] {
  return state === 'needs-me' ? 'waiting' : state === 'running' ? 'working' : state === 'unread' ? 'done' : 'idle';
}

function sessionTitle(session: Session, untitled: string): string {
  if (session.title !== undefined && session.title.trim() !== '') return session.title;
  if (session.last_prompt !== undefined && session.last_prompt.trim() !== '') return session.last_prompt;
  return untitled;
}

export function PersonaConversationSwitcher({
  anchor,
  align = 'end',
  alignTo,
  persona,
  sessions,
  status,
  activeSessionId,
  workspaceOptions = [],
  seen = {},
  roomNames,
  onClose,
}: PersonaConversationSwitcherProps) {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const [query, setQuery] = useState('');
  // The callers hand over a measured element, not a ref; the popover tier
  // anchors to a ref, so this adapter holds it for the panel's lifetime.
  const anchorRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    anchorRef.current = alignTo ?? anchor;
    return () => { anchorRef.current = null; };
  }, [anchor, alignTo]);

  const workspaceMap = useMemo(() => new Map(workspaceOptions.map((w) => [w.id, w.name])), [workspaceOptions]);

  const items = useMemo(() => {
    const personaSessions = sessions.filter((s) => !s.archived);
    const home = persona.homeSessionId === undefined
      ? undefined
      : personaSessions.find((s) => s.id === persona.homeSessionId);
    // The daily row is the persona's fixed entrance, not a summary of the
    // home session: it exists (and opens a draft) even before there is one.
    const dailyWorkspace = home?.workspace_id === undefined ? undefined : workspaceMap.get(home.workspace_id) ?? home.workspace_id;
    const list: ItemEntry[] = [{
      id: persona.homeSessionId ?? 'daily-draft',
      kind: 'daily',
      title: t('persona.dailyTitle'),
      workspaceName: dailyWorkspace,
      updatedAt: home?.updated_at,
      life: home === undefined ? 'idle' : lifeOf(sessionRowState(home, seen)),
      isCurrent: persona.homeSessionId !== undefined && activeSessionId === persona.homeSessionId,
      needsYou: home !== undefined && sessionRowState(home, seen) === 'needs-me',
      targetUrl: persona.homeSessionId === undefined
        ? `/p/${encodeURIComponent(persona.id)}/daily`
        : `/s/${encodeURIComponent(persona.homeSessionId)}`,
    }];

    const others = personaSessions
      .filter((session) => session.id !== persona.homeSessionId)
      .map((session): ItemEntry => {
        const roomId = typeof session.metadata?.['room_member_of'] === 'string'
          ? session.metadata['room_member_of'] as string
          : undefined;
        const state = sessionRowState(session, seen);
        return {
          id: session.id,
          kind: roomId === undefined ? 'topic' : 'room',
          title: roomId === undefined
            ? sessionTitle(session, t('sidebar.untitled'))
            : roomNames?.get(roomId) ?? sessionTitle(session, t('sidebar.untitled')),
          workspaceName: session.workspace_id === undefined ? undefined : workspaceMap.get(session.workspace_id) ?? session.workspace_id,
          updatedAt: session.updated_at,
          life: lifeOf(state),
          isCurrent: session.id === activeSessionId,
          needsYou: state === 'needs-me',
          // A room member session is a seat in a room; the room is the address.
          targetUrl: roomId === undefined ? `/s/${encodeURIComponent(session.id)}` : `/rooms/${encodeURIComponent(roomId)}`,
        };
      })
      .sort((a, b) => {
        if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
        if ((a.life === 'working') !== (b.life === 'working')) return a.life === 'working' ? -1 : 1;
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
      });

    if (query.trim() !== '') {
      const needle = query.trim().toLocaleLowerCase();
      // The daily conversation is an entrance, not a result: it stays while
      // the search narrows the conversations around it.
      const matches = (item: ItemEntry) => item.title.toLocaleLowerCase().includes(needle)
        || (item.workspaceName?.toLocaleLowerCase().includes(needle) ?? false);
      return [...list, ...others.filter(matches)];
    }
    // The current conversation is never the row that got cut: "back to where I
    // was" is the second half of the round trip.
    const visible = others.slice(0, MAX_OTHER_ROWS);
    if (others.length > MAX_OTHER_ROWS) {
      const current = others.find((item) => item.isCurrent);
      if (current !== undefined && !visible.includes(current)) visible[MAX_OTHER_ROWS - 1] = current;
    }
    return [...list, ...visible];
  }, [activeSessionId, persona, query, roomNames, seen, sessions, t, workspaceMap]);

  const conversationCount = useMemo(
    () => sessions.filter((session) => !session.archived && session.id !== persona.homeSessionId).length,
    [persona.homeSessionId, sessions],
  );
  const currentWorkspaceId = useMemo(() => {
    const current = sessions.find((session) => session.id === activeSessionId);
    return current?.workspace_id;
  }, [activeSessionId, sessions]);

  const avatarData: PersonaAvatarData = personaAvatarOf(persona);

  return (
    <AnchoredPopover
      open
      onClose={onClose}
      anchorRef={anchorRef}
      id={`persona-switcher-${persona.id}`}
      label={t('persona.switcherAria', { name: persona.name })}
      align={align}
      widthClassName="w-80"
      className="flex max-h-[min(70vh,480px)] flex-col overflow-y-hidden p-0"
      data={{ 'data-persona-conversation-switcher': '' }}
      initialFocusSelector="[role='menuitem']"
      onSurfaceKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
        // A pure arrow key; an Escape that reached here was not consumed by an
        // inner control, so the popover's own handler closes it.
        event.preventDefault();
        const menuItems = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        const index = menuItems.indexOf(document.activeElement as HTMLElement);
        menuItems[(index + (event.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length]?.focus();
        return true;
      }}
    >
      <div role="menu" aria-label={t('persona.switcherAria', { name: persona.name })} className="flex min-h-0 flex-1 flex-col">
      {/* Who this list belongs to; settings is the persona's, not the session's. */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-3">
        <PersonaAvatar persona={avatarData} size={20} decorative />
        <span className="min-w-0 shrink truncate text-[13px] font-medium text-ink">{persona.name}</span>
        {persona.title !== undefined && persona.title.trim() !== '' ? (
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint">{persona.title}</span>
        ) : <span className="flex-1" />}
        <button
          type="button"
          data-persona-switcher-settings
          onClick={() => {
            onClose();
            void navigate(`/personas?persona=${encodeURIComponent(persona.id)}&view=settings`);
          }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
          title={t('persona.settingsTitle')}
          aria-label={t('persona.settingsTitle')}
        >
          <Icon name="settings" size={14} />
        </button>
      </div>

      {conversationCount > MAX_OTHER_ROWS ? (
        <div className="shrink-0 border-b border-hairline px-2 py-1.5">
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-faint">
              <Icon name="search" size={12} />
            </span>
            <input
              type="text"
              value={query}
              onChange={(event) => { setQuery(event.target.value); }}
              placeholder={t('persona.searchConversations')}
              aria-label={t('persona.searchConversations')}
              className="h-7 w-full rounded-md border border-hairline bg-paper pr-2 pl-6 text-[12px] text-ink placeholder:text-ink-faint focus:border-hairline-strong focus:outline-none"
            />
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        <ul className="flex flex-col gap-px">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                role="menuitem"
                data-conversation-item={item.id}
                data-conversation-kind={item.kind}
                aria-current={item.isCurrent ? 'true' : undefined}
                onClick={() => {
                  onClose();
                  void navigate(item.targetUrl);
                }}
                className="row-interactive flex w-full items-start gap-2 py-1.5 pr-1 pl-2 text-left"
              >
                <span className="flex h-[19px] w-[7px] shrink-0 items-center">
                  <LifeMark
                    markId={`switcher:${item.id}`}
                    life={item.life}
                    still
                    tone={item.needsYou ? 'bg-attention' : undefined}
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1 text-[13px] leading-[19px]">
                    {item.kind === 'daily' ? (
                      <span aria-hidden className="shrink-0 text-ink-faint"><Icon name="pin" size={12} /></span>
                    ) : item.kind === 'room' ? (
                      <span aria-hidden className="shrink-0 font-mono text-ink-faint">#</span>
                    ) : null}
                    <span className={`min-w-0 truncate ${
                      item.isCurrent || item.needsYou || item.life === 'done' ? 'font-medium text-ink' : 'text-ink-soft'
                    }`}>
                      {item.title}
                    </span>
                  </span>
                  {item.workspaceName !== undefined || (item.kind === 'daily' && persona.homeSessionId === undefined) ? (
                    <span className="mt-px min-w-0 truncate text-[11px] leading-4 text-ink-faint">
                      {item.kind === 'daily' && persona.homeSessionId === undefined
                        ? t('persona.dailyStartFirst')
                        : item.workspaceName}
                    </span>
                  ) : null}
                </span>
                {item.updatedAt !== undefined ? (
                  <RelativeTime at={item.updatedAt} className="mt-0.5 shrink-0 text-[11px] leading-4 text-ink-faint tabular-nums" />
                ) : null}
              </button>
            </li>
          ))}
          {/* The daily row is always there, so an empty search is the only
              * way the list narrows to nothing. A read that is still running
              * or that failed is a different fact from "no matches", and the
              * list would otherwise show only the daily entrance, which reads
              * as "this persona has nothing". */}
          {items.every((item) => item.kind === 'daily') ? (
            <li className="px-3 py-4 text-center text-[12px] text-ink-faint">
              {status?.error !== undefined
                ? t('persona.conversationsLoadFailed', { detail: status.error })
                : status?.loading === true
                  ? t('persona.conversationsLoading')
                  : t('persona.noConversations')}
            </li>
          ) : null}
        </ul>
      </div>

      <div className="flex h-9 shrink-0 items-center justify-between border-t border-hairline px-2 text-[12px]">
        <button
          type="button"
          data-persona-switcher-new
          onClick={() => {
            onClose();
            // A new topic started from a project conversation stays in that
            // project; the daily pointer is untouched either way.
            void navigate(personaNewConversationUrl(persona.id, currentWorkspaceId));
          }}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
        >
          <Icon name="plus" size={12} />
          <span>{t('persona.newTopic')}</span>
        </button>
        <button
          type="button"
          data-persona-switcher-all
          onClick={() => {
            onClose();
            void navigate(`/personas?persona=${encodeURIComponent(persona.id)}&view=conversations`);
          }}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
        >
          <span>{t('persona.allConversations')}</span>
          <Icon name="arrowRight" size={12} />
        </button>
      </div>
      </div>
    </AnchoredPopover>
  );
}
