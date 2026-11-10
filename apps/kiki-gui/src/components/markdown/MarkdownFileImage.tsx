import { useMemo, useRef, useState, type ComponentProps } from 'react';

import { resolveFileReference, unwrapFileLinkTarget, type MediaRef } from '@kiki/session-core/composer/media';
import { parseDaemonFileRefFileId } from '@kiki/transcript';

import { useI18n } from '../../i18n';
import { useOptionalConnection } from '../../state/connection';
import { mediaOutcomeKey, useMediaReady } from '../imageActions';
import { safeImagePreviewName } from '../imagePreviewName';
import { MediaPart, useGalleryImage, useMessageImageMenu, useSessionMedia } from '../mediaParts';
import { useMediaPreview } from '../mediaPreviewContext';
import { useRecordRenderedImage } from './renderedImages';

type ImageProps = ComponentProps<'img'>;

export function MarkdownFileImage({ src, alt, title: _title, node: _node, documentDirectory, ...props }: ImageProps & {
  documentDirectory?: string;
  node?: unknown;
}) {
  const client = useOptionalConnection()?.client;
  const preview = useMediaPreview();
  const { t } = useI18n();
  const target = typeof src === 'string' ? unwrapFileLinkTarget(src) ?? src : undefined;
  const directory = documentDirectory ?? preview?.cwd;
  const path = useMemo(() => target === undefined
    ? undefined
    : resolveFileReference(target.split(/[?#]/, 1)[0]!, directory)?.path, [target, directory]);
  const [attempt, setAttempt] = useState(0);
  const [failedMedia, setFailedMedia] = useState<{ client: unknown; path: string | undefined } | null>(null);

  const fileId = target === undefined ? undefined : parseDaemonFileRefFileId(target);
  const localPath = fileId === undefined ? path : undefined;
  const mediaItem = useMemo<MediaRef>(() => ({ kind: 'image', path: localPath }), [localPath]);
  const load = useSessionMedia(mediaItem, preview?.sessionId, localPath !== undefined && client !== undefined, true, attempt);
  const failure = failedMedia !== null && failedMedia.client === client && failedMedia.path === path;
  const failedRef = useRef(false);
  failedRef.current = failure || load.status === 'failed';
  useMediaReady(mediaOutcomeKey({ sessionId: preview?.sessionId, fileId, path: localPath, url: localPath === undefined && typeof src === 'string' ? src : undefined }), () => {
    if (fileId !== undefined || !failedRef.current) return;
    setFailedMedia(null);
    setAttempt((value) => value + 1);
  });
  const name = safeImagePreviewName({ metadataName: load.status === 'ready' ? load.name : undefined, path });
  const galleryItem = useMemo<MediaRef>(() => ({ kind: 'image', fileId, path: localPath, url: localPath === undefined && typeof src === 'string' ? src : undefined, name }), [fileId, localPath, src, name]);
  const offset = (_node as { position?: { start?: { offset?: number } } } | undefined)?.position?.start?.offset ?? 0;
  const openImage = useGalleryImage(galleryItem, 0, undefined, offset);
  useRecordRenderedImage(typeof src === 'string' && src !== '' ? src : undefined);
  const label = name ?? t('media.image');
  const description = safeImagePreviewName({ name: alt }) ?? label;
  const url = path === undefined ? src : load.status === 'ready' ? load.url : undefined;
  const imageMenu = useMessageImageMenu(galleryItem, typeof url === 'string' ? url : undefined, description);
  if (fileId !== undefined) return <MediaPart item={{ kind: 'image', fileId }} />;

  if (path !== undefined && (load.status === 'failed' || failure)) {
    return (
      <button
        type="button"
        onClick={() => {
          setFailedMedia(null);
          setAttempt((value) => value + 1);
        }}
        className="kiki-md-img-retry inline-flex min-h-7 items-center gap-1 rounded-lg border border-hairline bg-panel px-2.5 py-1 font-sans text-[12px] text-ink-faint transition-colors hover:border-hairline-strong hover:text-ink"
      >
        {t('preview.failed')} · {t('transcript.detail.retry')}
      </button>
    );
  }

  const content = <img {...props} data-markdown-image="" src={url} alt={description} decoding="async" onContextMenu={imageMenu.openMenu} onError={() => { setFailedMedia({ client, path }); }} className="kiki-md-img max-w-full h-auto" />;
  if (preview === null) return <>{content}{imageMenu.menuElement}</>;
  return (
    <><button
      type="button"
      title={label}
      aria-label={label}
      className="kiki-md-img-trigger inline-block max-w-full bg-transparent p-0 align-middle focus-visible:outline-2 focus-visible:outline-selected-ink"
      onClick={() => {
        if (typeof url === 'string') openImage(url);
      }}
    >
      {content}
    </button>{imageMenu.menuElement}</>
  );
}
