/**
 * Full-resolution image preview tab.
 */

import { useEffect, useState } from 'react';

import { basenameOf, formatBytes } from '@kiki/session-core/composer/media';
import { useI18n } from '#/i18n';
import { useOptionalConnection } from '#/state/connection';
import type { PreviewReadState } from '#/state/previewResource';
import { Icon } from '../icons';
import { ImageViewport } from '../ImageViewport';
import { useMessageImageMenu } from '../mediaParts';
import { TabPathCaption } from './shared';

export function ImageTabView({
  path,
  onOpenImage,
  onReadStateChange,
}: {
  readonly path: string;
  readonly onOpenImage: (src: string, name?: string, sourcePath?: string) => void;
  readonly onReadStateChange?: (state: PreviewReadState) => void;
}) {
  const { t } = useI18n();
  const client = useOptionalConnection()?.client;
  const name = basenameOf(path);
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'error' }
    | { readonly status: 'ready'; readonly url: string; readonly size: number }
  >({ status: 'loading' });
  const imageMenu = useMessageImageMenu({ kind: 'image', path, name }, state.status === 'ready' ? state.url : undefined, name);

  useEffect(() => {
    const status = state.status === 'error' ? 'failed' : state.status;
    onReadStateChange?.({
      status,
      readableFromDevice: status !== 'failed',
      originalReadable: status !== 'failed',
    });
  }, [state.status, onReadStateChange]);

  // The tab shows the original bytes: a downscaled preview thumbnail here is
  // what made full-size screenshots unreadable.
  useEffect(() => {
    if (client === undefined) {
      setState({ status: 'error' });
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    setState({ status: 'loading' });
    client.readHostFileBytes(path).then(
      ({ bytes, mime }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
        setState({ status: 'ready', url: objectUrl, size: bytes.byteLength });
      },
      () => {
        if (!cancelled) setState({ status: 'error' });
      },
    );
    return () => {
      cancelled = true;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [client, path]);

  if (state.status !== 'ready') {
    return (
      <>
        <TabPathCaption path={path} />
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {state.status === 'loading' ? (
            <p className="flex items-center gap-2 text-[12px] text-ink-faint">
              <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
              {t('preview.loading')}
            </p>
          ) : (
            <p className="text-[12.5px] text-danger">{t('preview.failed')}</p>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <ImageViewport
        src={state.url}
        alt={name}
        caption={<span title={path}>{path}</span>}
        meta={formatBytes(state.size)}
        onContextMenu={imageMenu.openMenu}
        onError={() => { setState({ status: 'error' }); }}
        actions={
          <button
            type="button"
            onClick={() => { onOpenImage(state.url, name, path); }}
            title={t('media.viewImage')}
            aria-label={t('media.viewImage')}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
          >
            <Icon name="eye" size={14} />
          </button>
        }
      />
      {imageMenu.menuElement}
    </>
  );
}
