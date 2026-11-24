import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProviderCatalogItem } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../../i18n';
import {
  quotaSettingsHref,
  type ProviderQuotaSnapshot,
  type ProviderQuotaSource,
} from '../../../lib/providerQuota';
import { FeedbackLine, Toggle, type Feedback } from '../../controls';
import { DisclosureChevron } from '../../icons';

const ROW_LINK =
  'inline-flex h-7 shrink-0 items-center rounded px-1.5 text-[11.5px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:px-2.5';

function KindTag({ kind }: { readonly kind: ProviderQuotaSource['kind'] }) {
  const { t } = useI18n();
  if (kind === 'provider' || kind === 'executor') return null;
  return <span className="shrink-0 text-[11px] text-ink-faint">{t(`usage.quota.kind.${kind}` as I18nKey)}</span>;
}

export function UnsupportedQuotaSection({
  sources,
  providerById,
}: {
  readonly sources: readonly ProviderQuotaSource[];
  readonly providerById: (id: string) => ProviderCatalogItem | undefined;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  const ordered = [
    ...sources.filter((source) => source.kind === 'provider'),
    ...sources.filter((source) => source.kind !== 'provider'),
  ];
  return (
    <details
      data-quota-unsupported={sources.length}
      open={open}
      onToggle={(event) => { setOpen(event.currentTarget.open); }}
      className="pt-1"
    >
      <summary
        title={t('usage.quota.unsupported.note')}
        className="flex cursor-pointer list-none items-center gap-2 py-1.5 text-[12px] text-ink-faint transition-colors hover:text-ink pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden"
      >
        <DisclosureChevron open={open} />
        <span>{t('usage.quota.unsupported.summary', { n: sources.length })}</span>
      </summary>
      <div className="pb-2 pl-5">
        <ul className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
          {ordered.map((source) => (
            <li key={source.id} data-quota-unsupported-item={source.id} className="flex min-w-0 items-center gap-2 py-0.5">
              <span className="min-w-0 truncate font-mono text-[12px] text-ink-soft" title={source.label}>{source.label}</span>
              <KindTag kind={source.kind} />
              <Link
                to={quotaSettingsHref(source, providerById(source.provider_id))}
                data-quota-settings-link={source.id}
                className={`ml-auto ${ROW_LINK}`}
              >
                {t('usage.quota.action.settings')}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

export function OffQuotaSection({
  sources,
  providerById,
  onEnable,
}: {
  readonly sources: readonly ProviderQuotaSource[];
  readonly providerById: (id: string) => ProviderCatalogItem | undefined;
  readonly onEnable: (id: string) => Promise<ProviderQuotaSnapshot>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  return (
    <details
      data-quota-off={sources.length}
      open={open}
      onToggle={(event) => { setOpen(event.currentTarget.open); }}
      className="pt-1"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 py-1.5 text-[12px] text-ink-faint transition-colors hover:text-ink pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
        <DisclosureChevron open={open} />
        <span>{t('usage.quota.off.summary', { n: sources.length })}</span>
      </summary>
      <ul className="divide-y divide-hairline/70 pb-2 pl-5">
        {sources.map((source) => (
          <OffQuotaRow
            key={source.id}
            source={source}
            href={quotaSettingsHref(source, providerById(source.provider_id))}
            onEnable={() => onEnable(source.id)}
          />
        ))}
      </ul>
    </details>
  );
}

function OffQuotaRow({
  source,
  href,
  onEnable,
}: {
  readonly source: ProviderQuotaSource;
  readonly href: string;
  readonly onEnable: () => Promise<ProviderQuotaSnapshot>;
}) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const enable = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const next = await onEnable();
      const after = next?.sources.find((entry) => entry.id === source.id);
      if (after !== undefined && !after.enabled) setFeedback({ tone: 'error', text: t('usage.quota.off.blocked') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li data-quota-off-item={source.id} className="py-1.5">
      <div className="flex min-h-8 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-[12px] text-ink-soft">{source.label}</span>
        <KindTag kind={source.kind} />
        <Link to={href} data-quota-settings-link={source.id} className={`ml-auto ${ROW_LINK}`}>
          {t('usage.quota.action.settings')}
        </Link>
        <Toggle
          layout="bare"
          label={t('usage.quota.toggleEnable', { name: source.label })}
          checked={false}
          disabled={busy}
          onChange={(enabled) => { if (enabled) void enable(); }}
        />
      </div>
      <FeedbackLine feedback={feedback} />
    </li>
  );
}
