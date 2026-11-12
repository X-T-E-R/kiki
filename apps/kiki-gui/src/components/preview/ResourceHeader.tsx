/**
 * Resource header action controls and the tab right-click context menu.
 */

import { appendToDraft } from '@kiki/session-core/composer';
import { basenameOf, resolveHostPath } from '@kiki/session-core/composer/media';
import { openExternalUrl, useHost } from '#/host';
import { useI18n } from '#/i18n';
import { copyTextToClipboard } from '#/lib/clipboard';
import { useOptionalConnection } from '#/state/connection';
import {
  classifyResource,
  resourceActions,
  resourceMutability,
  type PreviewReadState,
  type PreviewResource,
} from '#/state/previewResource';
import {
  previewTabKey,
  type PreviewTab as PreviewTabModel,
} from '#/state/previewWorkspace';
import type { AgentWorkspaceNavigation } from '../agent-workspace/AgentWorkspace';
import { Icon } from '../icons';
import { saveMediaToDisk } from '../imageActions';
import { safeImagePreviewName } from '../imagePreviewName';
import { MiniContextMenu, type MiniMenuEntry } from '../MiniContextMenu';
import {
  downloadHostFile,
  HEADER_ACTION_CLASS,
  mentionTokenFor,
  relativeToCwd,
  useFileOpeners,
  usePreviewEnvironment,
} from './shared';

function refineResourceWithReadState(
  resource: PreviewResource,
  readState: PreviewReadState | undefined,
): PreviewResource {
  if (readState?.losslessUtf8 === undefined || resource.source.kind !== 'host-file') {
    return resource;
  }
  const head = readState.losslessUtf8 ? new Uint8Array([0x61]) : new Uint8Array([0xff]);
  return {
    ...resource,
    type: classifyResource({ name: resource.name ?? basenameOf(resource.source.path), mime: resource.mime, head }),
  };
}

export function TabContextMenu({
  menu,
  cwd,
  sessionId,
  readState,
  workspaceNavigation,
  onOpenCurrentFile,
  onReloadTab,
  onCloseMenu,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
}: {
  readonly menu: { tab: PreviewTabModel; x: number; y: number };
  readonly cwd: string | undefined;
  readonly sessionId: string | undefined;
  readonly readState: PreviewReadState | undefined;
  readonly workspaceNavigation: AgentWorkspaceNavigation | undefined;
  readonly onOpenCurrentFile: (path: string) => void;
  readonly onReloadTab?: (key: string) => void;
  readonly onCloseMenu: () => void;
  readonly onCloseTab: () => void;
  readonly onCloseOthers: () => void;
  readonly onCloseAll: () => void;
}) {
  const host = useHost();
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const environment = usePreviewEnvironment(sessionId);
  const tab = menu.tab;
  const entries: MiniMenuEntry[] = [
    { key: 'close-tab', label: t('preview.closeTab'), run: onCloseTab },
    { key: 'close-others', label: t('preview.closeOthers'), run: onCloseOthers },
    { key: 'close-all', label: t('preview.closeAll'), run: onCloseAll },
  ];
  if (tab.kind === 'resource') {
    const resource = refineResourceWithReadState(tab.resource, readState);
    const effectiveReadState: PreviewReadState = readState ?? {
      status: 'ready',
      readableFromDevice: true,
      originalReadable: true,
    };
    const actions = resourceActions(resource, environment, effectiveReadState);
    const isCopy = resourceMutability(resource) === 'copy';
    const trustedPath =
      resource.origin !== undefined && resource.origin.trusted
        ? resolveHostPath(resource.origin.path, cwd)
        : resource.source.kind === 'host-file'
          ? resolveHostPath(resource.source.path, cwd)
          : undefined;
    const actionEntries: MiniMenuEntry[] = [];
    for (const action of actions) {
      if (action.id === 'open-current-file' && trustedPath !== undefined) {
        actionEntries.push({
          key: 'open-current-file',
          label: t('preview.openCurrentFile'),
          run: () => { onOpenCurrentFile(trustedPath); },
        });
      } else if (action.id === 'download') {
        if (resource.source.kind === 'host-file') {
          const filePath = resolveHostPath(resource.source.path, cwd);
          actionEntries.push({
            key: 'download',
            label: t('media.download'),
            run: () => {
              if (client !== undefined) return downloadHostFile(host, client, filePath, basenameOf(filePath), t);
            },
          });
        } else {
          const name = resource.name ?? t('media.attachment');
          const downloadName = safeImagePreviewName({ name: resource.name, path: trustedPath }) ?? name;
          const copySource = resource.source;
          actionEntries.push({
            key: 'download',
            label: t('media.download'),
            run: async () => {
              await saveMediaToDisk(
                {
                  url: copySource.kind === 'url' ? copySource.url : undefined,
                  fileId: copySource.kind === 'session-copy' ? copySource.fileId : undefined,
                },
                downloadName,
                host,
                client as Parameters<typeof saveMediaToDisk>[3],
                copySource.kind === 'session-copy' ? (copySource.sessionId || sessionId) : sessionId,
              );
            },
          });
        }
      } else if (action.id === 'add-to-chat' && sessionId !== undefined && trustedPath !== undefined) {
        actionEntries.push({
          key: 'add-to-chat',
          label: t('preview.addToChat'),
          run: () => { appendToDraft(sessionId, mentionTokenFor(trustedPath, cwd)); },
        });
      } else if (action.id === 'copy-path' && trustedPath !== undefined) {
        const relativePath = relativeToCwd(trustedPath, cwd);
        if (!isCopy || relativePath !== trustedPath) {
          actionEntries.push({
            key: 'copy-relative',
            label: t('file.copyRelativePath'),
            run: () => copyTextToClipboard(relativePath),
          });
        }
        actionEntries.push({
          key: 'copy-absolute',
          label: isCopy ? t('file.copyPath') : t('file.copyAbsolutePath'),
          run: () => copyTextToClipboard(trustedPath),
        });
      } else if (action.id === 'show-on-this-computer' && trustedPath !== undefined && host.revealPath !== undefined) {
        actionEntries.push({
          key: 'show-in-folder',
          label: isCopy ? t('preview.showOnThisComputer') : t('file.showInFolder'),
          run: () => host.revealPath!(trustedPath),
        });
      } else if (action.id === 'open-with-default-app' && trustedPath !== undefined && host.openPath !== undefined) {
        actionEntries.push({
          key: 'open-default-app',
          label: isCopy ? t('preview.openOriginalFile') : t('file.openDefaultApp'),
          run: () => host.openPath!(trustedPath),
        });
      } else if (action.id === 'reload' && onReloadTab !== undefined) {
        actionEntries.push({
          key: 'reload',
          label: t('preview.reloadFile'),
          run: () => { onReloadTab(previewTabKey(tab, cwd)); },
        });
      }
    }
    if (actionEntries.length > 0) {
      entries.push({ separator: true }, ...actionEntries);
    }
  } else if (tab.kind === 'web') {
    entries.push(
      { separator: true },
      ...(onReloadTab === undefined
        ? []
        : [{ key: 'reload', label: t('preview.reloadFile'), run: () => { onReloadTab(previewTabKey(tab, cwd)); } }]),
      { key: 'copy-url', label: t('preview.copyUrl'), run: () => copyTextToClipboard(tab.url) },
      { key: 'open-browser', label: t('message.openInBrowser'), run: () => { void openExternalUrl(host, tab.url, t('common.popupBlocked')); } },
    );
  } else if (tab.kind === 'panel') {
    entries.push({ separator: true });
    if (workspaceNavigation !== undefined) {
      entries.push({ key: 'open-agent-route', label: t('preview.openAgentFullscreen', { name: tab.title ?? tab.agentId }), run: () => { workspaceNavigation.openAgentRoute(tab.agentId); } });
    }
    entries.push({ key: 'copy-agent-id', label: t('preview.copyAgentId'), run: () => copyTextToClipboard(tab.agentId) });
  }
  return (
    <MiniContextMenu
      x={menu.x}
      y={menu.y}
      entries={entries}
      onClose={onCloseMenu}
      ariaLabel={t('preview.tabMenuAria')}
      overlayId="preview-tab-menu"
      dataAttribute="data-preview-tab-menu"
    />
  );
}

