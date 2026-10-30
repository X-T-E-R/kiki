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
import { SettingField, SettingsBox } from './fields';
import { SettingsDraftFooter } from './SettingsPrimitives';
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

/** One ceiling, edited in place. The detail carries the engine default. */
function LimitRow({ label, id, detail, unit, value, disabled, onChange }: {
  readonly label: string;
  readonly id: string;
  readonly detail?: string;
  readonly unit?: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <SettingField label={label} htmlFor={id} detail={detail}>
      <div className="flex items-center gap-1.5">
        <input
          id={id}
          className="h-8 w-24 rounded-md border border-hairline bg-paper px-2 text-right font-mono text-[12.5px] text-ink outline-none transition-colors hover:border-hairline-strong focus:border-selected-ink"
          inputMode="numeric"
          value={value}
          disabled={disabled}
          onChange={(event) => { onChange(event.target.value); }}
        />
        {unit !== undefined ? <span className="text-[12px] text-ink-faint">{unit}</span> : null}
      </div>
    </SettingField>
  );
}

/**
 * Workspace and image resource ceilings. Optional numbers left empty delete
 * the saved value and restore the engine default. The workspace TTL reclaims
 * the resident workspace instance; it never removes the directory.
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

  const dirtyNow = draft !== null && baseline !== null && (
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
    if (configQuery.data === undefined || dirtyNow) return;
    const next = project(configQuery.data);
    setDraft(next);
    setBaseline(next);
    // `project` is rebuilt each render; the config read is what may change here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configQuery.data, dirtyNow]);

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
      <div className="space-y-3">
        <SettingsBox>
          <LimitRow
            label={t('st.resourceLimits.workspaceIdle')}
            id="resource-limits-workspace-idle"
            detail={t('st.resourceLimits.workspaceIdleDetail', { seconds: RESOURCE_DEFAULTS.workspaceIdleTtlS })}
            unit={t('st.residency.secondsUnit')}
            value={millisecondsAsSecondsText(draft.workspaceIdleTtlMs)}
            disabled={saving}
            onChange={(seconds) => { setDraft({ ...draft, workspaceIdleTtlMs: secondsTextAsMilliseconds(seconds) }); }}
          />
          <LimitRow
            label={t('st.resourceLimits.imageMaxEdge')}
            id="resource-limits-image-max-edge"
            detail={t('st.resourceLimits.imageMaxEdgeDetail', { px: RESOURCE_DEFAULTS.imageMaxEdgePx })}
            unit={t('st.resourceLimits.pxUnit')}
            value={draft.imageMaxEdgePx}
            disabled={saving}
            onChange={(imageMaxEdgePx) => { setDraft({ ...draft, imageMaxEdgePx }); }}
          />
          <LimitRow
            label={t('st.resourceLimits.imageBudget')}
            id="resource-limits-image-budget"
            detail={t('st.resourceLimits.imageBudgetDetail', { bytes: RESOURCE_DEFAULTS.imageReadByteBudget })}
            unit={t('st.resourceLimits.bytesUnit')}
            value={draft.imageReadByteBudget}
            disabled={saving}
            onChange={(imageReadByteBudget) => { setDraft({ ...draft, imageReadByteBudget }); }}
          />
        </SettingsBox>
        <SettingsDraftFooter saved={justSaved} id="resource-limits" dirty={dirtyNow} saving={saving} onSave={() => void save()}
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
