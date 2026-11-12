/**
 * Shared styling tokens, path/mention formatters, host openers, read-state
 * views, scroll restoration, and HTML sandbox helpers for the preview renderers.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { mentionToken } from '@kiki/session-core/composer';
import { basenameOf, resolveHostPath, type FileReference, type MediaRef } from '@kiki/session-core/composer/media';
import type { SessionViewState } from '@kiki/session-core/session';
import { errorToText } from '@kiki/session-core/util';
import { useHost, type HostAdapter } from '#/host';
import { useI18n } from '#/i18n';
import { copyTextToClipboard } from '#/lib/clipboard';
import type { KikiClient } from '#/lib/client';
import { usePhoneMode } from '#/lib/layoutHooks';
import { pushToast, runToastAction } from '#/lib/toasts';
import { useNavVisitId } from '#/lib/useNavSnapshot';
import { useOptionalConnection } from '#/state/connection';
import type { HostFileReadResult } from '#/state/hostFileEditor';
import {
  classifyResource,
  isKikiComputer,
  normalizeHostFilePath,
  type PreviewEnvironment,
  type PreviewReadFailureReason,
  type PreviewResource,
} from '#/state/previewResource';
import { mediaRefResource } from '#/state/previewWorkspace';
import { imageDownloadFailureText, saveMediaToDisk } from '../imageActions';
import { attachmentName } from '../mediaParts';
import { useMediaPreview } from '../mediaPreviewContext';

const MIN_WIDTH = 320;
export const MAX_PREVIEW_WIDTH = 760;

export function clampPreviewWidth(width: number, viewport: number): number {
  return Math.max(MIN_WIDTH, Math.min(width, Math.min(MAX_PREVIEW_WIDTH, Math.floor(viewport * 0.6))));
}

/**
 * Path relative to the session cwd (posix-style, case-insensitive prefix
 * match for Windows drives); falls back to the untouched absolute path when
 * the file lives outside the workspace.
 */
export function relativeToCwd(path: string, cwd: string | undefined): string {
  if (cwd === undefined) return path;
  const normPath = resolveHostPath(path).replaceAll('\\', '/');
  const normCwd = resolveHostPath(cwd).replaceAll('\\', '/').replace(/\/+$/, '');
  const prefix = `${normCwd}/`;
  if (normPath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normPath.slice(prefix.length);
  }
  return path;
}

export const SESSION_FS_READ_TEXT_BYTES = 512_000;
export const SESSION_FS_READ_MAX_BYTES = 10_485_760;

export interface SessionWorkspaceReadScope {
  readonly sessionId?: string;
  readonly workspaceRoot?: string;
  readonly localKikiComputer?: boolean;
}

/**
 * Strictly convert a path to a workspace-relative POSIX path without `..`
 * segments, suitable for `POST /sessions/{id}/fs:read`. Returns `undefined`
 * when `cwd` is absent or the target lives outside the session's working
 * directory.
 */
export function toWorkspaceRelativePath(path: string, cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd.trim() === '') return undefined;
  const normCwd = normalizeHostFilePath(cwd);
  const normPath = normalizeHostFilePath(path, cwd);
  const caseInsensitive = /^[A-Za-z]:\//u.test(normCwd) || normCwd.startsWith('//');
  const trimmedCwd = normCwd.replace(/\/+$/u, '');
  const cmpCwd = caseInsensitive ? trimmedCwd.toLowerCase() : trimmedCwd;
  const cmpPath = caseInsensitive ? normPath.toLowerCase() : normPath;
  if (cmpPath === cmpCwd) return '.';
  const prefix = cmpCwd === '' ? '/' : `${cmpCwd}/`;
  if (!cmpPath.startsWith(prefix)) return undefined;
  const rel = normPath.slice(prefix.length);
  if (rel === '' || rel.startsWith('/')) return undefined;
  const segments = rel.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined;
  }
  return rel;
}

