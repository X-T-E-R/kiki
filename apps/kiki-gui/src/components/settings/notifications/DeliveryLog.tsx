import type { NotificationDelivery } from '@kiki/klient';

import { useI18n } from '../../../i18n';
import { AdvancedDetails } from '../fields';
import { errorKindKey } from './model';

const FAILED = new Set<NotificationDelivery['status']>(['failed', 'unknown', 'expired']);

/** Collapsed per-channel delivery log: when, outcome, attempt, and why it failed. */
export function DeliveryLog({ deliveries }: { deliveries: readonly NotificationDelivery[] }) {
  const { t, time } = useI18n();
  return (
    <AdvancedDetails summary={`${t('st.notify.deliveries')} · ${deliveries.length}`} data-notify-deliveries>
      {deliveries.length === 0 ? <p className="text-[12px] text-ink-faint">{t('st.notify.deliveriesEmpty')}</p> : (
        <ol className="max-h-56 space-y-0.5 overflow-y-auto">
          {deliveries.slice(0, 20).map((row) => (
            <li key={row.delivery_id} data-notify-delivery={row.status}
              className="flex flex-wrap items-baseline gap-x-3 text-[12px] leading-5">
              <time dateTime={row.created_at} title={time.absoluteTime(row.created_at)} className="w-24 shrink-0 tabular-nums text-ink-faint">
                {time.relativeTime(row.created_at)}
              </time>
              <span className={FAILED.has(row.status) ? 'text-danger' : 'text-ink'}>{t(`st.notify.delivery.${row.status}`)}</span>
              {FAILED.has(row.status) && row.result !== null ? <span className="text-ink-soft">{t(errorKindKey(row.result.error_kind))}</span> : null}
              {row.attempt > 1 ? <span className="text-ink-faint">{t('st.notify.attempt', { n: row.attempt })}</span> : null}
            </li>
          ))}
        </ol>
      )}
    </AdvancedDetails>
  );
}
