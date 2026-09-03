/**
 * PreviewWorkspace — the resident multi-tab preview panel. One tab per host
 * file path; tabs close via the × or the context menu (close / close others /
 * close all), reorder by drag, and mark unsaved buffers with a dot. Content
 * routes by extension: images escalate to the lightbox, markdown toggles
 * rendered/source, code/text open in a CodeMirror view, and unknown binaries
 * get the download fallback. Text files are editable where a write channel
 * exists (desktop); everything degrades to read-only otherwise. Every tab's
 * view stays mounted while hidden so editor buffers survive tab switches.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { appendToDraft, mentionToken } from '@kiki/session-core/composer';
import { basenameOf, formatBytes, previewKindOf } from '@kiki/session-core/composer/media';
import { useHost, type HostAdapter } from '../host';
import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import type { KikiClient } from '../lib/client';
import { runToastAction } from '../lib/toasts';
import { useOptionalConnection } from '../state/connection';
import {
  HostFileEditorController,
  type HostFileEditorSnapshot,
} from '../state/hostFileEditor';
import { CodeEditor } from './CodeEditor';
import { ConfirmDialog } from './ConfirmDialog';
import { Markdown } from './Markdown';

export interface PreviewWorkspaceProps {
  readonly tabs: readonly string[];
  readonly active: string | null;
  readonly dirtyPaths: ReadonlySet<string>;
  readonly width: number;
  readonly onActivate: (path: string) => void;
  readonly onClose: (path: string) => void;
  readonly onCloseOthers: (path: string) => void;
  readonly onCloseAll: () => void;
  readonly onMove: (path: string, targetIndex: number) => void;
  readonly onCollapse: () => void;
  readonly onWidthChange: (width: number, final: boolean) => void;
  readonly onOpenImage: (src: string, name?: string) => void;
  readonly reportDirty: (path: string, dirty: boolean) => void;
  readonly overlay?: boolean;
  /** Session workspace cwd — anchors "Copy relative path" and the @-mention. */
  readonly cwd?: string;
  /** Owning session — the @-mention target composer. Absent without a session. */
  readonly sessionId?: string;
}

const MIN_WIDTH = 320;
const MAX_WIDTH = 760;

export function clampPreviewWidth(width: number, viewport: number): number {
  return Math.max(MIN_WIDTH, Math.min(width, Math.min(MAX_WIDTH, Math.floor(viewport * 0.6))));
}

/**
 * Path relative to the session cwd (posix-style, case-insensitive prefix
 * match for Windows drives); falls back to the untouched absolute path when
 * the file lives outside the workspace.
 */
export function relativeToCwd(path: string, cwd: string | undefined): string {
  if (cwd === undefined) return path;
  const normPath = path.replaceAll('\\', '/');
  const normCwd = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  const prefix = `${normCwd}/`;
  if (normPath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normPath.slice(prefix.length);
  }
  return path;
}

/**
 * Composer `@`-token for a previewed file — delegates whitespace quoting to
 * the shared mention formatter so spaced paths arrive as `@"…"`, exactly the
 * shape the TUI's mention autocomplete produces.
 */
function mentionTokenFor(path: string, cwd: string | undefined): string {
  return mentionToken({
    kind: 'file',
    path: relativeToCwd(path, cwd),
    name: basenameOf(path),
    isDir: false,
  });
}

