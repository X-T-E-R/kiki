/**
 * PreviewWorkspace top bar — tab strip and the five tab chips (file, skill,
 * attachment, web, and agent panel).
 */

import { useRef } from 'react';

import { appendToDraft } from '@kiki/session-core/composer';
import { basenameOf, resolveHostPath, type MediaRef } from '@kiki/session-core/composer/media';
import type { AgentForest } from '@kiki/session-core/session';
import { useI18n } from '#/i18n';
import type { PreviewReadState } from '#/state/previewResource';
import { previewTabKey, type PreviewTab as PreviewTabModel } from '#/state/previewWorkspace';
import { Icon } from '../icons';
import { attachmentName } from '../mediaParts';
import { mentionTokenFor, webUrlDisplayLabel } from './shared';

export interface PreviewTabStripProps {
  readonly tabs: readonly PreviewTabModel[];
  readonly active: string | null;
  readonly dirtyPaths: ReadonlySet<string>;
  readonly tabReadStates: Readonly<Record<string, PreviewReadState>>;
  readonly agentForest?: AgentForest;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly phoneMode: boolean;
  readonly isFullscreen: boolean;
  readonly onToggleFullscreen: () => void;
  readonly onCollapse: () => void;
  readonly onOpenCockpit?: () => void;
  readonly onActivate: (key: string) => void;
  readonly onClose: (key: string) => void;
  readonly onMove: (key: string, targetIndex: number) => void;
  readonly onOpenContextMenu: (tab: PreviewTabModel, x: number, y: number) => void;
}

export function PreviewTabStrip({
  tabs,
  active,
  dirtyPaths,
  tabReadStates,
  agentForest,
  cwd,
  sessionId,
  phoneMode,
  isFullscreen,
  onToggleFullscreen,
  onCollapse,
  onOpenCockpit,
  onActivate,
  onClose,
  onMove,
  onOpenContextMenu,
}: PreviewTabStripProps) {
  const { t } = useI18n();
  const dragKeyRef = useRef<string | null>(null);

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-hairline pl-2 pr-1 lg:h-9">
      <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab, index) => {
          const key = previewTabKey(tab);
          const isTabActive = key === active;
          const tabReadState = tabReadStates[key];
          const readFailed = tabReadState?.status === 'failed';
          return tab.kind === 'file' ? (
            <PreviewFileTab
              key={key}
              tabKey={key}
              path={tab.path}
              active={isTabActive}
              dirty={dirtyPaths.has(tab.path)}
              mentionable={sessionId !== undefined && !readFailed}
              onMention={
                sessionId === undefined || readFailed
                  ? undefined
                  : () => { appendToDraft(sessionId, mentionTokenFor(tab.path, cwd)); }
              }
              onActivate={() => { onActivate(key); }}
              onClose={() => { onClose(key); }}
              onContextMenu={(x, y) => { onOpenContextMenu(tab, x, y); }}
              onDragStart={() => { dragKeyRef.current = key; }}
              onDrop={() => {
                const dragged = dragKeyRef.current;
                dragKeyRef.current = null;
                if (dragged !== null && dragged !== key) onMove(dragged, index);
              }}
            />
          ) : tab.kind === 'attachment' ? (
            (() => {
              const origin = tab.origin ?? tab.item.origin;
              const trustedPath = origin !== undefined && origin.trusted ? resolveHostPath(origin.path, cwd) : undefined;
              const isCopy = tab.item.fileId !== undefined;
              const canMention = sessionId !== undefined && trustedPath !== undefined && !readFailed;
              return (
                <PreviewAttachmentTab
                  key={key}
                  tabKey={key}
                  item={tab.item}
                  isCopy={isCopy}
                  trustedPath={trustedPath}
                  mentionable={canMention}
                  onMention={
                    canMention
                      ? () => { appendToDraft(sessionId, mentionTokenFor(trustedPath, cwd)); }
                      : undefined
                  }
                  active={isTabActive}
                  onActivate={() => { onActivate(key); }}
                  onClose={() => { onClose(key); }}
                  onContextMenu={(x, y) => { onOpenContextMenu(tab, x, y); }}
                  onDragStart={() => { dragKeyRef.current = key; }}
                  onDrop={() => {
                    const dragged = dragKeyRef.current;
                    dragKeyRef.current = null;
                    if (dragged !== null && dragged !== key) onMove(dragged, index);
                  }}
                />
              );
            })()
          ) : tab.kind === 'web' ? (
            <PreviewWebTab
              key={key}
              tabKey={key}
              url={tab.url}
              title={tab.title}
              active={isTabActive}
              onActivate={() => { onActivate(key); }}
              onClose={() => { onClose(key); }}
              onContextMenu={(x, y) => { onOpenContextMenu(tab, x, y); }}
              onDragStart={() => { dragKeyRef.current = key; }}
              onDrop={() => {
                const dragged = dragKeyRef.current;
                dragKeyRef.current = null;
                if (dragged !== null && dragged !== key) onMove(dragged, index);
              }}
            />
          ) : tab.kind === 'skill' ? (
            <PreviewSkillTab
              key={key}
              tabKey={key}
              name={tab.name}
              active={isTabActive}
              onActivate={() => { onActivate(key); }}
              onClose={() => { onClose(key); }}
              onContextMenu={(x, y) => { onOpenContextMenu(tab, x, y); }}
              onDragStart={() => { dragKeyRef.current = key; }}
              onDrop={() => {
                const dragged = dragKeyRef.current;
                dragKeyRef.current = null;
                if (dragged !== null && dragged !== key) onMove(dragged, index);
              }}
            />
          ) : (
            <PreviewPanelTab
              key={key}
              tabKey={key}
              tab={tab}
              forest={agentForest}
              active={isTabActive}
              onActivate={() => { onActivate(key); }}
              onClose={() => { onClose(key); }}
              onContextMenu={(x, y) => { onOpenContextMenu(tab, x, y); }}
              onDragStart={() => { dragKeyRef.current = key; }}
              onDrop={() => {
                const dragged = dragKeyRef.current;
                dragKeyRef.current = null;
                if (dragged !== null && dragged !== key) onMove(dragged, index);
              }}
            />
          );
        })}
      </div>
      {onOpenCockpit !== undefined ? (
        <button
          type="button"
          data-preview-open-cockpit
          onClick={onOpenCockpit}
          className="hidden h-7 shrink-0 items-center rounded-md px-2 text-[12px] text-ink-faint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:flex min-[85rem]:hidden"
        >
          {t('rail.mode.cockpit')}
        </button>
      ) : null}
      {/* The exit stays while full screen was entered before the window
          became a phone (a rotated device), so it can still be left. */}
      {!phoneMode || isFullscreen ? (
        <button
          type="button"
          onClick={onToggleFullscreen}
          title={isFullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')}
          aria-label={isFullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')}
          data-preview-fullscreen-toggle
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[12px] text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-7 lg:w-7"
        >
          <Icon name={isFullscreen ? 'collapse' : 'expand'} />
        </button>
      ) : null}
      <button
        type="button"
        onClick={onCollapse}
        title={t('preview.collapse')}
        aria-label={t('preview.collapse')}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[12px] text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-7 lg:w-7"
      >
        »
      </button>
    </div>
  );
}

