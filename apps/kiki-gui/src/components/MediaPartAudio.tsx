import { useState } from 'react';
import { resolveHostPath, type MediaRef } from '@kiki/session-core/composer/media';
import { useI18n } from '../i18n';
import { useOptionalConnection } from '../state/connection';
import { isOnKikiComputer } from './imageActions';
import { inlineMediaCleanupRef, notifyInlineMediaPlay, unregisterInlineMediaElement } from './inlineMediaCoordinator';
import {
  attachmentName,
  FileChip,
  MediaLoadFailure,
  useMediaRefMenu,
  useSessionMedia,
  useVisibleOnce,
  type MediaFailureKind,
} from './mediaParts';
import { useMediaPreview } from './mediaPreviewContext';
import { useHostMediaPreview, useSessionMediaPlayback } from './useSessionMediaPlayback';

export function AudioPart({ item }: { item: MediaRef }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const localKikiComputer = isOnKikiComputer(connection);
  const [hostRef, visible] = useVisibleOnce();
  const [attempt, setAttempt] = useState(0);
  const hostPath = item.path === undefined ? undefined : resolveHostPath(item.path, preview?.cwd);
  const canHostPreview =
    visible &&
    item.url === undefined &&
    item.fileId === undefined &&
    hostPath !== undefined &&
    localKikiComputer &&
    client !== undefined &&
    typeof client.openHostMediaPreview === 'function';
  const hostPreview = useHostMediaPreview(client, hostPath, canHostPreview, attempt);

  const playbackSessionId = visible && item.url === undefined ? preview?.sessionId : undefined;
  const remotePlayback = client === undefined || !localKikiComputer;
  const playback = useSessionMediaPlayback(item, playbackSessionId, client, remotePlayback, attempt);
  const needBlobFallback =
    visible &&
    item.url === undefined &&
    playback.status === 'fallback' &&
    (!canHostPreview || hostPreview.status === 'fallback');
  const load = useSessionMedia(item, preview?.sessionId, needBlobFallback, false, attempt);
  const resolvedSrc =
    item.url ??
    (playback.status === 'ready'
      ? playback.url
      : hostPreview.status === 'ready'
        ? hostPreview.url
        : load.status === 'ready'
          ? load.url
          : undefined);
  const [stickySrc, setStickySrc] = useState<{ readonly key: string; readonly url: string } | null>(null);
  const mediaKey = `${preview?.sessionId ?? ''}\0${item.fileId ?? item.path ?? item.url ?? ''}\0${attempt}`;
  if (resolvedSrc !== undefined && (stickySrc?.key !== mediaKey || stickySrc.url !== resolvedSrc)) {
    setStickySrc({ key: mediaKey, url: resolvedSrc });
  }
  const [audioFailedState, setAudioFailedState] = useState<{ readonly key: string; readonly kind: 'decode' | 'transient' } | null>(null);
  const audioErrorKind = audioFailedState?.key === mediaKey ? audioFailedState.kind : undefined;
  const audioDecodeFailed = audioErrorKind === 'decode';
  const src = audioErrorKind !== undefined ? undefined : (resolvedSrc ?? (playback.status !== 'failed' && stickySrc?.key === mediaKey ? stickySrc.url : undefined));
  const failed = src === undefined && (audioErrorKind !== undefined || playback.status === 'failed' || (needBlobFallback && load.status === 'failed'));
  const audioFailureKind: MediaFailureKind =
    audioErrorKind ??
    (needBlobFallback && load.status === 'failed'
      ? (load.failureKind ?? 'transient')
      : 'transient');
  const label = attachmentName(item, undefined, t('media.attachment'));
  const audioMenu = useMediaRefMenu(item, label);
  const originalPath = item.path ?? item.origin?.path;
  return (
    <span ref={hostRef} className="inline-flex max-w-full" onContextMenu={audioMenu.openMenu}>
      {src !== undefined ? (
        <audio
          ref={inlineMediaCleanupRef}
          controls
          src={src}
          preload="none"
          onPlay={(event) => { notifyInlineMediaPlay(event.currentTarget); }}
          onEnded={(event) => { unregisterInlineMediaElement(event.currentTarget); }}
          onError={(event) => {
            unregisterInlineMediaElement(event.currentTarget);
            const errCode = event.currentTarget.error?.code;
            const isNetwork = errCode === 1 || errCode === 2;
            setAudioFailedState({ key: mediaKey, kind: isNetwork ? 'transient' : 'decode' });
            if (playback.status === 'ready') playback.fail();
          }}
          className="h-10 max-w-full"
        />
      ) : failed ? (
        <MediaLoadFailure
          name={label}
          decode={audioDecodeFailed}
          failureKind={audioFailureKind}
          title={originalPath ?? label}
          onRetry={() => {
            setAudioFailedState(null);
            setAttempt((value) => value + 1);
          }}
          onOpen={audioFailureKind === 'decode' && preview !== null ? () => { preview.openAttachment(item); } : undefined}
          onContextMenu={audioMenu.openMenu}
        />
      ) : !visible || playback.status === 'loading' || hostPreview.status === 'loading' || (needBlobFallback && load.status === 'loading') ? (
        <span aria-busy="true" className="block h-10 w-[220px] max-w-full animate-pulse rounded-lg bg-ink/[0.06] motion-reduce:animate-none" />
      ) : (
        <FileChip item={item} />
      )}
      {audioMenu.menuElement}
    </span>
  );
}
