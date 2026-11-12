/**
 * Session attachment preview tab — renders sent copies (and path-backed
 * attachments) across HTML, document, Markdown, text, image, audio, video, and
 * binary fallbacks, with shared `resourceActions` header controls.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { appendToDraft } from '@kiki/session-core/composer';
import { formatBytes, resolveHostPath, type MediaRef } from '@kiki/session-core/composer/media';
import { errorToText } from '@kiki/session-core/util';
import { useHost } from '#/host';
import { useI18n } from '#/i18n';
import { copyTextToClipboard } from '#/lib/clipboard';
import { pushToast, runToastAction } from '#/lib/toasts';
import { useOptionalConnection } from '#/state/connection';
import {
  resourceActions,
  resourceMutability,
  type PreviewReadState,
  type ResourceActionId,
} from '#/state/previewResource';
import { CodeEditor } from '../CodeEditor';
import { Icon } from '../icons';
import { imageDownloadFailureText, saveMediaToDisk } from '../imageActions';
import { safeImagePreviewName } from '../imagePreviewName';
import { ImageViewport } from '../ImageViewport';
import { Markdown } from '../Markdown';
import { attachmentName, MediaLoadFailure, useSessionMedia } from '../mediaParts';
import { MiniContextMenu, type MiniMenuEntry } from '../MiniContextMenu';
import { useSessionMediaPlayback } from '../useSessionMediaPlayback';
import { DocumentTabView } from './DocumentTabView';
import {
  BODY_ACTION_CLASS,
  buildAttachmentTabResource,
  CAPTION_ACTION_CLASS,
  classifyHtmlPreviewError,
  DelayedReadingNotice,
  HEADER_ACTION_CLASS,
  INK_BUTTON_CLASS,
  isLocalKikiComputer,
  mentionTokenFor,
  relativeToCwd,
  SandboxedHtmlPreview,
  usePreviewEnvironment,
  usePreviewReadingScroll,
  type HtmlPreviewState,
  type PreviewScrollPosition,
} from './shared';

function isAttachmentTextPreview(mime: string, name: string): boolean {
  if (mime.startsWith('text/')) return true;
  if (mime === 'application/json' || mime === 'application/x-ipynb+json' || mime === 'application/xml' || mime.endsWith('+json')) return true;
  return /\.(?:md|markdown|txt|log|json|jsonl|ipynb|ya?ml|toml|ini|csv|tsv|xml|html?|xhtml|css|jsx?|tsx?|py|rs|go|java|c|cc|cpp|h|hpp|sh|zsh|fish|ps1)$/iu.test(name);
}

function isAttachmentHtml(mime: string, name: string): boolean {
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return true;
  return /\.(?:html?|xhtml)$/iu.test(name);
}

function isAttachmentMarkdown(mime: string, name: string): boolean {
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return true;
  return /\.(?:md|markdown|mdx)$/iu.test(name);
}

function isAttachmentDocument(mime: string, name: string): boolean {
  if (
    mime === 'application/pdf' ||
    mime === 'text/csv' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return true;
  }
  return /\.(?:pdf|docx|xlsx|pptx|csv)$/iu.test(name);
}

export function PreviewAttachmentView({
  tabKey,
  item,
  origin,
  sessionId,
  workspaceRoot,
  visible,
  onOpenImage,
  onOpenCurrentFile,
  onReadStateChange,
  position,
  onScrollPosition,
}: {
  readonly tabKey: string;
  readonly item: MediaRef;
  readonly origin?: { readonly path: string; readonly trusted: true };
  readonly sessionId?: string;
  readonly workspaceRoot?: string;
  readonly visible: boolean;
  readonly onOpenImage: (src: string, name?: string, sourcePath?: string) => void;
  readonly onOpenCurrentFile?: (path: string) => void;
  readonly onReadStateChange?: (state: PreviewReadState) => void;
  readonly position?: PreviewScrollPosition;
  readonly onScrollPosition?: (position: { top: number; left?: number }) => void;
}) {
  const host = useHost();
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const remoteScope = !isLocalKikiComputer(connection);
  const environment = usePreviewEnvironment(sessionId);
  const fallbackName = item.kind === 'image' ? t('media.image') : t('media.attachment');
  const name = attachmentName(item, undefined, fallbackName);
  const resource = useMemo(
    () => buildAttachmentTabResource(item, sessionId, origin, workspaceRoot, fallbackName),
    [item, sessionId, origin, workspaceRoot, fallbackName],
  );
  const isCopy = resourceMutability(resource) === 'copy';
  const trustedPath =
    resource.origin !== undefined && resource.origin.trusted
      ? resource.origin.path
      : resource.source.kind === 'host-file'
        ? resource.source.path
        : undefined;
  const trustedDirectory = useMemo(() => {
    if (trustedPath === undefined) return undefined;
    const normalized = trustedPath.replaceAll('\\', '/');
    return normalized.slice(0, normalized.lastIndexOf('/')) || '/';
  }, [trustedPath]);
  const downloadName = safeImagePreviewName({ name: item.name, path: item.path });
  const mime = (item.mime ?? '').toLowerCase();
  const html = isAttachmentHtml(mime, name);
  const markdown = !html && isAttachmentMarkdown(mime, name);
  const documentPreview = !html && !markdown && isAttachmentDocument(mime, name) && item.fileId !== undefined && sessionId !== undefined;
  const textPreview = !html && !documentPreview && (markdown || isAttachmentTextPreview(mime, name));
  const viewable =
    html ||
    documentPreview ||
    textPreview ||
    item.kind !== 'file' ||
    /^(?:image|video|audio)\//iu.test(mime);

  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');
  const [attempt, setAttempt] = useState(0);
  const [htmlPreviewState, setHtmlPreviewState] = useState<HtmlPreviewState>({ status: 'idle' });
  const [docReadStatus, setDocReadStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [moreAnchor, setMoreAnchor] = useState<{ x: number; y: number } | null>(null);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canonicalItem = useMemo<MediaRef>(
    () => (item.fileId !== undefined ? { ...item, path: undefined } : item),
    [item],
  );
  const playback = useSessionMediaPlayback(canonicalItem, sessionId, client, remoteScope, attempt);
  const shouldLoadBytes =
    viewable &&
    !documentPreview &&
    playback.status === 'fallback' &&
    (!html || mode === 'source' || htmlPreviewState.status === 'error');
  const load = useSessionMedia(canonicalItem, sessionId, shouldLoadBytes, false, attempt);
  const { panelRef, onReadingReady } = usePreviewReadingScroll(visible, position, onScrollPosition);

  const readState = useMemo<PreviewReadState>(() => {
    let status: 'loading' | 'ready' | 'failed';
    if (documentPreview) {
      status = docReadStatus;
    } else if (!viewable) {
      status = 'ready';
    } else if (html && mode === 'rendered') {
      if (htmlPreviewState.status === 'ready') status = 'ready';
      else if (htmlPreviewState.status === 'error') {
        status = load.status === 'failed' ? 'failed' : load.status === 'ready' ? 'ready' : 'loading';
      } else {
        status = 'loading';
      }
    } else if (playback.status === 'ready') {
      status = 'ready';
    } else if (playback.status === 'failed' || load.status === 'failed') {
      status = 'failed';
    } else if (load.status === 'ready') {
      status = 'ready';
    } else {
      status = 'loading';
    }
    return {
      status,
      readableFromDevice: status !== 'failed',
      originalReadable: trustedPath !== undefined && status !== 'failed',
    };
  }, [documentPreview, docReadStatus, viewable, html, mode, htmlPreviewState.status, playback.status, load.status, trustedPath]);

  useEffect(() => {
    onReadStateChange?.(readState);
  }, [readState, onReadStateChange]);

  const actions = useMemo(
    () => resourceActions(resource, environment, readState),
    [resource, environment, readState],
  );
  const actionIds = useMemo<ReadonlySet<ResourceActionId>>(
    () => new Set(actions.map((action) => action.id)),
    [actions],
  );

  useEffect(() => {
    if (load.status === 'ready' || htmlPreviewState.status === 'ready') onReadingReady();
  }, [load.status, htmlPreviewState.status, mode, onReadingReady]);

  useEffect(() => {
    if (!html) {
      setHtmlPreviewState({ status: 'idle' });
      return undefined;
    }
    if (client === undefined) {
      setHtmlPreviewState({ status: 'loading' });
      return undefined;
    }
    let cancelled = false;
    let activePreviewId: string | null = null;
    setHtmlPreviewState({ status: 'loading' });
    const openHtml = async () => {
      if (item.fileId !== undefined && sessionId !== undefined) {
        return await client.openHtmlPreview({
          session_id: sessionId,
          file_id: item.fileId,
          source_id: item.sourceId,
          name,
        });
      }
      const hostPath = !remoteScope && item.path !== undefined ? resolveHostPath(item.path, workspaceRoot) : undefined;
      if (hostPath !== undefined) {
        return await client.openHtmlPreview({ path: hostPath, workspace_root: workspaceRoot });
      }
      throw new Error('html_preview_unavailable');
    };
    openHtml().then(
      (response) => {
        if (cancelled) {
          void client.closeHtmlPreview(response.preview_id);
          return;
        }
        activePreviewId = response.preview_id;
        const resolvedUrl = new URL(response.url, client.baseUrl).toString();
        setHtmlPreviewState({
          status: 'ready',
          previewId: response.preview_id,
          url: resolvedUrl,
          sandbox: response.sandbox,
          expiresAt: response.expires_at,
        });
        const ttl = Math.max(0, response.expires_at - Date.now());
        if (expiryTimerRef.current !== null) clearTimeout(expiryTimerRef.current);
        expiryTimerRef.current = setTimeout(() => {
          if (!cancelled) setHtmlPreviewState({ status: 'error', error: new Error('html_preview_expired') });
        }, ttl);
      },
      (error: unknown) => {
        if (!cancelled) setHtmlPreviewState({ status: 'error', error });
      },
    );
    return () => {
      cancelled = true;
      if (expiryTimerRef.current !== null) {
        clearTimeout(expiryTimerRef.current);
        expiryTimerRef.current = null;
      }
      if (activePreviewId !== null) {
        void client.closeHtmlPreview(activePreviewId);
        activePreviewId = null;
      }
    };
  }, [client, html, item.path, item.fileId, item.sourceId, sessionId, workspaceRoot, remoteScope, name, attempt]);

  const downloadAttachment = useCallback(async () => {
    try {
      await saveMediaToDisk(
        {
          url: item.url ?? (load.status === 'ready' ? load.url : undefined),
          path: item.fileId !== undefined ? undefined : item.path,
          fileId: item.fileId,
        },
        downloadName ?? name,
        host,
        client as Parameters<typeof saveMediaToDisk>[3],
        sessionId,
      );
    } catch (error) {
      pushToast({ tone: 'error', text: imageDownloadFailureText(error, t), detail: errorToText(error) });
    }
  }, [item.url, item.path, item.fileId, load, downloadName, host, client, sessionId, t]);

  const decodedText = useMemo(
    () => (load.status === 'ready' && (textPreview || html) ? new TextDecoder().decode(load.bytes) : undefined),
    [load, textPreview, html],
  );

  const moreEntries = useMemo<readonly MiniMenuEntry[]>(() => {
    const list: MiniMenuEntry[] = [];
    for (const action of actions) {
      if (action.id === 'add-to-chat' && sessionId !== undefined && trustedPath !== undefined) {
        list.push({
          key: 'add-to-chat',
          label: t('preview.addToChat'),
          run: () => { appendToDraft(sessionId, mentionTokenFor(trustedPath, workspaceRoot)); },
        });
      } else if (action.id === 'copy-content' && decodedText !== undefined) {
        list.push({
          key: 'copy-content',
          label: t('preview.copyContent'),
          run: () => copyTextToClipboard(decodedText),
        });
      } else if (action.id === 'copy-path' && trustedPath !== undefined) {
        const relativePath = relativeToCwd(trustedPath, workspaceRoot);
        if (relativePath !== trustedPath) {
          list.push({
            key: 'copy-relative',
            label: t('file.copyRelativePath'),
            run: () => copyTextToClipboard(relativePath),
          });
        }
        list.push({
          key: 'copy-absolute',
          label: t('file.copyPath'),
          run: () => copyTextToClipboard(trustedPath),
        });
      } else if (action.id === 'show-on-this-computer' && trustedPath !== undefined && host.revealPath !== undefined) {
        list.push({
          key: 'show-in-folder',
          label: isCopy ? t('preview.showOnThisComputer') : t('file.showInFolder'),
          run: () => { runToastAction(t('preview.showOnThisComputer'), () => host.revealPath!(trustedPath)); },
        });
      } else if (action.id === 'open-with-default-app' && trustedPath !== undefined && host.openPath !== undefined) {
        list.push({
          key: 'open-default-app',
          label: isCopy ? t('preview.openOriginalFile') : t('file.openDefaultApp'),
          run: () => {
            runToastAction(
              isCopy ? t('preview.openOriginalFile') : t('file.openDefaultApp'),
              () => host.openPath!(trustedPath),
            );
          },
        });
      }
    }
    return list;
  }, [actions, sessionId, trustedPath, workspaceRoot, decodedText, host, isCopy, t]);

  const hasRenderedToggle = html || markdown;
  const sizeBytes = load.status === 'ready' ? load.bytes.byteLength : item.size;
  const canOpenCurrent = actionIds.has('open-current-file') && trustedPath !== undefined && onOpenCurrentFile !== undefined;
  const canDownload = actionIds.has('download');

  const copyNoticeNode = isCopy ? (
    <span className="shrink-0 text-[11px] text-ink-faint" data-preview-copy-notice>
      {t('preview.sentCopyNotice')}
    </span>
  ) : null;

  const openCurrentButton = canOpenCurrent ? (
    <button
      type="button"
      data-open-current-file
      onClick={() => { onOpenCurrentFile(trustedPath); }}
      className={HEADER_ACTION_CLASS}
    >
      {t('preview.openCurrentFile')}
    </button>
  ) : null;

  const moreButton = moreEntries.length > 0 ? (
    <button
      type="button"
      title={t('preview.moreActions')}
      aria-label={t('preview.moreActions')}
      data-attachment-more
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setMoreAnchor({ x: rect.right, y: rect.bottom + 4 });
      }}
      className={HEADER_ACTION_CLASS}
    >
      <Icon name="more" size={12} />
    </button>
  ) : null;

  return (
    <div
      ref={panelRef}
      role="tabpanel"
      hidden={!visible}
      className={`min-h-0 flex-1 flex-col ${visible ? 'flex' : 'hidden'}`}
      data-preview-tabpanel={tabKey}
      data-attachment-preview
    >
      {documentPreview ? (
        <DocumentTabView
          source={{
            kind: 'session-media',
            fileId: item.fileId!,
            name,
            mediaType: item.mime,
          }}
          sessionId={sessionId}
          client={client}
          active={visible}
          headerSubtitle={
            isCopy ? (
              <span className="block truncate text-[10.5px] text-ink-faint" data-preview-copy-notice>
                {t('preview.sentCopyNotice')}
              </span>
            ) : undefined
          }
          headerActions={
            openCurrentButton !== null || moreButton !== null ? (
              <>
                {openCurrentButton}
                {moreButton}
              </>
            ) : undefined
          }
          onReadStateChange={setDocReadStatus}
          onOpenLocally={
            actionIds.has('open-with-default-app') && trustedPath !== undefined && host.openPath !== undefined
              ? () => {
                  runToastAction(
                    isCopy ? t('preview.openOriginalFile') : t('file.openDefaultApp'),
                    () => host.openPath!(trustedPath),
                  );
                }
              : undefined
          }
          onDownload={canDownload ? () => { void downloadAttachment(); } : undefined}
        />
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 truncate font-mono text-[11px] text-ink-faint" title={trustedPath ?? item.path ?? name}>
                {name}
              </span>
              {copyNoticeNode}
            </div>
            {sizeBytes !== undefined ? (
              <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                {formatBytes(sizeBytes)}
              </span>
            ) : null}
            {openCurrentButton}
            {hasRenderedToggle && actionIds.has('rendered-source') ? (
              <span className="flex shrink-0 items-center gap-0.5 rounded-md bg-ink/[0.05] p-0.5 text-[11px]">
                {(['rendered', 'source'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    data-preview-mode={option}
                    data-md-mode={markdown ? option : undefined}
                    data-html-mode={html ? option : undefined}
                    aria-pressed={mode === option}
                    onClick={() => { setMode(option); }}
                    className={`rounded-[5px] px-2 py-0.5 transition-colors duration-[var(--kiki-motion-quick)] ${
                      mode === option
                        ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                        : 'text-ink-faint hover:text-ink-soft'
                    }`}
                  >
                    {option === 'rendered' ? t('preview.rendered') : t('preview.source')}
                  </button>
                ))}
              </span>
            ) : null}
            {canDownload ? (
              <button
                type="button"
                title={t('media.download')}
                aria-label={t('media.download')}
                data-download-file
                onClick={() => { void downloadAttachment(); }}
                className={HEADER_ACTION_CLASS}
              >
                <Icon name="arrowDown" size={12} />
              </button>
            ) : null}
            {moreButton}
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {html && mode === 'rendered' ? (
              htmlPreviewState.status === 'ready' ? (
                <SandboxedHtmlPreview url={htmlPreviewState.url} sandbox={htmlPreviewState.sandbox} title={name} />
              ) : htmlPreviewState.status === 'loading' ? (
                <p className="flex items-center gap-2 p-3 text-[12px] text-ink-faint">
                  <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
                  {t('preview.loading')}
                </p>
              ) : htmlPreviewState.status === 'error' ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-html-preview-error={classifyHtmlPreviewError(htmlPreviewState.error)}>
                  <p className="max-w-md text-[13px] text-danger" role="alert">{t('preview.failed')}</p>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      data-html-reload
                      onClick={() => { setAttempt((value) => value + 1); }}
                      className="rounded-full bg-accent px-3 py-1 text-[12px] font-medium text-white shadow-sm transition-opacity hover:opacity-90"
                    >
                      {t('preview.htmlReload')}
                    </button>
                    <button
                      type="button"
                      data-html-view-source
                      onClick={() => { setMode('source'); }}
                      className="rounded-full border border-hairline px-3 py-1 text-[12px] text-ink-soft hover:border-hairline-strong hover:text-ink"
                    >
                      {t('preview.source')}
                    </button>
                  </div>
                </div>
              ) : null
            ) : !viewable ? (
              <div className="flex flex-1 flex-col items-start gap-3 p-4" data-preview-unsupported data-preview-read-state="unsupported">
                <p className="text-[13px] text-ink-soft">{t('preview.readUnsupported')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-download-file
                    onClick={() => { void downloadAttachment(); }}
                    className={INK_BUTTON_CLASS}
                  >
                    {t('media.download')}
                  </button>
                  {actionIds.has('open-with-default-app') && trustedPath !== undefined && host.openPath !== undefined ? (
                    <button
                      type="button"
                      data-open-default-app
                      onClick={() => {
                        runToastAction(
                          isCopy ? t('preview.openOriginalFile') : t('file.openDefaultApp'),
                          () => host.openPath!(trustedPath),
                        );
                      }}
                      className={BODY_ACTION_CLASS}
                    >
                      {isCopy ? t('preview.openOriginalFile') : t('file.open')}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : playback.status === 'ready' ? (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
                {playback.mime.startsWith('video/') ? (
                  <video src={playback.url} controls playsInline onError={playback.fail} data-preview-video className="max-h-full max-w-full" />
                ) : (
                  <audio src={playback.url} controls onError={playback.fail} data-preview-audio className="w-full max-w-2xl" />
                )}
              </div>
            ) : playback.status === 'failed' ? (
              <div className="flex min-h-0 flex-1 items-center justify-center p-4" data-preview-attachment-error>
                <MediaLoadFailure name={name} decode={false} onRetry={() => { setAttempt((value) => value + 1); }} />
              </div>
            ) : load.status === 'loading' ? (
              <DelayedReadingNotice active />
            ) : load.status === 'failed' ? (
              <div className="flex min-h-0 flex-1 items-center justify-center p-4" data-preview-attachment-error>
                <MediaLoadFailure name={name} decode={false} onRetry={() => { setAttempt((value) => value + 1); }} />
              </div>
            ) : load.mime.startsWith('image/') ? (
              <ImageViewport
                src={load.url}
                alt={name}
                caption={<span title={trustedPath ?? name}>{name}</span>}
                meta={formatBytes(load.bytes.byteLength)}
                actions={
                  <button
                    type="button"
                    onClick={() => { onOpenImage(load.url, name, trustedPath); }}
                    title={t('media.viewImage')}
                    aria-label={t('media.viewImage')}
                    className={CAPTION_ACTION_CLASS}
                  >
                    <Icon name="eye" size={14} />
                  </button>
                }
              />
            ) : load.mime.startsWith('video/') ? (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
                <video src={load.url} controls playsInline data-preview-video className="max-h-full max-w-full" />
              </div>
            ) : load.mime.startsWith('audio/') ? (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
                <audio src={load.url} controls data-preview-audio className="w-full max-w-2xl" />
              </div>
            ) : textPreview || html ? (
              (() => {
                const text = decodedText ?? new TextDecoder().decode(load.bytes);
                if (markdown && mode === 'rendered') {
                  return (
                    <div data-preview-scroll className="min-h-0 flex-1 overflow-auto p-4">
                      <Markdown
                        mode="static"
                        text={text}
                        documentDirectory={trustedDirectory}
                        documentPath={trustedPath}
                      />
                    </div>
                  );
                }
                return (
                  <div className="min-h-0 flex-1 flex-col flex">
                    <CodeEditor
                      key={`${name}:${attempt}`}
                      path={name}
                      value={text}
                      generation={attempt}
                      readOnly
                      onChange={() => {}}
                      ariaLabel={t('preview.openFile', { name })}
                    />
                  </div>
                );
              })()
            ) : (
              <div className="flex flex-1 flex-col items-start gap-3 p-4" data-preview-unsupported data-preview-read-state="unsupported">
                <p className="text-[13px] text-ink-soft">{t('preview.readUnsupported')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-download-file
                    onClick={() => { void downloadAttachment(); }}
                    className={INK_BUTTON_CLASS}
                  >
                    {t('media.download')}
                  </button>
                  {actionIds.has('open-with-default-app') && trustedPath !== undefined && host.openPath !== undefined ? (
                    <button
                      type="button"
                      data-open-default-app
                      onClick={() => {
                        runToastAction(
                          isCopy ? t('preview.openOriginalFile') : t('file.openDefaultApp'),
                          () => host.openPath!(trustedPath),
                        );
                      }}
                      className={BODY_ACTION_CLASS}
                    >
                      {isCopy ? t('preview.openOriginalFile') : t('file.open')}
                    </button>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </>
      )}
      {moreAnchor !== null && moreEntries.length > 0 ? (
        <MiniContextMenu
          x={moreAnchor.x}
          y={moreAnchor.y}
          entries={moreEntries}
          onClose={() => { setMoreAnchor(null); }}
          ariaLabel={t('preview.moreActions')}
          overlayId="preview-attachment-more-menu"
          dataAttribute="data-attachment-more-menu"
        />
      ) : null}
    </div>
  );
}
