/**
 * What the agent can use, as four tabs under the profile card: Tools,
 * Skills, Subagents, Extensions. Tools, subagents and extensions are rows,
 * one name per line with its origin on the right; skills are compact chips,
 * grouped Workspace then Global and alphabetical in each group. Every group
 * shows its first `CAP_SHOWN` items and folds the rest into "M more", and a
 * tab with more than that offers a filter, so an open tab never fills the
 * rail. An item opens the shared detail drawer. Only items that change what
 * the agent can do right now carry a state word (Asks first, Unavailable);
 * enabled is the default and says nothing.
 */

import { memo, useId, useMemo, useState, type ReactNode } from 'react';

import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import { AgentDetailDrawer, type DetailDrawerTarget } from './AgentDetailDrawer';
import { capabilityReasonText } from './mapCapabilities';
import { capabilitySourceLabel, SOURCE_TONE_CLASS, type SourceLabel } from './sourceLabel';
import { toolCategoryLabel } from './ToolChipList';
import type {
  AgentSkillCapability,
  AgentSubagentTarget,
  AgentToolCapability,
} from './types';

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

/** `mcp__<server>__<tool>` / `plugin__<id>__<tool>`: the owner part. */
export function extensionOwner(tool: AgentToolCapability): { kind: 'mcp' | 'plugin'; owner: string } | undefined {
  const match = /^(mcp|plugin)__(.+?)__/.exec(tool.name);
  if (match !== null) return { kind: match[1] as 'mcp' | 'plugin', owner: match[2]! };
  if (tool.source === 'mcp' || tool.source === 'plugin') return { kind: tool.source, owner: tool.category || tool.name };
  return undefined;
}

