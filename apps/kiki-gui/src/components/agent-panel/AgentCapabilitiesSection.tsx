import { memo, useState, useMemo } from 'react';
import { useI18n } from '../../i18n';
import type {
  AgentToolCapability,
  AgentSkillCapability,
  AgentSubagentTarget,
  CapabilityState,
} from './types';
import { AgentDetailDrawer, type DetailDrawerTarget } from './AgentDetailDrawer';

export interface AgentCapabilitiesSectionProps {
  readonly tools: readonly AgentToolCapability[];
  readonly skills: readonly AgentSkillCapability[];
  readonly subagentTargets: readonly AgentSubagentTarget[];
}

function stateBadge(
  state: CapabilityState,
  labels: Readonly<Record<CapabilityState, string>>,
): { label: string; className: string } {
  switch (state) {
    case 'enabled':
      return { label: labels.enabled, className: 'bg-success/15 text-success' };
    case 'approval-required':
      return { label: labels['approval-required'], className: 'bg-amber-card text-amber-ink border border-amber-rule/40' };
    case 'disabled':
      return { label: labels.disabled, className: 'bg-paper text-ink-faint border border-hairline' };
    case 'disconnected':
      return { label: labels.disconnected, className: 'bg-danger/10 text-danger border border-danger/30' };
    case 'unknown':
    default:
      return { label: labels.unknown, className: 'bg-paper text-ink-faint' };
  }
}

