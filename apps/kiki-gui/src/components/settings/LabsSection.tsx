import { Link, useLocation } from 'react-router-dom';

import {
  EXPERIMENTAL_FLAG_HOMES,
  experimentalCardId,
  experimentalFlagHome,
  experimentalSectionForFlag,
  settingsSectionLabels,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { Hint, InlineError } from '../controls';
import { useExperimentalFlags } from './ExperimentalRows';
import { SectionCard } from './SectionCard';

/**
 * Labs is an index, not a second home: each experimental flag is switched on
 * the page of the feature it changes, and Labs lists them all with a link to
 * that row. Read-only here so there is exactly one control per flag.
 */
export function LabsSection() {
  const { t } = useI18n();
  const { search } = useLocation();
  const { rows, effective, loading, error } = useExperimentalFlags();
  const labels = settingsSectionLabels(t);
  // Keep server/token deep-link params on the jump, like every settings link.
  const query = (() => {
    const params = new URLSearchParams(search);
    params.delete('tab');
    const text = params.toString();
    return text === '' ? '' : `?${text}`;
  })();
  const order = (id: string) => {
    const index = EXPERIMENTAL_FLAG_HOMES.findIndex((home) => home.id === id);
    return index === -1 ? EXPERIMENTAL_FLAG_HOMES.length : index;
  };
  const sorted = rows.toSorted((a, b) => order(a.id) - order(b.id) || a.id.localeCompare(b.id));

  return (
    <SectionCard id="st-card-labs" title={t('st.labs.indexTitle')}>
      {loading ? <Hint>{t('st.runtime.loading')}</Hint> : null}
      {error !== null && error !== undefined ? <InlineError error={error} /> : null}
      {!loading && sorted.length === 0 && (error === null || error === undefined) ? <Hint>{t('st.labs.empty')}</Hint> : null}
      <ul className="divide-y divide-hairline" data-labs-index>
        {sorted.map((row) => {
          const home = experimentalFlagHome(row.id);
          const section = experimentalSectionForFlag(row.id);
          const card = home?.cardId ?? experimentalCardId(section);
          const page = labels[section] ?? section;
          const state = effective[row.id];
          return (
            <li key={row.id} data-labs-entry={row.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-2 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="text-[13px] text-ink">{t(home?.labelKey ?? 'st.exp.unknown.name')}</p>
                <p className="text-[12px] leading-snug text-ink-faint">
                  <span className={state === true ? 'text-success' : undefined}>
                    {t(state === undefined ? 'st.exp.state.unknown' : state ? 'st.exp.state.on' : 'st.exp.state.off')}
                  </span>
                  <span aria-hidden className="px-1.5">·</span>
                  <span className="font-mono text-[11px]">{row.id}</span>
                </p>
              </div>
              <Link
                to={`/settings/${section}${query}#${card}`}
                data-labs-link={section}
                className="inline-flex min-h-8 items-center rounded-md px-1 text-[13px] font-medium text-selected-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
              >
                {t('st.labs.openIn', { page })}
              </Link>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
