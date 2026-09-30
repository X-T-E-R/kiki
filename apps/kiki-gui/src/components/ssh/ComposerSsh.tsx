/**
 * The composer's SSH surface for a live session:
 *
 *   - ＋ › SSH hosts: tick configured hosts to add them to this session
 *     (PUT/DELETE /sessions/{id}/ssh/hosts/{host}); "New host…" opens the same
 *     form as Settings and adds the new host here; "Manage hosts" goes to
 *     Settings › SSH hosts.
 *   - One small chip per added host above the input, removable in place.
 *
 * Adding a host does not connect to it. There is no push event for session
 * hosts, so every change refetches the session list (contract).
 */

import { useState, type ReactNode } from 'react';
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
import { useConnection } from '../../state/connection';
import { Icon } from '../icons';
import { stateDotClass } from './SshBits';
import { SshHostFormDialog } from './SshHostFormDialog';

const PANEL_ROW =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-visible:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-not-allowed disabled:opacity-50';

export interface ComposerSsh {
  /** False hides every SSH affordance (flag off, no session, no REST). */
  readonly available: boolean;
  /** Count shown on the ＋ menu row. */
  readonly joinedCount: number;
  /** The ＋ menu's SSH view; `close` closes the popover. */
  readonly renderPanel: (close: (refocus?: boolean) => void) => ReactNode;
  /** Chips above the input; null when nothing is added. */
  readonly chips: ReactNode;
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
  const available = enabled && sessionId !== undefined && flag.enabled === true && client.klient.rest !== undefined;
  const hostsQuery = useSshHosts(client, available);
  const sessionQuery = useSessionSshHosts(client, sessionId, available);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const joined = sessionQuery.data ?? [];
  const joinedIds = new Set(joined.map((entry) => entry.host.id));

  const setBusy = (id: string, busy: boolean) => {
    setPending((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const refetchSession = async () => {
    if (sessionId === undefined) return;
    await queryClient.invalidateQueries({ queryKey: sshKeys.session(sessionId) });
  };

  const toggle = async (host: SshHost, join: boolean) => {
    if (sessionId === undefined || pending.has(host.id)) return;
    setBusy(host.id, true);
    try {
      if (join) await sshApi(client).addSessionHost(sessionId, host.id);
      else await sshApi(client).removeSessionHost(sessionId, host.id);
      await refetchSession();
    } catch (error) {
      pushToast({
        tone: 'error',
        text: t(join ? 'composer.ssh.addFailed' : 'composer.ssh.removeFailed', { name: host.name, detail: errorText(locale, error) }),
      });
    } finally {
      setBusy(host.id, false);
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
      <p className="px-2.5 pt-1.5 pb-1 text-[12px] font-medium text-ink-faint">{t('composer.ssh.heading')}</p>
      {hostsQuery.isLoading ? (
        <p className="px-2.5 py-1.5 text-[12px] text-ink-faint">{t('composer.ssh.loading')}</p>
      ) : hostsQuery.isError ? (
        <p role="alert" className="px-2.5 py-1.5 text-[12px] leading-4 text-danger">{errorText(locale, hostsQuery.error)}</p>
      ) : hosts.length === 0 ? (
        <p data-composer-ssh-empty className="px-2.5 py-1.5 text-[12px] leading-4 text-ink-faint">{t('composer.ssh.empty')}</p>
      ) : (
        <div className="max-h-64 overflow-y-auto">
          {hosts.map((host) => {
            const on = joinedIds.has(host.id);
            const target = sshTargetLabel(host);
            return (
              <button
                key={host.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                data-menu-row
                data-composer-ssh-host={host.id}
                // aria-disabled, not disabled: a disabled button drops focus to <body>, so Escape and arrows would stop working mid-toggle.
                aria-disabled={pending.has(host.id) || undefined}
                onClick={() => { if (!pending.has(host.id)) void toggle(host, !on); }}
                className={`${PANEL_ROW} items-start aria-disabled:opacity-60`}
              >
                <span aria-hidden className={`flex h-[19px] w-3 shrink-0 items-center ${on ? 'text-ink' : 'text-transparent'}`}>
                  <Icon name="check" size={12} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate ${on ? 'font-medium text-ink' : 'text-ink'}`}>{host.name}</span>
                  <span className={`block truncate text-[12px] leading-4 text-ink-faint ${target !== undefined ? 'font-mono' : ''}`}>
                    {host.source === 'session'
                      ? <span className="font-sans">{t('composer.ssh.temporary')}</span>
                      : target ?? (host.source === 'ssh-config' ? t('composer.ssh.fromConfig') : host.id)}
                  </span>
                </span>
              </button>
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
      <p className="px-2.5 pt-1 pb-1.5 text-[12px] leading-4 text-ink-faint">{t('composer.ssh.hint')}</p>
    </div>
  );

  const chips = available && joined.length > 0 ? (
    <div data-composer-ssh-chips role="list" aria-label={t('composer.ssh.chipsAria')} className="mx-3.5 mt-2 flex flex-wrap gap-1.5">
      {joined.map(({ host, status }) => {
        const state = visibleState(status);
        const target = sshTargetLabel(host);
        return (
          <span
            key={host.id}
            role="listitem"
            data-composer-ssh-chip={host.id}
            title={target === undefined ? host.id : `${host.id} · ${target}`}
            className="anim-enter inline-flex h-6 max-w-[14rem] items-center gap-1.5 rounded-md bg-ink/[0.05] pr-0.5 pl-2 text-[12px] text-ink-soft"
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
      })}
    </div>
  ) : null;

  const dialog = creating && sessionId !== undefined ? (
    <SshHostFormDialog
      mode={{ kind: 'create' }}
      onClose={() => { setCreating(false); }}
      onSubmit={async (id, input) => {
        await sshApi(client).upsert(id, input);
        await queryClient.invalidateQueries({ queryKey: sshKeys.hosts() });
        setCreating(false);
        // Created from this session's menu: add it here too.
        try {
          await sshApi(client).addSessionHost(sessionId, id);
        } catch (error) {
          pushToast({ tone: 'error', text: t('composer.ssh.addFailed', { name: input.name, detail: errorText(locale, error) }) });
        }
        await refetchSession();
      }}
    />
  ) : null;

  const searchHosts = hosts.map((host) => ({ id: host.id, name: host.name, detail: sshTargetLabel(host), joined: joinedIds.has(host.id) }));
  const toggleHost = (id: string) => {
    const host = hosts.find((entry) => entry.id === id);
    if (host !== undefined) void toggle(host, !joinedIds.has(id));
  };

  return { available, joinedCount: joined.length, renderPanel, chips, dialog, hosts: searchHosts, toggleHost };
}
