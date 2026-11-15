import { useId, useState } from 'react';
import { formatGrouped } from '@kiki/session-core/util';

import { useI18n } from '../../i18n';
import type { UsageResponseWire } from '../../lib/usageV2';
import { Icon } from '../icons';

export function UsageReliabilityDetails({ summary, reliability }: Pick<UsageResponseWire, 'summary' | 'reliability'>) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const partialLabel = t('usage.reliability.unknown');
  const detailsId = useId();
  const coverage = reliability.usage_coverage;
  const missing = coverage?.missing_records ?? 0;
  const legacyZero = coverage?.legacy_zero_records ?? 0;
  const models = reliability.unknown_price_models;
  const partial = !reliability.complete || summary.cost_unknown || summary.tokens_unknown === true || models.length > 0 ||
    missing > 0 || legacyZero > 0 || reliability.incomplete_reason !== null || reliability.incomplete_sessions > 0;
  const hasAccountingNotices = missing > 0 || legacyZero > 0 || models.length > 0 || summary.cost_unknown;
  const formatDate = (ms: number) => new Date(ms).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
  const { earliest_at: earliest, latest_at: latest } = reliability.coverage;

  return (
    <div data-usage-reliability-state={partial ? 'partial' : 'complete'}>
      <button
        type="button"
        data-usage-reliability-toggle
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => { setOpen(!open); }}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-sm text-[12px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-selected-ink"
      >
        {partial ? (
          <span role="img" title={partialLabel} aria-label={partialLabel} className="inline-flex text-ink-faint">
            <Icon name="partial" size={12} />
          </span>
        ) : null}
        {t('usage.reliability.title')}
        <Icon name="chevron" size={12} className={`text-ink-faint ${open ? 'rotate-90' : ''}`} />
      </button>
      {open ? (
        <div id={detailsId} data-usage-reliability className="max-w-3xl pt-2 pb-3 text-[12px] leading-relaxed text-ink-soft">
          {hasAccountingNotices ? (
            <div data-usage-accounting-notices className="space-y-1.5">
              {missing > 0 ? <p data-usage-accounting-missing>{t('usage.accounting.missing', { count: missing })}</p> : null}
              {legacyZero > 0 ? <p data-usage-accounting-legacy-zero>{t('usage.accounting.legacyZero', { count: legacyZero })}</p> : null}
              {models.length > 0 ? (
                <div className="pt-1">
                  <p>{t('usage.reliability.unpriced', { count: models.length })}</p>
                  <ul data-usage-unpriced-models className="mt-1 max-h-28 overflow-y-auto font-mono text-[11.5px] text-ink-faint">
                    {models.map((model) => <li key={model} className="break-all py-0.5">{model}</li>)}
                  </ul>
                </div>
              ) : summary.cost_unknown ? <p>{t('usage.reliability.costUnknown')}</p> : null}
            </div>
          ) : null}
          <dl className={`${hasAccountingNotices ? 'mt-4 border-t border-hairline pt-3' : ''} grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]`}>
            <div>
              <dt className="text-[11.5px] text-ink-faint">{t('usage.reliability.coverage')}</dt>
              <dd className="tabular-nums">
                {earliest !== null && latest !== null ? `${formatDate(earliest)} → ${formatDate(latest)}` : t('usage.reliability.coverageEmpty')}
              </dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-ink-faint">{t('usage.reliability.scanned')}</dt>
              <dd className="tabular-nums">{formatGrouped(reliability.scanned_sessions)}</dd>
            </div>
          </dl>
          <p className="mt-3 text-[11.5px] text-ink-faint">{t('usage.reliability.costSource')} · {t(reliability.includes_deleted_sessions ? 'usage.reliability.deleted.included' : 'usage.reliability.deleted.excluded')}</p>
        </div>
      ) : null}
    </div>
  );
}
