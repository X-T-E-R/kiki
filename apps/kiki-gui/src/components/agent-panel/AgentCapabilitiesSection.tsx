/**
 * What the agent can use, as four tabs under the profile card: Tools,
 * Skills, Subagents, Extensions. Each tab is a plain list of rows, one
 * name per line with its origin on the right (Workspace, Global, Plugin,
 * Built-in), so "where does this come from" reads without opening anything.
 * A row opens the shared detail drawer. Only rows that change what the agent
 * can do right now carry a state word (Asks first, Unavailable); enabled is
 * the default and says nothing.
 */

import { memo, useId, useMemo, useState, type ReactNode } from 'react';

import { useI18n } from '../../i18n';
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

function GroupHead({ children }: { children: ReactNode }) {
  return <li aria-hidden className="px-2 pt-2 pb-0.5 text-[11px] font-medium text-ink-faint first:pt-0.5">{children}</li>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-2 text-[12.5px] text-ink-faint">{children}</p>;
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

  const own = useMemo(() => tools.filter((tool) => extensionOwner(tool) === undefined), [tools]);
  // Built-in tools by category; switched-off ones fold into one quiet line.
  const toolGroups = useMemo(() => {
    const groups = new Map<string, AgentToolCapability[]>();
    for (const tool of own) {
      if (tool.state === 'disabled') continue;
      const key = tool.category || 'other';
      groups.set(key, [...(groups.get(key) ?? []), tool]);
    }
    return [...groups.entries()];
  }, [own]);
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
  // Workspace skills first: they are what makes this agent different here.
  const orderedSkills = useMemo(() => [...skills].sort((a, b) =>
    Number(b.scope === 'workspace') - Number(a.scope === 'workspace') || a.name.localeCompare(b.name)), [skills]);

  const tabs: { id: CapabilityTab; label: string; count: number }[] = [
    { id: 'tools', label: t('inspector.cap.tools'), count: own.length - offTools.length },
    { id: 'skills', label: t('inspector.cap.skills'), count: skills.length },
    { id: 'subagents', label: t('inspector.cap.subagents'), count: subagentTargets.length },
    { id: 'extensions', label: t('inspector.cap.extensions'), count: extensions.length },
  ];
  const onTabKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = tabs.findIndex((entry) => entry.id === tab);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
    setTab(next.id);
    document.getElementById(`${baseId}-tab-${next.id}`)?.focus();
  };

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
        {tab === 'tools' ? (
          own.length === 0 ? <Empty>{t('inspector.cap.noTools')}</Empty> : (
            <ul data-capability-list="tools">
              {toolGroups.map(([category, list]) => (
                <li key={category}>
                  <ul>
                    <GroupHead>{toolCategoryLabel(t, category)}</GroupHead>
                    {list.map((tool) => (
                      <CapRow
                        key={tool.name}
                        data-capability-item={tool.name}
                        name={<span className="font-mono text-[12px]">{tool.name}</span>}
                        trailing={<StateWord state={tool.state} reason={capabilityReasonText(t, tool.unavailableReasonCode, tool.unavailableReason)} />}
                        onOpen={() => { setDrawerTarget({ kind: 'tool', tool }); }}
                      />
                    ))}
                  </ul>
                </li>
              ))}
              {offTools.length > 0 ? (
                <li className="px-2 pt-2 text-[11.5px] text-ink-faint" title={offTools.map((tool) => tool.name).join(', ')}>
                  {tp('inspector.cap.off', offTools.length)}
                </li>
              ) : null}
            </ul>
          )
        ) : null}

        {tab === 'skills' ? (
          orderedSkills.length === 0 ? <Empty>{t('inspector.cap.noSkills')}</Empty> : (
            <ul data-capability-list="skills">
              {orderedSkills.map((skill) => (
                <CapRow
                  key={skill.id}
                  data-capability-item={skill.name}
                  name={skill.name}
                  detail={skill.description}
                  muted={skill.state !== 'enabled'}
                  trailing={<SourceChip label={capabilitySourceLabel(t, skill)} />}
                  onOpen={() => { setDrawerTarget({ kind: 'skill', skill }); }}
                />
              ))}
            </ul>
          )
        ) : null}

        {tab === 'subagents' ? (
          subagentTargets.length === 0 ? <Empty>{t('inspector.cap.noSubagents')}</Empty> : (
            <ul data-capability-list="subagents">
              {subagentTargets.map((target, index) => {
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
            </ul>
          )
        ) : null}

        {tab === 'extensions' ? (
          extensions.length === 0 ? <Empty>{t('inspector.cap.noExtensions')}</Empty> : (
            <ul data-capability-list="extensions">
              {extensions.map((ext) => {
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
