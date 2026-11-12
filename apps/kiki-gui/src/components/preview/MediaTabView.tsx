/**
 * Audio and video HTML5 preview tabs.
 */

import { useCallback, useEffect, useState } from 'react';

import { basenameOf, formatBytes } from '@kiki/session-core/composer/media';
import type { KikiClient } from '#/lib/client';
import { usePhoneMode } from '#/lib/layoutHooks';
import { useOptionalConnection } from '#/state/connection';
import { classifyHostFileReadError } from '#/state/hostFileEditor';
import type { PreviewReadFailureReason, PreviewReadState } from '#/state/previewResource';
import { BinaryTabView } from './BinaryTabView';
import { HeaderFileActions } from './ResourceHeader';
import {
  DelayedReadingNotice,
  isLocalKikiComputer,
  PreviewReadFailureView,
  readPreviewFileBytes,
  type SessionWorkspaceReadScope,
} from './shared';

interface PlayableMedia {
  readonly url: string;
  readonly size: number;
  readonly via: 'capability' | 'blob';
  readonly release: () => void;
}

function loadPlayableBlob(
  client: KikiClient,
  path: string,
  scope: SessionWorkspaceReadScope,
  signal: AbortSignal,
): Promise<PlayableMedia> {
  return readPreviewFileBytes(client, path, scope, { signal }).then(({ bytes, mime }) => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('cancelled');
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    return { url, size: bytes.byteLength, via: 'blob', release: () => { URL.revokeObjectURL(url); } };
  });
}

/** Capability URL when this connection can mint one; otherwise the file bytes. */
function loadPlayableMedia(
  client: KikiClient,
  path: string,
  scope: SessionWorkspaceReadScope,
  signal: AbortSignal,
  forceBlob: boolean,
): Promise<PlayableMedia> {
  if (!forceBlob && scope.localKikiComputer !== false && typeof client.openHostMediaPreview === 'function') {
    return client.openHostMediaPreview({ path }, { signal }).then((opened) => {
      if (signal.aborted) {
        void client.closeHostMediaPreview(opened.preview_id);
        throw signal.reason instanceof Error ? signal.reason : new Error('cancelled');
      }
      return {
        url: opened.url,
        size: opened.size,
        via: 'capability' as const,
        release: () => { void client.closeHostMediaPreview(opened.preview_id); },
      };
    }, (error: unknown) => {
      if (signal.aborted) throw error;
      return loadPlayableBlob(client, path, scope, signal);
    });
  }
  return loadPlayableBlob(client, path, scope, signal);
}

/**
 * Audio tab: play the host file through a short-lived media URL when the
 * connection can mint one, otherwise from the original bytes. A failed read
 * stays actionable so the same tab can retry; a browser decode failure uses
 * the damaged-file state with download.
 */
