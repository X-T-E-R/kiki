/**
 * 插件 — the rail's plugin list for the session in focus.
 *
 * This is where the reader decides what this conversation may use. It is
 * deliberately *not* plugin management: installs, credentials and the home
 * master switch stay in the plugins page, and nothing here navigates away to
 * do a job this list can do in place.
 *
 * The shape follows the rest of the rail — a folded chapter, hairline rows, no
 * cards — because the reader's other decisions are made here too, and a
 * differently-styled panel would read as a different product.
 *
 * What it shows is the *session's* answer, not the workspace's, and the answer
 * is honest about the four levels that stack into it:
 *
 * - The head names the workspace the **server** resolved, never the window's
 *   own cwd.
 * - The switch shows `effective`, so a plugin whose global default is off but
 *   that this session switched on reads as on here, and one the home master
 *   switch denies reads off with the real reason beside it.
 * - Every row says which level decided, so an `on` from this session is not
 *   mistaken for one that applies everywhere.
 * - While the server is still applying, the choice just made stays on screen
 *   with its switch live; falling back to the old value would read as "your
 *   click did nothing".
 * - A failed write keeps the row editable and restores the last good value,
 *   beside the reason. Nothing here ever writes the workspace or the global
 *   default: a session choice is a session choice.
 * - `app_service` belongs to the home scope, so a row carrying it says so
 *   instead of implying that switching it off here stops that service.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';

import type { PluginUsageItem, PluginUsageResponse, PluginUsageTarget } from '@kiki/protocol';
import { errorText, type I18nKey, type Locale } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { isCapabilityUnsupportedError } from '../agent-panel/mapCapabilities';
import { InspectorSection } from '../agent-panel/InspectorSection';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { FOCUS_RING } from '../rail-variants/shell';
import { Spinner } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { Toggle } from '../controls';
import type { PluginMarketplaceEntry } from '../../lib/client';
import { CapabilityIcon } from './CapabilityIcon';
import { InstallFlow, type InstallRequest } from './InstallFlow';
import { AddSourceDialog } from './AddSourceDialog';
import {
  availableCount,
  isStaleRevision,
  isStaleScope,
  isStaleTarget,
  overrideSource,
  rowBlockedByHome,
  rowCanRestore,
  rowState,
  rowToggleIntent,
  scopeKey,
  scopeOf,
  scopeTitle,
  type OverrideSource,
  type UsageScope,
} from './pluginUsage';
import { PLUGIN_QUERY_KEYS, useInvalidatePlugins, usePluginMarketplace } from './usePlugins';

type UsageRead = UseQueryResult<PluginUsageResponse, Error>;

export function WorkspacePluginsSection({ sessionId }: { readonly sessionId: string }) {
  const { t, locale } = useI18n();
  const location = useLocation();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const invalidatePlugins = useInvalidatePlugins();
  const target: PluginUsageTarget = useMemo(() => ({ session_id: sessionId }), [sessionId]);
  // Read by a mutation that outlives this render, so a late answer knows the
  // locale and the session the reader is actually looking at now.
  const localeRef = useRef<Locale>(locale);
  localeRef.current = locale;
  const targetRef = useRef<PluginUsageTarget>(target);
  targetRef.current = target;

  const [pending, setPending] = useState<Readonly<Record<string, 'on' | 'off'>>>({});
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const nextRequest = useRef(0);
  const latestRequests = useRef(new Map<string, number>());
  // Per-row state is keyed by target *and* plugin. A choice or a failure made
  // for one session must never be shown on another session's row, even for the
  // same plugin — so the target is part of the identity of the entry.
  const rowKey = useCallback((pluginId: string) => `${scopeKey(target)}/${pluginId}`, [target]);
  const [browse, setBrowse] = useState(false);
  const [adding, setAdding] = useState(false);
  // An install in flight remembers the session that opened it, because the
  // install itself is a home-scope fact and only the session `on` that
  // follows is session-scoped.
  const [install, setInstall] = useState<{ readonly request: InstallRequest; readonly target: PluginUsageTarget } | null>(null);

  const read = useQuery({
    queryKey: PLUGIN_QUERY_KEYS.usage(sessionId),
    queryFn: () => client.getPluginUsage(target),
    staleTime: 5_000,
    retry: false,
  });

  const write = useMutation({
    // The target travels with the call, so every answer — success or failure —
    // can be checked against the session that asked for it rather than the one
    // the reader happens to be in when it lands.
    mutationFn: (input: { pluginId: string; override: 'on' | 'off' | 'inherit'; target: PluginUsageTarget }) =>
      client.setPluginUsage({ target: input.target, plugin_id: input.pluginId, override: input.override }),
    onMutate: (input) => {
      // The reader's choice is on screen before the server answers. `inherit`
      // removes the session override, so it has no session value to hold. The
      // value is captured in a const so the narrowing survives into the updater.
      const { override } = input;
      const key = `${scopeKey(input.target)}/${input.pluginId}`;
      const requestId = ++nextRequest.current;
      latestRequests.current.set(key, requestId);
      if (override !== 'inherit') {
        setPending((current) => ({ ...current, [key]: override }));
      } else {
        setPending(({ [key]: _cleared, ...rest }) => rest);
      }
      setFailures(({ [key]: _cleared, ...rest }) => rest);
      return { key, requestId };
    },
    onSuccess: (response, input, request) => {
      if (request === undefined || latestRequests.current.get(request.key) !== request.requestId) return;
      latestRequests.current.delete(request.key);
      setPending(({ [request.key]: _cleared, ...rest }) => rest);
      // Clear only this request's optimistic state even after navigation; its
      // answer must not replace another session or a newer request.
      if (isStaleTarget(input.target, targetRef.current)) return;
      if (isStaleScope(response, scopeOf(read.data))) return;
      const previous = queryClient.getQueryData<PluginUsageResponse>(PLUGIN_QUERY_KEYS.usage(sessionId));
      if (previous === undefined || !isStaleRevision(previous.revision, response.revision)) {
        queryClient.setQueryData(PLUGIN_QUERY_KEYS.usage(sessionId), response);
      }
    },
    onError: (error, input, request) => {
      if (request === undefined || latestRequests.current.get(request.key) !== request.requestId) return;
      latestRequests.current.delete(request.key);
      setPending(({ [request.key]: _cleared, ...rest }) => rest);
      if (isStaleTarget(input.target, targetRef.current)) return;
      setFailures((current) => ({ ...current, [request.key]: errorText(localeRef.current, error) }));
    },
  });

  // Feature detection, not an explanation wall: a server without the flag
  // answers unsupported and the rail keeps exactly what it had before. It is
  // checked after every hook, because returning earlier on a later render
  // would leave React with fewer hooks than the mount had.
  const unsupported = isCapabilityUnsupportedError(read.error);

  // A failed write is already reported on the row itself by the mutation's
  // `onError`; the promise's rejection carries no further work, and letting it
  // escape would surface an unhandled rejection in the window.
  const send = (pluginId: string, override: 'on' | 'off' | 'inherit') => {
    void write.mutateAsync({ pluginId, override, target }).catch(() => undefined);
  };

  const onToggle = (item: PluginUsageItem, enabled: boolean) => {
    // A home-blocked row has no session answer to give, so a click on it is
    // ignored rather than turned into a write the server would reject.
    if (rowToggleIntent(item) === undefined) return;
    // The checkbox reports the state being asked for; `effective` is the one
    // in force. Asking for what already holds is not a change.
    if (enabled === item.effective) return;
    send(item.id, enabled ? 'on' : 'off');
  };

  const onRestore = (item: PluginUsageItem) => {
    send(item.id, 'inherit');
  };

  // Installing from the rail runs the same preview → consent → install flow as
  // everywhere else, and only an installed plugin is then switched on for this
  // session — consent is never skipped by arriving from here, and a plugin
  // that is already installed is never installed a second time.
  //
  // The install itself is a home-scope fact. What is session-scoped is only
  // the `on` that follows, and it is addressed to the session that opened the
  // flow — not to whichever one the reader has since moved to.
  const onInstalled = useCallback(async (pluginId: string, from: PluginUsageTarget) => {
    setInstall(null);
    await invalidatePlugins();
    if (isStaleTarget(from, targetRef.current)) return;
    await write.mutateAsync({ pluginId, override: 'on', target: from }).catch(() => undefined);
  }, [invalidatePlugins, write]);

  const scope = scopeOf(read.data);
  const items = read.data?.plugins ?? [];

  if (unsupported) return null;

  return (
    <>
      <InspectorSection
        title={t('rail.plugins.title')}
        summary={t('rail.plugins.summary', { count: availableCount(items) })}
        defaultOpen={false}
        data-rail-plugins=""
      >
        <div className="space-y-1.5 pt-0.5">
          <ScopeLine scope={scope} onBrowse={() => { setBrowse(true); }} onAddFromSource={() => { setAdding(true); }} />
          {/* One line, and the boundary it implies lives on the management
              link: in a narrow rail a paragraph of scope prose costs more
              than it tells the reader. */}
          {scope !== undefined ? (
            <p className="text-[11.5px] leading-4 text-ink-faint" data-rail-plugins-hint>{t('rail.plugins.hint')}</p>
          ) : null}

          <UsageStatus read={read} />

          <ul className="space-y-px">
            {items.map((item) => (
              <PluginUsageRow
                key={item.id}
                item={item}
                pending={pending[rowKey(item.id)]}
                failure={failures[rowKey(item.id)]}
                busy={write.isPending && write.variables?.pluginId === item.id}
                settingsSearch={location.search}
                onToggle={onToggle}
                onRestore={onRestore}
              />
            ))}
          </ul>

          {items.length === 0 && read.isSuccess ? (
            <p className="pt-0.5 text-[12px] leading-relaxed text-ink-faint" data-rail-plugins-empty>{t('rail.plugins.empty')}</p>
          ) : null}
        </div>
      </InspectorSection>

      {browse ? (
        <PluginCatalogDialog
          onClose={() => { setBrowse(false); }}
          onPick={(entry) => {
            setBrowse(false);
            setInstall({ request: { source: entry.source, sha256: entry.sha256, displayName: entry.displayName, icon: entry.icon, entry }, target });
          }}
        />
      ) : null}
      {adding ? (
        <AddSourceDialog
          onClose={() => { setAdding(false); }}
          onPreview={(request) => { setAdding(false); setInstall({ request, target }); }}
        />
      ) : null}
      {install !== null ? (
        <InstallFlow
          request={install.request}
          onClose={() => { setInstall(null); }}
          onInstalled={(pluginId) => { void onInstalled(pluginId, install.target); }}
        />
      ) : null}
    </>
  );
}

