import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { basenameOf, type FileReference } from '@kiki/session-core/composer/media';

import { useHost, type HostAdapter } from '../../host';
import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';
import { runToastAction } from '../../lib/toasts';
import { useOptionalConnection } from '../../state/connection';
import {
  HostFileEditorController,
  type HostFileEditorSnapshot,
} from '../../state/hostFileEditor';
import { CodeEditor } from '../CodeEditor';
import { Icon } from '../icons';
import { Markdown } from '../Markdown';

export interface TextTabViewProps {
  readonly path: string;
  readonly markdown: boolean;
  readonly navigation?: FileReference;
  readonly reportDirty: (path: string, dirty: boolean) => void;
  readonly onReadingReady: () => void;
}

const IDLE_SNAPSHOT: HostFileEditorSnapshot = {
  status: 'loading',
  error: undefined,
  savedText: '',
  draft: '',
  dirty: false,
  saving: false,
  conflict: false,
  oversized: false,
  generation: 0,
  lastSavedAt: undefined,
};

const HEADER_ACTION_CLASS =
  'shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[11px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';

const CSP_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  'img-src data:',
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "worker-src 'none'",
].join('; ');

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${CSP_POLICY}">`;
const REFERRER_META = '<meta name="referrer" content="no-referrer">';

/** Whether the text tab can show a document renderer for this path. */
export function isHtmlPreviewPath(path: string): boolean {
  return /\.(?:html?|xhtml)$/iu.test(basenameOf(path));
}

function withoutNavigationElements(source: string): string {
  if (typeof DOMParser === 'undefined') return source;
  const document = new DOMParser().parseFromString(`${CSP_META}${REFERRER_META}${source}`, 'text/html');
  for (const element of document.querySelectorAll('base, meta, a[href], area[href]')) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'base' || (tag === 'meta' && element.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh')) {
      element.remove();
    } else if (tag === 'a' || tag === 'area') {
      element.removeAttribute('href');
      element.removeAttribute('target');
    }
  }
  return document.documentElement.outerHTML;
}

/**
 * Prefixes the policy before the file document so an author-provided comment
 * or script string cannot become the apparent head injection point. The inert
 * parse only removes navigation controls; it never executes the source.
 */
export function sandboxedHtmlDocument(source: string): string {
  const policy = `${CSP_META}${REFERRER_META}`;
  return `<!doctype html>${policy}${withoutNavigationElements(source)}`;
}

