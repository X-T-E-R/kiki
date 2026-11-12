/**
 * Text, code, Markdown, and sandboxed HTML preview tab.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { basenameOf, type FileReference } from '@kiki/session-core/composer/media';
import { useHost } from '#/host';
import { useI18n } from '#/i18n';
import type { KikiClient } from '#/lib/client';
import { useOptionalConnection } from '#/state/connection';
import {
  HostFileEditorController,
  type HostFileEditorSnapshot,
} from '#/state/hostFileEditor';
import {
  resourceReadOnlyReason,
  type PreviewReadState,
} from '#/state/previewResource';
import { CodeEditor } from '../CodeEditor';
import { Icon } from '../icons';
import { Markdown } from '../Markdown';
import { HeaderFileActions } from './ResourceHeader';
import {
  buildFileTabResource,
  classifyHtmlPreviewError,
  isLocalKikiComputer,
  SandboxedHtmlPreview,
  type HtmlPreviewState,
} from './shared';

/** Whether the text tab can show an isolated document preview for this path. */
export function isHtmlPreviewPath(path: string): boolean {
  return /\.(?:html?|xhtml)$/iu.test(basenameOf(path));
}

interface HtmlRootDraftState {
  readonly client: KikiClient | undefined;
  readonly path: string;
  readonly workspaceRoot?: string;
  readonly input: string;
  readonly override?: string;
}

const IDLE_SNAPSHOT: HostFileEditorSnapshot = {
  status: 'loading',
  error: undefined,
  failureReason: undefined,
  savedText: '',
  draft: '',
  editing: false,
  dirty: false,
  saving: false,
  conflict: false,
  oversized: false,
  lossless: true,
  etag: undefined,
  generation: 0,
  lastSavedAt: undefined,
};

/**
 * Text/code/markdown/HTML tab: one HostFileEditorController per tab (created
 * when the connection's client is available), CodeMirror for source, the
 * Markdown renderer for rendered markdown, and a server-issued isolated
 * document origin for HTML.
 */