/** The scope line: the server's own name for this workspace, plus entry points. */
function ScopeLine({
  scope,
  onBrowse,
  onAddFromSource,
}: {
  readonly scope: UsageScope | undefined;
  readonly onBrowse: () => void;
  readonly onAddFromSource: () => void;
}) {
  const { t } = useI18n();
  if (scope === undefined) return null;
  return (
    <div className="flex min-w-0 items-start justify-between gap-2">
      {/* Wraps rather than clips: the workspace's own name is the thing a
          reader needs, and a narrow rail must not hide half of it behind an
          ellipsis. The entry points stay on the baseline with it. */}
      <p className="min-w-0 flex-1 text-[12.5px] leading-5 text-ink-soft" data-rail-plugins-scope title={scope.root}>
        {scopeTitle(scope, t)}
      </p>
      <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
        <button type="button" onClick={onBrowse} className={`shrink-0 rounded text-[12px] text-ink-faint transition-colors hover:text-ink ${FOCUS_RING}`} data-rail-plugins-browse="">
          {t('rail.plugins.browse')}
        </button>
        <button type="button" onClick={onAddFromSource} className={`shrink-0 rounded text-[12px] text-ink-faint transition-colors hover:text-ink ${FOCUS_RING}`} data-rail-plugins-add-source="">
          {t('rail.plugins.addSource')}
        </button>
      </div>
    </div>
  );
}

