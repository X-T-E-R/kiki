/**
 * The document tab: a page, sheet or text window of a real file, in place.
 *
 * The header is the same quiet caption strip the other tabs use, plus the
 * page/sheet control and — when the server says it — the fidelity label. A
 * `text` answer is marked as the file's own characters rather than a rendered
 * page, because those are different things and the user is deciding whether
 * the layout matters. A blocked renderer offers one recovery action that goes
 * through this home's Work setup, not a second install flow.
 */

import { useMemo } from 'react';

import type { DocumentPreviewResponse } from '@kiki/protocol';
import { basenameOf } from '@kiki/session-core/composer/media';

import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';
import { Icon } from '../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { documentSourceFor, sheetsOf, useDocumentPreview, type DocumentPreviewController } from './documentPreview';
import { PreviewAssetImage } from './PreviewAssetImage';
import { RendererInstall } from './RendererInstall';
import { PdfPageView } from './PdfPageView';

export type DocumentTabSource =
  | { readonly kind: 'workspace'; readonly path: string; readonly runtimeId?: string }
  | { readonly kind: 'session-media'; readonly fileId: string; readonly name?: string; readonly mediaType?: string };

const CAPTION = 'flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5';

export interface DocumentTabViewProps {
  readonly source: DocumentTabSource;
  /** Which session's renderer and asset route serve this file. */
  readonly sessionId?: string;
  /** The connection that owns the file; its client carries the bearer token. */
  readonly client?: KikiClient;
  /**
   * Offered only where the user has no way to reach the plugin's own settings;
   * the recovery itself installs the one prerequisite directly, so it never
   * depends on a work mode being enabled.
   */
  readonly onOpenPluginSettings?: () => void;
  /**
   * The original file, for a format nothing here can render. The user keeps a
   * way to act on their document even when the preview cannot show it.
   */
  readonly onOpenLocally?: () => void;
  readonly onDownload?: () => void;
}

/** The server's own words, so the view never invents a capability. */
function reasonCopy(response: Extract<DocumentPreviewResponse, { kind: 'unsupported' }>, locale: 'en' | 'zh'): string {
  if (locale === 'zh') {
    return {
      format: '这个格式没有内置预览。',
      source_too_large: '文件太大，无法一次渲染。',
      remote_renderer_unavailable: '远程服务上没有渲染器。',
      binary_content: '这不是文本文件。',
    }[response.reason];
  }
  return {
    format: 'This format has no built-in preview.',
    source_too_large: 'The file is too large to render in one piece.',
    remote_renderer_unavailable: 'The renderer is not available on this connection.',
    binary_content: 'This file does not contain text.',
  }[response.reason];
}

/** What the user calls this kind of file, for the one recovery sentence. */
function extensionLabel(dependency: 'officecli'): string {
  return dependency === 'officecli' ? 'Word, Excel and PowerPoint' : dependency;
}

function PageControl({ controller, response }: { controller: DocumentPreviewController; response: Extract<DocumentPreviewResponse, { kind: 'ready' }> }) {
  const { t } = useI18n();
  const nav = response.navigation;
  if (nav.kind === 'page') {
    // The server's count when it sent one, otherwise the count the PDF
    // renderer reported once the file was open — otherwise the last page of a
    // long PDF is unreachable.
    const count = nav.page_count ?? controller.numPages;
    return (
      <span className="flex items-center gap-1" data-preview-page-control>
        <button
          type="button"
          disabled={!controller.canStepBack}
          aria-label={t('preview.previousPage')}
          onClick={() => { controller.step(-1); }}
          className="flex h-6 w-6 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-30"
        >
          <Icon name="chevron" size={14} className="rotate-180" />
        </button>
        <span className="min-w-[4.5rem] text-center font-mono text-[11px] text-ink-soft">
          {t('preview.pageOf', { page: String(nav.page), count: count === undefined ? '…' : String(count) })}
        </span>
        <button
          type="button"
          disabled={!controller.canStepForward}
          aria-label={t('preview.nextPage')}
          onClick={() => { controller.step(1); }}
          className="flex h-6 w-6 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-30"
        >
          <Icon name="chevron" size={14} />
        </button>
      </span>
    );
  }
  const sheets = sheetsOf(response);
  if (sheets.length === 0) return null;
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-ink-faint">
      <span className="sr-only">{t('preview.sheet')}</span>
      <select
        value={nav.sheet ?? ''}
        onChange={(event) => { controller.goTo({ sheet: event.target.value, page: undefined }); }}
        className="max-w-[9rem] truncate rounded-md border border-hairline bg-paper px-1.5 py-0.5 text-[11.5px] text-ink outline-none focus:border-accent"
      >
        {sheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}
      </select>
    </label>
  );
}

