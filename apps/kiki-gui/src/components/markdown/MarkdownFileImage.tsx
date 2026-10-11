import { useMemo, useState, type ComponentProps } from 'react';

import { resolveFileReference, unwrapFileLinkTarget, type MediaRef } from '@kiki/session-core/composer/media';
import { parseDaemonFileRefFileId } from '@kiki/transcript';

import { useI18n } from '../../i18n';
import { useOptionalConnection } from '../../state/connection';
import { safeImagePreviewName } from '../imagePreviewName';
import { MediaPart, useSessionMedia } from '../mediaParts';
import { useMediaPreview } from '../mediaPreviewContext';

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
  if (fileId !== undefined) return <MediaPart item={{ kind: 'image', fileId }} />;

  const name = safeImagePreviewName({ metadataName: load.status === 'ready' ? load.name : undefined, path });
  const label = name ?? t('media.image');
  const description = safeImagePreviewName({ name: alt }) ?? label;

  if (path !== undefined && (load.status === 'failed' || failure)) {
    return (
      <button
        type="button"
        onClick={() => {
          setFailedMedia(null);
          setAttempt((value) => value + 1);
        }}
        className="text-[12px] text-ink-faint hover:text-ink hover:underline"
      >
        {t('preview.failed')} · {t('transcript.detail.retry')}
      </button>
    );
  }

  const url = path === undefined ? src : load.status === 'ready' ? load.url : undefined;
  const content = <img {...props} src={url} alt={description} decoding="async" onError={() => { setFailedMedia({ client, path }); }} className="max-w-full h-auto" />;
  if (preview === null) return content;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="inline-block max-w-full bg-transparent p-0 align-middle focus-visible:outline-2 focus-visible:outline-selected-ink"
      onClick={() => {
        if (typeof url === 'string') preview.openImage(url, name);
      }}
    >
      {content}
    </button>
  );
}
