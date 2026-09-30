import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import type { MemoryApproval, MemorySettings } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, SaveStatus, Toggle, type Feedback } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { SectionCard } from './SectionCard';
import { SettingField } from './fields';
import { CommitInput, SettingsSelect } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

const MEMORY_SETTINGS_KEY = ['memory-settings'] as const;

type MemoryPatch = { enabled?: boolean; approval?: MemoryApproval; budget?: number };

export function MemorySettingsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const [saved, ping] = useSavedTick();
  const settingsQuery = useQuery({
    queryKey: MEMORY_SETTINGS_KEY,
    queryFn: () => client.getMemorySettings(),
    staleTime: 15_000,
  });
  const update = useMutation({
    mutationFn: (patch: MemoryPatch) => client.patchMemorySettings(patch),
    onSuccess: (next: MemorySettings) => { queryClient.setQueryData(MEMORY_SETTINGS_KEY, next); ping(); },
  });
  // Which row the last write came from, so its row alone shows the save state.
  const pendingKey = update.variables === undefined ? undefined : Object.keys(update.variables)[0];
  const status = (key: keyof MemoryPatch) => pendingKey === key
    ? <SaveStatus saving={update.isPending} saved={saved && !update.isError} />
    : null;
  const busy = settingsQuery.isPending || update.isPending;
  const feedback: Feedback = settingsQuery.isError
    ? { tone: 'error', text: t('st.memory.loadFailed', { detail: errorText(locale, settingsQuery.error) }) }
    : update.isError
      ? { tone: 'error', text: t('st.memory.saveFailed', { detail: errorText(locale, update.error) }) }
      : null;

  return (
    <SectionCard id="st-card-memory" title={t('st.memory.title')}>
      <div className="min-w-0 space-y-2" data-memory-settings>
        <SettingField label={t('memory.toggle')} htmlFor="memory-enabled" help={t('st.memory.hint')}>
          {status('enabled')}
          <Toggle
            id="memory-enabled"
            layout="bare"
            label={t('memory.toggle')}
            checked={settingsQuery.data?.enabled === true}
            disabled={busy}
            onChange={(enabled) => { update.mutate({ enabled }); }}
          />
        </SettingField>
        <SettingField label={t('st.memory.approval')} labelId="memory-approval-label">
          {status('approval')}
          <SettingsSelect<MemoryApproval>
            id="memory-approval"
            dataAttr="data-memory-approval"
            ariaLabel={t('st.memory.approval')}
            value={settingsQuery.data?.approval ?? 'auto'}
            disabled={busy}
            onChange={(approval) => { update.mutate({ approval }); }}
            choices={[
              { value: 'auto', label: t('st.memory.approval.auto') },
              { value: 'review', label: t('st.memory.approval.review') },
              { value: 'off', label: t('st.memory.approval.off') },
            ]}
          />
        </SettingField>
        <SettingField label={t('st.memory.budget')} htmlFor="memory-budget" help={t('st.memory.budgetHint')}>
          {status('budget')}
          <CommitInput
            id="memory-budget"
            dataAttr="data-memory-budget"
            className="w-24 text-right"
            inputMode="numeric"
            value={settingsQuery.data === undefined ? '' : String(settingsQuery.data.budget)}
            disabled={busy}
            validate={(text) => (/^\d+$/.test(text) && Number(text) <= 4_000 ? null : t('st.memory.budgetInvalid'))}
            onCommit={(text) => { update.mutate({ budget: Number(text) }); }}
          />
        </SettingField>
        <button
          type="button"
          data-memory-settings-link
          onClick={() => { navigate('/memory'); }}
          className="inline-flex min-h-7 items-center text-[12px] font-medium text-selected-ink transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
        >
          {t('st.memory.open')}
        </button>
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

type WorkspaceOverride = 'inherit' | 'true' | 'false';

export function MemoryWorkspaceSettingsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [saved, ping] = useSavedTick();
  const workspacesQuery = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  const settingsQuery = useQuery({ queryKey: MEMORY_SETTINGS_KEY, queryFn: () => client.getMemorySettings(), staleTime: 15_000 });
  const workspaces = workspacesQuery.data?.items ?? [];
  const requestedWorkspace = params.get('workspace');
  const selectedId = workspaces.find((workspace) => workspace.id === requestedWorkspace)?.id ?? workspaces[0]?.id;
  const workspaceQuery = useQuery({
    queryKey: ['memory-workspace-settings', selectedId],
    queryFn: () => client.getWorkspaceMemorySettings(selectedId!),
    enabled: selectedId !== undefined,
  });
  const update = useMutation({
    mutationFn: (enabled: boolean | null) => client.patchWorkspaceMemorySettings(selectedId!, enabled),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: MEMORY_SETTINGS_KEY }),
        queryClient.invalidateQueries({ queryKey: ['memory-workspace-settings', selectedId] }),
      ]);
      ping();
    },
  });
  const overrides = workspaces.filter((workspace) => workspace.id !== selectedId && settingsQuery.data?.workspaces[workspace.id] !== undefined);
  const feedback: Feedback = workspacesQuery.isError || settingsQuery.isError || workspaceQuery.isError
    ? { tone: 'error', text: t('st.memory.loadFailed', { detail: errorText(locale, workspacesQuery.error ?? settingsQuery.error ?? workspaceQuery.error) }) }
    : update.isError
      ? { tone: 'error', text: t('st.memory.saveFailed', { detail: errorText(locale, update.error) }) }
      : null;
  const override: WorkspaceOverride = workspaceQuery.data?.enabled === null || workspaceQuery.data === undefined
    ? 'inherit'
    : String(workspaceQuery.data.enabled) as WorkspaceOverride;
  const effective = workspaceQuery.data === undefined
    ? undefined
    : t(workspaceQuery.data.effective_enabled ? 'st.memory.enabled' : 'st.memory.disabled');

  return (
    <SectionCard id="st-card-memory-workspaces" title={t('st.memory.workspaces')} scope="workspace">
      <div className="space-y-2" data-memory-workspace-settings>
        {workspaces.length === 0 && !workspacesQuery.isPending ? <Hint>{t('st.memory.workspaceNone')}</Hint> : null}
        {selectedId !== undefined ? (
          <>
            <SettingField label={t('st.memory.workspaceSelect')}>
              <SettingsSelect
                id="memory-workspace-select"
                dataAttr="data-memory-workspace-select"
                ariaLabel={t('st.memory.workspaceSelect')}
                className="max-w-64"
                value={selectedId}
                onChange={(id) => { const next = new URLSearchParams(params); next.set('workspace', id); setParams(next, { replace: true }); }}
                choices={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name, hint: workspace.root }))}
              />
            </SettingField>
            <SettingField
              label={t('memory.ws.label')}
              help={<>
                {t('st.memory.workspaceHelp')}
                {effective !== undefined ? (
                  <span data-memory-workspace-effective role="status" className="ml-1 text-ink-soft">
                    {t('st.memory.workspaceEffectiveInline', { state: effective })}
                  </span>
                ) : null}
              </>}
            >
              <SaveStatus saving={update.isPending} saved={saved && !update.isError} />
              <SettingsSelect<WorkspaceOverride>
                dataAttr="data-memory-workspace-override"
                ariaLabel={t('memory.ws.label')}
                value={override}
                disabled={workspaceQuery.isPending || update.isPending}
                onChange={(next) => { update.mutate(next === 'inherit' ? null : next === 'true'); }}
                choices={[
                  { value: 'inherit', label: t('memory.ws.follow') },
                  { value: 'true', label: t('memory.ws.on') },
                  { value: 'false', label: t('memory.ws.off') },
                ]}
              />
            </SettingField>
          </>
        ) : null}
        {overrides.length > 0 ? (
          <div data-memory-other-overrides className="space-y-0.5 pt-1 text-[12px] text-ink-soft">
            <p className="font-medium">{t('st.memory.workspaceOverrides')}</p>
            {overrides.map((workspace) => (
              <p key={workspace.id}>{t('st.memory.workspaceOverride', {
                name: workspace.name,
                state: t(settingsQuery.data?.workspaces[workspace.id] === true ? 'memory.ws.on' : 'memory.ws.off'),
              })}</p>
            ))}
          </div>
        ) : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