function PreviewFileTab({
  tabKey,
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
  readonly tabKey: string;
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
      tabIndex={0}
      aria-selected={active}
      title={path}
      draggable
      data-preview-tab={path}
      data-preview-tab-key={tabKey}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tabKey);
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
      onKeyDown={(event) => {
        // Inner buttons (mention, close) keep their own activation.
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      className={`group flex h-7 max-w-40 min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-t-md border border-b-0 px-2 text-[11.5px] select-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
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
          className={`shrink-0 rounded-sm px-0.5 font-mono text-[11px] leading-none transition-colors hover:text-ink ${
            active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint pointer-coarse:text-ink-faint'
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
          active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint pointer-coarse:text-ink-faint'
        }`}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function PreviewSkillTab({
  tabKey,
  name,
  active,
  onActivate,
  onClose,
  onContextMenu,
  onDragStart,
  onDrop,
}: {
  readonly tabKey: string;
  readonly name: string;
  readonly active: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (x: number, y: number) => void;
  readonly onDragStart: () => void;
  readonly onDrop: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      title={`${t('cap.source.builtin')} · ${name} / SKILL.md`}
      draggable
      data-preview-tab={tabKey}
      data-preview-tab-key={tabKey}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tabKey);
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
      onKeyDown={(event) => {
        // The inner close button keeps its own activation.
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      className={`group flex h-7 max-w-48 min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-t-md border border-b-0 px-2 text-[11.5px] select-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
        active ? 'border-hairline bg-paper font-medium text-ink' : 'border-transparent text-ink-faint hover:text-ink-soft'
      }`}
    >
      <span className="min-w-0 truncate">SKILL.md</span>
      <span className="min-w-0 truncate text-[11px] text-ink-faint">{name}</span>
      <button
        type="button"
        aria-label={`${t('common.close')} ${name} SKILL.md`}
        onClick={(event) => { event.stopPropagation(); onClose(); }}
        className={`shrink-0 rounded-sm px-0.5 text-[11px] leading-none transition-colors hover:text-danger ${
          active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint pointer-coarse:text-ink-faint'
        }`}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function PreviewAttachmentTab({
  tabKey,
  item,
  isCopy,
  trustedPath,
  mentionable,
  onMention,
  active,
  onActivate,
  onClose,
  onContextMenu,
  onDragStart,
  onDrop,
}: {
  readonly tabKey: string;
  readonly item: MediaRef;
  readonly isCopy: boolean;
  readonly trustedPath?: string;
  readonly mentionable: boolean;
  readonly onMention: (() => void) | undefined;
  readonly active: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (x: number, y: number) => void;
  readonly onDragStart: () => void;
  readonly onDrop: () => void;
}) {
  const { t } = useI18n();
  const name = attachmentName(item, undefined, item.kind === 'image' ? t('media.image') : t('media.attachment'));
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      title={trustedPath ?? item.path ?? name}
      draggable
      data-preview-tab={item.fileId ?? item.path ?? name}
      data-preview-tab-key={tabKey}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tabKey);
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
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      className={`group flex h-7 max-w-52 min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-t-md border border-b-0 px-2 text-[11.5px] select-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
        active ? 'border-hairline bg-paper font-medium text-ink' : 'border-transparent text-ink-faint hover:text-ink-soft'
      }`}
    >
      <span className="min-w-0 truncate">{name}</span>
      {isCopy ? (
        <span
          data-preview-copy-badge
          className="shrink-0 rounded-[3px] bg-ink/[0.06] px-1 py-0.5 text-[10px] leading-none font-normal text-ink-faint"
        >
          {t('preview.sentCopyBadge')}
        </span>
      ) : null}
      {mentionable && onMention !== undefined && trustedPath !== undefined ? (
        <button
          type="button"
          data-mention-file={trustedPath}
          aria-label={t('preview.addToChat')}
          title={t('preview.addToChat')}
          onClick={(event) => {
            event.stopPropagation();
            onMention();
          }}
          className={`shrink-0 rounded-sm px-0.5 font-mono text-[11px] leading-none transition-colors hover:text-ink ${
            active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint pointer-coarse:text-ink-faint'
          }`}
        >
          @
        </button>
      ) : null}
      <button
        type="button"
        aria-label={`${t('common.close')} ${name}`}
        onClick={(event) => { event.stopPropagation(); onClose(); }}
        className={`shrink-0 rounded-sm px-0.5 text-[11px] leading-none transition-colors hover:text-danger ${
          active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint pointer-coarse:text-ink-faint'
        }`}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function PreviewWebTab({
  tabKey,
  url,
  title,
  active,
  onActivate,
  onClose,
  onContextMenu,
  onDragStart,
  onDrop,
}: {
  readonly tabKey: string;
  readonly url: string;
  readonly title?: string;
  readonly active: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (x: number, y: number) => void;
  readonly onDragStart: () => void;
  readonly onDrop: () => void;
}) {
  const { t } = useI18n();
  const label = webUrlDisplayLabel(url, title);
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      title={url}
      draggable
      data-preview-tab={url}
      data-preview-tab-key={tabKey}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tabKey);
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
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      className={`group flex h-7 max-w-44 min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-t-md border border-b-0 px-2 text-[11.5px] select-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
        active ? 'border-hairline bg-paper font-medium text-ink' : 'border-transparent text-ink-faint hover:text-ink-soft'
      }`}
    >
      <Icon name="compass" size={12} className="shrink-0 text-ink-faint" />
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        aria-label={`${t('common.close')} ${label}`}
        onClick={(event) => { event.stopPropagation(); onClose(); }}
        className={`shrink-0 rounded-sm px-0.5 text-[11px] leading-none transition-colors hover:text-danger ${
          active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint pointer-coarse:text-ink-faint'
        }`}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function PreviewPanelTab({
  tabKey,
  tab,
  forest,
  active,
  onActivate,
  onClose,
  onContextMenu,
  onDragStart,
  onDrop,
}: {
  readonly tabKey: string;
  readonly tab: Extract<PreviewTabModel, { kind: 'panel' }>;
  readonly forest?: AgentForest;
  readonly active: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (x: number, y: number) => void;
  readonly onDragStart: () => void;
  readonly onDrop: () => void;
}) {
  const { t } = useI18n();
  const node = forest?.byId[tab.agentId];
  const name = tab.title ?? node?.label ?? tab.agentId;
  const isBusy = node?.busy ?? false;

  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      title={t('preview.agentTabTitle', { name, id: tab.agentId })}
      draggable
      data-preview-tab={tabKey}
      data-preview-tab-key={tabKey}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tabKey);
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
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      className={`group flex h-11 max-w-44 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-[11.5px] select-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-7 ${
        active
          ? 'border-hairline bg-paper font-medium text-ink'
          : 'border-transparent text-ink-faint hover:text-ink-soft'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          isBusy ? 'status-dot-busy bg-accent' : node?.status === 'failed' ? 'bg-danger' : 'bg-ink-faint/60'
        }`}
      />
      <span className="min-w-0 truncate">{name}</span>
      <button
        type="button"
        aria-label={`${t('common.close')} ${name}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-[13px] leading-none transition-colors hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-7 lg:w-5 ${
          active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint pointer-coarse:text-ink-faint'
        }`}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
