import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { experimentalFlagRows } from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';

/**
 * Experimental flags (redesign §10.3): server-side feature switches with
 * inherited/effective state, moved out of the dissolved capabilities section
 * unchanged — same overrides draft, same `experimental` replace-domain save.
 */
export function ExperimentalSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const metaQuery = useQuery({ queryKey: ['meta'], queryFn: () => client.meta(), staleTime: 15_000 });

  useEffect(() => {
    if (configQuery.data !== undefined) setOverrides({ ...(configQuery.data.experimental ?? {}) });
  }, [configQuery.data]);

  const rows = experimentalFlagRows(metaQuery.data ?? {}, { experimental: overrides });
  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({
        experimental: overrides,
        replace_domains: ['experimental'],
      });
      queryClient.setQueryData(['config'], echoed);
      setOverrides({ ...(echoed.experimental ?? {}) });
      await queryClient.invalidateQueries({ queryKey: ['meta'] });
      setFeedback({ tone: 'success', text: t('st.experimental.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-experimental" title={t('st.experimental.title')}>
      <div className="space-y-3">
        <Hint>{t('st.experimental.hint')}</Hint>
        <fieldset disabled={saving} className="space-y-2 disabled:opacity-60">
          {rows.map((row) => (
            <div key={row.id} className="rounded-lg border border-hairline bg-paper px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-all font-mono text-[12px] font-medium text-ink">{row.id}</p>
                  <p className="text-[10.5px] text-ink-faint">
                    {t(row.effective ? 'st.experimental.effectiveOn' : 'st.experimental.effectiveOff')}
                    {' · '}
                    {t(row.override === undefined ? 'st.experimental.inherited' : 'st.experimental.overridden')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Toggle
                    label={t('st.experimental.overrideLabel', { id: row.id })}
                    checked={row.override ?? row.effective}
                    onChange={(checked) => { setOverrides((current) => ({ ...current, [row.id]: checked })); }}
                  />
                  {row.override !== undefined ? (
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      onClick={() => {
                        setOverrides((current) => {
                          const next = { ...current };
                          delete next[row.id];
                          return next;
                        });
                      }}
                    >
                      {t('st.experimental.useInherited')}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
          {rows.length === 0 && !metaQuery.isLoading && !configQuery.isLoading ? <Hint>{t('st.experimental.empty')}</Hint> : null}
        </fieldset>
        <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? t('common.saving') : t('common.save')}</button>
        {metaQuery.isError ? <InlineError error={metaQuery.error} /> : null}
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
