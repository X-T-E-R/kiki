import type { ReactNode } from 'react';
import { formatGrouped } from '@kiki/session-core/util';

import { useI18n } from '../../i18n';
import type { UsageResponseWire } from '../../lib/usageV2';
import { Icon } from '../icons';
import { AnchoredPopover, usePopover } from '../overlays/AnchoredPopover';

export function UsageReliabilityDetails({
  summary,
  reliability,
  onOpenPricing,
  footerSlot,
}: Pick<UsageResponseWire, 'summary' | 'reliability'> & {
  readonly onOpenPricing?: () => void;
  readonly footerSlot?: ReactNode;
}) {
  const { t, tp, locale } = useI18n();
  const pop = usePopover();
  const coverage = reliability.usage_coverage;
  const missing = coverage?.missing_records ?? 0;
  const legacyZero = coverage?.legacy_zero_records ?? 0;
  const models = reliability.unknown_price_models;
  const partial =
    !reliability.complete ||
    summary.cost_unknown ||
    summary.tokens_unknown === true ||
    models.length > 0 ||
    missing > 0 ||
    legacyZero > 0 ||
    reliability.incomplete_reason !== null ||
    reliability.incomplete_sessions > 0;
  const hasAccountingNotices = missing > 0 || legacyZero > 0 || models.length > 0 || summary.cost_unknown;
  const formatDate = (ms: number) =>
    new Date(ms).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  const { earliest_at: earliest, latest_at: latest } = reliability.coverage;
  const summaryLabel = partial
    ? t('usage.reliability.summaryPartial', { count: formatGrouped(reliability.scanned_sessions) })
    : t('usage.reliability.summaryComplete', { count: formatGrouped(reliability.scanned_sessions) });
  const tooltip = [
    summaryLabel,
    ...(models.length > 0 ? [tp('usage.reliability.unpriced', models.length)] : []),
    ...(missing > 0 ? [t('usage.accounting.missing', { count: missing })] : []),
  ].join(' · ');

  return (
    <div data-usage-reliability-state={partial ? 'partial' : 'complete'} className="inline-flex items-center">
      <button
        type="button"
        data-usage-reliability-toggle
        ref={pop.anchorRef}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-controls={pop.open ? pop.popoverProps.id : undefined}
        aria-label={tooltip}
        title={tooltip}
        onClick={() => { pop.setOpen((current) => !current); }}
        className={`flex h-8 w-8 items-center justify-center rounded-md border border-transparent transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11 ${
          partial ? 'text-amber-ink' : 'text-ink-faint hover:text-ink'
        }`}
      >
        <Icon name={partial ? 'partial' : 'info'} size={14} />
      </button>

      <AnchoredPopover
        {...pop.popoverProps}
        align="end"
        widthClassName="w-[19.5rem]"
        label={summaryLabel}
        data={{ 'data-usage-reliability': '' }}
      >
        <div className="space-y-3 text-[12px] leading-relaxed text-ink-soft">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-ink">{summaryLabel}</span>
            {models.length > 0 && onOpenPricing !== undefined ? (
              <button
                type="button"
                data-usage-reliability-set-prices
                onClick={() => {
                  pop.setOpen(false);
                  onOpenPricing();
                }}
                className="text-[11.5px] font-medium text-selected-ink underline-offset-2 hover:underline"
              >
                {t('usage.reliability.setPrices')}
              </button>
            ) : null}
          </div>

          {hasAccountingNotices ? (
            <div data-usage-accounting-notices className="space-y-1.5 border-t border-hairline pt-2.5">
              {missing > 0 ? <p data-usage-accounting-missing>{t('usage.accounting.missing', { count: missing })}</p> : null}
              {legacyZero > 0 ? <p data-usage-accounting-legacy-zero>{t('usage.accounting.legacyZero', { count: legacyZero })}</p> : null}
              {models.length > 0 ? (
                <div>
                  <p>{tp('usage.reliability.unpriced', models.length)}</p>
                  <ul data-usage-unpriced-models className="mt-1 max-h-24 overflow-y-auto font-mono text-[11px] text-ink-faint">
                    {models.map((model) => (
                      <li key={model} className="break-all py-0.5">{model}</li>
                    ))}
                  </ul>
                </div>
              ) : summary.cost_unknown ? (
                <p>{t('usage.reliability.costUnknown')}</p>
              ) : null}
            </div>
          ) : null}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-hairline pt-2.5">
            <div>
              <dt className="text-[11px] text-ink-faint">{t('usage.reliability.coverage')}</dt>
              <dd className="text-ink tabular-nums">
                {earliest !== null && latest !== null
                  ? `${formatDate(earliest)} → ${formatDate(latest)}`
                  : t('usage.reliability.coverageEmpty')}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-ink-faint">{t('usage.reliability.scanned')}</dt>
              <dd className="text-ink tabular-nums">{formatGrouped(reliability.scanned_sessions)}</dd>
            </div>
          </dl>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2.5">
            <span className="text-[11px] text-ink-faint">
              {t(reliability.includes_deleted_sessions ? 'usage.reliability.deleted.included' : 'usage.reliability.deleted.excluded')}
            </span>
            {footerSlot}
          </div>
        </div>
      </AnchoredPopover>
    </div>
  );
}
