/**
 * Installed — every plugin on this server as one management list, on the
 * shared settings list pattern: the toolbar carries search, state chips and
 * density; rows group into needs attention / updates available / on / off
 * (each shown only when non-empty, each foldable). A row is icon, name, where
 * it came from (official, catalog, a local folder, git, a ZIP), version, an
 * update hint when the catalog or GitHub has a newer one, the enable switch,
 * and a ⋯ menu (details, turn off, remove, homepage).
 */

import { useRef, useState, type ReactNode } from 'react';

import { copyTextToClipboard } from '../../lib/clipboard';
import type { PluginMarketplaceEntry, PluginSummary } from '../../lib/client';
import { pluginOrigin, type PluginOrigin, type PluginUpdateView } from '../../lib/pluginCatalog';
import { openExternalUrl } from '../../host/external';
import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { InlineError, Toggle } from '../controls';
import { MiniContextMenu, type MiniMenuEntry } from '../MiniContextMenu';
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
import { IconButton, Tag } from './primitives';
import { useInvalidatePlugins } from './usePlugins';

const ORIGIN_KEYS = {
  official: 'cap.origin.official',
  catalog: 'cap.origin.catalog',
  local: 'cap.origin.local',
  git: 'cap.origin.git',
  zip: 'cap.origin.zip',
} as const satisfies Record<PluginOrigin, string>;

