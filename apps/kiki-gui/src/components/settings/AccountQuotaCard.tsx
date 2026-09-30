/**
 * Connections → "Account quota": what each signed-in managed account has left
 * at its vendor. Kimi Code reports per-window limits (`/oauth/usage`); other
 * accounts show the one-line quota their sign-in status carries, when any.
 * This is the vendor's allowance, not this Kiki's token usage — the card says
 * so and links to the Usage page for the latter.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { OAuthMethodStatus } from '@kiki/klient';
import type { ManagedUsageResult } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint } from '../controls';
import { SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';

type UsageRow = Extract<ManagedUsageResult, { kind: 'ok' }>['limits'][number];

/** Only Kimi Code serves per-window usage; the server reads it for no other account. */
const DETAILED_USAGE_METHODS: ReadonlySet<string> = new Set(['kimi-code']);

/** At or past this share of a limit the bar turns amber: worth knowing, not an alarm. */
const NEAR_LIMIT = 0.8;

const WINDOW_KEYS: Record<NonNullable<UsageRow['window']>['unit'], I18nKey> = {
  minute: 'st.quota.window.minute',
  hour: 'st.quota.window.hour',
  day: 'st.quota.window.day',
  week: 'st.quota.window.week',
};

export function AccountQuotaCard({ methods }: { methods: readonly OAuthMethodStatus[] }) {
  const { t } = useI18n();
  const signedIn = methods.filter((method) => method.signed_in);
  if (signedIn.length === 0) return null;
  return (
    <SectionCard id="st-card-account-quota" title={t('st.quota.title')}>
      <div className="space-y-4">
        <Hint>
          {t('st.quota.intro')}{' '}
          <Link to="/usage" className="text-selected-ink underline-offset-2 hover:underline">{t('st.quota.usageLink')}</Link>
        </Hint>
        <div className="divide-y divide-hairline">
          {signedIn.map((method) => (
            DETAILED_USAGE_METHODS.has(method.id)
              ? <DetailedQuota key={method.id} method={method} />
              : <SummaryQuota key={method.id} method={method} />
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

function AccountHeading({ method }: { method: OAuthMethodStatus }) {
  return (
    <p className="flex min-w-0 items-baseline gap-2">
      <span className="text-[13px] font-medium text-ink">{method.label}</span>
      {method.account.state === 'known' ? <span className="truncate font-mono text-[11px] text-ink-faint">{method.account.id}</span> : null}
    </p>
  );
}
function resetText(iso: string | undefined, locale: string): string | null {
  if (iso === undefined) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function DetailedQuota({ method }: { method: OAuthMethodStatus }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const usage = useQuery({
    queryKey: ['oauth-usage', method.provider],
    queryFn: () => client.getManagedUsage(method.provider),
    staleTime: 60_000,
  });
  const data = usage.data;
  const rows = data?.kind === 'ok'
    ? [...(data.summary !== null ? [data.summary] : []), ...data.limits]
    : [];
  return (
    <section data-quota-account={method.id} className="space-y-3 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1"><AccountHeading method={method} /></div>
        <button type="button" className={SECONDARY_BUTTON} disabled={usage.isFetching} onClick={() => void usage.refetch()}>
          {usage.isFetching ? t('st.quota.refreshing') : t('st.quota.refresh')}
        </button>
      </div>
      {usage.isLoading ? <Hint>{t('st.quota.loading')}</Hint> : null}
      {usage.isError ? <FeedbackLine feedback={{ tone: 'error', text: t('st.quota.failed', { detail: errorText(locale, usage.error) }) }} /> : null}
      {data?.kind === 'error' ? (
        <FeedbackLine feedback={{ tone: 'error', text: t('st.quota.failed', { detail: data.message }) }} />
      ) : null}
      {data?.kind === 'ok' && rows.length === 0 ? <Hint>{t('st.quota.none')}</Hint> : null}
      {rows.length > 0 ? (
        <ul className="space-y-3">
          {rows.map((row, index) => (
            <QuotaBar key={`${row.name ?? 'row'}-${index}`} row={row} first={index === 0 && data?.kind === 'ok' && data.summary !== null} />
          ))}
        </ul>
      ) : null}
      {data?.kind === 'ok' && data.extra_usage !== null ? (
        <p data-quota-balance className="text-[12px] text-ink-soft">
          {t('st.quota.balance', { amount: money(data.extra_usage.balance_cents, data.extra_usage.currency, locale) })}
          {data.extra_usage.monthly_charge_limit_enabled
            ? ` · ${t('st.quota.monthly', {
              used: money(data.extra_usage.monthly_used_cents, data.extra_usage.currency, locale),
              limit: money(data.extra_usage.monthly_charge_limit_cents, data.extra_usage.currency, locale),
            })}`
            : ''}
        </p>
      ) : null}
    </section>
  );
}

function money(cents: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
function QuotaBar({ row, first }: { row: UsageRow; first: boolean }) {
  const { t, locale } = useI18n();
  // A zero limit is "no allowance reported", not "100% used".
  const share = row.limit > 0 ? Math.min(1, Math.max(0, row.used / row.limit)) : null;
  const near = share !== null && share >= NEAR_LIMIT;
  const name = row.name ?? (first ? t('st.quota.summary') : t('st.quota.limit'));
  const window = row.window === undefined ? null : t(WINDOW_KEYS[row.window.unit], { n: row.window.duration });
  const reset = resetText(row.reset_at, locale);
  const percent = share === null ? null : Math.round(share * 100);
  return (
    <li data-quota-row data-quota-near={near ? 'true' : undefined} className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
        <span className="font-medium text-ink">{name}</span>
        {window !== null ? <span className="text-ink-faint">{window}</span> : null}
        <span className="ml-auto tabular-nums text-ink-soft">
          {row.limit > 0 ? t('st.quota.usedOf', { used: row.used.toLocaleString(), limit: row.limit.toLocaleString() }) : t('st.quota.usedOnly', { used: row.used.toLocaleString() })}
          {percent !== null ? <span className={`ml-2 font-medium ${near ? 'text-amber-ink' : 'text-ink'}`}>{percent}%</span> : null}
        </span>
      </div>
      {share !== null ? (
        <div
          role="progressbar"
          aria-label={name}
          aria-valuemin={0}
          aria-valuemax={row.limit}
          aria-valuenow={Math.min(row.used, row.limit)}
          className="h-1.5 overflow-hidden rounded-full bg-hairline"
        >
          <div
            className={`h-full rounded-full ${near ? 'bg-amber-ink' : 'bg-selected-ink'}`}
            style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%` }}
          />
        </div>
      ) : null}
      {reset !== null ? <p className="text-[11px] text-ink-faint">{t('st.quota.resetsAt', { when: reset })}</p> : null}
    </li>
  );
}

/** Accounts without per-window usage: the single quota line their status carries. */
function SummaryQuota({ method }: { method: OAuthMethodStatus }) {
  const { t, locale } = useI18n();
  const quota = method.quota;
  const reset = quota.state === 'known' ? resetText(quota.reset_at, locale) : null;
  return (
    <section data-quota-account={method.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
      <AccountHeading method={method} />
      {quota.state === 'known' ? (
        <p className="text-[12px] text-ink-soft">
          <span>{quota.label}</span>
          <span className="ml-2 font-medium tabular-nums text-ink">
            {quota.unit === 'percent' ? t('st.quota.remainingPercent', { n: quota.remaining }) : t('st.quota.remainingCount', { n: quota.remaining.toLocaleString() })}
          </span>
          {reset !== null ? <span className="ml-2 text-ink-faint">{t('st.quota.resetsAt', { when: reset })}</span> : null}
        </p>
      ) : (
        <p className="text-[12px] text-ink-faint">{t('st.quota.unknown')}</p>
      )}
    </section>
  );
}
