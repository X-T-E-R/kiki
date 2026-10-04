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
 * Engine defaults for these ceilings, from the engine's own sections:
 *  - workspaceIdleTtlMs : DEFAULT_WORKSPACE_IDLE_TTL_MS = 5 min
 *  - imageMaxEdgePx     : MAX_IMAGE_EDGE_PX = 2000 px
 *  - imageReadByteBudget: READ_IMAGE_BYTE_BUDGET = 256 KiB
 */
const RESOURCE_DEFAULTS = {
  workspaceIdleTtlS: '300',
  imageMaxEdgePx: '2000',
  imageReadByteBudget: '262144',
} as const;

/** Durations are stored in ms and edited in seconds, like the residency card. */
function millisecondsAsSecondsText(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const ms = Number(trimmed);
  return Number.isFinite(ms) ? String(ms / 1000) : value;
}

function secondsTextAsMilliseconds(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const seconds = Number(trimmed);
  // Anything unparsable is passed through so the patch helper reports it.
  return Number.isFinite(seconds) ? String(Math.round(seconds * 1000)) : value;
}

/**
 * Workspace and image resource ceilings (runtime split): engine-internal
 * limits rather than everyday workspace management, so they live under
 * Advanced. Optional numbers left empty delete the saved value and restore
 * the engine default. The workspace TTL reclaims the resident workspace
 * instance; it never removes the directory.
 */
export function ResourceLimitsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ResourceLimitDraft | null>(null);
  // What the last real read said. A draft that returns to it is not a change,
  // so the bar goes quiet on its own — no separate "you edited" flag to keep
  // in step with the values it was supposed to describe.
  const [baseline, setBaseline] = useState<ResourceLimitDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  const dirty = draft !== null && baseline !== null && (
    draft.workspaceIdleTtlMs !== baseline.workspaceIdleTtlMs
    || draft.imageMaxEdgePx !== baseline.imageMaxEdgePx
    || draft.imageReadByteBudget !== baseline.imageReadByteBudget);

  const project = (config: unknown): ResourceLimitDraft => {
    const projected = runtimeConfigDraftFromConfig(config);
    return {
      workspaceIdleTtlMs: projected.workspaceIdleTtlMs,
      imageMaxEdgePx: projected.imageMaxEdgePx,
      imageReadByteBudget: projected.imageReadByteBudget,
    };
  };

  // A new read from the server becomes the baseline, but only while the reader
  // has nothing to lose: an unsaved draft is never overwritten by a background
  // refresh. Saving and discarding both land here with the server's own echo.
  useEffect(() => {
    if (configQuery.data === undefined || dirty) return;
    const next = project(configQuery.data);
    setDraft(next);
    setBaseline(next);
    // `project` is rebuilt each render; the config read is what may change here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configQuery.data, dirty]);

  if (draft === null || baseline === null) {
    return (
      <SectionCard id="st-card-resource-limits" title={t('st.resourceLimits.title')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }

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
      // The echo is the new baseline, and the form adopts it, so an optional
      // value the server dropped reads as empty again rather than staying
      // "edited" forever.
      const next = project(echoed);
      setDraft(next);
      setBaseline(next);
      pingSaved();
    } catch (error) {
      // A failed save leaves the draft exactly as typed: nothing is reverted,
      // and the baseline still says what the server last actually had.
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-resource-limits" title={t('st.resourceLimits.title')}>
      <div className="space-y-4">
        <Hint>{t('st.resourceLimits.hint')} <span className="text-ink-soft">{t('st.resourceLimits.emptyRule')}</span></Hint>
        <fieldset disabled={saving} className="min-w-0 space-y-4 disabled:opacity-60">
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              label={t('st.resourceLimits.workspaceIdle')}
              value={millisecondsAsSecondsText(draft.workspaceIdleTtlMs)}
              detail={t('st.resourceLimits.workspaceIdleDetail', { seconds: RESOURCE_DEFAULTS.workspaceIdleTtlS })}
              onChange={(seconds) => { setDraft({ ...draft, workspaceIdleTtlMs: secondsTextAsMilliseconds(seconds) }); }}
            />
            <NumberField
              label={t('st.resourceLimits.imageMaxEdge')}
              value={draft.imageMaxEdgePx}
              detail={t('st.resourceLimits.imageMaxEdgeDetail', { px: RESOURCE_DEFAULTS.imageMaxEdgePx })}
              onChange={(imageMaxEdgePx) => { setDraft({ ...draft, imageMaxEdgePx }); }}
            />
            <NumberField
              label={t('st.resourceLimits.imageBudget')}
              value={draft.imageReadByteBudget}
              detail={t('st.resourceLimits.imageBudgetDetail', { bytes: RESOURCE_DEFAULTS.imageReadByteBudget })}
              onChange={(imageReadByteBudget) => { setDraft({ ...draft, imageReadByteBudget }); }}
            />
            {/* MCP startup/tool timeouts live on Settings → MCP
                (st-card-mcp-timeouts) since the batch-3 split; these drafts
                and patches never carry the mcp domain. */}
          </div>
        </fieldset>
        <SettingsDraftFooter saved={justSaved} id="resource-limits" dirty={dirty} saving={saving} onSave={() => void save()}
          onDiscard={() => {
            if (configQuery.data !== undefined) { const next = project(configQuery.data); setDraft(next); setBaseline(next); }
            setFeedback(null);
          }} />
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
