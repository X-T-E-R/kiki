import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { errorText } from '@kiki/session-core/i18n';
import { DefaultOnSwitch, optionalCapabilityState } from '../capabilities/optionalCapabilityUi';
import { useI18n } from '../../i18n';
import type { KikiConfigResponse, MemoryApproval, MemorySettings } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, SaveStatus, Toggle, type Feedback } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { SECONDARY_BUTTON } from '../ui';
import { Icon } from '../icons';
import { SectionCard } from './SectionCard';
import { AdvancedDetails, SettingField } from './fields';
import { CommitInput, SettingsSelect } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

const MEMORY_SETTINGS_KEY = ['memory-settings'] as const;
/** Every workspace's computed effective state, whichever one the card shows. */
const MEMORY_WORKSPACE_SETTINGS_KEY = ['memory-workspace-settings'] as const;

type MemoryPatch = { enabled?: boolean; approval?: MemoryApproval; budget?: number };

export function MemorySettingsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const [saved, ping] = useSavedTick();
  const [defaultError, setDefaultError] = useState<unknown>();
  const settingsQuery = useQuery({
    queryKey: MEMORY_SETTINGS_KEY,
    queryFn: () => client.getMemorySettings(),
    staleTime: 15_000,
  });
  const configQuery = useQuery({
    queryKey: ['config', 'memory-default'],
    queryFn: () => client.getConfig(),
    enabled: typeof client.getConfig === 'function',
    staleTime: 30_000,
  });
  const memoryCapability = optionalCapabilityState(configQuery.data, 'memory');
  const update = useMutation({
    mutationFn: (patch: MemoryPatch) => client.patchMemorySettings(patch),
    onSuccess: async (next: MemorySettings, patch: MemoryPatch) => {
      queryClient.setQueryData(MEMORY_SETTINGS_KEY, next);
      if (patch.enabled !== undefined) {
        queryClient.setQueryData(['config', 'memory-default'], (current: KikiConfigResponse | undefined) => {
          const memory = current?.optional_capabilities?.memory;
          if (current?.optional_capabilities === undefined || memory === undefined) return current;
          return {
            ...current,
            optional_capabilities: {
              ...current.optional_capabilities,
              memory: { ...memory, allowed: next.enabled },
            },
          };
        });
      }
      // The global switch decides every workspace's effective state, so a save
      // that touched it has to re-read all of them, not just the ones this
      // card happens to be holding.
      await queryClient.invalidateQueries({ queryKey: MEMORY_WORKSPACE_SETTINGS_KEY });
      ping();
    },
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
      : defaultError !== undefined
        ? { tone: 'error', text: t('st.memory.saveFailed', { detail: errorText(locale, defaultError) }) }
        : null;

  return (
    <SectionCard id="st-card-memory" title={t('st.memory.title')} actions={(
      <button type="button" data-memory-settings-link className={SECONDARY_BUTTON}
        onClick={() => { void navigate('/memory'); }}>
        {t('st.memory.open')}
      </button>
    )}>
      <div className="min-w-0 space-y-2" data-memory-settings>
        <SettingField label={t('memory.toggle')} htmlFor="memory-enabled" help={t('st.memory.hint')}>
          {status('enabled')}
          <Toggle
            id="memory-enabled"
            layout="bare"
            label={t('memory.toggle')}
            checked={memoryCapability?.allowed ?? settingsQuery.data?.enabled === true}
            disabled={busy || memoryCapability?.host_locked === true}
            onChange={(enabled) => { update.mutate({ enabled }); }}
          />
        </SettingField>
        <DefaultOnSwitch
          id="memory"
          state={memoryCapability}
          disabled={busy}
          onChange={(next) => {
            setDefaultError(undefined);
            void client.patchConfig({ optional_capabilities: { defaults: { memory: next } } }).then((echoed) => {
              queryClient.setQueryData(['config', 'memory-default'], echoed);
              ping();
            }).catch((cause: unknown) => { setDefaultError(cause); });
          }}
        />
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
              { value: 'auto', label: t('st.memory.approval.auto'), hint: t('st.memory.approvalHint.auto') },
              { value: 'review', label: t('st.memory.approval.review'), hint: t('st.memory.approvalHint.review') },
              { value: 'off', label: t('st.memory.approval.off'), hint: t('st.memory.approvalHint.off') },
            ]}
          />
        </SettingField>
        {/* The text budget keeps its system default; it waits behind Advanced. */}
        <AdvancedDetails summary={t('st.memory.advanced')} data-memory-advanced>
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
        </AdvancedDetails>
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
  const workspacesQuery = useQuery({ queryKey: ['workspaces', 'catalog'], queryFn: () => client.listWorkspaceCatalog(), staleTime: 30_000 });
  const settingsQuery = useQuery({ queryKey: MEMORY_SETTINGS_KEY, queryFn: () => client.getMemorySettings(), staleTime: 15_000 });
  const workspaces = workspacesQuery.data?.items ?? [];
  const requestedWorkspace = params.get('workspace');
  const selectedId = workspaces.find((workspace) => workspace.id === requestedWorkspace)?.id ?? workspaces[0]?.id;
  const workspaceQuery = useQuery({
    queryKey: ['memory-workspace-settings', selectedId],
    queryFn: () => client.getWorkspaceMemorySettings(selectedId!),
    enabled: selectedId !== undefined,
  });
  // A write carries its workspace with it: the selection can move while it is
  // in flight, and the result, tick and error belong to the workspace written.
  const [savedId, setSavedId] = useState<string | undefined>();
  const update = useMutation({
    mutationFn: ({ workspaceId, enabled }: { workspaceId: string; enabled: boolean | null }) =>
      client.patchWorkspaceMemorySettings(workspaceId, enabled),
    onSuccess: async (result, { workspaceId }) => {
      const written = result.workspace_id || workspaceId;
      setSavedId(written);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: MEMORY_SETTINGS_KEY }),
        queryClient.invalidateQueries({ queryKey: [...MEMORY_WORKSPACE_SETTINGS_KEY, written] }),
      ]);
      ping();
    },
  });
  const updateHere = update.variables?.workspaceId === selectedId;
  const overrides = workspaces.filter((workspace) => workspace.id !== selectedId && settingsQuery.data?.workspaces[workspace.id] !== undefined);
  const feedback: Feedback = workspacesQuery.isError || settingsQuery.isError || workspaceQuery.isError
    ? { tone: 'error', text: t('st.memory.loadFailed', { detail: errorText(locale, workspacesQuery.error ?? settingsQuery.error ?? workspaceQuery.error) }) }
    : update.isError && updateHere
      ? { tone: 'error', text: t('st.memory.saveFailed', { detail: errorText(locale, update.error) }) }
      : null;
  const override: WorkspaceOverride = workspaceQuery.data?.enabled === null || workspaceQuery.data === undefined
    ? 'inherit'
    : String(workspaceQuery.data.enabled) as WorkspaceOverride;
  const effective = workspaceQuery.data === undefined
    ? undefined
    : t(workspaceQuery.data.effective_enabled ? 'st.memory.enabled' : 'st.memory.disabled');
  // A workspace uses memory only while the global switch is on and its own
  // setting is not off. Global off is said once, here, and nothing is
  // disabled: an override chosen now is saved as chosen and applies as soon
  // as memory is allowed again.
  const globalOff = settingsQuery.data?.enabled === false;
  const select = (id: string) => { const next = new URLSearchParams(params); next.set('workspace', id); setParams(next, { replace: true }); };

  return (
    <SectionCard id="st-card-memory-workspaces" title={t('st.memory.workspaces')} scope="workspace">
      <div className="space-y-2" data-memory-workspace-settings>
        {workspaces.length === 0 && !workspacesQuery.isPending ? <Hint>{t('st.memory.workspaceNone')}</Hint> : null}
        {globalOff && workspaces.length > 0 ? (
          <p data-memory-global-off className="max-w-[62ch] text-[12px] leading-snug text-amber-ink">{t('st.memory.globalOffNotice')}</p>
        ) : null}
        {selectedId !== undefined ? (
          <>
            <SettingField label={t('st.memory.workspaceSelect')}>
              <SettingsSelect
                id="memory-workspace-select"
                dataAttr="data-memory-workspace-select"
                ariaLabel={t('st.memory.workspaceSelect')}
                className="max-w-64"
                value={selectedId}
                onChange={select}
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
              <SaveStatus saving={update.isPending && updateHere} saved={saved && !(update.isError && updateHere) && savedId === selectedId} />
              <SettingsSelect<WorkspaceOverride>
                dataAttr="data-memory-workspace-override"
                ariaLabel={t('memory.ws.label')}
                value={override}
                disabled={workspaceQuery.isPending || (update.isPending && updateHere)}
                onChange={(next) => { update.mutate({ workspaceId: selectedId, enabled: next === 'inherit' ? null : next === 'true' }); }}
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
          <div data-memory-other-overrides className="space-y-1 border-t border-hairline pt-3">
            <p className="text-[13px] text-ink">{t('st.memory.workspaceOverrides')}</p>
            <ul className="divide-y divide-hairline rounded-lg border border-hairline bg-paper">
              {overrides.map((workspace) => (
                <li key={workspace.id}>
                  <button type="button" data-memory-override-open={workspace.id}
                    onClick={() => { select(workspace.id); }}
                    className="flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-ink/[0.03] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:min-h-11">
                    <span className="min-w-0 flex-1 truncate">{t('st.memory.workspaceOverride', {
                      name: workspace.name,
                      state: t(settingsQuery.data?.workspaces[workspace.id] === true ? 'memory.ws.on' : 'memory.ws.off'),
                    })}</span>
                    <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