export function TextTabView({
  path,
  workspaceRoot,
  visible,
  markdown,
  navigation,
  reportDirty,
  onReadStateChange,
  onReadingReady,
}: {
  readonly path: string;
  readonly workspaceRoot?: string;
  readonly visible: boolean;
  readonly markdown: boolean;
  readonly navigation?: FileReference;
  readonly reportDirty: (path: string, dirty: boolean) => void;
  readonly onReadStateChange?: (state: PreviewReadState) => void;
  readonly onReadingReady: () => void;
}) {
  const host = useHost();
  const { locale, t } = useI18n();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const localKikiComputer = isLocalKikiComputer(connection);
  const remoteBrokerHtmlScope = connection?.connectionSource === 'remote';
  const html = isHtmlPreviewPath(path);
  const hasRenderedMode = markdown || html;
  const [controller, setController] = useState<HostFileEditorController | null>(null);
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');
  const [reloadKey, setReloadKey] = useState(0);
  const [htmlRootDraft, setHtmlRootDraft] = useState<HtmlRootDraftState>(() => ({
    client,
    path,
    workspaceRoot,
    input: workspaceRoot ?? '',
  }));
  const htmlRootDraftMatches = htmlRootDraft.client === client &&
    htmlRootDraft.path === path && htmlRootDraft.workspaceRoot === workspaceRoot;
  const htmlRootInput = htmlRootDraftMatches ? htmlRootDraft.input : workspaceRoot ?? '';
  const htmlRootOverride = htmlRootDraftMatches ? htmlRootDraft.override : undefined;
  const [htmlPreviewState, setHtmlPreviewState] = useState<HtmlPreviewState>({ status: 'idle' });
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fullMarkdown, setFullMarkdown] = useState<{
    controller: HostFileEditorController; client: KikiClient; path: string;
    generation: number; text: string;
  } | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState(false);
  const fullLoadId = useRef(0);
  const fullLoadAbort = useRef<AbortController | null>(null);
  const [headingFound, setHeadingFound] = useState(true);
  useEffect(() => {
    if (navigation?.line !== undefined) setMode('source');
    else if (navigation?.heading !== undefined) setMode('rendered');
  }, [navigation]);

  useEffect(() => {
    if (!html) {
      setHtmlPreviewState({ status: 'idle' });
      return undefined;
    }
    if (client === undefined) {
      setHtmlPreviewState({ status: 'loading' });
      return undefined;
    }
    let cancelled = false;
    let activePreviewId: string | null = null;
    setHtmlPreviewState({ status: 'loading' });
    const request = remoteBrokerHtmlScope && htmlRootOverride !== undefined
      ? { path, root: htmlRootOverride }
      : { path, workspace_root: workspaceRoot };
    client.openHtmlPreview(request).then(
      (response) => {
        if (cancelled) {
          void client.closeHtmlPreview(response.preview_id);
          return;
        }
        activePreviewId = response.preview_id;
        const resolvedUrl = new URL(response.url, client.baseUrl).toString();
        setHtmlPreviewState({
          status: 'ready',
          previewId: response.preview_id,
          url: resolvedUrl,
          sandbox: response.sandbox,
          expiresAt: response.expires_at,
        });
        const ttl = Math.max(0, response.expires_at - Date.now());
        if (expiryTimerRef.current !== null) clearTimeout(expiryTimerRef.current);
        expiryTimerRef.current = setTimeout(() => {
          if (!cancelled) setHtmlPreviewState({ status: 'error', error: new Error('html_preview_expired') });
        }, ttl);
      },
      (error: unknown) => {
        if (!cancelled) setHtmlPreviewState({ status: 'error', error });
      },
    );
    return () => {
      cancelled = true;
      if (expiryTimerRef.current !== null) {
        clearTimeout(expiryTimerRef.current);
        expiryTimerRef.current = null;
      }
      if (activePreviewId !== null) {
        void client.closeHtmlPreview(activePreviewId);
        activePreviewId = null;
      }
    };
  }, [client, html, path, reloadKey, remoteBrokerHtmlScope, htmlRootOverride, workspaceRoot]);

  useEffect(() => {
    if (client === undefined) {
      setController(null);
      return;
    }
    const next = new HostFileEditorController({
      path,
      readFile: (target, options) => client.previewHostFile(target, undefined, options),
      writeFile: host.writeFileText,
      local: localKikiComputer,
    });
    setController(next);
    void next.load();
    return () => {
      next.dispose();
      setController(null);
    };
  }, [client, host, localKikiComputer, path]);

  const subscribe = useMemo(
    () => controller?.subscribe ?? (() => () => {}),
    [controller],
  );
  // Stable fallback snapshot: useSyncExternalStore loops forever on a fresh
  // object per call while the controller is still being created.
  const getState = useMemo(
    () => controller?.getState ?? (() => IDLE_SNAPSHOT),
    [controller],
  );
  const snap = useSyncExternalStore(subscribe, getState);
  const textReadFailed = html
    ? snap.status === 'error' && htmlPreviewState.status === 'error'
    : snap.status === 'error';
  const currentReadState = useMemo<PreviewReadState>(() => {
    const status = textReadFailed
      ? 'failed'
      : snap.status === 'ready' || (html && htmlPreviewState.status === 'ready')
        ? 'ready'
        : 'loading';
    return {
      status,
      losslessUtf8: snap.lossless,
      truncated: snap.oversized,
      readableFromDevice: status !== 'failed' && snap.failureReason !== 'remote-unreadable',
      originalReadable: status !== 'failed' && snap.failureReason !== 'remote-unreadable',
      failureReason: status === 'failed' ? snap.failureReason : undefined,
    };
  }, [textReadFailed, snap.status, snap.lossless, snap.oversized, snap.failureReason, html, htmlPreviewState.status]);
  useEffect(() => {
    onReadStateChange?.(currentReadState);
  }, [currentReadState, onReadStateChange]);
  useEffect(() => {
    setLoadingFull(false);
    setFullError(false);
    return () => {
      fullLoadId.current += 1;
      fullLoadAbort.current?.abort();
      fullLoadAbort.current = null;
    };
  }, [client, controller, path, snap.generation, visible]);

  const dirty = snap.dirty;
  useEffect(() => {
    reportDirty(path, dirty);
    return () => { reportDirty(path, false); };
  }, [reportDirty, path, dirty]);

  const name = basenameOf(path);
  const editable = controller?.editable ?? false;
  const editing = snap.editing;
  const readOnlyReason = useMemo(() => {
    if (snap.status !== 'ready') return undefined;
    const resource = buildFileTabResource(path, workspaceRoot, snap.lossless);
    const reason = resourceReadOnlyReason(
      resource,
      {
        isKikiComputer: localKikiComputer,
        capabilities: { write: host.writeFileText !== undefined },
      },
      currentReadState,
    );
    return reason === undefined ? undefined : locale === 'zh' ? reason.zh : reason.en;
  }, [currentReadState, host.writeFileText, localKikiComputer, locale, path, snap.lossless, snap.status, workspaceRoot]);
  const showEditor = !hasRenderedMode || mode === 'source';
  const [sourceMounted, setSourceMounted] = useState(!hasRenderedMode);
  useEffect(() => { if (showEditor) setSourceMounted(true); }, [showEditor]);
  const fullText = fullMarkdown?.controller === controller && fullMarkdown.client === client &&
    fullMarkdown.path === path && fullMarkdown.generation === snap.generation
    ? fullMarkdown.text : undefined;
  const renderedMarkdown = useRef<{ controller: HostFileEditorController | null; text: string } | null>(null);
  if (renderedMarkdown.current?.controller !== controller) renderedMarkdown.current = null;
  // Keep the resident document while editing source, without parsing each edit
  // in the hidden view. The next rendered visit consumes the current draft.
  if (markdown && !showEditor && snap.status === 'ready') {
    renderedMarkdown.current = { controller, text: fullText ?? snap.draft };
  }
  const referenceOutside = useMemo(() => {
    if (navigation?.line === undefined) return false;
    const lines = (fullText ?? snap.draft).split(/\r\n|\r|\n/);
    return navigation.line > lines.length || (navigation.endLine ?? navigation.line) > lines.length ||
      (navigation.column ?? 1) > (lines[navigation.line - 1]?.length ?? 0) + 1;
  }, [navigation, fullText, snap.draft]);
  // The renderer, not a frame deadline, says when this tab's text is on screen;
  // an HTML tab is readable once its document origin is live.
  useEffect(() => {
    if (html) {
      if (htmlPreviewState.status === 'ready') onReadingReady();
    } else if (snap.status === 'ready') {
      onReadingReady();
    }
  }, [snap.status, snap.generation, showEditor, fullText !== undefined, onReadingReady, html, htmlPreviewState.status]);
  const normalizedPath = path.replaceAll('\\', '/');
  const documentDirectory = normalizedPath.slice(0, normalizedPath.lastIndexOf('/')) || '/';
  const loadFullMarkdown = useCallback(async () => {
    if (client === undefined || controller === null || !visible || fullLoadAbort.current !== null) return;
    const loadId = ++fullLoadId.current;
    const abort = new AbortController();
    fullLoadAbort.current = abort;
    setLoadingFull(true);
    setFullError(false);
    try {
      const text = await client.readHostFile(path, { signal: abort.signal });
      if (!abort.signal.aborted && loadId === fullLoadId.current) setFullMarkdown({ controller, client, path, generation: snap.generation, text });
    } catch {
      if (!abort.signal.aborted && loadId === fullLoadId.current) setFullError(true);
    } finally {
      if (!abort.signal.aborted && loadId === fullLoadId.current) {
        fullLoadAbort.current = null;
        setLoadingFull(false);
      }
    }
  }, [client, controller, path, snap.generation, visible]);
  useEffect(() => {
    if (visible && markdown && snap.status === 'ready' && snap.oversized && fullText === undefined && !fullError) {
      void loadFullMarkdown();
    }
  }, [visible, markdown, snap.status, snap.oversized, fullText, fullError, loadFullMarkdown]);

  const htmlLoadingNotice = (
    <p className="flex items-center gap-2 p-3 text-[12px] text-ink-faint">
      <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
      {t('preview.loading')}
    </p>
  );

  const renderHtmlError = (error: unknown) => {
    const kind = classifyHtmlPreviewError(error);
    let message = t('preview.failed');
    if (kind === 'remote_grant_required') message = t('preview.htmlRemoteGrantRequired');
    else if (kind === 'local_connection_required') message = t('preview.htmlRequiresLocalConnection');
    else if (kind === 'path_outside_root') message = t('preview.htmlPathOutsideRoot');
    else if (kind === 'expired') message = t('preview.htmlExpired');
    else if (error instanceof Error && error.message) message = error.message;

    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-6 text-center" data-html-preview-error={kind}>
        <p className="max-w-md text-[13px] text-danger" role="alert">{message}</p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {kind === 'path_outside_root' && remoteBrokerHtmlScope ? (
            <form
              data-html-root-form
              className="flex min-w-0 w-full max-w-xl flex-wrap items-end justify-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const root = htmlRootInput.trim();
                if (root.length === 0) return;
                setHtmlRootDraft({ client, path, workspaceRoot, input: htmlRootInput, override: root });
                setReloadKey((k) => k + 1);
              }}
            >
              <label className="flex min-w-0 flex-[1_1_14rem] flex-col items-start gap-1 text-left text-[11px] text-ink-faint">
                <span>{t('preview.htmlResourceRootLabel')}</span>
                <input
                  type="text"
                  data-html-root-input
                  value={htmlRootInput}
                  onChange={(event) => { setHtmlRootDraft({ client, path, workspaceRoot, input: event.target.value, override: htmlRootOverride }); }}
                  aria-label={t('preview.htmlResourceRootLabel')}
                  autoComplete="off"
                  className="min-w-0 w-full rounded-full border border-hairline bg-paper px-3 py-1.5 font-mono text-[12px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
                />
              </label>
              <button
                type="submit"
                data-html-root-retry
                disabled={htmlRootInput.trim().length === 0}
                className="rounded-full bg-accent px-3 py-1.5 text-[12px] font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
              >
                {t('preview.htmlResourceRootRetry')}
              </button>
            </form>
          ) : null}
          {kind === 'expired' || kind === 'generic' ? (
            <button
              type="button"
              data-html-reload
              onClick={() => { setReloadKey((k) => k + 1); }}
              className="rounded-full bg-accent px-3 py-1 text-[12px] font-medium text-white shadow-sm transition-opacity hover:opacity-90"
            >
              {t('preview.htmlReload')}
            </button>
          ) : null}
          <button
            type="button"
            data-html-view-source
            onClick={() => { setMode('source'); }}
            className="rounded-full border border-hairline px-3 py-1 text-[12px] text-ink-soft hover:border-hairline-strong hover:text-ink"
          >
            {t('preview.source')}
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={path}>
          {path}
        </span>
        {hasRenderedMode ? (
          <span className="flex shrink-0 items-center gap-0.5 rounded-md bg-ink/[0.05] p-0.5 text-[11px]">
            {(['rendered', 'source'] as const).map((option) => (
              <button
                key={option}
                type="button"
                data-preview-mode={option}
                data-md-mode={option}
                data-html-mode={html ? option : undefined}
                aria-pressed={mode === option}
                onClick={() => { setMode(option); }}
                className={`rounded-[5px] px-2 py-0.5 transition-colors duration-[var(--kiki-motion-quick)] ${
                  mode === option
                    ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                    : 'text-ink-faint hover:text-ink-soft'
                }`}
              >
                {option === 'rendered' ? t('preview.rendered') : t('preview.source')}
              </button>
            ))}
          </span>
        ) : null}
        {snap.status === 'ready' ? (
          <span className="shrink-0 text-[11px] text-ink-faint" data-save-status>
            {snap.saving
              ? t('preview.saving')
              : snap.dirty
                ? <span className="inline-flex items-center gap-1"><Icon name="dot" size={12} className="text-amber-rule" />{t('preview.unsaved')}</span>
                : snap.lastSavedAt !== undefined
                  ? t('preview.saved')
                  : ''}
          </span>
        ) : null}
        {editable && snap.status === 'ready' ? (
          editing ? (
            <button
              type="button"
              data-save-button
              disabled={!snap.dirty || snap.saving}
              onClick={() => { void controller?.saveNow(); }}
              className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[11px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-default disabled:opacity-40 disabled:hover:border-hairline disabled:hover:text-ink-soft"
            >
              {t('preview.save')}
            </button>
          ) : (
            <button
              type="button"
              data-edit-button
              onClick={() => {
                if (controller?.beginEdit() === true && hasRenderedMode) {
                  setMode('source');
                }
              }}
              className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[11px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
            >
              {t('preview.edit')}
            </button>
          )
        ) : readOnlyReason !== undefined ? (
          <span
            data-readonly-reason
            className="shrink-0 text-[11px] text-ink-faint"
          >
            {readOnlyReason}
          </span>
        ) : null}
        <HeaderFileActions path={path} name={name} canDownload={!textReadFailed} />
      </div>
      {snap.conflict ? (
        <div
          data-conflict-banner
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-rule/40 bg-amber-card px-3 py-1.5 text-[11px] text-amber-ink"
        >
          <span className="min-w-0 flex-1">{t('preview.conflictBody')}</span>
          <button
            type="button"
            data-conflict-overwrite
            onClick={() => { void controller?.resolveConflict('overwrite'); }}
            className="rounded-full border border-amber-rule/60 px-2 py-0.5 font-medium transition-colors hover:bg-amber-rule/20"
          >
            {t('preview.overwrite')}
          </button>
          <button
            type="button"
            data-conflict-reload
            onClick={() => { void controller?.resolveConflict('reload'); }}
            className="rounded-full border border-amber-rule/60 px-2 py-0.5 font-medium transition-colors hover:bg-amber-rule/20"
          >
            {t('preview.reload')}
          </button>
          <button
            type="button"
            onClick={() => { void controller?.resolveConflict('cancel'); }}
            className="rounded-full px-2 py-0.5 text-amber-ink/70 transition-colors hover:text-amber-ink"
          >
            {t('preview.keepEditing')}
          </button>
        </div>
      ) : null}
      {snap.error !== undefined && snap.status !== 'error' ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/5 px-3 py-1.5 text-[11px] text-danger">
          <span className="min-w-0 flex-1 truncate">{snap.error}</span>
          <button
            type="button"
            onClick={() => { controller?.dismissError(); }}
            aria-label={t('common.close')}
            className="shrink-0"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ) : null}
      {!editable && snap.status === 'ready' && ((snap.oversized && fullText === undefined && !html) || readOnlyReason === undefined) ? (
        <div className={`flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 text-[11px] ${
          snap.oversized && fullText === undefined && !html
            ? 'border-amber-rule/40 bg-amber-card text-amber-ink'
            : 'border-hairline bg-paper/60 text-ink-faint'
        }`} data-preview-size-notice>
          <span>{snap.oversized && fullText === undefined && !html
            ? t('preview.oversized') : t('preview.editUnsupported')}</span>
          {markdown && snap.oversized && fullText === undefined ? (
            <button
              type="button"
              data-load-full-markdown
              disabled={loadingFull}
              onClick={() => { void loadFullMarkdown(); }}
              className="rounded-full border border-amber-rule/60 px-2 py-0.5 font-medium disabled:opacity-50"
            >
              {loadingFull ? t('preview.loading') : t('preview.loadFullFile')}
            </button>
          ) : null}
          {fullError ? <span role="alert">{t('preview.failed')}</span> : null}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {!html && snap.status === 'loading' ? (
          <p className="flex items-center gap-2 p-3 text-[12px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('preview.loading')}
          </p>
        ) : !html && snap.status === 'error' ? (
          <p className="p-3 text-[12.5px] text-danger">{t('preview.failed')}</p>
        ) : (
          <>
            {navigation?.invalidTarget || (navigation?.heading !== undefined && !headingFound) || referenceOutside ? (
              <p role="status" className="px-3 py-2 text-[12px] text-ink-soft">{t(referenceOutside ? 'preview.referenceClamped' : 'preview.referenceMissing')}</p>
            ) : null}
            {sourceMounted || showEditor ? (
              <div hidden={!showEditor} className={`min-h-0 flex-1 flex-col ${showEditor ? 'flex' : 'hidden'}`}>
                {html && snap.status === 'loading' ? htmlLoadingNotice
                  : html && snap.status === 'error' ? <p className="p-3 text-[12.5px] text-danger">{t('preview.failed')}</p>
                  : (
                    <CodeEditor
                      key={fullText !== undefined ? `${path}:full` : path}
                      path={path}
                      value={fullText ?? snap.draft}
                      generation={snap.generation}
                      navigation={showEditor ? navigation : undefined}
                      readOnly={!editing}
                      onChange={(text) => { controller?.setDraft(text); }}
                      onSaveShortcut={() => { void controller?.saveNow(); }}
                      ariaLabel={t('preview.openFile', { name })}
                    />
                  )}
              </div>
            ) : null}
            {markdown && renderedMarkdown.current !== null ? (
              <div hidden={showEditor} data-preview-scroll className="min-h-0 flex-1 overflow-auto p-4">
                <Markdown mode="static" text={renderedMarkdown.current.text} documentDirectory={documentDirectory} documentPath={path} headingNavigation={navigation} onHeadingResult={setHeadingFound} />
              </div>
            ) : null}
            {html ? (
              <>
                {htmlPreviewState.status === 'ready' ? (
                  <div hidden={showEditor} className={`min-h-0 flex-1 flex-col ${showEditor ? 'hidden' : 'flex'}`}>
                    <SandboxedHtmlPreview url={htmlPreviewState.url} sandbox={htmlPreviewState.sandbox} title={name} />
                  </div>
                ) : null}
                {!showEditor && htmlPreviewState.status !== 'ready' ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    {htmlPreviewState.status === 'loading' ? htmlLoadingNotice : null}
                    {htmlPreviewState.status === 'error' ? renderHtmlError(htmlPreviewState.error) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