/** Reading / applying / failed, in the rail's own quiet voice. */
function UsageStatus({ read }: { readonly read: UsageRead }) {
  const { t } = useI18n();
  if (read.isError) {
    if (isCapabilityUnsupportedError(read.error)) return null;
    return (
      <p role="status" data-rail-plugins-unavailable className="text-[12px] leading-relaxed text-ink-faint">
        {t('rail.plugins.unavailable')}
        <button type="button" onClick={() => { void read.refetch(); }} className={`ml-1.5 rounded font-medium text-ink-soft transition-colors hover:text-ink ${FOCUS_RING}`}>
          {t('common.retry')}
        </button>
      </p>
    );
  }
  if (read.isPending) {
    return (
      <p role="status" className="flex items-center gap-1.5 text-[12px] text-ink-faint">
        <Spinner label={t('cap.loading')} />{t('rail.plugins.loading')}
      </p>
    );
  }
  const state = read.data?.apply_state;
  const errors = read.data?.errors ?? [];
  if (state === 'pending') {
    return <p role="status" data-rail-plugins-applying className="text-[12px] leading-relaxed text-ink-faint">{t('rail.plugins.applying')}</p>;
  }
  if (state === 'failed' && errors.length > 0) {
    return <p role="status" data-rail-plugins-failed className="text-[12px] leading-relaxed text-danger">{errors.join(' · ')}</p>;
  }
  return null;
}