export function isRemoteUnavailableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { readonly msg?: unknown; readonly message?: unknown };
  const message =
    typeof record.msg === 'string'
      ? record.msg
      : typeof record.message === 'string'
        ? record.message
        : '';
  return (
    message === 'local_owner_required' ||
    message.includes('local_owner_required') ||
    message.includes('Operation is not available to a remote space')
  );
}

function makeRemoteUnreadableError(): Error & { readonly msg: string } {
  return Object.assign(new Error('local_owner_required'), { msg: 'local_owner_required' });
}

function makeFsTooLargeError(): Error & { readonly code: number; readonly msg: string } {
  return Object.assign(new Error('file too large'), { code: 41302, msg: 'fs.too_large' });
}

function decodeBase64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

export async function readWorkspaceTextViaSession(
  client: KikiClient,
  sessionId: string,
  path: string,
  workspaceRoot: string | undefined,
  options?: { readonly ifNoneMatch?: string; readonly length?: number; readonly signal?: AbortSignal },
): Promise<HostFileReadResult> {
  const relPath = toWorkspaceRelativePath(path, workspaceRoot);
  if (relPath === undefined) throw makeRemoteUnreadableError();
  const res = await client.fsRead(
    sessionId,
    {
      path: relPath,
      encoding: 'auto',
      length: options?.length ?? SESSION_FS_READ_TEXT_BYTES,
    },
    { signal: options?.signal },
  );
  if (options?.ifNoneMatch !== undefined && res.etag === options.ifNoneMatch) {
    return {
      text: '',
      truncated: res.truncated,
      lossless: !res.is_binary,
      etag: res.etag,
      notModified: true,
    };
  }
  if (res.encoding === 'utf-8') {
    return {
      text: res.content,
      truncated: res.truncated,
      lossless: !res.is_binary && !res.content.includes('\uFFFD'),
      etag: res.etag,
    };
  }
  const bytes = decodeBase64ToBytes(res.content);
  try {
    const decoded = fatalUtf8Decoder.decode(bytes);
    return {
      text: decoded,
      truncated: res.truncated,
      lossless: !res.is_binary,
      etag: res.etag,
    };
  } catch {
    return {
      text: new TextDecoder('utf-8').decode(bytes),
      truncated: res.truncated,
      lossless: false,
      etag: res.etag,
    };
  }
}

export async function readWorkspaceBytesViaSession(
  client: KikiClient,
  sessionId: string,
  path: string,
  workspaceRoot: string | undefined,
  options?: { readonly ifNoneMatch?: string; readonly signal?: AbortSignal },
): Promise<{
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly etag: string;
  readonly notModified?: boolean;
}> {
  const relPath = toWorkspaceRelativePath(path, workspaceRoot);
  if (relPath === undefined) throw makeRemoteUnreadableError();
  const res = await client.fsRead(
    sessionId,
    {
      path: relPath,
      encoding: 'base64',
      length: SESSION_FS_READ_MAX_BYTES,
    },
    { signal: options?.signal },
  );
  if (res.truncated) throw makeFsTooLargeError();
  if (options?.ifNoneMatch !== undefined && res.etag === options.ifNoneMatch) {
    return {
      bytes: new Uint8Array(),
      mime: res.mime,
      etag: res.etag,
      notModified: true,
    };
  }
  const bytes =
    res.encoding === 'base64'
      ? decodeBase64ToBytes(res.content)
      : new TextEncoder().encode(res.content);
  return {
    bytes,
    mime: res.mime,
    etag: res.etag,
  };
}

/**
 * Composer `@`-token for a previewed file — delegates whitespace quoting to
 * the shared mention formatter so spaced paths arrive as `@"…"`, exactly the
 * shape the TUI's mention autocomplete produces.
 */
export function mentionTokenFor(path: string, cwd: string | undefined): string {
  return mentionToken({
    kind: 'file',
    path: relativeToCwd(path, cwd),
    name: basenameOf(path),
    isDir: false,
  });
}