export function DocumentTabView({ source, sessionId, client: clientProp, onOpenPluginSettings, onOpenLocally, onDownload }: DocumentTabViewProps) {
  const { t, locale } = useI18n();
  // The client is a prop, not a context read: the tab already knows which
  // session owns the file, and a caller outside the live connection (a test, a
  // proof run) must be able to supply the same client the shell would.
  const client = clientProp;
  const documentSource = useMemo(() => (
    source.kind === 'workspace'
      ? documentSourceFor({ path: source.path, runtimeId: source.runtimeId })
      : documentSourceFor({ fileId: source.fileId, name: source.name, mediaType: source.mediaType })
  ), [source]);
  const controller = useDocumentPreview(client, sessionId, documentSource);
  const { state } = controller;
  // The caption names what the user recognises. A session attachment's
  // file id is an internal handle, never something to put in front of them.
  const name = source.kind === 'workspace'
    ? basenameOf(source.path)
    : (state.kind === 'ready' ? state.response.source.name : undefined) ?? source.name ?? basenameOf(source.fileId);
  const path = source.kind === 'workspace' ? source.path : name;

  const header = (
    <div className={CAPTION}>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={path}>{path}</span>
      {state.kind === 'ready' && state.response.kind === 'ready' ? <PageControl controller={controller} response={state.response} /> : null}
      {state.kind === 'ready' && state.response.kind === 'text' ? (
        <span className="shrink-0 rounded-[3px] bg-hairline/60 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-soft" data-preview-fidelity="source">
          {t('preview.fidelitySource')}
        </span>
      ) : null}
    </div>
  );

  if (state.kind === 'loading') {
    return (
      <>
        {header}
        <div className="min-h-0 flex-1 overflow-auto p-4" data-preview-document-loading>
          <div className="mx-auto max-w-[680px] space-y-2.5" aria-hidden>
            <div className="h-3 w-2/3 rounded-[3px] bg-hairline/70" />
            <div className="h-3 w-full rounded-[3px] bg-hairline/50" />
            <div className="h-3 w-5/6 rounded-[3px] bg-hairline/50" />
            <div className="h-3 w-1/2 rounded-[3px] bg-hairline/50" />
          </div>
          <p className="sr-only" aria-live="polite">{t('preview.rendering')}</p>
        </div>
      </>
    );
  }

  if (state.kind === 'failed') {
    return (
      <>
        {header}
        <div className="flex min-h-0 flex-1 flex-col items-start gap-3 p-4" data-preview-document-failed>
          <p className="text-[12.5px] text-ink-soft">{state.message}</p>
          <button type="button" onClick={controller.retry} className={SECONDARY_BUTTON}>{t('preview.tryAgain')}</button>
        </div>
      </>
    );
  }

  const response = state.response;

  if (response.kind === 'ready') {
    // A PDF the server did not rasterize is rendered here from the asset it
    // returned. The bytes are read through the client, so an attached PDF and
    // a PDF in the workspace take one authenticated path and neither falls
    // back to a local path read.
    if (response.renderer === 'browser-pdf') {
      const asset = response.assets[0];
      if (asset === undefined) {
        return (
          <>
            {header}
            <div className="flex min-h-0 flex-1 flex-col items-start gap-3 p-4" data-preview-document-unsupported>
              <p className="text-[12.5px] text-ink-soft">{t('preview.failed')}</p>
            </div>
          </>
        );
      }
      const page = response.navigation.kind === 'page' ? response.navigation.page : (controller.page ?? 1);
      return (
        <>
          {header}
          <div
            className="min-h-0 flex-1 overflow-auto bg-canvas px-4 py-5"
            data-preview-document
            data-fidelity={response.fidelity}
            data-format={response.format}
            data-renderer="browser-pdf"
            data-source={response.source.kind}
          >
            <PdfPageView
              client={client}
              assetUrl={asset.url}
              page={page}
              name={name}
              onPageCount={controller.setNumPages}
              onRetry={controller.retry}
            />
          </div>
        </>
      );
    }
    return (
      <>
        {header}
        <div className="min-h-0 flex-1 overflow-auto bg-canvas px-4 py-5" data-preview-document data-fidelity={response.fidelity} data-format={response.format} data-renderer={response.renderer}>
          {response.assets.map((asset) => (
            <PreviewAssetImage
              key={asset.asset_id}
              client={client}
              url={asset.url}
              alt={t('preview.pageAlt', { name, page: response.navigation.kind === 'page' ? String(response.navigation.page) : '' })}
              width={asset.width}
              height={asset.height}
            />
          ))}
        </div>
      </>
    );
  }

  if (response.kind === 'text') {
    return (
      <>
        {header}
        <div className="flex min-h-0 flex-1 flex-col" data-preview-document data-fidelity={response.fidelity} data-format={response.format}>
          <p className="shrink-0 border-b border-hairline px-3 py-1.5 text-[11.5px] text-ink-faint">
            {t('preview.sourceTextNotice', { name })}
          </p>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2.5 font-mono text-[12px] leading-[1.55] text-ink-soft">{response.content}</pre>
          {response.truncated ? (
            <div className="shrink-0 border-t border-hairline px-3 py-2">
              <button
                type="button"
                onClick={() => { controller.goTo({ offset: response.next_offset ?? response.offset }); }}
                className={SECONDARY_BUTTON}
              >
                {t('preview.loadMore')}
              </button>
            </div>
          ) : null}
        </div>
      </>
    );
  }

  if (response.kind === 'missing_dependency') {
    return (
      <>
        {header}
        <div className="flex min-h-0 flex-1 flex-col items-start gap-3 p-4" data-preview-document-missing data-dependency={response.dependency}>
          <p className="text-[12.5px] text-ink-soft">{response.message}</p>
          <p className="text-[11.5px] leading-[1.5] text-ink-faint">{t('preview.rendererShared', { name: extensionLabel(response.dependency) })}</p>
          <RendererInstall
            client={client}
            pluginId={response.recovery.plugin_id}
            prerequisiteId={response.recovery.prerequisite_id}
            pluginState={response.recovery.plugin_state}
            fileName={name}
            onInstalled={controller.retry}
          />
          {onOpenPluginSettings !== undefined ? (
            <button type="button" onClick={onOpenPluginSettings} className="text-[11.5px] text-ink-faint underline underline-offset-2 hover:text-ink">
              {t('preview.pluginSettings')}
            </button>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="flex min-h-0 flex-1 flex-col items-start gap-3 p-4" data-preview-document-unsupported data-format={response.format}>
        <p className="text-[12.5px] text-ink-soft">{reasonCopy(response, locale)}</p>
        <p className="font-mono text-[11px] text-ink-faint">{name}</p>
        <p className="text-[11.5px] leading-[1.5] text-ink-faint">{t('preview.legacyFormats')}</p>
        <div className="flex flex-wrap items-center gap-2">
          {onDownload !== undefined ? (
            <button type="button" onClick={onDownload} className={PRIMARY_BUTTON} data-download-original>{t('media.download')}</button>
          ) : null}
          {onOpenLocally !== undefined ? (
            <button type="button" onClick={onOpenLocally} className={SECONDARY_BUTTON} data-open-locally>{t('file.openDefaultApp')}</button>
          ) : null}
        </div>
      </div>
    </>
  );
}
