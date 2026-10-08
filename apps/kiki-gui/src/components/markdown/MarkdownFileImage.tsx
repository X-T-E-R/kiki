import { useEffect, useMemo, useState, type ComponentProps } from 'react';

import { resolveFileReference, unwrapFileLinkTarget } from '@kiki/session-core/composer/media';
import { parseDaemonFileRefFileId } from '@kiki/transcript';

import { useI18n } from '../../i18n';
import { useOptionalConnection } from '../../state/connection';
import { safeImagePreviewName } from '../imagePreviewName';
import { MediaPart } from '../mediaParts';
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
  const path = useMemo(() => target === undefined || directory === undefined
    ? undefined
    : resolveFileReference(target.split(/[?#]/, 1)[0]!, directory)?.path, [target, directory]);
  const [image, setImage] = useState<{ client: typeof client; path: string; url: string }>();
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState(false);

  useEffect(() => {
    setFailure(false);
    if (path === undefined || client === undefined) return;
    let active = true;
    let objectUrl: string | undefined;
    void client.readHostFileBytes(path).then(({ bytes, mime }) => {
      if (!active) return;
      if (!mime.startsWith('image/')) { setFailure(true); return; }
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
      setImage({ client, path, url: objectUrl });
    }).catch(() => { if (active) setFailure(true); });
    return () => {
      active = false;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [client, path, target, attempt]);

  const fileId = target === undefined ? undefined : parseDaemonFileRefFileId(target);
  if (fileId !== undefined) return <MediaPart item={{ kind: 'image', fileId }} />;
  const name = safeImagePreviewName({ path });
  const label = name ?? t('media.image');
  const description = safeImagePreviewName({ name: alt }) ?? label;
  const url = path === undefined ? src : image?.client === client && image.path === path ? image.url : undefined;
  if (failure) return <button type="button" onClick={() => { setFailure(false); setAttempt((value) => value + 1); }}>{t('preview.failed')} · {t('transcript.detail.retry')}</button>;
  const content = <img {...props} src={url} alt={description} decoding="async" onError={() => { setFailure(true); }} className="max-w-full h-auto" />;
  if (preview === null) return content;
  return <button type="button" title={label} aria-label={label} className="inline-block max-w-full bg-transparent p-0 align-middle focus-visible:outline-2 focus-visible:outline-selected-ink" onClick={() => { if (typeof url === 'string') preview.openImage(url, name); }}>{content}</button>;
}
