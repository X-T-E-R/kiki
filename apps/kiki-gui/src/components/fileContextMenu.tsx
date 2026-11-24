/**
 * Shared file, attachment, and web-link context menus.
 *
 * One menu surface across message attachments, audio players, composer chips,
 * and web preview cards. File actions delegate to `buildResourceMenuEntries` so
 * local desktop openers, remote/browser pruning, relative/absolute path copying,
 * downloads, and chat mentions stay identical everywhere.
 */

import { useCallback, useMemo, useState, type MouseEvent, type ReactNode } from 'react';

import type { MediaRef } from '@kiki/session-core/composer/media';

import { openExternalUrl, useHost } from '../host';
import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import { useOptionalConnection } from '../state/connection';
import { hostFileResource, mediaRefResource } from '../state/previewWorkspace';
import { isOnKikiComputer, isRemoteConnection } from './imageActions';
import { buildResourceMenuEntries, useActiveDraftKey } from './mediaParts';
import { useMediaPreview } from './mediaPreviewContext';
import { MiniContextMenu, type MiniMenuEntry } from './MiniContextMenu';
import { TextTile, type ContextChipVariant } from './ContextChips';
import { openAttachmentDirectly, resolveDirectLocalAttachment, type ResolvedLocalAttachment } from './attachmentDirectOpen';
export { openAttachmentDirectly, resolveDirectLocalAttachment, type ResolvedLocalAttachment };

export interface UseFilePathContextMenuOptions {
  readonly path?: string;
  readonly rawPath?: string;
  readonly label: string;
  readonly sessionId?: string;
  readonly onOpenPreview?: () => void;
}

/**
 * Context menu for a host file path (for example, a composer local-file chip).
 */
export function useFilePathContextMenu({
  path,
  rawPath,
  label,
  sessionId: sessionIdOverride,
  onOpenPreview,
}: UseFilePathContextMenuOptions) {
  const host = useHost();
  const { t } = useI18n();
  const preview = useMediaPreview();
  const connection = useOptionalConnection();
  const localKikiComputer = isOnKikiComputer(connection);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const sessionId = sessionIdOverride ?? preview?.sessionId;
  const draftKey = useActiveDraftKey(sessionId);

  const resource = useMemo(
    () => (path === undefined ? null : hostFileResource(path, preview?.cwd)),
    [path, preview?.cwd],
  );

  const openPreview = useCallback(() => {
    if (onOpenPreview !== undefined) {
      onOpenPreview();
      return;
    }
    if (path !== undefined && preview !== null) {
      preview.openFile(path);
    }
  }, [onOpenPreview, path, preview]);

  const entries = useMemo<readonly MiniMenuEntry[]>(() => {
    if (resource === null) return [];
    const canPreview = onOpenPreview !== undefined || (path !== undefined && preview !== null);
    return buildResourceMenuEntries({
      resource,
      rawPath: rawPath ?? path,
      cwd: preview?.cwd,
      sessionId,
      draftKey,
      localKikiComputer,
      host,
      client: connection?.client,
      t,
      onOpenPreview: canPreview ? openPreview : undefined,
    });
  }, [resource, onOpenPreview, path, preview, rawPath, sessionId, draftKey, localKikiComputer, host, connection?.client, t, openPreview]);

  const openMenu = useCallback(
    (event: MouseEvent) => {
      if (entries.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY });
    },
    [entries.length],
  );

  const menuElement = menu === null || entries.length === 0 ? null : (
    <MiniContextMenu
      x={menu.x}
      y={menu.y}
      entries={entries}
      onClose={() => { setMenu(null); }}
      ariaLabel={label}
      overlayId="file-context-menu"
      dataAttribute="data-file-link-menu"
    />
  );

  return { openMenu, menuElement, hasActions: entries.length > 0 };
}

export interface UseAttachmentContextMenuOptions {
  readonly item: MediaRef;
  readonly label: string;
  readonly readable?: boolean;
  readonly opensLiveDirectly?: boolean;
  readonly sessionId?: string;
  readonly onOpenPreview?: () => void;
}

/**
 * Context menu for a timeline attachment card or inline audio attachment.
 */
