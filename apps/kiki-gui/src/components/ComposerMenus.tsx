import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useNavigate } from 'react-router-dom';
import type { AgentReferenceCandidate, ExecutorModelCatalogResponse, FsSearchHit } from '@kiki/protocol';
import type { SlashActionId, SlashItem } from '@kiki/session-core/commands';
import type { ExecutionChoice } from '@kiki/session-core/composer';
import type { I18nKey } from '@kiki/session-core/i18n';
import { sortThinkingEffortsForDisplay, type ComposerModelSource } from '@kiki/session-core/settings';

import { useI18n } from '../i18n';
import { agentUnavailableReason, type AgentCandidateGroup } from '../lib/agentMentionCandidates';
import { isExecutorActionAvailable, mapExecutorCapabilities } from '../lib/executorCapabilities';
import type { FsSearchFeedView } from '../lib/fsSearchFeed';
import { useCoarsePointer } from '../lib/layoutHooks';
import { lazyComponent } from '../lib/lazyComponent';
import { getPickerScaleConfig } from '../lib/subagentScaleConfig';
import { formatThinkingEffortWord } from '../lib/thinkingEffort';
import { pushToast } from '../lib/toasts';
import { registerOverlay } from '../lib/uiBusy';
import {
  ComposerPanelOrigin,
  STATUS_SEGMENT_CLASS,
  STATUS_SEGMENT_ICON_CLASS,
  STATUS_SEGMENT_SET,
} from './ComposerControls';
import { WORKING_QUIET_THRESHOLD_MS, formatWorkingDuration, formatWorkingQuietAgo } from './composerWorking';
import { FileGlyph } from './ContextChips';
import { Icon } from './icons';
import { useNow } from './RelativeTime';
import type { SearchableSelectOption } from './SearchableSelect';

const ModelPicker = lazyComponent(() => import('./ModelPicker').then((m) => m.ModelPicker));
const AnchoredFloatingPopover = lazyComponent(() => import('./ComposerPopovers').then((m) => m.AnchoredFloatingPopover));

if (import.meta.env.MODE === 'test') {
  await Promise.all([ModelPicker.preload(), AnchoredFloatingPopover.preload()]);
}

const SLASH_ACTION_DESCRIPTIONS: Record<SlashActionId, I18nKey> = {
  plan: 'composer.slash.plan',
  goal: 'composer.slash.goal',
  new: 'composer.slash.new',
  btw: 'composer.slash.btw',
  branch: 'composer.slash.branch',
  fork: 'composer.slash.fork',
  undo: 'composer.slash.undo',
  compact: 'composer.slash.compact',
};

