/**
 * One capability group, opened: every reported member with its own state, an
 * in-group filter, and one tool that opens the shared tool detail in place.
 * The list is derived from the current tool list on every render, so a group
 * that changed, shrank or left keeps telling the truth; returning from a
 * single tool restores the filter, the scroll position and the focused row.
 * The panel is a read-only view: it never toggles a group.
 */

import type { I18nKey } from '@kiki/session-core/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import { ToolDetailBody } from './ToolDetailBody';
import { capabilityReasonText } from './mapCapabilities';
import { scrollHostOf } from './scrollHost';
import { toolGroupCountRatio, toolGroupNotes, toolGroupOrigin } from './toolGroupText';
import { toolShortName, toolStateBucket, type ToolGroup } from './toolGroups';
import type { AgentToolCapability, CapabilityState } from './types';

type Translate = (key: I18nKey, params?: Record<string, string | number>) => string;

/** The rail's row shape: a full-width quiet row that opens one tool. */
const ROW = 'flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-ink/[0.045] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:min-h-10';

/** Small back control, the same shape the detail shell uses for its own steps. */
const BACK = 'inline-flex h-6 max-w-full shrink-0 items-center gap-1 rounded border border-hairline px-1.5 font-mono text-[11px] text-ink-soft transition-colors hover:bg-paper hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';

/** From a handful of members on, the panel offers its own filter. */
const IN_GROUP_FILTER_MIN = 6;

/** A member's state word: which state it is in, never only a colour. */
function stateWordKey(state: CapabilityState): 'inspector.cap.stateOn' | 'inspector.cap.statePending' | 'inspector.cap.stateOff' | 'inspector.cap.stateDisconnected' | 'inspector.cap.stateUnknown' {
  switch (state) {
    case 'enabled':
      return 'inspector.cap.stateOn';
    case 'approval-required':
      return 'inspector.cap.statePending';
    case 'disabled':
      return 'inspector.cap.stateOff';
    case 'disconnected':
      return 'inspector.cap.stateDisconnected';
    case 'unknown':
      return 'inspector.cap.stateUnknown';
  }
}

function stateWordTone(state: CapabilityState): string {
  if (state === 'approval-required') return 'text-amber-ink';
  if (state === 'disconnected') return 'text-danger';
  return 'text-ink-faint';
}

/** The four sections, in the order the panel always reads them. */
const BUCKETS = [
  { id: 'on', labelKey: 'inspector.cap.stateOn' },
  { id: 'off', labelKey: 'inspector.cap.stateOff' },
  { id: 'disconnected', labelKey: 'inspector.cap.stateDisconnected' },
  { id: 'unknown', labelKey: 'inspector.cap.stateUnknown' },
] as const;

function matches(query: string, tool: AgentToolCapability): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [tool.name, toolShortName(tool.name), tool.description]
    .some((value) => value !== undefined && value.toLowerCase().includes(needle));
}

/** The reason a tool is not usable, which outranks a repeated description. */
function rowDetail(t: Translate, tool: AgentToolCapability): string | undefined {
  const reason = capabilityReasonText(t, tool.unavailableReasonCode, tool.unavailableReason);
  if (reason !== undefined) return reason;
  return tool.description !== undefined && tool.description !== '' ? tool.description : undefined;
}

