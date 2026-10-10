/**
 * DiscoveryExampleModal — renders local, non-executable UI examples during discovery.
 *
 * Ensures:
 * - Clear label indicating it is a local example and does not run.
 * - Does not create sessions, execute commands, or send prompts to models.
 * - Does not obscure the active composer or editor unexpectedly.
 */

import { DISCOVERY_EXAMPLES, type DiscoveryExampleId } from '@kiki/session-core/discovery';
import { useI18n } from '../../i18n';
import { Dialog } from '../Dialog';
import { Icon } from '../icons';
import { SECONDARY_BUTTON } from '../ui';

export function DiscoveryExampleModal({
  exampleId,
  onClose,
}: {
  readonly exampleId: DiscoveryExampleId;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const example = DISCOVERY_EXAMPLES.find((entry) => entry.id === exampleId);

  if (example === undefined) return null;

  return (
    <Dialog
      onClose={onClose}
      ariaLabel={t(example.labelKey)}
      overlayId={`discovery-example-${exampleId}`}
      panelClassName="anim-enter flex w-full max-w-[520px] flex-col rounded-2xl border border-hairline bg-panel p-6 shadow-[0_16px_48px_-16px_rgb(var(--kiki-shadow-ink)/0.35)]"
    >
      <div className="flex items-start justify-between gap-3 border-b border-hairline pb-3">
        <div className="min-w-0">
          <span
            data-discovery-example-badge
            className="inline-flex items-center gap-1 rounded-md bg-ink/[0.06] px-2 py-0.5 text-[11px] font-medium text-ink-soft"
          >
            <Icon name="info" size={12} />
            {t(example.labelKey)}
          </span>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{t(example.bodyKey)}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {example.items.length > 0 ? (
        <div className="mt-4 space-y-2.5" data-discovery-example-items>
          {example.items.map((item, index) => (
            <div
              key={index}
              className="rounded-xl border border-hairline bg-paper p-3 shadow-[var(--kiki-sheet-shadow)]"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ink/[0.06] text-[11px] font-semibold text-ink">
                  {index + 1}
                </span>
                <span className="text-[13px] font-medium text-ink">{t(item.titleKey)}</span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{t(item.bodyKey)}</p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-5 flex justify-end">
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
          {t('common.close')}
        </button>
      </div>
    </Dialog>
  );
}