export function SlashMenuBody({
  items,
  activeIndex,
  skillsFailed,
  hasSession,
  onAccept,
  onHoverRow,
}: {
  items: readonly SlashItem[];
  activeIndex: number;
  skillsFailed: boolean;
  hasSession: boolean;
  onAccept: (item: SlashItem) => void;
  onHoverRow: (index: number) => void;
}) {
  const { t } = useI18n();
  const coarsePointer = useCoarsePointer();
  const pickerScale = getPickerScaleConfig();
  const rootRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

  const flatRows = useMemo(() => {
    const rows: { readonly item: SlashItem; readonly index: number; readonly header: string | null }[] = [];
    let seenSkill = false;
    let seenPlugin = false;
    let seenAction = false;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]!;
      let header: string | null = null;
      if (item.kind === 'skill' && !seenSkill) {
        seenSkill = true;
        header = t('composer.slash.skills');
      } else if (item.kind === 'plugin' && !seenPlugin) {
        seenPlugin = true;
        header = t('composer.slash.plugins');
      } else if (item.kind === 'action' && !seenAction) {
        seenAction = true;
        header = t('composer.slash.shortcuts');
      }
      rows.push({ item, index: i, header });
    }
    return rows;
  }, [items, t]);

  useLayoutEffect(() => {
    const parent = rootRef.current?.closest<HTMLElement>('[data-composer-menu]') ?? null;
    setScrollEl((prev) => (prev === parent ? prev : parent));
  }, []);

  const isVirtualized = flatRows.length > pickerScale.selectVirtualizeThreshold;
  const virtualizer = useVirtualizer({
    count: isVirtualized ? flatRows.length : 0,
    getScrollElement: () => scrollEl,
    estimateSize: (index) => (flatRows[index]?.header !== null ? 58 : 34),
    getItemKey: (index) => {
      const entry = flatRows[index];
      return entry === undefined ? index : `${entry.item.kind}-${entry.item.name}`;
    },
    overscan: pickerScale.virtualOverscan,
    initialRect: { width: 420, height: 280 },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement;
      if (el === null) return;
      const emit = () => {
        const rect = el.getBoundingClientRect();
        const height = Math.round(rect.height || el.clientHeight);
        const width = Math.round(rect.width || el.clientWidth);
        if (height > 0) cb({ width, height });
      };
      emit();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(emit);
      observer.observe(el);
      return () => { observer.disconnect(); };
    },
    measureElement: (el) => {
      const height = Math.round(el.getBoundingClientRect().height);
      return height > 0 ? height : 34;
    },
    useFlushSync: false,
  });

  useLayoutEffect(() => {
    if (isVirtualized && scrollEl !== null && activeIndex >= 0 && activeIndex < flatRows.length) {
      if (scrollEl.scrollHeight > scrollEl.clientHeight) {
        virtualizer.scrollToIndex(activeIndex, { align: 'auto' });
      } else {
        const item = virtualizer.measurementsCache[activeIndex];
        if (item !== undefined) {
          const viewportH = scrollEl.clientHeight > 0 ? scrollEl.clientHeight : 280;
          const maxOffset = Math.max(0, virtualizer.getTotalSize() - viewportH);
          const current = scrollEl.scrollTop;
          let target = current;
          if (item.end > current + viewportH) target = item.end - viewportH;
          else if (item.start < current) target = item.start;
          const clamped = Math.max(0, Math.min(maxOffset, Math.round(target)));
          if (clamped !== current) {
            scrollEl.scrollTop = clamped;
            scrollEl.dispatchEvent(new Event('scroll'));
          }
        }
      }
      return;
    }
    const active = rootRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, flatRows.length, isVirtualized, scrollEl, virtualizer]);

  const renderEntry = (entry: { readonly item: SlashItem; readonly index: number; readonly header: string | null }) => {
    const { item, index, header } = entry;
    const active = index === activeIndex;
    const argHint = item.skill?.argument_hint ?? item.argumentHint;
    const descriptionText =
      item.kind === 'action' && item.action !== undefined
        ? t(SLASH_ACTION_DESCRIPTIONS[item.action])
        : item.description;
    return (
      <>
        {header !== null ? (
          <p className="px-3 pt-1.5 pb-1 text-[12px] font-normal text-ink-faint">
            {header}
          </p>
        ) : null}
        <button
          type="button"
          role="option"
          aria-selected={active}
          aria-disabled={item.disabled === true}
          aria-setsize={isVirtualized ? flatRows.length : undefined}
          aria-posinset={isVirtualized ? index + 1 : undefined}
          onClick={() => { onAccept(item); }}
          onMouseEnter={() => { onHoverRow(index); }}
          className={`flex w-full items-baseline gap-2 rounded-md px-3 py-1.5 text-left transition-colors pointer-coarse:min-h-11 pointer-coarse:items-center ${
            item.disabled === true ? 'opacity-50' : ''
          } ${active ? 'bg-paper' : 'hover:bg-paper'}`}
        >
          <span className={`shrink-0 font-mono text-[12.5px] font-normal ${active ? 'text-selected-ink' : 'text-ink'}`}>
            /{item.name}
          </span>
          {argHint !== undefined ? (
            <span className="max-w-32 truncate font-mono text-[11px] text-ink-faint">{argHint}</span>
          ) : null}
          <span
            title={descriptionText}
            className={`min-w-0 flex-1 text-[13px] text-ink-soft ${
              active && item.kind === 'plugin'
                ? 'whitespace-normal break-words max-[640px]:leading-snug min-[641px]:truncate'
                : 'truncate'
            }`}
          >
            {descriptionText}
          </span>
          {item.disabled === true ? (
            <span className="shrink-0 text-[12px] text-ink-faint">{t('composer.slash.notActivatable')}</span>
          ) : item.kind === 'skill' ? (
            <span title={item.skill?.path} className="shrink-0 text-[12px] text-ink-faint">{item.skill?.source}</span>
          ) : item.kind === 'plugin' && item.pluginId !== undefined ? (
            <span className="shrink-0 font-mono text-[11.5px] text-ink-faint">{item.pluginId}</span>
          ) : null}
        </button>
      </>
    );
  };

  return (
    <div ref={rootRef}>
      {isVirtualized ? (
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((row) => {
            const entry = flatRows[row.index];
            if (entry === undefined) return null;
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${row.start}px)`,
                }}
              >
                {renderEntry(entry)}
              </div>
            );
          })}
        </div>
      ) : (
        flatRows.map((entry) => (
          <div key={`${entry.item.kind}-${entry.item.name}`}>
            {renderEntry(entry)}
          </div>
        ))
      )}
      {items.length === 0 ? (
        <p className="px-3 py-2 text-[13px] text-ink-faint">
          {t(coarsePointer ? 'composer.slash.emptyTouch' : 'composer.slash.empty')}
        </p>
      ) : null}
      {skillsFailed && hasSession ? (
        <p className="border-t border-hairline px-3 py-1 text-[12px] text-ink-faint">
          {t('composer.slash.skillsFailed')}
        </p>
      ) : null}
    </div>
  );
}

export function SkillPreviewCard({ item }: { item: SlashItem }) {
  const { t } = useI18n();
  const skill = item.skill;
  return (
    <div
      data-skill-preview
      role="tooltip"
      aria-label={t('composer.slash.previewAria')}
      className="anim-enter pointer-events-none absolute right-0 bottom-full z-40 mb-1 hidden w-72 translate-x-[calc(100%+0.5rem)] rounded-[10px] border border-hairline bg-panel p-3 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)] min-[1360px]:block"
    >
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[12px] font-normal text-accent-ink">
          /{item.name}
        </span>
        {skill !== undefined ? (
          <span className="shrink-0 rounded-full border border-hairline px-1.5 py-px text-[11px] text-ink-faint">
            {skill.source}
          </span>
        ) : item.pluginId !== undefined ? (
          <span className="shrink-0 rounded-full border border-hairline px-1.5 py-px font-mono text-[11px] text-ink-faint">
            {item.pluginId}
          </span>
        ) : null}
        {item.disabled === true ? (
          <span className="shrink-0 text-[11px] text-ink-faint">
            {t('composer.slash.notActivatable')}
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 max-h-36 overflow-y-auto text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-soft">
        {item.description}
      </p>
      {skill !== undefined ? (
        <p title={skill.path} className="mt-2 truncate font-mono text-[11px] text-ink-faint">
          {skill.path}
        </p>
      ) : null}
    </div>
  );
}

export function MentionMenuBody({
  items,
  agentGroups,
  agentsFailed,
  delegationAvailable,
  delegationReason,
  activeIndex,
  loading,
  feed,
  query,
  onAccept,
  onAcceptAgent,
}: {
  items: readonly FsSearchHit[];
  agentGroups: readonly AgentCandidateGroup[];
  agentsFailed: boolean;
  delegationAvailable: boolean;
  delegationReason?: string;
  activeIndex: number;
  loading: boolean;
  feed: FsSearchFeedView;
  query: string;
  onAccept: (item: FsSearchHit) => void;
  onAcceptAgent: (candidate: AgentReferenceCandidate) => void;
}) {
  const { t } = useI18n();
  const pickerScale = getPickerScaleConfig();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const setListNode = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    setListEl(node);
  }, []);
  const pending = feed.pendingMore || feed.pendingRestart;

  type FlatMentionRow =
    | { readonly kind: 'file'; readonly key: string; readonly index: number; readonly item: FsSearchHit }
    | {
        readonly kind: 'agent';
        readonly key: string;
        readonly index: number;
        readonly candidate: AgentReferenceCandidate;
        readonly groupLabel: string | null;
        readonly showDelegationNote: boolean;
      };

  const flatRows = useMemo<readonly FlatMentionRow[]>(() => {
    const out: FlatMentionRow[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]!;
      out.push({ kind: 'file', key: `file:${item.path}`, index: i, item });
    }
    let idx = items.length;
    let delegationBannerPlaced = false;
    for (let g = 0; g < agentGroups.length; g += 1) {
      const group = agentGroups[g]!;
      for (let c = 0; c < group.candidates.length; c += 1) {
        const candidate = group.candidates[c]!;
        const showDelegationNote = !delegationBannerPlaced && !delegationAvailable;
        if (showDelegationNote) delegationBannerPlaced = true;
        out.push({
          kind: 'agent',
          key: `agent:${group.group}:${candidate.profile}`,
          index: idx,
          candidate,
          groupLabel: c === 0 ? group.label : null,
          showDelegationNote,
        });
        idx += 1;
      }
    }
    return out;
  }, [items, agentGroups, delegationAvailable]);

  const bothEmpty = flatRows.length === 0;
  const isVirtualized = flatRows.length > pickerScale.selectVirtualizeThreshold;

  const virtualizer = useVirtualizer({
    count: isVirtualized ? flatRows.length : 0,
    getScrollElement: () => listEl,
    estimateSize: (index) => {
      const row = flatRows[index];
      if (row === undefined) return 34;
      if (row.kind === 'agent') {
        return 34 + (row.groupLabel !== null ? 26 : 0) + (row.showDelegationNote ? 34 : 0);
      }
      return 34;
    },
    getItemKey: (index) => flatRows[index]?.key ?? index,
    overscan: pickerScale.virtualOverscan,
    initialRect: { width: 420, height: 256 },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement;
      if (el === null) return;
      const emit = () => {
        const rect = el.getBoundingClientRect();
        const height = Math.round(rect.height || el.clientHeight);
        const width = Math.round(rect.width || el.clientWidth);
        if (height > 0) cb({ width, height });
      };
      emit();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(emit);
      observer.observe(el);
      return () => { observer.disconnect(); };
    },
    measureElement: (el) => {
      const height = Math.round(el.getBoundingClientRect().height);
      return height > 0 ? height : 34;
    },
    useFlushSync: false,
  });

  useLayoutEffect(() => {
    if (isVirtualized && listEl !== null && activeIndex >= 0 && activeIndex < flatRows.length) {
      if (listEl.scrollHeight > listEl.clientHeight) {
        virtualizer.scrollToIndex(activeIndex, { align: 'auto' });
      } else {
        const item = virtualizer.measurementsCache[activeIndex];
        if (item !== undefined) {
          const viewportH = listEl.clientHeight > 0 ? listEl.clientHeight : 256;
          const maxOffset = Math.max(0, virtualizer.getTotalSize() - viewportH);
          const current = listEl.scrollTop;
          let target = current;
          if (item.end > current + viewportH) target = item.end - viewportH;
          else if (item.start < current) target = item.start;
          const clamped = Math.max(0, Math.min(maxOffset, Math.round(target)));
          if (clamped !== current) {
            listEl.scrollTop = clamped;
            listEl.dispatchEvent(new Event('scroll'));
          }
        }
      }
    } else {
      const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
      active?.scrollIntoView?.({ block: 'nearest' });
    }
    if (
      !loading &&
      !pending &&
      !feed.failed &&
      !feed.exhausted &&
      items.length > 0 &&
      activeIndex >= items.length - 2 &&
      activeIndex < items.length
    ) {
      feed.loadMore();
    }
  }, [activeIndex, items.length, flatRows.length, isVirtualized, listEl, virtualizer, loading, pending, feed]);

  const renderMentionRow = (row: FlatMentionRow) => {
    if (row.kind === 'file') {
      const active = row.index === activeIndex;
      const isDir = row.item.kind === 'directory';
      return (
        <button
          type="button"
          role="option"
          aria-selected={active}
          aria-setsize={isVirtualized ? flatRows.length : undefined}
          aria-posinset={isVirtualized ? row.index + 1 : undefined}
          onClick={() => { onAccept(row.item); }}
          className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors ${
            active ? 'bg-paper' : 'hover:bg-paper'
          }`}
        >
          <FileGlyph dir={isDir} />
          <span className={`shrink-0 font-mono text-[12.5px] font-normal ${active ? 'text-selected-ink' : 'text-ink'}`}>
            {row.item.name}
            {isDir ? '/' : ''}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
            {row.item.path}
          </span>
        </button>
      );
    }
    const { candidate } = row;
    const active = row.index === activeIndex;
    const disabled = !candidate.available;
    const reason = agentUnavailableReason(candidate, t);
    return (
      <>
        {row.showDelegationNote ? (
          <p className="mx-1 mt-1 rounded-md bg-ink/[0.045] px-3 py-1.5 text-[11.5px] text-ink-faint" data-agent-mention-note>
            {t('composer.agentsNoDelegation')}{delegationReason !== undefined && delegationReason !== '' ? ` — ${delegationReason}` : ''}
          </p>
        ) : null}
        {row.groupLabel !== null ? (
          <p className="px-3 pt-1.5 pb-1 text-[12px] font-normal text-ink-faint">
            {row.groupLabel}
          </p>
        ) : null}
        <button
          type="button"
          role="option"
          aria-selected={active}
          aria-disabled={disabled}
          aria-setsize={isVirtualized ? flatRows.length : undefined}
          aria-posinset={isVirtualized ? row.index + 1 : undefined}
          disabled={disabled}
          title={disabled ? reason : undefined}
          onClick={() => { onAcceptAgent(candidate); }}
          className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors ${
            disabled ? 'cursor-not-allowed opacity-45' : active ? 'bg-paper' : 'hover:bg-paper'
          }`}
        >
          <span aria-hidden className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-ink-faint">
            <Icon name="thread" size={12} />
          </span>
          <span className={`shrink-0 text-[12.5px] font-normal ${active && !disabled ? 'text-selected-ink' : 'text-ink'}`}>
            {candidate.label}
          </span>
          <span className="shrink-0 rounded-full border border-hairline px-1.5 py-px text-[10.5px] text-ink-faint">
            {candidate.engine_label}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
            {disabled ? reason : candidate.description ?? ''}
          </span>
        </button>
      </>
    );
  };

  return (
    <>
      {feed.failed ? <p className="px-3 py-2 text-[12px] text-danger">{t('composer.filesFailed')}</p> : null}
      {agentsFailed ? <p className="px-3 py-2 text-[12px] text-ink-faint" data-agent-mention-failed>{t('composer.agentsFailed')}</p> : null}
      {(loading && bothEmpty) || (bothEmpty && feed.exhausted && !feed.failed && !agentsFailed) ? (
        <p className="px-3 py-2 text-[12px] text-ink-faint" data-mention-empty>
          {loading ? t('composer.filesSearching') : query === '' ? t('composer.mentionEmpty') : t('composer.mentionNoMatch', { query })}
        </p>
      ) : null}
      {items.length > 0 ? <p className="px-3 pt-1.5 pb-1 text-[12px] font-normal text-ink-faint">{t('composer.filesHeader')}</p> : null}
      <div ref={setListNode} data-mention-file-list className="max-h-64 overflow-y-auto" onScroll={(event) => {
        const node = event.currentTarget;
        if (!loading && !pending && !feed.failed && !feed.exhausted && node.scrollHeight - node.scrollTop - node.clientHeight <= 32) feed.loadMore();
      }}>
      {isVirtualized ? (
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vRow) => {
            const entry = flatRows[vRow.index];
            if (entry === undefined) return null;
            return (
              <div
                key={vRow.key}
                data-index={vRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vRow.start}px)`,
                }}
              >
                {renderMentionRow(entry)}
              </div>
            );
          })}
        </div>
      ) : (
        flatRows.map((entry) => (
          <div key={entry.key}>
            {renderMentionRow(entry)}
          </div>
        ))
      )}
      </div>
      {!loading && (!feed.exhausted || feed.failed || pending) ? (
        <button type="button" data-mention-file-more={feed.failed ? 'retry' : pending ? 'pending' : 'more'}
          disabled={pending} onClick={feed.failed ? feed.retry : feed.loadMore}
          className="flex w-full rounded-md px-3 py-2 text-left text-[12px] text-ink-soft hover:bg-paper disabled:cursor-wait">
          {feed.failed ? t('common.retry') : pending ? t('sidebar.loadingMore') : t('sidebar.searchLoadMore')}
        </button>
      ) : null}
    </>
  );
}

