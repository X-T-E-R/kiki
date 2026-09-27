import { useEffect, useMemo, useState, type ComponentProps } from 'react';

import { resolveFileReference, unwrapFileLinkTarget } from '@kiki/session-core/composer/media';

import { useOptionalConnection } from '../../state/connection';

type ImageProps = ComponentProps<'img'>;

export function MarkdownFileImage({ src, documentDirectory, ...props }: ImageProps & {
  documentDirectory: string;
}) {
  const client = useOptionalConnection()?.client;
  const target = typeof src === 'string' ? unwrapFileLinkTarget(src) ?? src : undefined;
  const path = useMemo(() => target === undefined
    ? undefined
    : resolveFileReference(target.split(/[?#]/, 1)[0]!, documentDirectory)?.path, [target, documentDirectory]);
  const [image, setImage] = useState<{ client: typeof client; path: string; url: string }>();

  useEffect(() => {
    if (path === undefined || client === undefined) return;
    let active = true;
    let objectUrl: string | undefined;
    void client.readHostFileBytes(path).then(({ bytes, mime }) => {
      if (!active || !mime.startsWith('image/')) return;
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
      setImage({ client, path, url: objectUrl });
    }).catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [client, path]);

  if (path !== undefined) return <img {...props} src={image !== undefined && image.client === client && image.path === path ? image.url : undefined} />;
  return <img {...props} src={src} />;
}