async function downloadHostFile(
  host: HostAdapter,
  client: KikiClient,
  path: string,
  name: string,
): Promise<void> {
  const { bytes, mime } = await client.readHostFileBytes(path);
  const blob = new Blob([bytes as BlobPart], { type: mime });
  if (host.saveBlob !== undefined) {
    try {
      await host.saveBlob(blob, name);
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
}

function useTextFileOpeners(): { readonly reveal: (path: string) => void; readonly open: (path: string) => void } | null {
  const host = useHost();
  const { t } = useI18n();
  const remoteScope = useOptionalConnection()?.scopeId.startsWith('ssh:') ?? false;
  const { revealPath, openPath } = host;
  return useMemo(() => {
    if (remoteScope || revealPath === undefined || openPath === undefined) return null;
    return {
      reveal: (path: string) => { runToastAction(t('file.showInFolder'), () => revealPath(path)); },
      open: (path: string) => { runToastAction(t('file.openDefaultApp'), () => openPath(path)); },
    };
  }, [remoteScope, revealPath, openPath, t]);
}

/** Kept local so PreviewWorkspace can import this leaf without a cycle. */
function TextHeaderActions({ path, name }: { readonly path: string; readonly name: string }) {
  const host = useHost();
  const { t } = useI18n();
  const client = useOptionalConnection()?.client;
  const openers = useTextFileOpeners();
  return (
    <>
      <button
        type="button"
        title={t('media.download')}
        aria-label={t('media.download')}
        data-download-file
        onClick={() => {
          if (client !== undefined) void downloadHostFile(host, client, path, name);
        }}
        className={HEADER_ACTION_CLASS}
      >
        <Icon name="arrowDown" size={12} />
      </button>
      {openers !== null ? (
        <>
          <button
            type="button"
            title={t('file.openDefaultApp')}
            data-open-default-app
            onClick={() => { openers.open(path); }}
            className={HEADER_ACTION_CLASS}
          >
            {t('file.open')}
          </button>
          <button
            type="button"
            title={t('file.showInFolder')}
            aria-label={t('file.showInFolder')}
            data-reveal-file
            onClick={() => { openers.reveal(path); }}
            className={HEADER_ACTION_CLASS}
          >
            <Icon name="folder" size={12} />
          </button>
        </>
      ) : null}
    </>
  );
}

const SandboxedHtmlPreview = memo(function SandboxedHtmlPreview({
  source,
  title,
}: {
  readonly source: string;
  readonly title: string;
}) {
  const documentSource = useMemo(() => sandboxedHtmlDocument(source), [source]);
  return (
    <iframe
      title={title}
      data-preview-html
      srcDoc={documentSource}
      sandbox=""
      referrerPolicy="no-referrer"
      className="min-h-0 min-w-0 flex-1 border-0 bg-paper"
    />
  );
});

const RenderedMarkdown = memo(function RenderedMarkdown({
  text,
  documentDirectory,
  documentPath,
  navigation,
  onHeadingResult,
}: {
  readonly text: string;
  readonly documentDirectory: string;
  readonly documentPath: string;
  readonly navigation?: FileReference;
  readonly onHeadingResult: (found: boolean) => void;
}) {
  return (
    <Markdown
      mode="static"
      text={text}
      documentDirectory={documentDirectory}
      documentPath={documentPath}
      headingNavigation={navigation}
      onHeadingResult={onHeadingResult}
    />
  );
});

/**
 * Text/code/markdown/HTML tab. Source is resident after first use so CM6 owns
 * the draft, history and scroll position. Renderers are resident too, but the
 * rendered input is frozen while source is being edited so hidden Streamdown
 * trees never parse every keystroke.
 */
export function TextTabView({
  path,
  markdown,
  navigation,
  reportDirty,
  onReadingReady,
}: TextTabViewProps) {
  const host = useHost();
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const html = isHtmlPreviewPath(path);
  const hasRenderedMode = markdown || html;
  const [controller, setController] = useState<HostFileEditorController | null>(null);
  const [mode, setMode] = useState<'rendered' | 'source'>(() => hasRenderedMode ? 'rendered' : 'source');
  const [fullMarkdown, setFullMarkdown] = useState<{
    readonly controller: HostFileEditorController;
    readonly client: KikiClient;
    readonly path: string;
    readonly generation: number;
    readonly text: string;
  } | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState(false);
  const fullLoadId = useRef(0);
  const fullReadController = useRef<AbortController | null>(null);
  const [headingFound, setHeadingFound] = useState(true);

  useEffect(() => {
    if (navigation?.line !== undefined) setMode('source');
    else if (navigation?.heading !== undefined && markdown) setMode('rendered');
  }, [markdown, navigation]);

  const readHostText = useCallback(async (target: string): Promise<string | { readonly text: string; readonly truncated: boolean }> => {
    if (client === undefined) throw new Error('Preview connection unavailable');
    if (html) {
      const { bytes } = await client.readHostFileBytes(target, client.readingOptions());
      return new TextDecoder().decode(bytes);
    }
    return client.previewHostFile(target);
  }, [client, html]);

  useEffect(() => {
    if (client === undefined) {
      setController(null);
      return;
    }
    const next = new HostFileEditorController({
      path,
      readFile: readHostText,
      writeFile: host.writeFileText,
    });
    setController(next);
    void next.load();
    return () => {
      next.dispose();
      setController(null);
    };
  }, [client, host, path, readHostText]);

  const subscribe = useMemo(
    () => controller?.subscribe ?? (() => () => {}),
    [controller],
  );
  const getState = useMemo(
    () => controller?.getState ?? (() => IDLE_SNAPSHOT),
    [controller],
  );
  const snap = useSyncExternalStore(subscribe, getState);

  useEffect(() => {
    setLoadingFull(false);
    setFullError(false);
    return () => {
      fullLoadId.current += 1;
      fullReadController.current?.abort();
      fullReadController.current = null;
    };
  }, [client, path, snap.generation]);

  const dirty = snap.dirty;
  useEffect(() => {
    reportDirty(path, dirty);
    return () => { reportDirty(path, false); };
  }, [dirty, path, reportDirty]);

  const name = basenameOf(path);
  const editable = controller?.editable ?? false;
  const showEditor = !hasRenderedMode || mode === 'source';
  const [sourceMounted, setSourceMounted] = useState(!hasRenderedMode);
  useEffect(() => {
    if (showEditor) setSourceMounted(true);
  }, [showEditor]);

  const fullText = fullMarkdown?.controller === controller && fullMarkdown.client === client &&
    fullMarkdown.path === path && fullMarkdown.generation === snap.generation
    ? fullMarkdown.text
    : undefined;
  const currentText = snap.dirty ? snap.draft : (fullText ?? snap.draft);
  const renderedTextRef = useRef('');
  if (!showEditor) renderedTextRef.current = currentText;
  const renderedText = renderedTextRef.current;
  const referenceOutside = useMemo(() => {
    if (navigation?.line === undefined) return false;
    const lines = currentText.split('\n');
    return navigation.line > lines.length || (navigation.endLine ?? navigation.line) > lines.length ||
      (navigation.column ?? 1) > (lines[navigation.line - 1]?.length ?? 0) + 1;
  }, [currentText, navigation]);

  useEffect(() => {
    if (snap.status === 'ready') onReadingReady();
  }, [fullText !== undefined, onReadingReady, showEditor, snap.generation, snap.status]);

  const normalizedPath = path.replaceAll('\\', '/');
  const documentDirectory = normalizedPath.slice(0, normalizedPath.lastIndexOf('/')) || '/';
  const loadFullMarkdown = useCallback(async () => {
    if (client === undefined || controller === null || fullReadController.current !== null) return;
    const loadId = ++fullLoadId.current;
    const abort = new AbortController();
    fullReadController.current = abort;
    setLoadingFull(true);
    setFullError(false);
    try {
      const { bytes } = await client.readHostFileBytes(path, { ...client.readingOptions(), signal: abort.signal });
      if (loadId === fullLoadId.current && !abort.signal.aborted) {
        setFullMarkdown({
          controller,
          client,
          path,
          generation: snap.generation,
          text: new TextDecoder().decode(bytes),
        });
      }
    } catch {
      if (loadId === fullLoadId.current && !abort.signal.aborted) setFullError(true);
    } finally {
      if (fullReadController.current === abort) fullReadController.current = null;
      if (loadId === fullLoadId.current) setLoadingFull(false);
    }
  }, [client, controller, path, snap.generation]);

  useEffect(() => {
    if (!html && snap.status === 'ready' && snap.oversized && fullText === undefined && !fullError) {
      void loadFullMarkdown();
    }
  }, [html, fullError, fullText, loadFullMarkdown, snap.oversized, snap.status]);

  const renderedMarkdown = useMemo(() => (
    markdown ? (
      <RenderedMarkdown
        text={renderedText}
        documentDirectory={documentDirectory}
        documentPath={path}
        navigation={navigation}
        onHeadingResult={setHeadingFound}
      />
    ) : null
  ), [documentDirectory, markdown, navigation, path, renderedText, setHeadingFound]);

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
        {editable ? (
          <button
            type="button"
            data-save-button
            disabled={!snap.dirty || snap.saving}
            onClick={() => { void controller?.saveNow(); }}
            className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[11px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-default disabled:opacity-40 disabled:hover:border-hairline disabled:hover:text-ink-soft"
          >
            {t('preview.save')}
          </button>
        ) : null}
        <TextHeaderActions path={path} name={name} />
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
      {!editable && snap.status === 'ready' ? (
        <div className={`flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 text-[11px] ${
          snap.oversized && fullText === undefined && !html
            ? 'border-amber-rule/40 bg-amber-card text-amber-ink'
            : 'border-hairline bg-paper/60 text-ink-faint'
        }`} data-preview-size-notice>
          <span>{snap.oversized && fullText === undefined && !html
            ? t('preview.oversized') : t('preview.editUnsupported')}</span>
          {loadingFull ? <span role="status">{t('preview.loading')}</span> : null}
          {fullError ? <button type="button" data-load-full-markdown onClick={() => { void loadFullMarkdown(); }} className="rounded-full border border-amber-rule/60 px-2 py-0.5 font-medium">{t('transcript.detail.retry')}</button> : null}
          {fullError ? <span role="alert">{t('preview.failed')}</span> : null}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {snap.status === 'loading' ? (
          <p className="flex items-center gap-2 p-3 text-[12px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('preview.loading')}
          </p>
        ) : snap.status === 'error' ? (
          <p className="p-3 text-[12.5px] text-danger">{t('preview.failed')}</p>
        ) : (
          <>
            {navigation?.invalidTarget || (navigation?.heading !== undefined && !headingFound) || referenceOutside ? <p role="status" className="px-3 py-2 text-[12px] text-ink-soft">{t(referenceOutside ? 'preview.referenceClamped' : 'preview.referenceMissing')}</p> : null}
            {sourceMounted || showEditor ? <div hidden={!showEditor} className={`min-h-0 flex-1 flex-col ${showEditor ? 'flex' : 'hidden'}`}>
              <CodeEditor
                key={fullText !== undefined && !snap.dirty ? `${path}:full` : path}
                path={path}
                value={currentText}
                generation={snap.generation}
                navigation={showEditor ? navigation : undefined}
                readOnly={!editable}
                onChange={(text) => { controller?.setDraft(text); }}
                onSaveShortcut={() => { void controller?.saveNow(); }}
                ariaLabel={t('preview.openFile', { name })}
              />
            </div> : null}
            {markdown ? <div hidden={showEditor} data-preview-scroll className={`min-h-0 flex-1 overflow-auto p-4 ${showEditor ? 'hidden' : ''}`}>
              {renderedMarkdown}
            </div> : null}
            {html ? <div hidden={showEditor} className={`min-h-0 flex-1 flex-col ${showEditor ? 'hidden' : 'flex'}`}>
              <SandboxedHtmlPreview source={renderedText} title={name} />
            </div> : null}
          </>
        )}
      </div>
    </>
  );
}
