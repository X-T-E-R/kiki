/**
 * On-demand key health for one service instance.
 *
 * A `team` scope balance is the team's, not the key's: several keys may report
 * the same `remaining`. Each key shows its own row and is labelled with the
 * scope it came from, and the panel never adds the numbers up into a total.
 *
 * Nothing here runs on mount. A cold cache can still reach the provider even
 * with `refresh: false`, so the panel only calls when the user asks it to, and
 * "Refresh" is the only control that passes `refresh: true`. Only two providers
 * report a balance at all; for the rest the panel says so instead of showing an
 * invented number.
 *
 * Key values never reach this component: the view carries a 1-based index, a
 * state and an optional usage block.
 */

import { useState } from 'react';
import type { NbSearchKeyUsageView } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { SECONDARY_BUTTON } from '../../ui';
import { FeedbackLine, InlineError } from '../../controls';

type KeyUsage = NbSearchKeyUsageView['keys'][number];

const STATE_KEYS = {
  unknown: 'st.nbSearch.keyUsage.stateUnknown',
  ready: 'st.nbSearch.keyUsage.stateReady',
  cooldown: 'st.nbSearch.keyUsage.stateCooldown',
  invalid: 'st.nbSearch.keyUsage.stateInvalid',
  exhausted: 'st.nbSearch.keyUsage.stateExhausted',
} as const;

const STATE_CLASS = {
  unknown: 'text-ink-faint',
  ready: 'text-ink-soft',
  cooldown: 'text-amber-ink',
  invalid: 'text-danger',
  exhausted: 'text-danger',
} as const;

export function NbSearchKeyUsagePanel({
  instanceId,
  readUsage,
}: {
  instanceId: string;
  /** One typed read; `refresh` maps to the request's refresh flag. */
  readUsage: (refresh: boolean) => Promise<NbSearchKeyUsageView>;
}) {
  const { t, time, locale } = useI18n();
  const [view, setView] = useState<NbSearchKeyUsageView | null>(null);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<unknown>(null);

  const load = async (refresh: boolean) => {
    setBusy(true);
    setReadError(null);
    try {
      setView(await readUsage(refresh));
    } catch (error) {
      setReadError(error);
    } finally {
      setBusy(false);
    }
  };

  const formatNumber = (value: number) => new Intl.NumberFormat(locale).format(value);

  const usageLine = (key: KeyUsage): string | null => {
    const usage = key.usage;
    if (usage === undefined) return null;
    const numbers: string[] = [];
    if (usage.remaining !== null) numbers.push(t('st.nbSearch.keyUsage.remaining', { n: formatNumber(usage.remaining) }));
    else if (usage.used !== null) numbers.push(t('st.nbSearch.keyUsage.used', { n: formatNumber(usage.used) }));
    if (usage.limit !== null) numbers.push(t('st.nbSearch.keyUsage.limit', { n: formatNumber(usage.limit) }));
    if (numbers.length === 0) return null;
    const scope = usage.scope === 'team'
      ? t('st.nbSearch.keyUsage.scopeTeam')
      : t('st.nbSearch.keyUsage.scopeKey');
    return t('st.nbSearch.keyUsage.usageLine', { scope, numbers: numbers.join(' · ') });
  };

  return (
    <div className="space-y-2" data-nb-search-key-usage={instanceId}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={SECONDARY_BUTTON}
          disabled={busy}
          data-nb-search-key-usage-load
          onClick={() => {
            void load(false);
          }}
        >
          {view === null ? t('st.nbSearch.keyUsage.check') : t('st.nbSearch.keyUsage.recheck')}
        </button>
        {view === null ? null : (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={busy}
            data-nb-search-key-usage-refresh
            onClick={() => {
              void load(true);
            }}
          >
            {t('st.nbSearch.keyUsage.refresh')}
          </button>
        )}
        {busy ? <span className="text-[12px] text-ink-faint">{t('st.nbSearch.keyUsage.reading')}</span> : null}
      </div>

      {view === null && !busy && readError === null ? (
        <p className="text-[12px] leading-snug text-ink-faint" data-nb-search-key-usage-idle>
          {t('st.nbSearch.keyUsage.idle')}
        </p>
      ) : null}

      {readError !== null && !busy ? (
        <>
          <FeedbackLine feedback={{ tone: 'error', text: t('st.nbSearch.keyUsage.failed') }} />
          <span data-nb-search-key-usage-error>
            <InlineError error={readError} />
          </span>
        </>
      ) : null}

      {view !== null && !busy ? (
        <div className="space-y-2" data-nb-search-key-usage-result>
          <p className="text-[12px] leading-snug text-ink-faint">
            {view.balance_supported
              ? t('st.nbSearch.keyUsage.balanceSupported')
              : t('st.nbSearch.keyUsage.balanceUnsupported')}
          </p>
          <ul className="divide-y divide-hairline" data-nb-search-key-usage-keys>
            {view.keys.map((key) => (
              <li key={key.key_index} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5">
                <span className="font-mono text-[11px] text-ink-faint">
                  {t('st.nbSearch.keyUsage.keyIndex', { n: String(key.key_index) })}
                </span>
                <span className={`text-[13px] ${STATE_CLASS[key.state]}`} data-nb-search-key-state={key.state}>
                  {t(STATE_KEYS[key.state])}
                </span>
                {key.state === 'cooldown' && key.cooldown_until !== undefined ? (
                  <span className="text-[12px] text-ink-faint">
                    {t('st.nbSearch.keyUsage.cooldownUntil', { time: time.timeUntil(key.cooldown_until) })}
                  </span>
                ) : null}
                <span className="ml-auto text-[12px] text-ink-soft">
                  {usageLine(key)
                    ?? (key.usage_error === 'invalid_response'
                      ? t('st.nbSearch.keyUsage.usageInvalidResponse')
                      : key.usage_error === 'unavailable'
                        ? t('st.nbSearch.keyUsage.usageUnavailable')
                        : t('st.nbSearch.keyUsage.usageNone'))}
                </span>
              </li>
            ))}
          </ul>
          {view.keys.length === 0 ? (
            <p className="text-[12px] leading-snug text-ink-faint" data-nb-search-key-usage-empty>
              {t('st.nbSearch.keyUsage.noKeys')}
            </p>
          ) : null}
          <p className="text-[12px] leading-snug text-ink-faint">{t('st.nbSearch.keyUsage.footnote')}</p>
        </div>
      ) : null}

    </div>
  );
}
