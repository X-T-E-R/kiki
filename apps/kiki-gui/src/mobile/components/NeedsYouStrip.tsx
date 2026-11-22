import type { UnifiedInboxItem } from '@kiki/session-core/sessions';

import { Icon } from '../../components/icons';
import { ActionSheet } from '../../components/overlays/ActionSheet';
import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';
import { NeedsYouCard } from './NeedsYouCard';

/** One 44px row under the assistant header while any space waits on a decision. */
export function NeedsYouStrip({ count, onOpen }: { readonly count: number; readonly onOpen: () => void }) {
  const { t } = useI18n();
  if (count <= 0) return null;
  return (
    <div className="shrink-0 px-3 pb-1 pt-2">
      <button
        type="button"
        data-mobile-needs-you-strip={count}
        onClick={onOpen}
        className="mx-auto flex h-11 w-full max-w-[640px] items-center gap-2.5 rounded-2xl bg-accent-soft px-3.5 text-left text-[13.5px] font-medium text-accent-ink transition-opacity active:opacity-80"
      >
        <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-accent" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{t('mobile.needsYou.strip', { count })}</span>
        <Icon name="chevron" size={12} className="shrink-0 opacity-80" />
      </button>
    </div>
  );
}

interface NeedsYouSheetProps {
  readonly items: readonly UnifiedInboxItem[];
  readonly resolveClient: (spaceKey: string) => KikiClient;
  readonly onClose: () => void;
  readonly onOpenItem: (item: UnifiedInboxItem) => void;
  readonly onResolved: () => void;
}

/** Cross-space decisions, each approvable in place or opened in its own thread. */
export function NeedsYouSheet({ items, resolveClient, onClose, onOpenItem, onResolved }: NeedsYouSheetProps) {
  const { t } = useI18n();
  return (
    <ActionSheet
      role="dialog"
      ariaLabel={t('mobile.needsYou.title')}
      overlayId="mobile-needs-you"
      dataAttribute="data-mobile-needs-you-sheet"
      onClose={onClose}
      sheetClassName="kiki-space-switch-sheet max-h-[82dvh]! rounded-t-[24px]!"
    >
      <div className="kiki-mobile-sheet-grabber" aria-hidden="true" />
      <div className="flex h-11 items-center justify-between pl-4 pr-2">
        <h2 className="text-[16px] font-semibold text-ink">{t('mobile.needsYou.title')}</h2>
        <button
          type="button"
          aria-label={t('mobile.voice.cancel')}
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-full text-ink-faint hover:bg-ink/[0.06]"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4 pt-2">
        {items.map((item) => (
          <NeedsYouCard
            key={item.encodedKey}
            item={item}
            client={resolveClient(item.spaceKey)}
            onOpenThread={() => {
              onClose();
              onOpenItem(item);
            }}
            onResolved={onResolved}
          />
        ))}
      </div>
    </ActionSheet>
  );
}
