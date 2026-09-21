import { memo, useState, useMemo } from 'react';
import { useI18n } from '../../i18n';
import type {
  AgentToolCapability,
  AgentSkillCapability,
  AgentSubagentTarget,
} from './types';
import { AgentDetailDrawer, type DetailDrawerTarget } from './AgentDetailDrawer';
import { ToolChipList, toolCategoryLabel } from './ToolChipList';

export interface AgentCapabilitiesSectionProps {
  readonly tools: readonly AgentToolCapability[];
  readonly skills: readonly AgentSkillCapability[];
  readonly subagentTargets: readonly AgentSubagentTarget[];
  readonly draftScope?: { readonly workspace_id?: string; readonly cwd?: string };
}

export const AgentCapabilitiesSection = memo(function AgentCapabilitiesSection({
  tools,
  skills,
  subagentTargets,
  draftScope,
}: AgentCapabilitiesSectionProps) {
  const { t } = useI18n();

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
                    {toolCategoryLabel(t, category)} ({catTools.length})
                  </div>
                  <ToolChipList
                    variant="rows"
                    items={catTools.map((tool) => ({
                      key: tool.name,
                      name: tool.name,
                      state: tool.state,
                      readOnly: tool.readOnly,
                      unavailableReason: tool.unavailableReason,
                      onOpen: () => setDrawerTarget({ kind: 'tool', tool }),
                    }))}
                  />
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

        {!skillsOpen && workspaceSkills.length > 0 ? (
          <div className="mt-1.5">
            <ToolChipList
              variant="chips"
              items={workspaceSkills.slice(0, 3).map((skill) => ({
                key: skill.id,
                name: skill.name,
                unavailableReason: skill.unavailableReason,
                onOpen: () => setDrawerTarget({ kind: 'skill', skill }),
              }))}
            />
            {workspaceSkills.length > 3 ? (
              <span className="mt-1 block text-[10px] text-ink-faint">
                {t('agentPanel.moreSkills', { count: workspaceSkills.length - 3 })}
              </span>
            ) : null}
          </div>
        ) : null}

        {skillsOpen ? (
          <div className="mt-2 space-y-2 border-t border-hairline pt-1.5">
            <div>
              <div className="font-mono text-[9.5px] font-semibold uppercase text-accent">
                {t('agentPanel.workspaceSkills', { count: workspaceSkills.length })}
              </div>
              {workspaceSkills.length === 0 ? (
                <p className="mt-1 text-[10.5px] text-ink-faint">{t('agentPanel.noWorkspaceSkills')}</p>
              ) : (
                <div className="mt-1">
                  <ToolChipList
                    variant="rows"
                    items={workspaceSkills.map((skill) => ({
                      key: skill.id,
                      name: skill.name,
                      state: skill.state,
                      unavailableReason: skill.unavailableReason,
                      onOpen: () => setDrawerTarget({ kind: 'skill', skill }),
                    }))}
                  />
                </div>
              )}
            </div>

            <div className="border-t border-hairline/60 pt-1.5">
              <div className="font-mono text-[9.5px] font-semibold uppercase text-ink-faint">
                {t('agentPanel.globalSkills', { count: globalSkills.length })}
              </div>
              {globalSkills.length === 0 ? (
                <p className="mt-1 text-[10.5px] text-ink-faint">{t('agentPanel.noGlobalSkills')}</p>
              ) : (
                <div className="mt-1">
                  <ToolChipList
                    variant="rows"
                    items={globalSkills.map((skill) => ({
                      key: skill.id,
                      name: skill.name,
                      state: skill.state,
                      unavailableReason: skill.unavailableReason,
                      onOpen: () => setDrawerTarget({ kind: 'skill', skill }),
                    }))}
                  />
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
                        onClick={() => setDrawerTarget({ kind: 'profile-draft', profile: target.profile })}
                        className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-[11.5px] font-medium text-ink transition-colors hover:text-accent"
                        title={t('agentPanel.profileDetail')}
                      >
                        {target.profile}
                        {target.route ? ` / ${target.route}` : ''}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDrawerTarget({ kind: 'subagent', target })}
                        title={t('agentPanel.viewDetails')}
                        className={`shrink-0 cursor-pointer rounded border px-1.5 py-0.2 font-mono text-[9.5px] uppercase ${
                          allowed
                            ? 'border-success/30 bg-success/15 text-success'
                            : 'border-danger/30 bg-danger/10 text-danger'
                        }`}
                      >
                        {allowed ? t('agentPanel.allowed') : t('agentPanel.blocked')}
                      </button>
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
        draftScope={draftScope}
      />
    </div>
  );
});
