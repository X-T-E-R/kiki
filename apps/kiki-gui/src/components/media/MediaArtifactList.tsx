/**
 * Media artifacts — one row per produced file, playable and downloadable in
 * place.
 *
 * An artifact's `file_id` is a session-media id, exactly the kind the existing
 * preview surface already resolves, so an image or a video opens through the
 * same `MediaPart` a pasted screenshot uses, and the reader gets that
 * surface's own player and download button for free. There is no new media
 * transport here, and no artifact is ever linked by a filesystem path: the SDK
 * drops `path` from the public artifact precisely so a file the provider wrote
 * in its staging directory is not mistaken for a file the reader may open.
 *
 * What each modality gets, and why:
 *
 *  - image / video: a real thumbnail, loaded only once it scrolls into view.
 *    A job list with twenty results must not fetch twenty originals before
 *    anyone has scrolled to them. The click target is the existing preview,
 *    which already plays video and downloads any of them.
 *  - audio: the one thing this file adds. A generated voice line is meant to
 *    be *heard*, and the shared media list renders audio as a file chip. So an
 *    audio original gets a compact player bound to the same session-media
 *    bytes the preview would read — nothing new on the wire.
 *  - everything else (subtitles, JSON sidecars, and any provider preview): a
 *    file chip with its size. A subtitle answers "what was said"; it is not a
 *    picture of it, and a compressed preview is never shown as if it were the
 *    original.
 *
 * A duration is drawn only when the provider or a local probe reported one.
 * A file with no measured length shows its size alone rather than a guess.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { MediaRef } from '@kiki/session-core/composer/media';
import { formatBytes } from '@kiki/session-core/composer/media';

import { useI18n } from '../../i18n';
import type { MediaArtifact } from '../../lib/mediaSources';
import { useOptionalConnection } from '../../state/connection';
import { MediaPart } from '../mediaParts';
import { useMediaPreview } from '../mediaPreviewContext';
import { QUIET_BUTTON } from '../capabilities/primitives';
import { MediaKindGlyph } from './MediaKindGlyph';
import { useSessionMediaPlayback } from '../useSessionMediaPlayback';
import { isRemoteConnection } from '../imageActions';

/** An SDK artifact as the existing media surface already understands. */
export function artifactToMediaRef(artifact: MediaArtifact): MediaRef {
  return {
    // The shared media vocabulary has no audio kind; audio rides as a file
    // reference and gets its own row treatment below.
    kind: artifact.kind === 'image' || artifact.kind === 'video' ? artifact.kind : 'file',
    fileId: artifact.file_id,
    name: artifact.name,
    mime: artifact.mime,
    size: artifact.bytes,
  };
}

