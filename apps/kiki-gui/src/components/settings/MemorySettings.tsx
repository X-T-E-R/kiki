import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { errorText } from '@kiki/session-core/i18n';
import { workspaceSettingsPath } from '@kiki/session-core/settings';
import { DefaultOnSwitch, optionalCapabilityState } from '../capabilities/optionalCapabilityUi';
import { useI18n } from '../../i18n';
import type { KikiConfigResponse, MemoryApproval, MemorySettings } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, SaveStatus, Toggle, type Feedback } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { SECONDARY_BUTTON } from '../ui';
import { Icon } from '../icons';
import { invalidateMemoryAdvisorReads } from '../memory/useMemoryAdvisor';
import { SectionCard } from './SectionCard';
import { AdvancedDetails, SettingField, SettingsBox } from './fields';
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
      // The advisor reads carry their own `effective_enabled` and status,
      // which this write just changed.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: MEMORY_WORKSPACE_SETTINGS_KEY }),
        invalidateMemoryAdvisorReads(queryClient),
      ]);
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
        <SettingsBox>
          <div>
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
          </div>
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
        </SettingsBox>
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

/**
 * Workspaces whose memory does not follow the global default. The page only
 * lists them: an override belongs to the workspace it governs, so it is
 * written on that workspace's own page — never here. Every row is a link
 * there, and no click on this page changes anything.
 */
export function MemoryWorkspaceSettingsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const workspacesQuery = useQuery({ queryKey: ['workspaces', 'catalog'], queryFn: () => client.listWorkspaceCatalog(), staleTime: 30_000 });
  const settingsQuery = useQuery({ queryKey: MEMORY_SETTINGS_KEY, queryFn: () => client.getMemorySettings(), staleTime: 15_000 });
  const overrides = settingsQuery.data === undefined
    ? []
    : Object.entries(settingsQuery.data.workspaces)
      .map(([id, enabled]) => ({ id, enabled, name: workspacesQuery.data?.items.find((workspace) => workspace.id === id)?.name ?? id }));
  const feedback: Feedback = workspacesQuery.isError || settingsQuery.isError
    ? { tone: 'error', text: t('st.memory.loadFailed', { detail: errorText(locale, workspacesQuery.error ?? settingsQuery.error) }) }
    : null;

  return (
    <SectionCard id="st-card-memory-workspaces" title={t('st.memory.workspaces')} scope="workspace">
      <div className="space-y-2" data-memory-workspace-settings>
        <Hint>{t('st.memory.workspaceExceptionsHint')}</Hint>
        {settingsQuery.isPending ? <Hint>{t('cap.loading')}</Hint> : overrides.length === 0 ? (
          <p data-memory-exceptions-empty className="text-[13px] text-ink-faint">{t('st.memory.workspaceExceptionsEmpty')}</p>
        ) : (
          <ul data-memory-exceptions className="divide-y divide-hairline rounded-lg border border-hairline bg-paper">
            {overrides.map((override) => (
              <li key={override.id}>
                <Link to={`${workspaceSettingsPath(override.id)}#st-card-workspace-memory`}
                  data-memory-exception-open={override.id}
                  aria-label={t('st.memory.workspaceExceptionOpen', { name: override.name })}
                  className="flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-ink/[0.03] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:min-h-11">
                  <span className="min-w-0 flex-1 truncate">{override.name}</span>
                  <span className="shrink-0 text-[12px] text-ink-faint">
                    {t(override.enabled ? 'memory.ws.on' : 'memory.ws.off')}
                  </span>
                  <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />
                </Link>
              </li>
            ))}
          </ul>
        )}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