function ToolRow({ tool, group, onOpen, register }: {
  readonly tool: AgentToolCapability;
  readonly group: ToolGroup;
  readonly onOpen: () => void;
  readonly register: (name: string, element: HTMLButtonElement | null) => void;
}) {
  const { t } = useI18n();
  const bucket = toolStateBucket(tool.state);
  const detail = rowDetail(t, tool);
  const name = group.extension ? toolShortName(tool.name) : tool.name;
  return (
    <li>
      <button
        type="button"
        ref={(element) => { register(tool.name, element); }}
        data-tool-group-item={tool.name}
        onClick={onOpen}
        className={ROW}
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              title={tool.name}
              className={`min-w-0 truncate font-mono text-[12px] ${bucket === 'on' || bucket === 'disconnected' ? 'text-ink' : 'text-ink-faint'}`}
            >
              {name}
            </span>
            <span className={`ml-auto shrink-0 text-[11px] ${stateWordTone(tool.state)}`}>{t(stateWordKey(tool.state))}</span>
          </span>
          {detail !== undefined ? (
            <span className="block truncate text-[11.5px] leading-4 text-ink-faint" title={detail}>{detail}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

export interface ToolGroupDetailProps {
  /** The group as it is reported right now; `null` once it leaves the tool list. */
  readonly group: ToolGroup | null;
  /** The machine key of the group being viewed, kept while it is gone. */
  readonly groupKey: string;
  /** The group's display title, already resolved. */
  readonly title: string;
  /** The tab this group came from (`工具` / `扩展`), for the back label. */
  readonly tabLabel: string;
  /** Rail-hosted panel: it owns the back focus and Escape. The drawer shell already does. */
  readonly inlineDetail: boolean;
  readonly onBack: () => void;
}

export function ToolGroupDetail({
  group,
  groupKey,
  title,
  tabLabel,
  inlineDetail,
  onBack,
}: ToolGroupDetailProps) {
  const { t } = useI18n();
  const backRef = useRef<HTMLButtonElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const restoreRow = useRef<string | null>(null);
  const restoreTarget = useRef<HTMLElement | null>(null);
  const restoreScroll = useRef<number | null>(null);
  const [query, setQuery] = useState('');
  const [toolName, setToolName] = useState<string | null>(null);
  const openTool = group === null || toolName === null
    ? undefined
    : group.tools.find((tool) => tool.name === toolName);

  // A rail swaps the chip cluster for this panel; keyboard users land on the
  // way back instead of losing their place in the page.
  useEffect(() => {
    if (inlineDetail) backRef.current?.focus();
  }, [inlineDetail]);

  // Coming back from a single tool puts the reader back on the row they
  // opened and puts the host's scroll offset back exactly where it was.
  useLayoutEffect(() => {
    if (openTool !== undefined) return;
    const name = restoreRow.current;
    if (name === null) return;
    restoreRow.current = null;
    if (restoreTarget.current !== null && restoreScroll.current !== null) {
      restoreTarget.current.scrollTop = restoreScroll.current;
      restoreTarget.current = null;
      restoreScroll.current = null;
    }
    rows.current.get(name)?.focus({ preventScroll: true });
  }, [openTool]);

  const showTool = (name: string) => {
    const host = scrollHostOf(rows.current.get(name));
    restoreTarget.current = host;
    restoreScroll.current = host === null ? null : host.scrollTop;
    setToolName(name);
  };

  const closeTool = (name: string) => {
    restoreRow.current = name;
    setToolName(null);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !inlineDetail) return;
    event.stopPropagation();
    if (openTool !== undefined) {
      closeTool(openTool.name);
      return;
    }
    if (query !== '') {
      setQuery('');
      return;
    }
    onBack();
  };

  if (openTool !== undefined) {
    return (
      <div data-tool-group-detail={groupKey} data-tool-group-view="tool" className="text-[12.5px]" onKeyDown={onKeyDown}>
        <button
          type="button"
          data-tool-group-tool-back
          onClick={() => { closeTool(openTool.name); }}
          className={BACK}
        >
          <Icon name="arrowLeft" size={12} />
          <span className="truncate">{title}</span>
        </button>
        <div className="mt-2.5">
          {/* One tool reads exactly as it does when opened directly. */}
          <ToolDetailBody tool={openTool} />
        </div>
      </div>
    );
  }

  const back = (
    <div className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        ref={backRef}
        data-tool-group-back
        onClick={onBack}
        className={BACK}
      >
        <Icon name="arrowLeft" size={12} />
        <span className="truncate">{t('inspector.cap.backToTab', { tab: tabLabel })}</span>
      </button>
    </div>
  );

  if (group === null) {
    return (
      <div data-tool-group-detail={groupKey} data-tool-group-view="gone" className="text-[12.5px]" onKeyDown={onKeyDown}>
        {back}
        <h3 className="mt-2 text-[14px] leading-5 font-medium text-ink">{title}</h3>
        <p data-tool-group-gone role="status" className="mt-1 text-[12px] leading-relaxed text-ink-faint">
          {t('inspector.cap.groupGone')}
        </p>
      </div>
    );
  }

  const counts = group.counts;
  const visible = group.tools.filter((tool) => matches(query, tool));
  const origin = toolGroupOrigin(t, group);
  const meta = [toolGroupCountRatio(t, counts), origin, ...toolGroupNotes(t, counts)]
    .filter((part): part is string => part !== undefined);
  const filtering = query.trim() !== '';

  return (
    <div data-tool-group-detail={groupKey} data-tool-group-view="list" className="text-[12.5px]" onKeyDown={onKeyDown}>
      <header className="border-b border-hairline pb-2.5">
        {back}
        <h3 data-tool-group-title className="mt-2 text-[14px] leading-5 font-medium break-words text-ink">{title}</h3>
        <p data-tool-group-meta className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[11.5px] leading-4 text-ink-faint">
          <span className="tabular-nums">{meta[0]}</span>
          {meta.slice(1).map((part) => (
            <span key={part} className="flex items-baseline gap-1.5"><span aria-hidden>·</span>{part}</span>
          ))}
        </p>
      </header>

      {counts.total >= IN_GROUP_FILTER_MIN || filtering ? (
        <label className="relative mt-2.5 block">
          <span className="sr-only">{t('inspector.cap.inGroupSearch')}</span>
          <Icon name="search" size={12} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            data-tool-group-search
            value={query}
            onChange={(event) => { setQuery(event.target.value); }}
            onKeyDown={(event) => { if (event.key === 'Escape' && query !== '') { event.stopPropagation(); setQuery(''); } }}
            placeholder={t('inspector.cap.inGroupSearch')}
            className="h-7 w-full rounded-md border border-hairline bg-transparent pr-2 pl-7 text-[12px] text-ink placeholder:text-ink-faint transition-colors hover:border-hairline-strong focus:border-hairline-strong focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-selected-ink pointer-coarse:h-9"
          />
        </label>
      ) : null}
      {filtering ? (
        <p data-tool-group-count className="mt-1 text-[11.5px] text-ink-faint tabular-nums">
          {t('inspector.cap.showingCount', { shown: visible.length, total: counts.total })}
        </p>
      ) : null}

      {/* One scroll region per host: the rail's own column, or the drawer body. */}
      <div data-tool-group-list className="mt-2">
        {visible.length === 0 ? (
          <p data-tool-group-no-match className="px-2 py-2 text-[12px] text-ink-faint">{t('inspector.cap.noGroupMatch')}</p>
        ) : BUCKETS.map((bucket) => {
          const members = visible.filter((tool) => toolStateBucket(tool.state) === bucket.id);
          if (members.length === 0) return null;
          return (
            <section key={bucket.id} data-tool-group-section={bucket.id} className="pt-2 first:pt-0">
              <h4 className="flex items-baseline gap-1.5 px-2 pb-1 text-[11px] font-medium text-ink-faint">
                {t(bucket.labelKey)}
                <span className="font-normal tabular-nums">{members.length}</span>
              </h4>
              <ul>
                {members.map((tool) => (
                  <ToolRow
                    key={tool.name}
                    tool={tool}
                    group={group}
                    onOpen={() => { showTool(tool.name); }}
                    register={(name, element) => {
                      if (element === null) rows.current.delete(name);
                      else rows.current.set(name, element);
                    }}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
