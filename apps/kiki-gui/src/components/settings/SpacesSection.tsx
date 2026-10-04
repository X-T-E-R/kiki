import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { KikiClient } from '../../lib/client';
import { useSpaceSettingsTarget, type SpaceSettingsTarget } from '../../lib/spaceSettings';
import { useDirtyGuard, useGuardedNavigate } from '../dirtyGuard';
import {
  MAIN_SPACE_ID,
  currentSpace,
  currentSpaceId,
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
import { detectShortcutPlatform } from '../../lib/shortcuts';
import { pushToast } from '../../lib/toasts';
import { readHomeViewRoute } from '../../lib/spaceViewState';
import type { PreparedScope } from '../../lib/navScope';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { Icon } from '../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { LIST_ROW_HEIGHT, ListBody, ListEmpty, ListToolbar, useListView, type ListFilterSpec, type ListSortSpec } from './list';
import { CreateSpaceDialog } from './spaces/CreateSpaceDialog';
import { AttachSpaceDialog, DeleteSpaceDialog, SpaceCredentialsDialog } from './spaces/SpaceDialogs';
import { SpaceDot } from './spaces/SpaceDot';
import { SpaceRowMenu, type SpaceMenuItem } from './spaces/SpaceRowMenu';
import { SpaceCredentialsCard } from './spaces/SubspaceCards';
import { SpaceSettingsDetail } from './spaces/SpaceSettingsDetail';
import { RemoteConnectionsSection } from './RemoteConnectionsSection';
import { InboundConnectionsSection } from './InboundConnectionsSection';
import { WebAccessSection } from './WebAccessSection';

/**
 * Settings → Spaces (§9.1). The main space manages the list; a space sees the
 * same list read-only plus its own accounts card and its own settings. Physical
 * rename is not offered: the contract has no rename yet.
 */
export function SpacesSection() {
  const { client, localClient, meta } = useConnection();
  const host = useHost();
  const { t } = useI18n();
  const controlClient = host.kind === 'tauri' ? localClient : client;
  const controlTarget = useSpaceSettingsTarget(controlClient, controlClient === client ? meta : undefined);
  const sub = currentSpace() !== null;
  const openLocalSpace = useGuardedSpaceOpen(controlClient);
  const mode = launchWindowMode(readDesktopPrefs().windowMode);
  return (
    <>
      <WindowModeCard sub={sub} />
      {controlClient === null ? <Hint>{t('st.spaces.loading')}</Hint> : <>
        <SpaceListCard sub={sub} client={controlClient} target={controlTarget} openLocalSpace={openLocalSpace} />
        <RemoteConnectionsSection />
        <InboundConnectionsSection />
        <WebAccessSection />
        {sub ? <SpaceCredentialsCard client={controlClient} onEnterMain={() => openLocalSpace(MAIN_SPACE_ID, mode)} /> : null}
        {sub ? <CurrentSpaceSettings target={controlTarget} /> : null}
      </>}
    </>
  );
}

/**
 * The space this window is already in changes itself here (§4.1): the same
 * detail the row menu opens, read from the same contract, so a space never has
 * to be opened from the main space to be configured. Flat — no card, no
 * per-row chrome (design §5.4).
 *
 * It keeps the space's "changed here" id so the settings search entry keeps
 * pointing at the surface that answers that question, exactly as the accounts
 * card does for its own entry.
 */
function CurrentSpaceSettings({ target }: { target: SpaceSettingsTarget | null }) {
  const here = currentSpace();
  const selected = target === null ? null : { ...target, identity: { ...target.identity, homeId: currentSpaceId() } };
  return (
    <section id="st-card-space-overrides" className="border-t border-hairline pt-6" data-space-settings-section>
      <SpaceSettingsDetail target={selected} name={here?.name ?? currentSpaceId()} />
    </section>
  );
}

function useGuardedSpaceOpen(client: KikiClient | null) {
  const { sshLabel, scopeAdapter } = useConnection();
  const host = useHost();
  const guard = useDirtyGuard();
  const navigate = useGuardedNavigate();
  const clientRef = useRef(client);
  clientRef.current = client;
  return (id: string, mode: SpaceWindowMode) => {
    if (mode === 'switch') {
      if (client === null || client !== clientRef.current) return Promise.reject(new DOMException('The local space connection changed.', 'AbortError'));
      return enterSpace(host, id, mode);
    }
    const localView = sshLabel !== null ? readHomeViewRoute(currentSpaceId(), 'local') ?? '/new' : undefined;
    const open = async (signal = new AbortController().signal) => {
      if (client === null || client !== clientRef.current) throw new DOMException('The local space connection changed.', 'AbortError');
      let prepared: PreparedScope | undefined;
      try {
        if (localView !== undefined) {
          prepared = await scopeAdapter.prepare({ homeId: currentSpaceId(), scopeId: 'local' }, signal);
          await prepared.validate(localView, signal);
        }
        signal.throwIfAborted();
        if (client !== clientRef.current) throw new DOMException('The local space connection changed.', 'AbortError');
        await enterSpace(host, id, mode);
        // Native success is not rolled back if this window was cancelled meanwhile.
        signal.throwIfAborted();
        await prepared?.commit();
      } catch (error) { await prepared?.dispose(); throw error; }
    };
    return guard?.runAction !== undefined ? guard.runAction(open, localView)
      : open().then(() => { if (localView !== undefined) navigate(localView); });
  };
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

function SpaceListCard({ sub, client, target, openLocalSpace }: {
  sub: boolean;
  client: KikiClient;
  target: SpaceSettingsTarget | null;
  openLocalSpace: (id: string, mode: SpaceWindowMode) => void | Promise<void>;
}) {
  const host = useHost();
  const { sshLabel } = useConnection();
  const { t, tp, locale } = useI18n();
  const queryClient = useQueryClient();
  const spaces = useSpaces(client);
  const statuses = useSpaceStatuses(host);
  const [dialog, setDialog] = useState<
    | { kind: 'create' } | { kind: 'attach' }
    | { kind: 'remove'; space: SpaceListItem } | { kind: 'delete'; space: SpaceListItem }
    | { kind: 'credentials'; space: SpaceListItem } | { kind: 'settings'; space: SpaceListItem } | null
  >(null);
  const [menu, setMenu] = useState<{ space: SpaceListItem; anchor: DOMRect } | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [restartNote, setRestartNote] = useState<{ id: string; text: string } | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const desktop = host.kind === 'tauri';
  const isWindows = detectShortcutPlatform() === 'windows';
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
  // The list is anchored on the main space; every sort keeps it first.
  const ordered = useMemo(() => [...(main === undefined ? [] : [main]), ...others], [main, others]);
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: spaceKeys.all }); };

  const spaceLabel = useCallback(
    (space: SpaceListItem) => (space.id === MAIN_SPACE_ID ? t('st.spaces.main') : space.name),
    [t],
  );
  const keyOf = useCallback((space: SpaceListItem) => space.id, []);
  const textOf = useCallback((space: SpaceListItem) => [spaceLabel(space), space.path], [spaceLabel]);
  const filters = useMemo<readonly ListFilterSpec<SpaceListItem>[]>(() => [
    { id: 'running', label: t('st.spaces.filter.running'), test: (space) => spaceRunState(space.id, statuses.data) === 'hot' },
    { id: 'pending', label: t('st.spaces.filter.pending'), test: (space) => (spaceStatus(space.id, statuses.data)?.pendingCount ?? 0) > 0 },
    { id: 'isolated', label: t('st.spaces.filter.isolated'), test: (space) => space.credentials_shared === false },
  ], [t, statuses.data]);
  const sorts = useMemo<readonly ListSortSpec<SpaceListItem>[]>(() => [
    { id: 'order', label: t('st.list.sort.order'), compare: () => 0 },
    {
      id: 'name', label: t('st.list.sort.name'),
      compare: (a, b) => Number(b.id === MAIN_SPACE_ID) - Number(a.id === MAIN_SPACE_ID) || spaceLabel(a).localeCompare(spaceLabel(b)),
    },
  ], [t, spaceLabel]);
  const view = useListView({ listId: 'spaces', items: ordered, keyOf, textOf, filters, sorts });

  const enter = (space: Pick<SpaceListItem, 'id'>) => {
    setEntering(space.id);
    setFeedback(null);
    void Promise.resolve(openLocalSpace(space.id, mode))
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        setFeedback({ tone: 'error', text: errorText(locale, error) });
      })
      .finally(() => { setEntering(null); });
  };

  const createShortcut = (space: SpaceListItem) => {
    if (!desktop || host.createSpaceShortcut === undefined) return;
    if (!isWindows) {
      setFeedback({ tone: 'error', text: t('st.spaces.shortcutWindowsOnly') });
      return;
    }
    setFeedback(null);
    void host.createSpaceShortcut(space.id)
      .then((result) => {
        setFeedback({ tone: 'success', text: t('st.spaces.shortcutCreated', { path: result.path }) });
        pushToast({ tone: 'success', text: t('st.spaces.shortcutCreated', { path: result.path }) });
      })
      .catch((error: unknown) => {
        const failure = typeof error === 'object' && error !== null ? (error as { code?: unknown; message?: unknown }) : null;
        const code = typeof failure?.code === 'string' ? failure.code : undefined;
        const message = typeof failure?.message === 'string' ? failure.message : undefined;

        if (code === 'shortcut_exists') {
          setFeedback({ tone: 'info', text: t('st.spaces.shortcutExists') });
          pushToast({ tone: 'info', text: t('st.spaces.shortcutExists') });
        } else if (code === 'unsupported_platform') {
          setFeedback({ tone: 'error', text: t('st.spaces.shortcutWindowsOnly') });
        } else if (code === 'invalid_space') {
          setFeedback({ tone: 'error', text: t('st.spaces.shortcutInvalidSpace') });
        } else if (code === 'desktop_unavailable') {
          setFeedback({ tone: 'error', text: t('st.spaces.shortcutDesktopUnavailable') });
        } else if (code === 'executable_unavailable') {
          setFeedback({ tone: 'error', text: t('st.spaces.shortcutExecutableUnavailable') });
        } else if (code === 'shortcut_failed') {
          setFeedback({ tone: 'error', text: t('st.spaces.shortcutFailed', { detail: message || errorText(locale, error) }) });
        } else {
          setFeedback({ tone: 'error', text: errorText(locale, error) });
        }
      });
  };

  const deleteBlock = (space: SpaceListItem): string | undefined => {
    const run = spaceRunState(space.id, statuses.data);
    if (run === 'current') return t('st.spaces.deleteDisabledCurrent');
    if ((spaceStatus(space.id, statuses.data)?.busyCount ?? 0) > 0) return t('st.spaces.deleteDisabledBusy');
    if (run === 'hot') return t('st.spaces.deleteDisabledOpen');
    return undefined;
  };

  const menuItems = (space: SpaceListItem): SpaceMenuItem[] => {
    const isMain = space.id === MAIN_SPACE_ID;
    return [
      // Every row, the main space included: what this space follows, what it
      // holds, and the way to change either — without opening the space first.
      { key: 'settings', label: t('st.spaces.settingsMenu'), run: () => { setDialog({ kind: 'settings', space }); } },
      ...(host.revealPath !== undefined ? [{ key: 'reveal', label: t('st.spaces.reveal'), separatorBefore: true, run: () => { void host.revealPath?.(space.path).catch(() => undefined); } }] : []),
      ...(!isMain ? [{ key: 'credentials', label: t('st.spaces.credentials'), run: () => { setDialog({ kind: 'credentials', space }); } }] : []),
      ...(desktop && host.createSpaceShortcut !== undefined ? [{
        key: 'shortcut',
        label: t('st.spaces.createShortcut'),
        blockedReason: !isWindows ? t('st.spaces.shortcutWindowsOnly') : undefined,
        run: () => { createShortcut(space); },
      }] : []),
      ...(desktop && !isMain && host.restartSpace !== undefined ? [{ key: 'restart', label: t('st.spaces.restartSpace'), run: () => {
        setFeedback(null);
        void host.restartSpace?.(space.id)
          .then(() => { setRestartNote(null); refresh(); })
          .catch((error: unknown) => { setFeedback({ tone: 'error', text: errorText(locale, error) }); });
      } }] : []),
      ...(!isMain ? [
        { key: 'remove', label: t('st.spaces.removeFromList'), separatorBefore: true, run: () => { setDialog({ kind: 'remove', space }); } },
        { key: 'delete', label: t('st.spaces.delete'), danger: true, blockedReason: deleteBlock(space), run: () => { setDialog({ kind: 'delete', space }); } },
      ] : []),
    ];
  };

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

  const renderRow = (space: SpaceListItem) => {
    const localRun = spaceRunState(space.id, statuses.data);
    const run = sshLabel !== null && localRun === 'current' ? 'hot' : localRun;
    const pending = mode === 'switch' ? (spaceStatus(space.id, statuses.data)?.pendingCount ?? 0) : 0;
    const isMain = space.id === MAIN_SPACE_ID;
    const label = spaceLabel(space);
    const compact = view.density === 'compact';
    return (
      <div data-space-row={space.id} data-space-state={run} style={{ minHeight: LIST_ROW_HEIGHT[view.density] }}
        className="flex items-center gap-3 px-3 py-1.5">
        <SpaceDot color={isMain ? 'var(--color-ink-faint)' : space.color} />
        {compact ? (
          <div className="flex min-w-0 flex-1 items-baseline gap-x-2">
            <span className="min-w-0 truncate text-[13px] font-medium text-ink" title={label}>{label}</span>
            {!isMain ? (
              <span className="shrink-0 text-[12px] text-ink-faint" data-space-cred={space.credentials_shared === false ? 'isolated' : 'shared'}>
                {t(space.credentials_shared === false ? 'st.spaces.credIsolatedShort' : 'st.spaces.credSharedShort')}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={space.path}>{space.path}</span>
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-x-2">
              <span className="min-w-0 truncate text-[13px] font-medium text-ink" title={label}>{label}</span>
              {!isMain ? (
                <span className="shrink-0 text-[12px] text-ink-faint" data-space-cred={space.credentials_shared === false ? 'isolated' : 'shared'}>
                  {t(space.credentials_shared === false ? 'st.spaces.credIsolatedShort' : 'st.spaces.credSharedShort')}
                </span>
              ) : null}
            </div>
            <p className="truncate font-mono text-[11px] text-ink-faint" title={space.path}>{space.path}</p>
            {restartNote?.id === space.id ? <p className="text-[12px] font-medium text-amber-ink" data-space-restart-note>{restartNote.text}</p> : null}
          </div>
        )}
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
          {!sub ? (
            <button type="button" data-space-menu={space.id} aria-haspopup="menu" aria-label={t('st.spaces.menuAria', { name: space.name })}
              className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
              onClick={(event) => {
                setMenu({ space, anchor: event.currentTarget.getBoundingClientRect() });
              }}>
              <Icon name="more" size={14} />
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <SectionCard id="st-card-spaces" title={t('st.spaces.listTitle')} scope="server">
      <div className="space-y-3" data-space-list>
        {sub ? <Hint>{t('st.spaces.subManageHint')}</Hint> : null}

        {spaces.isLoading ? <Hint>{t('st.spaces.loading')}</Hint> : null}
        {spaces.isError ? <InlineError error={spaces.error} /> : null}

        {items.length > 0 ? (
          <>
            <ListToolbar view={view} total={ordered.length} filters={filters} sorts={sorts}
              searchLabel={t('st.spaces.search')} searchPlaceholder={t('st.spaces.searchPlaceholder')}
              actions={!sub ? (
                <>
                  <button type="button" data-space-new className={`${PRIMARY_BUTTON} inline-flex items-center gap-1`} onClick={() => { setDialog({ kind: 'create' }); }}>
                    <Icon name="plus" size={12} />{t('st.spaces.new')}
                  </button>
                  <button type="button" data-space-attach-open className={SECONDARY_BUTTON} onClick={() => { setDialog({ kind: 'attach' }); }}>{t('st.spaces.attach')}</button>
                </>
              ) : undefined} />
            {view.visible.length === 0 ? (
              <ListEmpty kind="no-match" title={t('st.spaces.noMatchTitle')}
                body={view.query.trim() !== '' ? t('st.spaces.noMatches', { query: view.query.trim() }) : undefined}
                onClear={view.clear} />
            ) : (
              <ListBody items={view.visible} keyOf={keyOf} density={view.density} label={t('st.spaces.listTitle')}
                virtualizeAfter={Number.POSITIVE_INFINITY} renderRow={renderRow} />
            )}
          </>
        ) : null}

        {spaces.isSuccess && others.length === 0 ? (
          <div data-space-empty>
            <ListEmpty kind="none" title={t('st.spaces.emptyTitle')} body={t('st.spaces.emptyBody')} />
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
        <CreateSpaceDialog client={client} mainPath={main?.path ?? ''} canOpen={desktop}
          onClose={() => { setDialog(null); }}
          onCreated={(record, open) => {
            setDialog(null);
            refresh();
            pushToast({ tone: 'success', text: t('st.spaces.created', { name: record.name }) });
            if (open) enter(record);
          }} />
      ) : null}
      {dialog?.kind === 'attach' ? (
        <AttachSpaceDialog client={client} onClose={() => { setDialog(null); }}
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
        <DeleteSpaceDialog client={client} space={dialog.space} onClose={() => { setDialog(null); }}
          onDeleted={() => {
            const name = dialog.space.name;
            setDialog(null);
            refresh();
            setFeedback({ tone: 'success', text: t('st.spaces.deleted', { name }) });
          }} />
      ) : null}
      {dialog?.kind === 'settings' ? (
        <Dialog onClose={() => { setDialog(null); }} overlayId="space-settings-dialog"
          ariaLabel={t('st.spaces.settingsTitle', { name: spaceLabel(dialog.space) })}
          panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} max-h-[calc(100dvh-2rem)] overflow-y-auto`}>
          <SpaceSettingsDetail target={target === null ? null : { ...target, identity: { ...target.identity, homeId: dialog.space.id } }} name={spaceLabel(dialog.space)} />
        </Dialog>
      ) : null}
      {dialog?.kind === 'credentials' ? (
        <SpaceCredentialsDialog client={client} space={dialog.space} onClose={() => { setDialog(null); }}
          onDone={(result) => { onCredentialsDone(dialog.space, result); }} />
      ) : null}
    </SectionCard>
  );
}