/** The one honest sentence about why a row is what it is. */
const REASON_KEY: Readonly<Record<NonNullable<PluginUsageItem['reason']>, I18nKey>> = {
  home_disabled: 'rail.plugins.reason.homeOff',
  invalid_plugin: 'rail.plugins.reason.invalid',
  workspace_disabled: 'rail.plugins.reason.workspaceOff',
  session_disabled: 'rail.plugins.reason.sessionOff',
  global_disabled: 'rail.plugins.reason.globalOff',
};

/**
 * One plugin in this session: what it is, whether it is actually usable here,
 * which level decided, and the choice that changes it.
 */
function PluginUsageRow({
  item,
  pending,
  failure,
  busy,
  settingsSearch,
  onToggle,
  onRestore,
}: {
  readonly item: PluginUsageItem;
  readonly pending?: 'on' | 'off';
  readonly failure?: string;
  readonly busy: boolean;
  readonly settingsSearch: string;
  readonly onToggle: (item: PluginUsageItem, enabled: boolean) => void;
  readonly onRestore: (item: PluginUsageItem) => void;
}) {
  const { t } = useI18n();
  // While a write is in flight the row shows the choice just made; the
  // server's answer replaces it when it lands.
  const effective = pending === undefined ? item.effective : pending === 'on';
  const state = rowState(item);
  const blocked = rowBlockedByHome(item);
  const contributions = [
    item.skillCount > 0 ? t('rail.plugins.counts.skill', { count: item.skillCount }) : '',
    item.mcpServerCount > 0 ? t('rail.plugins.counts.mcp', { count: item.mcpServerCount }) : '',
  ].filter((text) => text !== '');
  const source = pending === undefined ? overrideSource(item) : 'session';

  return (
    <li className="border-t border-hairline py-1.5 first:border-t-0" data-rail-plugin={item.id} data-override={pending ?? item.session_override ?? item.override} data-effective={String(effective)}>
      <div className="flex min-w-0 items-center gap-2">
        <CapabilityIcon icon={item.icon} kind="plugin" size="sm" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] leading-5 text-ink" title={item.displayName}>{item.displayName}</span>        <Toggle
          label={t('rail.plugins.toggle', { name: item.displayName })}
          // The plugin's name is already the row's own label, so the switch
          // keeps its name for assistive tech only. Repeating it here would
          // wrap the row onto three lines in a narrow rail.
          layout="bare"
          checked={effective}
          disabled={busy || state.kind === 'blocked'}
          onChange={(enabled) => { onToggle(item, enabled); }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-6 text-[11.5px] leading-4">
        {state.kind === 'blocked' ? (
          <span data-rail-plugin-reason={state.reason} className="text-ink-faint">
            {t(REASON_KEY[state.reason])}
          </span>
        ) : contributions.length > 0 ? (
          <span className="text-ink-faint">{contributions.join(' · ')}</span>
        ) : null}
        {!blocked ? <SourceTag source={source} /> : null}
        {item.app_service ? (
          // Home-scoped: switching this row off here does not stop that service.
          <span className="text-ink-faint" title={t('rail.plugins.appServiceHint')} data-rail-plugin-app-service="">
            {t('rail.plugins.appService')}
          </span>
        ) : null}
        {rowCanRestore(item) ? (
          <button type="button" onClick={() => { onRestore(item); }} className={`rounded text-ink-faint underline decoration-dotted underline-offset-2 transition-colors hover:text-ink ${FOCUS_RING}`} data-rail-plugin-restore="">
            {t('rail.plugins.restore')}
          </button>
        ) : null}
        {busy ? <Spinner label={t('rail.plugins.saving')} /> : null}
        {failure !== undefined ? <span role="alert" data-rail-plugin-error className="text-danger">{failure}</span> : null}
        {blocked ? (
          <Link to={{ pathname: '/settings/plugins', search: settingsSearch }} className={`rounded text-ink-faint underline decoration-dotted underline-offset-2 ${FOCUS_RING}`} data-rail-plugin-manage="">
            {t('rail.plugins.manageHome')}
          </Link>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Which level decided this row's value, in five words or fewer. A row that
 * says "from the global default" is answering a question a reader always has
 * when a plugin is on and they did not turn it on.
 */
function SourceTag({ source }: { readonly source: OverrideSource }) {
  const { t } = useI18n();
  return (
    <span data-rail-plugin-source={source} className="text-ink-faint">
      {t(SOURCE_KEY[source])}
    </span>
  );
}

const SOURCE_KEY: Readonly<Record<OverrideSource, I18nKey>> = {
  session: 'rail.plugins.source.session',
  workspace: 'rail.plugins.source.workspace',
  global: 'rail.plugins.source.global',
  home: 'rail.plugins.source.home',
};

/**
 * The catalog, for adding a plugin that is not installed here yet. It reads the
 * same catalog query the plugins page reads — the rail does not become a second
 * marketplace, it just asks the existing one.
 *
 * Exported because one workspace's own page opens the same catalog for itself:
 * arriving there from the rail's Link would have dropped the workspace, and an
 * install made "for this workspace" would then have landed with no workspace to
 * name. `title`/`body` exist for that second caller, which has to say *which*
 * scope it is adding to instead of borrowing the rail's "this conversation".
 */
export function PluginCatalogDialog({
  onClose,
  onPick,
  title,
  body,
}: {
  readonly onClose: () => void;
  readonly onPick: (entry: PluginMarketplaceEntry) => void;
  readonly title?: string;
  readonly body?: string;
}) {
  const { t } = useI18n();
  const catalog = usePluginMarketplace();
  const [query] = useState('');
  const entries = useMemo(
    () => (catalog.data?.entries ?? []).filter((entry) => catalogMatches(entry, query) && entry.installable !== false),
    [catalog.data, query],
  );
  return (
    <Dialog onClose={onClose} ariaLabel={title ?? t('rail.plugins.browse')} overlayId="rail-plugin-catalog" panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.sm} max-h-[min(80vh,560px)] overflow-y-auto`}>
      <h2 className="font-display text-[18px] leading-6 text-ink">{title ?? t('rail.plugins.browseTitle')}</h2>
      <p className="mt-1 text-[13px] leading-5 text-ink-soft">{body ?? t('rail.plugins.browseBody')}</p>
      <div className="mt-4 space-y-1">
        {entries.length === 0 ? (
          <p className="text-[12px] text-ink-faint">{t('cap.plugins.noMatch', { query })}</p>
        ) : entries.map((entry) => (
          <button key={entry.id} type="button" onClick={() => { onPick(entry); }} className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-ink/[0.04] ${FOCUS_RING}`} data-rail-plugin-catalog-entry={entry.id}>
            <CapabilityIcon icon={entry.icon} kind="plugin" size="sm" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{entry.displayName}</span>
            <span className="shrink-0 text-[12px] text-ink-faint">{t('rail.plugins.addHere')}</span>
          </button>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>{t('common.close')}</button>
      </div>
    </Dialog>
  );
}

function catalogMatches(entry: PluginMarketplaceEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return entry.displayName.toLowerCase().includes(needle) || (entry.description ?? '').toLowerCase().includes(needle);
}