import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';

import type { UpdateSpaceResponse } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import {
  readDesktopPrefs,
  writeDesktopPrefs,
  type SpaceWindowMode,
} from '@kiki/session-core/settings';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import {
  MAIN_SPACE_ID,
  currentSpace,
  enterSpace,
  homesApi,
  launchWindowMode,
  spaceKeys,
  spaceRunState,
  spaceStatus,
  useSpaceStatuses,
  useSpaces,
  type SpaceListItem,
} from '../../lib/spaces';
import { pushToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { Icon } from '../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { CreateSpaceDialog } from './spaces/CreateSpaceDialog';
import { AttachSpaceDialog, DeleteSpaceDialog, SpaceCredentialsDialog } from './spaces/SpaceDialogs';
import { SpaceDot } from './spaces/SpaceDot';
import { SpaceRowMenu, type SpaceMenuItem } from './spaces/SpaceRowMenu';
import { SpaceCredentialsCard, SpaceOverridesCard } from './spaces/SubspaceCards';

/**
 * Settings → Spaces (§9.1). The main space manages the list; a space sees the
 * same list read-only plus its own accounts card and what it changed locally.
 * Physical rename is not offered: the contract has no rename yet.
 */
export function SpacesSection() {
  const sub = currentSpace() !== null;
  return (
    <>
      <WindowModeCard sub={sub} />
      <SpaceListCard sub={sub} />
      {sub ? <SpaceCredentialsCard /> : null}
      {sub ? <SpaceOverridesCard /> : null}
    </>
  );
}

function WindowModeCard({ sub }: { sub: boolean }) {
  const host = useHost();
  const { t } = useI18n();
  const [prefs, setPrefs] = useState(readDesktopPrefs);
  const desktop = host.kind === 'tauri';
  // What the running process uses; a new choice waits for the next launch.
  const [launched] = useState(() => launchWindowMode(readDesktopPrefs().windowMode));

  useEffect(() => {
    if (host.kind !== 'tauri') return;
    void host.readDesktopPrefs().then((native) => {
      if (native === null) return;
      writeDesktopPrefs(native);
      setPrefs(readDesktopPrefs());
    });
  }, [host]);

  const choose = (windowMode: SpaceWindowMode) => {
    writeDesktopPrefs({ windowMode });
    setPrefs(readDesktopPrefs());
    if (host.kind === 'tauri') void host.writeDesktopPrefs({ windowMode });
  };

  const aside = !desktop ? t('st.spaces.windowBrowserHint') : sub ? t('st.spaces.windowSubHint') : undefined;
  return (
    <SectionCard id="st-card-space-window" title={t('st.spaces.windowTitle')} scope="app" aside={aside}>
      {desktop && !sub ? (
        <fieldset className="space-y-2" data-space-window-mode={prefs.windowMode}>
          <legend className="sr-only">{t('st.spaces.windowTitle')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {([
              { value: 'switch', titleKey: 'st.spaces.windowSwitch', descKey: 'st.spaces.windowSwitchDesc' },
              { value: 'windows', titleKey: 'st.spaces.windowWindows', descKey: 'st.spaces.windowWindowsDesc' },
            ] as const).map((option) => {
              const selected = prefs.windowMode === option.value;
              return (
                <label key={option.value} data-space-window-choice={option.value}
                  className={`cursor-pointer rounded-lg p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-selected-ink/50 ${selected ? 'bg-panel shadow-[var(--kiki-sheet-shadow)]' : 'bg-ink/[0.03] hover:bg-ink/[0.05]'}`}>
                  <span className="flex items-start gap-2">
                    <input type="radio" name="space-window-mode" checked={selected} onChange={() => { choose(option.value); }}
                      className="mt-0.5 accent-[var(--color-selected-ink)]" />
                    <span>
                      <span className="block text-[13px] font-medium text-ink">{t(option.titleKey)}</span>
                      <span className="mt-0.5 block text-[12px] text-ink-faint">{t(option.descKey)}</span>
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <p className="text-[12px] text-ink-faint" data-space-window-note>
            {prefs.windowMode !== launched
              ? <span className="font-medium text-amber-ink">{t('st.spaces.windowPending')}</span>
              : t('st.spaces.windowNextLaunch')}
          </p>
        </fieldset>
      ) : null}
    </SectionCard>
  );
}

function SpaceListCard({ sub }: { sub: boolean }) {
  const { client } = useConnection();
  const host = useHost();
  const { t, tp, locale } = useI18n();
  const queryClient = useQueryClient();
  const spaces = useSpaces(client);
  const statuses = useSpaceStatuses(host);
  const [dialog, setDialog] = useState<
    | { kind: 'create' } | { kind: 'attach' }
    | { kind: 'remove'; space: SpaceListItem } | { kind: 'delete'; space: SpaceListItem }
    | { kind: 'credentials'; space: SpaceListItem } | null
  >(null);
  const [menu, setMenu] = useState<{ space: SpaceListItem; anchor: DOMRect } | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [restartNote, setRestartNote] = useState<{ id: string; text: string } | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const desktop = host.kind === 'tauri';
  const mode = launchWindowMode(readDesktopPrefs().windowMode);
  const location = useLocation();
  const navigate = useNavigate();

  // The sidebar's "New space…" lands here with ?new=1: open create once, then
  // drop the flag so back/refresh does not reopen it.
  const wantsCreate = !sub && new URLSearchParams(location.search).get('new') === '1';
  useEffect(() => {
    if (!wantsCreate) return;
    setDialog({ kind: 'create' });
    void navigate(location.pathname, { replace: true });
  }, [wantsCreate, navigate, location.pathname]);

  const items = spaces.data ?? [];
  const main = items.find((item) => item.id === MAIN_SPACE_ID);
  const others = items.filter((item) => item.id !== MAIN_SPACE_ID);
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: spaceKeys.all }); };

  const enter = (space: SpaceListItem) => {
    setEntering(space.id);
    setFeedback(null);
    void enterSpace(host, space.id, mode)
      .catch(() => { setFeedback({ tone: 'error', text: t('st.spaces.switchFailed', { name: space.name }) }); })
      .finally(() => { setEntering(null); });
  };

  const deleteBlock = (space: SpaceListItem): string | undefined => {
    const run = spaceRunState(space.id, statuses.data);
    if (run === 'current') return t('st.spaces.deleteDisabledCurrent');
    if ((spaceStatus(space.id, statuses.data)?.busyCount ?? 0) > 0) return t('st.spaces.deleteDisabledBusy');
    if (run === 'hot') return t('st.spaces.deleteDisabledOpen');
    return undefined;
  };

  const menuItems = (space: SpaceListItem): SpaceMenuItem[] => [
    ...(host.revealPath !== undefined ? [{ key: 'reveal', label: t('st.spaces.reveal'), run: () => { void host.revealPath?.(space.path).catch(() => undefined); } }] : []),
    { key: 'credentials', label: t('st.spaces.credentials'), run: () => { setDialog({ kind: 'credentials', space }); } },
    ...(desktop && host.restartSpace !== undefined ? [{ key: 'restart', label: t('st.spaces.restartSpace'), run: () => {
      setFeedback(null);
      void host.restartSpace?.(space.id)
        .then(() => { setRestartNote(null); refresh(); })
        .catch((error: unknown) => { setFeedback({ tone: 'error', text: errorText(locale, error) }); });
    } }] : []),
    { key: 'remove', label: t('st.spaces.removeFromList'), separatorBefore: true, run: () => { setDialog({ kind: 'remove', space }); } },
    { key: 'delete', label: t('st.spaces.delete'), danger: true, blockedReason: deleteBlock(space), run: () => { setDialog({ kind: 'delete', space }); } },
  ];

  const onCredentialsDone = (space: SpaceListItem, result: UpdateSpaceResponse) => {
    setDialog(null);
    refresh();
    const parts = [t(result.space.credentials_shared ? 'st.spaces.credDoneShared' : 'st.spaces.credDoneIsolated', { name: space.name })];
    if (result.copied_ssh_entries > 0) parts.push(tp('st.spaces.copiedSsh', result.copied_ssh_entries));
    if (result.retained_isolated_ssh_entries !== undefined && result.retained_isolated_ssh_entries > 0) {
      parts.push(tp('st.spaces.retainedSsh', result.retained_isolated_ssh_entries));
    }
    setFeedback({ tone: 'success', text: parts.join(' ') });
    setRestartNote(result.restart_required ? { id: space.id, text: t('st.spaces.restartRequired', { name: space.name }) } : null);
  };

  return (
    <SectionCard id="st-card-spaces" title={t('st.spaces.listTitle')} scope="server">
      <div className="space-y-3" data-space-list>
        {!sub ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" data-space-new className={`${PRIMARY_BUTTON} inline-flex items-center gap-1`} onClick={() => { setDialog({ kind: 'create' }); }}>
              <Icon name="plus" size={12} />{t('st.spaces.new')}
            </button>
            <button type="button" data-space-attach-open className={SECONDARY_BUTTON} onClick={() => { setDialog({ kind: 'attach' }); }}>{t('st.spaces.attach')}</button>
          </div>
        ) : <Hint>{t('st.spaces.subManageHint')}</Hint>}

        {spaces.isLoading ? <Hint>{t('st.spaces.loading')}</Hint> : null}
        {spaces.isError ? <InlineError error={spaces.error} /> : null}

        {items.length > 0 ? (
          <ul className="divide-y divide-hairline rounded-lg border border-hairline bg-paper">
            {[...(main === undefined ? [] : [main]), ...others].map((space) => {
              const run = spaceRunState(space.id, statuses.data);
              const pending = mode === 'switch' ? (spaceStatus(space.id, statuses.data)?.pendingCount ?? 0) : 0;
              const isMain = space.id === MAIN_SPACE_ID;
              const label = isMain ? t('st.spaces.main') : space.name;
              return (
                <li key={space.id} data-space-row={space.id} data-space-state={run} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                  <SpaceDot color={isMain ? 'var(--color-ink-faint)' : space.color} className="mt-px" />
                  <div className="min-w-0 flex-1 basis-48">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="min-w-0 truncate text-[13px] font-medium text-ink" title={label}>{label}</span>
                      {!isMain ? (
                        <span className="text-[12px] text-ink-faint" data-space-cred={space.credentials_shared === false ? 'isolated' : 'shared'}>
                          {t(space.credentials_shared === false ? 'st.spaces.credIsolatedShort' : 'st.spaces.credSharedShort')}
                        </span>
                      ) : null}
                    </div>
                    <p className="truncate font-mono text-[11px] text-ink-faint" title={space.path}>{space.path}</p>
                    {restartNote?.id === space.id ? <p className="mt-0.5 text-[12px] font-medium text-amber-ink" data-space-restart-note>{restartNote.text}</p> : null}
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    {pending > 0 && run !== 'current' ? (
                      <span data-space-pending className="rounded-full bg-attention-soft px-1.5 text-[11.5px] font-medium tabular-nums text-attention">{tp('st.spaces.pending', pending)}</span>
                    ) : null}
                    {run === 'current' ? (
                      <span className="text-[12px] font-medium text-ink-soft" data-space-current>{t('st.spaces.current')}</span>
                    ) : (
                      <>
                        {desktop && mode === 'switch' ? (
                          <span className="inline-flex items-center gap-1 text-[12px] text-ink-faint" data-space-run={run}>
                            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${run === 'hot' ? 'bg-success' : 'border border-ink-faint/70'}`} />
                            {t(run === 'hot' ? 'st.spaces.running' : 'st.spaces.notStarted')}
                          </span>
                        ) : null}
                        {desktop ? (
                          <button type="button" data-space-enter={space.id} disabled={entering !== null} className={SECONDARY_BUTTON}
                            onClick={() => { enter(space); }}>
                            {entering === space.id ? t('sidebar.space.starting', { name: label }) : t(mode === 'switch' ? 'st.spaces.switch' : 'st.spaces.open')}
                          </button>
                        ) : null}
                      </>
                    )}
                    {!sub && !isMain ? (
                      <button type="button" data-space-menu={space.id} aria-haspopup="menu" aria-label={t('st.spaces.menuAria', { name: space.name })}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
                        onClick={(event) => {
                          setMenu({ space, anchor: event.currentTarget.getBoundingClientRect() });
                        }}>
                        <Icon name="more" size={14} />
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}

        {spaces.isSuccess && others.length === 0 ? (
          <div className="rounded-lg border border-dashed border-hairline bg-paper/60 px-4 py-6 text-center" data-space-empty>
            <p className="text-[13px] font-medium text-ink">{t('st.spaces.emptyTitle')}</p>
            <p className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-ink-faint">{t('st.spaces.emptyBody')}</p>
          </div>
        ) : null}
        {!desktop && others.length > 0 ? <Hint>{t('st.spaces.desktopOnly')}</Hint> : null}
        <FeedbackLine feedback={feedback} />
      </div>

      {menu !== null ? (
        <SpaceRowMenu anchor={menu.anchor} items={menuItems(menu.space)} onClose={() => { setMenu(null); }}
          ariaLabel={t('st.spaces.menuAria', { name: menu.space.name })} />
      ) : null}

      {dialog?.kind === 'create' ? (
        <CreateSpaceDialog mainPath={main?.path ?? ''} canOpen={desktop}
          onClose={() => { setDialog(null); }}
          onCreated={(record, open) => {
            setDialog(null);
            refresh();
            pushToast({ tone: 'success', text: t('st.spaces.created', { name: record.name }) });
            if (open) void enterSpace(host, record.id, mode).catch(() => {
              setFeedback({ tone: 'error', text: t('st.spaces.switchFailed', { name: record.name }) });
            });
          }} />
      ) : null}
      {dialog?.kind === 'attach' ? (
        <AttachSpaceDialog onClose={() => { setDialog(null); }}
          onAttached={(record) => { setDialog(null); refresh(); setFeedback({ tone: 'success', text: t('st.spaces.attached', { name: record.name }) }); }} />
      ) : null}
      {dialog?.kind === 'remove' ? (
        <ConfirmDialog open overlayId="space-remove-confirm" tone="default"
          title={t('st.spaces.removeTitle', { name: dialog.space.name })}
          body={t('st.spaces.removeBody')}
          confirmLabel={t('st.spaces.removeFromList')}
          onCancel={() => { setDialog(null); }}
          onConfirm={() => {
            const target = dialog.space;
            setDialog(null);
            void homesApi(client).remove(target.id)
              .then(() => { refresh(); setFeedback({ tone: 'success', text: t('st.spaces.removed', { name: target.name }) }); })
              .catch((error: unknown) => { setFeedback({ tone: 'error', text: errorText(locale, error) }); });
          }} />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteSpaceDialog space={dialog.space} onClose={() => { setDialog(null); }}
          onDeleted={() => {
            const name = dialog.space.name;
            setDialog(null);
            refresh();
            setFeedback({ tone: 'success', text: t('st.spaces.deleted', { name }) });
          }} />
      ) : null}
      {dialog?.kind === 'credentials' ? (
        <SpaceCredentialsDialog space={dialog.space} onClose={() => { setDialog(null); }}
          onDone={(result) => { onCredentialsDone(dialog.space, result); }} />
      ) : null}
    </SectionCard>
  );
}