export function PreviewWorkspace({
  tabs,
  active,
  dirtyPaths,
  width,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
  onMove,
  onCollapse,
  onWidthChange,
  onOpenImage,
  reportDirty,
  overlay = false,
  cwd,
  sessionId,
}: PreviewWorkspaceProps) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const dragPathRef = useRef<string | null>(null);

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const onMovePointer = (move: Event) => {
      const x = (move as PointerEvent).clientX;
      onWidthChange(clampPreviewWidth(window.innerWidth - x, window.innerWidth), false);
    };
    const onUp = (up: Event) => {
      const x = (up as PointerEvent).clientX;
      onWidthChange(clampPreviewWidth(window.innerWidth - x, window.innerWidth), true);
      handle.removeEventListener('pointermove', onMovePointer);
      handle.removeEventListener('pointerup', onUp);
    };
    handle.addEventListener('pointermove', onMovePointer);
    handle.addEventListener('pointerup', onUp);
  };

  return (
    <aside
      data-preview-workspace
      aria-label={t('preview.title')}
      className={`preview-workspace ${overlay ? 'preview-workspace--overlay' : ''}`}
      style={{ width }}
    >
      <div
        className="preview-workspace__resizer"
        aria-hidden
        onPointerDown={startResize}
      />
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-hairline pl-2 pr-1">
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((path, index) => (
            <PreviewTab
              key={path}
              path={path}
              active={path === active}
              dirty={dirtyPaths.has(path)}
              mentionable={sessionId !== undefined}
              onMention={
                sessionId === undefined
                  ? undefined
                  : () => { appendToDraft(sessionId, mentionTokenFor(path, cwd)); }
              }
              onActivate={() => { onActivate(path); }}
              onClose={() => { onClose(path); }}
              onContextMenu={(x, y) => { setMenu({ path, x, y }); }}
              onDragStart={() => { dragPathRef.current = path; }}
              onDrop={() => {
                const dragged = dragPathRef.current;
                dragPathRef.current = null;
                if (dragged !== null && dragged !== path) onMove(dragged, index);
              }}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={onCollapse}
          title={t('preview.collapse')}
          aria-label={t('preview.collapse')}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-ink-faint transition-colors hover:text-ink"
        >
          »
        </button>
      </div>
      {tabs.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-ink-faint">
          {t('preview.empty')}
        </div>
      ) : (
        tabs.map((path) => (
          <PreviewTabView
            key={path}
            path={path}
            visible={path === active}
            onOpenImage={onOpenImage}
            reportDirty={reportDirty}
          />
        ))
      )}
      {menu !== null ? (
        <TabContextMenu
          menu={menu}
          cwd={cwd}
          onCloseMenu={() => { setMenu(null); }}
          onCloseTab={() => { onClose(menu.path); }}
          onCloseOthers={() => { onCloseOthers(menu.path); }}
          onCloseAll={onCloseAll}
        />
      ) : null}
    </aside>
  );
}

