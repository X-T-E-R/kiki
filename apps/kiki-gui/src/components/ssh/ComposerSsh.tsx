/**
 * The composer's SSH surface for a live session: one resident control beside
 * the input that holds the hosts joined to THIS session for as long as the
 * session lives.
 *
 *   - The strip appears only once this session has SSH context — a joined
 *     host, or on /new a host picked to join. With nothing joined it is not
 *     drawn at all: an "SSH 0" line beside the input reads as a control the
 *     user must clear, and a zero count is not session state. The ＋ menu's SSH
 *     view stays the way in, so hiding the strip removes no route to adding.
 *   - 1–3 hosts: shown directly in the strip without folding.
 *   - >3 hosts: folded by default into the trigger pill with an explicit
 *     manual expand/collapse toggle so the resident row never balloons over
 *     the composer input.
 *   - Panel: shows each host with a clear enabled/disabled status, an operable
 *     Toggle switch, and an independent connection state mark. Joining a host
 *     to the session does not initiate a TCP connection.
 *
 * "In use" is the session's host list, never whether a request is on the wire
 * right now: a joined host stays joined between turns, and keying the strip to
 * live traffic would make it blink out mid-conversation.
 *
 * Adding a host does not connect to it. There is no push event for session
 * hosts, so every change refetches the session list (contract).
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { SshHostAttachment } from '@kiki/session-core/composer';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import {
  sshApi,
  sshKeys,
  sshTargetLabel,
  useNativeSshEnabled,
  useSessionSshHosts,
  useSshHosts,
  visibleState,
  type SshHost,
} from '../../lib/ssh';
import { pushToast } from '../../lib/toasts';
import { registerOverlay } from '../../lib/uiBusy';
import { useConnection } from '../../state/connection';
import { Toggle } from '../controls';
import { Icon } from '../icons';
import { POPOVER_SURFACE_CLASS } from '../SearchableSelect';
import { SSH_HOST_CHIP_CLASS, SshStateMark, stateDotClass } from './SshBits';
import { SshHostFormDialog } from './SshHostFormDialog';

const NO_INFLIGHT_HOSTS: ReadonlySet<string> = new Set();

const PANEL_ROW =
  'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13px] text-ink outline-none transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-visible:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-not-allowed disabled:opacity-50';

export interface ComposerSsh {
  /** False hides every SSH affordance (flag off or no REST). */
  readonly available: boolean;
  /** Display snapshot; actual host access is granted only by PUT join. */
  readonly snapshot: readonly SshHostAttachment[];
  readonly pending: boolean;
  /** Count shown on the ＋ menu row. */
  readonly joinedCount: number;
  /** The ＋ menu's SSH view; `close` closes the popover. */
  readonly renderPanel: (close: (refocus?: boolean) => void) => ReactNode;
  /** The resident session strip; null when this session has no SSH context. */
  readonly resident: ReactNode;
  /** The host form, mounted outside the popover so it survives the close. */
  readonly dialog: ReactNode;
  /** Hosts for the ＋ menu search (same list as the panel). */
  readonly hosts: readonly { readonly id: string; readonly name: string; readonly detail?: string; readonly joined: boolean }[];
  /** Join or leave one host by id (the panel row's toggle). */
  readonly toggleHost: (id: string) => void;
}