export function ExternalModelChoice({ choice, engineLabel, executorResponse, executorRefreshBusy, executorRefreshFailed, onRefreshExecutorModels, onChange }: {
  choice: ExecutionChoice;
  engineLabel: string;
  executorResponse?: ExecutorModelCatalogResponse;
  executorRefreshBusy: boolean;
  executorRefreshFailed: boolean;
  onRefreshExecutorModels: () => void;
  onChange: (model: string | undefined) => void;
}) {
  const { t } = useI18n();
  const now = useNow();
  const executorCapabilities = mapExecutorCapabilities(executorResponse, now);
  const model = typeof choice.overrides?.model === 'string' ? choice.overrides.model : undefined;
  const modelDimension = executorCapabilities.models;
  const modelState = modelDimension.kind;
  const reportedValues = modelState === 'ready' || modelState === 'partial'
    ? modelDimension.values ?? []
    : [];
  const currentModelIsUnlisted = modelState === 'ready'
    && model !== undefined
    && model !== ''
    && !reportedValues.includes(model);
  const modelOptions: readonly SearchableSelectOption[] = [
    { value: '', label: t('composer.engineModelFollow') },
    ...reportedValues.map((value) => ({ value, label: value })),
    ...(model !== undefined && model !== '' && !reportedValues.includes(model)
      ? [{
        value: model,
        label: model,
        badges: currentModelIsUnlisted
          ? [{ label: t('composer.engineModelNotInList'), tone: 'caution' as const }]
          : undefined,
      }]
      : []),
  ];
  const statusMessage = modelState === 'loading'
    ? t('composer.engineModelLoading')
    : modelState === 'partial'
      ? t('composer.engineModelPartial', { count: reportedValues.length })
      : modelState === 'unavailable'
        ? t('composer.engineModelUnavailable')
        : modelState === 'unknown' ? t('composer.engineModelUnknown') : undefined;
  const stale = executorCapabilities.freshness === 'stale';
  const modelDiagnostic = modelDimension.diagnostic !== undefined && modelDimension.diagnostic !== ''
    ? modelDimension.diagnostic
    : undefined;
  const modelNote = statusMessage === undefined || (stale && modelState === 'unknown')
    ? undefined
    : (modelState === 'unavailable' || modelState === 'unknown') && modelDiagnostic !== undefined
      ? `${statusMessage} · ${modelDiagnostic}`
      : statusMessage;
  const statusLine = executorRefreshFailed
    ? t('composer.engineCapabilityRefreshFailed')
    : [modelNote, stale ? t('composer.engineCapabilityStale') : undefined]
      .filter((part): part is string => part !== undefined)
      .join(' · ') || undefined;
  const switchControl = executorCapabilities.controls.model_switch;
  const switchLine = switchControl.kind === 'unavailable'
    ? [t('composer.engineModelSwitchUnavailable'), switchControl.diagnostic]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' · ')
    : undefined;
  const panelFooter = (
    <div data-external-model-footer className="flex items-center gap-2 border-t border-hairline px-3 py-1.5 text-[12px] leading-snug text-ink-faint">
      <div data-external-model-status className="min-w-0 flex-1">
        {statusLine !== undefined ? (
          <p
            data-external-model-refresh-error={executorRefreshFailed ? true : undefined}
            className="truncate"
            title={statusLine}
          >
            {statusLine}
          </p>
        ) : null}
        {switchLine !== undefined ? (
          <p data-external-model-switch className="truncate" title={switchLine}>{switchLine}</p>
        ) : null}
      </div>
      <button
        type="button"
        data-external-model-refresh
        aria-label={t('composer.engineCapabilityRefreshAria')}
        title={t('composer.engineCapabilityRefreshAria')}
        disabled={executorRefreshBusy}
        onClick={onRefreshExecutorModels}
        className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-normal text-ink-soft hover:bg-ink/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:cursor-wait disabled:opacity-60"
      >
        {executorRefreshBusy ? t('composer.engineCapabilityRefreshing') : t('composer.engineCapabilityRefresh')}
      </button>
    </div>
  );
  const writable = isExecutorActionAvailable(switchControl) && (modelState === 'ready' || modelState === 'partial');
  if (!writable) return <span className="flex min-w-0 items-center gap-1" data-external-model-readonly>
    <span data-composer-engine-model={engineLabel} className="max-w-56 truncate px-1.5 text-[13px] text-ink-soft" title={[engineLabel, statusLine, switchLine].filter(Boolean).join(' · ')}>
      {model ?? t('composer.engineModelFollow')}
    </span>
    <button type="button" data-external-model-refresh disabled={executorRefreshBusy} onClick={onRefreshExecutorModels}
      aria-label={t('composer.engineCapabilityRefreshAria')} title={statusLine ?? t('composer.engineCapabilityRefreshAria')}
      className="rounded p-1 text-ink-faint hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40">
      <Icon name="refresh" size={12} />
    </button>
  </span>;
  return (
    <ComposerPanelOrigin className="flex min-w-0 [&>div]:min-w-0">
      <ModelPicker
        id="composer-engine-model-select"
        value={model ?? ''}
        options={modelOptions}
        searchPlaceholder={t('composer.engineModelId')}
        allowCustomValue
        customValueLabel={(custom) => custom}
        onChange={(next) => { onChange(next === '' ? undefined : next); }}
        ariaLabel={t('composer.modelAria')}
        title={engineLabel}
        emptyText={t('composer.engineModelFollow')}
        density="compact"
        placement="above"
        hideChevron
        panelClassName="composer-floating-panel w-80"
        panelFooter={panelFooter}
        buttonClassName={`${STATUS_SEGMENT_CLASS} max-w-full ${model === undefined ? '' : STATUS_SEGMENT_SET}`}
      />
    </ComposerPanelOrigin>
  );
}

