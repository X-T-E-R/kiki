/**
 * Shared styling tokens, path/mention formatters, host openers, scroll
 * restoration, and HTML sandbox helpers for the preview renderers.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { mentionToken } from '@kiki/session-core/composer';
import { basenameOf, resolveHostPath, type FileReference, type MediaRef } from '@kiki/session-core/composer/media';
import { useHost, type HostAdapter } from '#/host';
import { useI18n } from '#/i18n';
import type { KikiClient } from '#/lib/client';
import { usePhoneMode } from '#/lib/layoutHooks';
import { runToastAction } from '#/lib/toasts';
import { useNavVisitId } from '#/lib/useNavSnapshot';
import { useOptionalConnection } from '#/state/connection';
import {
  classifyResource,
  isKikiComputer,
  type PreviewEnvironment,
  type PreviewResource,
} from '#/state/previewResource';
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
  const name = attachmentName(item, undefined, fallbackName);
  const origin = tabOrigin ?? item.origin;
  const resolvedOrigin =
    origin !== undefined && origin.trusted
      ? { path: resolveHostPath(origin.path, cwd), trusted: true as const }
      : undefined;
  const type = classifyResource({ name, mime: item.mime });
  if (item.fileId !== undefined) {
    return {
      source: {
        kind: 'session-copy',
        sessionId: sessionId ?? '',
        fileId: item.fileId,
        sourceId: item.sourceId,
      },
      origin: resolvedOrigin,
      type,
      name,
      mime: item.mime,
    };
  }
  if (item.path !== undefined) {
    const resolved = resolveHostPath(item.path, cwd);
    return {
      source: { kind: 'host-file', path: resolved },
      origin: resolvedOrigin ?? { path: resolved, trusted: true },
      type,
      name,
      mime: item.mime,
    };
  }
  return {
    source: { kind: 'url', url: item.url ?? '' },
    origin: resolvedOrigin,
    type,
    name,
    mime: item.mime,
  };
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

export async function downloadHostFile(
  host: HostAdapter,
  client: KikiClient,
  path: string,
  name: string,
): Promise<void> {
  const { bytes, mime } = await client.readHostFileBytes(path);
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

// Secondary body button beside the accent download (binary tab body).
export const BODY_ACTION_CLASS =
  'rounded-lg border border-hairline px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';

export function TabPathCaption({ path }: { readonly path: string }) {
  return (
    <p className="truncate border-b border-hairline px-3 py-1.5 font-mono text-[11px] text-ink-faint" title={path}>
      {path}
    </p>
  );
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