export function useComposerSsh(sessionId: string | undefined, enabled: boolean): ComposerSsh {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const flag = useNativeSshEnabled(client);
  const available = enabled && flag.enabled === true && client.klient.rest !== undefined;
  const hostsQuery = useSshHosts(client, available);
  const sessionQuery = useSessionSshHosts(client, sessionId, available);
  // Join/leave flights keyed by the session that started them. The resident
  // hook survives route changes, so a single set would disable the next
  // conversation until the previous request settled, and its `finally` would
  // clear a join the next conversation had already started.
  const inflightRef = useRef(new Map<string, Set<string>>());
  const [inflightBySession, setInflightBySession] = useState<ReadonlyMap<string, ReadonlySet<string>>>(() => new Map());
  const sessionKeyRef = useRef(sessionId);
  sessionKeyRef.current = sessionId;
  const aliveRef = useRef(true);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<readonly SshHost[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  useEffect(() => {
    setSelected([]);
    setUserExpanded(null);
  }, [sessionId]);

  const pending = sessionId === undefined ? NO_INFLIGHT_HOSTS : inflightBySession.get(sessionId) ?? NO_INFLIGHT_HOSTS;

  const joined = sessionId === undefined ? selected.map((host) => ({ host, status: undefined })) : sessionQuery.data ?? [];
  const joinedIds = new Set(joined.map((entry) => entry.host.id));

  const setBusy = (key: string, id: string, busy: boolean) => {
    const map = inflightRef.current;
    const ids = new Set(map.get(key) ?? []);
    if (busy) ids.add(id);
    else ids.delete(id);
    if (ids.size === 0) map.delete(key);
    else map.set(key, ids);
    if (!aliveRef.current) return;
    setInflightBySession(new Map(map));
  };

  // The server's list is the truth the strip draws, so a change reads it back
  // instead of trusting the local toggle. Refetching (not only invalidating)
  // keeps the awaited promise tied to that read.
  const refetchSession = async () => {
    if (sessionId === undefined) return;
    await sessionQuery.refetch();
  };

  const toggle = async (host: SshHost, join: boolean) => {
    if (sessionId !== undefined && inflightRef.current.get(sessionId)?.has(host.id)) return;
    if (sessionId === undefined) {
      setSelected((current) => join ? [...current.filter((entry) => entry.id !== host.id), host] : current.filter((entry) => entry.id !== host.id));
      return;
    }
    const key = sessionId;
    setBusy(key, host.id, true);
    try {
      if (join) await sshApi(client).addSessionHost(key, host.id);
      else await sshApi(client).removeSessionHost(key, host.id);
      await refetchSession();
    } catch (error) {
      if (!aliveRef.current || sessionKeyRef.current !== key) return;
      pushToast({
        tone: 'error',
        text: t(join ? 'composer.ssh.addFailed' : 'composer.ssh.removeFailed', { name: host.name, detail: errorText(locale, error) }),
      });
    } finally {
      setBusy(key, host.id, false);
    }
  };

  // Temporary `user@host` targets exist only in this session's list; show them too.
  const configured = hostsQuery.data ?? [];
  const hosts = [
    ...configured,
    ...joined.map((entry) => entry.host).filter((host) => host.source === 'session' && !configured.some((c) => c.id === host.id)),
  ];

  const renderPanel = (close: (refocus?: boolean) => void) => (
    <div data-composer-ssh-panel>
      <p className="px-3 pt-1.5 pb-1 text-[12px] font-medium text-ink-faint">{t('composer.ssh.heading')}</p>
      {hostsQuery.isLoading ? (
        <p className="px-3 py-1.5 text-[12px] text-ink-faint">{t('composer.ssh.loading')}</p>
      ) : hostsQuery.isError ? (
        <p role="alert" className="px-3 py-1.5 text-[12px] leading-4 text-danger">{errorText(locale, hostsQuery.error)}</p>
      ) : hosts.length === 0 ? (
        <p data-composer-ssh-empty className="px-3 py-1.5 text-[12px] leading-4 text-ink-faint">{t('composer.ssh.empty')}</p>
      ) : (
        <div className="max-h-64 overflow-y-auto divide-y divide-hairline/40">
          {hosts.map((host) => {
            const on = joinedIds.has(host.id);
            const target = sshTargetLabel(host);
            const joinedEntry = joined.find((entry) => entry.host.id === host.id);
            const state = visibleState(joinedEntry?.status);
            const isBusy = pending.has(host.id);
            const statusText = t(on ? 'composer.ssh.enabled' : 'composer.ssh.disabled');
            const switchLabel = t('composer.ssh.switchLabel', {
              name: host.name,
              status: statusText,
            });

            return (
              <div
                key={host.id}
                data-menu-row
                data-composer-ssh-host={host.id}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13px] transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.03] ${
                  isBusy ? 'opacity-60' : ''
                }`}
              >
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    if (!isBusy) void toggle(host, !on);
                  }}
                  className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 rounded"
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`truncate ${on ? 'font-medium text-ink' : 'text-ink-soft'}`}>{host.name}</span>
                    {on && state !== undefined ? (
                      <SshStateMark state={state} compact />
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] leading-4 text-ink-faint">
                    <span className={target !== undefined ? 'font-mono' : ''}>
                      {host.source === 'session'
                        ? t('composer.ssh.temporary')
                        : target ?? (host.source === 'ssh-config' ? t('composer.ssh.fromConfig') : host.id)}
                    </span>
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`text-[11px] font-medium transition-colors select-none ${on ? 'text-ink' : 'text-ink-faint'}`}>
                    {statusText}
                  </span>
                  <span data-composer-ssh-switch={host.id}>
                    <Toggle
                      id={`composer-ssh-toggle-${host.id}`}
                      layout="bare"
                      label={switchLabel}
                      checked={on}
                      disabled={isBusy}
                      onChange={(checked) => {
                        if (!isBusy) void toggle(host, checked);
                      }}
                    />
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-1 border-t border-hairline pt-1">
        <button
          type="button"
          role="menuitem"
          data-menu-row
          data-composer-ssh-new
          onClick={() => { close(); setCreating(true); }}
          className={PANEL_ROW}
        >
          <Icon name="plus" size={14} className="text-ink-soft" />
          <span className="flex-1">{t('composer.ssh.newHost')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-menu-row
          data-composer-ssh-manage
          onClick={() => { close(); void navigate('/settings/ssh'); }}
          className={PANEL_ROW}
        >
          <Icon name="settings" size={14} className="text-ink-soft" />
          <span className="flex-1">{t('composer.ssh.manage')}</span>
        </button>
      </div>
      <p className="px-3 pt-1 pb-1.5 text-[12px] leading-4 text-ink-faint">{t(sessionId === undefined ? 'composer.ssh.draftHint' : 'composer.ssh.sessionHint')}</p>
    </div>
  );

  // The resident list: the same rows the ＋ menu shows, docked under the
  // trigger so the strip can stand on its own without the add menu.
  const listId = useId();
  useEffect(() => {
    if (!listOpen) return;
    const unregister = registerOverlay('composer-ssh-strip');
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('[data-composer-ssh-strip]') === null) setListOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setListOpen(false); };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      unregister();
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [listOpen]);

  // The strip is a session-context control, so it stands only while this
  // session has SSH context. A session whose host list has not been read yet
  // is not an empty session: the strip waits for that read rather than
  // flashing a zero line and then growing one chip. On /new the picks are
  // local state, so an empty pick is genuinely empty.
  const contextKnown = sessionId === undefined || sessionQuery.data !== undefined;
  const isExpanded = joined.length <= 3 ? true : (userExpanded ?? false);

  const resident = available && contextKnown && joined.length > 0 ? (
    <div
      data-composer-ssh-strip
      data-composer-ssh-open={listOpen ? '' : undefined}
      className="mx-3 mt-2 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1"
    >
      <button
        type="button"
        data-composer-ssh-toggle
        aria-expanded={listOpen}
        aria-controls={listId}
        title={t(sessionId === undefined ? 'composer.ssh.draftHint' : 'composer.ssh.sessionHint')}
        onClick={() => { setListOpen((open) => !open); }}
        className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md pl-1.5 pr-1.5 text-[11px] font-medium tracking-wide text-ink-faint uppercase transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink-soft focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-8 ${listOpen ? 'bg-ink/[0.05] text-ink-soft' : ''}`}
      >
        <Icon name="terminal" size={12} className="shrink-0" />
        {/* Just "SSH": the strip only ever draws a session's own hosts, so the
            scope is what it means rather than something to spell out. */}
        <span className="shrink-0">{t('composer.ssh.hosts')}</span>
        <span className="shrink-0 tabular-nums">{joined.length}</span>
        <Icon name="chevron" size={12} className={`shrink-0 transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${listOpen ? 'rotate-90' : ''}`} />
      </button>

      {joined.length > 3 ? (
        <button
          type="button"
          data-composer-ssh-expand
          aria-expanded={isExpanded}
          onClick={() => { setUserExpanded(!isExpanded); }}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink-soft focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-8"
        >
          <span>
            {isExpanded
              ? t('composer.ssh.collapse')
              : t('composer.ssh.expand', { count: joined.length })}
          </span>
          <Icon
            name="chevron"
            size={12}
            className={`shrink-0 transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${
              isExpanded ? '-rotate-90' : 'rotate-90'
            }`}
          />
        </button>
      ) : null}

      {isExpanded ? joined.map(({ host, status }) => {
        const state = visibleState(status);
        const target = sshTargetLabel(host);
        return (
          <span
            key={host.id}
            role="listitem"
            data-composer-ssh-chip={host.id}
            title={target === undefined ? host.id : `${host.id} · ${target}`}
            className={`anim-enter ${SSH_HOST_CHIP_CLASS} pr-0.5 pl-2`}
          >
            <Icon name="terminal" size={12} className="text-ink-faint" />
            <span className="min-w-0 truncate">{host.name}</span>
            {state !== undefined ? (
              <span aria-label={t(`st.ssh.state.${state}`)} role="img" className={`h-1.5 w-1.5 shrink-0 rounded-full ${stateDotClass(state)}`} />
            ) : null}
            <button
              type="button"
              data-composer-ssh-chip-remove
              aria-label={t('composer.ssh.removeChip', { name: host.name })}
              title={t('composer.ssh.removeChip', { name: host.name })}
              disabled={pending.has(host.id)}
              onClick={() => void toggle(host, false)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:opacity-50 pointer-coarse:h-8 pointer-coarse:w-8"
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        );
      }) : null}

      {listOpen ? (
        <div
          id={listId}
          data-composer-ssh-list
          role="group"
          aria-label={t('composer.ssh.heading')}
          className={`anim-enter mt-1 w-full min-w-0 rounded-[10px] p-1 ${POPOVER_SURFACE_CLASS}`}
        >
          {renderPanel(() => { setListOpen(false); })}
        </div>
      ) : null}
    </div>
  ) : null;

  const dialog = creating ? (
    <SshHostFormDialog
      mode={{ kind: 'create' }}
      onClose={() => { setCreating(false); }}
      onSubmit={async (id, input) => {
        const { host } = await sshApi(client).upsert(id, input);
        await queryClient.invalidateQueries({ queryKey: sshKeys.hosts() });
        setCreating(false);
        await toggle(host, true);
      }}
    />
  ) : null;

  const searchHosts = hosts.map((host) => ({ id: host.id, name: host.name, detail: sshTargetLabel(host), joined: joinedIds.has(host.id) }));
  const toggleHost = (id: string) => {
    const host = hosts.find((entry) => entry.id === id);
    if (host !== undefined) void toggle(host, !joinedIds.has(id));
  };

  const snapshot: readonly SshHostAttachment[] = available ? joined.map(({ host }) => ({ kind: 'ssh', id: host.id, name: host.name })) : [];
  // Reading the session host list is not a send. A live prompt does not carry
  // `snapshot`; only a join or leave this session itself started still blocks.
  return { available, snapshot, pending: pending.size > 0, joinedCount: joined.length, renderPanel, resident, dialog, hosts: searchHosts, toggleHost };
}