function PreviewTab({
  path,
  active,
  dirty,
  mentionable,
  onMention,
  onActivate,
  onClose,
  onContextMenu,
  onDragStart,
  onDrop,
}: {
  readonly path: string;
  readonly active: boolean;
  readonly dirty: boolean;
  /** A mention button only renders when the workspace has an owning session. */
  readonly mentionable: boolean;
  readonly onMention: (() => void) | undefined;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (x: number, y: number) => void;
  readonly onDragStart: () => void;
  readonly onDrop: () => void;
}) {
  const { t } = useI18n();
  const name = basenameOf(path);
  return (
    <div
      role="tab"
      aria-selected={active}
      title={path}
      draggable
      data-preview-tab={path}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', path);
        onDragStart();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onClick={onActivate}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      className={`group flex h-7 max-w-40 min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-t-md border border-b-0 px-2 text-[11.5px] select-none ${
        active
          ? 'border-hairline bg-paper font-medium text-ink'
          : 'border-transparent text-ink-faint hover:text-ink-soft'
      }`}
    >
      {dirty ? (
        <span
          aria-label={t('preview.unsaved')}
          title={t('preview.unsaved')}
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
        />
      ) : null}
      <span className="min-w-0 truncate">{name}</span>
      {mentionable && onMention !== undefined ? (
        <button
          type="button"
          data-mention-file={path}
          aria-label={t('preview.addToChat')}
          title={t('preview.addToChat')}
          onClick={(event) => {
            event.stopPropagation();
            onMention();
          }}
          className={`shrink-0 rounded-sm px-0.5 font-mono text-[11px] leading-none transition-colors hover:text-accent ${
            active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint'
          }`}
        >
          @
        </button>
      ) : null}
      <button
        type="button"
        aria-label={`${t('common.close')} ${name}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className={`shrink-0 rounded-sm px-0.5 text-[11px] leading-none transition-colors hover:text-danger ${
          active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint'
        }`}
      >
        ×
      </button>
    </div>
  );
}

function TabContextMenu({
  menu,
  cwd,
  onCloseMenu,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
}: {
  readonly menu: { path: string; x: number; y: number };
  readonly cwd: string | undefined;
  readonly onCloseMenu: () => void;
  readonly onCloseTab: () => void;
  readonly onCloseOthers: () => void;
  readonly onCloseAll: () => void;
}) {
  const host = useHost();
  const { t } = useI18n();
  // Stable single attach: the parent passes inline callbacks, so depending on
  // `onCloseMenu` would churn detach/attach on every parent render and an
  // Escape landing in the gap would be swallowed (observed live: the trusted
  // keydown missed the just-reattached listener). A ref keeps the handler
  // current without re-subscribing.
  const closeRef = useRef(onCloseMenu);
  closeRef.current = onCloseMenu;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof HTMLElement) ||
        event.target.closest('[data-preview-tab-menu]') === null
      ) {
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  const itemClass =
    'w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper';
  const pick = (run: () => void) => {
    onCloseMenu();
    run();
  };
  const pickAction = (label: string, action: () => Promise<void>) => {
    onCloseMenu();
    runToastAction(label, action);
  };
  const path = menu.path;
  const relative = relativeToCwd(path, cwd);
  const openers = host.revealPath !== undefined && host.openPath !== undefined;
  return (
    <div
      data-preview-tab-menu
      role="menu"
      className="anim-enter fixed z-50 w-52 rounded-lg border border-hairline bg-panel p-1 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.3)]"
      style={{ left: menu.x, top: menu.y }}
    >
      <button type="button" role="menuitem" className={itemClass} onClick={() => { pick(onCloseTab); }}>
        {t('preview.closeTab')}
      </button>
      <button type="button" role="menuitem" className={itemClass} onClick={() => { pick(onCloseOthers); }}>
        {t('preview.closeOthers')}
      </button>
      <button type="button" role="menuitem" className={itemClass} onClick={() => { pick(onCloseAll); }}>
        {t('preview.closeAll')}
      </button>
      <div className="mx-1 my-1 border-t border-hairline" />
      <button
        type="button"
        role="menuitem"
        data-menu-item="copy-relative"
        className={itemClass}
        onClick={() => { pickAction(t('file.copyRelativePath'), () => copyTextToClipboard(relative)); }}
      >
        {t('file.copyRelativePath')}
      </button>
      <button
        type="button"
        role="menuitem"
        data-menu-item="copy-absolute"
        className={itemClass}
        onClick={() => { pickAction(t('file.copyAbsolutePath'), () => copyTextToClipboard(path)); }}
      >
        {t('file.copyAbsolutePath')}
      </button>
      {openers ? (
        <>
          <button
            type="button"
            role="menuitem"
            data-menu-item="show-in-folder"
            className={itemClass}
            onClick={() => { pickAction(t('file.showInFolder'), () => host.revealPath!(path)); }}
          >
            {t('file.showInFolder')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-menu-item="open-default-app"
            className={itemClass}
            onClick={() => { pickAction(t('file.openDefaultApp'), () => host.openPath!(path)); }}
          >
            {t('file.openDefaultApp')}
          </button>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab content
// ---------------------------------------------------------------------------

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

function PreviewTabView({
  path,
  visible,
  onOpenImage,
  reportDirty,
}: {
  readonly path: string;
  readonly visible: boolean;
  readonly onOpenImage: (src: string, name?: string) => void;
  readonly reportDirty: (path: string, dirty: boolean) => void;
}) {
  const kind = previewKindOf(path);
  return (
    <div
      role="tabpanel"
      hidden={!visible}
      className={`min-h-0 flex-1 flex-col ${visible ? 'flex' : 'hidden'}`}
      data-preview-tabpanel={path}
    >
      {kind === 'image' ? (
        <ImageTabView path={path} onOpenImage={onOpenImage} />
      ) : kind === 'binary' ? (
        <BinaryTabView path={path} />
      ) : (
        <TextTabView path={path} markdown={kind === 'markdown'} reportDirty={reportDirty} />
      )}
    </div>
  );
}

function TabPathCaption({ path }: { readonly path: string }) {
  return (
    <p className="truncate border-b border-hairline px-3 py-1.5 font-mono text-[10.5px] text-ink-faint" title={path}>
      {path}
    </p>
  );
}

function ImageTabView({
  path,
  onOpenImage,
}: {
  readonly path: string;
  readonly onOpenImage: (src: string, name?: string) => void;
}) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const name = basenameOf(path);
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'error' }
    | { readonly status: 'ready'; readonly url: string; readonly size: number }
  >({ status: 'loading' });

  useEffect(() => {
    const client = connection?.client;
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
  }, [connection, path]);

  return (
    <>
      <TabPathCaption path={path} />
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {state.status === 'loading' ? (
          <p className="flex items-center gap-2 text-[12px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('preview.loading')}
          </p>
        ) : state.status === 'error' ? (
          <p className="text-[12.5px] text-danger">{t('preview.failed')}</p>
        ) : (
          <button
            type="button"
            onClick={() => { onOpenImage(state.url, name); }}
            className="block"
            title={t('media.viewImage')}
          >
            <img
              src={state.url}
              alt={name}
              className="max-h-[70vh] rounded-lg border border-hairline object-contain"
            />
            <span className="mt-1 block font-mono text-[10.5px] text-ink-faint">
              {formatBytes(state.size)}
            </span>
          </button>
        )}
      </div>
    </>
  );
}

function BinaryTabView({ path }: { readonly path: string }) {
  const host = useHost();
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const name = basenameOf(path);
  return (
    <>
      <TabPathCaption path={path} />
      <div className="flex flex-1 flex-col items-start gap-3 p-4">
        <p className="text-[12.5px] text-ink-soft">{t('preview.unsupported')}</p>
        <button
          type="button"
          onClick={() => {
            const client = connection?.client;
            if (client !== undefined) void downloadHostFile(host, client, path, name);
          }}
          className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent-deep"
        >
          {t('media.download')}
        </button>
      </div>
    </>
  );
}

/**
 * Text/code/markdown tab: one HostFileEditorController per tab (created when
 * the connection's client is available), CodeMirror for source, the Markdown
 * renderer for the rendered markdown mode.
 */
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

function TextTabView({
  path,
  markdown,
  reportDirty,
}: {
  readonly path: string;
  readonly markdown: boolean;
  readonly reportDirty: (path: string, dirty: boolean) => void;
}) {
  const host = useHost();
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const [controller, setController] = useState<HostFileEditorController | null>(null);
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');

  useEffect(() => {
    if (client === undefined) {
      setController(null);
      return;
    }
    const next = new HostFileEditorController({
      path,
      readFile: (target) => client.readHostFile(target),
      writeFile: host.writeFileText,
    });
    setController(next);
    void next.load();
    return () => {
      next.dispose();
      setController(null);
    };
  }, [client, host, path]);

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

  const dirty = snap.dirty;
  useEffect(() => {
    reportDirty(path, dirty);
    return () => { reportDirty(path, false); };
  }, [reportDirty, path, dirty]);

  const name = basenameOf(path);
  const editable = controller?.editable ?? false;
  const showEditor = !markdown || mode === 'source';
  const clientForDownload = client;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint" title={path}>
          {path}
        </span>
        {markdown ? (
          <span className="flex shrink-0 overflow-hidden rounded-full border border-hairline text-[10.5px]">
            {(['rendered', 'source'] as const).map((option) => (
              <button
                key={option}
                type="button"
                data-md-mode={option}
                onClick={() => { setMode(option); }}
                className={`px-2 py-0.5 transition-colors ${
                  mode === option
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-ink-faint hover:text-ink-soft'
                }`}
              >
                {option === 'rendered' ? t('preview.rendered') : t('preview.source')}
              </button>
            ))}
          </span>
        ) : null}
        {snap.status === 'ready' ? (
          <span className="shrink-0 text-[10.5px] text-ink-faint" data-save-status>
            {snap.saving
              ? t('preview.saving')
              : snap.dirty
                ? `● ${t('preview.unsaved')}`
                : snap.lastSavedAt !== undefined
                  ? `✓ ${t('preview.saved')}`
                  : ''}
          </span>
        ) : null}
        {editable ? (
          <button
            type="button"
            data-save-button
            disabled={!snap.dirty || snap.saving}
            onClick={() => { void controller?.saveNow(); }}
            className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[10.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-40 disabled:hover:border-hairline disabled:hover:text-ink-soft"
          >
            {t('preview.save')}
          </button>
        ) : null}
        <button
          type="button"
          title={t('media.download')}
          onClick={() => {
            if (clientForDownload !== undefined) {
              void downloadHostFile(host, clientForDownload, path, name);
            }
          }}
          className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[10.5px] text-ink-soft transition-colors hover:border-accent hover:text-accent"
        >
          ↓
        </button>
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
            ×
          </button>
        </div>
      ) : null}
      {!editable && snap.status === 'ready' ? (
        <p className="shrink-0 border-b border-hairline bg-paper/60 px-3 py-1 text-[10.5px] text-ink-faint">
          {snap.oversized ? t('preview.oversized') : t('preview.editUnsupported')}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {snap.status === 'loading' ? (
          <p className="flex items-center gap-2 p-3 text-[12px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('preview.loading')}
          </p>
        ) : snap.status === 'error' ? (
          <p className="p-3 text-[12.5px] text-danger">{t('preview.failed')}</p>
        ) : showEditor ? (
          <CodeEditor
            key={path}
            path={path}
            value={snap.draft}
            generation={snap.generation}
            readOnly={!editable}
            onChange={(text) => { controller?.setDraft(text); }}
            onSaveShortcut={() => { void controller?.saveNow(); }}
            ariaLabel={t('preview.openFile', { name })}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <Markdown text={snap.draft} />
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Close-with-unsaved-changes confirmation, rendered by the provider next to
 * the workspace. `names` labels the single-file body; several files fall back
 * to the count body.
 */
export function PreviewCloseConfirm({
  paths,
  onConfirm,
  onCancel,
}: {
  readonly paths: readonly string[];
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <ConfirmDialog
      open
      overlayId="preview-close-dirty"
      title={t('preview.discardTitle')}
      body={
        paths.length === 1
          ? t('preview.discardBody', { name: basenameOf(paths[0] ?? '') })
          : t('preview.discardBodyMany', { count: paths.length })
      }
      confirmLabel={t('preview.discard')}
      tone="danger"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
