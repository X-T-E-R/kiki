import { useI18n } from '../../i18n';
import { useGuardedNavigate } from '../dirtyGuard';
import { SkillsView } from '../capabilities/SkillsView';
import { useCapabilityWorkspace, WorkspacePicker } from '../capabilities/CapabilitiesPage';
import { SectionCard } from './SectionCard';

/**
 * Unified Skills view in Settings -> Extensions -> Skills (and `/settings/skills`).
 * Renders the full searchable, source-filtered skill catalog with inline enable/disable
 * toggles, SKILL.md preview, and the collapsible Sources & folders panel.
 */
export function SkillsSection() {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const { workspaces, workspaceId, setWorkspaceId, query: workspacesQuery } = useCapabilityWorkspace();

  return (
    <SectionCard
      id="st-card-caps"
      title={t('st.skills.catalogTitle')}
      actions={workspaces.length > 0 ? (
        <WorkspacePicker
          id="settings-skills-workspace"
          workspaces={workspaces}
          value={workspaceId}
          onChange={setWorkspaceId}
        />
      ) : undefined}
    >
      {workspacesQuery.isPending ? (
        <p className="text-[13px] text-ink-faint" role="status" data-capability-workspaces-loading>
          {t('cap.loadingWorkspaces')}
        </p>
      ) : workspacesQuery.isError ? (
        <div className="space-y-3" data-capability-workspaces-error>
          <p className="text-[13px] text-danger" role="alert">{t('cap.workspacesFailed')}</p>
          <button
            type="button"
            onClick={() => { void workspacesQuery.refetch(); }}
            disabled={workspacesQuery.isFetching}
            className="min-h-8 rounded-md bg-ink/[0.06] px-3 text-[13px] text-ink hover:bg-ink/[0.1] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-selected-ink"
          >
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <SkillsView
          workspaceId={workspaceId}
          inSettings
          onOpenPlugin={(pluginId) => {
            void navigate(`/settings/extensions?plugin=${encodeURIComponent(pluginId)}`);
          }}
        />
      )}
    </SectionCard>
  );
}
