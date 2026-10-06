/**
 * What the agent can use, as four tabs under the profile card: Tools, Skills,
 * Subagents, Extensions. Tools and extensions are one chip per group — a
 * built-in category, one MCP server, one plugin, or the user's own tools —
 * each carrying `on/total` and the five reported states, so a full agent
 * never grows the rail by one row per tool. Skills stay chips by scope and
 * subagents stay rows. A chip only ever opens its group; the group's complete
 * member list (and the one tool inside it) is where a tool is read.
 *
 * The two ways in are deliberately different. Hover or keyboard focus shows
 * one short preview in a floating layer anchored to the chip, so passing the
 * pointer over the cluster never moves anything on the page. A click expands
 * the group in place, directly under the chips, so the reader keeps the
 * cluster, the tab strip and the surrounding sections in view while the
 * group's membership is open below it.
 */

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import {
  AgentDetailDrawer,
  type DetailDrawerTarget,
} from './AgentDetailDrawer';
import { GroupPreviewCard, type GroupPreviewAnchor } from './GroupPreviewCard';
import { SkillChipCluster, type SkillFoldState } from './SkillChipCluster';
import { ToolGroupDetail } from './ToolGroupDetail';
import { capabilityReasonText } from './mapCapabilities';
import { scrollHostOf } from './scrollHost';
import { capabilitySourceLabel, SOURCE_TONE_CLASS, type SourceLabel } from './sourceLabel';
import {
  extensionOwner,
  matchToolGroups,
  toolGroups,
  type ToolGroup,
} from './toolGroups';
import { toolGroupCountLine, toolGroupCountRatio, toolGroupNotes, toolGroupTitle } from './toolGroupText';
import type {
  AgentSkillCapability,
  AgentSubagentTarget,
  AgentToolCapability,
} from './types';

export { extensionOwner };

export type CapabilityTab = 'tools' | 'skills' | 'subagents' | 'extensions';

export interface AgentCapabilitiesSectionProps {
  readonly tools: readonly AgentToolCapability[];
  readonly skills: readonly AgentSkillCapability[];
  readonly subagentTargets: readonly AgentSubagentTarget[];
  readonly draftScope?: { readonly workspace_id?: string; readonly cwd?: string };
  /** The profile these capabilities belong to; drill-ins resolve targets through it. */
  readonly callerProfile?: string;
  readonly initialTab?: CapabilityTab;
}

export interface CapabilityCounts {
  readonly toolsOn: number;
  readonly tools: number;
  readonly skills: number;
  readonly subagents: number;
  readonly extensions: number;
}

/** The numbers the collapsed profile card shows. */
export function capabilityCounts(
  tools: readonly AgentToolCapability[],
  skills: readonly AgentSkillCapability[],
  subagentTargets: readonly AgentSubagentTarget[],
): CapabilityCounts {
  let toolsOn = 0;
  let own = 0;
  let extensions = 0;
  for (const group of toolGroups(tools)) {
    if (group.extension) {
      extensions += 1;
      continue;
    }
    toolsOn += group.counts.on;
    own += group.counts.total;
  }
  return {
    toolsOn,
    tools: own,
    skills: skills.length,
    subagents: subagentTargets.length,
    extensions,
  };
}

const ROW = 'flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-ink/[0.045] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:min-h-10';

function SourceChip({ label }: { label: SourceLabel | undefined }) {
  if (label === undefined) return null;
  return (
    <span
      data-capability-source={label.tone}
      title={label.title}
      className={`shrink-0 rounded px-1.5 py-px text-[11px] leading-4 whitespace-nowrap ${SOURCE_TONE_CLASS[label.tone]}`}
    >
      {label.text}
    </span>
  );
}

/** A state word only when it changes what the agent can do. */
function StateWord({ state, reason }: { state: AgentToolCapability['state']; reason?: string }) {
  const { t } = useI18n();
  if (state === 'enabled') return null;
  if (state === 'approval-required') {
    return <span title={reason} className="shrink-0 text-[11.5px] text-amber-ink">{t('inspector.cap.asks')}</span>;
  }
  return <span title={reason} className="shrink-0 text-[11.5px] text-ink-faint">{t('inspector.cap.unavailable')}</span>;
}