function formatSeconds(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Duration only when the provider or a local probe reported one. */
export function artifactDuration(artifact: MediaArtifact): number | undefined {
  const metadata = artifact.metadata;
  if (metadata === undefined) return undefined;
  for (const key of ['duration_seconds', 'duration']) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** The one fact line: what it is, how big, how long (when known). */
export function artifactFacts(artifact: MediaArtifact): string {
  const duration = artifactDuration(artifact);
  return [formatBytes(artifact.bytes), duration === undefined ? undefined : formatSeconds(duration)]
    .filter((part) => part !== undefined)
    .join(' · ');
}

/**
 * A preview is the same media as an original only when both name the same
 * session-media `file_id` or the artifact metadata explicitly links their
 * identities, and that original is complete. A shared stem,
 * `preview`/`thumb` filename, or any other label is not an association the
 * provider recorded. An incomplete original does not hide its preview.
 */
export function isProvenPreviewOf(preview: MediaArtifact, original: MediaArtifact): boolean {
  if (preview.role !== 'preview') return false;
  if (original.role !== 'original' || original.complete !== true) return false;
  if (preview.file_id !== '' && preview.file_id === original.file_id) return true;
  return metadataMatches(preview.metadata, ['original_id', 'originalId', 'parent_id', 'parentId'], original.id)
    || metadataMatches(preview.metadata, ['original_file_id', 'originalFileId'], original.file_id)
    || metadataMatches(original.metadata, ['preview_id', 'previewId'], preview.id)
    || metadataMatches(original.metadata, ['preview_file_id', 'previewFileId'], preview.file_id);
}

function metadataMatches(metadata: MediaArtifact['metadata'], keys: readonly string[], expected: string): boolean {
  if (metadata === undefined) return false;
  return keys.some((key) => metadata[key] === expected);
}

export function visibleArtifacts(artifacts: readonly MediaArtifact[]): readonly MediaArtifact[] {
  const completeOriginals = artifacts.filter(
    (artifact) => artifact.role === 'original' && artifact.complete === true,
  );
  if (completeOriginals.length === 0) return artifacts;
  return artifacts.filter((artifact) => {
    if (artifact.role !== 'preview') return true;
    const hasProvenOriginal = completeOriginals.some((orig) => isProvenPreviewOf(artifact, orig));
    return !hasProvenOriginal;
  });
}

export function MediaArtifactList({
  artifacts,
  sessionId,
  agentId,
}: {
  readonly artifacts: readonly MediaArtifact[];
  /** Session owning the artifact file ids; needed to resolve them. */
  readonly sessionId?: string;
  /** Producing agent, for artifact ids that carry a blob reference. */
  readonly agentId?: string;
}) {
  if (artifacts.length === 0) return null;
  const visible = visibleArtifacts(artifacts);
  if (visible.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5" data-media-artifacts={visible.length}>
      {visible.map((artifact) => (
        <MediaArtifactRow key={artifact.id} artifact={artifact} sessionId={sessionId} agentId={agentId} />
      ))}
    </div>
  );
}

function MediaArtifactRow({
  artifact,
  sessionId,
  agentId,
}: {
  readonly artifact: MediaArtifact;
  readonly sessionId?: string;
  readonly agentId?: string;
}) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const item = artifactToMediaRef(artifact);
  const meta = artifactFacts(artifact);
  // Without a preview surface there is nothing to click, so the row shows a
  // plain file chip instead of a thumbnail — and the chip already carries the
  // name, so the column beside it would print it twice.
  const degraded = preview === null;

  if (artifact.kind === 'image' || artifact.kind === 'video') {
    return (
      <div
        className="flex min-w-0 flex-wrap items-center gap-2"
        data-media-artifact={artifact.id}
        data-media-kind={artifact.kind}
        data-media-role={artifact.role}
      >
        <MediaPart item={item} agentId={agentId} />
        {degraded ? null : (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] text-ink" title={artifact.name}>{artifact.name}</span>
            <span className="block font-mono text-[11px] text-ink-faint">{meta}</span>
          </span>
        )}
        {artifact.role === 'preview' ? (
          <span className="shrink-0 text-[11px] text-ink-faint">{t('cap.media.artifact.preview')}</span>
        ) : null}
      </div>
    );
  }

  if (artifact.kind === 'audio' && artifact.role === 'original') {
    return (
      <div
        className="flex min-w-0 flex-wrap items-center gap-2"
        data-media-artifact={artifact.id}
        data-media-kind="audio"
        data-media-role={artifact.role}
      >
        <AudioOriginal artifact={artifact} sessionId={sessionId} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] text-ink" title={artifact.name}>{artifact.name}</span>
          <span className="block font-mono text-[11px] text-ink-faint">{meta}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-8 min-w-0 flex-wrap items-center gap-2"
      data-media-artifact={artifact.id}
      data-media-kind={artifact.kind}
      data-media-role={artifact.role}
    >
      <FileChip item={item} />
      {artifact.role === 'original' ? null : (
        <span className="shrink-0 text-[11px] text-ink-faint">
          {artifact.role === 'preview' ? t('cap.media.artifact.preview') : t('cap.media.artifact.subtitle')}
        </span>
      )}
    </div>
  );
}

/**
 * A file chip for a non-picture artifact. Local rather than imported so this
 * file owns no dependency on a surface someone else is editing; it is the same
 * shape the shared one uses — a name, a size, and a click that opens the
 * existing preview when there is a session to resolve it against.
 */
function FileChip({ item }: { readonly item: MediaRef }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const label = item.name ?? item.fileId ?? t('media.attachment');
  const openable = item.fileId !== undefined && preview !== null;
  const className = `inline-flex max-w-full items-center gap-1.5 rounded-lg border border-hairline bg-paper px-2.5 py-1 text-left ${
    openable ? 'transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink' : 'opacity-70'
  }`;
  const body = (
    <>
      <MediaKindGlyph kind="file" className="h-3.5 w-3.5 text-ink-faint" />
      <span className="min-w-0 truncate font-mono text-[12px] text-ink">{label}</span>
    </>
  );
  if (!openable) return <span className={className} title={item.fileId}>{body}</span>;
  return (
    <button type="button" className={className} title={item.fileId} onClick={() => { preview!.openAttachment(item); }}>
      {body}
    </button>
  );
}

/**
 * A generated voice line, playable where it is shown.
 *
 * The bytes come from the same session-media read the preview dialog uses, so
 * this adds no transport and no server route — it just stops asking the
 * reader to open a dialog to hear a two-second clip. Nothing is fetched until
 * the reader presses play, and a failure says so with a retry rather than
 * leaving a dead control.
 */