export function useAttachmentContextMenu({
  item,
  label,
  readable = true,
  opensLiveDirectly = false,
  sessionId: sessionIdOverride,
  onOpenPreview,
}: UseAttachmentContextMenuOptions) {
  const host = useHost();
  const { t } = useI18n();
  const preview = useMediaPreview();
  const connection = useOptionalConnection();
  const localKikiComputer = isOnKikiComputer(connection);
  const remote = isRemoteConnection(connection);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const sessionId = sessionIdOverride ?? preview?.sessionId;
  const draftKey = useActiveDraftKey(sessionId);

  const resource = useMemo(
    () =>
      mediaRefResource(item, {
        sessionId,
        origin: readable ? item.origin : undefined,
        cwd: preview?.cwd,
        name: label,
      }),
    [item, sessionId, readable, preview?.cwd, label],
  );

  const entries = useMemo<readonly MiniMenuEntry[]>(() => {
    if (!readable) return [];
    const fallbackOpen = preview === null
      ? undefined
      : () => {
          if (item.path !== undefined && !remote) preview.openFile(item.path);
          else if (preview.openAttachmentInWorkspace !== undefined) preview.openAttachmentInWorkspace(item);
          else preview.openAttachment(item);
        };
    return buildResourceMenuEntries({
      resource,
      rawPath: item.path,
      cwd: preview?.cwd,
      sessionId,
      draftKey,
      localKikiComputer,
      host,
      client: connection?.client,
      t,
      onOpenPreview: onOpenPreview ?? fallbackOpen,
      onOpenCurrentFile: preview === null || opensLiveDirectly ? undefined : (targetPath) => { preview.openFile(targetPath); },
    });
  }, [readable, opensLiveDirectly, preview, item, remote, resource, sessionId, draftKey, localKikiComputer, host, connection?.client, t, onOpenPreview]);

  const openMenu = useCallback(
    (event: MouseEvent) => {
      if (entries.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY });
    },
    [entries.length],
  );

  const menuElement = menu === null || entries.length === 0 ? null : (
    <MiniContextMenu
      x={menu.x}
      y={menu.y}
      entries={entries}
      onClose={() => { setMenu(null); }}
      ariaLabel={label}
      overlayId="attachment-context-menu"
      dataAttribute="data-file-link-menu"
    />
  );

  return { openMenu, menuElement, hasActions: entries.length > 0 };
}

export interface UseWebLinkContextMenuOptions {
  readonly url: string;
  readonly title: string;
  readonly onOpenPreview?: () => void;
}

/**
 * Context menu for a web link preview card: open in browser, open in preview
 * pane (when available), and copy URL.
 */
export function useWebLinkContextMenu({ url, title, onOpenPreview }: UseWebLinkContextMenuOptions) {
  const host = useHost();
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const entries = useMemo<readonly MiniMenuEntry[]>(() => {
    const list: MiniMenuEntry[] = [
      {
        key: 'open-in-browser',
        label: t('message.openInBrowser'),
        run: () => { void openExternalUrl(host, url, t('common.popupBlocked')); },
      },
    ];
    if (onOpenPreview !== undefined) {
      list.push({
        key: 'open-preview',
        label: t('file.openPreview'),
        run: onOpenPreview,
      });
    }
    list.push({ separator: true });
    list.push({
      key: 'copy-link',
      label: t('link.copyLink'),
      run: () => copyTextToClipboard(url),
    });
    return list;
  }, [host, onOpenPreview, t, url]);

  const openMenu = useCallback((event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const menuElement = menu === null ? null : (
    <MiniContextMenu
      x={menu.x}
      y={menu.y}
      entries={entries}
      onClose={() => { setMenu(null); }}
      ariaLabel={title}
      overlayId="web-link-context-menu"
      dataAttribute="data-web-link-menu"
    />
  );

  return { openMenu, menuElement };
}

/**
 * A composer file-attachment tile with the unified file right-click menu.
 */
export function ComposerFileTile({
  path,
  name,
  isDir,
  subtitle,
  leading,
  onRemove,
  removeLabel,
  variant = 'shelf',
}: {
  readonly path: string;
  readonly name: string;
  readonly isDir?: boolean;
  readonly subtitle?: string;
  readonly leading?: ReactNode;
  readonly onRemove?: () => void;
  readonly removeLabel?: string;
  readonly variant?: ContextChipVariant;
}) {
  const fileMenu = useFilePathContextMenu({
    path: isDir ? undefined : path,
    rawPath: path,
    label: name,
  });
  return (
    <>
      <TextTile
        variant={variant}
        title={path}
        subtitle={subtitle}
        leading={leading}
        mono
        onContextMenu={fileMenu.hasActions ? fileMenu.openMenu : undefined}
        onRemove={onRemove}
        removeLabel={removeLabel}
      >
        <span className="min-w-0 truncate">{name}{isDir ? '/' : ''}</span>
      </TextTile>
      {fileMenu.menuElement}
    </>
  );
}
