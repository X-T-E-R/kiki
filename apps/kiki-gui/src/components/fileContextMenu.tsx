/**
 * Shared file, attachment, and web-link context menus.
 *
 * One menu surface across message attachments, audio players, composer chips,
 * and web preview cards. File actions delegate to `buildResourceMenuEntries` so
 * local desktop openers, remote/browser pruning, relative/absolute path copying,
 * downloads, and chat mentions stay identical everywhere.
 */

import { useCallback, useMemo, useState, type MouseEvent, type ReactNode } from 'react';

import { resolveHostPath, type MediaRef } from '@kiki/session-core/composer/media';
import type { MessageAttachment } from '@kiki/session-core/session';

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
import { resolveSameSessionAttachmentPath, trustedAttachmentOrigin } from './message/messageMedia';

export interface ResolvedLocalAttachment {
  readonly origin?: { readonly path: string; readonly trusted: true };
  /**
   * Local filesystem path when the attachment can be opened directly on this
   * computer without bouncing through a read-only session copy first.
   */
  readonly localPath?: string;
}

/**
 * Resolve whether a same-session message attachment has a directly openable
 * local file path on the current Kiki computer.
 */
export function resolveDirectLocalAttachment(
  attachment: MessageAttachment,
  options: {
    readonly readable: boolean;
    readonly remote: boolean;
    readonly isHtml: boolean;
    readonly cwd?: string;
  },
): ResolvedLocalAttachment {
  const origin = trustedAttachmentOrigin(attachment, { readable: options.readable });
  if (!options.readable || options.remote) {
    return { origin };
  }
  if (origin !== undefined) {
    return {
      origin,
      localPath: resolveHostPath(origin.path, options.cwd),
    };
  }
  if (options.isHtml) {
    const htmlPath = resolveSameSessionAttachmentPath(attachment, {
      readable: options.readable,
      remote: options.remote,
      cwd: options.cwd,
    });
    if (htmlPath !== undefined) {
      return { origin, localPath: htmlPath };
    }
  }
  return { origin };
}

/**
 * Open a local attachment directly as a live file when it exists on disk,
 * falling back to the preserved session copy if the local file is gone or
 * unreadable.
 */
export function openAttachmentDirectly(options: {
  readonly localPath?: string;
  readonly preview: ReturnType<typeof useMediaPreview>;
  readonly client: ReturnType<typeof useOptionalConnection> extends infer C
    ? C extends { readonly client: infer K }
      ? K | undefined
      : undefined
    : undefined;
  readonly openCopy: () => void;
}): void {
  const { localPath, preview, client, openCopy } = options;
  if (preview === null) return;
  if (localPath === undefined) {
    openCopy();
    return;
  }
  const probe = client !== undefined && typeof client.previewHostFile === 'function'
    ? client.previewHostFile.bind(client)
    : undefined;
  if (probe === undefined) {
    preview.openFile(localPath);
    return;
  }
  void probe(localPath, 1)
    .then(() => {
      preview.openFile(localPath);
    })
    .catch(() => {
      openCopy();
    });
}

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