export function ModelChip({
  modelOptions,
  hasCatalog,
  model,
  resolvedModelKey,
  effectiveModel,
  shortLabel,
  modelSource,
  disabled = false,
  onChangeModel,
  efforts,
  effort,
  onChangeEffort,
  engineLabel,
  executorLabel,
  openSignal,
  domainNote,
}: {
  readonly domainNote?: string;
  readonly modelOptions: readonly SearchableSelectOption[];
  readonly engineLabel?: string;
  readonly executorLabel?: string;
  readonly openSignal?: number;
  readonly hasCatalog: boolean;
  readonly model: string | undefined;
  readonly resolvedModelKey: string | undefined;
  readonly effectiveModel: string | undefined;
  readonly shortLabel?: string;
  readonly modelSource: ComposerModelSource;
  readonly disabled?: boolean;
  readonly onChangeModel: (model: string | undefined) => void | Promise<void>;
  readonly efforts: readonly string[] | undefined;
  readonly effort: string | undefined;
  readonly onChangeEffort: (effort: string) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const displayEfforts = sortThinkingEffortsForDisplay(efforts ?? []);
  const showEffort = displayEfforts.length > 0 && effort !== undefined;
  const sourceTitle = t('composer.modelTitle', { source: t(`composer.modelProvenance.${modelSource}`) });
  const servingEngine = executorLabel ?? engineLabel;
  const baseTitle = servingEngine !== undefined
    ? `${t('composer.engineModelTitle', { model: effectiveModel ?? t('composer.engineModelDefault'), engine: servingEngine })} · ${sourceTitle}`
    : effectiveModel !== undefined ? `${effectiveModel} · ${sourceTitle}` : sourceTitle;
  const title = domainNote === undefined ? baseTitle : `${baseTitle}\n${domainNote}`;

  if (engineLabel !== undefined) {
    return (
      <span
        data-composer-engine-model={engineLabel}
        className="flex h-7 max-w-56 min-w-0 items-center truncate px-1.5 text-[13px] text-ink-soft"
        title={title}
      >
        {shortLabel ?? effectiveModel ?? (engineLabel !== undefined ? t('composer.engineModelDefault') : t('composer.inheritDefault'))}
      </span>
    );
  }

  return (
    <ComposerPanelOrigin className="flex min-w-0 max-w-full [&>div]:min-w-0">
    <ModelPicker
      id="composer-model-select"
      rootClassName="relative flex min-w-0 max-w-full"
      options={hasCatalog ? modelOptions : []}
      allowCustomValue={false}
      hideFilter={!hasCatalog}
      value={hasCatalog ? (resolvedModelKey ?? model ?? '') : (effectiveModel ?? '')}
      onChange={(next) => {
        void Promise.resolve(onChangeModel(next === '' ? undefined : next)).catch(
          (error: unknown) => {
            pushToast({
              tone: 'error',
              text: t('subagent.modelChangeFailed', {
                detail: error instanceof Error ? error.message : String(error),
              }),
            });
          },
        );
      }}
      disabled={disabled}
      openSignal={openSignal}
      title={title}
      ariaLabel={t('composer.modelAria')}
      emptyText={t(effectiveModel === undefined ? 'composer.chooseModel' : 'composer.inheritDefault')}
      searchPlaceholder={t('composer.modelSearchPlaceholder')}
      density="compact"
      placement="above"
      hideChevron
      panelClassName="composer-floating-panel max-h-[min(var(--available-height,420px),420px,calc(100dvh-120px))] w-96 [&>*]:shrink-0 [&>[role=listbox]]:min-h-0 [&>[role=listbox]]:shrink"
      buttonClassName={`${STATUS_SEGMENT_CLASS} max-w-full ${
        modelSource === 'override' ? STATUS_SEGMENT_SET : ''
      } disabled:cursor-not-allowed disabled:opacity-60`}
      triggerIcon={<EffortGauge efforts={displayEfforts} effort={showEffort ? effort : undefined} />}
      triggerLabel={shortLabel}
      triggerSuffix={
        showEffort || domainNote !== undefined ? (
          <>
            {showEffort && effort !== undefined ? (
              <>
                <span aria-hidden className="shrink-0 text-ink-faint/60 @max-[24rem]/toolbar:hidden">·</span>
                <span data-effort-label className="shrink-0 text-ink-faint @max-[24rem]/toolbar:hidden">
                  {formatThinkingEffortWord(effort, t)}
                </span>
              </>
            ) : null}
            {domainNote !== undefined ? (
              <span data-model-domain-note className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-rule">
                <span className="sr-only">{domainNote}</span>
              </span>
            ) : null}
          </>
        ) : null
      }
      panelHeader={
        <div data-model-provenance className="flex items-center gap-2 border-b border-hairline px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[12px] font-normal text-ink-faint">
            {[executorLabel, t(`composer.modelProvenance.${modelSource}`)].filter(Boolean).join(' · ')}
          </span>
          {executorLabel === undefined && model !== undefined && hasCatalog && !disabled ? (
            <button
              type="button"
              data-model-reset
              onClick={() => { void Promise.resolve(onChangeModel(undefined)).catch(() => undefined); }}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] font-normal text-ink-soft underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
            >
              {t('composer.modelResetDefault')}
            </button>
          ) : null}
        </div>
      }
      panelFooter={
        <>
        {showEffort ? (
          <div className="flex items-center gap-2 border-t border-hairline px-3 py-2">
            <span className="shrink-0 text-[12px] font-normal text-ink-faint">
              {t('composer.effortHeading')}
            </span>
            <div
              role="radiogroup"
              aria-label={t('composer.effortTitle')}
              className="ml-auto flex items-center gap-0.5 rounded-md bg-paper p-0.5"
            >
              {displayEfforts.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={level === effort}
                  data-effort={level}
                  disabled={disabled}
                  onClick={() => { onChangeEffort(level); }}
                  className={`rounded-[5px] px-2 py-0.5 text-[12px] transition-colors focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none ${
                    level === effort
                      ? 'bg-panel text-ink shadow-[var(--kiki-sheet-shadow)]'
                      : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  {t(`composer.effort.${level}` as I18nKey) === `composer.effort.${level}` ? <span className="capitalize">{level}</span> : t(`composer.effort.${level}` as I18nKey)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {executorLabel === undefined ? <button
          type="button"
          data-model-configure
          onClick={() => { void navigate('/settings/ai?tab=providers#st-card-providers-add'); }}
          className="w-full border-t border-hairline px-3 py-2 text-left text-[12px] font-normal text-ink-soft hover:bg-paper hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
        >
          {t('composer.configureModels')}
        </button> : null}
        </>
      }
    />
    </ComposerPanelOrigin>
  );
}

function EffortGauge({
  efforts,
  effort,
}: {
  readonly efforts: readonly string[] | undefined;
  readonly effort: string | undefined;
}) {
  const index = effort === undefined || efforts === undefined ? -1 : efforts.indexOf(effort);
  const lit = index < 0 || efforts === undefined ? 0 : Math.max(1, Math.round(((index + 1) / efforts.length) * 3));
  return (
    <svg
      aria-hidden
      data-effort-gauge={lit}
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 shrink-0 ${STATUS_SEGMENT_ICON_CLASS}`}
    >
      {[5, 8, 11].map((height, bar) => (
        <rect
          key={height}
          x={2.6 + bar * 4}
          y={13.2 - height}
          width={2.6}
          height={height}
          rx={1.1}
          fill="currentColor"
          opacity={bar < lit ? 1 : 0.28}
        />
      ))}
    </svg>
  );
}

export function ComposerWorkingLine({
  startedAt,
  lastResponseAt,
  queued,
  sendNowHint,
}: {
  readonly startedAt?: number | undefined;
  readonly lastResponseAt: number | undefined;
  readonly queued?: {
    readonly waitedMs: number;
    readonly modelId?: string;
    readonly blockingRules?: readonly string[];
  };
  readonly sendNowHint: string | undefined;
}) {
  const { t } = useI18n();
  const now = useNow();
  const navigate = useNavigate();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!detailsOpen) return undefined;
    const onPointerDown = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setDetailsOpen(false);
      }
    };
    const unregister = registerOverlay('composer-queued-details');
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setDetailsOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      unregister();
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [detailsOpen]);

  const isQueued = queued !== undefined;
  const waitedSec = queued !== undefined ? Math.max(1, Math.round(queued.waitedMs / 1000)) : 1;
  const elapsedMs = startedAt === undefined ? undefined : Math.max(0, now - startedAt);
  const quietMs = lastResponseAt === undefined ? undefined : Math.max(0, now - lastResponseAt);
  const status = elapsedMs !== undefined
    ? quietMs !== undefined && quietMs >= WORKING_QUIET_THRESHOLD_MS
      ? t('composer.workingElapsedLastResponse', {
          elapsed: formatWorkingDuration(elapsedMs, t),
          ago: formatWorkingQuietAgo(quietMs, t),
        })
      : t('composer.workingElapsed', { elapsed: formatWorkingDuration(elapsedMs, t) })
    : quietMs !== undefined
      ? t('composer.workingLastResponse', { ago: formatWorkingQuietAgo(quietMs, t) })
      : t('composer.working');

  return (
    <div className="relative flex min-w-0 items-center">
      <p
        data-composer-working
        data-turn-started-at={startedAt}
        data-last-response-at={lastResponseAt}
        className="anim-enter flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-faint"
      >
        <span aria-hidden className="status-dot-busy h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
        {isQueued ? (
          <span data-composer-queued className="flex shrink-0 items-center gap-1">
            <button
              ref={triggerRef}
              type="button"
              data-composer-queued-trigger
              aria-expanded={detailsOpen}
              onClick={() => { setDetailsOpen((v) => !v); }}
              className="font-normal text-ink-soft underline decoration-dotted transition-colors hover:text-ink hover:decoration-solid focus-visible:outline-2 focus-visible:outline-selected-ink"
            >
              {t('composer.queued')}
            </button>
          </span>
        ) : (
          <span className="min-w-0 truncate tabular-nums">{status}</span>
        )}
        {sendNowHint !== undefined ? (
          <span
            data-composer-send-now-hint
            className="min-w-0 shrink-0 truncate @max-[360px]/statusline:hidden pointer-coarse:hidden"
          >
            · {sendNowHint}
          </span>
        ) : null}
      </p>

      {isQueued && detailsOpen ? (
        <AnchoredFloatingPopover
          anchorRef={triggerRef}
          side="top"
          align="start"
          sideOffset={8}
          popupRef={panelRef}
          dataAttrs={{ 'data-composer-queued-popover': '' }}
          onOpenChange={(nextOpen, eventDetails) => {
            if (nextOpen) return;
            setDetailsOpen(false);
            if (eventDetails.reason === 'escape-key') {
              triggerRef.current?.focus();
            }
          }}
          className="anim-enter w-72 max-w-[calc(100vw-24px)] rounded-lg border border-hairline bg-paper p-3 shadow-lg text-[12px] text-ink outline-none"
        >
          <div className="flex items-center justify-between pb-1.5 border-b border-hairline/60">
            <span className="font-bold">{t('composer.queuedTitle')}</span>
            <span className="font-mono text-[11px] text-ink-faint tabular-nums">
              {t('composer.queuedWaited', { seconds: waitedSec })}
            </span>
          </div>
          <p className="mt-1.5 leading-snug text-ink-soft text-[11.5px]">
            {t('composer.queuedBody')}
          </p>
          {queued.modelId !== undefined ? (
            <p className="mt-1 font-mono text-[11px] text-ink-faint">
              {t('composer.queuedModel', { model: queued.modelId })}
            </p>
          ) : null}
          {queued.blockingRules !== undefined && queued.blockingRules.length > 0 ? (
            <p className="mt-0.5 text-[11px] text-ink-faint">
              {t('composer.queuedRules', { rules: queued.blockingRules.join(', ') })}
            </p>
          ) : null}
          <div className="mt-2.5 pt-1.5 border-t border-hairline/60">
            <button
              type="button"
              data-composer-queued-usage
              onClick={() => {
                setDetailsOpen(false);
                void navigate('/usage');
              }}
              className="text-[11.5px] font-normal text-selected-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
            >
              {t('composer.queuedUsageLink')}
            </button>
          </div>
        </AnchoredFloatingPopover>
      ) : null}
    </div>
  );
}
