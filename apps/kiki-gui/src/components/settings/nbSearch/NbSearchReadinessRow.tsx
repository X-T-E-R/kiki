import type { NbSearchTestStatus } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../../i18n';
import type { ReadinessState } from './types';
import { NbSearchIssues } from './NbSearchIssues';

const STATE_BADGE: Record<ReadinessState, string> = {
  ready: 'border-success/40 bg-success/10 text-success',
  degraded: 'border-amber-rule/60 bg-amber-card text-amber-ink',
  unconfigured: 'border-hairline bg-paper text-ink-faint',
  unavailable: 'border-danger/40 bg-danger/5 text-danger',
};

export function NbSearchStateBadge({ state }: { state: ReadinessState }) {
  const { t } = useI18n();
  const labelKey: I18nKey =
    state === 'ready'
      ? 'st.nbSearch.stateReady'
      : state === 'degraded'
        ? 'st.nbSearch.stateDegraded'
        : state === 'unconfigured'
          ? 'st.nbSearch.stateUnconfigured'
          : 'st.nbSearch.stateUnavailable';
  return (
    <span
      className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${STATE_BADGE[state]}`}
    >
      {t(labelKey)}
    </span>
  );
}

/**
 * One capability row: what the tool is, whether it works right now, and which
 * lane / chain is in effect — the three questions a user opens the overview
 * with. Issues render as sentences under the row.
 */
export function NbSearchReadinessRow({
  label,
  desc,
  state,
  readiness,
}: {
  label: string;
  /** One plain sentence on what this tool does for the assistant. */
  desc?: string;
  state: ReadinessState;
  readiness: NbSearchTestStatus['search'];
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-hairline bg-paper px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-semibold text-ink">{label}</span>
        <NbSearchStateBadge state={state} />
      </div>
      {desc !== undefined ? <p className="mt-0.5 text-[11px] text-ink-faint">{desc}</p> : null}
      {readiness.selection !== undefined ? (
        <p className="mt-1 text-[11px] text-ink-soft">
          {t('st.nbSearch.currentSelection', { selection: readiness.selection })}
        </p>
      ) : null}
      <NbSearchIssues issues={readiness.issues} />
    </div>
  );
}
