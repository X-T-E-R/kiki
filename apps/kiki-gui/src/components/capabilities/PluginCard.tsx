/**
 * A plugin as a two-line catalog card (Codex plugin-page grammar): icon, name
 * with at most one tag, one sentence, and a trailing slot with Install for
 * what is not installed yet and a ⋯ menu always. The whole card opens the
 * detail; the menu holds the secondary actions. Enabling and removing live
 * in the Installed view, so the catalog card never toggles anything.
 */

import { useRef, useState, type ReactNode } from 'react';

import { copyTextToClipboard } from '../../lib/clipboard';
import type { PluginMarketplaceEntry, PluginSummary } from '../../lib/client';
import { openExternalUrl } from '../../host/external';
import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { MiniContextMenu, type MiniMenuEntry } from '../MiniContextMenu';
import { CapabilityIcon } from './CapabilityIcon';
import { CapabilityRow, IconButton, Tag } from './primitives';

export function PluginCard({
  id,
  name,
  icon,
  line,
  entry,
  installed,
  badge,
  hasUpdate = false,
  onOpen,
  onInstall,
  onUpdate,
}: {
  readonly id: string;
  readonly name: string;
  readonly icon?: string;
  readonly line: string;
  readonly entry?: PluginMarketplaceEntry;
  readonly installed?: PluginSummary;
  readonly badge?: ReactNode;
  /** An update from the catalog or GitHub (one answer, computed by the view). */
  readonly hasUpdate?: boolean;
  readonly onOpen: () => void;
  readonly onInstall?: () => void;
  /** Opens the update preview; never installs directly. */
  readonly onUpdate?: () => void;
}) {
  const { t } = useI18n();
  const host = useHost();
  const anchor = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // The catalog reports install state on its own; the installed list may lag.
  const isInstalled = installed !== undefined || entry?.installed !== undefined;
  const enabled = installed?.enabled ?? entry?.installed?.enabled ?? true;
  const state = !isInstalled ? 'install' : hasUpdate ? 'update' : 'installed';
  const source = entry?.source ?? installed?.originalSource;
  const homepage = entry?.homepage;
  const entries: MiniMenuEntry[] = [
    { key: 'details', label: t('cap.plugins.menuDetails'), run: onOpen },
  ];
  if (!isInstalled && onInstall !== undefined) {
    entries.push({ key: 'install', label: t('cap.action.install'), run: onInstall });
  }
  if (homepage !== undefined) {
    entries.push({ key: 'homepage', label: t('cap.plugins.menuHomepage'), run: () => openExternalUrl(host, homepage, t('common.popupBlocked')) });
  }
  if (source !== undefined) {
    entries.push({ key: 'copy', label: t('cap.plugins.menuCopySource'), run: () => copyTextToClipboard(source) });
  }

  const openMenu = () => {
    const rect = anchor.current?.getBoundingClientRect();
    setMenu(rect === undefined ? { x: 0, y: 0 } : { x: rect.right - 208, y: rect.bottom + 4 });
  };

  return (
    <>
      <CapabilityRow
        dataAttrs={{ 'data-catalog-row': id, 'data-catalog-state': state }}
        icon={<span className={enabled ? '' : 'grayscale'}><CapabilityIcon icon={icon} /></span>}
        title={name}
        openLabel={t('cap.plugins.openDetail', { name })}
        onOpen={onOpen}
        badge={badge ?? (state === 'installed'
          ? <Tag>{enabled ? t('cap.state.installed') : t('cap.state.installedOff')}</Tag>
          : undefined)}
        meta={line === '' ? undefined : line}
        trailing={(
          <>
            {state === 'update' && onUpdate !== undefined ? (
              <button
                type="button"
                onClick={onUpdate}
                aria-label={t('cap.action.updateNamed', { name })}
                data-catalog-install={id}
                className="inline-flex min-h-8 items-center rounded-md px-3 text-[13px] font-medium text-selected-ink transition-colors duration-[var(--kiki-motion-quick)] hover:bg-selected focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
              >
                {t('cap.action.update')}
              </button>
            ) : state === 'install' && onInstall !== undefined ? (
              <IconButton icon="plus" label={t('cap.action.installNamed', { name })} onClick={onInstall} dataAttrs={{ 'data-catalog-install': id }} />
            ) : null}
            <span ref={anchor} className="flex">
              <IconButton
                icon="more"
                label={t('cap.plugins.more', { name })}
                onClick={openMenu}
                pressed={menu !== null}
                dataAttrs={{ 'data-catalog-more': id }}
              />
            </span>
          </>
        )}
      />
      {menu !== null ? (
        <MiniContextMenu
          x={menu.x}
          y={menu.y}
          entries={entries}
          onClose={() => { setMenu(null); }}
          ariaLabel={t('cap.plugins.more', { name })}
          overlayId="plugin-card-menu"
          dataAttribute="data-plugin-card-menu"
        />
      ) : null}
    </>
  );
}
