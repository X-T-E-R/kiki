/**
 * Installed — every plugin on this server as one direct management list:
 * instant search, state filter chips, health indicator dot, inline Settings &
 * Reload actions, update CTA, enable/disable Toggle, and confirmed Remove.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorText, type Locale } from '@kiki/session-core/i18n';

import { copyTextToClipboard } from '../../lib/clipboard';
import type { PluginMarketplaceEntry, PluginSummary } from '../../lib/client';
import { pluginOrigin, type PluginOrigin, type PluginUpdateView } from '../../lib/pluginCatalog';
import { pushToast } from '../../lib/toasts';
import { openExternalUrl } from '../../host/external';
import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { InlineError, Toggle } from '../controls';
import { Icon, Spinner } from '../icons';
import { MiniContextMenu, type MiniMenuEntry } from '../MiniContextMenu';
import { SECONDARY_BUTTON } from '../ui';
import {
  groupItems,
  LIST_ROW_HEIGHT,
  ListBody,
  ListEmpty,
  ListGroup,
  ListToolbar,
  useListView,
  type ListDensity,
  type ListFilterSpec,
} from '../settings/list';
import { CapabilityIcon } from './CapabilityIcon';
import { Disclosure, IconButton, Tag } from './primitives';
import { useInvalidatePlugins } from './usePlugins';

const ORIGIN_KEYS = {
  official: 'cap.origin.official',
  catalog: 'cap.origin.catalog',
  local: 'cap.origin.local',
  git: 'cap.origin.git',
  zip: 'cap.origin.zip',
} as const satisfies Record<PluginOrigin, string>;

const ZOD_ISSUE_SHAPE = /"code"\s*:\s*"(invalid_type|too_small|too_big|invalid_enum_value|invalid_value|unrecognized_keys?)"/;
const REDACT_URL = /\b(?:https?|wss?|file|ftp):\/\/[^\s)"'`<>]+/gi;
const REDACT_CREDENTIAL = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})|\b(?:token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;)"']+/gi;

export interface SanitizedPluginError {
  readonly summary: string;
  readonly diagnostic?: string;
  readonly structuredFirstIssue?: string;
}

function sanitizeErrorText(input: string): string {
  return input
    .replace(REDACT_URL, '[url]')
    .replace(REDACT_CREDENTIAL, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatZodIssues(issues: readonly unknown[]): { readonly diagnostic?: string; readonly firstIssue?: string } {
  const lines: string[] = [];
  let firstIssue: string | undefined;
  for (const rawIssue of issues.slice(0, 5)) {
    if (typeof rawIssue !== 'object' || rawIssue === null) continue;
    const issue = rawIssue as {
      readonly path?: readonly unknown[];
      readonly code?: unknown;
      readonly expected?: unknown;
      readonly message?: unknown;
    };
    const path = Array.isArray(issue.path)
      ? issue.path
          .map((segment) => String(segment).replace(/[^A-Za-z0-9_.-]/g, ''))
          .filter((segment) => segment !== '')
          .join('.')
          .slice(0, 64)
      : '';
    const code = typeof issue.code === 'string'
      ? issue.code.replace(/[^A-Za-z0-9_-]/g, '')
      : '';
    const expected = typeof issue.expected === 'string'
      ? issue.expected.replace(/[^A-Za-z0-9_|-]/g, '').slice(0, 32)
      : '';
    const cleanMessage = typeof issue.message === 'string'
      ? sanitizeErrorText(issue.message).slice(0, 96)
      : '';
    const safeMessage = cleanMessage !== '' && !ZOD_ISSUE_SHAPE.test(cleanMessage) && !/^[\[{]/.test(cleanMessage)
      ? cleanMessage
      : '';
    const detail = code !== ''
      ? (expected !== '' ? `${code} (${expected})` : code)
      : (safeMessage !== '' ? safeMessage : 'invalid_value');
    lines.push(path !== '' ? `${path}: ${detail}` : detail);
    if (firstIssue === undefined && safeMessage !== '') {
      firstIssue = path !== '' ? `${path}: ${safeMessage}` : safeMessage;
    }
  }
  return {
    diagnostic: lines.length > 0 ? lines.join('\n') : undefined,
    firstIssue,
  };
}

function extractStringifiedZodDiagnostic(raw: string): string | undefined {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        const formatted = formatZodIssues(parsed).diagnostic;
        if (formatted !== undefined) return formatted;
      }
    } catch {
      // Truncated JSON payload: fall back to safe field/code token extraction below.
    }
  }
  const codeMatch = /"code"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(raw);
  const expectedMatch = /"expected"\s*:\s*"([A-Za-z0-9_|-]+)"/.exec(raw);
  const pathMatch = /"path"\s*:\s*\[([^\]]*)\]/.exec(raw);
  const path = pathMatch?.[1]
    ?.split(',')
    .map((part) => part.replace(/[\s"']/g, '').replace(/[^A-Za-z0-9_.-]/g, ''))
    .filter((part) => part !== '')
    .join('.')
    .slice(0, 64) ?? '';
  const code = codeMatch?.[1] ?? 'invalid_payload';
  const expected = expectedMatch?.[1] ?? '';
  const detail = expected !== '' ? `${code} (${expected})` : code;
  return path !== '' ? `${path}: ${detail}` : detail;
}

export function describePluginLoadError(
  error: unknown,
  locale: Locale,
  serverDataText: string,
  unknownErrorText: string,
): SanitizedPluginError {
  if (
    typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'ZodError'
    && Array.isArray((error as { issues?: unknown }).issues)
  ) {
    const formatted = formatZodIssues((error as { issues: readonly unknown[] }).issues);
    return {
      summary: serverDataText,
      diagnostic: formatted.diagnostic,
      structuredFirstIssue: formatted.firstIssue,
    };
  }
  if (error instanceof SyntaxError) {
    return { summary: serverDataText, diagnostic: 'SyntaxError' };
  }
  const rawMessage = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (ZOD_ISSUE_SHAPE.test(rawMessage)) {
    return {
      summary: serverDataText,
      diagnostic: extractStringifiedZodDiagnostic(rawMessage),
    };
  }
  const localized = errorText(locale, error);
  if (ZOD_ISSUE_SHAPE.test(localized) || /^[\[{]\s*"/.test(localized.trim())) {
    return {
      summary: serverDataText,
      diagnostic: extractStringifiedZodDiagnostic(rawMessage || localized),
    };
  }
  const cleaned = sanitizeErrorText(localized);
  const summary = cleaned === ''
    ? unknownErrorText
    : cleaned.length > 140
      ? `${cleaned.slice(0, 137)}…`
      : cleaned;
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'number'
    ? (error as { code: number }).code
    : undefined;
  const diagnostic = code !== undefined
    ? `code ${code}`
    : cleaned.length > 140
      ? cleaned.slice(0, 280)
      : undefined;
  return { summary, diagnostic };
}

export function PluginLoadFailure({
  dataAttr,
  summary,
  diagnostic,
  retrying = false,
  onRetry,
}: {
  readonly dataAttr: 'data-plugins-installed-error' | 'data-plugins-catalog-error';
  readonly summary: string;
  readonly diagnostic?: string;
  readonly retrying?: boolean;
  readonly onRetry?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div
      {...{ [dataAttr]: '' }}
      className="space-y-2.5 border-l-2 border-danger/55 py-1 pl-3.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p role="alert" className="min-w-0 flex-1 text-[13px] leading-5 text-ink">
          {summary}
        </p>
        {onRetry !== undefined ? (
          <button
            type="button"
            data-settings-retry
            disabled={retrying}
            onClick={onRetry}
            className={`${SECONDARY_BUTTON} inline-flex shrink-0 items-center gap-1.5`}
          >
            {retrying ? <Spinner label={t('common.retry')} size={12} /> : null}
            <span>{t('common.retry')}</span>
          </button>
        ) : null}
      </div>
      {diagnostic !== undefined ? (
        <Disclosure
          label={t('cap.detail.diagnostics')}
          open={open}
          onToggle={() => { setOpen((value) => !value); }}
          dataAttrs={{ 'data-plugins-error-diagnostics': '' }}
        >
          <pre className="max-h-32 overflow-auto rounded-md bg-ink/[0.04] px-3 py-2 font-mono text-[12px] leading-4 whitespace-pre-wrap text-ink-soft">
            {diagnostic}
          </pre>
        </Disclosure>
      ) : null}
    </div>
  );
}

export function InstalledList({
  plugins,
  entries,
  loading,
  retrying = false,
  error,
  onRetry,
  updates,
  updateCheck,
  onOpen,
  onOpenSettings,
  onUpdate,
  onAdd,
  inSettings = false,
}: {
  readonly plugins: readonly PluginSummary[];
  readonly entries: readonly PluginMarketplaceEntry[];
  readonly loading: boolean;
  readonly retrying?: boolean;
  readonly error?: unknown;
  readonly onRetry?: () => void;
  /** Available update per plugin id, from the catalog or GitHub. */
  readonly updates: ReadonlyMap<string, PluginUpdateView>;
  /** The GitHub check line under the list; absent without GitHub installs. */
  readonly updateCheck?: ReactNode;
  readonly onOpen: (id: string) => void;
  readonly onOpenSettings?: (id: string) => void;
  readonly onUpdate: (plugin: PluginSummary, update: PluginUpdateView) => void;
  readonly onAdd: () => void;
  readonly inSettings?: boolean;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const invalidate = useInvalidatePlugins();
  const [busyCounts, setBusyCounts] = useState<Readonly<Record<string, number>>>({});
  const toggleSeqRef = useRef<Record<string, number>>({});
  const [optimisticEnabled, setOptimisticEnabled] = useState<Readonly<Record<string, boolean>>>({});
  const [pinnedGroupById, setPinnedGroupById] = useState<Readonly<Record<string, InstalledGroup>>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [removing, setRemoving] = useState<PluginSummary | null>(null);
  const canReload = typeof client.reloadPlugin === 'function';

  const isPluginBusy = (id: string) => (busyCounts[id] ?? 0) > 0;
  const beginBusy = (id: string) => {
    setBusyCounts((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  };
  const endBusy = (id: string) => {
    setBusyCounts((prev) => {
      const count = (prev[id] ?? 0) - 1;
      if (count > 0) return { ...prev, [id]: count };
      if (!Object.hasOwn(prev, id)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const displayPlugins = useMemo(
    () => plugins.map((plugin) => (
      Object.hasOwn(optimisticEnabled, plugin.id)
        ? { ...plugin, enabled: optimisticEnabled[plugin.id]! }
        : plugin
    )),
    [plugins, optimisticEnabled],
  );

  const act = async (id: string, action: () => Promise<unknown>) => {
    beginBusy(id);
    setFailure(null);
    try {
      await action();
      await invalidate();
    } catch (actionError) {
      setFailure(actionError);
    } finally {
      endBusy(id);
    }
  };

  const togglePluginEnabled = async (id: string, enabled: boolean) => {
    const current = displayPlugins.find((entry) => entry.id === id);
    if (current !== undefined) {
      const stableGroup = pinnedGroupById[id] ?? rawGroupOf(current);
      setPinnedGroupById((prev) => (prev[id] === stableGroup ? prev : { ...prev, [id]: stableGroup }));
    }
    const seq = (toggleSeqRef.current[id] ?? 0) + 1;
    toggleSeqRef.current[id] = seq;
    setOptimisticEnabled((prev) => ({ ...prev, [id]: enabled }));
    beginBusy(id);
    setFailure(null);
    try {
      if (current?.defaultEnabled === undefined) {
        await client.setPluginEnabled(id, enabled);
      } else {
        await client.setPluginState(id, { enabled, defaultEnabled: current.defaultEnabled });
      }
      await invalidate();
    } catch (actionError) {
      setFailure(actionError);
    } finally {
      if (toggleSeqRef.current[id] === seq) {
        setOptimisticEnabled((prev) => {
          if (!Object.hasOwn(prev, id)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
      endBusy(id);
    }
  };

  const broken = (plugin: PluginSummary) => plugin.state === 'error' || plugin.hasErrors;
  const rawGroupOf = (plugin: PluginSummary): InstalledGroup =>
    broken(plugin) ? 'attention' : updates.has(plugin.id) ? 'updates' : plugin.enabled ? 'on' : 'off';
  const groupOf = (plugin: PluginSummary): InstalledGroup => {
    if (broken(plugin)) return 'attention';
    if (updates.has(plugin.id)) return 'updates';
    return pinnedGroupById[plugin.id] ?? (plugin.enabled ? 'on' : 'off');
  };

  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const keyOf = (plugin: PluginSummary) => plugin.id;
  const textOf = (plugin: PluginSummary) => {
    const entry = entryById.get(plugin.id);
    return [plugin.displayName, plugin.id, plugin.originalSource, entry?.description, ...(entry?.keywords ?? [])];
  };
  const filters = useMemo<readonly ListFilterSpec<PluginSummary>[]>(() => [
    { id: 'attention', label: t('cap.installed.group.attention'), tone: 'attention', test: (plugin) => broken(plugin) },
    { id: 'updates', label: t('cap.installed.group.updates'), test: (plugin) => !broken(plugin) && updates.has(plugin.id) },
    { id: 'on', label: t('cap.installed.group.on'), test: (plugin) => plugin.enabled },
    { id: 'off', label: t('cap.installed.group.off'), test: (plugin) => !plugin.enabled },
  ], [t, updates]);

  const baseView = useListView({ listId: 'cap-plugins-installed', items: displayPlugins, keyOf, textOf, filters });
  const [shortQuery, setShortQuery] = useState('');
  const view = useMemo(() => {
    if (baseView.tools.search) return baseView;
    const needles = shortQuery.trim().toLowerCase().split(/\s+/).filter((word) => word !== '');
    const visible = needles.length === 0
      ? baseView.visible
      : baseView.visible.filter((plugin) => {
        const hay = textOf(plugin).filter((part): part is string => part !== undefined && part !== '').join('\n').toLowerCase();
        return needles.every((needle) => hay.includes(needle));
      });
    return {
      ...baseView,
      query: shortQuery,
      setQuery: setShortQuery,
      visible,
      narrowed: baseView.narrowed || needles.length > 0,
      clear: () => {
        setShortQuery('');
        baseView.clear();
      },
    };
  }, [baseView, shortQuery, entryById]);
  useEffect(() => {
    if (baseView.tools.search && shortQuery !== '') setShortQuery('');
  }, [baseView.tools.search, shortQuery]);
  useEffect(() => {
    setPinnedGroupById((prev) => (Object.keys(prev).length === 0 ? prev : {}));
  }, [view.query, view.filter]);
  const toolbarView = useMemo(() => ({
    ...view,
    tools: {
      ...view.tools,
      search: displayPlugins.length > 0,
      filters: false,
      filterIds: [],
    },
  }), [displayPlugins.length, view]);

  const groups = useMemo(
    () => groupItems(displayPlugins, view.visible, (plugin) => {
      const id = groupOf(plugin);
      return [{ key: id, label: t(GROUP_KEYS[id]) }];
    }, GROUP_ORDER),
    [displayPlugins, pinnedGroupById, t, updates, view.visible],
  );

  if (loading) return <p className="py-3 text-[13px] text-ink-faint" role="status">{t('cap.loading')}</p>;
  if (error !== undefined) {
    const described = describePluginLoadError(error, locale, t('err.serverData'), t('common.unknownError'));
    const summary = inSettings && described.structuredFirstIssue !== undefined
      ? t('st.plugins.loadInvalid', { detail: described.structuredFirstIssue })
      : t('st.plugins.loadFailed', { detail: described.summary });
    return (
      <PluginLoadFailure
        dataAttr="data-plugins-installed-error"
        summary={summary}
        diagnostic={described.diagnostic}
        retrying={retrying}
        onRetry={onRetry}
      />
    );
  }
  if (plugins.length === 0) {
    return (
      <ListEmpty
        kind="none"
        title={t('cap.plugins.noneInstalled')}
        body={t('cap.plugins.noneInstalledBody')}
        action={<button type="button" className="text-[13px] leading-5 font-normal text-selected-ink hover:underline" onClick={onAdd}>{t('cap.plugins.addFromSource')}</button>}
      />
    );
  }

  return (
    <div
      className="min-w-0 space-y-3"
      data-installed-list
      data-in-settings={inSettings ? '' : undefined}
    >
      <ListToolbar
        view={toolbarView}
        total={displayPlugins.length}
        filters={filters}
        searchLabel={t('cap.plugins.searchInstalled')}
        searchPlaceholder={t('cap.plugins.searchInstalled')}
      />
      {view.visible.length === 0 ? (
        <ListEmpty
          kind="no-match"
          title={t('cap.plugins.noMatchTitle')}
          body={view.query.trim() !== '' ? t('cap.plugins.noMatch', { query: view.query.trim() }) : undefined}
          onClear={view.clear}
        />
      ) : (
        groups.map((group) => (
          <ListGroup
            key={group.key}
            groupKey={group.key}
            label={group.label}
            count={group.items.length}
            total={group.total}
            folded={view.isFolded(group.key)}
            onToggle={() => { view.toggleFold(group.key); }}
          >
            <ListBody
              items={group.items}
              keyOf={keyOf}
              density={view.density}
              label={group.label}
              renderRow={(plugin) => (
                <InstalledRow
                  plugin={plugin}
                  density={view.density}
                  origin={pluginOrigin(plugin, entries)}
                  entry={entryById.get(plugin.id)}
                  update={updates.get(plugin.id)}
                  busy={isPluginBusy(plugin.id)}
                  onOpen={() => { onOpen(plugin.id); }}
                  onOpenSettings={onOpenSettings === undefined ? undefined : () => { onOpenSettings(plugin.id); }}
                  onReload={canReload ? () => {
                    void act(plugin.id, async () => {
                      await client.reloadPlugin(plugin.id);
                      pushToast({ tone: 'info', text: t('cap.plugins.reloaded', { name: plugin.displayName }) });
                    });
                  } : undefined}
                  onToggle={(enabled) => { void togglePluginEnabled(plugin.id, enabled); }}
                  onUpdate={(update) => { onUpdate(plugin, update); }}
                  onRemove={() => { setRemoving(plugin); }}
                />
              )}
            />
          </ListGroup>
        ))
      )}
      {updateCheck}
      {failure !== null ? <div className="mt-2"><InlineError error={failure} /></div> : null}
      <ConfirmDialog
        open={removing !== null}
        overlayId="confirm-installed-remove"
        title={t('cap.remove.title', { name: removing?.displayName ?? '' })}
        body={t('cap.remove.body')}
        confirmLabel={t('cap.action.remove')}
        tone="danger"
        busy={removing !== null && isPluginBusy(removing.id)}
        onCancel={() => { setRemoving(null); }}
        onConfirm={() => {
          const target = removing;
          if (target === null) return;
          void act(target.id, () => client.removePlugin(target.id, { deleteData: false })).then(() => { setRemoving(null); });
        }}
      />
    </div>
  );
}

type InstalledGroup = 'attention' | 'updates' | 'on' | 'off';
const GROUP_ORDER: readonly InstalledGroup[] = ['attention', 'updates', 'on', 'off'];
const GROUP_KEYS = {
  attention: 'cap.installed.group.attention',
  updates: 'cap.installed.group.updates',
  on: 'cap.installed.group.on',
  off: 'cap.installed.group.off',
} as const satisfies Record<InstalledGroup, string>;

const QUICK_ICON_BTN =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-45 pointer-coarse:h-11 pointer-coarse:w-11';

function InstalledRow({
  plugin,
  origin,
  entry,
  update,
  busy,
  density,
  onOpen,
  onOpenSettings,
  onReload,
  onToggle,
  onUpdate,
  onRemove,
}: {
  readonly plugin: PluginSummary;
  readonly origin: PluginOrigin;
  readonly entry?: PluginMarketplaceEntry;
  readonly update?: PluginUpdateView;
  readonly busy: boolean;
  readonly density: ListDensity;
  readonly onOpen: () => void;
  readonly onOpenSettings?: () => void;
  readonly onReload?: () => void;
  readonly onToggle: (enabled: boolean) => void;
  readonly onUpdate: (update: PluginUpdateView) => void;
  readonly onRemove: () => void;
}) {
  const { t } = useI18n();
  const host = useHost();
  const anchor = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const broken = plugin.state === 'error' || plugin.hasErrors;
  const healthLabel = broken ? t('cap.state.error') : plugin.enabled ? t('cap.plugins.healthy') : t('cap.plugins.disabledState');
  const homepage = entry?.homepage;
  const source = plugin.originalSource;

  const entries: MiniMenuEntry[] = [
    { key: 'details', label: t('cap.plugins.menuDetails'), run: onOpen },
  ];
  if (onOpenSettings !== undefined) entries.push({ key: 'settings', label: t('cap.plugins.settings'), run: onOpenSettings });
  if (onReload !== undefined) entries.push({ key: 'reload', label: t('cap.plugins.reload'), run: onReload });
  entries.push({ key: 'toggle', label: plugin.enabled ? t('cap.plugins.menuDisable') : t('cap.plugins.menuEnable'), run: () => { onToggle(!plugin.enabled); } });
  if (homepage !== undefined) entries.push({ key: 'homepage', label: t('cap.plugins.menuHomepage'), run: () => openExternalUrl(host, homepage, t('common.popupBlocked')) });
  if (source !== undefined) entries.push({ key: 'copy', label: t('cap.plugins.menuCopySource'), run: () => copyTextToClipboard(source) });
  entries.push({ separator: true }, { key: 'remove', label: t('cap.action.remove'), danger: true, run: onRemove });

  const fact = [
    plugin.version !== undefined ? `v${plugin.version}` : undefined,
    origin === 'local' || origin === 'git' || origin === 'zip' ? source : undefined,
  ].filter((part) => part !== undefined).join(' · ');

  return (
    <div
      className="group flex min-w-0 items-center gap-2.5 px-3 py-1.5 transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.03] focus-within:bg-ink/[0.03]"
      style={{ minHeight: LIST_ROW_HEIGHT[density] }}
      data-plugin-row={plugin.id}
      data-plugin-origin={origin}
      data-plugin-enabled={plugin.enabled ? 'true' : 'false'}
      data-plugin-health={broken ? 'error' : plugin.enabled ? 'ok' : 'off'}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={t('cap.plugins.openDetail', { name: plugin.displayName })}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
      >
        <span className={plugin.enabled ? '' : 'opacity-60 grayscale'}><CapabilityIcon icon={plugin.icon} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="flex min-w-0 max-w-full items-center gap-2">
              {broken ? (
                <span
                  aria-hidden
                  title={healthLabel}
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
                />
              ) : null}
              <span className={`min-w-0 truncate text-[13px] leading-5 font-normal ${plugin.enabled ? 'text-ink' : 'text-ink-soft'}`}>
                {plugin.displayName}
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <Tag>{t(ORIGIN_KEYS[origin])}</Tag>
              {broken ? <Tag tone="danger">{t('cap.state.error')}</Tag> : null}
            </span>
            {density === 'compact' && fact !== '' ? (
              <span className="min-w-0 truncate font-mono text-[12px] leading-4 text-ink-faint" title={source}>{fact}</span>
            ) : null}
          </span>
          {density === 'compact' ? null : (
            <span className={`mt-0.5 flex min-w-0 items-center gap-2 ${broken ? 'sm:pl-3.5' : ''}`}>
              <span className="min-w-0 truncate font-mono text-[12px] leading-4 text-ink-faint" title={source}>{fact}</span>
            </span>
          )}
        </span>
      </button>

      {update !== undefined ? (
        <button
          type="button"
          onClick={() => { onUpdate(update); }}
          data-plugin-update={plugin.id}
          className="hidden min-h-8 shrink-0 items-center rounded-md px-2.5 text-[12px] leading-4 font-normal text-selected-ink transition-colors hover:bg-selected focus-visible:outline-2 focus-visible:outline-selected-ink min-[480px]:inline-flex"
        >
          {update.version !== undefined ? t('cap.plugins.updateTo', { version: update.version }) : t('cap.action.update')}
        </button>
      ) : null}

      {(onOpenSettings !== undefined || onReload !== undefined) ? (
        <span className="hidden items-center gap-0.5 opacity-100 transition-opacity duration-[var(--kiki-motion-quick)] min-[640px]:flex [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100">
          {onOpenSettings !== undefined ? (
            <button
              type="button"
              data-plugin-settings-action={plugin.id}
              data-plugin-open-settings={plugin.id}
              aria-label={`${plugin.displayName} · ${t('cap.plugins.settings')}`}
              title={t('cap.plugins.settings')}
              onClick={onOpenSettings}
              className={QUICK_ICON_BTN}
            >
              <Icon name="settings" size={14} />
            </button>
          ) : null}
          {onReload !== undefined ? (
            <button
              type="button"
              data-plugin-reload={plugin.id}
              disabled={busy}
              aria-label={`${plugin.displayName} · ${t('cap.plugins.reload')}`}
              title={t('cap.plugins.reload')}
              onClick={onReload}
              className={QUICK_ICON_BTN}
            >
              <Icon name="refresh" size={14} />
            </button>
          ) : null}
        </span>
      ) : null}

      <span data-plugin-row-switch className="flex w-9 shrink-0 items-center justify-end">
        <Toggle
          layout="bare"
          label={plugin.enabled ? t('cap.state.on') : t('cap.state.off')}
          checked={plugin.enabled}
          disabled={busy}
          onChange={onToggle}
        />
      </span>

      <span ref={anchor} className="flex">
        <IconButton
          icon="more"
          label={t('cap.plugins.more', { name: plugin.displayName })}
          pressed={menu !== null}
          dataAttrs={{ 'data-plugin-more': plugin.id }}
          onClick={() => {
            const rect = anchor.current?.getBoundingClientRect();
            setMenu(rect === undefined ? { x: 0, y: 0 } : { x: rect.right - 208, y: rect.bottom + 4 });
          }}
        />
      </span>

      {menu !== null ? (
        <MiniContextMenu
          x={menu.x}
          y={menu.y}
          entries={update !== undefined ? [{ key: 'update', label: t('cap.action.update'), run: () => { onUpdate(update); } }, ...entries] : entries}
          onClose={() => { setMenu(null); }}
          ariaLabel={t('cap.plugins.more', { name: plugin.displayName })}
          overlayId="installed-plugin-menu"
          dataAttribute="data-plugin-card-menu"
        />
      ) : null}
    </div>
  );
}
