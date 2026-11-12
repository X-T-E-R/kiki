/**
 * Audio and video HTML5 preview tabs.
 */

import { useEffect, useState } from 'react';

import { basenameOf, formatBytes } from '@kiki/session-core/composer/media';
import { useI18n } from '#/i18n';
import type { KikiClient } from '#/lib/client';
import { useOptionalConnection } from '#/state/connection';
import type { PreviewReadState } from '#/state/previewResource';
import { BinaryTabView } from './BinaryTabView';
import { HeaderFileActions } from './ResourceHeader';

interface PlayableMedia {
  readonly url: string;
  readonly size: number;
  readonly via: 'capability' | 'blob';
  readonly release: () => void;
}

function loadPlayableBlob(client: KikiClient, path: string, signal: AbortSignal): Promise<PlayableMedia> {
  return client.readHostFileBytes(path, { signal }).then(({ bytes, mime }) => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('cancelled');
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    return { url, size: bytes.byteLength, via: 'blob', release: () => { URL.revokeObjectURL(url); } };
  });
}

/** Capability URL when this connection can mint one; otherwise the file bytes. */
function loadPlayableMedia(client: KikiClient, path: string, signal: AbortSignal, forceBlob: boolean): Promise<PlayableMedia> {
  if (!forceBlob && typeof client.openHostMediaPreview === 'function') {
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
      return loadPlayableBlob(client, path, signal);
    });
  }
  return loadPlayableBlob(client, path, signal);
}

/**
 * Audio tab: play the host file through a short-lived media URL when the
 * connection can mint one, otherwise from the original bytes. A failed read
 * stays actionable so the same tab can retry; a browser decode failure uses
 * the ordinary file fallback.
 */
export function AudioTabView({
  path,
  scopeId,
  onReadStateChange,
}: {
  readonly path: string;
  readonly scopeId?: string;
  readonly onReadStateChange?: (state: PreviewReadState) => void;
}) {
  const { t } = useI18n();
  const client = useOptionalConnection()?.client;
  const name = basenameOf(path);
  const mediaKey = `${scopeId ?? ''}\0${path}`;
  const [attempt, setAttempt] = useState(0);
  const [unplayable, setUnplayable] = useState(false);
  const [blobFallbackKey, setBlobFallbackKey] = useState<string | undefined>(undefined);
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'error' }
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

  useEffect(() => {
    const status = state.status === 'error' ? 'failed' : state.status;
    onReadStateChange?.({
      status,
      readableFromDevice: status !== 'failed',
      originalReadable: status !== 'failed',
    });
  }, [state.status, onReadStateChange]);

  useEffect(() => {
    setUnplayable(false);
    if (client === undefined) {
      setState({ status: 'error' });
      return;
    }
    const abort = new AbortController();
    let release: (() => void) | undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    loadPlayableMedia(client, path, abort.signal, blobFallbackKey === mediaKey).then((ready) => {
      if (cancelled) {
        ready.release();
        return;
      }
      release = ready.release;
      setState({ status: 'ready', client, path, scopeId, url: ready.url, size: ready.size, via: ready.via });
    }, () => {
      if (!cancelled && !abort.signal.aborted) setState({ status: 'error' });
    });
    return () => {
      cancelled = true;
      abort.abort();
      release?.();
    };
  }, [attempt, blobFallbackKey, client, mediaKey, path, scopeId]);

  const readyState = state.status === 'ready' && state.client === client && state.path === path && state.scopeId === scopeId
    ? state
    : undefined;
  if (unplayable) return <BinaryTabView path={path} />;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={path}>
          {path}
        </span>
        {readyState !== undefined ? (
          <span className="shrink-0 font-mono text-[11px] text-ink-faint" data-audio-meta>
            {formatBytes(readyState.size)}
          </span>
        ) : null}
        <HeaderFileActions path={path} name={name} canDownload={state.status !== 'error'} />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
        {readyState === undefined && state.status === 'loading' ? (
          <p className="flex items-center gap-2 text-[12px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('preview.loading')}
          </p>
        ) : readyState === undefined && state.status === 'error' ? (
          <div className="flex items-center gap-2 text-[12.5px] text-danger">
            <span>{t('preview.failed')}</span>
            <button
              type="button"
              data-preview-audio-retry
              onClick={() => { setAttempt((value) => value + 1); }}
              className="rounded-full border border-hairline px-2 py-0.5 text-[11px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
            >
              {t('common.retry')}
            </button>
          </div>
        ) : readyState !== undefined ? (
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
        ) : null}
      </div>
    </>
  );
}

/**
 * Video tab: the file's own bytes in a plain HTML5 player — native controls,
 * no frame around the picture, intrinsic size capped by the panel rather than
 * stretched to fill it. A container the runtime cannot decode (codec missing)
 * degrades to the binary fallback, whose opener buttons are the recovery.
 */
export function VideoTabView({
  path,
  onReadStateChange,
}: {
  readonly path: string;
  readonly onReadStateChange?: (state: PreviewReadState) => void;
}) {
  const { t } = useI18n();
  const client = useOptionalConnection()?.client;
  const name = basenameOf(path);
  const [unplayable, setUnplayable] = useState(false);
  const [blobFallback, setBlobFallback] = useState(false);
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'error' }
    | { readonly status: 'ready'; readonly url: string; readonly size: number; readonly via: 'capability' | 'blob' }
  >({ status: 'loading' });

  useEffect(() => {
    const status = state.status === 'error' ? 'failed' : state.status;
    onReadStateChange?.({
      status,
      readableFromDevice: status !== 'failed',
      originalReadable: status !== 'failed',
    });
  }, [state.status, onReadStateChange]);

  useEffect(() => {
    setBlobFallback(false);
  }, [client, path]);

  useEffect(() => {
    setUnplayable(false);
    if (client === undefined) {
      setState({ status: 'error' });
      return;
    }
    const abort = new AbortController();
    let release: (() => void) | undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    loadPlayableMedia(client, path, abort.signal, blobFallback).then((ready) => {
      if (cancelled) {
        ready.release();
        return;
      }
      release = ready.release;
      setState({ status: 'ready', url: ready.url, size: ready.size, via: ready.via });
    }, () => {
      if (!cancelled && !abort.signal.aborted) setState({ status: 'error' });
    });
    return () => {
      cancelled = true;
      abort.abort();
      release?.();
    };
  }, [blobFallback, client, path]);

  if (unplayable) return <BinaryTabView path={path} />;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={path}>
          {path}
        </span>
        {state.status === 'ready' ? (
          <span className="shrink-0 font-mono text-[11px] text-ink-faint" data-video-meta>
            {formatBytes(state.size)}
          </span>
        ) : null}
        <HeaderFileActions path={path} name={name} canDownload={state.status !== 'error'} />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
        {state.status === 'loading' ? (
          <p className="flex items-center gap-2 text-[12px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('preview.loading')}
          </p>
        ) : state.status === 'error' ? (
          <p className="text-[12.5px] text-danger">{t('preview.failed')}</p>
        ) : (
          <video
            src={state.url}
            controls
            playsInline
            aria-label={name}
            data-preview-video
            onError={() => {
              if (state.status === 'ready' && state.via === 'capability') setBlobFallback(true);
              else setUnplayable(true);
            }}
            className="max-h-full max-w-full"
          />
        )}
      </div>
    </>
  );
}
