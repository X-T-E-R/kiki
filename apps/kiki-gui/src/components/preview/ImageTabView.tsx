/**
 * Full-resolution image preview tab.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { basenameOf, formatBytes } from '@kiki/session-core/composer/media';
import { useHost } from '#/host';
import { useI18n } from '#/i18n';
import { useOptionalConnection } from '#/state/connection';
import { classifyHostFileReadError } from '#/state/hostFileEditor';
import type { PreviewReadFailureReason, PreviewReadState } from '#/state/previewResource';
import { Icon } from '../icons';
import { ImageViewport } from '../ImageViewport';
import { useMessageImageMenu } from '../mediaParts';
import {
  CAPTION_ACTION_CLASS,
  ChangedOnDiskStrip,
  DelayedReadingNotice,
  downloadHostFile,
  isLocalKikiComputer,
  PreviewReadFailureView,
  readPreviewFileBytes,
} from './shared';

export function ImageTabView({
  path,
  sessionId,
  workspaceRoot,
  visible = true,
  fileWriteEpoch = 0,
  externalReloadNonce,
  onOpenImage,
  onCloseTab,
  onReadStateChange,
}: {
  readonly path: string;
  readonly sessionId?: string;
  readonly workspaceRoot?: string;
  readonly visible?: boolean;
  readonly fileWriteEpoch?: number;
  readonly externalReloadNonce?: number;
  readonly onOpenImage: (src: string, name?: string, sourcePath?: string) => void;
  readonly onCloseTab?: () => void;
  readonly onReadStateChange?: (state: PreviewReadState) => void;
}) {
  const host = useHost();
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const localKikiComputer = isLocalKikiComputer(connection);
  const name = basenameOf(path);
  const [attempt, setAttempt] = useState(0);
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'error'; readonly reason: PreviewReadFailureReason }
    | { readonly status: 'ready'; readonly url: string; readonly size: number; readonly etag?: string }
  >({ status: 'loading' });
  const imageMenu = useMessageImageMenu(
    { kind: 'image', path, name },
    state.status === 'ready' ? state.url : undefined,
    name,
  );

  const reload = useCallback(() => {
    setChangedOnDisk(false);
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (externalReloadNonce !== undefined && externalReloadNonce > 0) reload();
  }, [externalReloadNonce, reload]);

  useEffect(() => {
    const status = state.status === 'error' ? 'failed' : state.status;
    const reason = state.status === 'error' ? state.reason : undefined;
    onReadStateChange?.({
      status,
      readableFromDevice: status !== 'failed' && reason !== 'remote-unreadable',
      originalReadable: status !== 'failed' && reason !== 'remote-unreadable',
      failureReason: reason,
    });
  }, [state, onReadStateChange]);

  useEffect(() => {
    if (client === undefined) {
      setState({ status: 'error', reason: 'error' });
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    setChangedOnDisk(false);
    setState({ status: 'loading' });
    readPreviewFileBytes(client, path, { sessionId, workspaceRoot, localKikiComputer }).then(
      ({ bytes, mime, etag }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
        setState({ status: 'ready', url: objectUrl, size: bytes.byteLength, etag });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', reason: classifyHostFileReadError(error) });
      },
    );
    return () => {
      cancelled = true;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [attempt, client, localKikiComputer, path, sessionId, workspaceRoot]);

  const checkDiskChange = useCallback(async () => {
    if (client === undefined || state.status !== 'ready' || state.etag === undefined) return;
    try {
      const probe = await readPreviewFileBytes(
        client,
        path,
        { sessionId, workspaceRoot, localKikiComputer },
        { ifNoneMatch: state.etag },
      );
      if (probe.notModified === true || probe.etag === state.etag) return;
      if (probe.etag !== undefined && probe.etag !== state.etag) {
        setChangedOnDisk(true);
      }
    } catch {
      // Ignore transient conditional-probe errors; explicit Reload shows any failure.
    }
  }, [client, localKikiComputer, path, sessionId, state, workspaceRoot]);

  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    const becameVisible = visible && !prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (becameVisible) void checkDiskChange();
  }, [visible, checkDiskChange]);

  const prevWriteEpochRef = useRef(fileWriteEpoch);
  useEffect(() => {
    if (fileWriteEpoch !== prevWriteEpochRef.current) {
      prevWriteEpochRef.current = fileWriteEpoch;
      void checkDiskChange();
    }
  }, [fileWriteEpoch, checkDiskChange]);

  useEffect(() => {
    if (!visible) return undefined;
    const onFocus = () => { void checkDiskChange(); };
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('focus', onFocus); };
  }, [visible, checkDiskChange]);

  if (state.status !== 'ready') {
    const readFailed = state.status === 'error';
    const failureReason = state.status === 'error' ? state.reason : undefined;
    return (
      <>
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={path}>
            {name}
          </span>
          <button
            type="button"
            title={t('preview.reloadFile')}
            aria-label={t('preview.reloadFile')}
            data-header-reload
            onClick={reload}
            className={CAPTION_ACTION_CLASS}
          >
            <Icon name="refresh" size={12} />
          </button>
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
              onDownload={
                failureReason === 'corrupted' && client !== undefined
                  ? () => {
                      void downloadHostFile(host, client, path, name, t, {
                        sessionId,
                        workspaceRoot,
                        localKikiComputer,
                      });
                    }
                  : undefined
              }
            />
          ) : null}
        </div>
      </>
    );
  }

  return (
    <>
      {changedOnDisk ? <ChangedOnDiskStrip onReload={reload} /> : null}
      <ImageViewport
        src={state.url}
        alt={name}
        caption={<span title={path}>{name}</span>}
        meta={formatBytes(state.size)}
        onContextMenu={imageMenu.openMenu}
        onError={() => { setState({ status: 'error', reason: 'corrupted' }); }}
        actions={
          <>
            <button
              type="button"
              onClick={reload}
              title={t('preview.reloadFile')}
              aria-label={t('preview.reloadFile')}
              data-header-reload
              className={CAPTION_ACTION_CLASS}
            >
              <Icon name="refresh" size={12} />
            </button>
            <button
              type="button"
              onClick={() => { onOpenImage(state.url, name, path); }}
              title={t('media.viewImage')}
              aria-label={t('media.viewImage')}
              className={CAPTION_ACTION_CLASS}
            >
              <Icon name="eye" size={14} />
            </button>
          </>
        }
      />
      {imageMenu.menuElement}
    </>
  );
}
