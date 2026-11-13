/**
 * Sandboxed plugin panel tab inside `PreviewWorkspace` (`kind: 'plugin'`).
 *
 * Keeps `PluginPanelHost` mounted across tab switches and collapse so live
 * device streams, WebSocket topics, and polling loops survive peeking at a
 * file tab. Reload remounts the iframe cleanly via `reloadKey`.
 */

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useI18n } from '#/i18n';
import { usePhoneMode } from '#/lib/layoutHooks';
import { PluginPanelHost } from '../capabilities/PluginPanelHost';
import { Icon, resolvePluginSlotIconName } from '../icons';
import { CAPTION_ACTION_CLASS, HEADER_ACTION_CLASS } from './shared';

export function PreviewPluginView({
  tabKey,
  pluginId,
  panelId,
  title,
  sessionId,
  visible,
  isFullscreen = false,
  onToggleFullscreen,
  onCollapse,
  onCloseTab,
  externalReloadNonce,
}: {
  readonly tabKey: string;
  readonly pluginId: string;
  readonly panelId: string;
  readonly title?: string;
  readonly sessionId?: string;
  readonly visible: boolean;
  readonly isFullscreen?: boolean;
  readonly onToggleFullscreen?: () => void;
  readonly onCollapse?: () => void;
  readonly onCloseTab?: () => void;
  readonly externalReloadNonce?: number;
}) {
  const { t } = useI18n();
  const phoneMode = usePhoneMode();
  const queryClient = useQueryClient();
  const [reloadKey, setReloadKey] = useState(0);
  const displayTitle = title !== undefined && title.trim() !== '' ? title.trim() : `${pluginId} · ${panelId}`;
  const iconName = resolvePluginSlotIconName({ pluginId, panelId, fallback: 'plugin' });

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['plugin-panel-document', pluginId, panelId],
    });
    setReloadKey((current) => current + 1);
  }, [panelId, pluginId, queryClient]);

  useEffect(() => {
    if (externalReloadNonce !== undefined && externalReloadNonce > 0) reload();
  }, [externalReloadNonce, reload]);

  return (
    <div
      role="tabpanel"
      hidden={!visible}
      className={`min-h-0 flex-1 flex-col bg-paper ${visible ? 'flex' : 'hidden'}`}
      data-preview-tabpanel={tabKey}
      data-preview-plugin-panel={`${pluginId}:${panelId}`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
        <Icon name={iconName} size={12} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-soft" title={`${pluginId}:${panelId}`}>
          {phoneMode ? displayTitle : `${pluginId} · ${panelId}`}
        </span>
        <button
          type="button"
          title={t('preview.reloadFile')}
          aria-label={t('preview.reloadFile')}
          data-plugin-panel-reload
          onClick={reload}
          className={
            phoneMode
              ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink'
              : HEADER_ACTION_CLASS
          }
        >
          <Icon name="refresh" size={phoneMode ? 14 : 12} />
        </button>
        {phoneMode && onToggleFullscreen !== undefined ? (
          <button
            type="button"
            title={isFullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')}
            aria-label={isFullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')}
            data-plugin-panel-fullscreen
            onClick={onToggleFullscreen}
            className={CAPTION_ACTION_CLASS}
          >
            <Icon name={isFullscreen ? 'collapse' : 'expand'} size={12} />
          </button>
        ) : null}
        {phoneMode && onCollapse !== undefined ? (
          <button
            type="button"
            title={t('preview.collapse')}
            aria-label={t('preview.collapse')}
            data-plugin-panel-collapse
            onClick={onCollapse}
            className={CAPTION_ACTION_CLASS}
          >
            <span aria-hidden className="text-[12px] leading-none">»</span>
          </button>
        ) : null}
        {onCloseTab !== undefined ? (
          <button
            type="button"
            title={`${t('common.close')} ${displayTitle}`}
            aria-label={`${t('common.close')} ${displayTitle}`}
            data-plugin-panel-close
            onClick={onCloseTab}
            className={`${CAPTION_ACTION_CLASS} hover:text-danger`}
          >
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-paper">
        <PluginPanelHost
          key={`${pluginId}:${panelId}:${reloadKey}`}
          pluginId={pluginId}
          panelId={panelId}
          title={title ?? panelId}
          sessionId={sessionId}
          workspaceId={undefined}
          variant="workspace"
        />
      </div>
    </div>
  );
}
