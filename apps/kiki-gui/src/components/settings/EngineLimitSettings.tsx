import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import {
  resourceLimitPatch,
  runtimeConfigDraftFromConfig,
  type RuntimeConfigDraft,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { SectionCard } from './SectionCard';
import { SettingsDraftFooter } from './SettingsPrimitives';
import { NumberField } from './runtimeControls';
import { useSavedTick } from './useSavedTick';

type ResourceLimitDraft = Pick<RuntimeConfigDraft, 'workspaceIdleTtlMs' | 'imageMaxEdgePx' | 'imageReadByteBudget'>;

/**
 * Workspace and image resource ceilings (runtime split): engine-internal
 * limits rather than everyday workspace management, so they live under
 * Advanced. Optional numbers left empty delete the saved value and restore
 * the engine default.
 */
export function ResourceLimitsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ResourceLimitDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined && !dirty) {
      const projected = runtimeConfigDraftFromConfig(configQuery.data);
      setDraft({
        workspaceIdleTtlMs: projected.workspaceIdleTtlMs,
        imageMaxEdgePx: projected.imageMaxEdgePx,
        imageReadByteBudget: projected.imageReadByteBudget,
      });
    }
  }, [configQuery.data, dirty]);

  if (draft === null) {
    return (
      <SectionCard id="st-card-resource-limits" title={t('st.resourceLimits.title')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }

  const updateDraft = (next: ResourceLimitDraft) => {
    setDraft(next);
    setDirty(true);
  };

  const save = async () => {
    let patch;
    try {
      patch = resourceLimitPatch(draft);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(patch);
      queryClient.setQueryData(['config'], echoed);
      const projected = runtimeConfigDraftFromConfig(echoed);
      setDraft({
        workspaceIdleTtlMs: projected.workspaceIdleTtlMs,
        imageMaxEdgePx: projected.imageMaxEdgePx,
        imageReadByteBudget: projected.imageReadByteBudget,
      });
      setDirty(false);
      pingSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-resource-limits" title={t('st.resourceLimits.title')}>
      <div className="space-y-4">
        <Hint>{t('st.resourceLimits.hint')}</Hint>
        <fieldset disabled={saving} className="min-w-0 space-y-4 disabled:opacity-60">
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField label={t('st.resourceLimits.workspaceIdle')} value={draft.workspaceIdleTtlMs} onChange={(workspaceIdleTtlMs) => { updateDraft({ ...draft, workspaceIdleTtlMs }); }} />
            <NumberField label={t('st.resourceLimits.imageMaxEdge')} value={draft.imageMaxEdgePx} onChange={(imageMaxEdgePx) => { updateDraft({ ...draft, imageMaxEdgePx }); }} />
            <NumberField label={t('st.resourceLimits.imageBudget')} value={draft.imageReadByteBudget} onChange={(imageReadByteBudget) => { updateDraft({ ...draft, imageReadByteBudget }); }} />
            {/* MCP startup/tool timeouts live on Settings → MCP
                (st-card-mcp-timeouts) since the batch-3 split; these drafts
                and patches never carry the mcp domain. */}
          </div>
        </fieldset>
        <SettingsDraftFooter saved={justSaved} id="resource-limits" dirty={dirty} saving={saving} onSave={() => void save()}
          onDiscard={() => { if (configQuery.data !== undefined) { const value = runtimeConfigDraftFromConfig(configQuery.data); setDraft({ workspaceIdleTtlMs: value.workspaceIdleTtlMs, imageMaxEdgePx: value.imageMaxEdgePx, imageReadByteBudget: value.imageReadByteBudget }); } setDirty(false); setFeedback(null); }} />
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
