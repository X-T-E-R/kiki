import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import type { MemoryApproval, MemorySettings } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, Toggle, type Feedback } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { SMALL_INPUT, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingField } from './fields';

const MEMORY_SETTINGS_KEY = ['memory-settings'] as const;

export function MemorySettingsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const [budget, setBudget] = useState('');
  const settingsQuery = useQuery({
    queryKey: MEMORY_SETTINGS_KEY,
    queryFn: () => client.getMemorySettings(),
    staleTime: 15_000,
  });
  useEffect(() => {
    if (settingsQuery.data !== undefined) setBudget(String(settingsQuery.data.budget));
  }, [settingsQuery.data?.budget]);
  const update = useMutation({
    mutationFn: (patch: { enabled?: boolean; approval?: MemoryApproval; budget?: number }) => client.patchMemorySettings(patch),
    onSuccess: (next: MemorySettings) => { queryClient.setQueryData(MEMORY_SETTINGS_KEY, next); },
  });
  const parsedBudget = Number(budget);
  const validBudget = /^\d+$/.test(budget) && Number.isInteger(parsedBudget) && parsedBudget <= 4_000;
  const feedback: Feedback = settingsQuery.isError
    ? { tone: 'error', text: t('st.memory.loadFailed', { detail: errorText(locale, settingsQuery.error) }) }
    : update.isError
      ? { tone: 'error', text: t('st.memory.saveFailed', { detail: errorText(locale, update.error) }) }
      : null;

  return (
    <SectionCard id="st-card-memory" title={t('st.memory.title')}>
      <div className="min-w-0 space-y-2" data-memory-settings>
        <SettingField label={t('memory.toggle')} help={t('st.memory.hint')}>
          <Toggle
            label={t('memory.toggle')}
            checked={settingsQuery.data?.enabled === true}
            disabled={settingsQuery.isPending || update.isPending}
            onChange={(enabled) => { update.mutate({ enabled }); }}
          />
        </SettingField>
        <SettingField label={t('st.memory.approval')} htmlFor="memory-approval">
          <select
            id="memory-approval"
            data-memory-approval
            className={SMALL_INPUT}
            value={settingsQuery.data?.approval ?? 'auto'}
            disabled={settingsQuery.isPending || update.isPending}
            onChange={(event) => { update.mutate({ approval: event.target.value as MemoryApproval }); }}
          >
            <option value="auto">{t('st.memory.approval.auto')}</option>
            <option value="review">{t('st.memory.approval.review')}</option>
            <option value="off">{t('st.memory.approval.off')}</option>
          </select>
        </SettingField>
        <SettingField label={t('st.memory.budget')} htmlFor="memory-budget" help={t('st.memory.budgetHint')}>
          <input
            id="memory-budget"
            data-memory-budget
            className={`${SMALL_INPUT} w-24`}
            type="number"
            min={0}
            max={4000}
            step={1}
            value={budget}
            disabled={settingsQuery.isPending || update.isPending}
            onChange={(event) => { setBudget(event.target.value); }}
          />
          <button
            type="button"
            data-memory-budget-save
            className={SECONDARY_BUTTON}
            disabled={settingsQuery.isPending || update.isPending || !validBudget || parsedBudget === settingsQuery.data?.budget}
            onClick={() => { update.mutate({ budget: parsedBudget }); }}
          >
            {t('st.memory.budgetSave')}
          </button>
        </SettingField>
        {budget !== '' && !validBudget ? <Hint>{t('st.memory.budgetInvalid')}</Hint> : null}
        <button
          type="button"
          data-memory-settings-link
          onClick={() => { navigate('/memory'); }}
          className="text-[12px] font-medium text-accent-ink transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-accent"
        >
          {t('st.memory.open')}
        </button>
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

export function MemoryWorkspaceSettingsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MEMORY_SETTINGS_KEY });
      void queryClient.invalidateQueries({ queryKey: ['memory-workspace-settings', selectedId] });
    },
  });
  const overrides = workspaces.filter((workspace) => workspace.id !== selectedId && settingsQuery.data?.workspaces[workspace.id] !== undefined);
  const feedback: Feedback = workspacesQuery.isError || settingsQuery.isError || workspaceQuery.isError
    ? { tone: 'error', text: t('st.memory.loadFailed', { detail: errorText(locale, workspacesQuery.error ?? settingsQuery.error ?? workspaceQuery.error) }) }
    : update.isError
      ? { tone: 'error', text: t('st.memory.saveFailed', { detail: errorText(locale, update.error) }) }
      : null;

  return (
    <SectionCard id="st-card-memory-workspaces" title={t('st.memory.workspaces')} scope="workspace">
      <div className="space-y-3" data-memory-workspace-settings>
        {workspaces.length === 0 && !workspacesQuery.isPending ? <Hint>{t('st.memory.workspaceNone')}</Hint> : null}
        {selectedId !== undefined ? (
          <>
            <SettingField label={t('st.memory.workspaceSelect')} htmlFor="memory-workspace-select">
              <select
                id="memory-workspace-select"
                data-memory-workspace-select
                className={SMALL_INPUT}
                value={selectedId}
                onChange={(event) => { const next = new URLSearchParams(params); next.set('workspace', event.target.value); setParams(next, { replace: true }); }}
              >
                {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
              </select>
            </SettingField>
            <SettingField label={t('memory.ws.label')} help={t('st.memory.workspaceHelp')}>
              <select
                data-memory-workspace-override
                aria-label={t('memory.ws.label')}
                className={SMALL_INPUT}
                value={workspaceQuery.data?.enabled === null ? 'inherit' : String(workspaceQuery.data?.enabled ?? 'inherit')}
                disabled={workspaceQuery.isPending || update.isPending}
                onChange={(event) => { update.mutate(event.target.value === 'inherit' ? null : event.target.value === 'true'); }}
              >
                <option value="inherit">{t('memory.ws.follow')}</option>
                <option value="true">{t('memory.ws.on')}</option>
                <option value="false">{t('memory.ws.off')}</option>
              </select>
            </SettingField>
            {workspaceQuery.data !== undefined ? (
              <p data-memory-workspace-effective role="status" className="text-[12px] text-ink-soft">
                {t('st.memory.workspaceEffective')}: {t(workspaceQuery.data.effective_enabled ? 'st.memory.enabled' : 'st.memory.disabled')}
              </p>
            ) : null}
          </>
        ) : null}
        {overrides.length > 0 ? (
          <div data-memory-other-overrides className="space-y-1 text-[12px] text-ink-soft">
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