/**
 * The header action trio: optional Reload, the download anchor (omitted when
 * the read failed) plus, where desktop openers apply, "open with default app"
 * and "reveal in file manager" sitting beside it.
 */
export function HeaderFileActions({
  path,
  name,
  canDownload = true,
  readFailed = false,
  failureReason,
  onReload,
}: {
  readonly path: string;
  readonly name: string;
  readonly canDownload?: boolean;
  readonly readFailed?: boolean;
  readonly failureReason?: PreviewReadState['failureReason'];
  readonly onReload?: () => void;
}) {
  const host = useHost();
  const { t } = useI18n();
  const client = useOptionalConnection()?.client;
  const openers = useFileOpeners();
  const showOpeners = !readFailed || failureReason === 'folder' || failureReason === 'unsupported';
  return (
    <>
      {onReload !== undefined ? (
        <button
          type="button"
          title={t('preview.reloadFile')}
          aria-label={t('preview.reloadFile')}
          data-header-reload
          onClick={onReload}
          className={HEADER_ACTION_CLASS}
        >
          <Icon name="refresh" size={12} />
        </button>
      ) : null}
      {canDownload && !readFailed ? (
        <button
          type="button"
          title={t('media.download')}
          aria-label={t('media.download')}
          data-download-file
          onClick={() => {
            if (client !== undefined) void downloadHostFile(host, client, path, name, t);
          }}
          className={HEADER_ACTION_CLASS}
        >
          <Icon name="arrowDown" size={12} />
        </button>
      ) : null}
      {showOpeners && failureReason !== 'folder' && openers?.open !== undefined ? (
        <button
          type="button"
          title={t('file.openDefaultApp')}
          data-open-default-app
          onClick={() => { openers.open!(path); }}
          className={HEADER_ACTION_CLASS}
        >
          {t('file.open')}
        </button>
      ) : null}
      {showOpeners && openers?.reveal !== undefined ? (
        <button
          type="button"
          title={t('file.showInFolder')}
          aria-label={t('file.showInFolder')}
          data-reveal-file
          onClick={() => { openers.reveal!(path); }}
          className={HEADER_ACTION_CLASS}
        >
          <Icon name="folder" size={12} />
        </button>
      ) : null}
    </>
  );
}