/** The short tool name inside an extension (`search_issues`). */
function extensionToolName(name: string): string {
  const match = /^(?:mcp|plugin)__.+?__(.+)$/.exec(name);
  return match?.[1] ?? name;
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
  const own = tools.filter((tool) => extensionOwner(tool) === undefined);
  const owners = new Set(tools.flatMap((tool) => {
    const ext = extensionOwner(tool);
    return ext === undefined ? [] : [`${ext.kind}:${ext.owner}`];
  }));
  return {
    toolsOn: own.filter((tool) => tool.state === 'enabled' || tool.state === 'approval-required').length,
    tools: own.length,
    skills: skills.length,
    subagents: subagentTargets.length,
    extensions: owners.size,
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

function GroupHead({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <li aria-hidden className="flex items-baseline gap-1.5 px-2 pt-2 pb-1 text-[11px] font-medium text-ink-faint first:pt-0.5">
      {children}
      {count !== undefined ? <span className="font-normal tabular-nums">{count}</span> : null}
    </li>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-2 text-[12.5px] text-ink-faint">{children}</p>;
}

/** Rows shown per group before the rest fold into "M more". */
export const CAP_SHOWN = 8;

/** The "M more" / "Show less" line under a capped group (`chip`: inline in a chip row). */
function MoreToggle({ hidden, open, onToggle, chip = false }: { hidden: number; open: boolean; onToggle: () => void; chip?: boolean }) {
  const { t } = useI18n();
  if (hidden <= 0 && !open) return null;
  return (
    <li>
      <button
        type="button"
        data-capability-more={open ? 'less' : hidden}
        aria-expanded={open}
        onClick={onToggle}
        className={`h-7 px-2 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.045] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-9 ${chip ? 'inline-flex items-center rounded-full' : 'rounded-md'}`}
      >
        {open ? t('inspector.cap.less') : t('inspector.cap.more', { count: hidden })}
      </button>
    </li>
  );
}

/** First `CAP_SHOWN` of `list` unless opened; an active filter shows every match. */
function capped<T>(list: readonly T[], open: boolean, filtering: boolean): { shown: readonly T[]; hidden: number } {
  if (open || filtering || list.length <= CAP_SHOWN + 1) return { shown: list, hidden: 0 };
  return { shown: list.slice(0, CAP_SHOWN), hidden: list.length - CAP_SHOWN };
}

/** Case-insensitive match on any of the given fields. */
function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  return needle === '' || fields.some((field) => field !== undefined && field.toLowerCase().includes(needle));
}

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
  const filtering = query.trim() !== '';
  const toggleGroup = (key: string) => {
    setOpenGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const chooseTab = (next: CapabilityTab) => {
    setTab(next);
    setQuery('');
  };

  const own = useMemo(() => tools.filter((tool) => extensionOwner(tool) === undefined), [tools]);
  // Built-in tools by category; switched-off ones fold into one quiet line.
  const toolGroups = useMemo(() => {
    const groups = new Map<string, AgentToolCapability[]>();
    for (const tool of own) {
      if (tool.state === 'disabled' || !matchesQuery(query, tool.name, tool.description)) continue;
      const key = tool.category || 'other';
      groups.set(key, [...(groups.get(key) ?? []), tool]);
    }
    return [...groups.entries()];
  }, [own, query]);
  const offTools = own.filter((tool) => tool.state === 'disabled');
  const extensions = useMemo(() => {
    const byOwner = new Map<string, { kind: 'mcp' | 'plugin'; owner: string; tools: AgentToolCapability[] }>();
    for (const tool of tools) {
      const ext = extensionOwner(tool);
      if (ext === undefined) continue;
      const key = `${ext.kind}:${ext.owner}`;
      const entry = byOwner.get(key) ?? { ...ext, tools: [] };
      entry.tools.push(tool);
      byOwner.set(key, entry);
    }
    return [...byOwner.values()];
  }, [tools]);
  const shownExtensions = extensions.filter((ext) => matchesQuery(query, ext.owner, ...ext.tools.map((tool) => tool.name)));
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

  const tabs: { id: CapabilityTab; label: string; count: number }[] = [
    { id: 'tools', label: t('inspector.cap.tools'), count: own.length - offTools.length },
    { id: 'skills', label: t('inspector.cap.skills'), count: skills.length },
    { id: 'subagents', label: t('inspector.cap.subagents'), count: subagentTargets.length },
    { id: 'extensions', label: t('inspector.cap.extensions'), count: extensions.length },
  ];
  const current = tabs.find((entry) => entry.id === tab)!;
  const onTabKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = tabs.findIndex((entry) => entry.id === tab);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
    chooseTab(next.id);
    document.getElementById(`${baseId}-tab-${next.id}`)?.focus();
  };
  const noMatch = <Empty>{t('inspector.cap.noMatch')}</Empty>;

  return (
    <div data-agent-capabilities-section data-capability-tab={tab} className="text-[13px]">
      <div
        role="tablist"
        aria-label={t('inspector.cap.tabsAria')}
        onKeyDown={onTabKey}
        className="-mx-1 flex gap-px rounded-lg bg-ink/[0.045] p-0.5"
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
              onClick={() => { setTab(entry.id); }}
              className={`flex h-7 flex-auto items-center justify-center gap-1 rounded-md px-1.5 text-[12px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-9 ${
                selected ? 'bg-panel font-medium text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]' : 'text-ink-soft hover:text-ink'
              }`}
            >
              <span>{entry.label}</span>
              <span className={`text-[11px] tabular-nums ${selected ? 'text-ink-soft' : 'text-ink-faint'}`}>{entry.count}</span>
            </button>
          );
        })}
      </div>

      <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${tab}`} className="-mx-2 mt-1.5">
        {/* Past a handful of items a tab offers a filter; a group shows its
            first rows and folds the rest into "M more". */}
        {current.count > CAP_SHOWN ? (
          <label className="relative mx-2 mb-1 block">
            <span className="sr-only">{t('inspector.cap.filterAria', { tab: current.label })}</span>
            <Icon name="search" size={12} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint" />
            <input
              type="search"
              data-capability-filter={tab}
              value={query}
              onChange={(event) => { setQuery(event.target.value); }}
              onKeyDown={(event) => { if (event.key === 'Escape' && query !== '') { event.stopPropagation(); setQuery(''); } }}
              placeholder={t('inspector.cap.filter', { tab: current.label })}
              className="h-7 w-full rounded-md border border-hairline bg-transparent pr-2 pl-7 text-[12px] text-ink placeholder:text-ink-faint transition-colors hover:border-hairline-strong focus:border-hairline-strong focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-selected-ink pointer-coarse:h-9"
            />
          </label>
        ) : null}
        {tab === 'tools' ? (
          own.length === 0 ? <Empty>{t('inspector.cap.noTools')}</Empty> : toolGroups.length === 0 ? noMatch : (
            <ul data-capability-list="tools">
              {toolGroups.map(([category, list]) => {
                const key = `tools:${category}`;
                const { shown, hidden } = capped(list, openGroups.has(key), filtering);
                return (
                  <li key={category} data-capability-group={category}>
                    <ul>
                      <GroupHead count={list.length}>{toolCategoryLabel(t, category)}</GroupHead>
                      {shown.map((tool) => (
                        <CapRow
                          key={tool.name}
                          data-capability-item={tool.name}
                          name={<span className="font-mono text-[12px]">{tool.name}</span>}
                          trailing={<StateWord state={tool.state} reason={capabilityReasonText(t, tool.unavailableReasonCode, tool.unavailableReason)} />}
                          onOpen={() => { setDrawerTarget({ kind: 'tool', tool }); }}
                        />
                      ))}
                      <MoreToggle hidden={hidden} open={openGroups.has(key) && !filtering} onToggle={() => { toggleGroup(key); }} />
                    </ul>
                  </li>
                );
              })}
              {offTools.length > 0 && !filtering ? (
                <li className="px-2 pt-2 text-[11.5px] text-ink-faint" title={offTools.map((tool) => tool.name).join(', ')}>
                  {tp('inspector.cap.off', offTools.length)}
                </li>
              ) : null}
            </ul>
          )
        ) : null}

        {tab === 'skills' ? (
          skills.length === 0 ? <Empty>{t('inspector.cap.noSkills')}</Empty> : skillGroups.length === 0 ? noMatch : (
            <div data-capability-list="skills" className="space-y-1">
              {skillGroups.map(([scope, label, list]) => {
                const key = `skills:${scope}`;
                const { shown, hidden } = capped(list, openGroups.has(key), filtering);
                return (
                  <ul key={scope} data-capability-group={scope} className="flex flex-wrap gap-1 px-2">
                    <li aria-hidden className="flex w-full items-baseline gap-1.5 pt-1 text-[11px] font-medium text-ink-faint">
                      {label}<span className="font-normal tabular-nums">{list.length}</span>
                    </li>
                    {shown.map((skill) => (
                      <SkillChip key={skill.id} skill={skill} onOpen={() => { setDrawerTarget({ kind: 'skill', skill }); }} />
                    ))}
                    <MoreToggle chip hidden={hidden} open={openGroups.has(key) && !filtering} onToggle={() => { toggleGroup(key); }} />
                  </ul>
                );
              })}
            </div>
          )
        ) : null}

        {tab === 'subagents' ? (
          subagentTargets.length === 0 ? <Empty>{t('inspector.cap.noSubagents')}</Empty> : shownTargets.length === 0 ? noMatch : (
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

        {tab === 'extensions' ? (
          extensions.length === 0 ? <Empty>{t('inspector.cap.noExtensions')}</Empty> : shownExtensions.length === 0 ? noMatch : (
            <ul data-capability-list="extensions">
              {capped(shownExtensions, openGroups.has('extensions'), filtering).shown.map((ext) => {
                const reachable = ext.tools.some((tool) => tool.state === 'enabled' || tool.state === 'approval-required');
                const first = ext.tools[0]!;
                return (
                  <CapRow
                    key={`${ext.kind}:${ext.owner}`}
                    data-capability-item={ext.owner}
                    name={ext.owner}
                    detail={ext.tools.map((tool) => extensionToolName(tool.name)).join(', ')}
                    muted={!reachable}
                    trailing={<>
                      {!reachable ? <StateWord state={first.state} /> : <span className="shrink-0 text-[11.5px] text-ink-faint tabular-nums">{tp('inspector.cap.toolCount', ext.tools.length)}</span>}
                      <span className="shrink-0 rounded bg-ink/[0.06] px-1.5 py-px text-[11px] leading-4 text-ink-soft">
                        {ext.kind === 'mcp' ? t('inspector.cap.mcp') : t('inspector.cap.plugin')}
                      </span>
                    </>}
                    onOpen={() => { setDrawerTarget({ kind: 'tool', tool: first }); }}
                  />
                );
              })}
              <MoreToggle hidden={capped(shownExtensions, false, filtering).hidden} open={openGroups.has('extensions') && !filtering} onToggle={() => { toggleGroup('extensions'); }} />
            </ul>
          )
        ) : null}
      </div>

      <AgentDetailDrawer
        target={drawerTarget}
        onClose={() => { setDrawerTarget(null); }}
        draftScope={draftScope}
        callerProfile={callerProfile}
      />
    </div>
  );
});