export function InstalledList({
  plugins,
  entries,
  loading,
  error,
  updates,
  updateCheck,
  onOpen,
  onUpdate,
  onAdd,
}: {
  readonly plugins: readonly PluginSummary[];
  readonly entries: readonly PluginMarketplaceEntry[];
  readonly loading: boolean;
  readonly error?: unknown;
  /** Available update per plugin id, from the catalog or GitHub. */
  readonly updates: ReadonlyMap<string, PluginUpdateView>;
  /** The GitHub check line under the list; absent without GitHub installs. */
  readonly updateCheck?: ReactNode;
  readonly onOpen: (id: string) => void;
  readonly onUpdate: (plugin: PluginSummary, update: PluginUpdateView) => void;
  readonly onAdd: () => void;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const invalidate = useInvalidatePlugins();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [removing, setRemoving] = useState<PluginSummary | null>(null);

  const act = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setFailure(null);
    try {
      await action();
      await invalidate();
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(null);
    }
  };

  const broken = (plugin: PluginSummary) => plugin.state === 'error' || plugin.hasErrors;
  const groupOf = (plugin: PluginSummary): InstalledGroup =>
    broken(plugin) ? 'attention' : updates.has(plugin.id) ? 'updates' : plugin.enabled ? 'on' : 'off';

  const keyOf = (plugin: PluginSummary) => plugin.id;
  const textOf = (plugin: PluginSummary) => [plugin.displayName, plugin.id, plugin.originalSource];
  const filters: readonly ListFilterSpec<PluginSummary>[] = [
    { id: 'attention', label: t('cap.installed.group.attention'), tone: 'attention', test: (plugin) => groupOf(plugin) === 'attention' },
    { id: 'updates', label: t('cap.installed.group.updates'), test: (plugin) => groupOf(plugin) === 'updates' },
    { id: 'on', label: t('cap.installed.group.on'), test: (plugin) => plugin.enabled },
    { id: 'off', label: t('cap.installed.group.off'), test: (plugin) => !plugin.enabled },
  ];
  const view = useListView({ listId: 'cap-plugins-installed', items: plugins, keyOf, textOf, filters });
  const groups = groupItems(plugins, view.visible, (plugin) => {
    const id = groupOf(plugin);
    return [{ key: id, label: t(GROUP_KEYS[id]) }];
  }, GROUP_ORDER);

  if (loading) return <p className="py-3 text-[13px] text-ink-faint" role="status">{t('cap.loading')}</p>;
  if (error !== undefined) return <InlineError error={error} />;
  if (plugins.length === 0) {
    return (
      <ListEmpty
        kind="none"
        title={t('cap.plugins.noneInstalled')}
        body={t('cap.plugins.noneInstalledBody')}
        action={<button type="button" className="text-[13px] font-medium text-selected-ink hover:underline" onClick={onAdd}>{t('cap.plugins.addFromSource')}</button>}
      />
    );
  }

  return (
    <div className="min-w-0 space-y-3 [&_[data-list-toolbar]]:-top-4 min-[720px]:[&_[data-list-toolbar]]:-top-8" data-installed-list>
      <ListToolbar view={view} total={plugins.length} filters={filters}
        searchLabel={t('cap.plugins.searchInstalled')} searchPlaceholder={t('cap.plugins.searchInstalled')} />
      {view.visible.length === 0 ? (
        <ListEmpty kind="no-match" title={t('cap.plugins.noMatchTitle')}
          body={view.query.trim() !== '' ? t('cap.plugins.noMatch', { query: view.query.trim() }) : undefined}
          onClear={view.clear} />
      ) : (
        groups.map((group) => (
          <ListGroup key={group.key} groupKey={group.key} label={group.label} count={group.items.length} total={group.total}
            folded={view.isFolded(group.key)} onToggle={() => { view.toggleFold(group.key); }}>
            <ListBody items={group.items} keyOf={keyOf} density={view.density} label={group.label}
              renderRow={(plugin) => (
                <InstalledRow
                  plugin={plugin}
                  density={view.density}
                  origin={pluginOrigin(plugin, entries)}
                  entry={entries.find((entry) => entry.id === plugin.id)}
                  update={updates.get(plugin.id)}
                  busy={busy === plugin.id}
                  onOpen={() => { onOpen(plugin.id); }}
                  onToggle={(enabled) => { void act(plugin.id, () => client.setPluginEnabled(plugin.id, enabled)); }}
                  onUpdate={(update) => { onUpdate(plugin, update); }}
                  onRemove={() => { setRemoving(plugin); }}
                />
              )} />
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
        busy={removing !== null && busy === removing.id}
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

function InstalledRow({
  plugin,
  origin,
  entry,
  update,
  busy,
  density,
  onOpen,
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
  readonly onToggle: (enabled: boolean) => void;
  readonly onUpdate: (update: PluginUpdateView) => void;
  readonly onRemove: () => void;
}) {
  const { t } = useI18n();
  const host = useHost();
  const anchor = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const broken = plugin.state === 'error' || plugin.hasErrors;
  const homepage = entry?.homepage;
  const source = plugin.originalSource;
  const entries: MiniMenuEntry[] = [
    { key: 'details', label: t('cap.plugins.menuDetails'), run: onOpen },
    { key: 'toggle', label: plugin.enabled ? t('cap.plugins.menuDisable') : t('cap.plugins.menuEnable'), run: () => { onToggle(!plugin.enabled); } },
  ];
  if (homepage !== undefined) entries.push({ key: 'homepage', label: t('cap.plugins.menuHomepage'), run: () => openExternalUrl(host, homepage, t('common.popupBlocked')) });
  if (source !== undefined) entries.push({ key: 'copy', label: t('cap.plugins.menuCopySource'), run: () => copyTextToClipboard(source) });
  entries.push({ separator: true }, { key: 'remove', label: t('cap.action.remove'), danger: true, run: onRemove });

  // Local and git plugins read their source as the fact; catalog plugins their version.
  const fact = [
    plugin.version !== undefined ? `v${plugin.version}` : undefined,
    origin === 'local' || origin === 'git' || origin === 'zip' ? source : undefined,
  ].filter((part) => part !== undefined).join(' · ');

  return (
    <div
      className="group flex min-w-0 items-center gap-3 px-3 py-1.5 transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.03]"
      style={{ minHeight: LIST_ROW_HEIGHT[density] }}
      data-plugin-row={plugin.id}
      data-plugin-origin={origin}
      data-plugin-enabled={plugin.enabled ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={t('cap.plugins.openDetail', { name: plugin.displayName })}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
      >
        <span className={plugin.enabled ? '' : 'opacity-60 grayscale'}><CapabilityIcon icon={plugin.icon} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className={`min-w-0 truncate text-[13px] font-medium ${plugin.enabled ? 'text-ink' : 'text-ink-soft'}`}>{plugin.displayName}</span>
            <span className="shrink-0"><Tag>{t(ORIGIN_KEYS[origin])}</Tag></span>
            {broken ? <span className="shrink-0"><Tag tone="danger">{t('cap.state.error')}</Tag></span> : null}
            {density === 'compact' && fact !== '' ? (
              <span className="min-w-0 truncate font-mono text-[11px] leading-4 text-ink-faint" title={source}>{fact}</span>
            ) : null}
          </span>
          {density === 'compact' ? null : (
            <span className="mt-0.5 flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate font-mono text-[11px] leading-4 text-ink-faint" title={source}>{fact}</span>
            </span>
          )}
        </span>
      </button>
      {update !== undefined ? (
        <button
          type="button"
          onClick={() => { onUpdate(update); }}
          data-plugin-update={plugin.id}
          className="hidden min-h-8 shrink-0 items-center rounded-md px-3 text-[12px] font-medium text-selected-ink transition-colors hover:bg-selected focus-visible:outline-2 focus-visible:outline-selected-ink min-[480px]:inline-flex"
        >
          {update.version !== undefined ? t('cap.plugins.updateTo', { version: update.version }) : t('cap.action.update')}
        </button>
      ) : null}
      {/* The word beside the switch drops on narrow widths; the switch keeps it as its name. */}
      <span className="shrink-0 [&_label>span:last-child]:max-[479px]:sr-only">
      <Toggle
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