export function isLocalKikiComputer(connection: ReturnType<typeof useOptionalConnection>): boolean {
  const pageUrl = typeof window !== 'undefined' ? window.location.href : undefined;
  return isKikiComputer(connection, { pageUrl });
}

export function usePreviewEnvironment(sessionId: string | undefined): PreviewEnvironment {
  const host = useHost();
  const connection = useOptionalConnection();
  const phoneForm = usePhoneMode();
  return useMemo<PreviewEnvironment>(
    () => ({
      isKikiComputer: isLocalKikiComputer(connection),
      hasSession: sessionId !== undefined,
      phoneForm,
      capabilities: {
        reveal: host.revealPath !== undefined,
        open: host.openPath !== undefined,
        write: host.writeFileText !== undefined,
        saveDialog: host.saveBlob !== undefined,
      },
    }),
    [connection, host.openPath, host.revealPath, host.saveBlob, host.writeFileText, phoneForm, sessionId],
  );
}

export function buildFileTabResource(
  path: string,
  cwd: string | undefined,
  losslessUtf8?: boolean,
): PreviewResource {
  const resolved = resolveHostPath(path, cwd);
  const name = basenameOf(resolved);
  const head =
    losslessUtf8 === undefined
      ? undefined
      : losslessUtf8
        ? new Uint8Array([0x61])
        : new Uint8Array([0xff]);
  return {
    source: { kind: 'host-file', path: resolved },
    origin: { path: resolved, trusted: true },
    type: classifyResource({ name, head }),
    name,
  };
}

export function buildAttachmentTabResource(
  item: MediaRef,
  sessionId: string | undefined,
  tabOrigin: { readonly path: string; readonly trusted: true } | undefined,
  cwd: string | undefined,
  fallbackName: string,
): PreviewResource {
  return mediaRefResource(item, {
    sessionId,
    origin: tabOrigin,
    cwd,
    name: attachmentName(item, undefined, fallbackName),
  });
}

export function webUrlDisplayLabel(url: string, title?: string): string {
  if (title !== undefined && title.trim() !== '') return title.trim();
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./iu, '') || url;
  } catch {
    return url;
  }
}

export async function readPreviewFileText(
  client: KikiClient,
  path: string,
  scope: SessionWorkspaceReadScope,
  options?: { readonly ifNoneMatch?: string; readonly maxBytes?: number; readonly signal?: AbortSignal },
): Promise<HostFileReadResult> {
  const canUseSessionFs =
    scope.sessionId !== undefined && typeof (client as { fsRead?: unknown }).fsRead === 'function';
  if (scope.localKikiComputer === false && canUseSessionFs) {
    return readWorkspaceTextViaSession(client, scope.sessionId!, path, scope.workspaceRoot, {
      ifNoneMatch: options?.ifNoneMatch,
      length: options?.maxBytes ?? SESSION_FS_READ_TEXT_BYTES,
      signal: options?.signal,
    });
  }
  try {
    return await (options === undefined
      ? client.previewHostFile(path)
      : client.previewHostFile(path, options.maxBytes, {
          ifNoneMatch: options.ifNoneMatch,
          signal: options.signal,
        }));
  } catch (error) {
    if (canUseSessionFs && isRemoteUnavailableError(error)) {
      return readWorkspaceTextViaSession(client, scope.sessionId!, path, scope.workspaceRoot, {
        ifNoneMatch: options?.ifNoneMatch,
        length: options?.maxBytes ?? SESSION_FS_READ_TEXT_BYTES,
        signal: options?.signal,
      });
    }
    throw error;
  }
}