export function AudioTabView({
  path,
  scopeId,
  sessionId,
  workspaceRoot,
  externalReloadNonce,
  onCloseTab,
  onReadStateChange,
}: {
  readonly path: string;
  readonly scopeId?: string;
  readonly sessionId?: string;
  readonly workspaceRoot?: string;
  readonly externalReloadNonce?: number;
  readonly onCloseTab?: () => void;
  readonly onReadStateChange?: (state: PreviewReadState) => void;
}) {
  const phoneMode = usePhoneMode();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const localKikiComputer = isLocalKikiComputer(connection);
  const name = basenameOf(path);
  const mediaKey = `${scopeId ?? ''}\0${path}`;
  const [attempt, setAttempt] = useState(0);
  const [unplayable, setUnplayable] = useState(false);
  const [blobFallbackKey, setBlobFallbackKey] = useState<string | undefined>(undefined);
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'error'; readonly reason: PreviewReadFailureReason }
    | {
      readonly status: 'ready';
      readonly client: KikiClient;
      readonly path: string;
      readonly scopeId: string | undefined;
      readonly url: string;
      readonly size: number;
      readonly via: 'capability' | 'blob';
    }
  >({ status: 'loading' });

  const reload = useCallback(() => {
    setUnplayable(false);
    setBlobFallbackKey(undefined);
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (externalReloadNonce !== undefined && externalReloadNonce > 0) reload();
  }, [externalReloadNonce, reload]);

  useEffect(() => {
    if (unplayable) {
      onReadStateChange?.({
        status: 'ready',
        readableFromDevice: true,
        originalReadable: true,
        failureReason: 'corrupted',
      });
      return;
    }
    const status = state.status === 'error' ? 'failed' : state.status;
    const reason = state.status === 'error' ? state.reason : undefined;
    onReadStateChange?.({
      status,
      readableFromDevice: status !== 'failed' && reason !== 'remote-unreadable',
      originalReadable: status !== 'failed' && reason !== 'remote-unreadable',
      failureReason: reason,
    });
  }, [unplayable, state, onReadStateChange]);

  useEffect(() => {
    setUnplayable(false);
    if (client === undefined) {
      setState({ status: 'error', reason: 'error' });
      return;
    }
    const abort = new AbortController();
    let release: (() => void) | undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    loadPlayableMedia(
      client,
      path,
      { sessionId, workspaceRoot, localKikiComputer },
      abort.signal,
      blobFallbackKey === mediaKey,
    ).then((ready) => {
      if (cancelled) {
        ready.release();
        return;
      }
      release = ready.release;
      setState({ status: 'ready', client, path, scopeId, url: ready.url, size: ready.size, via: ready.via });
    }, (error: unknown) => {
      if (!cancelled && !abort.signal.aborted) {
        setState({ status: 'error', reason: classifyHostFileReadError(error) });
      }
    });
    return () => {
      cancelled = true;
      abort.abort();
      release?.();
    };
  }, [attempt, blobFallbackKey, client, localKikiComputer, mediaKey, path, scopeId, sessionId, workspaceRoot]);

  const readyState = state.status === 'ready' && state.client === client && state.path === path && state.scopeId === scopeId
    ? state
    : undefined;
  if (unplayable) {
    return (
      <BinaryTabView
        path={path}
        sessionId={sessionId}
        workspaceRoot={workspaceRoot}
        reason="corrupted"
      />
    );
  }

  const readFailed = readyState === undefined && state.status === 'error';
  const failureReason = state.status === 'error' ? state.reason : undefined;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={path}>
          {phoneMode ? name : path}
        </span>
        {!phoneMode && readyState !== undefined ? (
          <span className="shrink-0 font-mono text-[11px] text-ink-faint" data-audio-meta>
            {formatBytes(readyState.size)}
          </span>
        ) : null}
        <HeaderFileActions
          path={path}
          name={name}
          sessionId={sessionId}
          workspaceRoot={workspaceRoot}
          resourceType="audio"
          canDownload={!readFailed}
          readFailed={readFailed}
          failureReason={failureReason}
          onReload={reload}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {readyState === undefined && state.status === 'loading' ? (
          <DelayedReadingNotice active />
        ) : readFailed && failureReason !== undefined ? (
          <PreviewReadFailureView
            reason={failureReason}
            path={path}
            onReload={reload}
            onCloseTab={onCloseTab}
          />
        ) : readyState !== undefined ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-3">
            <audio
              src={readyState.url}
              controls
              preload="metadata"
              aria-label={name}
              data-preview-audio
              onError={() => {
                if (readyState.via === 'capability') setBlobFallbackKey(mediaKey);
                else setUnplayable(true);
              }}
              className="w-full max-w-2xl"
            />
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * Video tab: the file's own bytes in a plain HTML5 player — native controls,
 * no frame around the picture, intrinsic size capped by the panel rather than
 * stretched to fill it. A truncated or unplayable video lands in the
 * damaged-file state ("corrupted") with a neutral ink download button, not
 * "unsupported".
 */
export function VideoTabView({
  path,
  sessionId,
  workspaceRoot,
  externalReloadNonce,
  onCloseTab,
  onReadStateChange,
}: {
  readonly path: string;
  readonly sessionId?: string;
  readonly workspaceRoot?: string;
  readonly externalReloadNonce?: number;
  readonly onCloseTab?: () => void;
  readonly onReadStateChange?: (state: PreviewReadState) => void;
}) {
  const phoneMode = usePhoneMode();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const localKikiComputer = isLocalKikiComputer(connection);
  const name = basenameOf(path);
  const [attempt, setAttempt] = useState(0);
  const [unplayable, setUnplayable] = useState(false);
  const [blobFallback, setBlobFallback] = useState(false);
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'error'; readonly reason: PreviewReadFailureReason }
    | { readonly status: 'ready'; readonly url: string; readonly size: number; readonly via: 'capability' | 'blob' }
  >({ status: 'loading' });

  const reload = useCallback(() => {
    setUnplayable(false);
    setBlobFallback(false);
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (externalReloadNonce !== undefined && externalReloadNonce > 0) reload();
  }, [externalReloadNonce, reload]);

  useEffect(() => {
    if (unplayable) {
      onReadStateChange?.({
        status: 'ready',
        readableFromDevice: true,
        originalReadable: true,
        failureReason: 'corrupted',
      });
      return;
    }
    const status = state.status === 'error' ? 'failed' : state.status;
    const reason = state.status === 'error' ? state.reason : undefined;
    onReadStateChange?.({
      status,
      readableFromDevice: status !== 'failed' && reason !== 'remote-unreadable',
      originalReadable: status !== 'failed' && reason !== 'remote-unreadable',
      failureReason: reason,
    });
  }, [unplayable, state, onReadStateChange]);

  useEffect(() => {
    setBlobFallback(false);
  }, [client, path]);

  useEffect(() => {
    setUnplayable(false);
    if (client === undefined) {
      setState({ status: 'error', reason: 'error' });
      return;
    }
    const abort = new AbortController();
    let release: (() => void) | undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    loadPlayableMedia(
      client,
      path,
      { sessionId, workspaceRoot, localKikiComputer },
      abort.signal,
      blobFallback,
    ).then((ready) => {
      if (cancelled) {
        ready.release();
        return;
      }
      release = ready.release;
      setState({ status: 'ready', url: ready.url, size: ready.size, via: ready.via });
    }, (error: unknown) => {
      if (!cancelled && !abort.signal.aborted) {
        setState({ status: 'error', reason: classifyHostFileReadError(error) });
      }
    });
    return () => {
      cancelled = true;
      abort.abort();
      release?.();
    };
  }, [attempt, blobFallback, client, localKikiComputer, path, sessionId, workspaceRoot]);

  if (unplayable) {
    return (
      <BinaryTabView
        path={path}
        sessionId={sessionId}
        workspaceRoot={workspaceRoot}
        reason="corrupted"
      />
    );
  }

  const readFailed = state.status === 'error';
  const failureReason = state.status === 'error' ? state.reason : undefined;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={path}>
          {phoneMode ? name : path}
        </span>
        {!phoneMode && state.status === 'ready' ? (
          <span className="shrink-0 font-mono text-[11px] text-ink-faint" data-video-meta>
            {formatBytes(state.size)}
          </span>
        ) : null}
        <HeaderFileActions
          path={path}
          name={name}
          sessionId={sessionId}
          workspaceRoot={workspaceRoot}
          resourceType="video"
          canDownload={!readFailed}
          readFailed={readFailed}
          failureReason={failureReason}
          onReload={reload}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {state.status === 'loading' ? (
          <DelayedReadingNotice active />
        ) : readFailed && failureReason !== undefined ? (
          <PreviewReadFailureView
            reason={failureReason}
            path={path}
            onReload={reload}
            onCloseTab={onCloseTab}
          />
        ) : state.status === 'ready' ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-3">
            <video
              src={state.url}
              controls
              playsInline
              aria-label={name}
              data-preview-video
              onError={() => {
                if (state.via === 'capability') setBlobFallback(true);
                else setUnplayable(true);
              }}
              className="max-h-full max-w-full"
            />
          </div>
        ) : null}
      </div>
    </>
  );
}
