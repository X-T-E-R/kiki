/**
 * Installed — every plugin on this server as one management list. A row is
 * icon, name, where it came from (official, catalog, a local folder, git, a
 * ZIP), version, an update hint when the catalog has a newer one, the enable
 * switch, and a ⋯ menu (details, turn off, remove, homepage). Plugins that
 * need attention lead; the rest keep install order.
 */

import { useRef, useState } from 'react';

import { copyTextToClipboard } from '../../lib/clipboard';
import type { PluginMarketplaceEntry, PluginSummary } from '../../lib/client';
import { installedMatches, pluginOrigin, type PluginOrigin } from '../../lib/pluginCatalog';
import { openExternalUrl } from '../../host/external';
import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { InlineError, Toggle } from '../controls';
import { MiniContextMenu, type MiniMenuEntry } from '../MiniContextMenu';
import { CapabilityIcon } from './CapabilityIcon';
import { EmptyNote, IconButton, Tag } from './primitives';
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
  query,
  loading,
  error,
  onOpen,
  onUpdate,
  onAdd,
}: {
  readonly plugins: readonly PluginSummary[];
  readonly entries: readonly PluginMarketplaceEntry[];
  readonly query: string;
  readonly loading: boolean;
  readonly error?: unknown;
  readonly onOpen: (id: string) => void;
  readonly onUpdate: (entry: PluginMarketplaceEntry) => void;
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
  const visible = plugins.filter((plugin) => installedMatches(plugin, query));
  const ordered = [...visible.filter(broken), ...visible.filter((plugin) => !broken(plugin))];

  if (loading) return <p className="py-3 text-[13px] text-ink-faint" role="status">{t('cap.loading')}</p>;
  if (error !== undefined) return <InlineError error={error} />;
  if (plugins.length === 0) {
    return (
      <EmptyNote
        title={t('cap.plugins.noneInstalled')}
        body={t('cap.plugins.noneInstalledBody')}
        action={<button type="button" className="text-[13px] font-medium text-accent-ink hover:underline" onClick={onAdd}>{t('cap.plugins.addFromSource')}</button>}
      />
    );
  }
  if (ordered.length === 0) return <EmptyNote title={t('cap.plugins.noMatch', { query: query.trim() })} />;

  return (
    <div className="min-w-0" data-installed-list>
      <ul className="divide-y divide-hairline border-y border-hairline">
        {ordered.map((plugin) => (
          <InstalledRow
            key={plugin.id}
            plugin={plugin}
            origin={pluginOrigin(plugin, entries)}
            entry={entries.find((entry) => entry.id === plugin.id)}
            busy={busy === plugin.id}
            onOpen={() => { onOpen(plugin.id); }}
            onToggle={(enabled) => { void act(plugin.id, () => client.setPluginEnabled(plugin.id, enabled)); }}
            onUpdate={onUpdate}
            onRemove={() => { setRemoving(plugin); }}
          />
        ))}
      </ul>
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

function InstalledRow({
  plugin,
  origin,
  entry,
  busy,
  onOpen,
  onToggle,
  onUpdate,
  onRemove,
}: {
  readonly plugin: PluginSummary;
  readonly origin: PluginOrigin;
  readonly entry?: PluginMarketplaceEntry;
  readonly busy: boolean;
  readonly onOpen: () => void;
  readonly onToggle: (enabled: boolean) => void;
  readonly onUpdate: (entry: PluginMarketplaceEntry) => void;
  readonly onRemove: () => void;
}) {
  const { t } = useI18n();
  const host = useHost();
  const anchor = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const broken = plugin.state === 'error' || plugin.hasErrors;
  const update = entry?.updateAvailable === true ? entry : undefined;
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
    <li
      className="group flex min-h-[60px] min-w-0 items-center gap-3 px-2 py-2.5 transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.03]"
      data-plugin-row={plugin.id}
      data-plugin-origin={origin}
      data-plugin-enabled={plugin.enabled ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={t('cap.plugins.openDetail', { name: plugin.displayName })}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className={plugin.enabled ? '' : 'opacity-60 grayscale'}><CapabilityIcon icon={plugin.icon} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className={`min-w-0 truncate text-[13px] font-medium ${plugin.enabled ? 'text-ink' : 'text-ink-soft'}`}>{plugin.displayName}</span>
            <span className="shrink-0"><Tag tone={origin === 'official' ? 'accent' : 'faint'}>{t(ORIGIN_KEYS[origin])}</Tag></span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-2">
            {broken ? <span className="shrink-0"><Tag tone="danger">{t('cap.state.error')}</Tag></span> : null}
            <span className="min-w-0 truncate font-mono text-[11px] leading-4 text-ink-faint" title={source}>{fact}</span>
          </span>
        </span>
      </button>
      {update !== undefined ? (
        <button
          type="button"
          onClick={() => { onUpdate(update); }}
          data-plugin-update={plugin.id}
          className="hidden min-h-8 shrink-0 items-center rounded-md px-2.5 text-[12px] font-medium text-accent-ink transition-colors hover:bg-ink/[0.06] focus-visible:outline-2 focus-visible:outline-accent min-[480px]:inline-flex"
        >
          {t('cap.plugins.updateTo', { version: update.version ?? '' })}
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
    </li>
  );
}