function CapRow({ name, detail, trailing, muted = false, onOpen, ...data }: {
  name: ReactNode;
  detail?: string;
  trailing?: ReactNode;
  muted?: boolean;
  onOpen: () => void;
} & { [key: `data-${string}`]: string | undefined }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className={ROW} {...data}>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[12.5px] leading-5 ${muted ? 'text-ink-faint' : 'text-ink'}`}>{name}</span>
          {detail !== undefined && detail !== '' ? (
            <span className="block truncate text-[11.5px] leading-4 text-ink-faint" title={detail}>{detail}</span>
          ) : null}
        </span>
        {trailing}
      </button>
    </li>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-2 text-[12.5px] text-ink-faint">{children}</p>;
}

/** Rows shown per group before the rest fold into "M more". */
export const CAP_SHOWN = 8;

/**
 * Group chips shown before the rest fold behind "+N groups". A main agent
 * reports roughly 15–18 built-in categories, so the cap sits well above that
 * and a normal tools tab shows every group; the fold exists only for a
 * genuinely long list (dozens of MCP servers). Searching lifts it entirely.
 */
export const TOOL_GROUPS_SHOWN = 24;

/**
 * The "M more" / "Show less" control. It is a chip inside a wrapping chip
 * cluster and a line under a row list, so it renders the element that matches
 * its own container: a list item only where it really is one.
 */
function MoreToggle({ hidden, open, onToggle, chip = false }: { hidden: number; open: boolean; onToggle: () => void; chip?: boolean }) {
  const { t } = useI18n();
  if (hidden <= 0 && !open) return null;
  const button = (
    <button
      type="button"
      data-capability-more={open ? 'less' : hidden}
      aria-expanded={open}
      onClick={onToggle}
      className={`h-7 px-2 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.045] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-9 ${chip ? 'inline-flex items-center rounded-full' : 'rounded-md'}`}
    >
      {open ? t('inspector.cap.less') : t('inspector.cap.more', { count: hidden })}
    </button>
  );
  return chip ? button : <li>{button}</li>;
}

/** Case-insensitive match on any of the given fields. */
function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  return needle === '' || fields.some((field) => field !== undefined && field.toLowerCase().includes(needle));
}

/** First `CAP_SHOWN` of `list` unless opened; an active filter shows every match. */
function capped<T>(list: readonly T[], open: boolean, filtering: boolean): { shown: readonly T[]; hidden: number } {
  if (open || filtering || list.length <= CAP_SHOWN + 1) return { shown: list, hidden: 0 };
  return { shown: list.slice(0, CAP_SHOWN), hidden: list.length - CAP_SHOWN };
}

/** One group as a chip: the name and `x/y`, the states those numbers are made of. */
function GroupChip({
  group,
  title,
  selected,
  describedBy,
  hits,
  register,
  onOpen,
  onPreviewLater,
  onPreviewNow,
  onPreviewOut,
  onPreviewClose,
}: {
  readonly group: ToolGroup;
  readonly title: string;
  readonly selected: boolean;
  readonly describedBy?: string;
  /** Members matching the active query; absent when nothing is being searched. */
  readonly hits?: number;
  readonly register: (element: HTMLButtonElement | null) => void;
  readonly onOpen: () => void;
  /** Pointer: the preview waits out a quick pass-through. */
  readonly onPreviewLater: () => void;
  /** Keyboard focus: immediately. */
  readonly onPreviewNow: () => void;
  /** Pointer left the chip: after a short pause, so a pass-through does not flicker. */
  readonly onPreviewOut: () => void;
  /** Escape or a lost focus: at once. */
  readonly onPreviewClose: () => void;
}) {
  const { t } = useI18n();
  const { counts } = group;
  const allUnknown = counts.total > 0 && counts.unknown === counts.total;
  const noneOn = counts.on === 0 && !allUnknown;
  const countLine = toolGroupCountLine(t, counts);
  // The chip shows the ratio alone; "on" on every bubble states what `x/y`
  // already means. The state word stays in `countLine` for the accessible name.
  const countRatio = toolGroupCountRatio(t, counts);
  const notes = toolGroupNotes(t, counts);
  const tone = selected
    ? 'bg-selected text-selected-ink ring-1 ring-selected-ink/35'
    : allUnknown || noneOn
      // Nothing is on: the lightest ground, a neutral outline, and the count
      // itself — never a low-opacity pill that reads as removed content.
      ? 'border border-hairline text-ink-faint hover:bg-ink/[0.045] hover:text-ink'
      : 'bg-ink/[0.05] text-ink hover:bg-ink/[0.09]';
  return (
    <button
      type="button"
      ref={register}
      data-capability-group-chip={group.key}
      data-capability-group-count={`${counts.on}/${counts.total}`}
      data-capability-group-hits={hits}
      data-capability-group-unknown-count={counts.unknown}
      data-capability-group-unknown={counts.unknown > 0 ? '' : undefined}
      data-capability-group-disconnected={counts.disconnected > 0 ? '' : undefined}
      aria-expanded={selected}
      aria-describedby={describedBy}
      aria-label={[title, countLine, ...notes].join(' · ')}
      onClick={onOpen}
      onMouseEnter={onPreviewLater}
      onMouseLeave={onPreviewOut}
      onFocus={onPreviewNow}
      onBlur={onPreviewClose}
      onKeyDown={(event) => { if (event.key === 'Escape') onPreviewClose(); }}
      className={`inline-flex h-7 max-w-full items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-9 ${tone}`}
    >
      <span className="truncate">{title}</span>
      <span className="flex shrink-0 items-baseline gap-1">
        <span className="tabular-nums">{countRatio}</span>
        {counts.unknown > 0 && counts.on > 0 ? <span aria-hidden className="text-ink-faint">?</span> : null}
        {counts.disconnected > 0 ? (
          <span aria-hidden data-capability-group-flag="disconnected" className="size-1.5 shrink-0 self-center rounded-full bg-danger" />
        ) : null}
      </span>
    </button>
  );
}

/**
 * Rows of chips shown before the rest fold behind "+N more". The skills tab
 * folds on real wrapped rows, not on a chip count, because how many chips
 * share a line is the column's own doing: eight names in a wide panel are
 * two rows, and the same eight in the rail's narrowest column are five.
 * A chip cap therefore reads as arbitrarily short or long in the same build.
 * `SKILL_ROWS` is measured against the row that actually wrapped.
 */
export const SKILL_ROWS = 4;

/** One skill as a compact chip: the name, the description on hover. */
function SkillChip({ skill, onOpen }: { skill: AgentSkillCapability; onOpen: () => void }) {
  const muted = skill.state !== 'enabled';
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-capability-item={skill.name}
        data-capability-chip=""
        title={skill.description === undefined || skill.description === '' ? skill.name : `${skill.name}\n${skill.description}`}
        onClick={onOpen}
        className={`inline-flex h-7 max-w-full items-center rounded-full bg-ink/[0.05] px-2.5 text-[12px] transition-colors hover:bg-ink/[0.09] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-9 ${muted ? 'text-ink-faint line-through decoration-ink-faint/50' : 'text-ink'}`}
      >
        <span className="truncate">{skill.name}</span>
      </button>
    </li>
  );
}

export const AgentCapabilitiesSection = memo(function AgentCapabilitiesSection({
  tools,
  skills,
  subagentTargets,
  draftScope,
  callerProfile,
  initialTab = 'tools',
}: AgentCapabilitiesSectionProps) {
  const { t, tp } = useI18n();
  const baseId = useId();
  const [tab, setTab] = useState<CapabilityTab>(initialTab);
  const [drawerTarget, setDrawerTarget] = useState<DetailDrawerTarget | null>(null);
  // Per tab: a filter, and which groups the user opened past the cap.
  const [query, setQuery] = useState('');
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [groupsExpanded, setGroupsExpanded] = useState(false);
  /** What each skills group's cut hides, measured from the real wrapped rows. */
  const [skillFolds, setSkillFolds] = useState<Readonly<Record<string, SkillFoldState>>>({});
  // The chip whose floating preview is showing, and the group expanded below
  // the cluster. The anchor is captured when the preview opens, so the layer
  // keeps its place while the pointer moves onto it.
  const [preview, setPreview] = useState<{ key: string; anchor: GroupPreviewAnchor } | null>(null);
  const [openGroupKey, setOpenGroupKey] = useState<string | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const chips = useRef(new Map<string, HTMLButtonElement>());
  const clusterBox = useRef<HTMLUListElement | null>(null);
  const knownTitles = useRef(new Map<string, string>());
  const restoreChip = useRef<string | null>(null);
  const restoreTarget = useRef<HTMLElement | null>(null);
  const restoreScroll = useRef<number | null>(null);
  const filtering = query.trim() !== '';
  const previewId = `${baseId}-group-preview`;

  const groups = useMemo(() => toolGroups(tools), [tools]);
  const split = useMemo(() => {
    const toolTab: ToolGroup[] = [];
    const extensionTab: ToolGroup[] = [];
    for (const group of groups) (group.extension ? extensionTab : toolTab).push(group);
    return { toolTab, extensionTab };
  }, [groups]);
  const titleOf = useCallback((group: ToolGroup) => toolGroupTitle(t, group), [t]);
  const tabGroups = tab === 'extensions' ? split.extensionTab : split.toolTab;
  const matches = useMemo(() => matchToolGroups(tabGroups, query, titleOf), [tabGroups, query, titleOf]);
  const openGroup = openGroupKey === null ? null : groups.find((group) => group.key === openGroupKey) ?? null;
  const previewGroup = preview === null ? undefined : groups.find((group) => group.key === preview.key);

  /** The chip's box and the cluster's own width, measured once per open. */
  const measure = useCallback((key: string): GroupPreviewAnchor | null => {
    const chip = chips.current.get(key);
    if (chip === undefined) return null;
    return {
      rect: chip.getBoundingClientRect(),
      clusterWidth: clusterBox.current?.getBoundingClientRect().width ?? chip.getBoundingClientRect().width,
    };
  }, []);

  // A group that leaves the current tool list still has a name to show.
  useEffect(() => {
    for (const group of groups) knownTitles.current.set(group.key, toolGroupTitle(t, group));
  }, [groups, t]);

  const clearHoverTimer = () => {
    if (hoverTimer.current !== undefined) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = undefined;
    }
  };
  useEffect(() => clearHoverTimer, []);
  const showPreview = (key: string) => {
    const anchor = measure(key);
    setPreview(anchor === null ? null : { key, anchor });
  };
  const previewNow = (key: string) => {
    clearHoverTimer();
    showPreview(key);
  };
  const previewLater = (key: string) => {
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = undefined;
      showPreview(key);
    }, 250);
  };
  // Leaving the chip or the card closes it; the pause keeps a pointer that
  // travels between the two from flickering.
  const previewOff = () => {
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = undefined;
      setPreview(null);
    }, 140);
  };
  const previewClose = () => {
    clearHoverTimer();
    setPreview(null);
  };

  const toggleGroup = (key: string) => {
    setOpenGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const setSkillFold = useCallback((key: string, state: SkillFoldState) => {
    setSkillFolds((previous) => {
      const current = previous[key];
      if (current?.hidden === state.hidden && current.folding === state.folding) return previous;
      return { ...previous, [key]: state };
    });
  }, []);

  const chooseTab = (next: CapabilityTab) => {
    setTab(next);
    setQuery('');
    setGroupsExpanded(false);
    setPreview(null);
    clearHoverTimer();
    // A group belongs to the tab it was opened from. Since the panel now
    // expands in place, a group left open across a tab switch would sit in
    // another tab's cluster and read as that tab's detail.
    setOpenGroupKey(null);
  };
  const openToolGroup = (key: string) => {
    clearHoverTimer();
    setPreview(null);
    // The host's single scroll region is where the reader was; remember it so
    // the way back lands on the same row of chips, not on a re-centred page.
    const host = scrollHostOf(chips.current.get(key));
    restoreScroll.current = host === null ? null : host.scrollTop;
    restoreTarget.current = host;
    setOpenGroupKey(key);
  };
  const closeToolGroup = () => {
    restoreChip.current = openGroupKey;
    setOpenGroupKey(null);
  };
  // Back from a group returns the reader to the chip they came from and puts
  // the host scroll back where it was.
  useEffect(() => {
    const key = restoreChip.current;
    if (key === null) return;
    restoreChip.current = null;
    if (restoreTarget.current !== null && restoreScroll.current !== null) {
      restoreTarget.current.scrollTop = restoreScroll.current;
      restoreTarget.current = null;
      restoreScroll.current = null;
    }
    chips.current.get(key)?.focus({ preventScroll: true });
  }, [openGroupKey]);

  const shownTargets = subagentTargets.filter((target) => matchesQuery(query, target.profile, target.route, target.description));
  // Skills in two groups, workspace first (they are what makes this agent
  // different here), then global; alphabetical inside each.
  const skillGroups = useMemo(() => {
    const byName = (a: AgentSkillCapability, b: AgentSkillCapability) => a.name.localeCompare(b.name);
    const visible = skills.filter((skill) => matchesQuery(query, skill.name, skill.description));
    return ([
      ['workspace', t('rail.source.workspace'), visible.filter((skill) => skill.scope === 'workspace').toSorted(byName)],
      ['global', t('rail.source.global'), visible.filter((skill) => skill.scope !== 'workspace').toSorted(byName)],
    ] as const).filter(([, , list]) => list.length > 0);
  }, [skills, query, t]);

  const toolTotal = split.toolTab.reduce((sum, group) => sum + group.counts.total, 0);
  const tabs: { id: CapabilityTab; label: string; count: number }[] = [
    { id: 'tools', label: t('inspector.cap.tools'), count: toolTotal },
    { id: 'skills', label: t('inspector.cap.skills'), count: skills.length },
    { id: 'subagents', label: t('inspector.cap.subagents'), count: subagentTargets.length },
    { id: 'extensions', label: t('inspector.cap.extensions'), count: split.extensionTab.length },
  ];
  const current = tabs.find((entry) => entry.id === tab)!;
  // The threshold follows every reported tool, not just the ones that are on:
  // a group with fifty tools must still be searchable.
  const searchable = tab === 'tools' || tab === 'extensions'
    ? tools.length > CAP_SHOWN
    : current.count > CAP_SHOWN;
  const onTabKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = tabs.findIndex((entry) => entry.id === tab);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
    chooseTab(next.id);
    document.getElementById(`${baseId}-tab-${next.id}`)?.focus();
  };

  /**
   * The group cluster: chips, the fold past the cap, and — when a chip was
   * clicked — that group's complete membership expanded directly below, so
   * the cluster, the tab strip and the sections after it all stay in view.
   */
  const cluster = () => {
    const shown = filtering || groupsExpanded ? matches : matches.slice(0, TOOL_GROUPS_SHOWN);
    const hidden = filtering || groupsExpanded ? 0 : Math.max(0, matches.length - TOOL_GROUPS_SHOWN);
    return (
      <>
        <ul ref={clusterBox} data-capability-group-list={tab} className="flex flex-wrap gap-1 px-2">
          {shown.map(({ group, matched }) => (
            <li key={group.key} className="flex min-w-0 items-center gap-1.5">
              <GroupChip
                group={group}
                title={titleOf(group)}
                selected={openGroupKey === group.key}
                describedBy={preview?.key === group.key ? previewId : undefined}
                register={(element) => {
                  if (element === null) chips.current.delete(group.key);
                  else chips.current.set(group.key, element);
                }}
                hits={filtering ? matched.length : undefined}
                onOpen={() => { openToolGroup(group.key); }}
                onPreviewLater={() => { previewLater(group.key); }}
                onPreviewNow={() => { previewNow(group.key); }}
                onPreviewOut={previewOff}
                onPreviewClose={previewClose}
              />
              {/* The counts stay the whole group's; a hit count is a separate fact. */}
              {filtering ? (
                <span data-capability-group-hit-note={matched.length} className="shrink-0 text-[11px] text-ink-faint tabular-nums">
                  {t('inspector.cap.hits', { count: matched.length })}
                </span>
              ) : null}
            </li>
          ))}
          {hidden > 0 ? (
            <li>
              <button
                type="button"
                data-capability-groups-more={hidden}
                onClick={() => { setGroupsExpanded(true); }}
                className="inline-flex h-7 items-center rounded-full px-2.5 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.045] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-9"
              >
                {tp('inspector.cap.moreGroups', hidden)}
              </button>
            </li>
          ) : null}
          {groupsExpanded && !filtering && tabGroups.length > TOOL_GROUPS_SHOWN ? (
            <li>
              <button
                type="button"
                data-capability-groups-less
                onClick={() => { setGroupsExpanded(false); }}
                className="inline-flex h-7 items-center rounded-full px-2.5 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.045] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-9"
              >
                {t('inspector.cap.fewerGroups')}
              </button>
            </li>
          ) : null}
        </ul>
        {/* In place, under the cluster: the click path adds height here, on
            purpose, and only here. The hover path adds nothing at all. */}
        {openGroupKey !== null ? (
          <div
            data-capability-group-expanded={openGroupKey}
            className="mt-1.5 border-t border-hairline px-2 pt-2.5"
          >
            <ToolGroupDetail
              key={openGroupKey}
              group={openGroup}
              groupKey={openGroupKey}
              title={openGroup === null ? knownTitles.current.get(openGroupKey) ?? openGroupKey : titleOf(openGroup)}
              tabLabel={(openGroup?.extension ?? (tab === 'extensions')) ? t('inspector.cap.extensions') : t('inspector.cap.tools')}
              inlineDetail
              onBack={closeToolGroup}
            />
          </div>
        ) : null}
      </>
    );
  };

  const noGroupMatch = (
    <div data-capability-group-nomatch className="px-2 py-2">
      <p className="text-[12.5px] text-ink-faint">{t('inspector.cap.noGroupMatch')}</p>
      <button
        type="button"
        data-capability-search-clear
        onClick={() => { setQuery(''); }}
        className="mt-1 rounded text-[12px] text-ink-soft underline underline-offset-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
      >
        {t('inspector.cap.clearSearch')}
      </button>
    </div>
  );

  // A host with no column of its own (the wide agent panel) still expands the
  // group in place, in this same flow; only the rail needs the extra hint that
  // it is narrower than the group.
  return (
    <div data-agent-capabilities-section data-capability-tab={tab} className="text-[13px]">
      <div
        role="tablist"
        aria-label={t('inspector.cap.tabsAria')}
        onKeyDown={onTabKey}
        className="-mx-1 flex flex-wrap gap-px rounded-lg bg-ink/[0.045] p-0.5"
      >
        {tabs.map((entry) => {
          const selected = entry.id === tab;
          return (
            <button
              key={entry.id}
              id={`${baseId}-tab-${entry.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              data-capability-tab-button={entry.id}
              onClick={() => { chooseTab(entry.id); }}
              className={`flex h-7 min-w-0 flex-auto items-center justify-center gap-1 rounded-md px-1.5 text-[12px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-9 ${
                selected ? 'bg-panel font-medium text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {/* The label gives way first; a count never truncates and no tab
                  is clipped whole in the rail's narrowest column. */}
              <span className="min-w-0 truncate">{entry.label}</span>
              <span className={`shrink-0 text-[11px] tabular-nums ${selected ? 'text-ink-soft' : 'text-ink-faint'}`}>{entry.count}</span>
            </button>
          );
        })}
      </div>

      <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${tab}`} className="-mx-2 mt-1.5">
        {/* Past a handful of tools a tab offers a filter, by groups; skills and
            subagents keep their row lists. */}
        {searchable ? (
          <label className="relative mx-2 mb-1 block">
            <span className="sr-only">{t('inspector.cap.filterAria', { tab: current.label })}</span>
            <Icon name="search" size={12} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint" />
            <input
              type="search"
              data-capability-filter={tab}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setPreview(null); }}
              onKeyDown={(event) => { if (event.key === 'Escape' && query !== '') { event.stopPropagation(); setQuery(''); } }}
              placeholder={tab === 'tools' || tab === 'extensions' ? t('inspector.cap.search') : t('inspector.cap.filter', { tab: current.label })}
              className="h-7 w-full rounded-md border border-hairline bg-transparent pr-2 pl-7 text-[12px] text-ink placeholder:text-ink-faint transition-colors hover:border-hairline-strong focus:border-hairline-strong focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-selected-ink pointer-coarse:h-9"
            />
          </label>
        ) : null}

        {tab === 'tools' ? (
          tools.length === 0 ? <Empty>{t('inspector.cap.noToolsReported')}</Empty>
            : split.toolTab.length === 0 ? <Empty>{t('inspector.cap.noOwnTools')}</Empty>
              : matches.length === 0 ? noGroupMatch
                : cluster()
        ) : null}

        {tab === 'extensions' ? (
          split.extensionTab.length === 0 ? <Empty>{t('inspector.cap.noExtensions')}</Empty>
            : matches.length === 0 ? noGroupMatch
              : cluster()
        ) : null}

        {tab === 'skills' ? (
          skills.length === 0 ? <Empty>{t('inspector.cap.noSkills')}</Empty> : skillGroups.length === 0 ? <Empty>{t('inspector.cap.noMatch')}</Empty> : (
            <div data-capability-list="skills" className="space-y-1">
              {skillGroups.map(([scope, , list]) => {
                const key = `skills:${scope}`;
                const open = openGroups.has(key) || filtering;
                const hidden = skillFolds[key]?.hidden ?? 0;
                return (
                  <div key={scope} data-capability-group={scope}>
                    <div aria-hidden className="flex items-baseline gap-1.5 px-2 pt-1 text-[11px] font-medium text-ink-faint">
                      {t(scope === 'workspace' ? 'rail.source.workspace' : 'rail.source.global')}<span className="font-normal tabular-nums">{list.length}</span>
                    </div>
                    <SkillChipCluster
                      open={open}
                      rowCount={SKILL_ROWS}
                      onFold={(state) => { setSkillFold(key, state); }}
                      toggle={hidden > 0 || open ? (
                        <div className="px-2">
                          <MoreToggle
                            chip
                            hidden={hidden}
                            open={open}
                            onToggle={() => { toggleGroup(key); }}
                          />
                        </div>
                      ) : null}
                    >
                      {list.map((skill) => (
                        <SkillChip key={skill.id} skill={skill} onOpen={() => { setDrawerTarget({ kind: 'skill', skill }); }} />
                      ))}
                    </SkillChipCluster>
                  </div>
                );
              })}
            </div>
          )
        ) : null}

        {tab === 'subagents' ? (
          subagentTargets.length === 0 ? <Empty>{t('inspector.cap.noSubagents')}</Empty> : shownTargets.length === 0 ? <Empty>{t('inspector.cap.noMatch')}</Empty> : (
            <ul data-capability-list="subagents">
              {capped(shownTargets, openGroups.has('subagents'), filtering).shown.map((target, index) => {
                const allowed = target.launchAllowed !== false && target.defaultsAvailable;
                const detail = [target.modelAlias, target.thinkingEffort].filter((part) => part !== undefined && part !== '').join(' · ');
                return (
                  <CapRow
                    key={`${target.profile}:${target.route ?? ''}:${index}`}
                    data-capability-item={target.profile}
                    name={<>{target.profile}{target.route ? <span className="text-ink-faint"> / {target.route}</span> : null}</>}
                    detail={detail || target.description}
                    muted={!allowed}
                    trailing={<>
                      {!allowed ? <StateWord state="disabled" reason={capabilityReasonText(t, target.launchUnavailableReasonCode, target.launchUnavailableReason)} /> : null}
                      <SourceChip label={capabilitySourceLabel(t, target)} />
                    </>}
                    onOpen={() => { setDrawerTarget({ kind: 'subagent', target }); }}
                  />
                );
              })}
              <MoreToggle hidden={capped(shownTargets, false, filtering).hidden} open={openGroups.has('subagents') && !filtering} onToggle={() => { toggleGroup('subagents'); }} />
            </ul>
          )
        ) : null}
      </div>

      {/* The one preview is a floating layer: portaled out of the column so
          hovering a chip cannot move the cluster or anything after it. */}
      {previewGroup !== undefined && preview !== null ? (
        <GroupPreviewCard
          id={previewId}
          group={previewGroup}
          title={titleOf(previewGroup)}
          anchor={preview.anchor}
        />
      ) : null}

      <AgentDetailDrawer
        target={drawerTarget}
        onClose={() => { setDrawerTarget(null); }}
        draftScope={draftScope}
        callerProfile={callerProfile}
      />
    </div>
  );
});