function AudioOriginal({ artifact, sessionId }: { readonly artifact: MediaArtifact; readonly sessionId?: string }) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const remoteScope = isRemoteConnection(connection);
  // Armed state binds to the exact client connection, session, and fileId (not containing attempt so retries preserve arming)
  const [armedSource, setArmedSource] = useState<{ client: typeof client; sessionId: string | undefined; fileId: string | undefined } | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  const currentSource = useMemo(
    () => ({ client, sessionId, fileId: artifact.file_id }),
    [client, sessionId, artifact.file_id],
  );

  const armed = armedSource !== undefined
    && armedSource.client === client
    && armedSource.sessionId === sessionId
    && armedSource.fileId === artifact.file_id;

  // V3: Bind byteLoad state, decode failure, and objectUrl to the current source identity (client, sessionId, file_id, attempt)
  const sourceIdentity = useMemo(
    () => ({ client, sessionId, fileId: artifact.file_id, attempt }),
    [client, sessionId, artifact.file_id, attempt],
  );

  const mediaRef = useMemo<MediaRef>(() => ({
    kind: 'file',
    fileId: artifact.file_id,
    mime: artifact.mime?.startsWith('audio/') ? artifact.mime : 'audio/mpeg',
    name: artifact.name,
    size: artifact.bytes,
  }), [artifact.file_id, artifact.mime, artifact.name, artifact.bytes]);

  const playback = useSessionMediaPlayback(
    mediaRef,
    sessionId,
    armed ? client : undefined,
    remoteScope,
    attempt,
  );

  const [decodeFailureState, setDecodeFailureState] = useState<{ source: typeof sourceIdentity; failed: boolean }>({
    source: sourceIdentity,
    failed: false,
  });
  const decodeFailed = decodeFailureState.source === sourceIdentity && decodeFailureState.failed;

  type ByteLoadState = { status: 'idle' | 'loading' | 'ready'; url?: string; failed: boolean };

  const [byteState, setByteState] = useState<{
    source: typeof sourceIdentity;
    load: ByteLoadState;
  }>({
    source: sourceIdentity,
    load: { status: 'idle', failed: false },
  });

  const byteLoad: ByteLoadState = byteState.source === sourceIdentity ? byteState.load : { status: 'idle', failed: false };
  const objectUrlRef = useRef<string | undefined>(undefined);

  // Revoke previous object URL on source change or unmount
  useEffect(() => {
    return () => {
      if (objectUrlRef.current !== undefined) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = undefined;
      }
    };
  }, [sourceIdentity]);

  // V1: Include attempt in fallback effect dependencies, so remote / unsupported route retries refetch bytes
  useEffect(() => {
    if (!armed || client === undefined || sessionId === undefined || playback.status !== 'fallback') return;
    const controller = new AbortController();
    setByteState({ source: sourceIdentity, load: { status: 'loading', failed: false } });

    client.readSessionMediaBytes(sessionId, artifact.file_id, { signal: controller.signal, timeoutMs: 0 })
      .then(({ bytes, mime }) => {
        if (controller.signal.aborted) return;
        if (objectUrlRef.current !== undefined) {
          URL.revokeObjectURL(objectUrlRef.current);
        }
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: artifact.mime || mime }));
        objectUrlRef.current = url;
        setByteState({ source: sourceIdentity, load: { status: 'ready', url, failed: false } });
      }, () => {
        if (!controller.signal.aborted) {
          setByteState({ source: sourceIdentity, load: { status: 'idle', failed: true } });
        }
      });

    return () => { controller.abort(); };
  }, [armed, client, sessionId, artifact.file_id, artifact.mime, playback.status, attempt, sourceIdentity]);

  // V2: audio onError handler when decoding or streaming media URL fails
  const onAudioError = () => {
    if (playback.status === 'ready') {
      playback.fail();
    } else {
      setDecodeFailureState({ source: sourceIdentity, failed: true });
    }
  };

  const failed = armed && (playback.status === 'failed' || byteLoad.failed || decodeFailed);
  const loading = armed && (playback.status === 'loading' || byteLoad.status === 'loading');
  const readyUrl = armed && !decodeFailed
    ? (playback.status === 'ready' ? playback.url : (playback.status === 'fallback' && byteLoad.status === 'ready' ? byteLoad.url : undefined))
    : undefined;

  if (failed) {
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-2" data-media-audio={artifact.id} data-media-audio-state="failed">
        <span role="alert" className="text-[11px] text-danger">{t('cap.media.artifact.audioFailed')}</span>
        <button
          type="button"
          onClick={() => {
            setDecodeFailureState({ source: sourceIdentity, failed: false });
            setByteState({ source: sourceIdentity, load: { status: 'idle', failed: false } });
            setAttempt((c) => c + 1);
            setArmedSource(currentSource);
          }}
          className={`${QUIET_BUTTON} h-8`}
          data-media-audio-retry={artifact.id}
        >
          {t('common.retry')}
        </button>
      </span>
    );
  }
  if (readyUrl !== undefined) {
    return (
      <audio
        controls
        preload="none"
        data-media-audio={artifact.id}
        data-media-audio-state="ready"
        src={readyUrl}
        onError={onAudioError}
        className="h-8 max-w-[min(100%,17rem)]"
      >
        {t('cap.media.artifact.audioUnsupported')}
      </audio>
    );
  }
  return (
    <button
      type="button"
      disabled={loading || sessionId === undefined}
      data-media-audio={artifact.id}
      data-media-audio-state={loading ? 'loading' : 'idle'}
      onClick={() => { setArmedSource(currentSource); }}
      className={`${QUIET_BUTTON} h-8 border border-hairline`}
    >
      <MediaKindGlyph kind="audio" className="h-3.5 w-3.5 text-ink-faint" />
      {loading ? t('cap.media.artifact.audioLoading') : t('cap.media.artifact.play')}
    </button>
  );
}