export const AgentCapabilitiesSection = memo(function AgentCapabilitiesSection({
  tools,
  skills,
  subagentTargets,
}: AgentCapabilitiesSectionProps) {
  const { t } = useI18n();
  const stateLabels: Readonly<Record<CapabilityState, string>> = {
    enabled: t('agentPanel.capability.enabled'),
    'approval-required': t('agentPanel.capability.approvalRequired'),
    disabled: t('agentPanel.capability.disabled'),
    disconnected: t('agentPanel.capability.disconnected'),
    unknown: t('agentPanel.capability.unknown'),
  };

  const [toolsOpen, setToolsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [subagentsOpen, setSubagentsOpen] = useState(false);

  // Active item in detail drawer
  const [drawerTarget, setDrawerTarget] = useState<DetailDrawerTarget | null>(null);

  // Group tools by their real category
  const toolsByCategory = useMemo(() => {
    const groups: Record<string, AgentToolCapability[]> = {};
    for (const tool of tools) {
      const cat = tool.category || t('agentPanel.generalCategory');
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(tool);
    }
    return groups;
  }, [t, tools]);

  // Skills divided into Workspace-specific vs Global
  const workspaceSkills = skills.filter((s) => s.scope === 'workspace');
  const globalSkills = skills.filter((s) => s.scope === 'global');

  return (
    <div
      data-agent-capabilities-section
      className="space-y-2 rounded-xl border border-hairline bg-panel p-3 shadow-xs text-[11.5px]"
    >
      <div className="font-mono text-[10.5px] font-semibold tracking-wider text-ink-faint uppercase">
        {t('agentPanel.capabilitiesTitle')}
      </div>

      {/* 1. Real Tools (Default Collapsed, Grouped by Category) */}
      <div className="rounded-lg border border-hairline bg-paper/40 p-2">
        <button
          type="button"
          aria-expanded={toolsOpen}
          onClick={() => setToolsOpen(!toolsOpen)}
          className="flex w-full items-center justify-between font-medium text-ink hover:text-accent transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={`inline-block text-[8px] transition-transform ${
                toolsOpen ? 'rotate-90' : ''
              }`}
            >
              ▶
            </span>
            <span>{t('agentPanel.registeredTools')}</span>
          </span>
          <span className="font-mono text-[10px] text-ink-faint">
            {t('agentPanel.availableCount', { count: tools.length })}
          </span>
        </button>

        {toolsOpen ? (
          <div className="mt-2 space-y-2.5 pt-1.5 border-t border-hairline">
            {tools.length === 0 ? (
              <p className="text-ink-faint text-[11px]">{t('agentPanel.noRegisteredTools')}</p>
            ) : (
              Object.entries(toolsByCategory).map(([category, catTools]) => (
                <div key={category} className="space-y-1">
                  <div className="font-mono text-[9.5px] font-semibold text-ink-faint uppercase tracking-wider">
                    {category} ({catTools.length})
                  </div>
                  <div className="divide-y divide-hairline/60 rounded-md border border-hairline bg-panel overflow-hidden">
                    {catTools.map((tool) => {
                      const badge = stateBadge(tool.state, stateLabels);
                      return (
                        <div
                          key={tool.name}
                          className="flex items-center justify-between gap-2 p-2 hover:bg-paper/70 transition-colors"
                        >
                          <button
                            type="button"
                            onClick={() => setDrawerTarget({ kind: 'tool', tool })}
                            className="font-mono text-[11.5px] font-medium text-ink hover:text-accent truncate text-left cursor-pointer flex-1 min-w-0"
                            title={t('agentPanel.viewDetails')}
                          >
                            {tool.name}
                          </button>
                          <div className="flex items-center gap-1 shrink-0">
                            {tool.readOnly ? (
                              <span className="rounded-sm bg-accent-soft px-1 text-[9px] font-mono text-accent">
                                {t('agentPanel.readOnly')}
                              </span>
                            ) : null}
                            <span
                              className={`rounded px-1.5 py-0.2 font-mono text-[9.5px] ${badge.className}`}
                              title={tool.unavailableReason}
                            >
                              {badge.label}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>

      {/* 2. Skills: Workspace-specific vs Global (Default Collapsed) */}
      <div className="rounded-lg border border-hairline bg-paper/40 p-2">
        <button
          type="button"
          aria-expanded={skillsOpen}
          onClick={() => setSkillsOpen(!skillsOpen)}
          className="flex w-full items-center justify-between font-medium text-ink hover:text-accent transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={`inline-block text-[8px] transition-transform ${
                skillsOpen ? 'rotate-90' : ''
              }`}
            >
              ▶
            </span>
            <span>{t('agentPanel.skills')}</span>
          </span>
          <span className="font-mono text-[10px] text-ink-faint">
            {t('agentPanel.skillsCount', { workspace: workspaceSkills.length, global: globalSkills.length })}
          </span>
        </button>

        {/* Workspace Skill previews when collapsed */}
        {!skillsOpen && workspaceSkills.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {workspaceSkills.slice(0, 3).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setDrawerTarget({ kind: 'skill', skill: s })}
                className="rounded bg-paper border border-hairline px-1.5 py-0.2 font-mono text-[10px] text-ink-soft hover:text-ink hover:border-hairline-strong cursor-pointer transition-colors"
                title={s.description ?? s.name}
              >
                ⚡ {s.name}
              </button>
            ))}
            {workspaceSkills.length > 3 ? (
              <span className="text-[10px] text-ink-faint self-center">
                {t('agentPanel.moreSkills', { count: workspaceSkills.length - 3 })}
              </span>
            ) : null}
          </div>
        ) : null}

        {skillsOpen ? (
          <div className="mt-2 space-y-2 pt-1.5 border-t border-hairline">
            {/* Workspace-specific Skills */}
            <div>
              <div className="font-mono text-[9.5px] font-semibold text-accent uppercase">
                {t('agentPanel.workspaceSkills', { count: workspaceSkills.length })}
              </div>
              {workspaceSkills.length === 0 ? (
                <p className="text-ink-faint text-[10.5px] mt-1">{t('agentPanel.noWorkspaceSkills')}</p>
              ) : (
                <div className="mt-1 divide-y divide-hairline/60 rounded-md border border-hairline bg-panel overflow-hidden">
                  {workspaceSkills.map((s) => {
                    const badge = stateBadge(s.state, stateLabels);
                    return (
                      <div
                        key={s.id}
                        className="flex items-center justify-between gap-2 p-2 hover:bg-paper/70 transition-colors"
                      >
                        <button
                          type="button"
                          onClick={() => setDrawerTarget({ kind: 'skill', skill: s })}
                          className="font-mono text-[11.5px] font-medium text-ink hover:text-accent truncate text-left cursor-pointer flex-1 min-w-0"
                          title={t('agentPanel.viewDetails')}
                        >
                          ⚡ {s.name}
                        </button>
                        <span className={`rounded px-1.5 py-0.2 font-mono text-[9.5px] shrink-0 ${badge.className}`}>
                          {badge.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Global Skills */}
            <div className="pt-1.5 border-t border-hairline/60">
              <div className="font-mono text-[9.5px] font-semibold text-ink-faint uppercase">
                {t('agentPanel.globalSkills', { count: globalSkills.length })}
              </div>
              {globalSkills.length === 0 ? (
                <p className="text-ink-faint text-[10.5px] mt-1">{t('agentPanel.noGlobalSkills')}</p>
              ) : (
                <div className="mt-1 divide-y divide-hairline/60 rounded-md border border-hairline bg-panel overflow-hidden">
                  {globalSkills.map((s) => {
                    const badge = stateBadge(s.state, stateLabels);
                    return (
                      <div
                        key={s.id}
                        className="flex items-center justify-between gap-2 p-2 hover:bg-paper/70 transition-colors"
                      >
                        <button
                          type="button"
                          onClick={() => setDrawerTarget({ kind: 'skill', skill: s })}
                          className="font-mono text-[11.5px] font-medium text-ink hover:text-accent truncate text-left cursor-pointer flex-1 min-w-0"
                          title={t('agentPanel.viewDetails')}
                        >
                          🌐 {s.name}
                        </button>
                        <span className={`rounded px-1.5 py-0.2 font-mono text-[9.5px] shrink-0 ${badge.className}`}>
                          {badge.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>

      {/* 3. Dispatchable Subagents & Admission Reasons */}
      <div className="rounded-lg border border-hairline bg-paper/40 p-2">
        <button
          type="button"
          aria-expanded={subagentsOpen}
          onClick={() => setSubagentsOpen(!subagentsOpen)}
          className="flex w-full items-center justify-between font-medium text-ink hover:text-accent transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={`inline-block text-[8px] transition-transform ${
                subagentsOpen ? 'rotate-90' : ''
              }`}
            >
              ▶
            </span>
            <span>{t('agentPanel.subagents')}</span>
          </span>
          <span className="font-mono text-[10px] text-ink-faint">
            {t('agentPanel.allowedCount', {
              allowed: subagentTargets.filter((t) => t.launchAllowed !== false && t.defaultsAvailable).length,
              total: subagentTargets.length,
            })}
          </span>
        </button>

        {subagentsOpen ? (
          <div className="mt-2 space-y-1.5 pt-1.5 border-t border-hairline">
            {subagentTargets.length === 0 ? (
              <p className="text-ink-faint text-[11px]">{t('agentPanel.noSubagents')}</p>
            ) : (
              <div className="divide-y divide-hairline/60 rounded-md border border-hairline bg-panel overflow-hidden">
                {subagentTargets.map((target, idx) => {
                  const allowed = target.launchAllowed !== false && target.defaultsAvailable;
                  return (
                    <div
                      key={`${target.profile}:${target.route ?? ''}:${idx}`}
                      className="flex items-center justify-between gap-2 p-2 hover:bg-paper/70 transition-colors"
                    >
                      <button
                        type="button"
                        onClick={() => setDrawerTarget({ kind: 'subagent', target })}
                        className="font-mono text-[11.5px] font-medium text-ink hover:text-accent truncate text-left cursor-pointer flex-1 min-w-0"
                        title={t('agentPanel.viewDetails')}
                      >
                        {target.profile}
                        {target.route ? ` / ${target.route}` : ''}
                      </button>
                      <span
                        className={`font-mono text-[9.5px] uppercase px-1.5 py-0.2 rounded shrink-0 ${
                          allowed
                            ? 'bg-success/15 text-success border border-success/30'
                            : 'bg-danger/10 text-danger border border-danger/30'
                        }`}
                      >
                        {allowed ? t('agentPanel.allowed') : t('agentPanel.blocked')}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Shared Detail Drawer */}
      <AgentDetailDrawer
        target={drawerTarget}
        onClose={() => setDrawerTarget(null)}
      />
    </div>
  );
});
