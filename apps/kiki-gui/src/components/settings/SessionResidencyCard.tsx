import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import type { I18nKey } from '@kiki/session-core/i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SaveStatus } from '../controls';
import { AdvancedDetails, SettingField } from './fields';
import { SectionCard } from './SectionCard';
import { CommitInput } from './SettingsPrimitives';
import { useInstantSave } from './useInstantSave';

type ResidencyKey = 'idleTtlMs' | 'maxLiveSessions' | 'minIdleMs' | 'sweepIntervalMs' | 'maxConcurrentRestores' | 'maxQueuedRestores';

interface ResidencyField {
  readonly key: ResidencyKey;
  readonly wire: string;
  readonly label: I18nKey;
  readonly help: I18nKey;
  /** Durations are stored in ms and edited in seconds. */
  readonly seconds: boolean;
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
}

// Bounds and defaults mirror the engine's session residency config section.
const FIELDS: readonly ResidencyField[] = [
  { key: 'maxLiveSessions', wire: 'max_live_sessions', label: 'st.residency.maxLive', help: 'st.residency.maxLiveHelp', seconds: false, min: 1, max: 64, fallback: 8 },
  { key: 'idleTtlMs', wire: 'idle_ttl_ms', label: 'st.residency.idleTtl', help: 'st.residency.idleTtlHelp', seconds: true, min: 0, max: 86_400_000, fallback: 600_000 },
  { key: 'minIdleMs', wire: 'min_idle_ms', label: 'st.residency.minIdle', help: 'st.residency.minIdleHelp', seconds: true, min: 0, max: 86_400_000, fallback: 60_000 },
  { key: 'sweepIntervalMs', wire: 'sweep_interval_ms', label: 'st.residency.sweep', help: 'st.residency.sweepHelp', seconds: true, min: 1_000, max: 300_000, fallback: 30_000 },
  { key: 'maxConcurrentRestores', wire: 'max_concurrent_restores', label: 'st.residency.concurrentRestores', help: 'st.residency.concurrentRestoresHelp', seconds: false, min: 1, max: 4, fallback: 1 },
  { key: 'maxQueuedRestores', wire: 'max_queued_restores', label: 'st.residency.queuedRestores', help: 'st.residency.queuedRestoresHelp', seconds: false, min: 0, max: 64, fallback: 8 },
];

function ResidencyRow({ field, stored }: { field: ResidencyField; stored: number | undefined }) {
  const { client } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const save = useInstantSave();
  const scale = field.seconds ? 1000 : 1;
  const shown = String((stored ?? field.fallback) / scale);
  const lo = field.min / scale;
  const hi = field.max / scale;
  return (
    <>
      <SettingField label={t(field.label)} help={t(field.help)}>
        <SaveStatus saving={save.saving} saved={save.saved} />
        <div className="flex items-center gap-1.5">
          <CommitInput
            ariaLabel={t(field.label)}
            dataAttr={`data-residency-${field.wire.replaceAll('_', '-')}`}
            className="w-20"
            inputMode="numeric"
            value={shown}
            disabled={save.saving}
            validate={(text) => {
              const value = Number(text);
              return text !== '' && Number.isInteger(value) && value >= lo && value <= hi ? null : t('st.residency.range', { min: lo, max: hi });
            }}
            onCommit={(text) => void save.run(async () => {
              const echoed = await client.patchConfig({ session_residency: { [field.wire]: Number(text) * scale } });
              queryClient.setQueryData(['config'], echoed);
            })}
          />
          {field.seconds ? <span className="text-[12px] text-ink-faint">{t('st.residency.secondsUnit')}</span> : null}
        </div>
      </SettingField>
      <FeedbackLine feedback={save.error} />
    </>
  );
}

/**
 * Developer → Session residency: how many sessions stay loaded in memory and
 * when idle ones are unloaded. Each number saves on its own; the rarely
 * tuned sweep and restore queue sit under Advanced.
 */
export function SessionResidencyCard() {
  const { client } = useConnection();
  const { t } = useI18n();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  if (configQuery.data === undefined) {
    return (
      <SectionCard id="st-card-session-residency" title={t('st.residency.title')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }
  const stored = (configQuery.data.session_residency ?? {}) as Partial<Record<ResidencyKey, number>>;
  const [primary, advanced] = [FIELDS.slice(0, 2), FIELDS.slice(2)];
  return (
    <SectionCard id="st-card-session-residency" title={t('st.residency.title')}>
      <div className="space-y-1">
        <Hint>{t('st.residency.hint')}</Hint>
        {primary.map((field) => <ResidencyRow key={field.key} field={field} stored={stored[field.key]} />)}
        <AdvancedDetails summary={t('st.residency.advanced')}>
          <div className="space-y-1">
            {advanced.map((field) => <ResidencyRow key={field.key} field={field} stored={stored[field.key]} />)}
          </div>
        </AdvancedDetails>
      </div>
    </SectionCard>
  );
}