export async function readPreviewFileBytes(
  client: KikiClient,
  path: string,
  scope: SessionWorkspaceReadScope,
  options?: { readonly ifNoneMatch?: string; readonly signal?: AbortSignal },
): Promise<{
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly etag?: string;
  readonly notModified?: boolean;
}> {
  const canUseSessionFs =
    scope.sessionId !== undefined && typeof (client as { fsRead?: unknown }).fsRead === 'function';
  if (scope.localKikiComputer === false && canUseSessionFs) {
    return readWorkspaceBytesViaSession(client, scope.sessionId!, path, scope.workspaceRoot, options);
  }
  try {
    return await client.readHostFileBytes(path, options);
  } catch (error) {
    if (canUseSessionFs && isRemoteUnavailableError(error)) {
      return readWorkspaceBytesViaSession(client, scope.sessionId!, path, scope.workspaceRoot, options);
    }
    throw error;
  }
}

async function saveBytesAsFile(host: HostAdapter, bytes: Uint8Array, mime: string, name: string): Promise<void> {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  if (host.saveBlob !== undefined) {
    try {
      await host.saveBlob(blob, name);
      return;
    } catch {
      // Fall through to the browser download.
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function downloadHostFile(
  host: HostAdapter,
  client: KikiClient,
  path: string,
  name: string,
  translateError?: Parameters<typeof imageDownloadFailureText>[1],
  scope?: SessionWorkspaceReadScope,
): Promise<void> {
  const canUseSessionFs =
    scope?.sessionId !== undefined && typeof (client as { fsRead?: unknown }).fsRead === 'function';
  if (scope?.localKikiComputer === false && canUseSessionFs) {
    try {
      const { bytes, mime } = await readWorkspaceBytesViaSession(
        client,
        scope.sessionId!,
        path,
        scope.workspaceRoot,
      );
      await saveBytesAsFile(host, bytes, mime, name);
    } catch (error) {
      if (translateError !== undefined) {
        pushToast({
          tone: 'error',
          text: imageDownloadFailureText(error, translateError),
          detail: errorToText(error),
        });
      }
    }
    return;
  }
  if (typeof (client as { downloadHostFile?: unknown }).downloadHostFile === 'function') {
    try {
      await saveMediaToDisk(
        { path },
        name,
        host,
        client as Parameters<typeof saveMediaToDisk>[3],
        undefined,
      );
      return;
    } catch (error) {
      if (canUseSessionFs && isRemoteUnavailableError(error)) {
        try {
          const { bytes, mime } = await readWorkspaceBytesViaSession(
            client,
            scope!.sessionId!,
            path,
            scope?.workspaceRoot,
          );
          await saveBytesAsFile(host, bytes, mime, name);
          return;
        } catch (fallbackError) {
          if (translateError !== undefined) {
            pushToast({
              tone: 'error',
              text: imageDownloadFailureText(fallbackError, translateError),
              detail: errorToText(fallbackError),
            });
          }
          return;
        }
      }
      if (translateError !== undefined) {
        pushToast({
          tone: 'error',
          text: imageDownloadFailureText(error, translateError),
          detail: errorToText(error),
        });
      }
      return;
    }
  }
  try {
    const { bytes, mime } = await readPreviewFileBytes(client, path, scope ?? {});
    await saveBytesAsFile(host, bytes, mime, name);
  } catch (error) {
    if (translateError !== undefined) {
      pushToast({
        tone: 'error',
        text: imageDownloadFailureText(error, translateError),
        detail: errorToText(error),
      });
    }
  }
}

/**
 * Desktop openers (reveal in the file manager / open with the default app),
 * gated by `isKikiComputer` and the host's individual opener capabilities.
 * Failures surface as toasts, same as the menu items.
 */
export function useFileOpeners(): {
  readonly reveal?: (path: string) => void;
  readonly open?: (path: string) => void;
} | null {
  const host = useHost();
  const { t } = useI18n();
  const preview = useMediaPreview();
  const connection = useOptionalConnection();
  const localComputer = isLocalKikiComputer(connection);
  const { revealPath, openPath } = host;
  const cwd = preview?.cwd;
  return useMemo(() => {
    if (!localComputer || (revealPath === undefined && openPath === undefined)) return null;
    return {
      reveal:
        revealPath === undefined
          ? undefined
          : (path: string) => {
              runToastAction(t('file.showInFolder'), () => revealPath(resolveHostPath(path, cwd)));
            },
      open:
        openPath === undefined
          ? undefined
          : (path: string) => {
              runToastAction(t('file.openDefaultApp'), () => openPath(resolveHostPath(path, cwd)));
            },
    };
  }, [cwd, localComputer, revealPath, openPath, t]);
}

// The text/video header pill idiom, shared by the download anchor and its
// opener siblings so the trio reads as one family.
export const HEADER_ACTION_CLASS =
  'shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[11px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';

// A quiet top-bar icon (binary tab's caption strip), matching the workspace's
// borderless chrome buttons.
export const CAPTION_ACTION_CLASS =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';

// Secondary body button beside the neutral ink download.
export const BODY_ACTION_CLASS =
  'rounded-lg border border-hairline px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';

// Neutral ink primary button (used for unsupported/damaged download instead of vermilion accent).
export const INK_BUTTON_CLASS =
  'rounded-lg border border-ink bg-ink px-3 py-1.5 text-[12px] font-medium text-paper transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';

export function TabPathCaption({ path }: { readonly path: string }) {
  return (
    <p className="truncate border-b border-hairline px-3 py-1.5 font-mono text-[11px] text-ink-faint" title={path}>
      {path}
    </p>
  );
}

/** Shows `正在读取…` / `Reading…` only after 300 ms so fast reads never flash. */
export function DelayedReadingNotice({
  active,
  delayMs = 300,
}: {
  readonly active: boolean;
  readonly delayMs?: number;
}) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      setShown(true);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [active, delayMs]);
  if (!active || !shown) return null;
  return (
    <p className="flex items-center gap-2 p-4 text-[12px] text-ink-faint" data-preview-reading>
      <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
      {t('preview.reading')}
    </p>
  );
}

/** Plain-language read failure view with the exact recovery offers from #32. */
export function PreviewReadFailureView({
  reason,
  path,
  onReload,
  onCloseTab,
  onDownload,
}: {
  readonly reason: PreviewReadFailureReason;
  readonly path?: string;
  readonly onReload?: () => void;
  readonly onCloseTab?: () => void;
  readonly onDownload?: () => void;
}) {
  const { t } = useI18n();
  const openers = useFileOpeners();
  const message =
    reason === 'missing'
      ? t('preview.readMissing')
      : reason === 'permission-denied'
        ? t('preview.readPermissionDenied')
        : reason === 'folder'
          ? t('preview.readIsFolder')
          : reason === 'remote-unreadable'
            ? t('preview.readRemoteUnreadable')
            : reason === 'too-large'
              ? t('preview.readFileTooLarge')
              : reason === 'unsupported'
                ? t('preview.readUnsupported')
                : reason === 'corrupted'
                  ? t('preview.readCannotDecode')
                  : t('preview.failed');

  return (
    <div
      className="flex flex-1 flex-col items-start gap-3 p-4"
      data-preview-read-state={reason}
      data-preview-unsupported={reason === 'unsupported' ? '' : undefined}
    >
      <div className="flex flex-col gap-1">
        <p className="text-[13px] text-ink-soft" role="alert">
          {message}
        </p>
        {reason === 'missing' && path !== undefined ? (
          <p className="break-all font-mono text-[11px] text-ink-faint">{path}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(reason === 'missing' || reason === 'permission-denied' || reason === 'error') && onReload !== undefined ? (
          <button
            type="button"
            data-preview-reload
            onClick={onReload}
            className={BODY_ACTION_CLASS}
          >
            {t('preview.reloadFile')}
          </button>
        ) : null}
        {reason === 'missing' && onCloseTab !== undefined ? (
          <button
            type="button"
            data-preview-close-missing
            onClick={onCloseTab}
            className={BODY_ACTION_CLASS}
          >
            {t('preview.closeTab')}
          </button>
        ) : null}
        {reason === 'folder' && path !== undefined && openers?.reveal !== undefined ? (
          <button
            type="button"
            data-reveal-file
            onClick={() => { openers.reveal!(path); }}
            className={BODY_ACTION_CLASS}
          >
            {t('preview.showOnThisComputer')}
          </button>
        ) : null}
        {(reason === 'remote-unreadable' || reason === 'too-large') && path !== undefined ? (
          <button
            type="button"
            data-copy-path
            onClick={() => { void copyTextToClipboard(path); }}
            className={BODY_ACTION_CLASS}
          >
            {t('file.copyPath')}
          </button>
        ) : null}
        {(reason === 'unsupported' || reason === 'corrupted') && onDownload !== undefined ? (
          <button
            type="button"
            data-download-file
            onClick={onDownload}
            className={INK_BUTTON_CLASS}
          >
            {t('media.download')}
          </button>
        ) : null}
        {reason === 'unsupported' && path !== undefined && openers?.open !== undefined ? (
          <button
            type="button"
            title={t('file.openDefaultApp')}
            data-open-default-app
            onClick={() => { openers.open!(path); }}
            className={BODY_ACTION_CLASS}
          >
            {t('file.open')}
          </button>
        ) : null}
        {reason === 'unsupported' && path !== undefined && openers?.reveal !== undefined ? (
          <button
            type="button"
            data-reveal-file
            onClick={() => { openers.reveal!(path); }}
            className={BODY_ACTION_CLASS}
          >
            {t('file.showInFolder')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Notice strip shown when a clean live file's ETag changed on disk. */
export function ChangedOnDiskStrip({ onReload }: { readonly onReload: () => void }) {
  const { t } = useI18n();
  return (
    <div
      data-changed-on-disk
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-rule/40 bg-amber-card px-3 py-1.5 text-[11px] text-amber-ink"
    >
      <span className="min-w-0 flex-1">{t('preview.readChangedOnDisk')}</span>
      <button
        type="button"
        data-changed-reload
        onClick={onReload}
        className="rounded-full border border-amber-rule/60 px-2.5 py-0.5 font-medium transition-colors hover:bg-amber-rule/20"
      >
        {t('preview.reloadFile')}
      </button>
    </div>
  );
}

function canonicalComparablePath(path: string, cwd: string | undefined): string {
  const normalized = normalizeHostFilePath(path, cwd);
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

/**
 * Counts completed file-writing tool blocks per canonical host path so open
 * tabs can run a bounded conditional ETag check when an agent finishes writing
 * their file.
 */
export function computeFileWriteCounts(
  blocks: SessionViewState['blocks'] | undefined,
  cwd: string | undefined,
): Readonly<Record<string, number>> {
  if (blocks === undefined || blocks.length === 0) return {};
  const counts: Record<string, number> = {};
  for (const block of blocks) {
    if (block.kind !== 'tool' || block.status !== 'done' || block.isError === true) continue;
    const display = block.display;
    if (display === undefined) continue;
    const isFileWrite =
      display.kind === 'diff' ||
      (display.kind === 'file_io' && (display.operation === 'edit' || display.operation === 'write'));
    if (!isFileWrite) continue;
    const key = canonicalComparablePath(display.path, cwd);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function fileWriteEpochFor(
  counts: Readonly<Record<string, number>> | undefined,
  path: string,
  cwd: string | undefined,
): number {
  if (counts === undefined) return 0;
  return counts[canonicalComparablePath(path, cwd)] ?? 0;
}

/** The scroller inside a preview tab: the editor's own box, or a rendered page. */
const PREVIEW_SCROLL_SELECTOR = '.cm-scroller, [data-preview-scroll], [data-image-viewport]';
export type PreviewScrollPosition = { readonly top: number; readonly left?: number };

export function usePreviewReadingScroll(
  visible: boolean,
  position: PreviewScrollPosition | undefined,
  onScrollPosition: ((position: { top: number; left?: number }) => void) | undefined,
  navigation?: FileReference,
) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const visitId = useNavVisitId();
  const positionRef = useRef(position);
  positionRef.current = position;
  const reportRef = useRef(onScrollPosition);
  reportRef.current = onScrollPosition;
  const [ready, setReady] = useState(0);
  const onReadingReady = useCallback(() => { setReady((value) => value + 1); }, []);
  const appliedRef = useRef<string | null>(null);
  const appliedPositionRef = useRef<PreviewScrollPosition | undefined>(undefined);
  const reportedRef = useRef<PreviewScrollPosition | undefined>(undefined);
  const pendingRef = useRef(false);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return undefined;
    const onScroll = (event: Event) => {
      const target = event.target;
      if (pendingRef.current || !(target instanceof HTMLElement) || !target.matches(PREVIEW_SCROLL_SELECTOR)) return;
      const value = { top: target.scrollTop, left: target.scrollLeft };
      reportedRef.current = value;
      reportRef.current?.(value);
    };
    const onLoad = (event: Event) => { if (event.target instanceof HTMLImageElement) onReadingReady(); };
    panel.addEventListener('scroll', onScroll, true);
    panel.addEventListener('load', onLoad, true);
    return () => {
      panel.removeEventListener('scroll', onScroll, true);
      panel.removeEventListener('load', onLoad, true);
    };
  }, [onReadingReady]);
  useEffect(() => {
    if (!visible) { appliedRef.current = null; return; }
    if (ready === 0 || navigation?.line !== undefined || navigation?.heading !== undefined) return;
    const identity = `${visitId ?? 'embedded'}\0${ready}`;
    if (appliedRef.current === identity) {
      const equal = (value: PreviewScrollPosition | undefined) => value?.top === position?.top && value?.left === position?.left;
      if (equal(appliedPositionRef.current) || equal(reportedRef.current)) return;
    } else {
      reportedRef.current = undefined;
    }
    pendingRef.current = true;
    // Ready comes from the renderer, not a DOM polling deadline. One layout
    // frame also lets a resident provider commit this visit's saved positions.
    const frame = requestAnimationFrame(() => {
      const scroller = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(PREVIEW_SCROLL_SELECTOR) ?? []).find((element) => element.closest('[hidden]') === null);
      const saved = positionRef.current;
      if (scroller !== undefined && scroller !== null && saved !== undefined) {
        scroller.scrollTop = saved.top;
        if (saved.left !== undefined) scroller.scrollLeft = saved.left;
        appliedRef.current = identity;
        appliedPositionRef.current = saved;
      }
      pendingRef.current = false;
    });
    return () => { cancelAnimationFrame(frame); pendingRef.current = false; };
  }, [visible, visitId, ready, position?.top, position?.left, navigation]);
  return { panelRef, onReadingReady };
}

export interface HtmlPreviewActiveState {
  readonly status: 'ready';
  readonly previewId: string;
  readonly url: string;
  readonly sandbox: string;
  readonly expiresAt: number;
}

export type HtmlPreviewState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | HtmlPreviewActiveState
  | { readonly status: 'error'; readonly error: unknown };

export function classifyHtmlPreviewError(
  error: unknown,
): 'remote_grant_required' | 'local_connection_required' | 'path_outside_root' | 'expired' | 'generic' {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('html_preview_target_owner_grant_required')) return 'remote_grant_required';
  if (message.includes('html_preview_document_origin_requires_local_connection')) return 'local_connection_required';
  if (message.includes('preview_path_outside_root')) return 'path_outside_root';
  if (message.includes('html_preview_expired')) return 'expired';
  return 'generic';
}

export const SandboxedHtmlPreview = memo(function SandboxedHtmlPreview({
  url,
  sandbox,
  title,
}: {
  readonly url: string;
  readonly sandbox: string;
  readonly title: string;
}) {
  return (
    <iframe
      title={title}
      data-preview-html
      src={url}
      sandbox={sandbox}
      referrerPolicy="no-referrer"
      allow="fullscreen"
      allowFullScreen
      className="min-h-0 min-w-0 flex-1 border-0 bg-paper"
    />
  );
});
