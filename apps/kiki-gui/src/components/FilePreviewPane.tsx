/**
 * FilePreviewPane — right slide-over for host files (transcript links, tool
 * card paths). Content comes from `GET /api/v1/fs:content` via the client:
 * images load as bytes (the endpoint needs the bearer header, so a bare
 * <img src> is not an option), markdown renders, code/text shows in a mono
 * read-only view, and unknown binary types get a download-only fallback.
 * Large text files are capped with a truncation notice.
 */

import { useEffect, useState } from 'react';

import { useI18n } from '../i18n';
import { isDesktopRuntime, saveBlobNative } from '../lib/desktop';
import { basenameOf, formatBytes, previewKindOf } from '../lib/media';
import { useOptionalConnection } from '../state/connection';
import { Dialog } from './Dialog';
import { Markdown } from './Markdown';

/** Text previews render at most this many characters. */
const MAX_TEXT_CHARS = 256_000;

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'text'; readonly text: string; readonly truncated: boolean }
  | { readonly status: 'image'; readonly url: string; readonly bytes: Uint8Array; readonly mime: string }
  | { readonly status: 'unsupported' };

export function FilePreviewPane({
  path,
  onClose,
  onOpenImage,
}: {
  path: string;
  onClose: () => void;
  /** Image bodies can escalate to the fullscreen lightbox. */
  onOpenImage?: (src: string, name?: string) => void;
}) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const kind = previewKindOf(path);
  const name = basenameOf(path);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    const client = connection?.client;
    let cancelled = false;
    let objectUrl: string | undefined;
    setState({ status: 'loading' });
    if (client === undefined) {
      setState({ status: 'error', message: t('preview.failed') });
      return;
    }
    if (kind === 'binary') {
      setState({ status: 'unsupported' });
      return;
    }
    if (kind === 'image') {
      client.readHostFileBytes(path).then(
        ({ bytes, mime }) => {
          if (cancelled) return;
          objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
          setState({ status: 'image', url: objectUrl, bytes, mime });
        },
        (error: unknown) => {
          if (!cancelled) setState({ status: 'error', message: String(error) });
        },
      );
    } else {
      client.readHostFile(path).then(
        (text) => {
          if (cancelled) return;
          const truncated = text.length > MAX_TEXT_CHARS;
          setState({ status: 'text', text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated });
        },
        (error: unknown) => {
          if (!cancelled) setState({ status: 'error', message: String(error) });
        },
      );
    }
    return () => {
      cancelled = true;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [connection, path, kind, t]);

  const download = async () => {
    const client = connection?.client;
    if (client === undefined) return;
    try {
      const blob =
        state.status === 'image'
          ? new Blob([state.bytes as BlobPart], { type: state.mime })
          : state.status === 'text'
            ? new Blob([state.text], { type: 'text/plain' })
            : await client
                .readHostFileBytes(path)
                .then(({ bytes, mime }) => new Blob([bytes as BlobPart], { type: mime }));
      if (isDesktopRuntime()) {
        try {
          await saveBlobNative(blob, name);
          return;
        } catch {
          // Fall through to the browser download.
        }
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setState({ status: 'error', message: t('preview.failed') });
    }
  };

  return (
    <Dialog
      onClose={onClose}
      ariaLabel={t('preview.openFile', { name })}
      overlayId="file-preview"
      overlayClassName="fixed inset-0 z-50 flex justify-end bg-ink/20"
      panelClassName="anim-enter flex h-full w-[min(560px,94vw)] flex-col border-l border-hairline bg-panel shadow-[-16px_0_48px_-24px_rgba(28,25,23,0.4)] outline-none"
    >
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-ink">{name}</p>
          <p className="truncate font-mono text-[10.5px] text-ink-faint" title={path}>
            {path}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void download()}
          className="shrink-0 rounded-full border border-hairline px-2.5 py-1 text-[11px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent"
        >
          {t('media.download')}
        </button>
        <button
          type="button"
          data-autofocus
          onClick={onClose}
          aria-label={t('common.close')}
          className="shrink-0 rounded-full border border-hairline px-2.5 py-1 text-[11px] text-ink-soft transition-colors hover:border-accent hover:text-accent"
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {state.status === 'loading' ? (
          <div className="flex items-center gap-2 text-[12px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('preview.loading')}
          </div>
        ) : state.status === 'error' ? (
          <p className="text-[12.5px] text-danger">{t('preview.failed')}</p>
        ) : state.status === 'unsupported' ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-[12.5px] text-ink-soft">{t('preview.unsupported')}</p>
            <button
              type="button"
              onClick={() => void download()}
              className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent-deep"
            >
              {t('media.download')}
            </button>
          </div>
        ) : state.status === 'image' ? (
          <button
            type="button"
            onClick={() => { onOpenImage?.(state.url, name); }}
            className="block"
            title={t('media.viewImage')}
          >
            <img
              src={state.url}
              alt={name}
              className="max-h-[70vh] rounded-lg border border-hairline object-contain"
            />
            <span className="mt-1 block font-mono text-[10.5px] text-ink-faint">
              {formatBytes(state.bytes.byteLength)}
            </span>
          </button>
        ) : state.status === 'text' && kind === 'markdown' ? (
          <Markdown text={state.text} />
        ) : state.status === 'text' ? (
          <pre className="rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink">
            {state.text}
          </pre>
        ) : null}
        {state.status === 'text' && state.truncated ? (
          <p className="mt-2 text-[11px] text-ink-faint">{t('preview.truncated')}</p>
        ) : null}
      </div>
    </Dialog>
  );
}
