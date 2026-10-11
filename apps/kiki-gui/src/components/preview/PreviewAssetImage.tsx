/**
 * One rendered document page, read over the connection it lives on.
 *
 * The server's asset route sits behind the same bearer gate as the rest of
 * `/api`, so a plain `<img src>` would be refused, and a remote scope would
 * resolve the path against this page's origin instead of the remote host. The
 * bytes therefore come from the client and the element is fed an object URL
 * that is revoked with the component.
 *
 * A failure says what happened and offers the one thing that can fix it,
 * because a page that silently stays blank is the worst outcome here.
 */

import { useEffect, useState } from 'react';

import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';

export interface PreviewAssetImageProps {
  readonly client: KikiClient | undefined;
  readonly url: string;
  readonly alt: string;
  readonly width?: number;
  readonly height?: number;
}

export function PreviewAssetImage({ client, url, alt, width, height }: PreviewAssetImageProps) {
  const { t } = useI18n();
  const [objectUrl, setObjectUrl] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (client === undefined) return;
    let cancelled = false;
    let created: string | undefined;
    setFailed(false);
    setObjectUrl(undefined);
    client.readDocumentPreviewAsset(url).then(({ bytes, mime }) => {
      if (cancelled) return;
      created = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      setObjectUrl(created);
    }, () => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      if (created !== undefined) URL.revokeObjectURL(created);
    };
  }, [attempt, client, url]);

  if (failed) {
    return (
      <div className="mx-auto w-full max-w-[900px] rounded-lg border border-danger bg-[#fbeceb] px-3 py-2.5" role="alert" data-preview-asset-failed>
        <p className="text-[12px] text-danger">{t('preview.assetFailed')}</p>
        <button
          type="button"
          onClick={() => { setAttempt((value) => value + 1); }}
          className="mt-1.5 text-[12px] font-medium text-danger underline underline-offset-2"
        >
          {t('preview.tryAgain')}
        </button>
      </div>
    );
  }

  if (objectUrl === undefined) {
    return (
      <div className="mx-auto w-full max-w-[900px] space-y-2.5" aria-hidden data-preview-asset-loading>
        <div className="h-3 w-2/3 rounded-[3px] bg-hairline/70" />
        <div className="h-3 w-full rounded-[3px] bg-hairline/50" />
        <div className="h-3 w-5/6 rounded-[3px] bg-hairline/50" />
      </div>
    );
  }

  return (
    <img
      src={objectUrl}
      alt={alt}
      width={width}
      height={height}
      data-preview-asset
      className="mx-auto h-auto w-full max-w-[900px] rounded-[3px] shadow-[var(--kiki-sheet-shadow)]"
    />
  );
}
